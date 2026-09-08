import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import {
  PendingRelease,
  TenantTransaction,
  tenantStorage,
} from './tenant-store';

/**
 * Prisma's own default is 5s. This is the ceiling on everything one scope can
 * hold, and a scope is now a whole request. Deliberately a constant rather than
 * another environment variable: it is a property of the design, not of a
 * deployment.
 */
const SCOPE_TIMEOUT_MS = 15_000;

/** How long to wait for a connection before giving up on opening the scope. */
const SCOPE_MAX_WAIT_MS = 5_000;

/**
 * Opens the tenant scope, which is now also a database transaction.
 *
 * **Every scope is a transaction, `runWithoutTenant()` included, and a nested
 * scope reuses the one that is already open.** One rule, no exceptions; settled
 * decision #0 in documents/RLS_DESIGN.md records why the narrower version of it
 * cannot work — `CompaniesService.create()` changes tenant scope in the middle
 * of a transaction it opened by hand, and under the narrower rule its two halves
 * land on two connections and the writes die on the policy.
 *
 * Why a transaction at all: Row-Level Security reads the tenant from
 * `current_setting('app.tenant_id')`, which is set transaction-locally and only
 * applies to the connection it was set on. With `@prisma/adapter-pg`, one
 * connection for both the `set_config` and the query is only guaranteed inside
 * an interactive `$transaction`. See documents/important/RLS_NOTES.md.
 *
 * Why a provider and not the free functions this replaces: opening a
 * transaction means reaching a live client, which only the container can hand
 * out. A module-level singleton registered at boot would work and was rejected
 * — it is the same invisible global that `PrismaModule` refuses to be by not
 * being `@Global()`, and it would leave `runWithTenant` looking like a pure
 * AsyncLocalStorage helper while it opens a database transaction. Settled
 * decision #1.
 */
@Injectable()
export class TenantScopeService {
  constructor(@Inject(PRISMA) private readonly prisma: ExtendedPrismaClient) {}

  /**
   * Runs `fn` with `tenantId` visible to every query it makes.
   *
   * Always async, and it awaits `fn()` *inside* the scope on purpose. Prisma's
   * PrismaPromise is lazy: the query is dispatched when the promise is awaited,
   * not when the method is called. A synchronous wrapper would let
   * `runWithTenant(id, () => prisma.ticket.findMany())` dispatch outside the
   * scope, which costs a confusing TenantContextMissingError at best.
   */
  async runWithTenant<T>(
    tenantId: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    if (!tenantId) {
      throw new TypeError('runWithTenant requires a non-empty tenantId');
    }
    return this.run(tenantId, fn);
  }

  /**
   * Runs `fn` with no tenant, unlocking tenant-agnostic models only.
   *
   * This exists for the login path, which must find a Tenant by domain before
   * any tenant identity exists. Tenant-scoped models still refuse to run. It is
   * deliberately explicit and greppable: an audit can list every place that
   * claims to need it.
   *
   * It opens a transaction like any other scope. The only model it reaches today
   * is `Tenant`, which has no policy, so the transaction buys it nothing on its
   * own — what it buys is that the store always holds a `tx`, which is what
   * makes the proxy re-entrant everywhere.
   */
  async runWithoutTenant<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.run(null, fn);
  }

  /**
   * Runs `fn` so that a failure inside it leaves the surrounding transaction
   * usable.
   *
   * **Any database error aborts the whole transaction**, not just the statement
   * that caused it: every following statement comes back
   * `25P02 current transaction is aborted`. Before a scope was a transaction
   * that did not matter, because a failed write was the end of its own little
   * unit of work. Now a request is one transaction, so code that catches a
   * constraint violation and then *asks the database why* — which is exactly
   * what `UsersService.create()` does to tell "this address is taken" from
   * "this person was deactivated" — would get `25P02` instead of an answer.
   *
   * A `SAVEPOINT` is the only thing that repairs that: rolling back to one
   * undoes the failed statement and leaves the transaction alive. Anything that
   * expects to recover from a database error has to go through here.
   *
   * Outside a transaction it is a pass-through, so the unit tier and the worker
   * paths behave the same as before.
   */
  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    const tx = tenantStorage.getStore()?.tx;

    if (!tx) {
      return fn();
    }

    // Numbered rather than random: the name is interpolated into SQL, so it must
    // be something this class produced and not something a caller supplied.
    const name = `nexusops_sp_${++this.savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);

    try {
      const result = await fn();
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  private savepoints = 0;

  private async run<T>(
    tenantId: string | null,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const enclosing = tenantStorage.getStore();

    if (enclosing?.tx) {
      return this.runNested(enclosing.tx, enclosing, tenantId, fn);
    }

    // This scope owns the transaction, so it owns the event queue too.
    const pending: PendingRelease[] = [];

    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.setTenant(tx, tenantId);
        return tenantStorage.run({ tenantId, tx, pending }, async () => fn());
      },
      { timeout: SCOPE_TIMEOUT_MS, maxWait: SCOPE_MAX_WAIT_MS },
    );

    // After the commit, never before. A throw above means nothing is released,
    // so a rolled-back mutation announces nothing — which is the guarantee the
    // comment above `TicketsService.mutate()`'s emit has always claimed.
    //
    // Deliberately not awaited and deliberately not knowing what these are: an
    // emit was fire-and-forget before this existed, and keeping it that way is
    // what stops a slow listener from slowing the request.
    for (const release of pending) {
      release();
    }

    return result;
  }

  /**
   * A nested scope borrows the open transaction and re-points it at another
   * tenant, then puts the enclosing one back on the way out.
   *
   * The restore is the part that is easy to skip and must not be: without it the
   * store would say one tenant while the database session said another, and the
   * two layers this design calls "deliberately redundant" would quietly
   * disagree — the exact failure Row-Level Security is here to catch. No call
   * site queries after a nested scope today; that is an accident of the current
   * code, not something to lean on.
   *
   * It does not drain: the queue belongs to the scope that opened the
   * transaction, and it is shared by reference, so events raised in here are
   * released when that one commits.
   */
  private async runNested<T>(
    tx: TenantTransaction,
    enclosing: {
      readonly tenantId: string | null;
      readonly pending: PendingRelease[];
    },
    tenantId: string | null,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    await this.setTenant(tx, tenantId);

    try {
      return await tenantStorage.run(
        { tenantId, tx, pending: enclosing.pending },
        async () => fn(),
      );
    } finally {
      // The restore can itself fail, and swallowing that is correct rather than
      // lazy. If `fn` threw a *database* error, the transaction is already
      // aborted — every statement on it now answers `25P02`, this one included
      // — and letting that replace the original error turns a clean 409 into a
      // 500. There is also nothing left to restore: an aborted transaction can
      // only roll back. A non-database failure leaves the transaction healthy,
      // the restore succeeds, and the enclosing scope carries on correctly.
      try {
        await this.setTenant(tx, enclosing.tenantId);
      } catch {
        // Deliberately empty. The error that brought us here is the one the
        // caller needs to see.
      }
    }
  }

  /**
   * `true` is `is_local`: the value belongs to this transaction and goes out of
   * scope when it ends.
   *
   * Unscoped is written as the empty string, because there is no way back to
   * unset — passing NULL writes `''` too, and once a connection has served one
   * scoped transaction its reset value is `''` rather than NULL. That only reads
   * as "no tenant" because the policies wrap the setting in `nullif`; the two
   * halves are one mechanism. Measured, see RLS_NOTES.md.
   */
  private setTenant(
    tx: TenantTransaction,
    tenantId: string | null,
  ): Promise<number> {
    return tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId ?? ''}, true)`;
  }
}
