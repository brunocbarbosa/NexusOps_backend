import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../app.setup';
import { UserRole } from '../../generated/prisma/enums';
import { QueryUsersDto } from './query-users.dto';

/**
 * Query strings only ever carry text, and the global pipe runs with
 * `enableImplicitConversion`. That combination has one genuinely dangerous
 * case: `Boolean('false')` is `true`, so a flag asked for as `false` arrives as
 * `true` — the opposite of the request, with nothing to notice it.
 *
 * The pipe is built from the same options the application uses, so this cannot
 * pass against a configuration nobody ships.
 */
describe('QueryUsersDto through the global ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'query',
    metatype: QueryUsersDto,
  };

  const parse = (query: Record<string, string>) =>
    pipe.transform(query, metadata) as Promise<QueryUsersDto>;

  it('applies the defaults when nothing is asked for', async () => {
    await expect(parse({})).resolves.toMatchObject({
      page: 1,
      perPage: 20,
      includeDeleted: false,
    });
  });

  it('converts the numeric parameters', async () => {
    const parsed = await parse({ page: '3', perPage: '50' });

    expect(parsed.page).toBe(3);
    expect(parsed.perPage).toBe(50);
  });

  // The case worth the whole file.
  it.each([
    ['true', true],
    ['false', false],
  ])('reads includeDeleted=%s as %s', async (raw, expected) => {
    const parsed = await parse({ includeDeleted: raw });

    expect(parsed.includeDeleted).toBe(expected);
  });

  it('rejects an includeDeleted that is neither', async () => {
    await expect(parse({ includeDeleted: 'maybe' })).rejects.toThrow();
  });

  it.each([
    ['a page below 1', { page: '0' }],
    ['a perPage above the cap', { perPage: '101' }],
    ['a perPage below 1', { perPage: '0' }],
    ['a role that is not one', { role: 'WIZARD' }],
  ])('rejects %s', async (_label, query) => {
    await expect(parse(query)).rejects.toThrow();
  });

  it('accepts a real role and lowercases the search', async () => {
    const parsed = await parse({ role: UserRole.AGENT, search: '  ACME  ' });

    expect(parsed.role).toBe(UserRole.AGENT);
    expect(parsed.search).toBe('acme');
  });

  // whitelist + forbidNonWhitelisted, so a mistyped parameter is a 400 rather
  // than a filter that silently did nothing.
  it('rejects an unknown parameter', async () => {
    await expect(parse({ includedeleted: 'true' })).rejects.toThrow();
  });
});
