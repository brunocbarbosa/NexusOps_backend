import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';
import { BCRYPT_MAX_BYTES, MaxBytes } from '../password.constraints';

// Both tolerate a non-string and hand it back untouched, so that the type
// validator on the property is what reports it — a transform that threw would
// turn a wrong type into a 500 instead of a 400.
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Trims and lowercases. E-mails and domains are compared case-insensitively. */
const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Creates a tenant and its first ADMIN in one call.
 *
 * This is the only way either of them can come into existence, so it is public
 * — there is no authenticated user to authorise it, by definition. Everything
 * after it goes through an authenticated ADMIN.
 */
export class RegisterDto {
  @IsString()
  @Length(2, 255)
  @Transform(trim)
  tenantName: string;

  // The login discriminator. `User.email` is only unique within a tenant, so
  // something has to say which company is meant, and the domain is the one
  // identifier a company already knows.
  @IsString()
  @Length(3, 100)
  @Matches(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    {
      message: 'tenantDomain must be a hostname, like acme.com or acme',
    },
  )
  @Transform(normalise)
  tenantDomain: string;

  @IsEmail()
  @Length(3, 255)
  @Transform(normalise)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxBytes(BCRYPT_MAX_BYTES)
  password: string;
}
