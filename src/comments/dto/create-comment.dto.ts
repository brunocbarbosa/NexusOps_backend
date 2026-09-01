import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `Boolean('yes')` is `true`, and so is `Boolean('false')`.
 *
 * The global pipe runs with `enableImplicitConversion`, and this was measured
 * to apply to a **JSON body**, not only to a query string: `{"isInternal":
 * "yes"}` arrived as `true`, passed `@IsBoolean()`, and reached the service as
 * a genuine request for an internal note. The `"false"` case is the dangerous
 * one — a staff member asking for a visible comment would have got a hidden one.
 *
 * The fix is the same three decorators `QueryTicketsDto` uses, for the same
 * reason: `@Type(() => String)` redirects the implicit conversion so the raw
 * text reaches `@Transform`, which maps only the two strings that mean
 * something and hands anything else back untouched for `@IsBoolean()` to
 * reject as a 400. `create-comment.dto.spec.ts` is the guard.
 */
const asOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/**
 * No `ticketId` and no `authorId`. The ticket is in the path and the author is
 * the caller, so neither is a field somebody could get wrong — or aim
 * somewhere else.
 */
export class CreateCommentDto {
  @IsString()
  @Length(1, 10000)
  @Transform(trim)
  body: string;

  // Defaulting to false rather than to the author's role: a note that hides
  // itself from the customer should be asked for, never inferred.
  @IsOptional()
  @IsBoolean()
  @Transform(asOptionalBoolean)
  @Type(() => String)
  isInternal?: boolean;
}
