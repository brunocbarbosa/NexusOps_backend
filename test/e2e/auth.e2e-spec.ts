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
});
