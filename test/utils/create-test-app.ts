import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

/**
 * Boots the real application for an e2e suite.
 *
 * Goes through `configureApp` rather than repeating the global pipes and
 * filters, so a test can never pass against a configuration that production
 * does not have — the failure mode this exists to prevent is an e2e test
 * asserting 400 Bad Request while the deployed app happily accepts the payload.
 *
 * `customise` hands back the TestingModuleBuilder before it compiles, which is
 * where a suite overrides a provider (`.overrideProvider(X).useValue(Y)`).
 */
export async function createTestApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customise) {
    builder = customise(builder);
  }

  const app = configureApp((await builder.compile()).createNestApplication());
  await app.init();
  return app;
}
