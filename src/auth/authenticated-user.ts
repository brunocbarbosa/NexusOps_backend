import { UserRole } from '../generated/prisma/enums';

/**
 * What `JwtStrategy.validate()` puts on `request.user`, and therefore what
 * `@CurrentUser()` hands to a controller.
 *
 * `tenantId` is here because the whole request depends on it:
 * `TenantContextInterceptor` reads it to open the AsyncLocalStorage scope. It
 * is read structurally there rather than imported, so the tenancy layer keeps
 * knowing nothing about authentication.
 */
export type AuthenticatedUser = {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
};

/** The claims this application puts in an access token. */
export type AccessTokenPayload = {
  sub: string;
  tenantId: string;
  email: string;
  role: UserRole;
};
