import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped tenant identity.
 *
 * The store is module-private: the only ways in are runWithTenant and
 * runWithoutTenant, and the only ways out are requireTenantId and currentScope.
 * See CLAUDE.md > Architecture.
 */
type Store = { readonly tenantId: string | null };

const storage = new AsyncLocalStorage<Store>();

/**
 * What scope the caller is running under. A discriminated union rather than a
 * `string | undefined` getter, because `currentTenantId() ?? fallback` is exactly the
 * silent bypass this design exists to prevent -- here every case must be handled.
 */
export type TenantScope =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | { readonly kind: 'unscoped' }
  | { readonly kind: 'none' };

export class TenantContextMissingError extends Error {
  constructor() {
    super(
      'No tenant in context. HTTP requests establish it from the authenticated user; ' +
        'BullMQ workers and WebSocket handlers have no request, so they must carry the ' +
        'tenant in the job payload and wrap their body in runWithTenant(). For the ' +
        'login path, which has no tenant yet, use runWithoutTenant().',
    );
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Runs `fn` with `tenantId` visible to every query it makes.
 *
 * Always async, and it awaits `fn()` *inside* the scope on purpose. Prisma's
 * PrismaPromise is lazy: the query is dispatched when the promise is awaited, not when
 * the method is called. A synchronous wrapper would therefore let
 * `runWithTenant(id, () => prisma.ticket.findMany())` dispatch outside the scope, which
 * costs a confusing TenantContextMissingError at best.
 */
export async function runWithTenant<T>(
  tenantId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new TypeError('runWithTenant requires a non-empty tenantId');
  }
  return storage.run({ tenantId }, async () => fn());
}

/**
 * Runs `fn` with no tenant, unlocking tenant-agnostic models only.
 *
 * This exists for the login path, which must find a Tenant by domain before any tenant
 * identity exists. Tenant-scoped models still refuse to run. It is deliberately
 * explicit and greppable: an audit can list every place that claims to need it.
 */
export async function runWithoutTenant<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  return storage.run({ tenantId: null }, async () => fn());
}

/** The current tenant, or a thrown error. Never a nullable value. */
export function requireTenantId(): string {
  const store = storage.getStore();
  if (!store || store.tenantId === null) {
    throw new TenantContextMissingError();
  }
  return store.tenantId;
}

/** For the extension's own branching. Application code wants requireTenantId. */
export function currentScope(): TenantScope {
  const store = storage.getStore();
  if (!store) {
    return { kind: 'none' };
  }
  return store.tenantId === null
    ? { kind: 'unscoped' }
    : { kind: 'tenant', tenantId: store.tenantId };
}
