import { UserRole } from '../generated/prisma/enums';

/**
 * The roles an API caller may ask for.
 *
 * `ADMIN_MASTER` is absent, and that absence is the whole point. It is a platform
 * role, not a company one: exactly one exists, the bootstrap is the only thing that
 * writes it, and it lives in the reserved platform tenant. Left as a plain
 * `@IsEnum(UserRole)` on the DTOs, any company's ADMIN could mint a platform
 * operator inside their own company through `POST /users` — an escalation out of
 * the tenant entirely, and the tenant is the boundary this project exists to hold.
 *
 * This is the first of two layers, matching the two layers of tenancy. It fails
 * closed in the global `ValidationPipe`, so such a request is a 400 before any
 * service runs. The second layer is the `users_single_admin_master` partial unique
 * index, which refuses a second row even if something bypasses the pipe.
 */
export const ASSIGNABLE_ROLES = [
  UserRole.ADMIN,
  UserRole.AGENT,
  UserRole.REQUESTER,
] as const;

/** A role a request may name: `UserRole` minus the platform operator. */
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
