import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';
import { BCRYPT_MAX_BYTES, MaxBytes } from '../../auth/password.constraints';
import { UserRole } from '../../generated/prisma/enums';

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * No `tenantId` field, and not by omission: the extension stamps it, and a
 * field here would be a way to ask for another tenant. The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so sending one is a 400.
 */
export class CreateUserDto {
  @IsEmail()
  @Length(3, 255)
  @Transform(normalise)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxBytes(BCRYPT_MAX_BYTES)
  password: string;

  // Optional so that the common case — adding a requester — needs no thought.
  // The schema default is REQUESTER, which is also the least privileged.
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
