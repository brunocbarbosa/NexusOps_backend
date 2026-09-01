import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../app.setup';
import {
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../../generated/prisma/enums';
import { QueryTicketsDto } from './query-tickets.dto';

/**
 * The same trap `QueryUsersDto` guards against, in the filter that needs three
 * states rather than two.
 *
 * `Boolean('false')` is `true`, and the global pipe runs with
 * `enableImplicitConversion`, so `?unassigned=false` would ask for the opposite
 * of what it says. `?unassigned` absent has to stay absent, too: collapsing it
 * to `false` would silently turn "any ticket" into "only assigned ones".
 *
 * Built from the options the application actually ships, so this cannot pass
 * against a pipe nobody runs.
 */
describe('QueryTicketsDto through the global ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'query',
    metatype: QueryTicketsDto,
  };

  const parse = (query: Record<string, string>) =>
    pipe.transform(query, metadata) as Promise<QueryTicketsDto>;

  it('applies the defaults when nothing is asked for', async () => {
    await expect(parse({})).resolves.toMatchObject({ page: 1, perPage: 20 });
  });

  // The case worth the whole file: three states, and the middle one is the
  // easiest to lose.
  it.each([
    ['true', true],
    ['false', false],
  ])('reads unassigned=%s as %s', async (raw, expected) => {
    const parsed = await parse({ unassigned: raw });

    expect(parsed.unassigned).toBe(expected);
  });

  it('leaves unassigned undefined when it is not asked for', async () => {
    const parsed = await parse({});

    expect(parsed.unassigned).toBeUndefined();
  });

  it('rejects an unassigned that is neither', async () => {
    await expect(parse({ unassigned: 'maybe' })).rejects.toThrow();
  });

  it('converts the numeric parameters', async () => {
    const parsed = await parse({ page: '3', perPage: '50' });

    expect(parsed.page).toBe(3);
    expect(parsed.perPage).toBe(50);
  });

  it('keeps the enum filters as they came', async () => {
    const parsed = await parse({
      status: TicketStatus.IN_PROGRESS,
      priority: TicketPriority.URGENT,
      category: TicketCategory.NETWORK,
    });

    expect(parsed.status).toBe(TicketStatus.IN_PROGRESS);
    expect(parsed.priority).toBe(TicketPriority.URGENT);
    expect(parsed.category).toBe(TicketCategory.NETWORK);
  });

  it('trims the search but keeps its case', async () => {
    // Unlike the user search, which lowercases: emails are compared as
    // lowercase everywhere, ticket titles are free text and `mode:
    // 'insensitive'` already does the work in the query.
    const parsed = await parse({ search: '  Printer  ' });

    expect(parsed.search).toBe('Printer');
  });

  it.each([
    ['a page below 1', { page: '0' }],
    ['a perPage above the cap', { perPage: '101' }],
    ['a status that is not one', { status: 'PONDERING' }],
    ['a priority that is not one', { priority: 'WHENEVER' }],
    ['a category that is not one', { category: 'VIBES' }],
    ['an assigneeId that is not a uuid', { assigneeId: 'someone' }],
    ['a requesterId that is not a uuid', { requesterId: 'someone' }],
  ])('rejects %s', async (_label, query) => {
    await expect(parse(query)).rejects.toThrow();
  });

  // whitelist + forbidNonWhitelisted, so a mistyped filter is a 400 rather than
  // a filter that silently did nothing.
  it('rejects an unknown parameter', async () => {
    await expect(parse({ unassignned: 'true' })).rejects.toThrow();
  });

  // The one field no DTO in this project accepts.
  it('rejects a tenantId', async () => {
    await expect(
      parse({ tenantId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow();
  });
});
