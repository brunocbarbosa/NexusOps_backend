import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

// What the domain schema does and does not guarantee on its own.
//
// The tenant filter is not in place yet: AsyncLocalStorage and the Prisma Client
// Extension are the next slice. These tests pin down the starting point, so that
// slice has something concrete to turn green. See CLAUDE.md > Architecture.
describe('tenant isolation (schema layer)', () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // Suffixed so reruns do not collide on the unique `domain`.
  const run = randomUUID();
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let ticketA: string;
  let ticketB: string;

  beforeAll(async () => {
    const seed = async (label: string) => {
      const tenant = await prisma.tenant.create({
        data: { name: `Tenant ${label}`, domain: `${label}-${run}.example` },
      });
      const user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: 'shared@example.com',
          passwordHash: 'not-a-real-hash',
        },
      });
      const ticket = await prisma.ticket.create({
        data: {
          tenantId: tenant.id,
          requesterId: user.id,
          title: `Ticket of tenant ${label}`,
        },
      });
      return { tenant: tenant.id, user: user.id, ticket: ticket.id };
    };

    const a = await seed('a');
    const b = await seed('b');
    [tenantA, userA, ticketA] = [a.tenant, a.user, a.ticket];
    [tenantB, userB, ticketB] = [b.tenant, b.user, b.ticket];
  });

  afterAll(async () => {
    // Cascade from Tenant clears users, tickets, comments and audit logs.
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await prisma.$disconnect();
  });

  // The reason the extension has to exist. This assertion gets inverted once the
  // tenant filter is injected at the chokepoint.
  it('leaks across tenants when the query carries no tenant filter', async () => {
    const tickets = await prisma.ticket.findMany({
      where: { id: { in: [ticketA, ticketB] } },
    });

    const tenants = new Set(tickets.map((t) => t.tenantId));
    expect(tenants.size).toBe(2);
  });

  // The mechanism the next slice depends on: @@unique([tenantId, id]) means a
  // single-record read can be scoped to one tenant, so another tenant's id comes
  // back as not-found rather than as data.
  it('scopes a single-record read to one tenant via the compound unique', async () => {
    const own = await prisma.ticket.findUnique({
      where: { tenantId_id: { tenantId: tenantA, id: ticketA } },
    });
    expect(own?.id).toBe(ticketA);

    const foreign = await prisma.ticket.findUnique({
      where: { tenantId_id: { tenantId: tenantA, id: ticketB } },
    });
    expect(foreign).toBeNull();
  });

  // @@unique([tenantId, email]) - the same person can exist in two tenants, but
  // not twice in one. Both tenants were already seeded with shared@example.com.
  it('makes email unique per tenant rather than globally', async () => {
    const [a, b] = await Promise.all([
      prisma.user.findUnique({
        where: {
          tenantId_email: { tenantId: tenantA, email: 'shared@example.com' },
        },
      }),
      prisma.user.findUnique({
        where: {
          tenantId_email: { tenantId: tenantB, email: 'shared@example.com' },
        },
      }),
    ]);
    expect(a?.id).toBe(userA);
    expect(b?.id).toBe(userB);
    expect(a?.id).not.toBe(b?.id);

    await expect(
      prisma.user.create({
        data: {
          tenantId: tenantA,
          email: 'shared@example.com',
          passwordHash: 'not-a-real-hash',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // Optimistic concurrency. updateMany is the right call and update() is not:
  // update() requires a unique where, and { id, version } is not unique. A count
  // of 0 is what the service layer turns into 409 Conflict.
  it('rejects the losing writer when two updates share a starting version', async () => {
    const before = await prisma.ticket.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenantA, id: ticketA } },
    });

    const update = (title: string) =>
      prisma.ticket.updateMany({
        where: { id: ticketA, tenantId: tenantA, version: before.version },
        data: { title, version: { increment: 1 } },
      });

    const [first, second] = await Promise.all([
      update('winner'),
      update('loser'),
    ]);

    const counts = [first.count, second.count].sort();
    expect(counts).toEqual([0, 1]);

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenantA, id: ticketA } },
    });
    expect(after.version).toBe(before.version + 1);
  });
});
