import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import { validateEnv } from '../../src/config/env.validation';
import { UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';

/**
 * The users module against a real database, with two tenants side by side.
 *
 * Nothing in `UsersService` writes a tenant filter — the isolation asserted
 * here comes entirely from the extension. That is the claim worth a test with
 * a real PostgreSQL behind it, because it is a claim about a query nobody
 * wrote.
 */
describe('UsersService across tenants', () => {
  let mod: TestingModule;
  let users: UsersService;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let adminA: AuthenticatedUser;
  let userB: string;

  const seed = async (label: string) => {
    const domain = `users-${label}-${run}.example`;
    domains.push(domain);
    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({ data: { name: `Users ${label}`, domain } }),
    );
    const admin = await runWithTenant(tenant.id, () =>
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `admin@${label}.example`,
          passwordHash: 'x',
          role: UserRole.ADMIN,
        },
      }),
    );
    return { tenantId: tenant.id, adminId: admin.id };
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        UsersModule,
      ],
    }).compile();
    await mod.init();

    users = mod.get(UsersService);
    prisma = mod.get<ExtendedPrismaClient>(PRISMA);

    const a = await seed('a');
    const b = await seed('b');
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    userB = b.adminId;
    adminA = {
      id: a.adminId,
      tenantId: tenantA,
      email: 'admin@a.example',
      role: UserRole.ADMIN,
    };
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await mod.close();
  });

  const asA = <T>(fn: () => Promise<T>) => runWithTenant(tenantA, fn);

  it('creates into the caller tenant without being told which one', async () => {
    const created = await asA(() =>
      users.create({
        email: `fresh-${run}@a.example`,
        password: 'a-long-enough-password',
      }),
    );

    const stored = await asA(() =>
      prisma.user.findUnique({ where: { id: created.id } }),
    );
    expect(stored?.tenantId).toBe(tenantA);
  });

  it('does not list another tenant users', async () => {
    const page = await asA(() =>
      users.findAll({ page: 1, perPage: 100, includeDeleted: false }, adminA),
    );

    expect(page.data.length).toBeGreaterThan(0);
    const ids = page.data.map((u) => u.id);
    expect(ids).not.toContain(userB);
  });

  // 404 rather than 403: the id is real, and saying so would be a fact about
  // another company's data.
  it('answers 404 for another tenant user id', async () => {
    await expect(
      asA(() => users.findOne(userB, adminA)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cannot deactivate another tenant user', async () => {
    await expect(asA(() => users.remove(userB, adminA))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const stillThere = await runWithTenant(tenantB, () =>
      prisma.user.findUnique({ where: { id: userB } }),
    );
    expect(stillThere?.deletedAt).toBeNull();
  });

  // The same e-mail in two companies is two different people, which is why
  // @@unique is on (tenantId, email) and not on email alone.
  it('allows the same e-mail in another tenant', async () => {
    const email = `shared-${run}@example.com`;
    await asA(() =>
      users.create({ email, password: 'a-long-enough-password' }),
    );

    await expect(
      runWithTenant(tenantB, () =>
        users.create({ email, password: 'a-long-enough-password' }),
      ),
    ).resolves.toMatchObject({ email });
  });

  /**
   * The deactivate/restore cycle, and the constraint that shapes it.
   *
   * A deactivated user keeps occupying `@@unique([tenantId, email])`, so
   * recreating them is a P2002 rather than a fresh account. Measured in phase 2
   * and pinned here: this is the reason `POST /users/:id/restore` exists at
   * all, and the reason `create` bothers to tell the two cases apart.
   */
  describe('soft delete against the unique e-mail', () => {
    const email = `recycled-${run}@a.example`;
    let victim: string;

    beforeAll(async () => {
      const created = await asA(() =>
        users.create({ email, password: 'a-long-enough-password' }),
      );
      victim = created.id;
      await asA(() => users.remove(victim, adminA));
    });

    it('keeps the address occupied, and says where it went', async () => {
      await expect(
        asA(() => users.create({ email, password: 'a-long-enough-password' })),
      ).rejects.toThrow(new RegExp(`deactivated user \\(${victim}\\)`));
    });

    it('hides the row from a listing but keeps it for an ADMIN who asks', async () => {
      const hidden = await asA(() =>
        users.findAll({ page: 1, perPage: 100, includeDeleted: false }, adminA),
      );
      const shown = await asA(() =>
        users.findAll({ page: 1, perPage: 100, includeDeleted: true }, adminA),
      );

      expect(hidden.data.map((u) => u.id)).not.toContain(victim);
      expect(shown.data.map((u) => u.id)).toContain(victim);
    });

    it('restores the same row, so the history stays attached to it', async () => {
      const restored = await asA(() => users.restore(victim, adminA));

      expect(restored.id).toBe(victim);
      expect(restored.deletedAt).toBeNull();

      await expect(
        asA(() => users.restore(victim, adminA)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
