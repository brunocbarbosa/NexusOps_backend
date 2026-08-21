import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { HashingService } from '../auth/hashing.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { Prisma, User } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant } from '../tenancy/tenant-context';
import { QueryUsersDto } from './dto/query-users.dto';
import { UsersService } from './users.service';

const duplicate = () =>
  new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '7.9.1',
  });

describe('UsersService', () => {
  const admin: AuthenticatedUser = {
    id: 'admin-1',
    tenantId: 'tenant-a',
    email: 'admin@acme.com',
    role: UserRole.ADMIN,
  };
  const agent: AuthenticatedUser = {
    ...admin,
    id: 'agent-1',
    role: UserRole.AGENT,
  };

  const row = (over: Partial<User> = {}): User => ({
    id: 'user-1',
    tenantId: 'tenant-a',
    email: 'someone@acme.com',
    passwordHash: 'stored-hash',
    role: UserRole.REQUESTER,
    createdAt: new Date(),
    deletedAt: null,
    ...over,
  });

  let prisma: {
    user: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let hashing: { hash: jest.Mock; compare: jest.Mock };
  let refreshTokens: { revokeAllFor: jest.Mock };
  let service: UsersService;

  // Everything here runs inside a tenant scope, because in production the
  // interceptor has already opened one by the time a service method runs.
  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant('tenant-a', fn);

  beforeEach(() => {
    prisma = {
      user: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockResolvedValue([0, []]),
    };
    hashing = {
      hash: jest.fn().mockResolvedValue('fresh-hash'),
      compare: jest.fn().mockResolvedValue(true),
    };
    refreshTokens = { revokeAllFor: jest.fn().mockResolvedValue(1) };

    service = new UsersService(
      prisma as unknown as ExtendedPrismaClient,
      hashing as unknown as HashingService,
      refreshTokens as unknown as RefreshTokenService,
    );
  });

  describe('create', () => {
    it('defaults to the least privileged role and never stores the plaintext', async () => {
      prisma.user.create.mockResolvedValue(row());

      await inTenant(() =>
        service.create({ email: 'new@acme.com', password: 'a-password-here' }),
      );

      expect(hashing.hash).toHaveBeenCalledWith('a-password-here');
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'new@acme.com',
          passwordHash: 'fresh-hash',
          role: UserRole.REQUESTER,
          // Stamped by tenantScoped, not written by the service.
          tenantId: 'tenant-a',
        },
      });
    });

    it('never returns the password hash', async () => {
      prisma.user.create.mockResolvedValue(row());

      const created = await inTenant(() =>
        service.create({ email: 'new@acme.com', password: 'a-password-here' }),
      );

      expect(created).not.toHaveProperty('passwordHash');
    });

    // The two cases behind one P2002. Telling them apart is the reason the
    // restore route exists at all.
    it('points a clashing e-mail at restore when the holder is deactivated', async () => {
      prisma.user.create.mockRejectedValue(duplicate());
      prisma.user.findFirst.mockResolvedValue(
        row({ id: 'gone-1', deletedAt: new Date() }),
      );

      await expect(
        inTenant(() =>
          service.create({
            email: 'new@acme.com',
            password: 'a-password-here',
          }),
        ),
      ).rejects.toThrow(/deactivated user \(gone-1\)/);
    });

    it('reports a clashing e-mail plainly when the holder is active', async () => {
      prisma.user.create.mockRejectedValue(duplicate());
      prisma.user.findFirst.mockResolvedValue(row());

      await expect(
        inTenant(() =>
          service.create({
            email: 'new@acme.com',
            password: 'a-password-here',
          }),
        ),
      ).rejects.toThrow(/already in use/);
    });
  });

  describe('findAll', () => {
    const query = (over: Partial<QueryUsersDto> = {}): QueryUsersDto => ({
      page: 1,
      perPage: 20,
      includeDeleted: false,
      ...over,
    });

    it('hides deactivated users by default, with no tenant filter of its own', async () => {
      await inTenant(() => service.findAll(query(), agent));

      const [countArgs] = prisma.user.count.mock.calls[0] as [
        { where: unknown },
      ];
      expect(countArgs.where).toEqual({ deletedAt: null });
    });

    it('lets an ADMIN ask for deactivated users', async () => {
      await inTenant(() =>
        service.findAll(query({ includeDeleted: true }), admin),
      );

      const [countArgs] = prisma.user.count.mock.calls[0] as [
        { where: unknown },
      ];
      expect(countArgs.where).toEqual({});
    });

    // Refused rather than ignored: an AGENT told "no deactivated users" would
    // read that as an answer about the data.
    it('refuses includeDeleted for anyone but an ADMIN', async () => {
      await expect(
        inTenant(() => service.findAll(query({ includeDeleted: true }), agent)),
      ).rejects.toThrow(ForbiddenException);
    });

    it('counts and pages in one transaction, so the total matches the page', async () => {
      prisma.$transaction.mockResolvedValue([42, [row()]]);

      const result = await inTenant(() =>
        service.findAll(query({ page: 3, perPage: 10 }), admin),
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result.meta).toEqual({
        total: 42,
        page: 3,
        perPage: 10,
        totalPages: 5,
      });
    });

    it('reports one page rather than zero when the tenant is empty', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      const result = await inTenant(() => service.findAll(query(), admin));

      expect(result.meta.totalPages).toBe(1);
    });
  });

  describe('findOne', () => {
    it('404s on an id the extension filtered out', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        inTenant(() => service.findOne('user-1', admin)),
      ).rejects.toThrow(NotFoundException);
    });

    // 404 and not 403: a 403 confirms the id exists, which is a fact about
    // another company's data.
    it('asks with no tenant filter of its own', async () => {
      prisma.user.findUnique.mockResolvedValue(row());

      await inTenant(() => service.findOne('user-1', admin));

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });

    it('shows a deactivated user to an ADMIN and hides it from an AGENT', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ deletedAt: new Date() }));

      await expect(
        inTenant(() => service.findOne('user-1', admin)),
      ).resolves.toMatchObject({ id: 'user-1' });
      await expect(
        inTenant(() => service.findOne('user-1', agent)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deactivates instead of deleting, and ends the sessions', async () => {
      prisma.user.findUnique.mockResolvedValue(row());
      prisma.user.update.mockResolvedValue(row({ deletedAt: new Date() }));

      await inTenant(() => service.remove('user-1', admin));

      const [call] = prisma.user.update.mock.calls as [
        [{ where: { id: string }; data: { deletedAt: Date } }],
      ];
      expect(call[0].where).toEqual({ id: 'user-1' });
      expect(call[0].data.deletedAt).toBeInstanceOf(Date);
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('user-1');
    });

    it('refuses self-deactivation', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ id: admin.id }));

      await expect(
        inTenant(() => service.remove(admin.id, admin)),
      ).rejects.toThrow(/cannot deactivate yourself/);
    });

    it('refuses a user who is already deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ deletedAt: new Date() }));

      await expect(
        inTenant(() => service.remove('user-1', admin)),
      ).rejects.toThrow(/already deactivated/);
    });

    // A tenant with no active ADMIN cannot create users, restore them or
    // change roles — there is no way back.
    it('refuses the last active ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(
        row({ id: 'other-admin', role: UserRole.ADMIN }),
      );
      prisma.user.count.mockResolvedValue(1);

      await expect(
        inTenant(() => service.remove('other-admin', admin)),
      ).rejects.toThrow(/last active ADMIN/);
    });

    it('allows an ADMIN when another one remains', async () => {
      prisma.user.findUnique.mockResolvedValue(
        row({ id: 'other-admin', role: UserRole.ADMIN }),
      );
      prisma.user.count.mockResolvedValue(2);
      prisma.user.update.mockResolvedValue(row({ deletedAt: new Date() }));

      await expect(
        inTenant(() => service.remove('other-admin', admin)),
      ).resolves.toBeUndefined();
    });
  });

  describe('update', () => {
    it('refuses to demote the last active ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(
        row({ id: 'other-admin', role: UserRole.ADMIN }),
      );
      prisma.user.count.mockResolvedValue(1);

      await expect(
        inTenant(() =>
          service.update('other-admin', { role: UserRole.AGENT }, admin),
        ),
      ).rejects.toThrow(/last active ADMIN/);
    });

    it('turns a clashing e-mail into 409', async () => {
      prisma.user.findUnique.mockResolvedValue(row());
      prisma.user.update.mockRejectedValue(duplicate());

      await expect(
        inTenant(() =>
          service.update('user-1', { email: 'taken@acme.com' }, admin),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('restore', () => {
    it('reactivates a deactivated user', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ deletedAt: new Date() }));
      prisma.user.update.mockResolvedValue(row());

      const restored = await inTenant(() => service.restore('user-1', admin));

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { deletedAt: null },
      });
      expect(restored.deletedAt).toBeNull();
    });

    it('refuses a user who is not deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue(row());

      await expect(
        inTenant(() => service.restore('user-1', admin)),
      ).rejects.toThrow(/not deactivated/);
    });
  });

  describe('changePassword', () => {
    const dto = {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    };

    it('ends every session, which is the point of changing it', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ id: admin.id }));
      hashing.compare
        .mockResolvedValueOnce(true) // current password matches
        .mockResolvedValueOnce(false); // and the new one differs
      prisma.user.update.mockResolvedValue(row({ id: admin.id }));

      await inTenant(() => service.changePassword(dto, admin));

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: admin.id },
        data: { passwordHash: 'fresh-hash' },
      });
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith(admin.id);
    });

    it('refuses a wrong current password without touching the row', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ id: admin.id }));
      hashing.compare.mockResolvedValue(false);

      await expect(
        inTenant(() => service.changePassword(dto, admin)),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a new password identical to the current one', async () => {
      prisma.user.findUnique.mockResolvedValue(row({ id: admin.id }));
      hashing.compare.mockResolvedValue(true);

      await expect(
        inTenant(() => service.changePassword(dto, admin)),
      ).rejects.toThrow(/must differ/);
    });
  });
});
