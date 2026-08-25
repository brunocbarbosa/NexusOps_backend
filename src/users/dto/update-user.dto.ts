import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, Length } from 'class-validator';
import { ASSIGNABLE_ROLES } from '../assignable-role';
import type { AssignableRole } from '../assignable-role';

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Not `PartialType(CreateUserDto)`.
 *
 * That would inherit `password`, and changing somebody else's password through
 * the same route that renames them is exactly the shape that lets an
 * over-broad admin action become an account takeover. Passwords change through
 * `PATCH /users/me/password`, which demands the current one.
 */
export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  @Length(3, 255)
  @Transform(normalise)
  email?: string;

  // Never ADMIN_MASTER — promoting an existing user into the platform role is the
  // same escalation as creating one. See src/users/assignable-role.ts.
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: AssignableRole;
}
