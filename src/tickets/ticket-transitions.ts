import { TicketStatus } from '../generated/prisma/enums';

/**
 * The legal status transitions, as data rather than as a chain of ifs.
 *
 * Two of the entries are the whole design and are worth reading as decisions:
 *
 * `RESOLVED -> OPEN` exists because "resolved" is a claim by an agent, and the
 * person who opened the ticket is the one who gets to disagree. Without it a
 * reopened problem becomes a second ticket, and the history splits in two.
 *
 * `CLOSED` leads nowhere. It is terminal on purpose: a closed ticket is a
 * record, and this project keeps an audit trail precisely so that records stay
 * still. Reopening after closure means opening a new ticket that references it.
 *
 * The map is exhaustive over `TicketStatus` by type, so adding a status to the
 * enum without deciding where it may go from is a compile error rather than a
 * silently unreachable state.
 */
export const TICKET_TRANSITIONS: Readonly<
  Record<TicketStatus, readonly TicketStatus[]>
> = {
  [TicketStatus.OPEN]: [TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED],
  [TicketStatus.IN_PROGRESS]: [TicketStatus.RESOLVED, TicketStatus.OPEN],
  [TicketStatus.RESOLVED]: [TicketStatus.CLOSED, TicketStatus.OPEN],
  [TicketStatus.CLOSED]: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}
