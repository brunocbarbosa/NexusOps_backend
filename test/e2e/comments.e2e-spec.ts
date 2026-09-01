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

type TicketBody = { id: string; version: number; status: TicketStatus };

type CommentBody = {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  author: UserBody;
  createdAt: string;
};

type PageBody = {
  data: CommentBody[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The thread inside a ticket, over HTTP.
 *
 * The assertion this suite exists for is the internal note: an agent leaves
 * one, and for the requester it is absent from the page **and** from the total.
 * A total that counted it would announce that something is being hidden, which
 * is most of what hiding it was for.
 */
describe('Comments (e2e)', () => {
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

  const newTenant = async (label: string) => {
    const domain = `comments-${label}-${run}.example`;
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

  it('lets the requester and an agent talk on the same thread', async () => {
    const ticket = await open(requesterA, 'conversation');

    const mine = bodyOf<CommentBody>(
      await as(requesterA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'It is still broken' })
        .expect(201),
    );
    expect(mine.author.email).toBe('req@a.example');
    expect(mine.isInternal).toBe(false);
    expect(mine).not.toHaveProperty('tenantId');

    await as(agentA)
      .post(`/tickets/${ticket.id}/comments`)
      .send({ body: 'Looking into it' })
      .expect(201);

    const thread = bodyOf<PageBody>(
      await as(requesterA).get(`/tickets/${ticket.id}/comments`).expect(200),
    );
    expect(thread.meta.total).toBe(2);
    // Oldest first: a thread is read from the top down.
    expect(thread.data[0].body).toBe('It is still broken');
  });

  describe('the internal note', () => {
    it('is invisible to the requester, in the page and in the total', async () => {
      const ticket = await open(requesterA, 'with a note');

      await as(requesterA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'public question' })
        .expect(201);
      await as(agentA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'escalate to networking', isInternal: true })
        .expect(201);

      const staffView = bodyOf<PageBody>(
        await as(agentA).get(`/tickets/${ticket.id}/comments`).expect(200),
      );
      const customerView = bodyOf<PageBody>(
        await as(requesterA).get(`/tickets/${ticket.id}/comments`).expect(200),
      );

      expect(staffView.meta.total).toBe(2);
      expect(staffView.data.some((c) => c.isInternal)).toBe(true);

      expect(customerView.meta.total).toBe(1);
      expect(customerView.data.every((c) => !c.isInternal)).toBe(true);
      expect(
        customerView.data.some((c) => c.body === 'escalate to networking'),
      ).toBe(false);
    });

    it('is refused to a requester with 403', async () => {
      const ticket = await open(requesterA, 'no notes for you');

      // 403 and not 404: the ticket is theirs and they can see it. What is
      // missing is the role, and saying so leaks nothing they did not know.
      await as(requesterA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'sneaky', isInternal: true })
        .expect(403);
    });

    it('is allowed to an admin', async () => {
      const ticket = await open(requesterA, 'admin note');

      await as(adminA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'admin sees all', isInternal: true })
        .expect(201);
    });
  });

  describe('the parent ticket decides access', () => {
    it('404s another requester of the same company', async () => {
      const ticket = await open(requesterA, 'private thread');

      await as(otherRequesterA)
        .get(`/tickets/${ticket.id}/comments`)
        .expect(404);
      await as(otherRequesterA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'butting in' })
        .expect(404);
    });

    it('404s another company', async () => {
      const ticket = await open(requesterA, 'company A thread');

      await as(requesterB).get(`/tickets/${ticket.id}/comments`).expect(404);
      await as(requesterB)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'from elsewhere' })
        .expect(404);
    });

    it('404s a ticket that does not exist', async () => {
      await as(agentA).get(`/tickets/${randomUUID()}/comments`).expect(404);
    });

    it('400s a ticket id that is not a uuid', async () => {
      await as(agentA).get('/tickets/not-a-uuid/comments').expect(400);
    });
  });

  describe('a closed ticket', () => {
    const close = async (ticket: TicketBody) => {
      let current = ticket;
      for (const status of [
        TicketStatus.RESOLVED,
        TicketStatus.CLOSED,
      ] as const) {
        current = bodyOf<TicketBody>(
          await as(agentA)
            .patch(`/tickets/${current.id}/status`)
            .send({ version: current.version, status })
            .expect(200),
        );
      }
      return current;
    };

    it('takes no new comments', async () => {
      const ticket = await close(await open(requesterA, 'to be closed'));

      await as(agentA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'one more thing' })
        .expect(409);
    });

    it('stays readable', async () => {
      const opened = await open(requesterA, 'closed but readable');
      await as(agentA)
        .post(`/tickets/${opened.id}/comments`)
        .send({ body: 'said before closing' })
        .expect(201);
      const ticket = await close(opened);

      // Frozen, not hidden.
      const thread = bodyOf<PageBody>(
        await as(requesterA).get(`/tickets/${ticket.id}/comments`).expect(200),
      );
      expect(thread.meta.total).toBe(1);
    });
  });

  it.each([
    ['an empty body', { body: '' }],
    ['no body at all', {}],
    ['an isInternal that is not a boolean', { body: 'ok', isInternal: 'yes' }],
    ['an authorId', { body: 'ok', authorId: randomUUID() }],
    ['a ticketId', { body: 'ok', ticketId: randomUUID() }],
    ['a tenantId', { body: 'ok', tenantId: randomUUID() }],
  ])('rejects %s with 400', async (_label, body) => {
    const ticket = await open(requesterA, 'validation');

    await as(requesterA)
      .post(`/tickets/${ticket.id}/comments`)
      .send(body)
      .expect(400);
  });

  it('is append-only: no update and no delete', async () => {
    const ticket = await open(requesterA, 'append only');
    const posted = bodyOf<CommentBody>(
      await as(requesterA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'said once' })
        .expect(201),
    );

    await as(adminA)
      .patch(`/tickets/${ticket.id}/comments/${posted.id}`)
      .send({ body: 'rewritten' })
      .expect(404);
    await as(adminA)
      .delete(`/tickets/${ticket.id}/comments/${posted.id}`)
      .expect(404);
  });
});
