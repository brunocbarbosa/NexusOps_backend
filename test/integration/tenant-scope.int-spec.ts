import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
  scopeFor,
  useScope,
} from '../utils/tenant-scope';

/**
 * The runtime half of the tenant scope: that a scope really is a transaction,
 * and that the queries inside it really land on the connection that transaction
 * pinned.
 *
 * Worth its own file because everything here is invisible to every other suite.
 * The proxy could quietly fall through to the base client on every call and the
 * whole test suite would still pass today — the application connects as the
 * owning superuser, so nothing enforces the scope. It is only when
 * `DATABASE_URL_APP` is switched on that the difference becomes the difference
 * between "the request works" and "every read returns nothing". These
 * assertions are what turns that from a hope into a check.
 *
 * `test/integration/rls.int-spec.ts` is the other half: it drives raw SQL as the
 * application role and shows what the database does. This one shows that the
 * runtime speaks to it the way the policies expect.
 */
describe('the tenant scope, as the runtime opens it', () => {
  const prisma: ExtendedPrismaClient = createPrismaClient(
    process.env.DATABASE_URL as string,
  );
  useScope(scopeFor(prisma));

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const readTenant = () =>
    prisma.$queryRaw<{ t: string | null }[]>`
      SELECT current_setting('app.tenant_id', true) AS t
    `;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sets the tenant on the connection the query runs on', async () => {
    const [row] = await runWithTenant(tenantA, readTenant);
    expect(row.t).toBe(tenantA);
  });

  // Raw SQL never reaches the tenancy extension, which is the whole reason RLS
  // exists — so if the proxy did not route it into the transaction, this is the
  // query that would silently escape the scope.
  it('routes raw SQL into the transaction, not around it', async () => {
    const ids = await runWithTenant(tenantA, async () => {
      const first = await prisma.$queryRaw<{ x: string }[]>`
        SELECT txid_current()::text AS x
      `;
      const second = await prisma.$queryRaw<{ x: string }[]>`
        SELECT txid_current()::text AS x
      `;
      return [first[0].x, second[0].x];
    });

    // One transaction id for both statements: they share a transaction, which
    // means they share a connection, which is what the policy needs.
    expect(ids[0]).toBe(ids[1]);
  });

  it('gives a scope its own transaction rather than reusing the last one', async () => {
    const first = await runWithTenant(
      tenantA,
      () => prisma.$queryRaw<{ x: string }[]>`SELECT txid_current()::text AS x`,
    );
    const second = await runWithTenant(
      tenantA,
      () => prisma.$queryRaw<{ x: string }[]>`SELECT txid_current()::text AS x`,
    );

    expect(first[0].x).not.toBe(second[0].x);
  });

  // Settled decision #0: a nested scope reuses the open transaction and
  // re-points it, rather than opening a second one on a second connection.
  it('switches the tenant inside a nested scope and restores it on the way out', async () => {
    const seen = await runWithTenant(tenantA, async () => {
      const outer = (await readTenant())[0].t;
      const inner = await runWithTenant(
        tenantB,
        async () => (await readTenant())[0].t,
      );
      const restored = (await readTenant())[0].t;
      return { outer, inner, restored };
    });

    expect(seen).toEqual({
      outer: tenantA,
      inner: tenantB,
      restored: tenantA,
    });
  });

  it('keeps a nested scope on the same transaction as its parent', async () => {
    const ids = await runWithTenant(tenantA, async () => {
      const outer = await prisma.$queryRaw<{ x: string }[]>`
        SELECT txid_current()::text AS x
      `;
      const inner = await runWithTenant(
        tenantB,
        () =>
          prisma.$queryRaw<{ x: string }[]>`SELECT txid_current()::text AS x`,
      );
      return [outer[0].x, inner[0].x];
    });

    expect(ids[0]).toBe(ids[1]);
  });

  // Written as the empty string because there is no way back to unset. It only
  // reads as "no tenant" because the policies wrap the setting in `nullif` —
  // the two halves are one mechanism, and this is the runtime half.
  it('writes the empty string for an unscoped scope, not NULL', async () => {
    const [row] = await runWithoutTenant(readTenant);
    expect(row.t).toBe('');
  });

  // `attempt()` exists because a failed statement aborts the whole transaction.
  // Without the savepoint, the read after the failure would answer 25P02.
  it('survives a failed statement inside attempt(), and reports the original error', async () => {
    const scope = scopeFor(prisma);

    const answer = await scope.runWithTenant(tenantA, async () => {
      await expect(
        scope.attempt(() => prisma.$queryRaw`SELECT 1 / 0`),
      ).rejects.toThrow(/division by zero/i);

      // The transaction is still usable, which is the entire point.
      const [row] = await readTenant();
      return row.t;
    });

    expect(answer).toBe(tenantA);
  });
});
