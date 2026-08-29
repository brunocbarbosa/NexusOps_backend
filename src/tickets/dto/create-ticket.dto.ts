import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { TicketCategory, TicketPriority } from '../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * No `requesterId` and no `number`, and neither is an omission.
 *
 * The requester is the caller: an agent opening a ticket on someone else's
 * behalf is a real workflow and it is not this one, so rather than accept a
 * field the service would have to police, the route simply does not offer it.
 * The number comes from the tenant's counter, which is the only thing that can
 * hand out a sequence without a race.
 *
 * No `tenantId` either, for the reason it is absent from every DTO here: the
 * extension stamps it, and `forbidNonWhitelisted` makes sending one a 400.
 */
export class CreateTicketDto {
  @IsString()
  @Length(3, 255)
  @Transform(trim)
  title: string;

  // Bounded even though the column is `text`: an unbounded body is an
  // unbounded request, and nothing here needs a novel.
  @IsOptional()
  @IsString()
  @Length(1, 10000)
  @Transform(trim)
  description?: string;

  // Optional so the common case needs no thought. Both fall back to the schema
  // defaults, MEDIUM and OTHER.
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;
}
