/**
 * The events a ticket change emits, and the contract its listeners read.
 *
 * This lives in `src/events/` rather than inside `src/audit/` because it has
 * two consumers now — the audit trail and the notification gateway — and
 * neither depends on the other. Leaving it in the audit module would make
 * `src/realtime/` import from `src/audit/`, which reads as a dependency that
 * does not exist.
 *
 * Business logic never calls `AuditService`. It emits, and something else
 * decides what that is worth recording — the Observer the CLAUDE.md
 * architecture section calls for. The point is not indirection for its own
 * sake: it is that `TicketsService` has no import of the audit module, so
 * forgetting to log is not a thing a future method can do, and the WebSocket
 * gateway in a later phase subscribes to this same stream without either side
 * knowing about the other.
 *
 * **Everything the listener needs is in the payload, `tenantId` included.**
 * `@nestjs/event-emitter` dispatches synchronously, so the `AsyncLocalStorage`
 * scope of the request does in fact survive into a listener — measured, see
 * HELPDESK.md Part II. Relying on that would tie the audit trail to the
 * emitter's dispatch strategy, which is a dependency's implementation detail
 * rather than a decision this repository made. Carrying the tenant explicitly
 * is also exactly the shape a BullMQ worker needs, so there is one rule for
 * "code that runs outside a request" instead of two.
 */

/** The aggregate an entry is about. A comment is a change *to a ticket*. */
export const AUDIT_ENTITIES = { Ticket: 'Ticket' } as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];

/**
 * What happened. Stored in `audit_logs.action`, a `varchar(50)`.
 *
 * `internal_note_added` is a separate action from `commented` rather than a
 * flag inside `newValues`, and that is the load-bearing bit: it lets a
 * requester's timeline be filtered with a plain column comparison instead of a
 * JSONB path query. A filter nobody can read is a filter nobody will maintain.
 */
export const AUDIT_ACTIONS = {
  Created: 'created',
  Updated: 'updated',
  StatusChanged: 'status_changed',
  Assigned: 'assigned',
  Commented: 'commented',
  InternalNoteAdded: 'internal_note_added',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Actions a `REQUESTER` must never see on their own ticket's timeline. */
export const STAFF_ONLY_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.InternalNoteAdded,
];

export type TicketEvent = {
  tenantId: string;
  /** Who did it. Null only for something the system did on its own. */
  actorId: string | null;
  /**
   * Who opened the ticket.
   *
   * Carried for the notification gateway rather than for the trail, which
   * never reads it: staff hear about every ticket in the company, and the
   * requester is the one person outside staff who should hear about this one.
   * Looking it up in the gateway instead would mean a database read per event,
   * on a listener that has no request scope to read it in.
   */
  requesterId: string;
  entityType: AuditEntity;
  entityId: string;
  action: AuditAction;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
};

/**
 * The emitter name for an event. `ticket.status_changed`, and so on.
 *
 * A helper rather than string literals at the call sites, so that the listener's
 * `ticket.*` pattern and the names actually emitted cannot drift apart.
 */
export function auditEventName(
  entityType: AuditEntity,
  action: AuditAction,
): string {
  return `${entityType.toLowerCase()}.${action}`;
}

/** What the listeners subscribe to. Requires `wildcard: true` on the module. */
export const TICKET_EVENT_PATTERN = 'ticket.*';
