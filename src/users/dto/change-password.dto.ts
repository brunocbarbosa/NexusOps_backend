import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { BCRYPT_MAX_BYTES, MaxBytes } from '../../auth/password.constraints';

export class ChangePasswordDto {
  // The policy of the day is not applied to the current password: it may
  // predate the policy, and rejecting it here would lock the user out of the
  // very route that fixes that.
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxBytes(BCRYPT_MAX_BYTES)
  newPassword: string;
}
