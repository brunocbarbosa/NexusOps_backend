import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from '../utils/create-test-app';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  // beforeAll, not beforeEach: booting the Nest container per test costs more
  // than every assertion in the file put together, and nothing here mutates
  // application state.
  beforeAll(async () => {
    app = (await createTestApp()) as INestApplication<App>;
  });

  afterAll(async () => {
    await app.close();
  });

  // Reachable without a token, which the `docker` job in CI depends on: it
  // boots the image and runs `curl -fsS localhost:3000`, and `-f` treats a 401
  // as a failure. Every other route is authenticated by default.
  it('GET / returns the scaffold greeting without authentication', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  // Proves the router is actually mounted rather than the server answering
  // everything — a bare `createNestApplication()` that failed to register the
  // controller would still return 404 here, but a 200 on GET / plus a 404 on an
  // unknown path together pin the routing down.
  it('answers 404 on an unmapped route', () => {
    return request(app.getHttpServer()).get('/nope').expect(404);
  });
});
