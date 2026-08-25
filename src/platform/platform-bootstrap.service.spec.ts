import { ConfigService } from '@nestjs/config';
import { HashingService } from '../auth/hashing.service';
import { Tenant, User } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { currentScope } from '../tenancy/tenant-context';
import { PlatformBootstrapService } from './platform-bootstrap.service';
import { PLATFORM_TENANT_DOMAIN } from './platform.constants';

/**
 * The bootstrap is the entire lifecycle of the ADMIN_MASTER: no route assigns
 * the role, and a partial unique index refuses a second row. So what matters is
 * that it *converges* — it runs on every boot, including every e2e suite's
 * `createTestApp()`, and it has to end in the same state each time rather than
 * accumulate.
 */
describe('PlatformBootstrapService', () => {
  const platformTenant: Tenant = {
    id: 'platform-tenant',
    name: 'NexusOps Platform',
    domain: PLATFORM_TENANT_DOMAIN,
    isActive: true,
    isPlatform: true,
    createdAt: new Date(),
  };

  const operator: User = {
    id: 'operator-1',
    tenantId: 'platform-tenant',
    email: 'operator@nexusops.test',
    passwordHash: 'stored-hash',
    role: UserRole.ADMIN_MASTER,
    createdAt: new Date(),
    deletedAt: null,
  };

  const env: Record<string, string> = {
    ADMIN_MASTER_EMAIL: 'operator@nexusops.test',
    ADMIN_MASTER_PASSWORD: 'a-long-enough-password',
  };

  let prisma: {
    tenant: { upsert: jest.Mock };
    user: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let hashing: { hash: jest.Mock; compare: jest.Mock };
  let service: PlatformBootstrapService;

  beforeEach(() => {
    prisma = {
      tenant: { upsert: jest.fn().mockResolvedValue(platformTenant) },
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(operator),
        update: jest.fn().mockResolvedValue(operator),
      },
    };
    hashing = {
      hash: jest.fn().mockResolvedValue('fresh-hash'),
      compare: jest.fn().mockResolvedValue(true),
    };

    service = new PlatformBootstrapService(
      prisma as unknown as ExtendedPrismaClient,
      hashing as unknown as HashingService,
      { getOrThrow: (key: string) => env[key] } as unknown as ConfigService,
    );
  });

  describe('the first boot', () => {
    it('creates the platform tenant and the operator', async () => {
      await service.ensureAdminMaster();

      expect(prisma.tenant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPlatform: true } }),
      );
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'operator@nexusops.test',
          passwordHash: 'fresh-hash',
          role: UserRole.ADMIN_MASTER,
          // Stamped by tenantScoped() from the scope the service opened, not
          // written by hand.
          tenantId: 'platform-tenant',
        },
      });
    });

    it('normalises the e-mail, so the .env casing cannot lock the operator out', async () => {
      env.ADMIN_MASTER_EMAIL = '  Operator@NexusOps.Test ';

      await service.ensureAdminMaster();

      const [args] = prisma.user.create.mock.calls[0] as [
        { data: { email: string } },
      ];
      expect(args.data.email).toBe('operator@nexusops.test');
      env.ADMIN_MASTER_EMAIL = 'operator@nexusops.test';
    });
  });

  describe('every boot after the first', () => {
    beforeEach(() => {
      prisma.user.findFirst.mockResolvedValue(operator);
    });

    // bcrypt salts randomly, so hashing unconditionally would rewrite the row on
    // every single boot and make "nothing changed" indistinguishable from "the
    // password rotated".
    it('writes nothing when the environment already matches', async () => {
      await service.ensureAdminMaster();

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(hashing.hash).not.toHaveBeenCalled();
    });

    it('re-hashes when the password in the environment changed', async () => {
      hashing.compare.mockResolvedValue(false);

      await service.ensureAdminMaster();

      const [args] = prisma.user.update.mock.calls[0] as [
        { data: { passwordHash?: string } },
      ];
      expect(args.data.passwordHash).toBe('fresh-hash');
    });

    /**
     * The reason the existing operator is found by role rather than by e-mail.
     * Keyed on the e-mail, changing ADMIN_MASTER_EMAIL would try to create a
     * *second* operator and die on `users_single_admin_master`; by role, the same
     * change renames the one that exists.
     */
    it('renames rather than duplicates when the e-mail changed', async () => {
      env.ADMIN_MASTER_EMAIL = 'newoperator@nexusops.test';

      await service.ensureAdminMaster();

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { role: UserRole.ADMIN_MASTER },
      });
      const [args] = prisma.user.update.mock.calls[0] as [
        { data: { email: string } },
      ];
      expect(args.data.email).toBe('newoperator@nexusops.test');
      env.ADMIN_MASTER_EMAIL = 'operator@nexusops.test';
    });

    // There is only ever one row, and the index makes sure of it, so a
    // deactivated operator has to come back rather than be replaced.
    it('restores a deactivated operator', async () => {
      prisma.user.findFirst.mockResolvedValue({
        ...operator,
        deletedAt: new Date(),
      });

      await service.ensureAdminMaster();

      const [args] = prisma.user.update.mock.calls[0] as [
        { data: { deletedAt: Date | null } },
      ];
      expect(args.data.deletedAt).toBeNull();
    });
  });

  describe('the scopes it runs in', () => {
    it('upserts the platform tenant unscoped', async () => {
      prisma.tenant.upsert.mockImplementation(() => {
        // Tenant is the one TENANT_AGNOSTIC model. Under a tenant scope the
        // extension would rewrite the where to `id = <current tenant>`, and at
        // boot there is no current tenant at all.
        expect(currentScope()).toEqual({ kind: 'unscoped' });
        return Promise.resolve(platformTenant);
      });

      await service.ensureAdminMaster();
    });

    it('writes the operator inside the platform tenant scope', async () => {
      prisma.user.create.mockImplementation(() => {
        expect(currentScope()).toEqual({
          kind: 'tenant',
          tenantId: 'platform-tenant',
        });
        return Promise.resolve(operator);
      });

      await service.ensureAdminMaster();
    });
  });
});
