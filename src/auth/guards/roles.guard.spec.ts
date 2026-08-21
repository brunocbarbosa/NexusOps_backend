import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/enums';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  const contextFor = (user?: unknown): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const guardRequiring = (roles: UserRole[] | undefined) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
    return new RolesGuard(reflector);
  };

  const admin = {
    id: 'u',
    tenantId: 't',
    email: 'a@b.c',
    role: UserRole.ADMIN,
  };

  // The property that lets the guard be global: a route says nothing, and the
  // guard stays out of the way rather than denying everything.
  it.each([
    ['no @Roles() at all', undefined],
    ['an empty @Roles()', [] as UserRole[]],
  ])('allows any authenticated user with %s', (_label, roles) => {
    expect(guardRequiring(roles).canActivate(contextFor(admin))).toBe(true);
  });

  it('allows a user whose role is listed', () => {
    const guard = guardRequiring([UserRole.ADMIN, UserRole.AGENT]);

    expect(guard.canActivate(contextFor(admin))).toBe(true);
  });

  it('refuses a user whose role is not listed', () => {
    const guard = guardRequiring([UserRole.ADMIN]);
    const requester = { ...admin, role: UserRole.REQUESTER };

    expect(() => guard.canActivate(contextFor(requester))).toThrow(
      ForbiddenException,
    );
  });

  // @Public() plus @Roles() is a contradiction. Allowing it would make the role
  // decorator decorative, which is worse than refusing.
  it('refuses when there is no user to check', () => {
    const guard = guardRequiring([UserRole.ADMIN]);

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
