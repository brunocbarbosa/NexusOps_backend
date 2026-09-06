import { UserRole } from '../generated/prisma/enums';
import { seesEveryTicket, ticketsInvolving } from './ticket-visibility';

/**
 * The rule the whole slice rests on, at the cheapest tier there is.
 *
 * It had no spec of its own while the answer was obvious — "staff sees
 * everything" reads the same as its body. It stopped being obvious the day the
 * `AGENT` left, so the answer is pinned here rather than only in the e2e suite
 * that would notice it three tiers later.
 */
describe('seesEveryTicket', () => {
  it('says yes to an ADMIN', () => {
    expect(seesEveryTicket(UserRole.ADMIN)).toBe(true);
  });

  // The assertion that carries the change: an AGENT used to answer true here.
  it('says no to an AGENT', () => {
    expect(seesEveryTicket(UserRole.AGENT)).toBe(false);
  });

  it('says no to a REQUESTER', () => {
    expect(seesEveryTicket(UserRole.REQUESTER)).toBe(false);
  });

  // Not an oversight: the operator's reserved tenant has no tickets, so the
  // scoped branch answers it with an empty list, which is what it should see.
  it('says no to the ADMIN_MASTER', () => {
    expect(seesEveryTicket(UserRole.ADMIN_MASTER)).toBe(false);
  });
});

describe('ticketsInvolving', () => {
  it('matches the tickets one person opened or is working', () => {
    expect(ticketsInvolving('user-7')).toEqual({
      OR: [{ requesterId: 'user-7' }, { assigneeId: 'user-7' }],
    });
  });
});
