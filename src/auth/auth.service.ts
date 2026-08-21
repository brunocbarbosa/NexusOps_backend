import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant, runWithoutTenant } from '../tenancy/tenant-context';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { UserResponse, toUserResponse } from '../users/user-response';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
} from './authenticated-user';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
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
  ) {}

  /**
   * Creates a tenant and its first ADMIN.
   *
   * The scope changes halfway through a single transaction, which is the most
   * delicate few lines in the module. `Tenant` is the one tenant-agnostic
   * model, so it is created under `runWithoutTenant()`; the user is scoped, so
   * it is created under `runWithTenant(tenant.id)` — and both must be in the
   * same transaction, or a duplicate domain leaves a tenant with no way in.
   *
   * Two things make it work, and both are properties worth knowing rather than
   * assuming: the extension applies to the transaction client `tx`, and
   * AsyncLocalStorage survives the awaits inside the callback.
   * `test/integration/auth-registration.int-spec.ts` pins both.
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    // Outside the transaction on purpose: bcrypt at production cost takes
    // hundreds of milliseconds, and holding a database connection open for it
    // is how a login storm exhausts the pool.
    const passwordHash = await this.hashing.hash(dto.password);

    try {
      const user = await runWithoutTenant(() =>
        this.prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: { name: dto.tenantName, domain: dto.tenantDomain },
          });

          return runWithTenant(tenant.id, () =>
            tx.user.create({
              data: tenantScoped({
                email: dto.email,
                passwordHash,
                role: UserRole.ADMIN,
              }),
            }),
          );
        }),
      );

      return this.issueTokens(user);
    } catch (error) {
      // Checked rather than pre-queried: a "is this domain taken?" read before
      // the insert is a race, and the unique index has to be handled anyway.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `The domain "${dto.tenantDomain}" is already registered`,
        );
      }
      throw error;
    }
  }

  /**
   * Exchanges a tenant domain, an e-mail and a password for an access token.
   *
   * The tenant lookup runs unscoped because there is no tenant identity yet —
   * that is precisely what `runWithoutTenant()` exists for. Everything after it
   * runs inside the tenant, so the user lookup carries no hand-written filter.
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const tenant = await runWithoutTenant(() =>
      this.prisma.tenant.findUnique({ where: { domain: dto.tenantDomain } }),
    );

    if (!tenant || !tenant.isActive) {
      await this.hashing.compareWithDecoy(dto.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const user = await runWithTenant(tenant.id, () =>
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
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const payload = await this.refreshTokens.verify(refreshToken);

    return runWithTenant(payload.tenantId, async () => {
      const outcome = await this.refreshTokens.consume(refreshToken);

      if (outcome === 'unknown') {
        throw new UnauthorizedException(INVALID_REFRESH);
      }

      // A token that was already spent is being presented a second time. The
      // legitimate holder and whoever copied it are indistinguishable from
      // here, so every session of that user ends and both have to log in
      // again. Doing nothing would leave the thief with a working chain.
      if (outcome === 'reused') {
        await this.refreshTokens.revokeAllFor(payload.sub);
        throw new UnauthorizedException(INVALID_REFRESH);
      }

      const user = await this.prisma.user.findUnique({
        where: { id: outcome.userId },
      });

      // Same freshness check JwtStrategy makes: a week-long refresh token must
      // not outlive the account it belongs to.
      if (!user || user.deletedAt !== null) {
        throw new UnauthorizedException(INVALID_REFRESH);
      }

      return this.issueTokens(user);
    });
  }

  /** Ends one session. Silent about tokens that are not the caller's. */
  async logout(refreshToken: string, user: AuthenticatedUser): Promise<void> {
    await runWithTenant(user.tenantId, () =>
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
    // scope. login() and register() both call this from outside one — login
    // has just left the tenant lookup, and register's transaction has already
    // closed — so it is opened here rather than at three call sites.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload),
      runWithTenant(user.tenantId, () => this.refreshTokens.issue(user.id)),
    ]);

    return { accessToken, refreshToken, user: toUserResponse(user) };
  }
}
