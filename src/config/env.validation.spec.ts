import { EnvironmentVariables, validateEnv } from './env.validation';

describe('validateEnv', () => {
  const valid = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
    JWT_SECRET: 'a-secret-long-enough-to-pass',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'a-different-secret-long-enough',
    JWT_REFRESH_EXPIRES_IN: '7d',
    BCRYPT_SALT_ROUNDS: '4',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REPORTS_MAX_ROWS: '100',
    ADMIN_MASTER_EMAIL: 'operator@nexusops.test',
    ADMIN_MASTER_PASSWORD: 'a-long-enough-operator-password',
  };

  it('accepts a complete environment', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  // The reason enableImplicitConversion is on: everything in process.env is a
  // string, and a PORT that stays "3000" would reach `app.listen` as a string.
  it('coerces the numeric variables', () => {
    const result = validateEnv(valid) as unknown as EnvironmentVariables;

    expect(result.PORT).toBe(3000);
    expect(result.BCRYPT_SALT_ROUNDS).toBe(4);
    expect(result.REDIS_PORT).toBe(6379);
    expect(result.REPORTS_MAX_ROWS).toBe(100);
  });

  // Variables belonging to docker-compose are not declared on the class.
  // Stripping them would make ConfigService.get return undefined for variables
  // that are plainly set. REDIS_HOST used to be the example here; it is
  // declared now that BullMQ opens a connection at boot, so POSTGRES_USER —
  // which only docker-compose reads — took its place.
  it('passes undeclared variables through untouched', () => {
    const result = validateEnv({ ...valid, POSTGRES_USER: 'nexusops' });

    expect(result.POSTGRES_USER).toBe('nexusops');
  });

  // The queue connects at boot now, so an unset host has to stop the process
  // rather than surface later as a job that is enqueued and never runs.
  it('rejects a missing REDIS_HOST', () => {
    const incomplete: Record<string, string> = { ...valid };
    delete incomplete.REDIS_HOST;

    expect(() => validateEnv(incomplete)).toThrow(/REDIS_HOST/);
  });

  // Optional and genuinely so: the local and CI stacks run Redis without one.
  it('accepts an absent REDIS_PASSWORD', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('rejects a missing variable', () => {
    const incomplete: Record<string, string> = { ...valid };
    delete incomplete.JWT_SECRET;

    expect(() => validateEnv(incomplete)).toThrow(/JWT_SECRET/);
  });

  // One error per run would mean a boot-fix-boot loop for each missing variable.
  it('reports every problem at once', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_SECRET: 'short', PORT: '0' }),
    ).toThrow(/2 problem\(s\)/);
  });

  it.each([
    ['DATABASE_URL', 'mysql://user:pass@localhost:3306/db'],
    ['JWT_EXPIRES_IN', '15 minutes'],
    ['JWT_REFRESH_EXPIRES_IN', 'forever'],
    ['NODE_ENV', 'produciton'],
    ['BCRYPT_SALT_ROUNDS', '3'],
    ['ADMIN_MASTER_EMAIL', 'not-an-email'],
    ['ADMIN_MASTER_PASSWORD', 'short'],
  ])('rejects a malformed %s', (key, value) => {
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(
      new RegExp(key),
    );
  });

  // The placeholder is committed in .env.example, so it is public knowledge and
  // anyone could mint a token for any tenant with it.
  it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])(
    'refuses the .env.example placeholder in %s in production',
    (key) => {
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          [key]: 'change-me-in-every-environment',
        }),
      ).toThrow(/placeholder/);
    },
  );

  // Two keys that are equal are one key, and then a refresh token valid for
  // days is accepted as a bearer token — silently, since nothing downstream
  // would notice.
  it('refuses a refresh secret equal to the access secret', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_SECRET }),
    ).toThrow(/must differ from JWT_SECRET/);
  });

  // The account it guards can create every company and every user in them, so
  // the published placeholder is not a weak password — it is a known one.
  it('refuses the .env.example ADMIN_MASTER_PASSWORD in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        ADMIN_MASTER_PASSWORD: 'change-me-before-any-deployment',
      }),
    ).toThrow(/placeholder/);
  });

  // bcrypt silently truncates past 72 bytes, so a longer operator password
  // would have a tail that never mattered — caught here rather than discovered.
  it('refuses an ADMIN_MASTER_PASSWORD past bcrypt truncation', () => {
    expect(() =>
      validateEnv({ ...valid, ADMIN_MASTER_PASSWORD: 'x'.repeat(73) }),
    ).toThrow(/ADMIN_MASTER_PASSWORD/);
  });

  it('tolerates the placeholder outside production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'development',
        JWT_SECRET: 'change-me-in-every-environment',
      }),
    ).not.toThrow();
  });
});
