import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
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
import type { AuthBody } from '../utils/platform-session';
import { bodyOf } from '../utils/response-body';

type TicketBody = { id: string; version: number };
type ReportBody = { id: string };
type TicketMessage = { ticketId: string; action: string };

/**
 * The notification gateway, against a real socket.io client.
 *
 * The assertion this suite exists for is the negative one: **the visibility
 * rule that the HTTP phase established has to hold over the socket too.**
 * Broadcasting every change to a per-tenant room would hand a `REQUESTER`
 * somebody else's ticket without a controller being involved to refuse it, and
 * nothing in the HTTP suites would notice.
 */
describe('Realtime (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ExtendedPrismaClient;
  let url: string;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  const sockets: Socket[] = [];
  const http = () => request(app.getHttpServer());

  const as = (session: { accessToken: string }) => ({
    get: (u: string) =>
      http().get(u).set('Authorization', `Bearer ${session.accessToken}`),
    post: (u: string) =>
      http().post(u).set('Authorization', `Bearer ${session.accessToken}`),
    patch: (u: string) =>
      http().patch(u).set('Authorization', `Bearer ${session.accessToken}`),
  });

  let operator: AuthBody;
  let adminA: AuthBody;
  let domainA: string;
  let agentA: AuthBody;
  let requesterA: AuthBody;
  let otherRequesterA: AuthBody;
  let requesterB: AuthBody;

  /** Connects and resolves once the gateway has confirmed the handshake. */
  const connect = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(url, {
        auth: { token },
        transports: ['websocket'],
        // Without this a refused handshake retries forever, and the retry timer
        // keeps the event loop alive after the suite has finished — which Jest
        // reports as "did not exit one second after the test run completed".
        reconnection: false,
      });
      sockets.push(socket);

      // Cleared on every exit, for the same reason: an unfired timer is an
      // open handle.
      const timer = setTimeout(
        () => reject(new Error('handshake timed out')),
        3000,
      );
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };

      socket.on('ready', () => settle(() => resolve(socket)));
      socket.on('unauthorized', (payload: { message: string }) =>
        settle(() => reject(new Error(payload.message))),
      );
      socket.on('connect_error', (error: Error) => settle(() => reject(error)));
    });

  /** Collects everything a socket hears on `event` for `ms`. */
  const collect = <T>(socket: Socket, event: string, ms = 250): Promise<T[]> =>
    new Promise((resolve) => {
      const heard: T[] = [];
      const listener = (payload: T) => heard.push(payload);
      socket.on(event, listener);
      setTimeout(() => {
        socket.off(event, listener);
        resolve(heard);
      }, ms);
    });

  const newTenant = async (label: string) => {
    const domain = `realtime-${label}-${run}.example`;
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

  beforeAll(async () => {
    app = (await createTestApp()) as INestApplication<App>;
    // A socket needs a listening server; `createTestApp` only calls init().
    await app.listen(0);
    // `App` is supertest's type and does not declare `address()`; the object
    // underneath is a real node HTTP server.
    const server = app.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    const { port } = server.address();
    url = `http://127.0.0.1:${port}`;

    prisma = app.get<ExtendedPrismaClient>(PRISMA);
    operator = await loginAsAdminMaster(app);

    const a = await newTenant('a');
    adminA = a.admin;
    domainA = a.domain;
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
    for (const socket of sockets) socket.close();

    // This is the only suite that calls `app.listen()`, so it is the only one
    // with keep-alive connections to release: `server.close()` stops accepting
    // new ones but waits on the open ones supertest and socket.io left behind.
    //
    // Run on its own, this file still prints Jest's "did not exit one second
    // after the test run has completed". That was chased rather than assumed:
    // dumping `process._getActiveHandles()` after teardown leaves exactly two
    // Sockets with no address, which are stdout and stderr — Jest pipes them,
    // and a piped stdio stream *is* a net.Socket. There is nothing left to
    // close. The full tier exits clean.
    (
      app.getHttpServer() as unknown as { closeAllConnections(): void }
    ).closeAllConnections();
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await app.close();
  });

  describe('the handshake', () => {
    it('accepts a valid access token', async () => {
      const socket = await connect(agentA.accessToken);

      expect(socket.connected).toBe(true);
    });

    it.each([
      ['no token', ''],
      ['a forged one', 'not.a.jwt'],
    ])('refuses %s', async (_label, token) => {
      await expect(connect(token)).rejects.toThrow();
    });

    it('refuses a refresh token presented as an access token', async () => {
      // Different signing keys, which is the whole reason JWT_SECRET and
      // JWT_REFRESH_SECRET are validated as distinct.
      await expect(connect(agentA.refreshToken)).rejects.toThrow();
    });
  });

  describe('who hears about a ticket', () => {
    it('tells the admins and the requester, and nobody else', async () => {
      const [boss, unassigned, mine, theirs, elsewhere] = await Promise.all([
        connect(adminA.accessToken),
        connect(agentA.accessToken),
        connect(requesterA.accessToken),
        connect(otherRequesterA.accessToken),
        connect(requesterB.accessToken),
      ]);

      const heard = Promise.all([
        collect<TicketMessage>(boss, 'ticket.changed'),
        collect<TicketMessage>(unassigned, 'ticket.changed'),
        collect<TicketMessage>(mine, 'ticket.changed'),
        collect<TicketMessage>(theirs, 'ticket.changed'),
        collect<TicketMessage>(elsewhere, 'ticket.changed'),
      ]);

      const ticket = bodyOf<TicketBody>(
        await as(requesterA)
          .post('/tickets')
          .send({ title: 'broadcast me' })
          .expect(201),
      );

      const [byBoss, byUnassigned, byMine, byTheirs, byElsewhere] = await heard;

      expect(byBoss.map((m) => m.ticketId)).toContain(ticket.id);
      expect(byMine.map((m) => m.ticketId)).toContain(ticket.id);
      // The three that matter, and the first is the new one: an agent nobody
      // has given this ticket to. It used to hear every ticket in the company
      // here, and no HTTP test would ever have said so.
      expect(byUnassigned).toHaveLength(0);
      expect(byTheirs).toHaveLength(0);
      expect(byElsewhere).toHaveLength(0);
    });

    it('starts telling an agent about a ticket the moment it is assigned', async () => {
      const socket = await connect(agentA.accessToken);

      const opened = bodyOf<TicketBody>(
        await as(requesterA)
          .post('/tickets')
          .send({ title: 'handed over on the socket' })
          .expect(201),
      );

      const heard = collect<TicketMessage>(socket, 'ticket.changed');

      const assigned = bodyOf<TicketBody>(
        await as(adminA)
          .patch(`/tickets/${opened.id}/assignee`)
          .send({ version: opened.version, assigneeId: agentA.user.id })
          .expect(200),
      );
      await as(agentA)
        .patch(`/tickets/${assigned.id}/status`)
        .send({ version: assigned.version, status: TicketStatus.IN_PROGRESS })
        .expect(200);

      const messages = await heard;
      expect(messages.map((m) => m.action)).toEqual(
        expect.arrayContaining(['assigned', 'status_changed']),
      );
    });

    it('tells an agent a ticket was taken away from it', async () => {
      const second = await addUser(
        adminA,
        domainA,
        'second-agent@a.example',
        UserRole.AGENT,
      );
      const socket = await connect(agentA.accessToken);

      const opened = bodyOf<TicketBody>(
        await as(requesterA)
          .post('/tickets')
          .send({ title: 'taken away' })
          .expect(201),
      );
      const mine = bodyOf<TicketBody>(
        await as(adminA)
          .patch(`/tickets/${opened.id}/assignee`)
          .send({ version: opened.version, assigneeId: agentA.user.id })
          .expect(200),
      );

      const heard = collect<TicketMessage>(socket, 'ticket.changed');

      await as(adminA)
        .patch(`/tickets/${mine.id}/assignee`)
        .send({ version: mine.version, assigneeId: second.user.id })
        .expect(200);

      // The deliberate exception: this event describes a ticket the agent can
      // no longer read over HTTP, and it exists so its queue drops the row.
      const messages = await heard;
      expect(messages.map((m) => m.action)).toContain('assigned');
      await as(agentA).get(`/tickets/${mine.id}`).expect(404);
    });

    it('keeps the internal note away from the requester', async () => {
      const [staff, mine] = await Promise.all([
        connect(agentA.accessToken),
        connect(requesterA.accessToken),
      ]);

      const opened = bodyOf<TicketBody>(
        await as(requesterA)
          .post('/tickets')
          .send({ title: 'with a note' })
          .expect(201),
      );
      // The agent has to be working the ticket before it can write its note.
      const ticket = bodyOf<TicketBody>(
        await as(adminA)
          .patch(`/tickets/${opened.id}/assignee`)
          .send({ version: opened.version, assigneeId: agentA.user.id })
          .expect(200),
      );

      const heard = Promise.all([
        collect<TicketMessage>(staff, 'ticket.changed'),
        collect<TicketMessage>(mine, 'ticket.changed'),
      ]);

      await as(agentA)
        .post(`/tickets/${ticket.id}/comments`)
        .send({ body: 'escalating', isInternal: true })
        .expect(201);

      const [byStaff, byMine] = await heard;

      expect(byStaff.map((m) => m.action)).toContain('internal_note_added');
      // The point of the separate action: the customer never learns it exists,
      // over HTTP or over the socket.
      expect(byMine.map((m) => m.action)).not.toContain('internal_note_added');
    });

    it('carries the action of a status change', async () => {
      const staff = await connect(agentA.accessToken);
      const opened = bodyOf<TicketBody>(
        await as(requesterA)
          .post('/tickets')
          .send({ title: 'status watch' })
          .expect(201),
      );
      const ticket = bodyOf<TicketBody>(
        await as(adminA)
          .patch(`/tickets/${opened.id}/assignee`)
          .send({ version: opened.version, assigneeId: agentA.user.id })
          .expect(200),
      );

      const heard = collect<TicketMessage>(staff, 'ticket.changed');

      await as(agentA)
        .patch(`/tickets/${ticket.id}/status`)
        .send({ version: ticket.version, status: TicketStatus.IN_PROGRESS })
        .expect(200);

      const messages = await heard;
      expect(messages.map((m) => m.action)).toContain('status_changed');
    });
  });

  describe('the 202 flow', () => {
    it('wakes the requester when the export finishes', async () => {
      const mine = await connect(requesterA.accessToken);

      const done = new Promise<{ reportId: string; rowCount: number }>(
        (resolve, reject) => {
          mine.on('report.completed', resolve);
          setTimeout(() => reject(new Error('no report.completed')), 5000);
        },
      );

      const accepted = bodyOf<ReportBody>(
        await as(requesterA).post('/reports/tickets').send({}).expect(202),
      );

      const message = await done;
      expect(message.reportId).toBe(accepted.id);

      // Emitted after the row is written, so reading it here finds it settled
      // rather than racing the update that caused the notification.
      await as(requesterA)
        .get(`/reports/${accepted.id}/download`)
        .expect(200)
        .expect('Content-Type', /text\/csv/);
    });

    it('tells nobody else about it', async () => {
      const [staff, mine] = await Promise.all([
        connect(agentA.accessToken),
        connect(requesterA.accessToken),
      ]);

      const heard = Promise.all([
        collect(staff, 'report.completed', 1500),
        collect(mine, 'report.completed', 1500),
      ]);

      await as(requesterA).post('/reports/tickets').send({}).expect(202);

      const [byStaff, byMine] = await heard;

      // A report is built through its requester's visibility, so its very
      // existence is addressed to them and not to the company's agents.
      expect(byMine.length).toBeGreaterThan(0);
      expect(byStaff).toHaveLength(0);
    });
  });
});
