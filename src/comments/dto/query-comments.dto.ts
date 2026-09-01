import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Page and size only.
 *
 * There is deliberately no `includeInternal` flag: who sees the internal notes
 * is decided by the caller's role, not by what the caller asks for. A filter
 * here would be a filter a requester could flip.
 */
export class QueryCommentsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;
}
