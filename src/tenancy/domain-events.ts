import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { tenantStorage } from './tenant-store';

/**
 * Emits domain events **after** the surrounding transaction commits.
 *
 * Settled decision #3 in documents/RLS_DESIGN.md. Once `$transaction` is
 * re-entrant, a mutation no longer commits before it emits — the request's
 * transaction does, later — so an emit that used to happen after a commit now
 * happens inside one. Two things break silently if nothing is done about it:
 *
 *  - `AuditListener.handle` is `async` and `emit` is not awaited, so its write
 *    runs in a later continuation. Prisma invalidates an interactive
 *    transaction client when its callback returns, not when the COMMIT lands,
 *    so the listener would write through a closed `tx` and get `P2028`. Its own
 *    `catch` swallows that and logs "the trail is now behind the data", which
 *    would be the only true sentence in the sequence.
 *  - `NotificationsGateway.onTicketEvent` is synchronous, and clients refetch on
 *    `ticket.changed`. Emitted pre-commit, that wakes a client to read a row
 *    that does not exist yet.
 *
 * So an event raised while a transaction is open is queued on the scope that
 * owns it, and drained after the commit — un-awaited, which is exactly what an
 * emit does today. A rollback discards the queue, which is the behaviour the
 * comment above `TicketsService.mutate()`'s emit has always claimed.
 *
 * The signature matches `EventEmitter2.emit`, so no emit site in `src/` changes
 * shape: the three services that hold an emitter hold this instead.
 */
@Injectable()
export class DomainEvents {
  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Queues when a transaction is open, emits immediately when none is.
   *
   * The immediate path is not a fallback: `ReportsProcessor.announce()` runs
   * between scopes rather than inside one, so it takes it and behaves exactly
   * as it did before this class existed.
   */
  emit(name: string, payload: unknown): void {
    const store = tenantStorage.getStore();

    if (store?.tx) {
      // Queued as a thunk, so the scope releases it without knowing what it is.
      // The queue is shared by reference with every nested scope, so an event
      // raised three scopes deep is still released once, by the owner.
      store.pending.push(() => this.emitter.emit(name, payload));
      return;
    }

    this.emitter.emit(name, payload);
  }
}
