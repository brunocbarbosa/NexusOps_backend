import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { requireTenantId } from '../tenancy/tenant-context';
import { tenantScoped } from '../tenancy/tenant-scoped';

/** The claims a refresh token carries. Deliberately fewer than an access token. */
export type RefreshTokenPayload = {
  sub: string;
  tenantId: string;
  jti: string;
  exp: number;
};

/** One message for every way a refresh can fail, for the same reason login has one. */
export const INVALID_REFRESH = 'Invalid refresh token';

/**
 * `tenantId` is in the payload because nothing else can supply it.
 *
 * Refreshing happens when the access token has expired, so there is no
 * authenticated user and no tenant scope — and the tokens table is
 * tenant-scoped like everything else, so the lookup cannot even run without
 * one. Carrying it in the token is what lets `runWithTenant` open the scope
 * before the first query, instead of a lookup that would have to be unscoped.
 */
@Injectable()
export class RefreshTokenService {
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.expiresIn = config.getOrThrow<string>('JWT_REFRESH_EXPIRES_IN');
  }

  /**
   * sha256 and not bcrypt.
   *
   * bcrypt is slow on purpose, to make guessing a human-chosen secret
   * expensive. A refresh token is 256 bits of signed randomness, so there is
   * nothing to guess — the slowness would buy no security and would be paid on
   * every single rotation. What the hash is for is that a database dump must
   * not be a set of usable sessions.
   */
  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Mints a refresh token and records it. Must run inside the user's tenant scope. */
  async issue(userId: string): Promise<string> {
    const token = await this.jwt.signAsync(
      { sub: userId, tenantId: requireTenantId(), jti: randomUUID() },
      {
        secret: this.secret,
        expiresIn: this.expiresIn as JwtSignOptions['expiresIn'],
      },
    );

    await this.prisma.refreshToken.create({
      data: tenantScoped({
        userId,
        tokenHash: RefreshTokenService.hash(token),
        // Read back off the token rather than parsed from the duration string a
        // second time: one source of truth, and no chance of the row claiming a
        // different lifetime than the token it describes.
        expiresAt: new Date(this.decodeExpiry(token) * 1000),
      }),
    });

    return token;
  }

  /**
   * Verifies a refresh token's signature and expiry.
   *
   * The expiry check lives here, in `jsonwebtoken`, not in a comparison against
   * `expires_at`: that column exists so a future cleanup job can delete dead
   * rows, and duplicating the check would give two answers to disagree about.
   */
  async verify(token: string): Promise<RefreshTokenPayload> {
    try {
      return await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.secret,
      });
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
  }

  /**
   * Consumes a token exactly once, and reports whether it had already been used.
   *
   * The single-statement `updateMany` filtered on `revokedAt: null` is what
   * makes "exactly once" true under concurrency — the same optimistic
   * concurrency shape the ticket aggregate uses. Reading the row and then
   * revoking it would let two simultaneous refreshes both see `null` and both
   * succeed, which is precisely the case reuse detection exists to catch.
   */
  async consume(
    token: string,
  ): Promise<{ userId: string } | 'unknown' | 'reused'> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: RefreshTokenService.hash(token) },
    });

    if (!stored) {
      return 'unknown';
    }

    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return rotated.count === 1 ? { userId: stored.userId } : 'reused';
  }

  /**
   * Revokes every live token of one user.
   *
   * Called when a revoked token comes back: the legitimate holder and whoever
   * copied it are now indistinguishable, so the only safe move is to end every
   * session and make both log in again. Also called on a password change.
   */
  async revokeAllFor(userId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  /**
   * Revokes one token, if it belongs to the given user. Silent when it does not
   * — a logout that answered differently would let a caller probe whether an
   * arbitrary token string is live.
   */
  async revoke(token: string, userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: RefreshTokenService.hash(token), userId },
      data: { revokedAt: new Date() },
    });
  }

  private decodeExpiry(token: string): number {
    const decoded = this.jwt.decode<{ exp?: number }>(token);
    if (!decoded?.exp) {
      throw new Error('Signed refresh token has no exp claim');
    }
    return decoded.exp;
  }
}
