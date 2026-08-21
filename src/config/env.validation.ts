import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

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

/** The placeholder shipped in `.env.example`. Refused in production. */
const PLACEHOLDER_JWT_SECRET = 'change-me-in-every-environment';

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
  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.JWT_SECRET === PLACEHOLDER_JWT_SECRET
  ) {
    problems.push(
      '  - JWT_SECRET: still the .env.example placeholder, which is public. ' +
        'Generate a real one with `openssl rand -base64 48`',
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
