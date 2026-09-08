import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { resetDatabase } from '../utils/reset-database';

/**
 * Row-Level Security, the second isolation layer — the database half of it.
 *
 * **This suite deliberately does not go through the application.** It connects
 * as the application's own role and drives raw SQL by hand, because what Part I
 * of `documents/RLS_DESIGN.md` delivered is a database layer: a role, seven
 * policies and a set of grants. The runtime still connects with `DATABASE_URL`,
 * as the owning superuser, so an assertion made through `PrismaModule` today
 * would prove nothing about the policies — it would bypass them.
 *
 * That is also why nothing here imports the tenancy extension. The extension is
 * the *first* layer; this file exists to show the second one standing on its
 * own, which is the whole point of calling them "deliberately redundant".
 *
 * The transaction shape below — `$executeRaw` a `set_config`, then query, all
 * inside one interactive `$transaction` — is not incidental. It is exactly what
 * `TenantScopeService` will do in Part II, so these tests pin the mechanism
 * before the code that wraps it exists.
 *
 * Catalogue checks (`describe('is it configured')`) prove only the **absence**
 * of enforcement, quickly. The behavioural ones below them are what turn this
 * layer from configured into verified.
 */

/** The seven that must be scoped today. Derived checks below also catch new ones. */
const KNOWN_SCOPED_TABLES = [
  'audit_logs',
  'comments',
  'refresh_tokens',
  'reports',
  'ticket_counters',
  'tickets',
  'users',
];

describe('Row-Level Security (database layer)', () => {
  // The owner. A superuser here, so it bypasses the policies and can seed —
  // measured, and the reason `FORCE ROW LEVEL SECURITY` changes nothing in this
  // repository's own containers. See RLS_NOTES.md.
  const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  // The application's role: NOSUPERUSER NOBYPASSRLS, owning nothing.
  //
  // `max: 1` is not tuning. It pins every query in this suite to one physical
  // connection, which is what makes the "recycled connection" test below
  // deterministic rather than dependent on which connection the pool handed out.
  const app = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL_APP,
      max: 1,
    }),
  });

  const suffix = randomUUID();
  let tenantA: string;
  let tenantB: string;

  /** One scope, the way Part II will open it: set the tenant, then query, in one transaction. */
  const inScope = <T>(
    tenantId: string | null,
    fn: (tx: Omit<PrismaClient, '$transaction'>) => Promise<T>,
  ): Promise<T> =>
    app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId ?? ''}, true)`;
      return fn(tx as unknown as Omit<PrismaClient, '$transaction'>);
    });

  beforeAll(async () => {
    await resetDatabase(owner);

    const seed = async (label: string) => {
      const tenant = await owner.tenant.create({
        data: { name: `Tenant ${label}`, domain: `${label}-${suffix}.example` },
      });
      const user = await owner.user.create({
        data: {
          tenantId: tenant.id,
          email: `someone@${label}.example`,
          passwordHash: 'not-a-real-hash',
        },
      });
      await owner.ticket.create({
        data: {
          tenantId: tenant.id,
          number: 1,
          requesterId: user.id,
          title: `Ticket of tenant ${label}`,
        },
      });
      return tenant.id;
    };

    tenantA = await seed('a');
    tenantB = await seed('b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await app.$disconnect();
  });

  // ---------------------------------------------------------------------------
  describe('is it configured', () => {
    // The first question, because a `true` in either column makes every other
    // check in this file meaningless: the role would see everything regardless.
    it('the application role can neither bypass RLS nor act as a superuser', async () => {
      const [role] = await app.$queryRaw<
        { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

      expect(role.rolname).toBe('nexusops_app');
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);
    });

    // Read from the catalogue rather than from a hard-coded list, so a model
    // added later with a `tenant_id` and no policy fails here instead of leaking
    // in production. KNOWN_SCOPED_TABLES only guards the query itself: without
    // it, a query that returned nothing would make every assertion vacuous.
    it('every table carrying tenant_id has RLS enabled and forced, and one policy', async () => {
      const rows = await owner.$queryRaw<
        {
          tablename: string;
          enabled: boolean;
          forced: boolean;
          policies: bigint;
        }[]
      >`
        SELECT c.relname                AS tablename,
               c.relrowsecurity         AS enabled,
               c.relforcerowsecurity    AS forced,
               (SELECT count(*) FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
        FROM   pg_class c
        WHERE  c.relnamespace = 'public'::regnamespace
          AND  c.relkind = 'r'
          AND  EXISTS (
                 SELECT 1 FROM information_schema.columns col
                 WHERE col.table_name = c.relname AND col.column_name = 'tenant_id'
               )
        ORDER  BY c.relname
      `;

      expect(rows.map((r) => r.tablename)).toEqual(
        expect.arrayContaining(KNOWN_SCOPED_TABLES),
      );

      for (const row of rows) {
        expect({
          table: row.tablename,
          enabled: row.enabled,
          forced: row.forced,
          policies: Number(row.policies),
        }).toEqual({
          table: row.tablename,
          enabled: true,
          forced: true,
          policies: 1,
        });
      }
    });

    // `tenants` is the tenant rather than being scoped by one, and login has to
    // find it before any tenant identity exists. A policy here would make every
    // login fail with "invalid credentials" and nothing would explain why.
    it('tenants carries no policy, and the application role can still read it', async () => {
      const [{ count }] = await owner.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenants'`;
      expect(Number(count)).toBe(0);

      const rows = await app.$queryRaw<
        { id: string }[]
      >`SELECT id FROM tenants`;
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    // The suites truncate to reset and do it as the owner, precisely so the
    // application role never holds a privilege that empties a tenant's tables in
    // one statement. A grant that drifted to ALL PRIVILEGES would fail here.
    it('the application role cannot TRUNCATE', async () => {
      await expect(
        app.$executeRawUnsafe('TRUNCATE TABLE users'),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // ---------------------------------------------------------------------------
  describe('does it enforce', () => {
    // Fail-closed: no tenant means no rows, not an error and not everything.
    it('outside any scope, a read returns nothing', async () => {
      const rows = await app.$queryRaw<{ id: string }[]>`SELECT id FROM users`;
      expect(rows).toEqual([]);
    });

    // The one that would have been an error rather than an empty result without
    // `nullif` in the policy: a transaction-local setting never goes back to
    // unset, so a connection that has served a scope reads `''` afterwards and
    // `''::uuid` raises 22P02. `max: 1` above is what guarantees this runs on
    // the connection the scope just used. See RLS_NOTES.md, third trap.
    it('outside a scope on a connection that has served one, a read still returns nothing', async () => {
      await inScope(tenantA, (tx) => tx.$queryRaw`SELECT id FROM users`);

      const rows = await app.$queryRaw<{ id: string }[]>`SELECT id FROM users`;
      expect(rows).toEqual([]);
    });

    it("inside a scope, a read returns that tenant's rows and no others", async () => {
      const rows = await inScope(
        tenantA,
        (tx) =>
          tx.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM users`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantA);
    });

    it('a cross-tenant INSERT is refused by WITH CHECK', async () => {
      await expect(
        inScope(
          tenantA,
          (tx) => tx.$executeRaw`
            INSERT INTO users (id, tenant_id, email, password_hash)
            VALUES (gen_random_uuid(), ${tenantB}::uuid, 'intruder@b.example', 'x')
          `,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    // The half that is easy to forget: without WITH CHECK the policy would stop
    // tenant A reading B's rows while still letting it write its own rows *into*
    // B, which is a leak in the other direction.
    it('an UPDATE that moves a row into another tenant is refused', async () => {
      await expect(
        inScope(
          tenantA,
          (tx) => tx.$executeRaw`UPDATE users SET tenant_id = ${tenantB}::uuid`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    // Both tenants still have exactly what they started with. A failed write
    // that had partially landed would show up here and nowhere else.
    it('leaves both tenants intact', async () => {
      for (const tenant of [tenantA, tenantB]) {
        const rows = await inScope(
          tenant,
          (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM users`,
        );
        expect(rows).toHaveLength(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('nesting', () => {
    // The mechanism settled decision #0 rests on: a nested scope reuses the open
    // transaction and re-emits set_config, and leaving it puts the enclosing
    // tenant back. Without the restore, the ALS store would say one tenant while
    // the database session said another — the two layers disagreeing silently,
    // which is the exact failure RLS is here to catch.
    //
    // Written against raw SQL because TenantScopeService does not exist yet.
    // When it does, it has to keep producing this sequence.
    it('re-setting the tenant mid-transaction switches scope, and restoring puts it back', async () => {
      const seen = await app.$transaction(async (tx) => {
        const read = async () =>
          (
            await tx.$queryRaw<{ tenant_id: string }[]>`
              SELECT tenant_id FROM users
            `
          ).map((r) => r.tenant_id);

        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        const outer = await read();

        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
        const inner = await read();

        // Leaving the nested scope: back to the enclosing tenant.
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        const restored = await read();

        // And leaving the outer one: back to unscoped. It has to be written as
        // the empty string, because there is no way back to unset — which is
        // only readable as "no tenant" because the policy wraps it in nullif.
        await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
        const unscoped = await read();

        return { outer, inner, restored, unscoped };
      });

      expect(seen).toEqual({
        outer: [tenantA],
        inner: [tenantB],
        restored: [tenantA],
        unscoped: [],
      });
    });

    // An expected refusal aborts the transaction like any other error, so a test
    // that asserts one and keeps going gets 25P02 on everything after it. This
    // pins the savepoint that makes such a test writable at all.
    it('a refusal taken in a SAVEPOINT leaves the transaction usable', async () => {
      const survived = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx.$executeRawUnsafe('SAVEPOINT refusal');

        await expect(
          tx.$executeRaw`
            INSERT INTO users (id, tenant_id, email, password_hash)
            VALUES (gen_random_uuid(), ${tenantB}::uuid, 'nope@b.example', 'x')
          `,
        ).rejects.toThrow(/row-level security/i);

        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refusal');

        return tx.$queryRaw<{ id: string }[]>`SELECT id FROM users`;
      });

      expect(survived).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Waiting on Part II of documents/RLS_DESIGN.md — the runtime. They are listed
  // rather than omitted so the gap is visible in the suite's own output instead
  // of living only in a design document.
  describe('waiting on the runtime (Part II)', () => {
    it.todo(
      'the application connects as nexusops_app, so a query outside a scope returns nothing',
    );
    it.todo(
      'CompaniesService.create() still creates a company, its counter and its first ADMIN',
    );
    it.todo('a mutation that rolls back emits no domain event');
    it.todo('the audit row for a committed mutation lands after the commit');
    it.todo('a ticket export runs to completion as the application role');
  });
});
