import { Prisma } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';

/**
 * Who sees the company's whole queue, and who sees only the tickets they are
 * part of.
 *
 * This is the one rule that makes the same URL answer differently to two
 * people in the same company, so it lives in a named predicate rather than
 * inlined at the two call sites that need it — the list, and the single read
 * every other route in the slice resolves through.
 *
 * **An `AGENT` is not here any more, and that is the change.** An agent sees
 * the tickets assigned to them and nothing else. A helpdesk where every agent
 * reads every ticket in the company makes "who is working this" a label rather
 * than a boundary. The cost is stated rather than hidden: nobody but an `ADMIN`
 * sees a ticket nobody is assigned to, so nothing gets worked until somebody
 * assigns it — which is why assignment is an `ADMIN` route now. The two rules
 * only make sense together, and an agent could not have assigned one to
 * themselves anyway: `load()` 404s the ticket before `mutate()` reaches the
 * write.
 *
 * `ADMIN_MASTER` is deliberately absent, for the reason it always was: the
 * operator lives in the reserved platform tenant, which has no tickets, so it
 * falls into the scoped branch and sees an empty list — which is the right
 * answer. Adding it here would read as "the operator may inspect any company's
 * tickets", and no route offers that.
 *
 * `RolesGuard` stays non-hierarchical, as everywhere else: this is not "ADMIN
 * outranks AGENT", it is the one role that answers yes to one specific
 * question.
 */
export function seesEveryTicket(role: UserRole): boolean {
  return role === UserRole.ADMIN;
}

/**
 * The tickets one person is part of: the ones they opened, and the one they
 * are working.
 *
 * A `where` fragment and not a boolean, because this question stopped being
 * answerable from the role alone the moment "assigned to me" entered it — it
 * needs the row. Keeping it beside `seesEveryTicket()` rather than inlining it
 * in the service is what lets the rule and its composition stay apart:
 * `visibleTo()` decides *whether* to scope, this decides *what the scope is*,
 * and neither has to know how the other behaves when a caller's own filter is
 * already present.
 *
 * **Two arms, and only one of them is ever live per role.** A `REQUESTER` can
 * never be an assignee — `assertAssignable()` answers 409 to one — so the
 * second arm is inert for them. An `AGENT` can no longer open a ticket, so the
 * first arm is inert for anything they file from now on; it is kept because
 * tickets opened by agents under the old rule already exist in every
 * development database and must not become invisible to their own authors, and
 * because an `ADMIN` who opens a ticket is its requester like anybody else. One
 * predicate that is right for four roles beats a per-role branch that has to be
 * re-read every time a role is added.
 */
export function ticketsInvolving(userId: string): Prisma.TicketWhereInput {
  return { OR: [{ requesterId: userId }, { assigneeId: userId }] };
}
