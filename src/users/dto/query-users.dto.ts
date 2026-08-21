import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { UserRole } from '../../generated/prisma/enums';

/**
 * `Boolean('false')` is `true`, so `enableImplicitConversion` — which the
 * global ValidationPipe runs with — turns `?includeDeleted=false` into `true`,
 * the exact opposite of what was asked, silently.
 *
 * A `@Transform` alone does **not** fix it, which is the part worth writing
 * down: measured with the real pipe, the implicit conversion runs first, so the
 * transform receives a `boolean` that is already wrong and `'false'` and
 * `'maybe'` both arrive as `true`. `@Type(() => String)` on the property is
 * what redirects the conversion, leaving the raw text for this to read.
 * `src/users/dto/query-users.dto.spec.ts` is the guard.
 */
const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const asBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false || value === undefined) return false;
  return value;
};

export class QueryUsersDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  // Capped so that one request cannot ask for a tenant's entire user table and
  // the response size stays bounded no matter who calls it.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  // A `contains` on an unindexed column, and deliberately so: the scan is
  // already bounded by the tenant filter, and a tenant's user table is small
  // by nature. If that stops being true, the index goes in with a measurement
  // behind it.
  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Transform(normalise)
  search?: string;

  // ADMIN only; the service refuses it for anyone else rather than quietly
  // ignoring it, so a caller is never told "no deleted users" when the real
  // answer is "you may not ask".
  // @IsBoolean after the transform, so `?includeDeleted=maybe` is a 400 rather
  // than a truthy string sneaking through.
  @IsOptional()
  @IsBoolean()
  @Transform(asBoolean)
  @Type(() => String)
  includeDeleted: boolean = false;
}
