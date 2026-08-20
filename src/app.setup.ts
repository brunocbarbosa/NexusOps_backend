import { INestApplication, ValidationPipe } from '@nestjs/common';

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
  app.useGlobalPipes(
    new ValidationPipe({
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
    }),
  );

  return app;
}
