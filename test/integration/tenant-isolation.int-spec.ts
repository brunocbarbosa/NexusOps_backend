import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import {
  CrossTenantWriteError,
  tenantIsolationExtension,
} from '../../src/tenancy/tenant-extension';
import {
  TenantContextMissingError,
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';

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

// The chokepoint itself. Fixtures are built with the unextended client on purpose:
// a fixture built by the thing under test proves nothing.
describe('tenant isolation (extension)', () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const base = new PrismaClient({ adapter });
  const prisma = base.$extends(tenantIsolationExtension);

  const run = randomUUID();
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let ticketA: string;
  let ticketB: string;

  beforeAll(async () => {
    const seed = async (label: string) => {
      const tenant = await base.tenant.create({
        data: { name: `Ext ${label}`, domain: `ext-${label}-${run}.example` },
      });
      const user = await base.user.create({
        data: {
          tenantId: tenant.id,
          email: 'agent@example.com',
          passwordHash: 'not-a-real-hash',
        },
      });
      const ticket = await base.ticket.create({
        data: {
          tenantId: tenant.id,
          requesterId: user.id,
          title: `Ticket of ${label}`,
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
    await base.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await base.$disconnect();
  });

  it('returns only the active tenant rows from findMany', async () => {
    const tickets = await runWithTenant(tenantA, () =>
      prisma.ticket.findMany(),
    );
    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe(ticketA);
  });

  it('refuses to query at all when no tenant is in context', async () => {
    await expect(prisma.ticket.findMany()).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('scopes every read operation, not just findMany', async () => {
    await runWithTenant(tenantA, async () => {
      expect(await prisma.ticket.count()).toBe(1);

      const aggregate = await prisma.ticket.aggregate({
        _count: { _all: true },
      });
      expect(aggregate._count._all).toBe(1);

      const groups = await prisma.ticket.groupBy({
        by: ['status'],
        _count: { _all: true },
      });
      expect(groups).toHaveLength(1);
      expect(groups[0]._count._all).toBe(1);

      const first = await prisma.ticket.findFirst();
      expect(first?.id).toBe(ticketA);

      // Another tenant's id is not-found rather than data.
      expect(
        await prisma.ticket.findUnique({ where: { id: ticketB } }),
      ).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: userB } })).toBeNull();
    });
  });

  it('stamps the tenant on create without the caller supplying it', async () => {
    const created = await runWithTenant(tenantA, () =>
      prisma.ticket.create({
        data: { requesterId: userA, title: 'stamped' },
      } as Parameters<typeof prisma.ticket.create>[0]),
    );
    expect(created.tenantId).toBe(tenantA);
    await base.ticket.delete({ where: { id: created.id } });
  });

  it('rejects a create that names another tenant', async () => {
    await expect(
      runWithTenant(tenantA, () =>
        prisma.ticket.create({
          data: { tenantId: tenantB, requesterId: userB, title: 'smuggled' },
        }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
  });

  // The where-filter alone does not catch this one: it confines the update to the
  // caller's own rows, but data.tenantId would move a row *out* of the tenant.
  it('rejects an update that tries to rewrite tenantId', async () => {
    await expect(
      runWithTenant(tenantA, () =>
        prisma.ticket.updateMany({
          where: { id: ticketA },
          data: { tenantId: tenantB },
        }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
  });

  it('confines updateMany, deleteMany and upsert to the active tenant', async () => {
    await runWithTenant(tenantA, async () => {
      // An unfiltered updateMany must still not reach tenant B.
      const updated = await prisma.ticket.updateMany({
        data: { status: 'CLOSED' },
      });
      expect(updated.count).toBe(1);

      const spare = await prisma.ticket.create({
        data: { requesterId: userA, title: 'disposable' },
      } as Parameters<typeof prisma.ticket.create>[0]);
      const deleted = await prisma.ticket.deleteMany({
        where: { id: spare.id },
      });
      expect(deleted.count).toBe(1);

      // Upserting another tenant's id must not touch that tenant's row.
      await prisma.ticket.upsert({
        where: { id: ticketB },
        create: { requesterId: userA, title: 'upserted' },
        update: { title: 'hijacked' },
      } as Parameters<typeof prisma.ticket.upsert>[0]);
    });

    const untouched = await base.ticket.findUniqueOrThrow({
      where: { id: ticketB },
    });
    expect(untouched.title).toBe('Ticket of b');
    expect(untouched.status).toBe('OPEN');

    await base.ticket.deleteMany({
      where: { tenantId: tenantA, title: 'upserted' },
    });
  });

  // Workers and gateways have no HTTP request, so this is the shape that matters most:
  // the tenant travels in the job payload and the handler re-establishes the scope.
  describe('background worker', () => {
    const handler = async (job: { tenantId: string }) =>
      runWithTenant(job.tenantId, () => prisma.ticket.findMany());

    it('sees one tenant when the payload scope is re-established', async () => {
      const rows = await handler({ tenantId: tenantB });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(ticketB);
    });

    it('throws rather than leaking when the wrapper is forgotten', async () => {
      const forgetful = () => prisma.ticket.findMany();
      await expect(forgetful()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });
  });

  // Nested writes are closed by the composite foreign keys, not by this extension:
  // the child's tenantId is derived from the parent and is absent from the input type.
  it('derives the tenant of a nested child from its parent', async () => {
    const ticket = await runWithTenant(tenantA, () =>
      prisma.ticket.create({
        data: {
          requesterId: userA,
          title: 'with a comment',
          comments: { create: [{ authorId: userA, body: 'nested' }] },
        },
      } as Parameters<typeof prisma.ticket.create>[0]),
    );

    // Read back with the unextended client: the point is what landed on disk.
    const comments = await base.comment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].tenantId).toBe(tenantA);
    await base.ticket.delete({ where: { id: ticket.id } });
  });

  it('lets PostgreSQL reject a child whose author belongs to another tenant', async () => {
    await expect(
      runWithTenant(tenantA, () =>
        prisma.comment.create({
          data: { ticketId: ticketA, authorId: userB, body: 'foreign author' },
        } as Parameters<typeof prisma.comment.create>[0]),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  // Recorded so the remaining RLS gap is a measured fact and not folklore.
  it('does NOT scope raw SQL, which is what RLS is for', async () => {
    const rows = await runWithTenant(
      tenantA,
      () =>
        prisma.$queryRaw<{ tenants: bigint }[]>`
        SELECT count(DISTINCT tenant_id) AS tenants FROM tickets`,
    );
    expect(Number(rows[0].tenants)).toBe(2);
  });

  describe('the Tenant model, which has no tenantId of its own', () => {
    const both = () => ({ where: { id: { in: [tenantA, tenantB] } } });

    it('is scoped to the caller inside a tenant context', async () => {
      const scoped = await runWithTenant(tenantA, () =>
        prisma.tenant.findMany(both()),
      );
      expect(scoped).toHaveLength(1);
      expect(scoped[0].id).toBe(tenantA);
    });

    // The login path: find a tenant by domain before any tenant identity exists.
    it('is readable in full only under an explicit runWithoutTenant', async () => {
      const unscoped = await runWithoutTenant(() =>
        prisma.tenant.findMany(both()),
      );
      expect(unscoped).toHaveLength(2);
    });

    // A context lost by accident must not quietly widen into every tenant.
    it('is refused when there is no context at all', async () => {
      await expect(prisma.tenant.findMany()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });
  });
});
