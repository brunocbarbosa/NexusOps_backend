import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Opens a route to unauthenticated callers.
 *
 * The default is the other way round — `JwtAuthGuard` is registered globally,
 * so a new controller is protected the moment it is written and forgetting to
 * add a guard cannot expose it. Only two routes carry this — login and refresh
 * — neither of which can have an authenticated user by definition. Creating a
 * company is not among them any more: it belongs to the ADMIN_MASTER at
 * `POST /platform/companies`, which is authenticated like everything else.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
