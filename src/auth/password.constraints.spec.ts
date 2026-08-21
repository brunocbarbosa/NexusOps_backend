import { validateSync } from 'class-validator';
import { BCRYPT_MAX_BYTES, MaxBytes } from './password.constraints';

class Subject {
  @MaxBytes(BCRYPT_MAX_BYTES)
  password: string;

  constructor(password: string) {
    this.password = password;
  }
}

const isValid = (password: string) =>
  validateSync(new Subject(password)).length === 0;

describe('MaxBytes', () => {
  it('accepts a password at exactly the limit', () => {
    expect(isValid('a'.repeat(72))).toBe(true);
  });

  // The limit bcrypt actually applies. Measured against bcrypt 6.0.0: hashing
  // 81 characters and comparing a different password sharing the first 72
  // returns true, so anything past this point is not part of the credential.
  it('refuses a password past the limit', () => {
    expect(isValid('a'.repeat(73))).toBe(false);
  });

  // Bytes, not characters: 72 emoji are 288 bytes, and bcrypt would keep 18 of
  // them. A @MaxLength(72) would have let this through.
  it('counts bytes rather than characters', () => {
    expect(isValid('😀'.repeat(19))).toBe(false);
    expect(isValid('😀'.repeat(18))).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(validateSync(new Subject(42 as unknown as string))).toHaveLength(1);
  });
});
