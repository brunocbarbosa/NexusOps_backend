import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

/**
 * Password hashing, isolated from everything that uses it.
 *
 * Two reasons it is a service rather than two free functions: the cost factor
 * comes from configuration, and the unit tier needs one place to stub so that
 * service specs are not dominated by key derivation.
 */
@Injectable()
export class HashingService implements OnModuleInit {
  private readonly rounds: number;

  /**
   * A hash of a value nobody knows, used to spend the same time on a login for
   * an account that does not exist as on one that does. Without it, "no such
   * tenant" answers in a millisecond and "wrong password" in fifty, which turns
   * the login endpoint into an account-enumeration oracle no matter how careful
   * the error message is.
   */
  private decoyHash: string;

  constructor(config: ConfigService) {
    this.rounds = config.getOrThrow<number>('BCRYPT_SALT_ROUNDS');
  }

  // Built at boot from the configured cost, not hard-coded: a bcrypt hash
  // carries its own cost factor, so a fixed decoy would burn a different amount
  // of time than the real hashes and reintroduce the very difference it exists
  // to hide.
  async onModuleInit(): Promise<void> {
    this.decoyHash = await this.hash(randomUUID());
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** For the not-found path. Always false; the point is the time it takes. */
  async compareWithDecoy(plain: string): Promise<false> {
    await bcrypt.compare(plain, this.decoyHash);
    return false;
  }
}
