import { randomUUID } from 'node:crypto';
import { UserRole } from '../../src/generated/prisma/enums';
import { createPrismaClient } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
  scopeFor,
  useScope,
} from '../utils/tenant-scope';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';

/**
 * The per-tenant ticket sequence, against a real PostgreSQL.
 *
 * `Ticket.number` is what a user says out loud, so it restarts at 1 in every
 * company and it may not skip or repeat. `SELECT MAX(number) + 1` cannot deliver
 * that: two concurrent opens read the same maximum. The design is a row in
 * `ticket_counters` incremented inside the same interactive transaction as the
 * insert, and this suite is what proves the design rather than assuming it.
 *
 * It runs before `TicketsService` exists and exercises the transaction shape
 * directly — the same shape the service will use in the next phase. Two claims
 * are being tested and they fail for different reasons:
 *
 *   1. Under concurrency the numbers come out as 1..N with no gap and no
 *      duplicate. A failure here is the race the counter exists to prevent.
 *   2. `updateManyAndReturn({ where: {} })` is scoped by the tenancy extension.
 *      A failure here means the increment reached another tenant's counter, and
 *      the whole reason the operation was chosen over `update` is gone.
 */
describe('per-tenant ticket numbering', () => {
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let requesterA: string;
  let requesterB: string;

  /**
   * The transaction `TicketsService.create` will run in the next phase.
   *
   * `where: {}` is not an oversight: the extension injects the tenant filter, so
   * the caller never names a tenant. The increment is evaluated by PostgreSQL and
   * takes a row lock that is held until this transaction commits, which is what
   * makes a second concurrent opener wait instead of reading a stale number.
   */
  const openTicket = (tenantId: string, requesterId: string, title: string) =>
    runWithTenant(tenantId, () =>
      prisma.$transaction(async (tx) => {
        const [counter] = await tx.ticketCounter.updateManyAndReturn({
          where: {},
          data: { lastNumber: { increment: 1 } },
        });

        return tx.ticket.create({
          data: tenantScoped({
            number: counter.lastNumber,
            requesterId,
            title,
          }),
        });
      }),
    );

  const seed = async (label: string) => {
    const domain = `numbering-${label}-${run}.example`;
    domains.push(domain);

    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({ data: { name: `Numbering ${label}`, domain } }),
    );

    return runWithTenant(tenant.id, async () => {
      // Created here because in production `CompaniesService.create` creates it
      // with the company. The increment is an update, not an upsert, so the row
      // has to exist before the first ticket.
      await prisma.ticketCounter.create({ data: tenantScoped({}) });

      const requester = await prisma.user.create({
        data: tenantScoped({
          email: `requester@${label}.example`,
          passwordHash: 'x',
          role: UserRole.REQUESTER,
        }),
      });

      return { tenantId: tenant.id, requesterId: requester.id };
    });
  };

  beforeAll(async () => {
    prisma = createPrismaClient(process.env.DATABASE_URL as string, 25);
    useScope(scopeFor(prisma));
    ({ tenantId: tenantA, requesterId: requesterA } = await seed('a'));
    ({ tenantId: tenantB, requesterId: requesterB } = await seed('b'));
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await prisma.$disconnect();
  });

  it('gives the first ticket of a company the number 1', async () => {
    const ticket = await openTicket(tenantA, requesterA, 'first');

    expect(ticket.number).toBe(1);
  });

  it('restarts the sequence in every company', async () => {
    const ticket = await openTicket(tenantB, requesterB, 'first of B');

    // Tenant A already holds number 1. If the counter were global — or if the
    // extension had failed to scope the increment — this would be 2.
    expect(ticket.number).toBe(1);
  });

  it('hands out no gap and no duplicate under concurrency', async () => {
    const CONCURRENT = 20;

    const tickets = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        openTicket(tenantA, requesterA, `concurrent ${i}`),
      ),
    );

    const numbers = tickets
      .map((ticket) => ticket.number)
      .sort((a, b) => a - b);

    // Number 1 was taken by the first test, so this batch must be exactly
    // 2..CONCURRENT+1. Sorting first because the order they resolve in is not
    // the order they committed in, and that is not what is under test.
    expect(numbers).toEqual(
      Array.from({ length: CONCURRENT }, (_, i) => i + 2),
    );
    expect(new Set(numbers).size).toBe(CONCURRENT);
  });

  it('leaves the other company untouched while that happens', async () => {
    const counter = await runWithTenant(tenantB, () =>
      prisma.ticketCounter.findFirst({}),
    );

    // Tenant B opened exactly one ticket. Twenty-one increments landed on A.
    expect(counter?.lastNumber).toBe(1);
  });

  it('refuses two tickets with the same number in one company', async () => {
    // The counter is the mechanism; this unique index is the backstop. If the
    // counter logic ever regresses, the database is what stops two "chamado 3"
    // from existing rather than a code review.
    await expect(
      runWithTenant(tenantA, () =>
        prisma.ticket.create({
          data: tenantScoped({
            number: 1,
            requesterId: requesterA,
            title: 'duplicate number',
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
