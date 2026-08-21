/**
 * Settings the three test tiers share. Each tier file below adds only what
 * distinguishes it, so a change to the transform or the coverage exclusions
 * cannot land in two tiers and be forgotten in the third.
 *
 * `rootDir` is the repository root, not `src/`, for every tier: a per-tier
 * rootDir makes the emitted lcov paths incomparable and the reports impossible
 * to merge for a single coverage number later.
 *
 * `setupFiles` carries `reflect-metadata` for every tier. The decorators that
 * `class-validator` and `class-transformer` emit read `Reflect.getMetadata`,
 * and the polyfill only arrives implicitly through `@nestjs/core` — so a unit
 * spec that imports a decorated class directly, without booting Nest, fails
 * with "Reflect.getMetadata is not a function". A tier that adds its own
 * setupFiles must spread this one in rather than replace it.
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
  setupFiles: ['reflect-metadata'],
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
