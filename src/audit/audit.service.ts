import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Prisma } from '../generated/prisma/client';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { TicketsService } from '../tickets/tickets.service';
import { AuditResponse, AUDIT_ACTOR, toAuditResponse } from './audit-response';
import { TicketEvent, STAFF_ONLY_ACTIONS } from '../events/ticket-events';
import { handlesInternalNotes } from '../comments/internal-notes';
import { QueryAuditDto } from './dto/query-audit.dto';

export type PaginatedAudit = {
  data: AuditResponse[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * Writes and reads the trail.
 *
 * `record()` is called only by `AuditListener`, never by a domain service —
 * that is the coupling the Observer exists to remove, and the reason this class
 * is not exported to any feature module.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tickets: TicketsService,
  ) {}

  /**
   * Appends one entry. Expects a tenant scope to be open already — the listener
   * opens it from the event payload.
   */
  async record(event: TicketEvent): Promise<void> {
    await this.prisma.auditLog.create({
      data: tenantScoped({
        userId: event.actorId,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        // `Prisma.DbNull` and not `null`: for a nullable Json column Prisma
        // distinguishes a JSON `null` *value* from a SQL NULL, and a bare null
        // is ambiguous enough that it refuses it. DbNull is "no row value".
        //
        // The cast is the one place this file bends. `Record<string, unknown>`
        // is structurally a JSON object, but `InputJsonValue` is a recursive
        // type TypeScript cannot see that through. Everything the domain puts
        // in these payloads is a string, a number, a boolean or null, which is
        // what makes the cast true rather than merely convenient.
        oldValues: asJson(event.oldValues),
        newValues: asJson(event.newValues),
      }),
    });
  }

  /**
   * One ticket's history.
   *
   * The ticket is resolved first, so a ticket the caller cannot see 404s before
   * any entry is read — the timeline cannot become a side channel onto tickets
   * the list route hides.
   *
   * It carries the ticket's own entries only. A comment shows up here as a
   * `commented` action on the ticket, which is why comments are recorded
   * against the aggregate rather than against themselves; the comment *bodies*
   * come from `GET /tickets/:id/comments`, and the client interleaves the two.
   */
  async timeline(
    ticketId: string,
    query: QueryAuditDto,
    reader: AuthenticatedUser,
  ): Promise<PaginatedAudit> {
    const ticket = await this.tickets.requireTicket(ticketId, reader);

    const where: Prisma.AuditLogWhereInput = {
      entityId: ticket.id,
      ...(query.action ? { action: query.action } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      // Last, so it wins. A plain column comparison rather than a JSONB path
      // query, which is the whole reason `internal_note_added` is its own
      // action instead of a flag inside `newValues`.
      ...(handlesInternalNotes(reader.role)
        ? {}
        : { action: { notIn: [...STAFF_ONLY_ACTIONS] } }),
    };

    return this.page(where, query, 'asc');
  }

  /** The company-wide feed. ADMIN only, enforced by the controller. */
  async findAll(query: QueryAuditDto): Promise<PaginatedAudit> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };

    return this.page(where, query, 'desc');
  }

  private async page(
    where: Prisma.AuditLogWhereInput,
    query: QueryAuditDto,
    direction: 'asc' | 'desc',
  ): Promise<PaginatedAudit> {
    const [total, entries] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: AUDIT_ACTOR,
        // A timeline reads forwards and a feed reads backwards; the id breaks
        // ties either way so that two entries written in the same millisecond
        // keep their order across pages.
        orderBy: [{ createdAt: direction }, { id: direction }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
    ]);

    return {
      data: entries.map(toAuditResponse),
      meta: {
        total,
        page: query.page,
        perPage: query.perPage,
        totalPages: Math.ceil(total / query.perPage) || 1,
      },
    };
  }
}

function asJson(
  values: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return values === null || values === undefined
    ? Prisma.DbNull
    : (values as Prisma.InputJsonObject);
}
