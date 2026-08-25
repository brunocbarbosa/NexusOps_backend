import { ConflictException, NotFoundException } from '@nestjs/common';
import { HashingService } from '../auth/hashing.service';
import { Prisma, Tenant } from '../generated/prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { currentScope } from '../tenancy/tenant-context';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';

/**
 * These tests came from `AuthService.register`, because the transaction did:
 * `POST /platform/companies` is that code moved, not rewritten, and what it has
 * to keep getting right is unchanged.
 */
describe('CompaniesService', () => {
  const company: Tenant = {
    id: 'tenant-a',
    name: 'Acme',
    domain: 'acme.com',
    isActive: true,
    isPlatform: null,
    createdAt: new Date(),
  };

  const dto: CreateCompanyDto = {
    name: 'Acme',
    domain: 'acme.com',
    admin: { email: 'admin@acme.com', password: 'a-long-enough-password' },
  };

  const duplicate = () =>
    new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '7.9.1',
    });

  let prisma: {
    tenant: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let hashing: { hash: jest.Mock };
  let service: CompaniesService;

  beforeEach(() => {
    prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(company),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue(company),
        delete: jest.fn().mockResolvedValue(company),
      },
      $transaction: jest.fn(),
    };
    hashing = { hash: jest.fn().mockResolvedValue('fresh-hash') };

    service = new CompaniesService(
      prisma as unknown as ExtendedPrismaClient,
      hashing as unknown as HashingService,
    );
  });

  describe('create', () => {
    it('hashes the password before opening the transaction', async () => {
      const order: string[] = [];
      hashing.hash.mockImplementation(() => {
        order.push('hash');
        return Promise.resolve('fresh-hash');
      });
      prisma.$transaction.mockImplementation(() => {
        order.push('transaction');
        return Promise.resolve({ company, admin: {} });
      });

      await service.create(dto);

      // bcrypt at production cost takes hundreds of milliseconds; doing it
      // inside the transaction holds a pooled connection open for all of it.
      expect(order).toEqual(['hash', 'transaction']);
    });

    it('turns a duplicate domain into 409 rather than a Prisma error', async () => {
      prisma.$transaction.mockRejectedValue(duplicate());

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });

    it('lets any other database error through untranslated', async () => {
      const boom = new Error('connection reset');
      prisma.$transaction.mockRejectedValue(boom);

      await expect(service.create(dto)).rejects.toBe(boom);
    });
  });

  /**
   * The property the whole service rests on. `Tenant` is the one model in
   * `TENANT_AGNOSTIC`, and under a tenant scope the extension rewrites a read to
   * `where.id = <current tenant>` — so an ADMIN_MASTER whose request already
   * carries the platform scope would see the platform row and nothing else.
   */
  describe('the scope every company query runs in', () => {
    it('reads a company unscoped, not under the caller tenant', async () => {
      prisma.tenant.findUnique.mockImplementation(() => {
        expect(currentScope()).toEqual({ kind: 'unscoped' });
        return Promise.resolve(company);
      });

      await service.findOne('tenant-a');

      expect(prisma.tenant.findUnique).toHaveBeenCalled();
    });

    it('lists companies unscoped', async () => {
      prisma.$transaction.mockImplementation(() => {
        expect(currentScope()).toEqual({ kind: 'unscoped' });
        return Promise.resolve([0, []]);
      });

      await service.findAll({ page: 1, perPage: 20 });
    });
  });

  describe('findAll', () => {
    it('excludes the platform tenant by isPlatform, never by domain', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ page: 1, perPage: 20 });

      const [where] = prisma.tenant.count.mock.calls[0] as [{ where: unknown }];
      // `domain: { not: "platform" }` would drop every company whose domain is
      // NULL, because NOT (NULL = 'platform') is NULL rather than true.
      expect((where as { where: Record<string, unknown> }).where).toMatchObject(
        {
          isPlatform: null,
        },
      );
    });

    it('leaves isActive out of the filter when it was not asked for', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ page: 1, perPage: 20 });

      const [args] = prisma.tenant.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).not.toHaveProperty('isActive');
    });

    it('reports at least one page when there is nothing to show', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      const result = await service.findAll({ page: 1, perPage: 20 });

      expect(result.meta).toEqual({
        total: 0,
        page: 1,
        perPage: 20,
        totalPages: 1,
      });
    });
  });

  describe('requireCompany', () => {
    it('404s on an id that belongs to nothing', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);

      await expect(service.requireCompany('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // Without this, /platform/companies/<platform-id>/users/<self> lets the
    // ADMIN_MASTER deactivate itself and leaves the installation operatorless.
    it('404s on the platform tenant — it is not a company', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        ...company,
        isPlatform: true,
      });

      await expect(service.requireCompany('tenant-a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to delete the platform tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        ...company,
        isPlatform: true,
      });

      await expect(service.remove('tenant-a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.tenant.delete).not.toHaveBeenCalled();
    });
  });
});
