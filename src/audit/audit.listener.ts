import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantScopeService } from '../tenancy/tenant-scope.service';
import { TICKET_EVENT_PATTERN } from '../events/ticket-events';
import type { TicketEvent } from '../events/ticket-events';
import { AuditService } from './audit.service';

/**
 * The Observer end of the audit trail: the only thing in the codebase that
 * calls `AuditService.record()`.
 *
 * **It opens the tenant scope from the payload rather than inheriting one.**
 * The scope does survive a synchronous `emit` — measured, see HELPDESK.md
 * Part II — but inheriting it would make the audit trail depend on
 * `@nestjs/event-emitter` dispatching synchronously, which is a fact about a
 * dependency and not a decision made here. Opening it explicitly is also
 * exactly what a BullMQ worker has to do, so there is one rule rather than two.
 *
 * **A failure here does not fail the request**, and cannot: by the time this
 * runs, the mutation has already committed. Throwing would surface as an
 * unhandled rejection long after the response went out, so the error is logged
 * loudly instead. That the trail can therefore fall behind the data is a real
 * gap, stated in HELPDESK.md rather than hidden.
 */
@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  @OnEvent(TICKET_EVENT_PATTERN)
  async handle(event: TicketEvent): Promise<void> {
    try {
      await this.scope.runWithTenant(event.tenantId, () =>
        this.audit.record(event),
      );
    } catch (error) {
      this.logger.error(
        `Failed to record ${event.action} on ${event.entityType} ` +
          `${event.entityId} for tenant ${event.tenantId}. The change itself ` +
          'was committed; the trail is now behind the data.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  constructor(
    private readonly audit: AuditService,
    private readonly scope: TenantScopeService,
  ) {}
}
