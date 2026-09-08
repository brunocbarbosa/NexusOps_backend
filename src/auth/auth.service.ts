import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '../generated/prisma/client';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { TenantScopeService } from '../tenancy/tenant-scope.service';
import { UserResponse, toUserResponse } from '../users/user-response';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
} from './authenticated-user';
import { LoginDto } from './dto/login.dto';
import { HashingService } from './hashing.service';
import { INVALID_REFRESH, RefreshTokenService } from './refresh-token.service';

/**
 * One message for every way a login can fail.
 *
 * "No such tenant", "no such user" and "wrong password" are three different
 * facts, and telling them apart lets anyone map which companies use the product
 * and who works there. The timing is levelled separately, in
 * `HashingService.compareWithDecoy`.
 */
const INVALID_CREDENTIALS = 'Invalid credentials';

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: UserResponse;
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly hashing: HashingService,
    private readonly jwt: JwtService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly scope: TenantScopeService,
  ) {}

  /**
   * Exchanges a tenant domain, an e-mail and a password for an access token.
   *
   * The tenant lookup runs unscoped because there is no tenant identity yet —
   * that is precisely what `runWithoutTenant()` exists for. Everything after it
   * runs inside the tenant, so the user lookup carries no hand-written filter.
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const tenant = await this.scope.runWithoutTenant(() =>
      this.prisma.tenant.findUnique({ where: { domain: dto.tenantDomain } }),
    );

    if (!tenant || !tenant.isActive) {
      await this.hashing.compareWithDecoy(dto.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const user = await this.scope.runWithTenant(tenant.id, () =>
      // findFirst and not findUnique on tenantId_email: the compound unique
      // would mean writing the tenant by hand, and the extension is what puts
      // it in the where. The index is the same either way.
      this.prisma.user.findFirst({ where: { email: dto.email } }),
    );

    if (!user || user.deletedAt !== null) {
      await this.hashing.compareWithDecoy(dto.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.hashing.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issueTokens(user);
  }

  /** The current user, already loaded and freshness-checked by JwtStrategy. */
  me(user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /**
   * Exchanges a refresh token for a new pair, and rotates it.
   *
   * The scope comes from the token itself: refreshing happens precisely when
   * the access token has expired, so there is no authenticated user for
   * `TenantContextInterceptor` to have read and no scope to inherit.
   *
   * **The rejection is thrown after the scope closes, not inside it**, and that
   * is load-bearing rather than tidy. A scope is a transaction now, so throwing
   * from inside one rolls back everything it wrote — including the revocation
   * on the reuse path, which is a security action that has to survive the very
   * request it rejects. Leaving it inside would hand a thief a successor token
   * that still works, and every test would still pass except the one that
   * replays a spent token. So the scope returns a verdict and the caller throws
   * on it.
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const payload = await this.refreshTokens.verify(refreshToken);

    const verdict = await this.scope.runWithTenant(
      payload.tenantId,
      async () => {
        const outcome = await this.refreshTokens.consume(refreshToken);

        if (outcome === 'unknown') {
          return 'rejected' as const;
        }

        // A token that was already spent is being presented a second time. The
        // legitimate holder and whoever copied it are indistinguishable from
        // here, so every session of that user ends and both have to log in
        // again. Doing nothing would leave the thief with a working chain.
        if (outcome === 'reused') {
          await this.refreshTokens.revokeAllFor(payload.sub);
          return 'rejected' as const;
        }

        const user = await this.prisma.user.findUnique({
          where: { id: outcome.userId },
        });

        // Same freshness check JwtStrategy makes: a week-long refresh token must
        // not outlive the account it belongs to.
        if (!user || user.deletedAt !== null) {
          return 'rejected' as const;
        }

        return { user };
      },
    );

    if (verdict === 'rejected') {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    return this.issueTokens(verdict.user);
  }

  /** Ends one session. Silent about tokens that are not the caller's. */
  async logout(refreshToken: string, user: AuthenticatedUser): Promise<void> {
    await this.scope.runWithTenant(user.tenantId, () =>
      this.refreshTokens.revoke(refreshToken, user.id),
    );
  }

  private async issueTokens(user: User): Promise<AuthResult> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    };

    // The refresh token is recorded in a tenant-scoped table, so this needs a
    // scope. Both callers reach it from outside one — login has just left the
    // tenant lookup, and refresh's own scope has closed — so it is opened here
    // rather than at each call site.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload),
      this.scope.runWithTenant(user.tenantId, () =>
        this.refreshTokens.issue(user.id),
      ),
    ]);

    return { accessToken, refreshToken, user: toUserResponse(user) };
  }
}
