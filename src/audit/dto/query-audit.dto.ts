import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AUDIT_ACTIONS } from '../audit.events';
import type { AuditAction } from '../audit.events';

const ACTIONS = Object.values(AUDIT_ACTIONS);

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `@IsIn(ACTIONS)` rather than `@IsEnum`: `action` is a `varchar` in the
 * schema, not a PostgreSQL enum, so there is no generated enum to validate
 * against. The column is a string on purpose — the trail has to accept actions
 * from entities that do not exist yet without a migration.
 */
export class QueryAuditDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;

  @IsOptional()
  @IsIn(ACTIONS)
  @Transform(trim)
  action?: AuditAction;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  // Who did it. A uuid rather than an email, because the trail keeps the id
  // even after the user row is anonymised.
  @IsOptional()
  @IsUUID()
  userId?: string;
}
