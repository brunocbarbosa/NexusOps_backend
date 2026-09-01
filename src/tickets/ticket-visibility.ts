import { UserRole } from '../generated/prisma/enums';

/**
 * Who sees every ticket of a company, and who sees only their own.
 *
 * This is the one rule that makes the same URL answer differently to two
 * people in the same company, so it lives in a named predicate rather than
 * inlined at the three call sites that need it — the list, the single read and
 * the comment routes that come later.
 *
 * `ADMIN_MASTER` is deliberately absent. The operator lives in the reserved
 * platform tenant, which has no tickets, so it falls into the own-tickets-only
 * branch and sees an empty list — which is the right answer. Adding it here
 * would read as "the operator may inspect any company's tickets", and no route
 * offers that.
 *
 * `RolesGuard` stays non-hierarchical, as everywhere else: this is not
 * "AGENT outranks REQUESTER", it is the two roles that answer yes to one
 * specific question.
 */
export function seesEveryTicket(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.AGENT;
}
