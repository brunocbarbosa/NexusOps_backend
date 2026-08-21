import { requireTenantId } from './tenant-context';

/**
 * The type-level half of what the extension does at runtime.
 *
 * `tenantIsolationExtension` stamps `tenantId` into every create, so a service
 * has no reason to mention it. Prisma's generated input types disagree: `User`
 * has a required `tenant` relation, so `UserCreateInput` demands either
 * `tenantId` or `tenant: { connect }` and a bare `{ email, passwordHash }` is a
 * compile error. Without a bridge, every service would end up writing the
 * tenant by hand — which is the convention this whole layer exists to remove.
 *
 * So this computes the same value the extension would, from the same source:
 *
 *   prisma.user.create({ data: tenantScoped({ email, passwordHash }) })
 *
 * It is deliberately not a cast. A cast would satisfy the compiler while
 * leaving the object without the field, and the day the extension stops firing
 * for some operation, the write would land with `tenantId: undefined` instead
 * of failing. Here the value is real, `requireTenantId()` throws when there is
 * no scope, and `stampTenant` in the extension still rejects a mismatch — so
 * the two halves check each other rather than trusting each other.
 *
 * Nested creates need nothing: the composite foreign keys mean Prisma
 * regenerates the nested input without a `tenantId` field at all. See
 * documents/important/TENANCY_EXTENSION.md.
 */
export function tenantScoped<T extends object>(
  data: T,
): T & { tenantId: string } {
  return { ...data, tenantId: requireTenantId() };
}
