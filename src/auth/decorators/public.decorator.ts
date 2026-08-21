import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Opens a route to unauthenticated callers.
 *
 * The default is the other way round — `JwtAuthGuard` is registered globally,
 * so a new controller is protected the moment it is written and forgetting to
 * add a guard cannot expose it. Only three routes carry this: register, login
 * and refresh, none of which can have an authenticated user by definition.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
