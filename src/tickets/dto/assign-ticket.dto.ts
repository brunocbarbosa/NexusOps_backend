import { IsInt, IsUUID, Min, ValidateIf } from 'class-validator';

/**
 * `assigneeId` is nullable but not optional, and the distinction is the whole
 * point of the DTO: `null` means "unassign", and leaving the field out means
 * the client forgot. `@IsOptional()` would collapse the two into each other and
 * make an incomplete request silently unassign a ticket.
 *
 * `@ValidateIf` is what allows an explicit `null` through while still requiring
 * a UUID for anything else — `@IsUUID()` alone rejects `null`, and `undefined`
 * still fails because `undefined !== null` leaves the validator switched on.
 */
export class AssignTicketDto {
  @IsInt()
  @Min(1)
  version: number;

  @ValidateIf((dto: AssignTicketDto) => dto.assigneeId !== null)
  @IsUUID()
  assigneeId: string | null;
}
