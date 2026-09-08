import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import { PLATFORM_TENANT_DOMAIN } from '../../src/platform/platform.constants';
import {
  runWithTenant,
  runWithoutTenant,
  useScope,
} from '../utils/tenant-scope';
import { TenantScopeService } from '../../src/tenancy/tenant-scope.service';
import { createTestApp } from '../utils/create-test-app';
import {
  FIXTURE_PASSWORD,
  createCompany,
  loginAsAdminMaster,
  newCompanySession,
} from '../utils/platform-session';
import type {
  AuthBody,
  CompanyBody,
  UserBody,
} from '../utils/platform-session';
import { bodyOf } from '../utils/response-body';

type PageBody<T> = {
  data: T[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

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
    patch: (url: string) =>
      http().patch(url).set('Authorization', `Bearer ${session.accessToken}`),
    delete: (url: string) =>
      http().delete(url).set('Authorization', `Bearer ${session.accessToken}`),
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
    useScope(app.get(TenantScopeService));
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

  describe('GET /platform/companies', () => {
    it('lists companies and never the platform tenant among them', async () => {
      const payload = spec('listed');
      await createCompany(app, operator, payload);

      const body = bodyOf<PageBody<CompanyBody>>(
        await as(operator).get('/platform/companies?perPage=100').expect(200),
      );

      expect(body.data.some((c) => c.domain === payload.domain)).toBe(true);
      // The reserved row is not a customer. `isPlatform: null` is what excludes
      // it; `domain: { not: "platform" }` would also drop every company whose
      // domain is NULL, because NOT (NULL = 'platform') is NULL.
      expect(body.data.some((c) => c.domain === PLATFORM_TENANT_DOMAIN)).toBe(
        false,
      );
    });

    it('filters by isActive without collapsing `false` into `true`', async () => {
      const payload = spec('suspended');
      const created = await createCompany(app, operator, payload);
      await as(operator)
        .patch(`/platform/companies/${created.company.id}`)
        .send({ isActive: false })
        .expect(200);

      const inactive = bodyOf<PageBody<CompanyBody>>(
        await as(operator)
          .get('/platform/companies?isActive=false&perPage=100')
          .expect(200),
      );
      const active = bodyOf<PageBody<CompanyBody>>(
        await as(operator)
          .get('/platform/companies?isActive=true&perPage=100')
          .expect(200),
      );

      // Boolean('false') is true, so without @Type(() => String) on the DTO this
      // query would have answered with the active companies instead.
      expect(inactive.data.some((c) => c.id === created.company.id)).toBe(true);
      expect(active.data.some((c) => c.id === created.company.id)).toBe(false);
    });

    it.each([
      ['a page below 1', '?page=0'],
      ['a perPage above the cap', '?perPage=101'],
      ['a non-boolean isActive', '?isActive=maybe'],
      ['an unknown parameter', '?nope=1'],
    ])('rejects %s with 400', async (_label, query) => {
      await as(operator).get(`/platform/companies${query}`).expect(400);
    });
  });

  describe('the platform tenant is not a company', () => {
    let platformId: string;

    beforeAll(async () => {
      const platform = await runWithoutTenant(() =>
        prisma.tenant.findUnique({ where: { isPlatform: true } }),
      );
      platformId = platform!.id;
    });

    // Without this the operator can reach itself through its own console:
    // deactivate the only ADMIN_MASTER and the installation has no operator and
    // no way to mint another short of a reboot.
    it.each([
      [
        'read it',
        (id: string) => as(operator).get(`/platform/companies/${id}`),
      ],
      [
        'list its users',
        (id: string) => as(operator).get(`/platform/companies/${id}/users`),
      ],
      [
        'delete it',
        (id: string) => as(operator).delete(`/platform/companies/${id}`),
      ],
    ])('404s when the operator tries to %s', async (_label, call) => {
      await call(platformId).expect(404);
    });

    it('leaves the operator able to log in afterwards', async () => {
      await loginAsAdminMaster(app);
    });
  });

  describe('managing the users of a company', () => {
    let companyId: string;

    beforeAll(async () => {
      const created = await createCompany(app, operator, spec('users'));
      companyId = created.company.id;
    });

    const url = (suffix = '') =>
      `/platform/companies/${companyId}/users${suffix}`;

    it('creates a user at every assignable level', async () => {
      for (const role of [UserRole.ADMIN, UserRole.AGENT, UserRole.REQUESTER]) {
        await as(operator)
          .post(url())
          .send({
            email: `${role.toLowerCase()}-${run}@users.example`,
            password: FIXTURE_PASSWORD,
            role,
          })
          .expect(201);
      }

      const body = bodyOf<PageBody<UserBody>>(
        await as(operator).get(url()).expect(200),
      );
      // Three created here, plus the ADMIN the company was born with.
      expect(body.meta.total).toBe(4);
    });

    // The enum carries ADMIN_MASTER; the assignable list does not. Without that
    // split this route would mint a platform operator inside a customer company.
    it('refuses to create an ADMIN_MASTER', async () => {
      await as(operator)
        .post(url())
        .send({
          email: `escalation-${run}@users.example`,
          password: FIXTURE_PASSWORD,
          role: UserRole.ADMIN_MASTER,
        })
        .expect(400);
    });

    it('deactivates and restores, and shows the deactivated one only on request', async () => {
      const created = bodyOf<UserBody>(
        await as(operator)
          .post(url())
          .send({
            email: `cycle-${run}@users.example`,
            password: FIXTURE_PASSWORD,
            role: UserRole.AGENT,
          })
          .expect(201),
      );

      await as(operator)
        .delete(url(`/${created.id}`))
        .expect(204);

      const visible = bodyOf<PageBody<UserBody>>(
        await as(operator).get(url()).expect(200),
      );
      expect(visible.data.some((u) => u.id === created.id)).toBe(false);

      // The ADMIN_MASTER may ask for them, because restoring requires seeing
      // them first. Before administersUsers() this answered 403.
      const withDeleted = bodyOf<PageBody<UserBody>>(
        await as(operator).get(url('?includeDeleted=true')).expect(200),
      );
      expect(withDeleted.data.some((u) => u.id === created.id)).toBe(true);

      await as(operator)
        .post(url(`/${created.id}/restore`))
        .expect(200);
      const restored = bodyOf<UserBody>(
        await as(operator)
          .get(url(`/${created.id}`))
          .expect(200),
      );
      expect(restored.deletedAt).toBeNull();
    });

    it('404s on a company that does not exist, rather than an empty page', async () => {
      const nowhere = randomUUID();

      // runWithTenant() accepts any string, so without requireCompany() this
      // would answer 200 with zero users — "this company has no users" instead
      // of "there is no such company".
      await as(operator)
        .get(`/platform/companies/${nowhere}/users`)
        .expect(404);
    });

    it("404s on another company's user, never 403", async () => {
      const stranger = await createCompany(app, operator, spec('stranger'));

      await as(operator)
        .get(url(`/${stranger.admin.id}`))
        .expect(404);
      await as(operator)
        .patch(url(`/${stranger.admin.id}`))
        .send({ role: UserRole.REQUESTER })
        .expect(404);
      // A 403 would confirm the id exists somewhere, which is a fact about
      // another company's data.
      await as(operator)
        .delete(url(`/${stranger.admin.id}`))
        .expect(404);
    });
  });

  describe('DELETE /platform/companies/:companyId', () => {
    it('takes the company and everything in it', async () => {
      const payload = spec('doomed');
      const created = await createCompany(app, operator, payload);
      await as(operator)
        .post(`/platform/companies/${created.company.id}/users`)
        .send({
          email: `doomed-agent-${run}@users.example`,
          password: FIXTURE_PASSWORD,
          role: UserRole.AGENT,
        })
        .expect(201);

      await as(operator)
        .delete(`/platform/companies/${created.company.id}`)
        .expect(204);

      await as(operator)
        .get(`/platform/companies/${created.company.id}`)
        .expect(404);

      // Read from inside the deleted company's own scope, which is the only way
      // to ask this: `User` is tenant-scoped, so `runWithoutTenant()` refuses it
      // outright rather than letting an unfiltered count through.
      const survivors = await runWithTenant(created.company.id, () =>
        prisma.user.count(),
      );
      expect(survivors).toBe(0);
    });

    it('locks a company out through isActive without deleting anything', async () => {
      const payload = spec('locked');
      const created = await createCompany(app, operator, payload);

      await as(operator)
        .patch(`/platform/companies/${created.company.id}`)
        .send({ isActive: false })
        .expect(200);

      // AuthService.login already refuses an inactive tenant, so suspending a
      // customer needs no change to a single user row.
      await http()
        .post('/auth/login')
        .send({
          tenantDomain: payload.domain,
          email: payload.email,
          password: payload.password,
        })
        .expect(401);
    });
  });
});
