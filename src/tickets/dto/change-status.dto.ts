import { IsEnum, IsInt, Min } from 'class-validator';
import { TicketStatus } from '../../generated/prisma/enums';

/**
 * `@IsEnum(TicketStatus)` and not a carved-out subset: every one of the four
 * values is reachable from some state, so there is no privileged member to keep
 * out of the DTO the way `ADMIN_MASTER` is kept out of the role DTOs.
 *
 * Which transitions are legal is a question about the ticket's current status,
 * not about the payload, so it is answered in the service against
 * `TICKET_TRANSITIONS` — a DTO cannot see the row.
 */
export class ChangeStatusDto {
  @IsInt()
  @Min(1)
  version: number;

  @IsEnum(TicketStatus)
  status: TicketStatus;
}
