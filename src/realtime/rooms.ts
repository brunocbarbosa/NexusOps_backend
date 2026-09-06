import { UserRole } from '../generated/prisma/enums';

/**
 * The two rooms a connection may join, as functions rather than template
 * literals at the call sites — a typo in one of four hand-written strings is a
 * socket that silently receives nothing.
 */
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Everyone in the company entitled to hear about every ticket in it.
 *
 * It was `tenant:<id>:staff` and it held the agents too. It does not any more,
 * and the rename is not cosmetic: an agent hears about the tickets assigned to
 * it, addressed personally through `user:<id>`, and about nothing else. A room
 * still called `staff` while excluding the agents is a name somebody would read
 * as a bug and then "fix". Renaming the string costs nothing on the wire —
 * this gateway pushes and takes no commands, so no client ever names a room.
 *
 * **This room is still the whole broadcast story of the gateway.** Emitting to
 * a plain `tenant:<id>` would hand every ticket in the company to a REQUESTER
 * over a socket, with no controller involved to refuse it and no HTTP test to
 * notice — and it would now do the same to an agent.
 */
export const adminRoom = (tenantId: string): string =>
  `tenant:${tenantId}:admins`;

/**
 * Who belongs in the admin room. Identical to `seesEveryTicket()` in
 * `src/tickets/` and named separately for the same reason
 * `handlesInternalNotes()` is: it answers a different question that happens to
 * have the same answer, and binding them would be an accident waiting for one
 * of the two to change.
 *
 * That stopped being hypothetical. When the `AGENT` left `seesEveryTicket()` it
 * left this predicate with it and stayed in `handlesInternalNotes()` — the
 * three moved apart exactly as their docblocks said they might, and the day it
 * happened was not the day to discover they had been collapsed into one.
 */
export function joinsAdminRoom(role: UserRole): boolean {
  return role === UserRole.ADMIN;
}
