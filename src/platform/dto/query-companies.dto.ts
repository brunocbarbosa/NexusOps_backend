import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Tri-state, unlike `QueryUsersDto.includeDeleted`: absent means "both", so
 * `undefined` has to survive rather than collapse to `false`.
 *
 * The `@Type(() => String)` below is load-bearing for the same measured reason
 * documented in `query-users.dto.ts`: the global pipe runs with
 * `enableImplicitConversion`, that conversion happens *before* `@Transform`, and
 * `Boolean('false')` is `true`. Without it, `?isActive=false` would list the
 * active companies — the exact opposite of the question.
 */
const asOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class QueryCompaniesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;

  /** Matched against the name and the domain, case-insensitively. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Transform(normalise)
  search?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(asOptionalBoolean)
  @Type(() => String)
  isActive?: boolean;
}
