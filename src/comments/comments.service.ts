import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DomainEvents } from '../tenancy/domain-events';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  auditEventName,
} from '../events/ticket-events';
import type { TicketEvent } from '../events/ticket-events';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Prisma } from '../generated/prisma/client';
import { TicketStatus } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { TicketsService } from '../tickets/tickets.service';
import {
  COMMENT_AUTHOR,
  CommentResponse,
  toCommentResponse,
} from './comment-response';
import { CreateCommentDto } from './dto/create-comment.dto';
import { QueryCommentsDto } from './dto/query-comments.dto';
import { handlesInternalNotes } from './internal-notes';

export type PaginatedComments = {
  data: CommentResponse[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The conversation inside a ticket.
 *
 * Two things shape every method here.
 *
 * **The parent is resolved first, through `TicketsService.requireTicket()`.**
 * That is the whole access-control story: a ticket the caller cannot see 404s
 * before a comment is read or written, so this service never repeats the
 * visibility rule and cannot drift from it. It is the shape
 * `CompanyUsersController` uses for nested resources, applied one level down.
 *
 * **Comments are append-only.** There is no update and no delete, in the
 * service or on the controller. The thread is what the audit trail renders as a
 * timeline, and a timeline whose entries can be rewritten is not one.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tickets: TicketsService,
    private readonly events: DomainEvents,
  ) {}

  async create(
    ticketId: string,
    dto: CreateCommentDto,
    author: AuthenticatedUser,
  ): Promise<CommentResponse> {
    const ticket = await this.tickets.requireTicket(ticketId, author);

    if (ticket.status === TicketStatus.CLOSED) {
      throw new ConflictException(
        'This ticket is closed and cannot take new comments. Open a new one that references it.',
      );
    }

    // 403 and not 404: the ticket is visible and the request is understood.
    // What is missing is the role, and saying so is not a leak — the caller
    // already knows the ticket exists.
    if (dto.isInternal === true && !handlesInternalNotes(author.role)) {
      throw new ForbiddenException(
        'Only an ADMIN or an AGENT can leave an internal note',
      );
    }

    const comment = await this.prisma.comment.create({
      data: tenantScoped({
        ticketId: ticket.id,
        authorId: author.id,
        body: dto.body,
        isInternal: dto.isInternal ?? false,
      }),
      include: COMMENT_AUTHOR,
    });

    // Recorded against the **ticket**, not against the comment: the ticket is
    // the aggregate, and a timeline that had to chase a second entity to find
    // out somebody replied would not be a timeline. `internal_note_added` is a
    // distinct action rather than a flag in the payload so that hiding it from
    // a requester stays a plain column comparison.
    const event: TicketEvent = {
      tenantId: author.tenantId,
      actorId: author.id,
      requesterId: ticket.requesterId,
      // A comment changes no assignment, so there is one side to name and it
      // is already in hand: `requireTicket()` returned the row.
      assigneeIds: ticket.assigneeId === null ? [] : [ticket.assigneeId],
      entityType: AUDIT_ENTITIES.Ticket,
      entityId: ticket.id,
      action: comment.isInternal
        ? AUDIT_ACTIONS.InternalNoteAdded
        : AUDIT_ACTIONS.Commented,
      newValues: { commentId: comment.id },
    };
    this.events.emit(
      auditEventName(AUDIT_ENTITIES.Ticket, event.action),
      event,
    );

    return toCommentResponse(comment);
  }

  async findAll(
    ticketId: string,
    query: QueryCommentsDto,
    reader: AuthenticatedUser,
  ): Promise<PaginatedComments> {
    const ticket = await this.tickets.requireTicket(ticketId, reader);

    const where: Prisma.CommentWhereInput = {
      ticketId: ticket.id,
      // Applied to the count as well as to the page, because it is the same
      // `where`. A total that counted rows the caller cannot see would announce
      // that something is being hidden, which is most of what hiding it was for.
      ...(handlesInternalNotes(reader.role) ? {} : { isInternal: false }),
    };

    const [total, comments] = await this.prisma.$transaction([
      this.prisma.comment.count({ where }),
      this.prisma.comment.findMany({
        where,
        include: COMMENT_AUTHOR,
        // Oldest first: a thread is read from the top down, unlike the ticket
        // list. The id breaks ties so two comments posted in the same
        // millisecond keep their order across pages.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
    ]);

    return {
      data: comments.map(toCommentResponse),
      meta: {
        total,
        page: query.page,
        perPage: query.perPage,
        totalPages: Math.ceil(total / query.perPage) || 1,
      },
    };
  }
}
