import { UserRole } from '../generated/prisma/enums';

/**
 * The two rooms a connection may join, as functions rather than template
 * literals at the call sites — a typo in one of four hand-written strings is a
 * socket that silently receives nothing.
 */
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Everyone in the company who works tickets.
 *
 * **This room is the whole access-control story of the gateway.** The HTTP side
 * spent a phase making sure a `REQUESTER` cannot read somebody else's ticket;
 * broadcasting every change to `tenant:<id>` would hand it to them over a
 * socket instead, and no controller would be involved to notice.
 */
export const staffRoom = (tenantId: string): string =>
  `tenant:${tenantId}:staff`;

/**
 * Who belongs in the staff room. Identical to `seesEveryTicket()` in
 * `src/tickets/` and named separately for the same reason
 * `handlesInternalNotes()` is: it answers a different question that happens to
 * have the same answer, and binding them would be an accident waiting for one
 * of the two to change.
 */
export function joinsStaffRoom(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.AGENT;
}
