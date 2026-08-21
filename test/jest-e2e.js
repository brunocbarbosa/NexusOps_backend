const base = require('./jest.base');

/**
 * E2E tier: Supertest firing real HTTP requests at a booted Nest application.
 *
 * The application comes from `test/utils/create-test-app.ts`, which routes
 * through the same `configureApp()` that `src/main.ts` uses. Without that these
 * tests would assert against a differently-configured app than the one that
 * ships, and a passing 400-Bad-Request test would prove nothing.
 *
 * Same two constraints as the integration tier: `--experimental-vm-modules` is
 * required by the Prisma 7 runtime, and `maxWorkers: 1` because the suites
 * share one database.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  setupFiles: [...base.setupFiles, 'dotenv/config'],
  maxWorkers: 1,
  testTimeout: 30000,
  coverageDirectory: '<rootDir>/coverage-e2e',
};
