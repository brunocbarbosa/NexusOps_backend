import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Prisma } from '../generated/prisma/client';
import { TicketStatus, UserRole } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type {
  ExtendedPrismaClient,
  ExtendedTransactionClient,
} from '../prisma/prisma.client';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { QueryTicketsDto } from './dto/query-tickets.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import {
  TICKET_PEOPLE,
  TicketResponse,
  TicketWithPeople,
  toTicketResponse,
} from './ticket-response';
import { canTransition } from './ticket-transitions';
import { seesEveryTicket } from './ticket-visibility';

export type PaginatedTickets = {
  data: TicketResponse[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The helpdesk's core aggregate.
 *
 * Three rules hold across this whole file, and none of them is enforced by a
 * compiler:
 *
 * **No query here writes a tenant filter.** The extension injects it into every
 * `where` and stamps it into every `data`. Every cross-tenant 404 in the e2e
 * suite is produced by code that is not in this file.
 *
 * **Visibility is applied last.** `visibleTo()` is spread after the caller's
 * own filters so that a `REQUESTER` passing `?requesterId=<someone else>` has
 * it overwritten rather than honoured — the same ordering trick the extension
 * uses for `tenantId`.
 *
 * **Every mutation goes through `mutate()`.** It is the one place the version
 * check lives, and a second copy of it would be a second place for a
 * last-write-wins bug to appear.
 */
@Injectable()
export class TicketsService {
  constructor(@Inject(PRISMA) private readonly prisma: ExtendedPrismaClient) {}

  /**
   * Opens a ticket, taking the next number in the company's sequence.
   *
   * The counter increment and the insert share one interactive transaction on
   * purpose: the `UPDATE` takes a row lock that is held until commit, so two
   * people opening a ticket at the same moment serialize instead of both
   * reading the same number. `where: {}` is not an oversight — the extension
   * supplies the tenant, which is what keeps this method free of a
   * hand-written filter.
   */
  async create(
    dto: CreateTicketDto,
    requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    const ticket = await this.prisma.$transaction(async (tx) => {
      const [counter] = await tx.ticketCounter.updateManyAndReturn({
        where: {},
        data: { lastNumber: { increment: 1 } },
      });

      // The row is created with the company, in the same transaction, and
      // backfilled for the companies that predate the table. Missing means the
      // data is broken rather than the request, so this is deliberately not an
      // HTTP exception: it should page somebody, not tell the caller to retry.
      if (!counter) {
        throw new Error(
          'This tenant has no ticket_counters row, so no ticket number can be ' +
            'issued. It should have been created with the company.',
        );
      }

      return tx.ticket.create({
        data: tenantScoped({
          number: counter.lastNumber,
          requesterId: requester.id,
          title: dto.title,
          description: dto.description,
          priority: dto.priority,
          category: dto.category,
        }),
        include: TICKET_PEOPLE,
      });
    });

    return toTicketResponse(ticket);
  }

  async findAll(
    query: QueryTicketsDto,
    requester: AuthenticatedUser,
  ): Promise<PaginatedTickets> {
    // Refused rather than resolved in favour of one of them: both readings are
    // defensible, so guessing would make the API's answer depend on which one
    // the implementer happened to pick.
    if (query.unassigned === true && query.assigneeId !== undefined) {
      throw new BadRequestException(
        'unassigned and assigneeId contradict each other. Send one or the other.',
      );
    }

    const where: Prisma.TicketWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
      ...(query.requesterId ? { requesterId: query.requesterId } : {}),
      ...(query.unassigned === undefined
        ? {}
        : query.unassigned
          ? { assigneeId: null }
          : { assigneeId: { not: null } }),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      // Last, so it wins over anything the caller asked for.
      ...this.visibleTo(requester),
    };

    // One round trip for both halves. Two awaits would let a concurrent write
    // land between them and return a total that does not match the page.
    const [total, tickets] = await this.prisma.$transaction([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        include: TICKET_PEOPLE,
        // Newest first, because a helpdesk queue is read from the top. The id
        // breaks ties so that two tickets created in the same millisecond do
        // not swap places between pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
    ]);

    return {
      data: tickets.map(toTicketResponse),
      meta: {
        total,
        page: query.page,
        perPage: query.perPage,
        totalPages: Math.ceil(total / query.perPage) || 1,
      },
    };
  }

  async findOne(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return toTicketResponse(await this.requireTicket(id, requester));
  }

  /**
   * Edits the descriptive fields. Status and assignee have their own routes.
   */
  async update(
    id: string,
    dto: UpdateTicketDto,
    requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.mutate(id, dto.version, requester, (_tx, current) => {
      this.assertOpenForEditing(current);

      // Undefined fields are left alone by Prisma, which is what makes a
      // partial PATCH work without the service comparing anything.
      return Promise.resolve({
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
        category: dto.category,
      });
    });
  }

  /**
   * Moves the ticket through its lifecycle, stamping the timestamps that go
   * with each destination.
   */
  async changeStatus(
    id: string,
    dto: ChangeStatusDto,
    requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.mutate(id, dto.version, requester, (_tx, current) => {
      if (current.status === dto.status) {
        throw new ConflictException(
          `This ticket is already ${dto.status.toLowerCase()}`,
        );
      }

      if (!canTransition(current.status, dto.status)) {
        throw new ConflictException(
          `A ticket cannot go from ${current.status} to ${dto.status}`,
        );
      }

      return Promise.resolve({
        status: dto.status,
        ...(dto.status === TicketStatus.RESOLVED
          ? { resolvedAt: new Date() }
          : {}),
        // Cleared only on the way back to OPEN. Reopening discards the
        // resolution, so a ticket sitting in OPEN while carrying a resolvedAt
        // would be a row contradicting itself. Closing does the opposite: it
        // keeps it, because when the work finished is the whole point of any
        // time-to-resolution report.
        ...(dto.status === TicketStatus.OPEN ? { resolvedAt: null } : {}),
        ...(dto.status === TicketStatus.CLOSED
          ? { closedAt: new Date(), closedById: requester.id }
          : {}),
      });
    });
  }

  /**
   * Assigns or unassigns. `assigneeId: null` is the unassign, and it is a
   * different request from omitting the field — see `AssignTicketDto`.
   */
  async assign(
    id: string,
    dto: AssignTicketDto,
    requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.mutate(id, dto.version, requester, async (tx, current) => {
      this.assertOpenForEditing(current);

      if (dto.assigneeId !== null) {
        await this.assertAssignable(tx, dto.assigneeId);
      }

      return { assigneeId: dto.assigneeId };
    });
  }

  /**
   * Loads a ticket the caller is allowed to see, or 404s.
   *
   * Public because the comment routes hang off a ticket and have to resolve the
   * parent before touching a child — a second implementation of this lookup
   * would be a second place for the visibility rule to drift.
   *
   * Both ways of failing produce the same 404. Another tenant's id is filtered
   * out by the extension; another requester's ticket is filtered out by
   * `visibleTo()`. A 403 in either case would confirm that the id exists,
   * which is a fact about somebody else's data.
   */
  async requireTicket(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<TicketWithPeople> {
    return this.load(this.prisma, id, requester);
  }

  private async load(
    client: ExtendedPrismaClient | ExtendedTransactionClient,
    id: string,
    requester: AuthenticatedUser,
  ): Promise<TicketWithPeople> {
    // findFirst and not findUnique: visibility is part of the question, and
    // findUnique takes only a unique key.
    const ticket = await client.ticket.findFirst({
      where: { id, ...this.visibleTo(requester) },
      include: TICKET_PEOPLE,
    });

    if (!ticket) {
      throw new NotFoundException(`No ticket ${id}`);
    }

    return ticket;
  }

  /**
   * The optimistic concurrency chokepoint. Every mutation goes through here.
   *
   * `updateMany` and not `update`, and that is forced rather than chosen:
   * `update` requires a unique `where`, and `{ id, version }` is not unique. A
   * count of zero means the row moved between the read and the write.
   *
   * The read and the write share one interactive transaction so that the 404
   * and the 409 stay distinguishable. Without the read, a caller could not tell
   * "this ticket is not yours" from "somebody just changed it", and the client
   * would have no way to know whether reloading is worth trying.
   */
  private async mutate(
    id: string,
    version: number,
    requester: AuthenticatedUser,
    // `Unchecked` and not `TicketUpdateManyMutationInput`: the checked variant
    // hides the relation scalars, and `assigneeId` and `closedById` are exactly
    // what two of the three mutations need to set. The variant also exposes
    // `tenantId`, which sounds like a hole and is not: the extension throws
    // CrossTenantWriteError on any update whose data mentions it.
    change: (
      tx: ExtendedTransactionClient,
      current: TicketWithPeople,
    ) => Promise<Prisma.TicketUncheckedUpdateManyInput>,
  ): Promise<TicketResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.load(tx, id, requester);
      const data = await change(tx, current);

      const { count } = await tx.ticket.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });

      if (count === 0) {
        throw new ConflictException(
          `This ticket was changed by someone else (it is now at version ` +
            `${current.version}). Reload it and reapply your change.`,
        );
      }

      return toTicketResponse(
        await tx.ticket.findUniqueOrThrow({
          where: { id },
          include: TICKET_PEOPLE,
        }),
      );
    });
  }

  /**
   * What the caller is allowed to see, as a `where` fragment.
   *
   * An empty object for staff, so it composes with any other filter without a
   * branch at the call site.
   */
  private visibleTo(requester: AuthenticatedUser): Prisma.TicketWhereInput {
    return seesEveryTicket(requester.role) ? {} : { requesterId: requester.id };
  }

  /**
   * A closed ticket is a record. Nothing about it changes, which is also why
   * `CLOSED` has no outgoing transition.
   */
  private assertOpenForEditing(ticket: TicketWithPeople): void {
    if (ticket.status === TicketStatus.CLOSED) {
      throw new ConflictException(
        'This ticket is closed and cannot be changed. Open a new one that references it.',
      );
    }
  }

  /**
   * A ticket is worked by staff, so only staff can hold one.
   *
   * The lookup carries no tenant filter, so a user of another company is simply
   * not found — the assignee cannot be smuggled in from outside even before the
   * composite foreign key gets a chance to refuse it.
   */
  private async assertAssignable(
    tx: ExtendedTransactionClient,
    assigneeId: string,
  ): Promise<void> {
    const assignee = await tx.user.findFirst({
      where: { id: assigneeId, deletedAt: null },
    });

    if (!assignee) {
      throw new NotFoundException(`No user ${assigneeId}`);
    }

    if (assignee.role !== UserRole.AGENT && assignee.role !== UserRole.ADMIN) {
      throw new ConflictException(
        `${assignee.email} is a ${assignee.role} and cannot be assigned a ticket. ` +
          'Only an AGENT or an ADMIN works tickets.',
      );
    }
  }
}
