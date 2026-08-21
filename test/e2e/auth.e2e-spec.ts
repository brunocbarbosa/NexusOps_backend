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

type AuthBody = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: UserRole; deletedAt: string | null };
};

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  const registration = (label: string) => {
    const tenantDomain = `${label}-${run}.example`;
    domains.push(tenantDomain);
    return {
      tenantName: `${label} Co`,
      tenantDomain,
      email: `founder@${label}.example`,
      password: 'a-long-enough-password',
    };
  };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = (await createTestApp()) as INestApplication<App>;
    prisma = app.get<ExtendedPrismaClient>(PRISMA);
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await app.close();
  });

  describe('POST /auth/register', () => {
    it('creates a tenant with its first ADMIN', async () => {
      const payload = registration('signup');

      const response = await http()
        .post('/auth/register')
        .send(payload)
        .expect(201);

      const body = bodyOf<AuthBody>(response);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.user).toMatchObject({
        email: payload.email,
        role: UserRole.ADMIN,
        deletedAt: null,
      });
      // The one field that must never appear in a response body.
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    it('refuses a domain that is already registered', async () => {
      const payload = registration('taken');
      await http().post('/auth/register').send(payload).expect(201);

      await http().post('/auth/register').send(payload).expect(409);
    });

    it.each([
      ['a malformed e-mail', { email: 'not-an-email' }],
      ['a password below the minimum', { password: 'short' }],
      // bcrypt hashes at most 72 bytes and silently drops the rest, so anything
      // longer is not really part of the credential.
      ['a password past bcrypt 72-byte limit', { password: 'a'.repeat(73) }],
      ['a domain that is not a hostname', { tenantDomain: 'not a domain!' }],
    ])('rejects %s with 400', async (_label, override) => {
      await http()
        .post('/auth/register')
        .send({ ...registration('invalid'), ...override })
        .expect(400);
    });

    // forbidNonWhitelisted in the global ValidationPipe. Without it, an extra
    // field travels into a Prisma `data` object.
    it('rejects an unexpected field with 400', async () => {
      await http()
        .post('/auth/register')
        .send({ ...registration('extra'), role: UserRole.ADMIN })
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    const payload = registration('login');

    beforeAll(async () => {
      await http().post('/auth/register').send(payload).expect(201);
    });

    it('returns 200 and a token', async () => {
      const response = await http()
        .post('/auth/login')
        .send({
          tenantDomain: payload.tenantDomain,
          email: payload.email,
          password: payload.password,
        })
        .expect(200);

      expect(bodyOf<AuthBody>(response).accessToken).toEqual(
        expect.any(String),
      );
    });

    // Normalisation happens in the DTO, so a capitalised e-mail is the same
    // credential rather than a mysterious 401.
    it('is case-insensitive about the e-mail and the domain', async () => {
      await http()
        .post('/auth/login')
        .send({
          tenantDomain: payload.tenantDomain.toUpperCase(),
          email: payload.email.toUpperCase(),
          password: payload.password,
        })
        .expect(200);
    });

    // The three failures a stranger could tell apart, if the answers differed.
    it.each([
      ['a wrong password', { password: 'wrong-but-long-enough' }],
      ['an unknown e-mail', { email: 'nobody@login.example' }],
      ['an unknown tenant', { tenantDomain: `absent-${run}.example` }],
    ])('answers %s with the same 401 and message', async (_label, override) => {
      const response = await http()
        .post('/auth/login')
        .send({
          tenantDomain: payload.tenantDomain,
          email: payload.email,
          password: payload.password,
          ...override,
        })
        .expect(401);

      expect(bodyOf<{ message: string }>(response).message).toBe(
        'Invalid credentials',
      );
    });
  });

  describe('GET /auth/me', () => {
    const payload = registration('me');
    let accessToken: string;

    beforeAll(async () => {
      const response = await http()
        .post('/auth/register')
        .send(payload)
        .expect(201);
      accessToken = bodyOf<AuthBody>(response).accessToken;
    });

    it('returns the authenticated user', async () => {
      const response = await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = bodyOf<{ email: string; role: UserRole; tenantId: string }>(
        response,
      );
      expect(body).toMatchObject({
        email: payload.email,
        role: UserRole.ADMIN,
      });
      expect(body.tenantId).toEqual(expect.any(String));
    });

    // JwtAuthGuard is global, so this is the default for every route that does
    // not say @Public().
    it.each([
      ['no Authorization header', undefined],
      ['a token that is not a JWT', 'Bearer nonsense'],
      ['an empty bearer token', 'Bearer '],
    ])('answers 401 with %s', async (_label, header) => {
      const call = http().get('/auth/me');
      if (header) {
        void call.set('Authorization', header);
      }
      await call.expect(401);
    });

    // A token signed with a different secret must not be accepted, which is the
    // whole point of validating the signature rather than just decoding.
    it('answers 401 for a token signed with another secret', async () => {
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
          'base64url',
        ),
        Buffer.from(
          JSON.stringify({ sub: randomUUID(), tenantId: randomUUID() }),
        ).toString('base64url'),
        'not-a-valid-signature',
      ].join('.');

      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });
  });

  describe('POST /auth/refresh', () => {
    const payload = registration('refresh');

    const freshSession = async () => {
      const response = await http()
        .post('/auth/login')
        .send({
          tenantDomain: payload.tenantDomain,
          email: payload.email,
          password: payload.password,
        })
        .expect(200);
      return bodyOf<AuthBody>(response);
    };

    beforeAll(async () => {
      await http().post('/auth/register').send(payload).expect(201);
    });

    it('exchanges a refresh token for a working new pair', async () => {
      const session = await freshSession();

      const refreshed = bodyOf<AuthBody>(
        await http()
          .post('/auth/refresh')
          .send({ refreshToken: session.refreshToken })
          .expect(200),
      );

      expect(refreshed.refreshToken).not.toBe(session.refreshToken);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${refreshed.accessToken}`)
        .expect(200);
    });

    it('rotates: the token just used stops working', async () => {
      const session = await freshSession();
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    /**
     * Reuse detection, end to end. Replaying a spent token means two parties
     * hold it and neither can be told from the other, so the chain that was
     * issued from it dies too — otherwise the thief keeps refreshing forever
     * beside the legitimate user.
     */
    it('kills the successor chain when a spent token is replayed', async () => {
      const session = await freshSession();
      const successor = bodyOf<AuthBody>(
        await http()
          .post('/auth/refresh')
          .send({ refreshToken: session.refreshToken })
          .expect(200),
      );

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: successor.refreshToken })
        .expect(401);
    });

    /**
     * The reason JWT_REFRESH_SECRET exists.
     *
     * Access and refresh tokens carry nearly the same claims, so signed with
     * one key the refresh token — good for seven days — would authenticate as a
     * bearer token and the fifteen-minute access lifetime would mean nothing.
     * Two keys make the signature check refuse it, with no `type` claim for
     * anyone to forget.
     */
    it('does not accept a refresh token as a bearer token', async () => {
      const session = await freshSession();

      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${session.refreshToken}`)
        .expect(401);
    });

    // And the other direction, which the token-hash lookup covers on its own.
    it('does not accept an access token as a refresh token', async () => {
      const session = await freshSession();

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.accessToken })
        .expect(401);
    });

    it('rejects a body that is not a JWT with 400', async () => {
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: 'not-a-jwt' })
        .expect(400);
    });
  });

  describe('POST /auth/logout', () => {
    const payload = registration('logout');

    beforeAll(async () => {
      await http().post('/auth/register').send(payload).expect(201);
    });

    const freshSession = async () =>
      bodyOf<AuthBody>(
        await http()
          .post('/auth/login')
          .send({
            tenantDomain: payload.tenantDomain,
            email: payload.email,
            password: payload.password,
          })
          .expect(200),
      );

    it('answers 204 and makes the refresh token unusable', async () => {
      const session = await freshSession();

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ refreshToken: session.refreshToken })
        .expect(204);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    // Ending one session must not end the others: a phone logging out should
    // not sign the laptop out too.
    it('leaves the caller other sessions alone', async () => {
      const [phone, laptop] = [await freshSession(), await freshSession()];

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${phone.accessToken}`)
        .send({ refreshToken: phone.refreshToken })
        .expect(204);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: laptop.refreshToken })
        .expect(200);
    });

    it('requires authentication', async () => {
      const session = await freshSession();

      await http()
        .post('/auth/logout')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });
  });
});
