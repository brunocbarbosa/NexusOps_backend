import {
  INestApplication,
  ValidationPipe,
  ValidationPipeOptions,
} from '@nestjs/common';
import { TenantContextInterceptor } from './tenancy/tenant-context.interceptor';

/**
 * The global validation settings, exported so a DTO can be unit-tested through
 * the same pipe the application runs. A spec that built its own options would
 * be testing a configuration nobody ships — and with `enableImplicitConversion`
 * on, the options are not a detail: they decide what a query string becomes.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  // Strip properties that no DTO declares. Without this a client can post
  // extra fields and they travel straight into a Prisma `data` object.
  whitelist: true,
  // And reject the request outright rather than silently dropping them, so
  // a typo in a field name surfaces as a 400 instead of a no-op write.
  forbidNonWhitelisted: true,
  // DTOs arrive from JSON as plain objects; without this every numeric or
  // boolean field would fail its own @IsNumber/@IsBoolean validator.
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};

/**
 * Everything that turns a bare Nest application into *this* application.
 *
 * The point is that there is exactly one of these. `src/main.ts` calls it and
 * so does `test/utils/create-test-app.ts`, so an e2e test always exercises the
 * same wiring that production runs. Register a pipe, filter, interceptor or
 * prefix only in main.ts and every e2e assertion about it is a lie; register it
 * here and there is nowhere to forget it.
 *
 * Same reasoning as the tenancy chokepoint in `src/tenancy/`: a convention a
 * developer has to remember is a convention that eventually gets skipped.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // Establishes the AsyncLocalStorage tenant scope from the authenticated user,
  // so no handler has to remember to do it. It needs no injected dependency, so
  // it belongs here rather than as an APP_INTERCEPTOR provider; the guards that
  // populate `request.user` do need the Reflector and live in AuthModule.
  app.useGlobalInterceptors(new TenantContextInterceptor());

  return app;
}
