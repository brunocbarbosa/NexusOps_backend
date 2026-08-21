/**
 * Settings the three test tiers share. Each tier file below adds only what
 * distinguishes it, so a change to the transform or the coverage exclusions
 * cannot land in two tiers and be forgotten in the third.
 *
 * `rootDir` is the repository root, not `src/`, for every tier: a per-tier
 * rootDir makes the emitted lcov paths incomparable and the reports impossible
 * to merge for a single coverage number later.
 *
 * `src/generated` is Prisma output — gitignored, rewritten by every
 * `prisma generate`, and about as large as the hand-written source. Left in the
 * denominator it swamps the coverage figure and reports on code nobody wrote.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/generated/**',
    '!src/**/*.spec.ts',
    '!src/main.ts',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/generated/'],
};
