import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthService } from '../../src/auth/auth.service';
import { validateEnv } from '../../src/config/env.validation';
import { UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';
import { CrossTenantWriteError } from '../../src/tenancy/tenant-extension';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';

/**
 * Registration creates a tenant and its first user in one transaction, and the
 * tenant scope changes halfway through it: `Tenant` is the one tenant-agnostic
 * model, so it is written under `runWithoutTenant()`, while the user is written
 * under `runWithTenant(tenant.id)`.
 *
 * That rests on two properties of Prisma 7.9.1 that are worth measuring rather
 * than assuming — extensions apply to the interactive transaction client, and
 * AsyncLocalStorage survives the awaits inside the callback. Both are pinned
 * here, so a Prisma upgrade that breaks either fails loudly instead of writing
 * users into the wrong tenant.
 */
describe('registration inside a scope-changing transaction', () => {
  let mod: TestingModule;
  let auth: AuthService;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  const domain = (label: string) => {
    const value = `${label}-${run}.example`;
    domains.push(value);
    return value;
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        AuthModule,
      ],
    }).compile();
    // init(), not compile() alone: HashingService builds its decoy hash in
    // onModuleInit, and the login paths would otherwise compare against
    // undefined.
    await mod.init();

    auth = mod.get(AuthService);
    prisma = mod.get<ExtendedPrismaClient>(PRISMA);
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await mod.close();
  });

  it('creates the tenant and its first ADMIN', async () => {
    const tenantDomain = domain('register');

    const result = await auth.register({
      tenantName: 'Register Co',
      tenantDomain,
      email: 'founder@register.example',
      password: 'a-long-enough-password',
    });

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.user.role).toBe(UserRole.ADMIN);
    expect(result.user).not.toHaveProperty('passwordHash');

    const tenant = await runWithoutTenant(() =>
      prisma.tenant.findUnique({ where: { domain: tenantDomain } }),
    );
    const user = await runWithTenant(tenant!.id, () =>
      prisma.user.findUnique({ where: { id: result.user.id } }),
    );

    // The extension stamped this, inside the transaction, from a scope opened
    // after the transaction had already started.
    expect(user?.tenantId).toBe(tenant!.id);
  });

  it('logs in the user it just registered', async () => {
    const tenantDomain = domain('login');
    await auth.register({
      tenantName: 'Login Co',
      tenantDomain,
      email: 'founder@login.example',
      password: 'a-long-enough-password',
    });

    const result = await auth.login({
      tenantDomain,
      email: 'founder@login.example',
      password: 'a-long-enough-password',
    });

    expect(result.user.email).toBe('founder@login.example');
  });

  it('refuses a duplicate domain with 409 and leaves nothing behind', async () => {
    const tenantDomain = domain('duplicate');
    const payload = {
      tenantName: 'Duplicate Co',
      tenantDomain,
      email: 'founder@duplicate.example',
      password: 'a-long-enough-password',
    };
    await auth.register(payload);

    await expect(auth.register(payload)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const tenants = await runWithoutTenant(() =>
      prisma.tenant.findMany({ where: { domain: tenantDomain } }),
    );
    expect(tenants).toHaveLength(1);
  });

  // The atomicity the pattern depends on: a failure in the scoped half must
  // take the tenant with it, or a company ends up existing with no way to log
  // into it.
  it('rolls the tenant back when the scoped write fails', async () => {
    const tenantDomain = domain('rollback');

    await expect(
      runWithoutTenant(() =>
        prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: { name: 'Rollback Co', domain: tenantDomain },
          });

          return runWithTenant(tenant.id, async () => {
            const data = tenantScoped({
              email: 'clash@rollback.example',
              passwordHash: 'x',
            });
            await tx.user.create({ data });
            // Same tenant, same e-mail: P2002 on @@unique([tenantId, email]).
            await tx.user.create({ data });
          });
        }),
      ),
    ).rejects.toThrow();

    const tenant = await runWithoutTenant(() =>
      prisma.tenant.findUnique({ where: { domain: tenantDomain } }),
    );
    expect(tenant).toBeNull();
  });

  // The transaction client is not a way around the chokepoint.
  it('keeps rejecting cross-tenant writes inside a transaction', async () => {
    const tenantDomain = domain('cross');
    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({
        data: { name: 'Cross Co', domain: tenantDomain },
      }),
    );

    await expect(
      runWithTenant(tenant.id, () =>
        prisma.$transaction((tx) =>
          tx.user.create({
            data: {
              tenantId: randomUUID(),
              email: 'smuggled@cross.example',
              passwordHash: 'x',
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);
  });
});
