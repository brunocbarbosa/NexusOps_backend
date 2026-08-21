import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthModule } from '../../src/auth/auth.module';
import { RefreshTokenService } from '../../src/auth/refresh-token.service';
import { validateEnv } from '../../src/config/env.validation';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';

/**
 * "Consumed exactly once" is the property the whole reuse-detection design
 * rests on, and it is a concurrency claim — which means it cannot be checked by
 * reading the code. These run against a real PostgreSQL for that reason.
 */
describe('RefreshTokenService against a real database', () => {
  let mod: TestingModule;
  let service: RefreshTokenService;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        AuthModule,
      ],
    }).compile();
    await mod.init();

    service = mod.get(RefreshTokenService);
    prisma = mod.get<ExtendedPrismaClient>(PRISMA);

    const domain = `refresh-${run}.example`;
    domains.push(domain);
    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({ data: { name: 'Refresh Co', domain } }),
    );
    tenantId = tenant.id;
    const user = await runWithTenant(tenantId, () =>
      prisma.user.create({
        data: tenantScoped({
          email: 'holder@refresh.example',
          passwordHash: 'x',
        }),
      }),
    );
    userId = user.id;
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await mod.close();
  });

  const issue = () => runWithTenant(tenantId, () => service.issue(userId));

  it('stores a hash and never the token itself', async () => {
    const token = await issue();

    const rows = await runWithTenant(tenantId, () =>
      prisma.refreshToken.findMany({ where: { userId } }),
    );

    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
    expect(
      rows.some((row) => row.tokenHash === RefreshTokenService.hash(token)),
    ).toBe(true);
  });

  // The row must not claim a different lifetime than the token it describes,
  // which is why expiresAt is read back off the signed token rather than parsed
  // from the duration string a second time.
  it('records an expiry that matches the token exp claim', async () => {
    const token = await issue();
    const payload = await service.verify(token);

    const row = await runWithTenant(tenantId, () =>
      prisma.refreshToken.findUnique({
        where: { tokenHash: RefreshTokenService.hash(token) },
      }),
    );

    expect(row?.expiresAt.getTime()).toBe(payload.exp * 1000);
  });

  it('consumes a fresh token once', async () => {
    const token = await issue();

    await expect(
      runWithTenant(tenantId, () => service.consume(token)),
    ).resolves.toEqual({ userId });
  });

  it('reports a second use as reuse rather than succeeding again', async () => {
    const token = await issue();
    await runWithTenant(tenantId, () => service.consume(token));

    await expect(
      runWithTenant(tenantId, () => service.consume(token)),
    ).resolves.toBe('reused');
  });

  /**
   * The reason `consume` is a single filtered `updateMany` and not a read
   * followed by a write.
   *
   * With read-then-write, both callers see `revokedAt: null`, both revoke, and
   * both get a new token pair — so a genuinely stolen token would refresh
   * happily beside the real one, and the detection this exists for never fires.
   */
  it('lets exactly one of two simultaneous consumers win', async () => {
    const token = await issue();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        runWithTenant(tenantId, () => service.consume(token)),
      ),
    );

    expect(outcomes.filter((o) => o !== 'reused')).toEqual([{ userId }]);
    expect(outcomes.filter((o) => o === 'reused')).toHaveLength(4);
  });

  it('reports a token it never issued as unknown', async () => {
    const stranger = await issue();
    // Same shape, different tenant's storage: revoke the row so the hash is
    // gone from the caller's scope entirely.
    await runWithTenant(tenantId, () =>
      prisma.refreshToken.deleteMany({
        where: { tokenHash: RefreshTokenService.hash(stranger) },
      }),
    );

    await expect(
      runWithTenant(tenantId, () => service.consume(stranger)),
    ).resolves.toBe('unknown');
  });

  it('revokes an entire family in one call', async () => {
    const tokens = await Promise.all([issue(), issue(), issue()]);

    const revoked = await runWithTenant(tenantId, () =>
      service.revokeAllFor(userId),
    );

    expect(revoked).toBeGreaterThanOrEqual(tokens.length);
    const outcomes = await Promise.all(
      tokens.map((token) =>
        runWithTenant(tenantId, () => service.consume(token)),
      ),
    );
    expect(outcomes).toEqual(['reused', 'reused', 'reused']);
  });

  // Logout must not become a way to end somebody else's session.
  it('ignores a revoke aimed at a token belonging to another user', async () => {
    const token = await issue();

    await runWithTenant(tenantId, () => service.revoke(token, randomUUID()));

    await expect(
      runWithTenant(tenantId, () => service.consume(token)),
    ).resolves.toEqual({ userId });
  });
});
