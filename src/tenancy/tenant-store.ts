import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request-scoped store itself, and nothing else.
 *
 * This file is a leaf on purpose: it imports nothing from this repository, so
 * everything that needs the store — the readers in `tenant-context.ts`, the
 * writer in `tenant-scope.service.ts`, and the proxy in `prisma.client.ts` —
 * can reach it without any of them having to reach each other. Splitting it out
 * is what lets the scope opener be an injected provider (settled decision #1)
 * instead of a module-level singleton registered at boot.
 */

/**
 * What the store needs from the open transaction, structurally.
 *
 * Deliberately not `ExtendedTransactionClient`: that type is inferred from the
 * client factory, which is defined in terms of the extension, which reads this
 * store. Naming it here would make the type circular for no benefit — the only
 * thing this file does with `tx` is carry it, and the two places that use it
 * for real have the concrete types.
 */
export interface TenantTransaction {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
  /** For `SAVEPOINT`, whose name cannot be a bind parameter. */
  $executeRawUnsafe(query: string): Promise<number>;
}

/**
 * Something held back until the owning scope's transaction commits.
 *
 * A thunk rather than an event, so that this file — and `TenantScopeService`
 * with it — knows nothing about events. The scope's job is to release what was
 * queued once the work is durable; deciding *what* to queue belongs to
 * `DomainEvents`, and keeping it there is what stops every module that touches
 * the database from having to import an event emitter.
 */
export type PendingRelease = () => void;

/**
 * `tx` is never null in practice — every scope is a transaction (settled
 * decision #0) — but the type keeps the proxy honest about the case where the
 * store exists and the transaction has not been opened yet.
 *
 * `pending` is shared by reference with every nested scope, so an event emitted
 * three scopes deep is drained once, by the scope that owns the transaction.
 */
export type Store = {
  readonly tenantId: string | null;
  readonly tx: TenantTransaction | null;
  readonly pending: PendingRelease[];
};

export const tenantStorage = new AsyncLocalStorage<Store>();

/** The open transaction, for the proxy. `null` outside any scope. */
export function currentTransaction(): TenantTransaction | null {
  return tenantStorage.getStore()?.tx ?? null;
}
