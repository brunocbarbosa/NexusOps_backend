import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../../generated/prisma/enums';

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `Boolean('false')` is `true`, and the global ValidationPipe runs with
 * `enableImplicitConversion`, so `?unassigned=false` becomes `true` — the exact
 * opposite of the question asked, with no error anywhere.
 *
 * A `@Transform` alone does not fix it: the implicit conversion runs first, so
 * the transform receives a boolean that is already wrong. `@Type(() => String)`
 * is what redirects the conversion and leaves the raw text for this to read.
 * The full measurement is in USERS.md, Part II; `query-tickets.dto.spec.ts` is
 * what keeps it from regressing here.
 *
 * This variant preserves `undefined` rather than collapsing it to `false`,
 * because the filter is tri-state: unassigned, assigned, or don't care.
 */
const asOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class QueryTicketsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  // Capped so one request cannot ask for a company's entire ticket history.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;

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

  // A REQUESTER may send this and it will be overridden by their own id: the
  // visibility scope is applied after every filter, on purpose. See
  // `TicketsService.findAll`.
  @IsOptional()
  @IsUUID()
  requesterId?: string;

  // The agent's queue. Contradicting it with `assigneeId` is a 400 rather than
  // a silent winner, because either interpretation would be a guess.
  @IsOptional()
  @IsBoolean()
  @Transform(asOptionalBoolean)
  @Type(() => String)
  unassigned?: boolean;

  // `contains` over title and description, both unindexed. Bounded by the
  // tenant filter already, and an index goes in when there is a measurement
  // asking for one.
  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Transform(normalise)
  search?: string;
}
