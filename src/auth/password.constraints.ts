import {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';

/**
 * bcrypt hashes at most 72 **bytes** and silently ignores the rest — measured
 * against bcrypt 6.0.0: hashing a 81-character password and then comparing a
 * different password sharing its first 72 characters returns `true`, and
 * `bcrypt.hash` does not throw on over-long input.
 *
 * So without this limit, "…72 identical bytes… plus anything" and "…72
 * identical bytes… plus anything else" are the same credential, and a user who
 * chose a long passphrase gets far less security than the length suggests.
 * Bytes and not characters, because one emoji is four of them.
 */
export const BCRYPT_MAX_BYTES = 72;

@ValidatorConstraint({ name: 'maxBytes', async: false })
class MaxBytesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [max] = args.constraints as [number];
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max;
  }

  defaultMessage(args: ValidationArguments): string {
    const [max] = args.constraints as [number];
    return `${args.property} must be at most ${max} bytes long (an accent or an emoji costs more than one)`;
  }
}

export function MaxBytes(max: number, options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [max],
      validator: MaxBytesConstraint,
    });
  };
}
