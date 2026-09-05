import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { TicketStatus, UserRole } from '../../src/generated/prisma/enums';
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

type TicketBody = { id: string; version: number };

type AuditBody = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  oldValues: unknown;
  newValues: unknown;
  user: UserBody | null;
  createdAt: string;
};

type PageBody = {
  data: AuditBody[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The trail over HTTP.
 *
 * Nothing in this suite asks the application to write an audit entry — it opens
 * tickets and comments on them, and the entries appear. That is the Observer
 * doing its job, and it is the assertion worth making at this tier.
 */
describe('Audit (e2e)', () => {
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
  });

  let operator: AuthBody;
  let adminA: AuthBody;
  let agentA: AuthBody;
  let requesterA: AuthBody;
  let requesterB: AuthBody;

  const newTenant = async (label: string) => {
    const domain = `audit-${label}-${run}.example`;
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

  const open = async (session: AuthBody, title: string): Promise<TicketBody> =>
    bodyOf<TicketBody>(
      await as(session).post('/tickets').send({ title }).expect(201),
    );

  /** The listener writes after the response goes out, so read until it lands. */
  const timeline = async (
    session: AuthBody,
    ticketId: string,
    atLeast: number,
  ): Promise<PageBody> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const page = bodyOf<PageBody>(
        await as(session)
          .get(`/tickets/${ticketId}/timeline?perPage=50`)
          .expect(200),
      );
      if (page.meta.total >= atLeast) return page;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timeline never reached ${atLeast} entries`);
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

  it('builds a timeline nobody asked it to build', async () => {
    const ticket = await open(requesterA, 'the whole story');

    // The admin hands it over: assignment is an ADMIN route, and it is also
    // what lets the agent do anything at all with this ticket below.
    const assigned = bodyOf<TicketBody>(
      await as(adminA)
        .patch(`/tickets/${ticket.id}/assignee`)
        .send({ version: ticket.version, assigneeId: agentA.user.id })
        .expect(200),
    );
    await as(agentA)
      .patch(`/tickets/${assigned.id}/status`)
      .send({ version: assigned.version, status: TicketStatus.IN_PROGRESS })
      .expect(200);
    await as(requesterA)
      .post(`/tickets/${ticket.id}/comments`)
      .send({ body: 'any news' })
      .expect(201);

    const page = await timeline(agentA, ticket.id, 4);
    const actions = page.data.map((e) => e.action);

    // Oldest first, and the create is the first thing that happened.
    expect(actions[0]).toBe('created');
    expect(actions).toEqual(
      expect.arrayContaining(['assigned', 'status_changed', 'commented']),
    );
    expect(page.data[0].user?.email).toBe('req@a.example');
    expect(page.data[0]).not.toHaveProperty('tenantId');
  });

  it('hides the internal note from the requester, count included', async () => {
    const opened = await open(requesterA, 'with a note');
    const ticket = bodyOf<TicketBody>(
      await as(adminA)
        .patch(`/tickets/${opened.id}/assignee`)
        .send({ version: opened.version, assigneeId: agentA.user.id })
        .expect(200),
    );
    await as(agentA)
      .post(`/tickets/${ticket.id}/comments`)
      .send({ body: 'escalating', isInternal: true })
      .expect(201);

    const staffView = await timeline(agentA, ticket.id, 3);
    const customerView = await timeline(requesterA, ticket.id, 2);

    // created + assigned + internal_note_added, and the customer sees the
    // first two: the difference is the note, which is the whole assertion.
    expect(staffView.meta.total).toBe(3);
    expect(customerView.meta.total).toBe(2);
    expect(
      customerView.data.some((e) => e.action === 'internal_note_added'),
    ).toBe(false);
  });

  it('404s the timeline of a ticket the caller cannot see', async () => {
    const ticket = await open(requesterA, 'company A only');

    await as(requesterB).get(`/tickets/${ticket.id}/timeline`).expect(404);
    // The same 404 for a colleague nobody assigned it to as for a stranger in
    // another company — which is the rule at its sharpest.
    await as(agentA).get(`/tickets/${ticket.id}/timeline`).expect(404);
  });

  describe('the company feed', () => {
    it('is ADMIN only', async () => {
      await as(adminA).get('/audit').expect(200);
      await as(agentA).get('/audit').expect(403);
      await as(requesterA).get('/audit').expect(403);
    });

    it('spans tickets and filters by action', async () => {
      const ticket = await open(requesterA, 'in the feed');
      // Waited for as the admin: nobody has been assigned this ticket, so the
      // agent cannot read its timeline to wait on it.
      await timeline(adminA, ticket.id, 1);

      const page = bodyOf<PageBody>(
        await as(adminA).get('/audit?action=created&perPage=100').expect(200),
      );

      expect(page.data.every((e) => e.action === 'created')).toBe(true);
      expect(page.data.some((e) => e.entityId === ticket.id)).toBe(true);
    });

    it('never shows one company another company entries', async () => {
      const theirs = await open(requesterB, 'company B');
      await timeline(requesterB, theirs.id, 1);

      const page = bodyOf<PageBody>(
        await as(adminA).get('/audit?perPage=100').expect(200),
      );

      expect(page.data.some((e) => e.entityId === theirs.id)).toBe(false);
    });

    it.each([
      ['an action that is not one', 'action=exploded'],
      ['an entityId that is not a uuid', 'entityId=nope'],
      ['an unknown parameter', 'entityType=Ticket'],
    ])('rejects %s with 400', async (_label, qs) => {
      await as(adminA).get(`/audit?${qs}`).expect(400);
    });
  });
});
