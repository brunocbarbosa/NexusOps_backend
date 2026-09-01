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
import { TICKET_EVENT_PATTERN } from '../events/ticket-events';
import type { TicketEvent } from '../events/ticket-events';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant } from '../tenancy/tenant-context';
import { joinsStaffRoom, staffRoom, userRoom } from './rooms';

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
   * access token's fifteen minutes by hours, so an agent demoted — or
   * deactivated — after connecting would otherwise sit in the staff room for
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
    if (joinsStaffRoom(user.role)) {
      await client.join(staffRoom(user.tenantId));
    }

    client.emit('ready', { userId: user.id, role: user.role });
  }

  /**
   * A ticket moved.
   *
   * Staff hear about every ticket in their company; the requester hears about
   * their own. socket.io de-duplicates across rooms, so an agent who opened the
   * ticket themselves still receives it once.
   *
   * The internal note is the one thing held back: it is emitted only to staff,
   * because the whole point of `internal_note_added` being a separate action is
   * that the customer never learns the note exists.
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

    this.server.to(staffRoom(event.tenantId)).emit('ticket.changed', message);

    if (event.action !== 'internal_note_added') {
      this.server
        .to(userRoom(event.requesterId))
        .emit('ticket.changed', message);
    }
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
