import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, Length } from 'class-validator';
import { UserRole } from '../../generated/prisma/enums';

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

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
