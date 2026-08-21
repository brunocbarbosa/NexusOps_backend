import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/enums';
import type { AuthenticatedUser } from '../authenticated-user';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Authorisation by role, on top of authentication.
 *
 * Registered as the second APP_GUARD, after JwtAuthGuard — global guards run in
 * declaration order, and this one needs the user that the first one put on the
 * request.
 *
 * 403 and not 404 here, unlike a cross-tenant read. The difference is what the
 * status confirms: "you may not do this" reveals nothing, while "this ticket
 * exists but is not yours" tells another tenant that the id is real.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() means any authenticated user, which is why this guard can be
    // global without every route having to opt in.
    if (!required || required.length === 0) {
      return true;
    }

    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;

    // A @Public() route carrying @Roles() has no user to check, and silently
    // allowing it would make the decorator a lie.
    if (!user) {
      throw new ForbiddenException();
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `This route requires one of: ${required.join(', ')}`,
      );
    }

    return true;
  }
}
