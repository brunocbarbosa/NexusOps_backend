import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../app.setup';
import { UpdateCompanyDto } from './update-company.dto';

/**
 * `isActive` is the switch that suspends a company, so getting its value
 * backwards is the worst possible failure mode for this DTO.
 *
 * The global pipe runs with `enableImplicitConversion`, which converts by the
 * property's declared type rather than by the value's — in a JSON body as much
 * as in a query string. `Boolean('false')` is `true`, so `{"isActive":
 * "false"}` used to **reactivate** a company that the caller was asking to
 * suspend, silently and with a 200.
 *
 * Found while writing `CreateCommentDto`, which had the same defect.
 */
describe('UpdateCompanyDto through the global ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: UpdateCompanyDto,
  };

  const parse = (body: Record<string, unknown>) =>
    pipe.transform(body, metadata) as Promise<UpdateCompanyDto>;

  it('leaves isActive undefined when it is not asked for', async () => {
    await expect(parse({ name: 'Acme' })).resolves.toMatchObject({
      isActive: undefined,
    });
  });

  it.each([
    ['a real boolean true', true, true],
    ['a real boolean false', false, false],
    ['the string true', 'true', true],
    // The one that mattered.
    ['the string false', 'false', false],
  ])('reads %s as %s', async (_label, raw, expected) => {
    const parsed = await parse({ isActive: raw });

    expect(parsed.isActive).toBe(expected);
  });

  it.each([
    ['a string that is neither', 'maybe'],
    ['a number', 0],
  ])('rejects %s', async (_label, raw) => {
    await expect(parse({ isActive: raw })).rejects.toThrow();
  });
});
