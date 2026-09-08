import { TenantScopeService } from '../../src/tenancy/tenant-scope.service';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';

/**
 * `runWithTenant` / `runWithoutTenant` for the suites, as free functions.
 *
 * Opening a scope is a method on an injected provider now (settled decision #1
 * in documents/RLS_DESIGN.md), because it opens a database transaction and
 * needs a client. A suite therefore has to say *which* client its scopes run
 * on — and it always has one, either from the module it built or from the app
 * it booted.
 *
 * This file holds that choice in module state, which is exactly the shape
 * rejected for `src/`. The objection there does not apply here: the reason to
 * refuse it in production was that `runWithTenant` would keep the appearance of
 * a pure AsyncLocalStorage helper while quietly opening a transaction on a
 * client the class never declared. A spec declares it, in one visible line, and
 * Jest gives every test file its own module registry — so this state is
 * per-file, not shared.
 *
 * Call `useScope()` once, after the module or app exists:
 *
 * ```ts
 * beforeAll(async () => {
 *   const moduleRef = await Test.createTestingModule({ ... }).compile();
 *   useScope(moduleRef.get(TenantScopeService));
 * });
 * ```
 *
 * A suite that builds a bare client instead of a module uses `scopeFor(client)`.
 */
let active: TenantScopeService | null = null;

/** Points the helpers below at the scope service a suite has just obtained. */
export function useScope(scope: TenantScopeService): void {
  active = scope;
}

/**
 * For the unit tier, which has no database at all.
 *
 * The scope still has to open a "transaction", because that is what puts a `tx`
 * in the store and therefore what makes `requireTenantId()` answer. Nothing is
 * sent anywhere: the stub resolves `$executeRaw` and hands the callback a
 * client the spec's own mock ignores, since a unit spec injects its own Prisma
 * double into the service under test.
 */
export function fakeScope(): TenantScopeService {
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    // `attempt()` issues SAVEPOINT through this one.
    $executeRawUnsafe: () => Promise.resolve(0),
  };
  const client = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
  };
  return new TenantScopeService(client as never);
}

/** For suites that build a client directly rather than through Nest. */
export function scopeFor(prisma: ExtendedPrismaClient): TenantScopeService {
  return new TenantScopeService(prisma);
}

function required(): TenantScopeService {
  if (active === null) {
    throw new Error(
      'No TenantScopeService registered. Call useScope(...) in beforeAll, ' +
        'after the testing module or application exists. See test/utils/tenant-scope.ts.',
    );
  }
  return active;
}

export function runWithTenant<T>(
  tenantId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return required().runWithTenant(tenantId, fn);
}

export function runWithoutTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return required().runWithoutTenant(fn);
}
