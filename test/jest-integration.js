const base = require('./jest.base');

/**
 * Integration tier: a real PostgreSQL behind a real Prisma client, no HTTP
 * layer. The tenancy chokepoint regressions live here.
 *
 * Must be launched through `npm run test:int`. The Prisma 7 runtime uses
 * dynamic `import()`, which Jest's default CJS VM rejects unless node runs with
 * `--experimental-vm-modules`; the script supplies that flag and the bare `jest`
 * binary does not. See CLAUDE.md > Prisma 7 wiring.
 *
 * `maxWorkers: 1` is correctness, not a performance trade-off. Every file
 * shares one database, and `tenant-isolation` seeds fixtures in `beforeAll` and
 * deletes them in `afterAll` — a second worker would delete rows the first is
 * still asserting on.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
  setupFiles: ['dotenv/config'],
  maxWorkers: 1,
  testTimeout: 30000,
  coverageDirectory: '<rootDir>/coverage-integration',
};
