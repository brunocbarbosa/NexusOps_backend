import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditService } from '../../src/audit/audit.service';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import { CommentsModule } from '../../src/comments/comments.module';
import { CommentsService } from '../../src/comments/comments.service';
import { validateEnv } from '../../src/config/env.validation';
import { TicketStatus, UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import { currentScope } from '../../src/tenancy/tenant-context';
import {
  fakeScope,
  runWithTenant,
  runWithoutTenant,
  useScope,
} from '../utils/tenant-scope';
import { TenantScopeService } from '../../src/tenancy/tenant-scope.service';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';
import { TicketsModule } from '../../src/tickets/tickets.module';
import { TicketsService } from '../../src/tickets/tickets.service';

/**
 * The reactive audit trail, end to end, plus the measurement it is designed
 * around.
 *
 * `AuditListener` opens its own tenant scope from the event payload instead of
 * inheriting the request's. The first describe below is what justifies that
 * choice with a number rather than a hunch: the inherited scope *does* survive,
 * and the design deliberately does not use it.
 */
describe('audit trail', () => {
  /**
   * What `@nestjs/event-emitter` does to the AsyncLocalStorage scope.
   *
   * Measured with a bare EventEmitter2 rather than through the application, so
   * the answer is about the library and not about our wiring.
   */
  describe('the tenant scope across an emit', () => {
    // Its own scope, and a fake one: this describe measures what the emitter
    // does to AsyncLocalStorage, which needs no database at all. The real
    // service arrives in the next describe's beforeAll, which runs later.
    useScope(fakeScope());

    it('survives a synchronous listener', async () => {
      const emitter = new EventEmitter2({ wildcard: true });
      let seen: ReturnType<typeof currentScope> | undefined;

      emitter.on('probe.sync', () => {
        seen = currentScope();
      });

      await runWithTenant('tenant-probe', () => {
        emitter.emit('probe.sync', {});
        return Promise.resolve();
      });

      // `emit` dispatches on the caller's stack, so the listener runs inside
      // the scope. This is exactly the fact the audit listener refuses to lean
      // on: it is a property of the emitter's dispatch strategy, not a decision
      // this repository made, and a future `emitAsync` or a queued dispatcher
      // would take it away silently.
      expect(seen).toEqual({ kind: 'tenant', tenantId: 'tenant-probe' });
    });

    it('survives an async listener across its first await', async () => {
      const emitter = new EventEmitter2({ wildcard: true });
      let seen: ReturnType<typeof currentScope> | undefined;
      let done: Promise<void> | undefined;

      emitter.on('probe.async', () => {
        done = (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          seen = currentScope();
        })();
      });

      await runWithTenant('tenant-probe', () => {
        emitter.emit('probe.async', {});
        return Promise.resolve();
      });
      await done;

      // AsyncLocalStorage propagates through the continuation, so even this
      // holds. It still is not something to build on.
      expect(seen).toEqual({ kind: 'tenant', tenantId: 'tenant-probe' });
    });
  });

  describe('through the application', () => {
    let mod: TestingModule;
    let tickets: TicketsService;
    let comments: CommentsService;
    let audit: AuditService;
    let prisma: ExtendedPrismaClient;
    let emitter: EventEmitter2;

    const run = randomUUID().slice(0, 8);
    const domains: string[] = [];
    let tenantA: string;
    let tenantB: string;
    let agentA: AuthenticatedUser;
    let adminA: AuthenticatedUser;
    let requesterA: AuthenticatedUser;
    let requesterB: AuthenticatedUser;

    const seed = async (label: string) => {
      const domain = `audit-${label}-${run}.example`;
      domains.push(domain);

      const tenant = await runWithoutTenant(() =>
        prisma.tenant.create({ data: { name: `Audit ${label}`, domain } }),
      );

      return runWithTenant(tenant.id, async () => {
        await prisma.ticketCounter.create({ data: tenantScoped({}) });

        const agent = await prisma.user.create({
          data: tenantScoped({
            email: `agent@${label}.example`,
            passwordHash: 'x',
            role: UserRole.AGENT,
          }),
        });
        const requester = await prisma.user.create({
          data: tenantScoped({
            email: `req@${label}.example`,
            passwordHash: 'x',
            role: UserRole.REQUESTER,
          }),
        });
        const admin = await prisma.user.create({
          data: tenantScoped({
            email: `admin@${label}.example`,
            passwordHash: 'x',
            role: UserRole.ADMIN,
          }),
        });

        return { tenantId: tenant.id, agent, requester, admin };
      });
    };

    /**
     * The listener runs after the emitting call has already returned, so the
     * row is not there the instant a mutation resolves. Polling rather than a
     * fixed sleep: a sleep is either flaky or slow, and usually both.
     */
    const eventually = async <T>(
      read: () => Promise<T[]>,
      atLeast: number,
    ): Promise<T[]> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const rows = await read();
        if (rows.length >= atLeast) return rows;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No ${atLeast} audit rows after 500ms`);
    };

    const entriesFor = (tenantId: string, entityId: string) =>
      runWithTenant(tenantId, () =>
        prisma.auditLog.findMany({
          where: { entityId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );

    /**
     * A ticket the agent can act on: opened by the requester, handed over by
     * the admin.
     *
     * An agent reaches nothing it is not assigned to, so a test that has one
     * change a status or write an internal note has to set that up. It costs a
     * second trail entry — `assigned` — which is why the counts below are not
     * the ones this file started with.
     */
    const openAssigned = async (title: string) => {
      const ticket = await runWithTenant(tenantA, () =>
        tickets.create({ title }, requesterA),
      );

      return runWithTenant(tenantA, () =>
        tickets.assign(
          ticket.id,
          { version: ticket.version, assigneeId: agentA.id },
          adminA,
        ),
      );
    };

    beforeAll(async () => {
      mod = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
          EventEmitterModule.forRoot({ wildcard: true }),
          TicketsModule,
          CommentsModule,
          AuditModule,
        ],
      }).compile();
      useScope(mod.get(TenantScopeService));
      await mod.init();

      tickets = mod.get(TicketsService);
      comments = mod.get(CommentsService);
      audit = mod.get(AuditService);
      prisma = mod.get<ExtendedPrismaClient>(PRISMA);
      emitter = mod.get(EventEmitter2);

      const a = await seed('a');
      const b = await seed('b');
      tenantA = a.tenantId;
      tenantB = b.tenantId;
      agentA = {
        id: a.agent.id,
        tenantId: tenantA,
        email: a.agent.email,
        role: UserRole.AGENT,
      };
      adminA = {
        id: a.admin.id,
        tenantId: tenantA,
        email: a.admin.email,
        role: UserRole.ADMIN,
      };
      requesterA = {
        id: a.requester.id,
        tenantId: tenantA,
        email: a.requester.email,
        role: UserRole.REQUESTER,
      };
      requesterB = {
        id: b.requester.id,
        tenantId: tenantB,
        email: b.requester.email,
        role: UserRole.REQUESTER,
      };
    });

    afterAll(async () => {
      await runWithoutTenant(() =>
        prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
      );
      await mod.close();
    });

    it('has exactly one listener on the ticket namespace', () => {
      // If wildcard were off, this would be zero and every assertion below
      // would fail for a reason that looks like a database problem.
      expect(emitter.listeners('ticket.created')).toHaveLength(1);
    });

    it('records a ticket the service never told it about', async () => {
      const ticket = await runWithTenant(tenantA, () =>
        tickets.create({ title: 'audited' }, requesterA),
      );

      const [entry] = await eventually(() => entriesFor(tenantA, ticket.id), 1);

      expect(entry.action).toBe('created');
      expect(entry.entityType).toBe('Ticket');
      expect(entry.userId).toBe(requesterA.id);
      expect(entry.tenantId).toBe(tenantA);
      expect(entry.newValues).toMatchObject({ title: 'audited' });
    });

    it('records a status change with both sides of it', async () => {
      const ticket = await openAssigned('moving');
      await runWithTenant(tenantA, () =>
        tickets.changeStatus(
          ticket.id,
          { version: ticket.version, status: TicketStatus.IN_PROGRESS },
          agentA,
        ),
      );

      const entries = await eventually(() => entriesFor(tenantA, ticket.id), 3);
      const change = entries.find((e) => e.action === 'status_changed');

      expect(change?.oldValues).toEqual({ status: 'OPEN' });
      expect(change?.newValues).toEqual({ status: 'IN_PROGRESS' });
      expect(change?.userId).toBe(agentA.id);
    });

    it('records a comment against the ticket, with its own action for a note', async () => {
      const ticket = await openAssigned('discussed');
      await runWithTenant(tenantA, () =>
        comments.create(ticket.id, { body: 'public' }, requesterA),
      );
      await runWithTenant(tenantA, () =>
        comments.create(
          ticket.id,
          { body: 'private', isInternal: true },
          agentA,
        ),
      );

      const entries = await eventually(() => entriesFor(tenantA, ticket.id), 4);
      const actions = entries.map((e) => e.action);

      expect(actions).toContain('commented');
      expect(actions).toContain('internal_note_added');
    });

    it('writes nothing when the mutation was refused', async () => {
      const ticket = await runWithTenant(tenantA, () =>
        tickets.create({ title: 'refused' }, requesterA),
      );
      await eventually(() => entriesFor(tenantA, ticket.id), 1);

      await expect(
        runWithTenant(tenantA, () =>
          tickets.changeStatus(
            ticket.id,
            { version: 999, status: TicketStatus.RESOLVED },
            agentA,
          ),
        ),
      ).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 50));
      const entries = await entriesFor(tenantA, ticket.id);

      // Only the creation. Emitting inside the transaction would have recorded
      // a status change that never committed.
      expect(entries).toHaveLength(1);
    });

    it('keeps one company trail out of another', async () => {
      const ticket = await runWithTenant(tenantB, () =>
        tickets.create({ title: 'B only' }, requesterB),
      );
      await eventually(() => entriesFor(tenantB, ticket.id), 1);

      // Same entityId, asked from the wrong tenant. The extension filters it.
      const fromA = await entriesFor(tenantA, ticket.id);
      expect(fromA).toHaveLength(0);
    });

    describe('the timeline route', () => {
      const query = { page: 1, perPage: 50 };

      it('hides the internal note from the requester, count included', async () => {
        const ticket = await openAssigned('timeline');
        await runWithTenant(tenantA, () =>
          comments.create(
            ticket.id,
            { body: 'internal', isInternal: true },
            agentA,
          ),
        );
        await eventually(() => entriesFor(tenantA, ticket.id), 3);

        const staffView = await runWithTenant(tenantA, () =>
          audit.timeline(ticket.id, query, agentA),
        );
        const customerView = await runWithTenant(tenantA, () =>
          audit.timeline(ticket.id, query, requesterA),
        );

        // created + assigned + internal_note_added, and the customer sees the
        // first two: the difference is the note, which is the whole assertion.
        expect(staffView.meta.total).toBe(3);
        expect(customerView.meta.total).toBe(2);
        expect(
          customerView.data.some((e) => e.action === 'internal_note_added'),
        ).toBe(false);
      });

      it('404s a ticket the caller cannot see', async () => {
        const ticket = await runWithTenant(tenantA, () =>
          tickets.create({ title: 'not yours' }, requesterA),
        );

        await expect(
          runWithTenant(tenantB, () =>
            audit.timeline(ticket.id, query, requesterB),
          ),
        ).rejects.toThrow(/No ticket/);
      });
    });
  });
});
