import { UserRole } from '../generated/prisma/enums';

/**
 * Who may read and write the internal note on a ticket.
 *
 * Its body is identical to `seesEveryTicket()` in `src/tickets/`, and calling
 * that one instead would be the wrong kind of shortcut: "may this person see
 * every ticket in the company" and "may this person read the note the customer
 * is not meant to see" are two questions that happen to have the same answer
 * today. Answering the second by asking the first reads as a non-sequitur, and
 * it silently binds the two the day one of them changes.
 *
 * `ADMIN_MASTER` is absent for the reason it is absent there: the operator has
 * no tickets of its own, so it has no notes to read.
 */
export function handlesInternalNotes(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.AGENT;
}
