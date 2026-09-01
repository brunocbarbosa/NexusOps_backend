import { Report, User } from '../generated/prisma/client';
import { UserResponse, toUserResponse } from '../users/user-response';

export const REPORT_REQUESTER = { requestedBy: true } as const;

export type ReportWithRequester = Report & { requestedBy: User };

/**
 * A report on the way out.
 *
 * **`content` is deliberately not here.** The CSV can be tens of thousands of
 * rows, and putting it in the status response would mean every poll of
 * `GET /reports/:id` carries the whole file. It has its own route, with its own
 * content type.
 */
export type ReportResponse = {
  id: string;
  status: Report['status'];
  filters: unknown;
  rowCount: number | null;
  error: string | null;
  requestedBy: UserResponse;
  createdAt: Date;
  completedAt: Date | null;
};

export function toReportResponse(report: ReportWithRequester): ReportResponse {
  return {
    id: report.id,
    status: report.status,
    filters: report.filters,
    rowCount: report.rowCount,
    error: report.error,
    requestedBy: toUserResponse(report.requestedBy),
    createdAt: report.createdAt,
    completedAt: report.completedAt,
  };
}
