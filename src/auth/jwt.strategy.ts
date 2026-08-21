import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant } from '../tenancy/tenant-context';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
} from './authenticated-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Expiry is enforced by passport-jwt rather than by us. The alternative,
      // `ignoreExpiration: true` plus a manual check, is how expired tokens
      // quietly keep working.
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Turns a verified token into the user the request runs as.
   *
   * It goes to the database on every request, and that is the point: a token is
   * valid for its whole lifetime, so without this check a user who was
   * deactivated thirty seconds ago keeps working for the next fifteen minutes.
   * The cost is one indexed read per request, and CLAUDE.md already earmarks
   * Redis as the permission cache that removes it.
   *
   * The scope is opened here, by hand, because guards run *before*
   * interceptors: at this point `TenantContextInterceptor` has not run and
   * there is no `request.user` for it to have read. This is the one place in
   * the request path that establishes a tenant scope for itself.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const user = await runWithTenant(payload.tenantId, () =>
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
    );

    if (!user || user.deletedAt !== null) {
      throw new UnauthorizedException();
    }

    // Role comes from the row, not from the token: an admin demoted to agent
    // must not keep admin rights until their token expires.
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    };
  }
}
