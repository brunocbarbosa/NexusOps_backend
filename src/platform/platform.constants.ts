/**
 * The reserved tenant the single ADMIN_MASTER lives in.
 *
 * In code rather than in the environment, and deliberately so. These are identity,
 * not configuration: `AuthService.login` resolves a tenant by `domain`, so a
 * deployment able to point `PLATFORM_TENANT_DOMAIN` somewhere else would have two
 * answers to "which tenant is the platform" — and a typo would quietly seed a
 * second one rather than fail.
 *
 * `Tenant.isPlatform` is what actually marks the row; the domain is only how the
 * operator names it at the login screen.
 */
export const PLATFORM_TENANT_DOMAIN = 'platform';

/** Shown nowhere a customer sees. The platform tenant is not a company. */
export const PLATFORM_TENANT_NAME = 'NexusOps Platform';
