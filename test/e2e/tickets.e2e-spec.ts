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
    it('hides a requester ticket from another requester in the same company', async () => {
      const ticket = await open(requesterA, { title: 'private' });

      await as(otherRequesterA).get(`/tickets/${ticket.id}`).expect(404);
      await as(agentA).get(`/tickets/${ticket.id}`).expect(200);
      await as(adminA).get(`/tickets/${ticket.id}`).expect(200);
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

    it('lists only their own to a requester and all of them to staff', async () => {
      await open(requesterA, { title: 'mine one' });
      await open(otherRequesterA, { title: 'theirs one' });

      const mine = bodyOf<PageBody>(
        await as(requesterA).get('/tickets?perPage=100').expect(200),
      );
      const all = bodyOf<PageBody>(
        await as(agentA).get('/tickets?perPage=100').expect(200),
      );

      expect(
        mine.data.every((t) => t.requester.email === 'req@a.example'),
      ).toBe(true);
      expect(all.meta.total).toBeGreaterThan(mine.meta.total);
    });

    it('gives a requester their own tickets even when they ask for someone else', async () => {
      const page = bodyOf<PageBody>(
        await as(requesterA)
          .get(`/tickets?perPage=100&requesterId=${otherRequesterA.user.id}`)
          .expect(200),
      );

      expect(
        page.data.every((t) => t.requester.email === 'req@a.example'),
      ).toBe(true);
    });
  });

  describe('optimistic concurrency', () => {
    it('refuses the second writer at the same version with 409', async () => {
      const ticket = await open(requesterA, { title: 'contended' });

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
      const ticket = await open(requesterA, { title: 'no version' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}`)
        .send({ title: 'sneaky' })
        .expect(400);
    });

    it('hands back the new version to retry with', async () => {
      const ticket = await open(requesterA, { title: 'retry' });

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
      let ticket = await open(requesterA, { title: 'lifecycle' });

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
      const ticket = await open(requesterA, { title: 'no shortcut' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}/status`)
        .send({ version: ticket.version, status: TicketStatus.CLOSED })
        .expect(409);
    });

    it('leaves a closed ticket alone', async () => {
      let ticket = await open(requesterA, { title: 'frozen' });
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
      let ticket = await open(requesterA, { title: 'reopened' });

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
      const ticket = await open(requesterA, { title: 'not mine to resolve' });

      // 403 and not 404 here: the ticket is theirs and they can see it. What
      // they lack is the role, and RolesGuard says so before the service runs.
      await as(requesterA)
        .patch(`/tickets/${ticket.id}/status`)
        .send({ version: ticket.version, status: TicketStatus.RESOLVED })
        .expect(403);
    });
  });

  describe('assignment', () => {
    it('assigns to an agent and unassigns with an explicit null', async () => {
      const ticket = await open(requesterA, { title: 'to be worked' });

      const assigned = bodyOf<TicketBody>(
        await as(agentA)
          .patch(`/tickets/${ticket.id}/assignee`)
          .send({ version: ticket.version, assigneeId: agentA.user.id })
          .expect(200),
      );
      expect(assigned.assignee?.email).toBe('agent@a.example');

      const cleared = bodyOf<TicketBody>(
        await as(agentA)
          .patch(`/tickets/${ticket.id}/assignee`)
          .send({ version: assigned.version, assigneeId: null })
          .expect(200),
      );
      expect(cleared.assignee).toBeNull();
    });

    it('refuses a requester as assignee with 409', async () => {
      const ticket = await open(requesterA, { title: 'wrong assignee' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}/assignee`)
        .send({ version: ticket.version, assigneeId: requesterA.user.id })
        .expect(409);
    });

    it('rejects a missing assigneeId rather than treating it as unassign', async () => {
      const ticket = await open(requesterA, { title: 'omitted' });

      await as(agentA)
        .patch(`/tickets/${ticket.id}/assignee`)
        .send({ version: ticket.version })
        .expect(400);
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
