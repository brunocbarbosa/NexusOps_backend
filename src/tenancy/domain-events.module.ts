import { Module } from '@nestjs/common';
import { DomainEvents } from './domain-events';

/**
 * Provides `DomainEvents` to the modules that actually raise events.
 *
 * Deliberately **not** part of `PrismaModule`, even though the queue it feeds
 * lives in the tenant scope. `DomainEvents` needs `EventEmitter2`, which only
 * exists because `AppModule` registers `EventEmitterModule.forRoot()` — so
 * putting it there would make every module that merely touches the database
 * depend on an event emitter, and every integration spec that assembles a
 * partial application would have to register one to build a `UsersModule`.
 *
 * `TenantScopeService` stays free of it because the scope's queue holds thunks
 * rather than events: it releases what was queued without knowing what it is.
 */
@Module({
  providers: [DomainEvents],
  exports: [DomainEvents],
})
export class DomainEventsModule {}
