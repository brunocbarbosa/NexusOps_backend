import type { AuthenticatedUser } from '../auth/authenticated-user';
import type { TicketReportFiltersDto } from './dto/ticket-report-filters.dto';

/** The BullMQ queue name. One constant, so the producer and the worker agree. */
export const REPORTS_QUEUE = 'reports';

export const TICKET_REPORT_JOB = 'ticket-csv';

/**
 * What travels to the worker.
 *
 * **The whole actor goes in the payload, not just the tenant.** A worker has no
 * HTTP request, so `AsyncLocalStorage` is empty there — CLAUDE.md calls this the
 * single most likely place in the project for a tenant leak. It needs the tenant
 * to open a scope, and it needs the role and the id as well, because the rows
 * that belong in this CSV are exactly the rows this person can see: a
 * `REQUESTER`'s export must not contain somebody else's tickets.
 *
 * Serialised through Redis as JSON, so everything in here has to survive
 * `JSON.stringify` — which is why it holds ids and enum strings and nothing
 * with a prototype.
 */
export type TicketReportJob = {
  reportId: string;
  actor: AuthenticatedUser;
  filters: TicketReportFiltersDto;
};
