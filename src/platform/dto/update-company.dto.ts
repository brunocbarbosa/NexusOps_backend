import { Transform, Type } from 'class-transformer';
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

const asOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

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

  /**
   * The suspend switch, and the reason this file carries the same three
   * decorators the query DTOs do.
   *
   * `enableImplicitConversion` converts by the property's declared type rather
   * than by the value's, and it does that in a JSON body just as much as in a
   * query string — measured, not assumed. `Boolean('false')` is `true`, so
   * `{"isActive": "false"}` used to **reactivate** the company the caller was
   * asking to suspend, with a 200 and no way to notice. `@Type(() => String)`
   * redirects the conversion so the raw value reaches `@Transform`, which maps
   * the two strings that mean something and hands anything else back for
   * `@IsBoolean()` to reject.
   *
   * `update-company.dto.spec.ts` is the guard.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(asOptionalBoolean)
  @Type(() => String)
  isActive?: boolean;
}
