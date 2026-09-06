import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  TicketPriority,
  TicketStatus,
  UserRole,
} from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import { runWithoutTenant } from '../../src/tenancy/tenant-context';
import { createTestApp } from '../utils/create-test-app';
import {
  FIXTURE_PASSWORD,
  loginAs,
  loginAsAdminMaster,
  newCompanySession,
} from '../utils/platform-session';
import type { AuthBody, UserBody } from '../utils/platform-session';
import { bodyOf } from '../utils/response-body';

type TicketBody = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  category: string;
  version: number;
  requester: UserBody;
  assignee: UserBody | null;
  closedBy: UserBody | null;
  resolvedAt: string | null;
  closedAt: string | null;
};

type PageBody = {
  data: TicketBody[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The helpdesk over HTTP, with two companies and three roles in each.
 *
 * What this tier adds over the integration one is everything between the socket
 * and the service: the global `JwtAuthGuard`, `RolesGuard`, the
 * `TenantContextInterceptor` that opens the tenant scope from the token, and
 * the `ValidationPipe` whose options the DTOs are written against. All of it
 * comes from the real `configureApp()`, so a 400 asserted here is the 400 the
 * application ships.
 */
describe('Tickets (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  const http = () => request(app.getHttpServer());

  const as = (session: { accessToken: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${session.accessToken}`),
    post: (url: string) =>
      http().post(url).set('Authorization', `Bearer ${session.accessToken}`),
    patch: (url: string) =>
      http().patch(url).set('Authorization', `Bearer ${session.accessToken}`),
    delete: (url: string) =>
      http().delete(url).set('Authorization', `Bearer ${session.accessToken}`),
  });

  let operator: AuthBody;
  let adminA: AuthBody;
  let agentA: AuthBody;
  let requesterA: AuthBody;
  let otherRequesterA: AuthBody;
  let requesterB: AuthBody;

  /** Creates a company and returns its ADMIN session, the real way. */
  const newTenant = async (label: string) => {
    const domain = `tickets-${label}-${run}.example`;
    domains.push(domain);
    const admin = await newCompanySession(app, operator, {
      name: `${label} Co`,
      domain,
      email: `admin@${label}.example`,
    });
    return { admin, domain };
  };

  const addUser = async (
    admin: AuthBody,
    domain: string,
    email: string,
    role: UserRole,
  ): Promise<AuthBody> => {
    await as(admin)
      .post('/users')
      .send({ email, password: FIXTURE_PASSWORD, role })
      .expect(201);
    return loginAs(app, domain, email);
  };

  const open = async (
    session: AuthBody,
    body: Record<string, unknown> = {},
  ): Promise<TicketBody> => {
    const response = await as(session)
      .post('/tickets')
      .send({ title: 'Printer is on fire', ...body })
      .expect(201);
    return bodyOf<TicketBody>(response);
  };

  /**
   * Hands a ticket to somebody, as the admin — the only role that can.
   *
   * Used all over this file for a reason that is the point of the slice: an
   * agent reaches nothing it is not assigned to, so a test that has one work a
   * ticket has to be given one first.
   */
  const assign = async (
    ticket: TicketBody,
    to: AuthBody | null,
  ): Promise<TicketBody> => {
    const response = await as(adminA)
      .patch(`/tickets/${ticket.id}/assignee`)
      .send({
        version: ticket.version,
        assigneeId: to === null ? null : to.user.id,
      })
      .expect(200);
    return bodyOf<TicketBody>(response);
  };

  /** Opened by the requester and handed to the agent, in one step. */
  const openAssigned = async (
    body: Record<string, unknown> = {},
  ): Promise<TicketBody> => assign(await open(requesterA, body), agentA);

  beforeAll(async () => {
    app = (await createTestApp()) as INestApplication<App>;
    prisma = app.get<ExtendedPrismaClient>(PRISMA);
    operator = await loginAsAdminMaster(app);

    const a = await newTenant('a');
    adminA = a.admin;
    agentA = await addUser(adminA, a.domain, 'agent@a.example', UserRole.AGENT);
    requesterA = await addUser(
      adminA,
      a.domain,
      'req@a.example',
      UserRole.REQUESTER,
    );
    otherRequesterA = await addUser(
      adminA,
      a.domain,
      'other@a.example',
      UserRole.REQUESTER,
    );

    const b = await newTenant('b');
    requesterB = await addUser(
      b.admin,
      b.domain,
      'req@b.example',
      UserRole.REQUESTER,
    );
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await app.close();
  });

  describe('opening a ticket', () => {
    it('numbers it and makes the caller the requester', async () => {
      const ticket = await open(requesterA, { title: 'First of the day' });

      expect(ticket.number).toBeGreaterThan(0);
      expect(ticket.requester.email).toBe('req@a.example');
      expect(ticket.status).toBe(TicketStatus.OPEN);
      expect(ticket.priority).toBe(TicketPriority.MEDIUM);
      expect(ticket.assignee).toBeNull();
      expect(ticket.version).toBe(1);
    });

    it('never puts tenantId on the wire', async () => {
      const ticket = await open(requesterA);

      expect(ticket).not.toHaveProperty('tenantId');
      expect(ticket.requester).not.toHaveProperty('tenantId');
    });

    it('rejects an anonymous caller', async () => {
      await http().post('/tickets').send({ title: 'anonymous' }).expect(401);
    });

    // The role that *works* tickets is not the role that *opens* them. It is
    // also a way around the visibility rule if left open: the author of a
    // ticket sees it, so an agent could have opened its way to one.
    it('refuses an agent with 403', async () => {
      await as(agentA)
        .post('/tickets')
        .send({ title: 'not the agent job' })
        .expect(403);
    });

    // 403 replaces a 500 here. The operator's reserved tenant has no
    // ticket_counters row, so before the guard existed this route reached the
    // service and threw on data that was never meant to be there.
    it('refuses the platform operator with 403', async () => {
      await as(operator)
        .post('/tickets')
        .send({ title: 'not the operator job' })
        .expect(403);
    });

    it('still lets an admin open one', async () => {
      const ticket = await open(adminA, { title: 'opened by the admin' });

      expect(ticket.requester.email).toBe('admin@a.example');
    });

    it.each([
      ['a title that is too short', { title: 'no' }],
      ['no title at all', {}],
      ['a priority that is not one', { title: 'ok', priority: 'WHENEVER' }],
      ['a tenantId', { title: 'ok', tenantId: randomUUID() }],
      ['a requesterId', { title: 'ok', requesterId: randomUUID() }],
      ['a number of its own', { title: 'ok', number: 999 }],
    ])('rejects %s with 400', async (_label, body) => {
      await as(requesterA).post('/tickets').send(body).expect(400);
    });
  });

  describe('visibility', () => {
    it('shows a ticket to its requester and the admin, and to nobody else', async () => {
      const ticket = await open(requesterA, { title: 'private' });

      await as(otherRequesterA).get(`/tickets/${ticket.id}`).expect(404);
      // The agent gets the same 404 as a stranger while nobody has handed the
      // ticket to them. Being staff is no longer the question.
      await as(agentA).get(`/tickets/${ticket.id}`).expect(404);
      await as(adminA).get(`/tickets/${ticket.id}`).expect(200);
    });

    it('opens a ticket to an agent the moment it is assigned, and closes it again', async () => {
      const ticket = await open(requesterA, { title: 'handed over' });

      await as(agentA).get(`/tickets/${ticket.id}`).expect(404);

      const assigned = await assign(ticket, agentA);
      await as(agentA).get(`/tickets/${ticket.id}`).expect(200);

      await assign(assigned, null);
      await as(agentA).get(`/tickets/${ticket.id}`).expect(404);
    });

    it('answers 404 and not 403 across companies', async () => {
      const ticket = await open(requesterA, { title: 'company A only' });

      // 403 would confirm the id exists somewhere, which is a fact about
      // another company's data.
      await as(requesterB).get(`/tickets/${ticket.id}`).expect(404);
      await as(requesterB)
        .patch(`/tickets/${ticket.id}`)
        .send({ version: 1, title: 'hijack' })
        .expect(404);
    });

    it('lists only their own to a requester and all of them to the admin', async () => {
      await open(requesterA, { title: 'mine one' });
      await open(otherRequesterA, { title: 'theirs one' });

      const mine = bodyOf<PageBody>(
        await as(requesterA).get('/tickets?perPage=100').expect(200),
      );
      const all = bodyOf<PageBody>(
        await as(adminA).get('/tickets?perPage=100').expect(200),
      );

      expect(
        mine.data.every((t) => t.requester.email === 'req@a.example'),
      ).toBe(true);
      expect(all.meta.total).toBeGreaterThan(mine.meta.total);
    });

    it('lists an agent only the tickets assigned to them', async () => {
      const ticket = await open(requesterA, { title: 'agent queue' });
      await open(otherRequesterA, { title: 'not the agent queue' });
      await assign(ticket, agentA);

      const queue = bodyOf<PageBody>(
        await as(agentA).get('/tickets?perPage=100').expect(200),
      );

      expect(queue.data.map((t) => t.id)).toContain(ticket.id);
      // The total is scoped too, not only the page: a count that included
      // invisible rows would announce that they exist.
      expect(queue.meta.total).toBe(queue.data.length);
      expect(
        queue.data.every((t) => t.assignee?.email === 'agent@a.example'),
      ).toBe(true);
    });

    // The filter is intersected with the caller's scope rather than losing to
    // it. An empty page is the honest answer: the filter was obeyed, and the
    // scope leaves it matching nothing.
    it('gives a requester nothing when they ask for somebody else tickets', async () => {
      const page = bodyOf<PageBody>(
        await as(requesterA)
          .get(`/tickets?perPage=100&requesterId=${otherRequesterA.user.id}`)
          .expect(200),
      );

      expect(page.data).toHaveLength(0);
      expect(page.meta.total).toBe(0);
    });

    it('lets an agent narrow their own queue by requester', async () => {
      const mine = await open(requesterA, { title: 'from req A' });
      const theirs = await open(otherRequesterA, { title: 'from other A' });
      await assign(mine, agentA);
      await assign(theirs, agentA);

      const page = bodyOf<PageBody>(
        await as(agentA)
          .get(`/tickets?perPage=100&requesterId=${requesterA.user.id}`)
          .expect(200),
      );

      expect(page.data.map((t) => t.id)).toContain(mine.id);
      expect(page.data.map((t) => t.id)).not.toContain(theirs.id);
    });
  });

  describe('optimistic concurrency', () => {
    it('refuses the second writer at the same version with 409', async () => {
      const ticket = await openAssigned({ title: 'contended' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}`)
        .send({ version: ticket.version, title: 'first wins' })
        .expect(200);

      await as(agentA)
        .patch(`/tickets/${ticket.id}`)
        .send({ version: ticket.version, title: 'second loses' })
        .expect(409);
    });

    it('requires the version', async () => {
      const ticket = await openAssigned({ title: 'no version' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}`)
        .send({ title: 'sneaky' })
        .expect(400);
    });

    it('hands back the new version to retry with', async () => {
      const ticket = await openAssigned({ title: 'retry' });

      const updated = bodyOf<TicketBody>(
        await as(agentA)
          .patch(`/tickets/${ticket.id}`)
          .send({ version: ticket.version, title: 'once' })
          .expect(200),
      );

      expect(updated.version).toBe(ticket.version + 1);

      await as(agentA)
        .patch(`/tickets/${ticket.id}`)
        .send({ version: updated.version, title: 'twice' })
        .expect(200);
    });
  });

  describe('the lifecycle', () => {
    it('walks OPEN to IN_PROGRESS to RESOLVED to CLOSED', async () => {
      let ticket = await openAssigned({ title: 'lifecycle' });

      for (const status of [
        TicketStatus.IN_PROGRESS,
        TicketStatus.RESOLVED,
        TicketStatus.CLOSED,
      ]) {
        ticket = bodyOf<TicketBody>(
          await as(agentA)
            .patch(`/tickets/${ticket.id}/status`)
            .send({ version: ticket.version, status })
            .expect(200),
        );
        expect(ticket.status).toBe(status);
      }

      expect(ticket.resolvedAt).not.toBeNull();
      expect(ticket.closedAt).not.toBeNull();
      expect(ticket.closedBy?.email).toBe('agent@a.example');
    });

    it('refuses to skip from OPEN to CLOSED', async () => {
      const ticket = await openAssigned({ title: 'no shortcut' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}/status`)
        .send({ version: ticket.version, status: TicketStatus.CLOSED })
        .expect(409);
    });

    it('leaves a closed ticket alone', async () => {
      let ticket = await openAssigned({ title: 'frozen' });
      for (const status of [
        TicketStatus.RESOLVED,
        TicketStatus.CLOSED,
      ] as const) {
        ticket = bodyOf<TicketBody>(
          await as(agentA)
            .patch(`/tickets/${ticket.id}/status`)
            .send({ version: ticket.version, status })
            .expect(200),
        );
      }

      // Terminal in both directions: no edit, and no way back out.
      await as(agentA)
        .patch(`/tickets/${ticket.id}`)
        .send({ version: ticket.version, title: 'after the fact' })
        .expect(409);
      await as(agentA)
        .patch(`/tickets/${ticket.id}/status`)
        .send({ version: ticket.version, status: TicketStatus.OPEN })
        .expect(409);
    });

    it('clears resolvedAt when a resolved ticket is reopened', async () => {
      let ticket = await openAssigned({ title: 'reopened' });

      ticket = bodyOf<TicketBody>(
        await as(agentA)
          .patch(`/tickets/${ticket.id}/status`)
          .send({ version: ticket.version, status: TicketStatus.RESOLVED })
          .expect(200),
      );
      expect(ticket.resolvedAt).not.toBeNull();

      ticket = bodyOf<TicketBody>(
        await as(agentA)
          .patch(`/tickets/${ticket.id}/status`)
          .send({ version: ticket.version, status: TicketStatus.OPEN })
          .expect(200),
      );
      expect(ticket.resolvedAt).toBeNull();
    });

    it('refuses a requester the status route', async () => {
      const ticket = await openAssigned({ title: 'not mine to resolve' });

      // 403 and not 404 here: the ticket is theirs and they can see it. What
      // they lack is the role, and RolesGuard says so before the service runs.
      await as(requesterA)
        .patch(`/tickets/${ticket.id}/status`)
        .send({ version: ticket.version, status: TicketStatus.RESOLVED })
        .expect(403);
    });
  });

  // The actor is the admin throughout: assignment is an ADMIN route now, and
  // an agent asking for one of these gets a 403 from the guard before the
  // handler runs — which would make these tests pass for the wrong reason.
  describe('assignment', () => {
    it('assigns to an agent and unassigns with an explicit null', async () => {
      const ticket = await open(requesterA, { title: 'to be worked' });

      const assigned = bodyOf<TicketBody>(
        await as(adminA)
          .patch(`/tickets/${ticket.id}/assignee`)
          .send({ version: ticket.version, assigneeId: agentA.user.id })
          .expect(200),
      );
      expect(assigned.assignee?.email).toBe('agent@a.example');

      const cleared = bodyOf<TicketBody>(
        await as(adminA)
          .patch(`/tickets/${ticket.id}/assignee`)
          .send({ version: assigned.version, assigneeId: null })
          .expect(200),
      );
      expect(cleared.assignee).toBeNull();
    });

    it('refuses a requester as assignee with 409', async () => {
      const ticket = await open(requesterA, { title: 'wrong assignee' });

      await as(adminA)
        .patch(`/tickets/${ticket.id}/assignee`)
        .send({ version: ticket.version, assigneeId: requesterA.user.id })
        .expect(409);
    });

    it('rejects a missing assigneeId rather than treating it as unassign', async () => {
      const ticket = await open(requesterA, { title: 'omitted' });

      await as(adminA)
        .patch(`/tickets/${ticket.id}/assignee`)
        .send({ version: ticket.version })
        .expect(400);
    });

    it('refuses an agent the assignment route with 403', async () => {
      const ticket = await open(requesterA, { title: 'not the agent call' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}/assignee`)
        .send({ version: ticket.version, assigneeId: agentA.user.id })
        .expect(403);

      // Not even to drop one that is already theirs: an agent leaving a ticket
      // would erase it from the only queue that shows it.
      const mine = await assign(ticket, agentA);
      await as(agentA)
        .patch(`/tickets/${mine.id}/assignee`)
        .send({ version: mine.version, assigneeId: null })
        .expect(403);
    });

    // Documented rather than special-cased: the filter intersects with the
    // caller's scope, and `assigneeId: null` cannot also be the agent, so what
    // is left is the tickets they opened that nobody picked up.
    it('gives an agent asking for the unassigned queue only their own', async () => {
      await open(requesterA, { title: 'nobody has this one' });

      const page = bodyOf<PageBody>(
        await as(agentA)
          .get('/tickets?unassigned=true&perPage=100')
          .expect(200),
      );

      expect(page.data.every((t) => t.assignee === null)).toBe(true);
      expect(
        page.data.every((t) => t.requester.email === 'agent@a.example'),
      ).toBe(true);
    });

    it('filters by unassigned, and refuses the contradiction', async () => {
      await as(agentA).get('/tickets?unassigned=true').expect(200);
      await as(agentA)
        .get(`/tickets?unassigned=true&assigneeId=${agentA.user.id}`)
        .expect(400);
    });
  });

  it('answers 400 rather than 500 for an id that is not a uuid', async () => {
    await as(requesterA).get('/tickets/not-a-uuid').expect(400);
  });

  it('has no delete route', async () => {
    const ticket = await open(requesterA, { title: 'permanent' });

    await as(adminA).delete(`/tickets/${ticket.id}`).expect(404);
  });
});
