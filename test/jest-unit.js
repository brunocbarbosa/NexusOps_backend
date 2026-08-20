const base = require('./jest.base');

/**
 * Unit tier: mocks only. No database, no Redis, no environment file — this is
 * what `npm test` runs, and it has to stay runnable on a machine with nothing
 * started.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  coverageDirectory: '<rootDir>/coverage',
};
