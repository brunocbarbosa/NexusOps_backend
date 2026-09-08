import { tenantStorage } from './tenant-store';

/**
 * Reading the request-scoped tenant identity.
 *
 * The **readers** live here and stay free functions, because what consumes them
 * is `tenant-extension.ts` — a Prisma extension, which is not a Nest provider
 * and never will be. The **writers** moved to `TenantScopeService`, because
 * opening a scope now means opening a database transaction, and that needs a
 * client only the container can hand out. See CLAUDE.md > Architecture and
 * documents/RLS_DESIGN.md, settled decisions #0 and #1.
 */

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
        'tenant in the job payload and wrap their body in TenantScopeService.' +
        'runWithTenant(). For the login path, which has no tenant yet, use ' +
        'runWithoutTenant().',
    );
    this.name = 'TenantContextMissingError';
  }
}

/** The current tenant, or a thrown error. Never a nullable value. */
export function requireTenantId(): string {
  const store = tenantStorage.getStore();
  if (!store || store.tenantId === null) {
    throw new TenantContextMissingError();
  }
  return store.tenantId;
}

/** For the extension's own branching. Application code wants requireTenantId. */
export function currentScope(): TenantScope {
  const store = tenantStorage.getStore();
  if (!store) {
    return { kind: 'none' };
  }
  return store.tenantId === null
    ? { kind: 'unscoped' }
    : { kind: 'tenant', tenantId: store.tenantId };
}
