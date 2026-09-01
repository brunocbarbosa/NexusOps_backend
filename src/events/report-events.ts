/**
 * What an asynchronous export announces when it settles.
 *
 * Emitted by the worker, consumed by the notification gateway. It is the other
 * half of the 202 flow: the API said "later", and this is later.
 *
 * There is no audit listener for these on purpose. A report is a read, and the
 * trail records changes to the domain — logging every export would fill it with
 * entries nobody is auditing.
 */
export const REPORT_EVENTS = {
  Completed: 'report.completed',
  Failed: 'report.failed',
} as const;

/** Requires `wildcard: true`, like the ticket pattern. */
export const REPORT_EVENT_PATTERN = 'report.*';

export type ReportEvent = {
  tenantId: string;
  reportId: string;
  /**
   * Who asked for it, and the only person who may hear about it: a report is
   * built through its requester's visibility, so its very existence is
   * addressed to them.
   */
  requestedById: string;
  rowCount: number | null;
  error: string | null;
};
