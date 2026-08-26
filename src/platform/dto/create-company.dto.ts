import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmptyObject,
  IsString,
  Length,
  Matches,
  MinLength,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { BCRYPT_MAX_BYTES, MaxBytes } from '../../auth/password.constraints';
import { PLATFORM_TENANT_DOMAIN } from '../platform.constants';

// Both tolerate a non-string and hand it back untouched, so the type validator
// on the property reports it — a transform that threw would turn a wrong type
// into a 500 instead of a 400.
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** A hostname, like `acme.com` or `acme`. */
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The first ADMIN of the company being created.
 *
 * Mandatory, and this is a correctness constraint rather than a convenience. A
 * company with no ADMIN is one where `UsersService.assertNotLastAdmin` can never
 * be satisfied, where nobody can create the first user, and which nobody can log
 * into — an unreachable state with no route out of itself.
 */
export class CompanyAdminDto {
  @IsEmail()
  @Length(3, 255)
  @Transform(normalise)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxBytes(BCRYPT_MAX_BYTES)
  password: string;
}

export class CreateCompanyDto {
  @IsString()
  @Length(2, 255)
  @Transform(trim)
  name: string;

  // Required, unlike `Tenant.domain` in the schema. It is the login
  // discriminator — `User.email` is only unique within a company — so a company
  // without one is a company nobody can sign in to.
  @IsString()
  @Length(3, 100)
  @Matches(HOSTNAME, {
    message: 'domain must be a hostname, like acme.com or acme',
  })
  // The unique index would already answer 409, but that reads as "somebody took
  // it" when the truth is "this one is not for sale". Checked after @Transform,
  // so `PLATFORM` is caught too.
  @NotEquals(PLATFORM_TENANT_DOMAIN, {
    message: `domain "${PLATFORM_TENANT_DOMAIN}" is reserved for the platform itself`,
  })
  @Transform(normalise)
  domain: string;

  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => CompanyAdminDto)
  admin: CompanyAdminDto;
}
