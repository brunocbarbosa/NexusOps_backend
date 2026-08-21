import { randomUUID } from 'node:crypto';
import {
  ExtendedPrismaClient,
  createPrismaClient,
} from '../../src/prisma/prisma.client';
import {
  TenantContextMissingError,
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';
import { CrossTenantWriteError } from '../../src/tenancy/tenant-extension';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';

/**
 * The client the application actually runs.
 *
 * `tenant-isolation.int-spec.ts` builds a bare client on purpose, to show what
 * the schema guarantees *without* the extension. This file is the opposite end:
 * it proves that what `createPrismaClient()` hands to the Nest container has the
 * extension attached, so nothing between the factory and a service can quietly
 * drop it.
 */
describe('createPrismaClient (application client)', () => {
  let prisma: ExtendedPrismaClient;

  // Suffixed so reruns do not collide on the unique `domain`.
  const run = randomUUID();
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    prisma = createPrismaClient(process.env.DATABASE_URL as string);

    // Tenant is the one tenant-agnostic model, so seeding it needs the explicit
    // unscoped escape hatch — exactly what the register/login paths use.
    const seed = async (label: string) => {
      const tenant = await runWithoutTenant(() =>
        prisma.tenant.create({
          data: { name: `Tenant ${label}`, domain: `${label}-${run}.example` },
        }),
      );
      await runWithTenant(tenant.id, () =>
        prisma.user.create({
          data: tenantScoped({
            email: `owner@${label}.example`,
            passwordHash: 'not-a-real-hash',
          }),
        }),
      );
      return tenant.id;
    };

    tenantA = await seed('client-a');
    tenantB = await seed('client-b');
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }),
    );
    await prisma.$disconnect();
  });

  it('injects the tenant filter into a read nobody scoped by hand', async () => {
    const users = await runWithTenant(tenantA, () => prisma.user.findMany());

    expect(users).toHaveLength(1);
    expect(users[0].tenantId).toBe(tenantA);
  });

  // The runtime half: a create whose payload genuinely has no tenantId still
  // lands in the right tenant, because the extension stamps it. The cast is the
  // point of the test — `tenantScoped` is what production uses, and this proves
  // the extension does not depend on it.
  it('stamps the tenant into a create that omits it', async () => {
    const payload = { email: `stamped-${run}@b.example`, passwordHash: 'x' };

    const created = await runWithTenant(tenantB, () =>
      prisma.user.create({
        data: payload as typeof payload & { tenantId: string },
      }),
    );

    expect(created.tenantId).toBe(tenantB);
  });

  // And the type-level half agrees with it.
  it('accepts a tenantScoped payload without argument from the caller', async () => {
    const created = await runWithTenant(tenantB, () =>
      prisma.user.create({
        data: tenantScoped({
          email: `scoped-${run}@b.example`,
          passwordHash: 'x',
        }),
      }),
    );

    expect(created.tenantId).toBe(tenantB);
  });

  it('refuses a write aimed at another tenant', async () => {
    await expect(
      runWithTenant(tenantA, () =>
        prisma.user.create({
          data: {
            tenantId: tenantB,
            email: `smuggled-${run}@b.example`,
            passwordHash: 'x',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
  });

  // A single-record read of somebody else's row comes back empty rather than
  // populated, so the API answers 404 and never confirms the row exists.
  it('returns another tenant row as not-found', async () => {
    const foreign = await runWithTenant(tenantA, () =>
      prisma.user.findFirst({ where: { email: 'owner@client-b.example' } }),
    );

    expect(foreign).toBeNull();
  });

  // The failure mode this whole design exists to prevent, pinned down: with no
  // scope the query does not run unfiltered, it does not run at all.
  it('refuses to query at all with no tenant in context', async () => {
    await expect(prisma.user.findMany()).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  // Raw SQL is a client operation, not a model one, so it never reaches the
  // extension. Pinned here so the day RLS lands there is a test that changes.
  it('leaves raw SQL unfiltered — the hole RLS is for', async () => {
    const rows = await runWithTenant(
      tenantA,
      () =>
        prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM users WHERE tenant_id = ${tenantB}::uuid
      `,
    );

    expect(rows[0].count).toBeGreaterThan(0n);
  });
});
