import { plainToInstance } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { BCRYPT_MAX_BYTES, MaxBytes } from '../auth/password.constraints';

/**
 * The environment this process is running as. An enum rather than a free string
 * so that a typo like `NODE_ENV=produciton` fails at boot instead of quietly
 * putting the application in development mode.
 */
export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** The placeholders shipped in `.env.example`. Refused in production. */
const PLACEHOLDER_JWT_SECRET = 'change-me-in-every-environment';
const PLACEHOLDER_ADMIN_MASTER_PASSWORD = 'change-me-before-any-deployment';

/**
 * `15m`, `7d`, `3600s` — the duration grammar `@nestjs/jwt` accepts. Validated
 * here because a malformed value does not throw: `jsonwebtoken` treats an
 * unparseable `expiresIn` as seconds or ignores it, so the failure would surface
 * as tokens with the wrong lifetime rather than as an error.
 */
const DURATION = /^\d+[smhd]$/;

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number;

  // Only the scheme is checked. Anything deeper duplicates what `pg` already
  // validates, and it would reject perfectly valid URLs (unix sockets, options).
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL: string;

  // The connection the application itself uses: a NOSUPERUSER NOBYPASSRLS role
  // that does not own the tables, so the RLS policies apply to it. `DATABASE_URL`
  // above stays the owner and keeps running the migrations.
  //
  // Required rather than optional, and required from the moment the role exists
  // rather than from the moment the runtime starts using it: an environment that
  // is missing it would otherwise be discovered by the deploy that switches over,
  // which is the worst moment to find out.
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL_APP must be a postgresql:// connection string',
  })
  DATABASE_URL_APP: string;

  // How many connections the application may hold at once. Under Row-Level
  // Security a scope is a transaction and a transaction pins a connection for
  // the length of the request that opened it, so this is the ceiling on
  // concurrent requests, not on concurrent queries — request N+1 waits for a
  // connection and gives up after the scope's 5s `maxWait`.
  //
  // Required, and with no default on purpose: `pg` has one (10), and a ceiling
  // nobody chose is a ceiling nobody knows. The number that matters in
  // production is this times the number of instances, against the server's
  // `max_connections` — which is why the bound below is loose: only the
  // deployment knows what is too many.
  @IsInt()
  @Min(1)
  @Max(1000)
  DATABASE_POOL_MAX: number;

  @IsString()
  @MinLength(16, {
    message:
      'JWT_SECRET must be at least 16 characters; generate one with `openssl rand -base64 48`',
  })
  JWT_SECRET: string;

  @Matches(DURATION, {
    message: 'JWT_EXPIRES_IN must look like 15m, 24h or 7d',
  })
  JWT_EXPIRES_IN: string;

  // A separate key, not the same one with a longer expiry. Access and refresh
  // tokens carry almost the same claims, so under one key a refresh token —
  // valid for days — is accepted as a bearer token by JwtStrategy, and the
  // short access-token lifetime stops meaning anything. With two keys the
  // signature check refuses it, and no `type` claim has to be remembered.
  @IsString()
  @MinLength(16, {
    message:
      'JWT_REFRESH_SECRET must be at least 16 characters; generate one with `openssl rand -base64 48`',
  })
  JWT_REFRESH_SECRET: string;

  @Matches(DURATION, {
    message: 'JWT_REFRESH_EXPIRES_IN must look like 15m, 24h or 7d',
  })
  JWT_REFRESH_EXPIRES_IN: string;

  // bcrypt itself only accepts 4..31. Below 10 is too cheap for a real password,
  // but `.env.test` deliberately runs at 4 so the auth suites are not dominated
  // by key derivation, which is why the floor here is bcrypt's and not 10.
  @IsInt()
  @Min(4)
  @Max(31)
  BCRYPT_SALT_ROUNDS: number;

  // Read by BullMQ, which is why they are validated here now and were not
  // before: until the report queue existed, nothing in the process opened a
  // Redis connection, and an unset REDIS_HOST failed at nobody. Now the
  // application connects at boot, so a missing value should stop it there
  // rather than surface as a job that is enqueued and never runs.
  @IsString()
  @MinLength(1)
  REDIS_HOST: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number;

  // Optional, and genuinely so: the local and CI stacks run Redis with no
  // password, and requiring one would mean inventing a value for a container
  // that ignores it.
  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  // The ceiling on one CSV export. The report body is stored in a TEXT column
  // rather than in object storage, so this is what keeps a single row from
  // growing without bound — see documents/important/HELPDESK.md.
  @IsInt()
  @Min(1)
  @Max(1000000)
  REPORTS_MAX_ROWS: number;

  // The single platform operator. Seeded into the reserved platform tenant at
  // boot by PlatformBootstrapService, which is why these are required rather
  // than optional: an application that starts with nobody able to create a
  // company has started into a state with no way out of itself.
  @IsEmail()
  ADMIN_MASTER_EMAIL: string;

  // The same policy the API enforces on any password, including bcrypt's 72-byte
  // truncation — a longer one here would be silently cut, and the operator would
  // be typing a password whose tail never mattered.
  @IsString()
  @MinLength(8)
  @MaxBytes(BCRYPT_MAX_BYTES)
  ADMIN_MASTER_PASSWORD: string;
}

/**
 * Validates `process.env` at boot, before anything can read a missing variable.
 *
 * Wired through `ConfigModule.forRoot({ validate: validateEnv })`. The point is
 * that a missing `JWT_SECRET` fails the process on startup with a list of every
 * problem at once, rather than surfacing as `undefined` inside a token signature
 * on the first login attempt.
 *
 * Unknown variables are deliberately **not** stripped: `POSTGRES_*` belongs to
 * docker-compose and `REDIS_*` is read by BullMQ later, and whitelisting them
 * out of the validated config would make `ConfigService.get` return undefined
 * for variables that are plainly set.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const validated = plainToInstance(EnvironmentVariables, config, {
    // `process.env` values are all strings; without this, PORT and
    // BCRYPT_SALT_ROUNDS would fail @IsInt() no matter what they contain.
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  const problems = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}).map(
      (message) => `  - ${error.property}: ${message}`,
    ),
  );

  // Not a class-validator constraint because it depends on another field, and a
  // cross-field decorator would be more machinery than one comparison deserves.
  if (validated.NODE_ENV === NodeEnv.Production) {
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (validated[key] === PLACEHOLDER_JWT_SECRET) {
        problems.push(
          `  - ${key}: still the .env.example placeholder, which is public. ` +
            'Generate a real one with `openssl rand -base64 48`',
        );
      }
    }

    // The account this one guards can create companies and users at any level,
    // so shipping the published placeholder is worse than a weak password: it
    // is a known one.
    if (validated.ADMIN_MASTER_PASSWORD === PLACEHOLDER_ADMIN_MASTER_PASSWORD) {
      problems.push(
        '  - ADMIN_MASTER_PASSWORD: still the .env.example placeholder, which is ' +
          'public, and it guards the account that creates every company',
      );
    }
  }

  // Same shape as the JWT check below, and for the same reason. If the two URLs
  // match, the application connects as the owning superuser, every policy is
  // bypassed, and `pg_policies` still reports the setup as correct -- a silent
  // failure that looks exactly like protection. Measured, see RLS_NOTES.md.
  if (
    validated.DATABASE_URL &&
    validated.DATABASE_URL === validated.DATABASE_URL_APP
  ) {
    problems.push(
      '  - DATABASE_URL_APP: must differ from DATABASE_URL. They are the same ' +
        'connection, so the application would connect as the table owner and ' +
        'every Row-Level Security policy would be bypassed in silence',
    );
  }

  // Setting both to the same value silently undoes the separation the two keys
  // exist for, and nothing downstream would ever complain.
  if (
    validated.JWT_SECRET &&
    validated.JWT_SECRET === validated.JWT_REFRESH_SECRET
  ) {
    problems.push(
      '  - JWT_REFRESH_SECRET: must differ from JWT_SECRET, or a refresh token ' +
        'is accepted as an access token and the short access lifetime is pointless',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment (${problems.length} problem(s)):\n${problems.join('\n')}`,
    );
  }

  // The validated instance carries the coerced types (PORT as a number), and the
  // untouched extras come along because plainToInstance copies them.
  return validated as unknown as Record<string, unknown>;
}
