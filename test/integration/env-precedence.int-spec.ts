import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validateEnv } from '../../src/config/env.validation';

/**
 * The application now loads `.env` through ConfigModule, and the test tiers load
 * `.env.test` through `DOTENV_CONFIG_PATH`. Only one thing keeps the suites off
 * the development database: `@nestjs/config` sets a variable from the file only
 * when `process.env` does not already have it.
 *
 * That is a behaviour of a dependency, not of this repository, so it gets a test
 * rather than a comment — a minor-version change there would otherwise redirect
 * every integration suite at `.env` and silently truncate the developer's own
 * data.
 *
 * The env file here is written to a temp directory rather than read from `.env`,
 * because `.env` is gitignored and does not exist in CI.
 */
describe('environment precedence', () => {
  const decoyPath = join(mkdtempSync(join(tmpdir(), 'nexusops-env-')), '.env');

  beforeAll(() => {
    writeFileSync(
      decoyPath,
      [
        'DATABASE_URL="postgresql://decoy:decoy@localhost:5432/decoy?schema=public"',
        'A_VARIABLE_NOBODY_SET=from-the-file',
      ].join('\n'),
    );
  });

  it('keeps the value already in process.env instead of the file value', async () => {
    // Put there by dotenv from .env.test, before Nest booted.
    const fromTestEnv = process.env.DATABASE_URL;
    expect(fromTestEnv).toContain('5433');

    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: decoyPath,
          validate: validateEnv,
        }),
      ],
    }).compile();

    const config = mod.get(ConfigService);

    expect(config.getOrThrow<string>('DATABASE_URL')).toBe(fromTestEnv);
    expect(process.env.DATABASE_URL).toBe(fromTestEnv);

    // The other half of the same behaviour: a variable that process.env does
    // *not* have does come from the file. Without this assertion the test would
    // still pass if ConfigModule stopped reading the file altogether.
    expect(config.get<string>('A_VARIABLE_NOBODY_SET')).toBe('from-the-file');

    await mod.close();
  });
});
