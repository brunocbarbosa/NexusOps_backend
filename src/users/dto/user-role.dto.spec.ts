import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../app.setup';
import { UserRole } from '../../generated/prisma/enums';
import { ASSIGNABLE_ROLES } from '../assignable-role';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';

/**
 * The escalation barrier.
 *
 * `UserRole` carries `ADMIN_MASTER`, and the write DTOs must not. Were they
 * `@IsEnum(UserRole)`, `POST /users { role: 'ADMIN_MASTER' }` from any company's
 * own ADMIN would mint a platform operator inside that company — an escalation
 * straight out of the tenant, which is the boundary this project exists to hold.
 *
 * The pipe here is built from the options the application actually ships, so this
 * cannot pass against a configuration nobody runs.
 */
describe('the assignable roles, through the global ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

  const parse = (metatype: ArgumentMetadata['metatype'], body: unknown) =>
    pipe.transform(body, { type: 'body', metatype });

  const validPassword = 'a-long-enough-password';

  it('does not offer ADMIN_MASTER as an assignable role', () => {
    expect(ASSIGNABLE_ROLES).not.toContain(UserRole.ADMIN_MASTER);
    expect([...ASSIGNABLE_ROLES]).toEqual([
      UserRole.ADMIN,
      UserRole.AGENT,
      UserRole.REQUESTER,
    ]);
  });

  it.each([...ASSIGNABLE_ROLES])('accepts %s on create', async (role) => {
    await expect(
      parse(CreateUserDto, {
        email: 'someone@acme.example',
        password: validPassword,
        role,
      }),
    ).resolves.toMatchObject({ role });
  });

  it('refuses ADMIN_MASTER on create', async () => {
    await expect(
      parse(CreateUserDto, {
        email: 'escalation@acme.example',
        password: validPassword,
        role: UserRole.ADMIN_MASTER,
      }),
    ).rejects.toThrow();
  });

  it('refuses ADMIN_MASTER on update — promoting is the same escalation', async () => {
    await expect(
      parse(UpdateUserDto, { role: UserRole.ADMIN_MASTER }),
    ).rejects.toThrow();
  });

  it('still refuses a role that is not one at all', async () => {
    await expect(parse(UpdateUserDto, { role: 'WIZARD' })).rejects.toThrow();
  });
});
