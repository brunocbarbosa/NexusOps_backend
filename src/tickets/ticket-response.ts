import { Ticket, User } from '../generated/prisma/client';
import { UserResponse, toUserResponse } from '../users/user-response';

/**
 * The relations every ticket response carries.
 *
 * Embedded rather than left as bare ids because the alternative is a list
 * screen that fetches one user per row. The extension does not reach a nested
 * read — query extensions never fire for `include` — but nothing is leaking
 * here: the composite foreign keys mean a ticket's requester, assignee and
 * closer are all rows of the same tenant, enforced by PostgreSQL rather than by
 * this file.
 */
export const TICKET_PEOPLE = {
  requester: true,
  assignee: true,
  closedBy: true,
} as const;

export type TicketWithPeople = Ticket & {
  requester: User;
  assignee: User | null;
  closedBy: User | null;
};

/**
 * What a ticket looks like on the way out.
 *
 * An allowlist, like every other response type here: a column added to the
 * table stays out of the API until somebody decides otherwise. `tenantId` is
 * the field this most matters for — it is on the row and never on the wire.
 *
 * `version` is on the wire and has to be: a client cannot send it back on the
 * next `PATCH` without having received it, and without it the optimistic
 * concurrency check has nothing to compare.
 */
export type TicketResponse = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: Ticket['status'];
  priority: Ticket['priority'];
  category: Ticket['category'];
  version: number;
  requester: UserResponse;
  assignee: UserResponse | null;
  closedBy: UserResponse | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toTicketResponse(ticket: TicketWithPeople): TicketResponse {
  return {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    version: ticket.version,
    requester: toUserResponse(ticket.requester),
    assignee: ticket.assignee === null ? null : toUserResponse(ticket.assignee),
    closedBy: ticket.closedBy === null ? null : toUserResponse(ticket.closedBy),
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}
