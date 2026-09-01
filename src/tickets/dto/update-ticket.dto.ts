import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { TicketCategory, TicketPriority } from '../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Not `PartialType(CreateTicketDto)`, for the same reason the other update DTOs
 * in this repository are not: inheriting the create shape means inheriting
 * every field somebody adds to it later, including ones that must never be
 * settable after creation. Each field is re-declared on purpose.
 *
 * `status` and `assigneeId` are absent. They have their own routes because they
 * are not edits, they are workflow: they carry side effects (`resolvedAt`,
 * `closedBy`) and a narrower role check than editing a title does.
 */
export class UpdateTicketDto {
  /**
   * The version the client last read. Required, not optional.
   *
   * Optional would mean "overwrite whatever is there", which is exactly the
   * silent last-write-wins this column exists to prevent. A client that has not
   * read the ticket has no business updating it.
   */
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  @Transform(trim)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 10000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;
}
