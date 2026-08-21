import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import { runWithoutTenant } from '../../src/tenancy/tenant-context';
import { createTestApp } from '../utils/create-test-app';
import { bodyOf } from '../utils/response-body';

type UserBody = {
  id: string;
  email: string;
  role: UserRole;
  deletedAt: string | null;
};
type AuthBody = { accessToken: string; refreshToken: string; user: UserBody };
type PageBody = {
  data: UserBody[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

describe('Users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  const http = () => request(app.getHttpServer());

  /** Registers a tenant and returns its first ADMIN session. */
  const newTenant = async (label: string): Promise<AuthBody> => {
    const tenantDomain = `crud-${label}-${run}.example`;
    domains.push(tenantDomain);
    return bodyOf<AuthBody>(
      await http()
        .post('/auth/register')
        .send({
          tenantName: `${label} Co`,
          tenantDomain,
          email: `admin@${label}.example`,
          password: 'a-long-enough-password',
        })
        .expect(201),
    );
  };

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

  let owner: AuthBody;

  beforeAll(async () => {
    app = (await createTestApp()) as INestApplication<App>;
    prisma = app.get<ExtendedPrismaClient>(PRISMA);
    owner = await newTenant('main');
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await app.close();
  });

  const createUser = async (
    email: string,
    role: UserRole = UserRole.REQUESTER,
  ) =>
    bodyOf<UserBody>(
      await as(owner)
        .post('/users')
        .send({ email, password: 'a-long-enough-password', role })
        .expect(201),
    );

  describe('POST /users', () => {
    it('creates a user and never echoes the hash', async () => {
      const created = await createUser(`created-${run}@main.example`);

      expect(created).toMatchObject({
        email: `created-${run}@main.example`,
        role: UserRole.REQUESTER,
        deletedAt: null,
      });
      expect(created).not.toHaveProperty('passwordHash');
    });

    // The extension stamps the tenant, so a field for it would only ever be a
    // way to ask for a different one. forbidNonWhitelisted turns it into a 400.
    it('rejects an attempt to choose the tenant', async () => {
      await as(owner)
        .post('/users')
        .send({
          email: `smuggle-${run}@main.example`,
          password: 'a-long-enough-password',
          tenantId: randomUUID(),
        })
        .expect(400);
    });

    it('needs ADMIN', async () => {
      const requester = await createUser(`nobody-${run}@main.example`);
      const session = bodyOf<AuthBody>(
        await http()
          .post('/auth/login')
          .send({
            tenantDomain: domains[0],
            email: requester.email,
            password: 'a-long-enough-password',
          })
          .expect(200),
      );

      await as(session)
        .post('/users')
        .send({
          email: `denied-${run}@main.example`,
          password: 'a-long-enough-password',
        })
        .expect(403);
    });
  });

  describe('GET /users', () => {
    it('pages, and reports a total that matches the page', async () => {
      const page = bodyOf<PageBody>(
        await as(owner).get('/users?page=1&perPage=2').expect(200),
      );

      expect(page.data.length).toBeLessThanOrEqual(2);
      expect(page.meta.perPage).toBe(2);
      expect(page.meta.totalPages).toBe(Math.ceil(page.meta.total / 2) || 1);
    });

    it('filters by role', async () => {
      const page = bodyOf<PageBody>(
        await as(owner).get('/users?role=ADMIN&perPage=100').expect(200),
      );

      expect(page.data.every((u) => u.role === UserRole.ADMIN)).toBe(true);
    });

    // Boolean('false') is true, so implicit conversion would have turned this
    // into includeDeleted=true — the opposite of what was asked.
    it('treats includeDeleted=false as false', async () => {
      const gone = await createUser(`hidden-${run}@main.example`);
      await as(owner).delete(`/users/${gone.id}`).expect(204);

      const page = bodyOf<PageBody>(
        await as(owner)
          .get('/users?includeDeleted=false&perPage=100')
          .expect(200),
      );

      expect(page.data.map((u) => u.id)).not.toContain(gone.id);
    });

    it.each([
      ['a page below 1', '?page=0'],
      ['a perPage above the cap', '?perPage=101'],
      ['a role that is not one', '?role=WIZARD'],
      ['a non-boolean includeDeleted', '?includeDeleted=maybe'],
    ])('rejects %s with 400', async (_label, query) => {
      await as(owner).get(`/users${query}`).expect(400);
    });

    it('needs ADMIN or AGENT', async () => {
      const requester = await createUser(`listless-${run}@main.example`);
      const session = bodyOf<AuthBody>(
        await http()
          .post('/auth/login')
          .send({
            tenantDomain: domains[0],
            email: requester.email,
            password: 'a-long-enough-password',
          })
          .expect(200),
      );

      await as(session).get('/users').expect(403);
    });
  });

  describe('GET /users/:id', () => {
    it('rejects an id that is not a UUID with 400, not 500', async () => {
      await as(owner).get('/users/not-a-uuid').expect(400);
    });

    it('404s on an id that does not exist', async () => {
      await as(owner).get(`/users/${randomUUID()}`).expect(404);
    });

    /**
     * The isolation that matters, end to end. Nothing in UsersService writes a
     * tenant filter — this 404 is produced by the Prisma extension, from a
     * tenant established by the interceptor out of the JWT.
     */
    it('404s on a user that belongs to another tenant', async () => {
      const stranger = await newTenant('stranger');

      await as(owner).get(`/users/${stranger.user.id}`).expect(404);
      await as(owner)
        .patch(`/users/${stranger.user.id}`)
        .send({ role: UserRole.REQUESTER })
        .expect(404);
      await as(owner).delete(`/users/${stranger.user.id}`).expect(404);

      // And the stranger is untouched by any of it.
      await as(stranger).get('/auth/me').expect(200);
    });
  });

  describe('PATCH /users/:id', () => {
    it('updates the role', async () => {
      const user = await createUser(`promote-${run}@main.example`);

      const updated = bodyOf<UserBody>(
        await as(owner)
          .patch(`/users/${user.id}`)
          .send({ role: UserRole.AGENT })
          .expect(200),
      );

      expect(updated.role).toBe(UserRole.AGENT);
    });

    // Changing somebody else's password through the route that renames them is
    // how an over-broad admin action becomes an account takeover.
    it('refuses a password field', async () => {
      const user = await createUser(`nopass-${run}@main.example`);

      await as(owner)
        .patch(`/users/${user.id}`)
        .send({ password: 'another-password' })
        .expect(400);
    });

    it('409s on an e-mail that is taken', async () => {
      const first = await createUser(`taken-a-${run}@main.example`);
      const second = await createUser(`taken-b-${run}@main.example`);

      await as(owner)
        .patch(`/users/${second.id}`)
        .send({ email: first.email })
        .expect(409);
    });
  });

  describe('DELETE and restore', () => {
    it('deactivates, hides, restores', async () => {
      const user = await createUser(`cycle-${run}@main.example`);

      await as(owner).delete(`/users/${user.id}`).expect(204);
      await as(owner).get(`/users/${user.id}`).expect(200); // ADMIN still sees it
      await as(owner).delete(`/users/${user.id}`).expect(409); // already gone

      const restored = bodyOf<UserBody>(
        await as(owner).post(`/users/${user.id}/restore`).expect(200),
      );
      expect(restored.deletedAt).toBeNull();
      await as(owner).post(`/users/${user.id}/restore`).expect(409);
    });

    it('refuses self-deactivation and the last ADMIN', async () => {
      // The registering ADMIN is both, which makes one tenant enough to show
      // that neither guard depends on the other.
      await as(owner).delete(`/users/${owner.user.id}`).expect(409);
    });

    it('ends the deactivated user sessions', async () => {
      const user = await createUser(`kicked-${run}@main.example`);
      const session = bodyOf<AuthBody>(
        await http()
          .post('/auth/login')
          .send({
            tenantDomain: domains[0],
            email: user.email,
            password: 'a-long-enough-password',
          })
          .expect(200),
      );
      await as(session).get('/auth/me').expect(200);

      await as(owner).delete(`/users/${user.id}`).expect(204);

      // The access token is still cryptographically valid; JwtStrategy checks
      // the row, which is why it stops working immediately rather than in 15
      // minutes.
      await as(session).get('/auth/me').expect(401);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });
  });

  describe('PATCH /users/me/password', () => {
    it('changes the password and ends every other session', async () => {
      const user = await createUser(`rotate-${run}@main.example`);
      const login = (password: string) =>
        http().post('/auth/login').send({
          tenantDomain: domains[0],
          email: user.email,
          password,
        });

      const phone = bodyOf<AuthBody>(await login('a-long-enough-password'));
      const laptop = bodyOf<AuthBody>(await login('a-long-enough-password'));

      await as(phone)
        .patch('/users/me/password')
        .send({
          currentPassword: 'a-long-enough-password',
          newPassword: 'a-brand-new-password',
        })
        .expect(204);

      // The whole point after a leak: the other session cannot refresh either.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: laptop.refreshToken })
        .expect(401);
      await login('a-long-enough-password').expect(401);
      await login('a-brand-new-password').expect(200);
    });

    it('refuses a wrong current password', async () => {
      await as(owner)
        .patch('/users/me/password')
        .send({
          currentPassword: 'not-the-password',
          newPassword: 'a-brand-new-password',
        })
        .expect(401);
    });

    it('refuses a new password identical to the current one', async () => {
      await as(owner)
        .patch('/users/me/password')
        .send({
          currentPassword: 'a-long-enough-password',
          newPassword: 'a-long-enough-password',
        })
        .expect(409);
    });
  });

  it('requires authentication everywhere', async () => {
    await http().get('/users').expect(401);
    await http().post('/users').send({}).expect(401);
    await http().get(`/users/${randomUUID()}`).expect(401);
  });
});
