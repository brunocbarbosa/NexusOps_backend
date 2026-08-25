import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import { runWithoutTenant } from '../../src/tenancy/tenant-context';
import { createTestApp } from '../utils/create-test-app';
import {
  FIXTURE_PASSWORD,
  createCompany,
  loginAsAdminMaster,
  newCompanySession,
} from '../utils/platform-session';
import type { AuthBody } from '../utils/platform-session';

describe('Platform (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ExtendedPrismaClient;
  let operator: AuthBody;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  const http = () => request(app.getHttpServer());

  const as = (session: { accessToken: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${session.accessToken}`),
    post: (url: string) =>
      http().post(url).set('Authorization', `Bearer ${session.accessToken}`),
  });

  /** A fresh company payload. The domain is namespaced so reruns cannot collide. */
  const spec = (label: string) => {
    const domain = `plat-${label}-${run}.example`;
    domains.push(domain);
    return {
      name: `${label} Co`,
      domain,
      email: `admin@${label}.example`,
      password: FIXTURE_PASSWORD,
    };
  };

  beforeAll(async () => {
    app = (await createTestApp()) as INestApplication<App>;
    prisma = app.get<ExtendedPrismaClient>(PRISMA);
    // Logging in as the ADMIN_MASTER is itself the assertion that
    // PlatformBootstrapService seeded it from .env.test when the module booted.
    operator = await loginAsAdminMaster(app);
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await app.close();
  });

  it('signs in the seeded ADMIN_MASTER through the ordinary login route', () => {
    expect(operator.user.role).toBe(UserRole.ADMIN_MASTER);
    expect(operator.user).not.toHaveProperty('passwordHash');
  });

  describe('POST /platform/companies', () => {
    it('creates a company and its first ADMIN in one call', async () => {
      const payload = spec('create');

      const body = await createCompany(app, operator, payload);

      expect(body.company).toMatchObject({
        name: payload.name,
        domain: payload.domain,
        isActive: true,
      });
      expect(body.admin).toMatchObject({
        email: payload.email,
        role: UserRole.ADMIN,
        deletedAt: null,
      });
      // The one field that must never appear in a response body.
      expect(body.admin).not.toHaveProperty('passwordHash');
    });

    it('refuses a domain that is already registered', async () => {
      const payload = spec('taken');
      await createCompany(app, operator, payload);

      await as(operator)
        .post('/platform/companies')
        .send({
          name: payload.name,
          domain: payload.domain,
          admin: { email: payload.email, password: payload.password },
        })
        .expect(409);
    });

    // These moved here from POST /auth/register, along with the responsibility.
    it.each([
      ['a malformed e-mail', { admin: { email: 'not-an-email' } }],
      ['a password below the minimum', { admin: { password: 'short' } }],
      // bcrypt hashes at most 72 bytes and silently drops the rest, so anything
      // longer is not really part of the credential.
      [
        'a password past the bcrypt 72-byte limit',
        { admin: { password: 'a'.repeat(73) } },
      ],
      ['a domain that is not a hostname', { domain: 'not a domain!' }],
      // The unique index would answer 409, which reads as "somebody took it"
      // when the truth is "this one is not for sale".
      ['the reserved platform domain', { domain: 'platform' }],
      ['no admin at all', { admin: undefined }],
    ])('rejects %s with 400', async (_label, override) => {
      const payload = spec(`invalid-${randomUUID().slice(0, 6)}`);

      await as(operator)
        .post('/platform/companies')
        .send({
          name: payload.name,
          domain: payload.domain,
          ...override,
          admin:
            'admin' in override
              ? override.admin === undefined
                ? undefined
                : {
                    email: payload.email,
                    password: payload.password,
                    ...override.admin,
                  }
              : { email: payload.email, password: payload.password },
        })
        .expect(400);
    });

    // forbidNonWhitelisted in the global ValidationPipe. Without it, an extra
    // field travels into a Prisma `data` object.
    it('rejects an unexpected field with 400', async () => {
      const payload = spec('extra');

      await as(operator)
        .post('/platform/companies')
        .send({
          name: payload.name,
          domain: payload.domain,
          isPlatform: true,
          admin: { email: payload.email, password: payload.password },
        })
        .expect(400);
    });
  });

  describe('authorisation', () => {
    it("refuses a company's own ADMIN with 403 across /platform", async () => {
      const payload = spec('outsider');
      const admin = await newCompanySession(app, operator, payload);

      await as(admin).get('/platform/companies').expect(403);
      await as(admin)
        .post('/platform/companies')
        .send({
          name: 'Sneaky',
          domain: `sneaky-${run}.example`,
          admin: { email: 'a@sneaky.example', password: FIXTURE_PASSWORD },
        })
        .expect(403);
    });

    it('refuses an unauthenticated caller with 401', async () => {
      await http().get('/platform/companies').expect(401);
    });
  });
});
