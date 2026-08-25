import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  NotEquals,
} from 'class-validator';
import { PLATFORM_TENANT_DOMAIN } from '../platform.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Not `PartialType(CreateCompanyDto)`: that would inherit `admin`, and creating
 * a second first-ADMIN through the rename route is not a thing that should be
 * expressible. Users are managed at `/platform/companies/:companyId/users`.
 *
 * `isActive: false` is the suspension switch — `AuthService.login` already
 * refuses an inactive tenant, so it locks the whole company out without
 * touching a single user row.
 */
export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @Length(2, 255)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(3, 100)
  @Matches(HOSTNAME, {
    message: 'domain must be a hostname, like acme.com or acme',
  })
  @NotEquals(PLATFORM_TENANT_DOMAIN, {
    message: `domain "${PLATFORM_TENANT_DOMAIN}" is reserved for the platform itself`,
  })
  @Transform(normalise)
  domain?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
