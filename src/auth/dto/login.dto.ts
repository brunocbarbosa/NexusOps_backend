import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

const normalise = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @IsString()
  @Length(3, 100)
  @Transform(normalise)
  tenantDomain: string;

  @IsEmail()
  @Length(3, 255)
  @Transform(normalise)
  email: string;

  // Deliberately only IsNotEmpty. Applying the registration password policy
  // here would answer "does this account use a short password?" with a 400
  // before any credential is checked, and it would lock out every account
  // created before a policy change.
  @IsString()
  @IsNotEmpty()
  password: string;
}
