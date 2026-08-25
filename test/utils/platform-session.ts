import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { UserRole } from '../../src/generated/prisma/enums';
import { PLATFORM_TENANT_DOMAIN } from '../../src/platform/platform.constants';

export type UserBody = {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  deletedAt: string | null;
};

export type AuthBody = {
  accessToken: string;
  refreshToken: string;
  user: UserBody;
};

export type CompanyBody = {
  id: string;
  name: string;
  domain: string | null;
  isActive: boolean;
  createdAt: string;
};

/** Long enough for the DTO's @MinLength(8), and the same everywhere. */
export const FIXTURE_PASSWORD = 'a-long-enough-password';

/**
 * How a suite gets a company now that `POST /auth/register` is gone.
 *
 * Every one of these goes through the real HTTP routes: no token is forged, no
 * provider is overridden, no row is inserted behind the application's back. The
 * ADMIN_MASTER exists because `PlatformBootstrapService` seeded it from
 * `.env.test` when `createTestApp()` booted the module — so logging in as it is
 * itself a test that the bootstrap ran.
 */
export async function loginAsAdminMaster(
  app: INestApplication<App>,
): Promise<AuthBody> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({
      tenantDomain: PLATFORM_TENANT_DOMAIN,
      email: process.env.ADMIN_MASTER_EMAIL,
      password: process.env.ADMIN_MASTER_PASSWORD,
    })
    .expect(200);

  return response.body as AuthBody;
}

/** Creates a company and its first ADMIN. Returns both, as the route does. */
export async function createCompany(
  app: INestApplication<App>,
  operator: AuthBody,
  spec: { name: string; domain: string; email: string; password?: string },
): Promise<{ company: CompanyBody; admin: UserBody }> {
  const response = await request(app.getHttpServer())
    .post('/platform/companies')
    .set('Authorization', `Bearer ${operator.accessToken}`)
    .send({
      name: spec.name,
      domain: spec.domain,
      admin: {
        email: spec.email,
        password: spec.password ?? FIXTURE_PASSWORD,
      },
    })
    .expect(201);

  return response.body as { company: CompanyBody; admin: UserBody };
}

/**
 * Creates a company and comes back holding its first ADMIN's session — the
 * drop-in for what `POST /auth/register` used to return in one call.
 */
export async function newCompanySession(
  app: INestApplication<App>,
  operator: AuthBody,
  spec: { name: string; domain: string; email: string; password?: string },
): Promise<AuthBody> {
  await createCompany(app, operator, spec);
  return loginAs(app, spec.domain, spec.email, spec.password);
}

export async function loginAs(
  app: INestApplication<App>,
  tenantDomain: string,
  email: string,
  password: string = FIXTURE_PASSWORD,
): Promise<AuthBody> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ tenantDomain, email, password })
    .expect(200);

  return response.body as AuthBody;
}
