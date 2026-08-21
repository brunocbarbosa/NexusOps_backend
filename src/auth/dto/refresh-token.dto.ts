import { IsJWT } from 'class-validator';

/**
 * Used by both `POST /auth/refresh` and `POST /auth/logout` — same field, same
 * meaning, and two identical classes would drift apart the first time one of
 * them gained a validation rule.
 *
 * `@IsJWT()` only checks the shape. The signature is verified in the service,
 * against the refresh key; the point here is that obvious rubbish is a 400
 * instead of reaching the verification path at all.
 */
export class RefreshTokenDto {
  @IsJWT()
  refreshToken: string;
}
