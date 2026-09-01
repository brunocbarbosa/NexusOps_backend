import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../app.setup';
import { CreateCommentDto } from './create-comment.dto';

/**
 * The measurement that made this file exist.
 *
 * `enableImplicitConversion` is usually discussed as a query-string problem,
 * because that is where everything arrives as text. It is not: the pipe runs
 * over a JSON body too, and it converts by the property's declared type rather
 * than by the value's. A body of `{"isInternal": "yes"}` therefore became
 * `true` — it passed `@IsBoolean()` and reached the service as a real request
 * for an internal note. Caught by the e2e suite, not by any unit test.
 *
 * `metatype` is `body` here rather than `query`, which is the whole point.
 */
describe('CreateCommentDto through the global ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: CreateCommentDto,
  };

  const parse = (body: Record<string, unknown>) =>
    pipe.transform(body, metadata) as Promise<CreateCommentDto>;

  it('leaves isInternal undefined when it is not asked for', async () => {
    const parsed = await parse({ body: 'hello' });

    expect(parsed.isInternal).toBeUndefined();
  });

  it.each([
    ['a real boolean true', true, true],
    ['a real boolean false', false, false],
    ['the string true', 'true', true],
    // The case worth the file: this used to arrive as `true`.
    ['the string false', 'false', false],
  ])('reads %s as %s', async (_label, raw, expected) => {
    const parsed = await parse({ body: 'hello', isInternal: raw });

    expect(parsed.isInternal).toBe(expected);
  });

  it.each([
    ['a string that is neither', 'yes'],
    ['a number', 1],
    ['an object', {}],
  ])('rejects %s', async (_label, raw) => {
    await expect(parse({ body: 'hello', isInternal: raw })).rejects.toThrow();
  });

  it('trims the body and rejects an empty one', async () => {
    await expect(parse({ body: '  spaced  ' })).resolves.toMatchObject({
      body: 'spaced',
    });
    await expect(parse({ body: '   ' })).rejects.toThrow();
  });

  // whitelist + forbidNonWhitelisted: the author and the ticket come from the
  // request, never from the payload.
  it.each([
    ['an authorId', { authorId: '00000000-0000-4000-8000-000000000000' }],
    ['a ticketId', { ticketId: '00000000-0000-4000-8000-000000000000' }],
    ['a tenantId', { tenantId: '00000000-0000-4000-8000-000000000000' }],
  ])('rejects %s', async (_label, extra) => {
    await expect(parse({ body: 'hello', ...extra })).rejects.toThrow();
  });
});
