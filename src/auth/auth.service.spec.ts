import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { currentScope } from '../tenancy/tenant-context';
import { AuthService } from './auth.service';
import { HashingService } from './hashing.service';

describe('AuthService', () => {
  const tenant = {
    id: 'tenant-a',
    name: 'Acme',
    domain: 'acme.com',
    isActive: true,
    createdAt: new Date(),
  };

  const user: User = {
    id: 'user-a',
    tenantId: 'tenant-a',
    email: 'admin@acme.com',
    passwordHash: 'stored-hash',
    role: UserRole.ADMIN,
    createdAt: new Date(),
    deletedAt: null,
  };

  const credentials = {
    tenantDomain: 'acme.com',
    email: 'admin@acme.com',
    password: 'correct horse battery',
  };

  let prisma: {
    tenant: { findUnique: jest.Mock };
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let hashing: {
    hash: jest.Mock;
    compare: jest.Mock;
    compareWithDecoy: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    prisma = {
      tenant: { findUnique: jest.fn() },
      user: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    hashing = {
      hash: jest.fn().mockResolvedValue('fresh-hash'),
      compare: jest.fn().mockResolvedValue(true),
      compareWithDecoy: jest.fn().mockResolvedValue(false),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.access.token') };

    service = new AuthService(
      prisma as unknown as ExtendedPrismaClient,
      hashing as unknown as HashingService,
      jwt as unknown as JwtService,
    );
  });

  describe('login', () => {
    const succeedingLookups = () => {
      prisma.tenant.findUnique.mockResolvedValue(tenant);
      prisma.user.findFirst.mockResolvedValue(user);
    };

    it('returns a token and a user with no password hash in it', async () => {
      succeedingLookups();

      const result = await service.login(credentials);

      expect(result.accessToken).toBe('signed.access.token');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user.id).toBe('user-a');
    });

    it('puts the tenant in the token so the request can establish its scope', async () => {
      succeedingLookups();

      await service.login(credentials);

      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: 'user-a',
        tenantId: 'tenant-a',
        email: 'admin@acme.com',
        role: UserRole.ADMIN,
      });
    });

    // The tenant lookup is the one read in the module that legitimately runs
    // without a tenant, and it must not leave the scope behind it.
    it('resolves the tenant unscoped and the user scoped', async () => {
      const scopes: unknown[] = [];
      prisma.tenant.findUnique.mockImplementation(() => {
        scopes.push(currentScope());
        return Promise.resolve(tenant);
      });
      prisma.user.findFirst.mockImplementation(() => {
        scopes.push(currentScope());
        return Promise.resolve(user);
      });

      await service.login(credentials);

      expect(scopes).toEqual([
        { kind: 'unscoped' },
        { kind: 'tenant', tenantId: 'tenant-a' },
      ]);
      expect(currentScope()).toEqual({ kind: 'none' });
    });

    // The user lookup carries no tenant filter of its own: the extension
    // injects it. A filter written here is a filter that can be forgotten.
    it('does not hand-write a tenant filter', async () => {
      succeedingLookups();

      await service.login(credentials);

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'admin@acme.com' },
      });
    });

    describe.each([
      [
        'the tenant does not exist',
        () => prisma.tenant.findUnique.mockResolvedValue(null),
      ],
      [
        'the tenant is deactivated',
        () =>
          prisma.tenant.findUnique.mockResolvedValue({
            ...tenant,
            isActive: false,
          }),
      ],
      [
        'the user does not exist',
        () => {
          prisma.tenant.findUnique.mockResolvedValue(tenant);
          prisma.user.findFirst.mockResolvedValue(null);
        },
      ],
      [
        'the user is soft-deleted',
        () => {
          prisma.tenant.findUnique.mockResolvedValue(tenant);
          prisma.user.findFirst.mockResolvedValue({
            ...user,
            deletedAt: new Date(),
          });
        },
      ],
    ])('when %s', (_label, arrange) => {
      beforeEach(() => arrange());

      // Telling these apart would map which companies use the product and who
      // works there.
      it('fails with the same message as a wrong password', async () => {
        await expect(service.login(credentials)).rejects.toThrow(
          new UnauthorizedException('Invalid credentials'),
        );
      });

      // And in the same amount of time. Skipping bcrypt on the not-found path
      // answers "does this account exist?" with a stopwatch.
      it('still spends the time a real comparison would', async () => {
        await expect(service.login(credentials)).rejects.toThrow();

        expect(hashing.compareWithDecoy).toHaveBeenCalledWith(
          credentials.password,
        );
      });
    });

    it('rejects a wrong password', async () => {
      succeedingLookups();
      hashing.compare.mockResolvedValue(false);

      await expect(service.login(credentials)).rejects.toThrow(
        new UnauthorizedException('Invalid credentials'),
      );
    });
  });

  describe('register', () => {
    it('hashes the password before opening the transaction', async () => {
      const order: string[] = [];
      hashing.hash.mockImplementation(() => {
        order.push('hash');
        return Promise.resolve('fresh-hash');
      });
      prisma.$transaction.mockImplementation(() => {
        order.push('transaction');
        return Promise.resolve(user);
      });

      await service.register({ ...credentials, tenantName: 'Acme' });

      // bcrypt at production cost takes hundreds of milliseconds; doing it
      // inside the transaction holds a pooled connection open for all of it.
      expect(order).toEqual(['hash', 'transaction']);
    });

    it('turns a duplicate domain into 409 rather than a Prisma error', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '7.9.1',
        }),
      );

      await expect(
        service.register({ ...credentials, tenantName: 'Acme' }),
      ).rejects.toThrow(ConflictException);
    });

    it('lets any other database error through untranslated', async () => {
      const boom = new Error('connection reset');
      prisma.$transaction.mockRejectedValue(boom);

      await expect(
        service.register({ ...credentials, tenantName: 'Acme' }),
      ).rejects.toBe(boom);
    });
  });
});
