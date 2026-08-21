import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthenticatedUser } from '../authenticated-user';

/**
 * The authenticated user, as `JwtStrategy.validate()` built it.
 *
 * Non-nullable on purpose: every route that can reach a handler has passed
 * `JwtAuthGuard`, and the ones that have not are `@Public()` and have no user
 * to ask for. A `@Public()` route that uses this decorator is a bug, and it
 * shows up as a thrown error rather than as `undefined` flowing onwards.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;

    if (!user) {
      throw new Error(
        '@CurrentUser() on a route with no authenticated user. Either the route ' +
          'is @Public(), or JwtAuthGuard is no longer registered globally.',
      );
    }

    return user;
  },
);
