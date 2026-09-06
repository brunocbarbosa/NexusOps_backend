import { JwtService } from '@nestjs/jwt';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../events/ticket-events';
import type { TicketEvent } from '../events/ticket-events';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { NotificationsGateway } from './notifications.gateway';

const TENANT = 'tenant-a';

const event = (over: Partial<TicketEvent> = {}): TicketEvent => ({
  tenantId: TENANT,
  actorId: 'actor-1',
  requesterId: 'requester-1',
  assigneeIds: [],
  entityType: AUDIT_ENTITIES.Ticket,
  entityId: 'ticket-1',
  action: AUDIT_ACTIONS.Updated,
  oldValues: null,
  newValues: null,
  ...over,
});

/**
 * The fan-out, which is where an agent's access boundary now lives.
 *
 * The HTTP side answers 404 to a ticket that is not the agent's; a gateway that
 * kept broadcasting to a room holding every agent would hand it over anyway,
 * over a socket, with no controller involved to refuse it — and not one HTTP
 * test would fail. This is the cheapest tier that can say so.
 */
describe('NotificationsGateway fan-out', () => {
  let emit: jest.Mock;
  let to: jest.Mock;
  let gateway: NotificationsGateway;

  /** The room list of the single `to()` call the handler is allowed to make. */
  const roomsUsed = (): string[] => {
    expect(to).toHaveBeenCalledTimes(1);
    const [rooms] = to.mock.calls[0] as [string[]];
    return rooms;
  };

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });

    gateway = new NotificationsGateway(
      {} as unknown as JwtService,
      {} as unknown as ExtendedPrismaClient,
    );
    Object.defineProperty(gateway, 'server', { value: { to } });
  });

  it('always tells the company admins', () => {
    gateway.onTicketEvent(event());

    expect(roomsUsed()).toContain(`tenant:${TENANT}:admins`);
  });

  it('tells the requester', () => {
    gateway.onTicketEvent(event());

    expect(roomsUsed()).toContain('user:requester-1');
  });

  it('tells the agent the ticket is assigned to', () => {
    gateway.onTicketEvent(event({ assigneeIds: ['agent-1'] }));

    expect(roomsUsed()).toContain('user:agent-1');
  });

  // The agent that lost the ticket needs this one event, and only this one: it
  // is what tells its queue to drop the row. It describes a ticket the agent
  // can no longer read over HTTP, which is the deliberate exception.
  it('tells both sides of a reassignment', () => {
    gateway.onTicketEvent(
      event({
        action: AUDIT_ACTIONS.Assigned,
        assigneeIds: ['agent-before', 'agent-after'],
      }),
    );

    expect(roomsUsed()).toEqual(
      expect.arrayContaining(['user:agent-before', 'user:agent-after']),
    );
  });

  it('adds no room for a ticket nobody is working', () => {
    gateway.onTicketEvent(event({ assigneeIds: [] }));

    expect(roomsUsed()).toEqual([
      `tenant:${TENANT}:admins`,
      'user:requester-1',
    ]);
  });

  // The whole point of `internal_note_added` being its own action: the customer
  // never learns the note exists, over HTTP or over the socket.
  it('keeps the internal note from the requester and gives it to the assignee', () => {
    gateway.onTicketEvent(
      event({
        action: AUDIT_ACTIONS.InternalNoteAdded,
        assigneeIds: ['agent-1'],
      }),
    );

    const rooms = roomsUsed();
    expect(rooms).not.toContain('user:requester-1');
    expect(rooms).toContain('user:agent-1');
    expect(rooms).toContain(`tenant:${TENANT}:admins`);
  });

  // socket.io de-duplicates the sockets across the rooms of one `to()` call and
  // not across two, so somebody who is two of these at once used to hear the
  // same change twice.
  it('emits once, over the whole list of rooms', () => {
    gateway.onTicketEvent(event({ assigneeIds: ['agent-1'] }));

    expect(to).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('ticket.changed', {
      ticketId: 'ticket-1',
      action: AUDIT_ACTIONS.Updated,
      actorId: 'actor-1',
      oldValues: null,
      newValues: null,
    });
  });
});
