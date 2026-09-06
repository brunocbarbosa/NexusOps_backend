import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AuditAction,
  TicketEvent,
  auditEventName,
} from '../events/ticket-events';
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
import { seesEveryTicket, ticketsInvolving } from './ticket-visibility';

/**
 * Who a change concerns, besides the company's admins.
 *
 * `assignees` takes both sides of the mutation — before and after — because
 * only a reassignment has two, and asking every caller to work out which case
 * it is in would be a branch per action. `emit()` drops the nulls and the
 * duplicate.
 */
type Audience = {
  requesterId: string;
  assignees: readonly (string | null)[];
};

/** What a mutation reports to the trail, built after the write has committed. */
type AuditChange = {
  action: AuditAction;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
};

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
 * **Visibility is intersected, not applied last.** `visibleTo()` contributes an
 * `AND` rather than overwriting a key of the caller's, because the scope is an
 * `OR` over two columns and there is no single key left to overwrite. A
 * `REQUESTER` passing `?requesterId=<someone else>` therefore gets an empty
 * page rather than their own tickets — the answer is honest instead of merely
 * safe, and narrowing is the only thing a filter can do.
 *
 * **Every mutation goes through `mutate()`.** It is the one place the version
 * check lives, and a second copy of it would be a second place for a
 * last-write-wins bug to appear.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly events: EventEmitter2,
  ) {}

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

    const response = toTicketResponse(ticket);
    // Always unassigned: `POST /tickets` takes no assigneeId, so a new ticket
    // reaches nobody's queue until an admin puts it there.
    this.emit(
      requester,
      response.id,
      { requesterId: response.requester.id, assignees: [] },
      {
        action: AUDIT_ACTIONS.Created,
        oldValues: {},
        newValues: {
          number: response.number,
          title: response.title,
          status: response.status,
          priority: response.priority,
          category: response.category,
        },
      },
    );

    return response;
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
      // Last, and under `AND`: it intersects with what the caller asked for
      // rather than overwriting it, so a filter can only ever narrow the
      // answer. Spreading it here would replace the `OR` that `search` writes
      // four lines up.
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
    return this.mutate(
      id,
      dto.version,
      requester,
      (_tx, current) => {
        this.assertOpenForEditing(current);

        // Undefined fields are left alone by Prisma, which is what makes a
        // partial PATCH work without the service comparing anything.
        return Promise.resolve({
          title: dto.title,
          description: dto.description,
          priority: dto.priority,
          category: dto.category,
        });
      },
      // Only what actually changed. Recording the whole row on every edit would
      // make the trail unreadable and would grow every entry with columns the
      // edit never touched.
      (before, after) => ({
        action: AUDIT_ACTIONS.Updated,
        oldValues: changedFields(before, after, EDITABLE_FIELDS, 'before'),
        newValues: changedFields(before, after, EDITABLE_FIELDS, 'after'),
      }),
    );
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
    return this.mutate(
      id,
      dto.version,
      requester,
      (_tx, current) => {
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
      },
      (before, after) => ({
        action: AUDIT_ACTIONS.StatusChanged,
        oldValues: { status: before.status },
        newValues: { status: after.status },
      }),
    );
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
    return this.mutate(
      id,
      dto.version,
      requester,
      async (tx, current) => {
        this.assertOpenForEditing(current);

        if (dto.assigneeId !== null) {
          await this.assertAssignable(tx, dto.assigneeId);
        }

        return { assigneeId: dto.assigneeId };
      },
      (before, after) => ({
        action: AUDIT_ACTIONS.Assigned,
        oldValues: { assigneeId: before.assigneeId },
        newValues: { assigneeId: after.assignee?.id ?? null },
      }),
    );
  }

  /**
   * Loads a ticket the caller is allowed to see, or 404s.
   *
   * Public because the comment routes hang off a ticket and have to resolve the
   * parent before touching a child — a second implementation of this lookup
   * would be a second place for the visibility rule to drift.
   *
   * Both ways of failing produce the same 404. Another tenant's id is filtered
   * out by the extension; a ticket the caller neither opened nor is working is
   * filtered out by `visibleTo()`. A 403 in either case would confirm that the
   * id exists, which is a fact about somebody else's data.
   *
   * This is also where the new visibility rule reaches everything else without
   * a line of its own: comments, the timeline, the report export and all three
   * mutations resolve their ticket through here.
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
    audit: (before: TicketWithPeople, after: TicketResponse) => AuditChange,
  ): Promise<TicketResponse> {
    const [before, after] = await this.prisma.$transaction(async (tx) => {
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

      const updated = await tx.ticket.findUniqueOrThrow({
        where: { id },
        include: TICKET_PEOPLE,
      });

      return [current, toTicketResponse(updated)] as const;
    });

    // After the transaction, never inside it. An event emitted from within the
    // callback would announce a change that a later statement could still roll
    // back, and the trail would record something that never happened.
    // Both sides of the assignee, every time. `mutate()` already holds `before`
    // and `after`, so the reassignment — the one change that concerns two
    // agents, the one it reached and the one it left — costs no branch of its
    // own, and no future mutation can forget it.
    this.emit(
      requester,
      after.id,
      {
        requesterId: before.requesterId,
        assignees: [before.assigneeId, after.assignee?.id ?? null],
      },
      audit(before, after),
    );

    return after;
  }

  /**
   * The single place this service talks to the outside world about a change.
   *
   * It emits and does not await: listeners are the audit trail and the
   * notification gateway, and neither is allowed to make a request slower or to
   * fail it. `tenantId` rides in the payload because a listener has no promise
   * of inheriting the request's scope — see `audit.events.ts`.
   *
   * The audience is normalised here rather than at the two call sites: the
   * common case names one assignee twice, the reassignment is the only one with
   * two, and neither caller should have to remember to drop the nulls or the
   * duplicate.
   */
  private emit(
    actor: AuthenticatedUser,
    ticketId: string,
    audience: Audience,
    change: AuditChange,
  ): void {
    const event: TicketEvent = {
      tenantId: actor.tenantId,
      actorId: actor.id,
      requesterId: audience.requesterId,
      assigneeIds: [...new Set(audience.assignees.filter((id) => id !== null))],
      entityType: AUDIT_ENTITIES.Ticket,
      entityId: ticketId,
      action: change.action,
      oldValues: change.oldValues,
      newValues: change.newValues,
    };

    this.events.emit(
      auditEventName(AUDIT_ENTITIES.Ticket, change.action),
      event,
    );
  }

  /**
   * What the caller is allowed to see, as a `where` fragment.
   *
   * An empty object for an `ADMIN`, so it composes with any other filter
   * without a branch at the call site.
   *
   * For everybody else it goes under `AND`, and never as a spread of the
   * scope's own keys. That is the part that changed with the rule. The old
   * scope was one column, so writing `requesterId` last physically overwrote
   * whatever the caller had asked for. An `OR` cannot overwrite a column, and
   * spread last it would do something worse: silently replace the `OR` that
   * `search` writes in `findAll`, widening the page instead of narrowing it.
   * `AND` is a key no caller filter uses, so the scope can only ever remove
   * rows.
   *
   * The consequence a client sees is deliberate: a filter is now intersected
   * with the scope rather than losing to it, so `?requesterId=<somebody else>`
   * from a requester answers an empty page instead of quietly answering a
   * different question.
   */
  private visibleTo(requester: AuthenticatedUser): Prisma.TicketWhereInput {
    return seesEveryTicket(requester.role)
      ? {}
      : { AND: [ticketsInvolving(requester.id)] };
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

/** The fields `PATCH /tickets/:id` may touch, and therefore the ones it diffs. */
const EDITABLE_FIELDS = [
  'title',
  'description',
  'priority',
  'category',
] as const;

/**
 * The subset of `fields` whose value actually moved, taken from whichever side
 * is asked for.
 *
 * A partial PATCH sends only some fields, and Prisma leaves the rest alone, so
 * "what the request contained" and "what changed" are different questions. The
 * trail wants the second one: an edit that resubmits the same title unchanged
 * should not show up as a title change.
 */
function changedFields(
  before: TicketWithPeople,
  after: TicketResponse,
  fields: readonly (keyof TicketResponse & keyof TicketWithPeople)[],
  side: 'before' | 'after',
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};

  for (const field of fields) {
    if (before[field] !== after[field]) {
      changed[field] = side === 'before' ? before[field] : after[field];
    }
  }

  return changed;
}
