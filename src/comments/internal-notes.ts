import { UserRole } from '../generated/prisma/enums';

/**
 * Who may read and write the internal note on a ticket.
 *
 * Its body used to be identical to `seesEveryTicket()` in `src/tickets/`, and
 * the argument for keeping them apart was that "may this person see every
 * ticket in the company" and "may this person read the note the customer is not
 * meant to see" are two questions that happened to share an answer.
 *
 * They stopped sharing it. The `AGENT` left `seesEveryTicket()` and stayed
 * here, because an agent working a ticket still writes its internal note: the
 * ticket-level 404 decides *which* ticket it reaches, and this predicate only
 * ever decides *what* it may do on one it can already see. Had the two been
 * collapsed into one, narrowing visibility would have silently taken the
 * internal note away from the only person using it.
 *
 * `ADMIN_MASTER` is absent for the reason it is absent there: the operator has
 * no tickets of its own, so it has no notes to read.
 */
export function handlesInternalNotes(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.AGENT;
}
