import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import {
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The filters that define a report, and nothing else.
 *
 * Deliberately **not** `QueryTicketsDto`: that one carries `page` and `perPage`,
 * which mean nothing here — a report is every matching row up to
 * `REPORTS_MAX_ROWS`, and offering a page size would invite a client to ask for
 * a report of twenty tickets and wonder why it went to a queue.
 *
 * It is also not `unassigned`, for a smaller reason: this is a JSON body, so
 * `assigneeId: null` says it directly and the tri-state query-string dance is
 * not needed.
 */
export class TicketReportFiltersDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsUUID()
  requesterId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Transform(trim)
  search?: string;
}
