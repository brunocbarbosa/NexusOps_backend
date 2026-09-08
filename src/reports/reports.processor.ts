import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { REPORT_EVENTS } from '../events/report-events';
import type { ReportEvent } from '../events/report-events';
import { ReportStatus } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { DomainEvents } from '../tenancy/domain-events';
import { TenantScopeService } from '../tenancy/tenant-scope.service';
import { TicketResponse } from '../tickets/ticket-response';
import { TicketsService } from '../tickets/tickets.service';
import { REPORTS_QUEUE, TicketReportJob } from './reports.constants';
import { ticketsToCsv } from './ticket-csv';

/** What one page of the export asks for. The API caps `perPage` at 100. */
const PAGE_SIZE = 100;

/**
 * The worker. **There is no HTTP request here, so there is no tenant scope to
 * inherit**, and every database call below runs inside an explicit
 * `this.scope.runWithTenant(job.data.actor.tenantId, ...)`. CLAUDE.md calls this
 * the single most likely place in the project for a tenant leak, and the reason
 * is visible in the shape of the code: nothing about a Prisma call here looks
 * different from one in a controller, so a query written outside a scope would
 * not look wrong — it would throw `TenantContextMissingError` at runtime, which
 * is exactly why `requireTenantId()` has no nullable variant to fall back to.
 *
 * **And a scope is a unit of work, not a job.** That is the second lesson, and
 * it is the one the next worker will need. A scope is now a database
 * transaction, so wrapping this whole method in one — which is what it used to
 * be — would hold a pooled connection for the length of an export: up to five
 * hundred page queries at the configured cap, with nothing to reclaim it, since
 * this project sets no `idle_in_transaction_session_timeout`. And it would buy
 * nothing in exchange: Prisma sets no isolation level, so the transaction runs
 * at `read committed`, where each statement takes a fresh snapshot anyway. The
 * export is no more consistent for being one transaction — measured, see
 * documents/RLS_DESIGN.md, settled decision #2.
 *
 * So: one scope to mark the row as processing, one per page, one for the result,
 * one for the failure path. Roughly five hundred short transactions where there
 * would have been one long one, which is the right side of that trade.
 *
 * `announce()` deliberately runs *between* scopes rather than inside one, so
 * `DomainEvents` sees no open transaction and emits immediately — which is what
 * the comment on it has always promised.
 *
 * The rows are gathered by paging `TicketsService.findAll` rather than by a
 * query written here. That is deliberate and costs one round trip per hundred
 * rows: `findAll` is where the visibility rule lives, so an export built
 * through it cannot contain a ticket the requester could not have listed. A
 * second query with its own `where` would be a second place for that rule to
 * drift, and the drift would only be visible in a file somebody downloads.
 */
@Processor(REPORTS_QUEUE)
export class ReportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsProcessor.name);
  private readonly maxRows: number;

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tickets: TicketsService,
    private readonly events: DomainEvents,
    private readonly scope: TenantScopeService,
    config: ConfigService,
  ) {
    super();
    this.maxRows = config.getOrThrow<number>('REPORTS_MAX_ROWS');
  }

  async process(job: Job<TicketReportJob>): Promise<void> {
    const { reportId, actor, filters } = job.data;

    await this.setStatus(actor.tenantId, reportId, ReportStatus.PROCESSING);

    try {
      const rows = await this.collect(actor, filters);

      await this.scope.runWithTenant(actor.tenantId, () =>
        this.prisma.report.updateMany({
          where: { id: reportId },
          data: {
            status: ReportStatus.COMPLETED,
            content: ticketsToCsv(rows),
            rowCount: rows.length,
            completedAt: new Date(),
            error: null,
          },
        }),
      );

      this.announce(REPORT_EVENTS.Completed, {
        tenantId: actor.tenantId,
        reportId,
        requestedById: actor.id,
        rowCount: rows.length,
        error: null,
      });
    } catch (error) {
      // The failure is recorded on the row rather than only thrown, because
      // the client is polling that row: a job that dies silently leaves a
      // report stuck in PROCESSING forever with nothing to explain it.
      const message =
        error instanceof Error ? error.message : 'Unknown failure';

      // Its own scope, and therefore its own transaction. The one the failure
      // came from is gone — if it was a database error it took its transaction
      // with it, and writing this row through it would fail too.
      await this.scope.runWithTenant(actor.tenantId, () =>
        this.prisma.report.updateMany({
          where: { id: reportId },
          data: {
            status: ReportStatus.FAILED,
            error: message,
            completedAt: new Date(),
          },
        }),
      );

      this.announce(REPORT_EVENTS.Failed, {
        tenantId: actor.tenantId,
        reportId,
        requestedById: actor.id,
        rowCount: null,
        error: message,
      });

      this.logger.error(
        `Report ${reportId} failed for tenant ${actor.tenantId}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );

      // Rethrown so BullMQ marks the job failed too. The row and the queue
      // disagreeing about what happened is worse than either being wrong.
      throw error;
    }
  }

  /**
   * Pages through the caller's own view of the tickets, up to the cap.
   *
   * The cap exists because the CSV is stored in a `TEXT` column rather than in
   * object storage. It truncates rather than failing: a report that says "here
   * are the first 50000" is more useful than one that refuses, and `rowCount`
   * on the row tells the client what it got.
   */
  private async collect(
    actor: TicketReportJob['actor'],
    filters: TicketReportJob['filters'],
  ): Promise<TicketResponse[]> {
    const rows: TicketResponse[] = [];

    for (let page = 1; rows.length < this.maxRows; page += 1) {
      // One scope per page, so a long export is a long series of short
      // transactions rather than one transaction holding a connection.
      const result = await this.scope.runWithTenant(actor.tenantId, () =>
        this.tickets.findAll({ ...filters, page, perPage: PAGE_SIZE }, actor),
      );

      rows.push(...result.data);

      if (page >= result.meta.totalPages || result.data.length === 0) break;
    }

    return rows.slice(0, this.maxRows);
  }

  /**
   * Announces the outcome. Emitted **after** the row is written, so a client
   * woken by the socket and reading the report immediately finds it settled
   * rather than racing the update that caused the notification.
   */
  private announce(name: string, event: ReportEvent): void {
    this.events.emit(name, event);
  }

  private async setStatus(
    tenantId: string,
    reportId: string,
    status: ReportStatus,
  ): Promise<void> {
    // updateMany and not update: the tenant filter is injected into a `where`,
    // and `update` would need a unique key that already names the tenant.
    await this.scope.runWithTenant(tenantId, () =>
      this.prisma.report.updateMany({
        where: { id: reportId },
        data: { status },
      }),
    );
  }
}
