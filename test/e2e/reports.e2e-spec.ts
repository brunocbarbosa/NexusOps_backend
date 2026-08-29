import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  ReportStatus,
  TicketPriority,
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

type ReportBody = {
  id: string;
  status: ReportStatus;
  filters: unknown;
  rowCount: number | null;
  error: string | null;
  requestedBy: UserBody;
  completedAt: string | null;
};

type PageBody = {
  data: ReportBody[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * The 202-then-download flow over HTTP.
 *
 * This is the pillar MAIN.md describes as "the API answers 202 Accepted and
 * hands the work to a queue". What the tier adds over the integration suite is
 * the status code, the content type and the header — the three things a client
 * actually integrates against.
 */
describe('Reports (e2e)', () => {
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
  });

  let operator: AuthBody;
  let adminA: AuthBody;
  let agentA: AuthBody;
  let requesterA: AuthBody;
  let requesterB: AuthBody;

  const newTenant = async (label: string) => {
    const domain = `reports-${label}-${run}.example`;
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

  /** Polls the status route the way a client without a socket would. */
  const settle = async (
    session: AuthBody,
    reportId: string,
  ): Promise<ReportBody> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const report = bodyOf<ReportBody>(
        await as(session).get(`/reports/${reportId}`).expect(200),
      );
      if (
        report.status === ReportStatus.COMPLETED ||
        report.status === ReportStatus.FAILED
      ) {
        return report;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Report ${reportId} never settled`);
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

    await as(requesterA)
      .post('/tickets')
      .send({ title: 'A urgent one', priority: TicketPriority.URGENT })
      .expect(201);
    await as(requesterB)
      .post('/tickets')
      .send({ title: 'B elsewhere' })
      .expect(201);
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await app.close();
  });

  it('accepts the request with 202 and finishes it in the background', async () => {
    const accepted = bodyOf<ReportBody>(
      await as(agentA).post('/reports/tickets').send({}).expect(202),
    );

    // 202 and not 201: what exists is a request, not a report.
    expect(accepted.status).toBe(ReportStatus.PENDING);
    expect(accepted.rowCount).toBeNull();
    expect(accepted.requestedBy.email).toBe('agent@a.example');
    expect(accepted).not.toHaveProperty('content');
    expect(accepted).not.toHaveProperty('tenantId');

    const settled = await settle(agentA, accepted.id);
    expect(settled.status).toBe(ReportStatus.COMPLETED);
    expect(settled.rowCount).toBe(1);
  });

  it('serves the file as csv with a filename', async () => {
    const accepted = bodyOf<ReportBody>(
      await as(agentA).post('/reports/tickets').send({}).expect(202),
    );
    await settle(agentA, accepted.id);

    const response = await as(agentA)
      .get(`/reports/${accepted.id}/download`)
      .expect(200)
      .expect('Content-Type', /text\/csv/);

    expect(response.headers['content-disposition']).toContain(
      `filename="tickets-${accepted.id}.csv"`,
    );
    expect(response.text).toContain('"number"');
    expect(response.text).toContain('A urgent one');
  });

  it('quotes every cell, so a title with a comma survives', async () => {
    await as(requesterA)
      .post('/tickets')
      .send({ title: 'Printer, scanner and fax are down' })
      .expect(201);

    const accepted = bodyOf<ReportBody>(
      await as(agentA).post('/reports/tickets').send({}).expect(202),
    );
    await settle(agentA, accepted.id);

    const response = await as(agentA)
      .get(`/reports/${accepted.id}/download`)
      .expect(200);

    expect(response.text).toContain('"Printer, scanner and fax are down"');
  });

  it('gives a requester only their own rows', async () => {
    const accepted = bodyOf<ReportBody>(
      await as(requesterA).post('/reports/tickets').send({}).expect(202),
    );
    const settled = await settle(requesterA, accepted.id);

    const response = await as(requesterA)
      .get(`/reports/${accepted.id}/download`)
      .expect(200);

    expect(settled.rowCount).toBeGreaterThan(0);
    expect(response.text).not.toContain('B elsewhere');
  });

  describe('reports are personal', () => {
    it('404s one requested by somebody else in the same company', async () => {
      const accepted = bodyOf<ReportBody>(
        await as(requesterA).post('/reports/tickets').send({}).expect(202),
      );
      await settle(requesterA, accepted.id);

      // The file was built through requesterA's visibility, so handing it over
      // would hand over rows the ticket routes would refuse.
      await as(agentA).get(`/reports/${accepted.id}`).expect(404);
      await as(agentA).get(`/reports/${accepted.id}/download`).expect(404);
    });

    it('404s one of another company', async () => {
      const accepted = bodyOf<ReportBody>(
        await as(agentA).post('/reports/tickets').send({}).expect(202),
      );

      await as(requesterB).get(`/reports/${accepted.id}`).expect(404);
    });

    it('lists only the caller own requests', async () => {
      await as(requesterA).post('/reports/tickets').send({}).expect(202);

      const mine = bodyOf<PageBody>(
        await as(requesterA).get('/reports?perPage=100').expect(200),
      );

      expect(mine.meta.total).toBeGreaterThan(0);
      expect(
        mine.data.every((r) => r.requestedBy.email === 'req@a.example'),
      ).toBe(true);
    });
  });

  it('rejects an anonymous caller', async () => {
    await http().post('/reports/tickets').send({}).expect(401);
  });

  it.each([
    ['a status that is not one', { status: 'PONDERING' }],
    ['an assigneeId that is not a uuid', { assigneeId: 'someone' }],
    ['a page size', { perPage: 10 }],
    ['a tenantId', { tenantId: randomUUID() }],
  ])('rejects %s with 400', async (_label, body) => {
    await as(agentA).post('/reports/tickets').send(body).expect(400);
  });

  it('400s a report id that is not a uuid', async () => {
    await as(agentA).get('/reports/not-a-uuid').expect(400);
  });
});
