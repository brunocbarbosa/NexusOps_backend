import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Ticket, User } from '../generated/prisma/client';
import {
  TicketCategory,
  TicketPriority,
  TicketStatus,
  UserRole,
} from '../generated/prisma/enums';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant } from '../tenancy/tenant-context';
import { TicketWithPeople } from './ticket-response';
import { TicketsService } from './tickets.service';

const TENANT = 'tenant-a';

const user = (over: Partial<User> = {}): User => ({
  id: 'user-1',
  tenantId: TENANT,
  email: 'requester@example.com',
  passwordHash: 'x',
  role: UserRole.REQUESTER,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
  ...over,
});

const row = (over: Partial<Ticket> = {}): TicketWithPeople => ({
  id: 'ticket-1',
  tenantId: TENANT,
  number: 1,
  requesterId: 'user-1',
  assigneeId: null,
  title: 'Printer is on fire',
  description: null,
  status: TicketStatus.OPEN,
  priority: TicketPriority.MEDIUM,
  category: TicketCategory.OTHER,
  version: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null,
  closedAt: null,
  closedById: null,
  ...over,
  requester: user(),
  assignee: null,
  closedBy: null,
});

const requester: AuthenticatedUser = {
  id: 'user-1',
  tenantId: TENANT,
  email: 'requester@example.com',
  role: UserRole.REQUESTER,
};

const agent: AuthenticatedUser = {
  id: 'user-2',
  tenantId: TENANT,
  email: 'agent@example.com',
  role: UserRole.AGENT,
};

/**
 * The service against a mocked Prisma, inside a real tenant scope.
 *
 * `runWithTenant` is the real function, not a mock, because that is what makes
 * `tenantScoped()` produce a tenantId and what lets these assertions say
 * something true: the queries below are inspected for a tenant filter the
 * service must **not** have written. In production the interceptor has already
 * opened this scope by the time any of these methods run.
 */
describe('TicketsService', () => {
  let prisma: {
    ticket: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
    ticketCounter: { updateManyAndReturn: jest.Mock };
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tickets: TicketsService;

  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(TENANT, fn);

  beforeEach(() => {
    prisma = {
      ticket: {
        create: jest.fn().mockResolvedValue(row()),
        findFirst: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([]),
        findUniqueOrThrow: jest.fn().mockResolvedValue(row({ version: 2 })),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ticketCounter: {
        updateManyAndReturn: jest.fn().mockResolvedValue([{ lastNumber: 7 }]),
      },
      user: { findFirst: jest.fn().mockResolvedValue(user()) },
      // Both shapes: the array form for count+page, the callback form for the
      // mutations. The callback gets the same mock, which is what the real
      // extended client hands over too.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as unknown[]),
      ),
    };

    tickets = new TicketsService(prisma as unknown as ExtendedPrismaClient);
  });

  describe('create', () => {
    it('takes its number from the counter and stamps the tenant', async () => {
      await inTenant(() =>
        tickets.create({ title: 'Printer is on fire' }, requester),
      );

      const [args] = prisma.ticket.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data.number).toBe(7);
      expect(args.data.requesterId).toBe('user-1');
      // Written by tenantScoped(), not by the service naming a tenant.
      expect(args.data.tenantId).toBe(TENANT);
    });

    it('asks the counter with no tenant filter of its own', async () => {
      await inTenant(() => tickets.create({ title: 'x' }, requester));

      const [args] = prisma.ticketCounter.updateManyAndReturn.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).toEqual({});
    });

    it('fails loudly when the tenant has no counter row', async () => {
      prisma.ticketCounter.updateManyAndReturn.mockResolvedValue([]);

      // Not an HTTP exception on purpose: broken data, not a bad request.
      await expect(
        inTenant(() => tickets.create({ title: 'x' }, requester)),
      ).rejects.toThrow(/no ticket_counters row/);
    });
  });

  describe('findAll', () => {
    const query = (over: Record<string, unknown> = {}) =>
      ({ page: 1, perPage: 20, ...over }) as never;

    it('writes no tenant filter of its own', async () => {
      await inTenant(() => tickets.findAll(query(), agent));

      const [countArgs] = prisma.ticket.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(countArgs.where).not.toHaveProperty('tenantId');
    });

    it('confines a requester to their own tickets', async () => {
      await inTenant(() => tickets.findAll(query(), requester));

      const [countArgs] = prisma.ticket.count.mock.calls[0] as [
        { where: { requesterId?: string } },
      ];
      expect(countArgs.where.requesterId).toBe('user-1');
    });

    it('leaves staff unfiltered by requester', async () => {
      await inTenant(() => tickets.findAll(query(), agent));

      const [countArgs] = prisma.ticket.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(countArgs.where).not.toHaveProperty('requesterId');
    });

    // The ordering that makes the visibility rule hold: the scope is spread
    // last, so a requester asking about somebody else overwrites nothing.
    it('overrides a requesterId a requester tried to pass', async () => {
      await inTenant(() =>
        tickets.findAll(query({ requesterId: 'someone-else' }), requester),
      );

      const [countArgs] = prisma.ticket.count.mock.calls[0] as [
        { where: { requesterId?: string } },
      ];
      expect(countArgs.where.requesterId).toBe('user-1');
    });

    it('honours a requesterId when staff asks', async () => {
      await inTenant(() =>
        tickets.findAll(query({ requesterId: 'someone-else' }), agent),
      );

      const [countArgs] = prisma.ticket.count.mock.calls[0] as [
        { where: { requesterId?: string } },
      ];
      expect(countArgs.where.requesterId).toBe('someone-else');
    });

    it('refuses unassigned and assigneeId together', async () => {
      await expect(
        inTenant(() =>
          tickets.findAll(
            query({ unassigned: true, assigneeId: 'user-2' }),
            agent,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports one page rather than zero for an empty list', async () => {
      const page = await inTenant(() => tickets.findAll(query(), agent));

      expect(page.meta).toEqual({
        total: 0,
        page: 1,
        perPage: 20,
        totalPages: 1,
      });
    });
  });

  describe('optimistic concurrency', () => {
    it('matches on the version the caller sent', async () => {
      await inTenant(() =>
        tickets.update('ticket-1', { version: 3, title: 'new' }, agent),
      );

      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ];
      expect(args.where).toEqual({ id: 'ticket-1', version: 3 });
      expect(args.data.version).toEqual({ increment: 1 });
    });

    it('answers 409 when the row moved under the caller', async () => {
      prisma.ticket.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        inTenant(() =>
          tickets.update('ticket-1', { version: 1, title: 'new' }, agent),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 404 rather than 409 for a ticket it cannot see', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        inTenant(() =>
          tickets.update('ticket-1', { version: 1, title: 'new' }, agent),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The distinction is the point: the write never ran.
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('changeStatus', () => {
    it('stamps resolvedAt on the way into RESOLVED', async () => {
      await inTenant(() =>
        tickets.changeStatus(
          'ticket-1',
          { version: 1, status: TicketStatus.RESOLVED },
          agent,
        ),
      );

      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { data: { resolvedAt: Date | null } },
      ];
      expect(args.data.resolvedAt).toBeInstanceOf(Date);
    });

    it('clears resolvedAt when a resolved ticket is reopened', async () => {
      prisma.ticket.findFirst.mockResolvedValue(
        row({ status: TicketStatus.RESOLVED }),
      );

      await inTenant(() =>
        tickets.changeStatus(
          'ticket-1',
          { version: 1, status: TicketStatus.OPEN },
          agent,
        ),
      );

      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { data: { resolvedAt: Date | null } },
      ];
      expect(args.data.resolvedAt).toBeNull();
    });

    it('keeps resolvedAt when a resolved ticket is closed', async () => {
      prisma.ticket.findFirst.mockResolvedValue(
        row({ status: TicketStatus.RESOLVED }),
      );

      await inTenant(() =>
        tickets.changeStatus(
          'ticket-1',
          { version: 1, status: TicketStatus.CLOSED },
          agent,
        ),
      );

      // Closing must not erase when the work finished. An earlier draft cleared
      // resolvedAt on every destination that was not RESOLVED, which quietly
      // wiped it on the way to CLOSED — caught by the e2e lifecycle walk, not
      // by any unit test, which is why this one exists now.
      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).not.toHaveProperty('resolvedAt');
    });

    it('records who closed it', async () => {
      prisma.ticket.findFirst.mockResolvedValue(
        row({ status: TicketStatus.RESOLVED }),
      );

      await inTenant(() =>
        tickets.changeStatus(
          'ticket-1',
          { version: 1, status: TicketStatus.CLOSED },
          agent,
        ),
      );

      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { data: { closedById: string; closedAt: Date } },
      ];
      expect(args.data.closedById).toBe('user-2');
      expect(args.data.closedAt).toBeInstanceOf(Date);
    });

    it.each([
      ['OPEN straight to CLOSED', TicketStatus.OPEN, TicketStatus.CLOSED],
      ['anything out of CLOSED', TicketStatus.CLOSED, TicketStatus.OPEN],
    ])('refuses %s', async (_label, from, to) => {
      prisma.ticket.findFirst.mockResolvedValue(row({ status: from }));

      await expect(
        inTenant(() =>
          tickets.changeStatus('ticket-1', { version: 1, status: to }, agent),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a transition to the status it already has', async () => {
      await expect(
        inTenant(() =>
          tickets.changeStatus(
            'ticket-1',
            { version: 1, status: TicketStatus.OPEN },
            agent,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('assign', () => {
    it('accepts an agent', async () => {
      prisma.user.findFirst.mockResolvedValue(
        user({ id: 'user-2', role: UserRole.AGENT }),
      );

      await inTenant(() =>
        tickets.assign('ticket-1', { version: 1, assigneeId: 'user-2' }, agent),
      );

      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { data: { assigneeId: string | null } },
      ];
      expect(args.data.assigneeId).toBe('user-2');
    });

    it('unassigns on an explicit null without looking anybody up', async () => {
      await inTenant(() =>
        tickets.assign('ticket-1', { version: 1, assigneeId: null }, agent),
      );

      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      const [args] = prisma.ticket.updateMany.mock.calls[0] as [
        { data: { assigneeId: string | null } },
      ];
      expect(args.data.assigneeId).toBeNull();
    });

    it('refuses a requester as assignee', async () => {
      prisma.user.findFirst.mockResolvedValue(
        user({ id: 'user-3', role: UserRole.REQUESTER }),
      );

      await expect(
        inTenant(() =>
          tickets.assign(
            'ticket-1',
            { version: 1, assigneeId: 'user-3' },
            agent,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s on an assignee that is not in this tenant', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        inTenant(() =>
          tickets.assign(
            'ticket-1',
            { version: 1, assigneeId: 'user-9' },
            agent,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('refuses to edit a closed ticket', async () => {
    prisma.ticket.findFirst.mockResolvedValue(
      row({ status: TicketStatus.CLOSED }),
    );

    await expect(
      inTenant(() =>
        tickets.update('ticket-1', { version: 1, title: 'new' }, agent),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
