import { Inject, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/authenticated-user';
import { REPORT_EVENTS, REPORT_EVENT_PATTERN } from '../events/report-events';
import type { ReportEvent } from '../events/report-events';
import {
  STAFF_ONLY_ACTIONS,
  TICKET_EVENT_PATTERN,
} from '../events/ticket-events';
import type { TicketEvent } from '../events/ticket-events';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant } from '../tenancy/tenant-context';
import { adminRoom, joinsAdminRoom, userRoom } from './rooms';

/**
 * Pushes what just happened to the people entitled to hear it.
 *
 * It listens to the same `EventEmitter2` stream the audit trail does and knows
 * nothing about `TicketsService` or `ReportsProcessor` — and neither knows
 * about it. Adding a notification is subscribing; it is never a line inside a
 * domain method.
 *
 * **A gateway has no HTTP request**, so nothing here inherits a tenant scope,
 * exactly as in a BullMQ worker. The handshake opens one by hand to look the
 * user up; the event handlers need none, because routing to a room is string
 * work and never touches the database.
 */
@WebSocketGateway({
  // The browser connects from another origin in every deployment of this
  // project, and socket.io refuses cross-origin by default.
  cors: { origin: true, credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  private readonly server: Server;

  constructor(
    private readonly jwt: JwtService,
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
  ) {}

  /**
   * Authenticates the handshake and puts the socket in its rooms.
   *
   * The token arrives in `handshake.auth.token` rather than in a header,
   * because the browser `WebSocket` API cannot set one and socket.io's `auth`
   * field is the supported way through.
   *
   * **The role comes from the database, not from the token**, for the same
   * reason `JwtStrategy` re-reads it on every request: a socket outlives an
   * access token's fifteen minutes by hours, so an admin demoted — or
   * deactivated — after connecting would otherwise sit in the admin room for
   * as long as they keep the tab open.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as unknown;

    if (typeof token !== 'string' || token.length === 0) {
      return this.reject(client, 'no token');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      // Deliberately no detail: an expired token and a forged one get the same
      // answer, and the client's move is the same either way — refresh, retry.
      return this.reject(client, 'invalid token');
    }

    const user = await runWithTenant(payload.tenantId, () =>
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
    );

    if (!user || user.deletedAt !== null) {
      return this.reject(client, 'unknown or deactivated user');
    }

    await client.join(userRoom(user.id));
    if (joinsAdminRoom(user.role)) {
      await client.join(adminRoom(user.tenantId));
    }

    client.emit('ready', { userId: user.id, role: user.role });
  }

  /**
   * A ticket moved.
   *
   * The company's admins hear about every ticket, in one room. An agent is not
   * in that room any more and is addressed personally, because it is the
   * *ticket* that entitles it to the event and not the role. On a reassignment
   * that is two people: the agent it reached, and the agent it left — who needs
   * the event precisely so its queue can drop the row. That one event describes
   * a ticket the agent can no longer read over HTTP, and it is the deliberate
   * exception: it says something is leaving, not something they did not already
   * know.
   *
   * One `emit` over a list of rooms rather than one call per room, because
   * socket.io de-duplicates within a call and not across two: whoever is both
   * an admin and the requester used to receive this twice.
   *
   * The internal note is the one thing held back from the requester, through
   * the same `STAFF_ONLY_ACTIONS` the timeline filters on — so the socket and
   * the timeline cannot come to disagree about what a customer may learn.
   */
  @OnEvent(TICKET_EVENT_PATTERN)
  onTicketEvent(event: TicketEvent): void {
    const message = {
      ticketId: event.entityId,
      action: event.action,
      actorId: event.actorId,
      oldValues: event.oldValues ?? null,
      newValues: event.newValues ?? null,
    };

    const rooms = [
      adminRoom(event.tenantId),
      ...event.assigneeIds.map(userRoom),
    ];

    if (!STAFF_ONLY_ACTIONS.includes(event.action)) {
      rooms.push(userRoom(event.requesterId));
    }

    this.server.to(rooms).emit('ticket.changed', message);
  }

  /**
   * An export finished. Addressed to one person, never to a room of staff: a
   * report is built through its requester's own visibility, so its very
   * existence is theirs.
   */
  @OnEvent(REPORT_EVENT_PATTERN)
  onReportEvent(event: ReportEvent): void {
    this.server
      .to(userRoom(event.requestedById))
      .emit(
        event.error === null ? REPORT_EVENTS.Completed : REPORT_EVENTS.Failed,
        {
          reportId: event.reportId,
          rowCount: event.rowCount,
          error: event.error,
        },
      );
  }

  private reject(client: Socket, reason: string): void {
    this.logger.debug(`Refusing socket ${client.id}: ${reason}`);
    client.emit('unauthorized', { message: reason });
    client.disconnect(true);
  }
}
