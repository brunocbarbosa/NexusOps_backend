import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DomainEvents } from '../tenancy/domain-events';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Comment, Ticket, User } from '../generated/prisma/client';
import {
  TicketCategory,
  TicketPriority,
  TicketStatus,
  UserRole,
} from '../generated/prisma/enums';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import {
  runWithTenant,
  fakeScope,
  useScope,
} from '../../test/utils/tenant-scope';
import { TicketWithPeople } from '../tickets/ticket-response';
import { TicketsService } from '../tickets/tickets.service';
import { CommentWithAuthor } from './comment-response';
import { CommentsService } from './comments.service';

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

const ticket = (over: Partial<Ticket> = {}): TicketWithPeople => ({
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

const comment = (over: Partial<Comment> = {}): CommentWithAuthor => ({
  id: 'comment-1',
  tenantId: TENANT,
  ticketId: 'ticket-1',
  authorId: 'user-1',
  body: 'Have you tried turning it off',
  isInternal: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
  author: user(),
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

describe('CommentsService', () => {
  useScope(fakeScope());

  let prisma: {
    comment: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };
  let tickets: { requireTicket: jest.Mock };
  let events: { emit: jest.Mock };
  let comments: CommentsService;

  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(TENANT, fn);
  const query = { page: 1, perPage: 20 };

  beforeEach(() => {
    prisma = {
      comment: {
        create: jest.fn().mockResolvedValue(comment()),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as unknown[]),
      ),
    };
    tickets = { requireTicket: jest.fn().mockResolvedValue(ticket()) };

    events = { emit: jest.fn() };
    comments = new CommentsService(
      prisma as unknown as ExtendedPrismaClient,
      tickets as unknown as TicketsService,
      events as unknown as DomainEvents,
    );
  });

  // The access-control story in one assertion: everything else in this service
  // runs only after the parent ticket has been resolved for this caller.
  it('resolves the parent ticket before anything else', async () => {
    await inTenant(() => comments.findAll('ticket-1', query, requester));

    expect(tickets.requireTicket).toHaveBeenCalledWith('ticket-1', requester);
  });

  it('lets the ticket 404 propagate rather than answering it here', async () => {
    tickets.requireTicket.mockRejectedValue(new Error('No ticket ticket-9'));

    await expect(
      inTenant(() => comments.findAll('ticket-9', query, requester)),
    ).rejects.toThrow('No ticket ticket-9');
    expect(prisma.comment.count).not.toHaveBeenCalled();
  });

  describe('internal notes', () => {
    it('refuses one from a requester', async () => {
      await expect(
        inTenant(() =>
          comments.create(
            'ticket-1',
            { body: 'secret', isInternal: true },
            requester,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('accepts one from an agent', async () => {
      await inTenant(() =>
        comments.create(
          'ticket-1',
          { body: 'internal', isInternal: true },
          agent,
        ),
      );

      const [args] = prisma.comment.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data.isInternal).toBe(true);
      expect(args.data.tenantId).toBe(TENANT);
    });

    it('defaults to a visible comment when the flag is absent', async () => {
      await inTenant(() =>
        comments.create('ticket-1', { body: 'hello' }, agent),
      );

      const [args] = prisma.comment.create.mock.calls[0] as [
        { data: { isInternal: boolean } },
      ];
      expect(args.data.isInternal).toBe(false);
    });

    it('hides them from a requester, in the page and in the count', async () => {
      await inTenant(() => comments.findAll('ticket-1', query, requester));

      const [countArgs] = prisma.comment.count.mock.calls[0] as [
        { where: { isInternal?: boolean } },
      ];
      const [manyArgs] = prisma.comment.findMany.mock.calls[0] as [
        { where: { isInternal?: boolean } },
      ];
      expect(countArgs.where.isInternal).toBe(false);
      // The same `where` object reaches both, which is what keeps the total
      // from announcing rows the caller cannot read.
      expect(manyArgs.where).toEqual(countArgs.where);
    });

    it('shows them to staff', async () => {
      await inTenant(() => comments.findAll('ticket-1', query, agent));

      const [countArgs] = prisma.comment.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(countArgs.where).not.toHaveProperty('isInternal');
    });
  });

  it('writes no tenant filter of its own', async () => {
    await inTenant(() => comments.findAll('ticket-1', query, agent));

    const [countArgs] = prisma.comment.count.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(countArgs.where).not.toHaveProperty('tenantId');
  });

  it('refuses a comment on a closed ticket', async () => {
    tickets.requireTicket.mockResolvedValue(
      ticket({ status: TicketStatus.CLOSED }),
    );

    await expect(
      inTenant(() => comments.create('ticket-1', { body: 'late' }, agent)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('still lets a closed ticket be read', async () => {
    tickets.requireTicket.mockResolvedValue(
      ticket({ status: TicketStatus.CLOSED }),
    );

    // Frozen, not hidden: the record stays readable.
    await expect(
      inTenant(() => comments.findAll('ticket-1', query, agent)),
    ).resolves.toMatchObject({ meta: { total: 0 } });
  });

  it('reports one page rather than zero for an empty thread', async () => {
    const page = await inTenant(() =>
      comments.findAll('ticket-1', query, agent),
    );

    expect(page.meta).toEqual({
      total: 0,
      page: 1,
      perPage: 20,
      totalPages: 1,
    });
  });

  describe('the events it emits', () => {
    it('records a reply against the ticket, not the comment', async () => {
      await inTenant(() =>
        comments.create('ticket-1', { body: 'hello' }, agent),
      );

      const [name, event] = events.emit.mock.calls[0] as [
        string,
        { entityId: string; entityType: string; newValues: unknown },
      ];
      expect(name).toBe('ticket.commented');
      expect(event.entityType).toBe('Ticket');
      // The ticket id, so one timeline query finds it.
      expect(event.entityId).toBe('ticket-1');
      expect(event.newValues).toEqual({ commentId: 'comment-1' });
    });

    it('gives an internal note its own action', async () => {
      prisma.comment.create.mockResolvedValue(comment({ isInternal: true }));

      await inTenant(() =>
        comments.create(
          'ticket-1',
          { body: 'internal', isInternal: true },
          agent,
        ),
      );

      // A distinct action rather than a flag inside the payload, so that hiding
      // it from a requester's timeline stays a plain column comparison.
      const [name] = events.emit.mock.calls[0] as [string];
      expect(name).toBe('ticket.internal_note_added');
    });

    it('says nothing when the comment was refused', async () => {
      await expect(
        inTenant(() =>
          comments.create(
            'ticket-1',
            { body: 'secret', isInternal: true },
            requester,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
