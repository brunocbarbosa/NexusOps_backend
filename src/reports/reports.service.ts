import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Prisma } from '../generated/prisma/client';
import { ReportStatus } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { QueryReportsDto } from './dto/query-reports.dto';
import { TicketReportFiltersDto } from './dto/ticket-report-filters.dto';
import {
  REPORT_REQUESTER,
  ReportResponse,
  ReportWithRequester,
  toReportResponse,
} from './report-response';
import {
  REPORTS_QUEUE,
  TICKET_REPORT_JOB,
  TicketReportJob,
} from './reports.constants';

export type PaginatedReports = {
  data: ReportResponse[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The request side of the asynchronous export.
 *
 * **Reports are personal**: every query here filters by `requestedById`, and
 * that is a security property rather than a simplification. The CSV was built
 * through the requester's own visibility, so a `REQUESTER`'s export contains
 * only their tickets while an `AGENT`'s contains the company's. Letting a third
 * person download somebody else's report would hand them rows the ticket routes
 * would refuse them.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @InjectQueue(REPORTS_QUEUE) private readonly queue: Queue<TicketReportJob>,
  ) {}

  /**
   * Records the request and hands it to the queue. Answered with `202`.
   *
   * The row is written **before** the job is enqueued, and the order matters: a
   * job whose report row does not exist yet is a job that fails on its first
   * statement, and BullMQ would retry it into the same failure. The other
   * order — enqueue, then insert — has no such race.
   */
  async requestTicketReport(
    filters: TicketReportFiltersDto,
    requester: AuthenticatedUser,
  ): Promise<ReportResponse> {
    const report = await this.prisma.report.create({
      data: tenantScoped({
        requestedById: requester.id,
        // The filters as asked for, so the row can say what it contains. A URL
        // is gone by the time the file is downloaded.
        filters: filters as Prisma.InputJsonObject,
      }),
      include: REPORT_REQUESTER,
    });

    await this.queue.add(TICKET_REPORT_JOB, {
      reportId: report.id,
      actor: requester,
      filters,
    });

    return toReportResponse(report);
  }

  async findAll(
    query: QueryReportsDto,
    requester: AuthenticatedUser,
  ): Promise<PaginatedReports> {
    const where: Prisma.ReportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      // Last, and never optional.
      requestedById: requester.id,
    };

    const [total, reports] = await this.prisma.$transaction([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({
        where,
        include: REPORT_REQUESTER,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
    ]);

    return {
      data: reports.map(toReportResponse),
      meta: {
        total,
        page: query.page,
        perPage: query.perPage,
        totalPages: Math.ceil(total / query.perPage) || 1,
      },
    };
  }

  async findOne(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<ReportResponse> {
    return toReportResponse(await this.load(id, requester));
  }

  /**
   * The CSV itself.
   *
   * `409` while the job has not finished, rather than an empty body with a
   * `200`: a client that downloaded a report before it was ready would get a
   * file it has no way to tell apart from a report with no matching tickets.
   */
  async download(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<{ filename: string; content: string }> {
    const report = await this.load(id, requester);

    if (report.status !== ReportStatus.COMPLETED) {
      throw new ConflictException(
        `This report is ${report.status.toLowerCase()} and has nothing to download yet` +
          (report.error === null ? '' : `: ${report.error}`),
      );
    }

    return {
      filename: `tickets-${report.id}.csv`,
      content: report.content ?? '',
    };
  }

  private async load(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<ReportWithRequester> {
    // Another tenant's id is filtered out by the extension; another person's
    // report by `requestedById`. Both are 404, and telling them apart would be
    // telling the caller that somebody else's report exists.
    const report = await this.prisma.report.findFirst({
      where: { id, requestedById: requester.id },
      include: REPORT_REQUESTER,
    });

    if (!report) {
      throw new NotFoundException(`No report ${id}`);
    }

    return report;
  }
}
