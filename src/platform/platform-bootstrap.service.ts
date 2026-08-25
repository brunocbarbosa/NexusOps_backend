import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashingService } from '../auth/hashing.service';
import { UserRole } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant, runWithoutTenant } from '../tenancy/tenant-context';
import { tenantScoped } from '../tenancy/tenant-scoped';
import {
  PLATFORM_TENANT_DOMAIN,
  PLATFORM_TENANT_NAME,
} from './platform.constants';

/**
 * Brings the single ADMIN_MASTER into existence, from the environment, at boot.
 *
 * There is no other way to create one: no route assigns the role (see
 * `ASSIGNABLE_ROLES`), and a partial unique index refuses a second row. So this
 * is the whole lifecycle of the account, and the `.env` is its source of truth —
 * rotating the password there, or changing the email, takes effect on the next
 * start.
 *
 * **Idempotent by design, not by luck.** It runs on every boot, including every
 * e2e suite's `createTestApp()`, so it has to converge rather than accumulate.
 */
@Injectable()
export class PlatformBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(PlatformBootstrapService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly hashing: HashingService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureAdminMaster();
  }

  /**
   * Deliberately **not** wrapped in a single transaction, which is where this
   * departs from `AuthService.register`.
   *
   * Register cannot be interrupted halfway: a tenant created without its first
   * ADMIN is a company nobody can ever log into, and nothing retries it. This
   * runs again on every boot, so a partial application self-heals on the next
   * start — and the alternative would hold a database connection open across a
   * bcrypt hash at production cost, which is what the register path already
   * refuses to do.
   */
  async ensureAdminMaster(): Promise<void> {
    const email = this.config
      .getOrThrow<string>('ADMIN_MASTER_EMAIL')
      .trim()
      .toLowerCase();
    const password = this.config.getOrThrow<string>('ADMIN_MASTER_PASSWORD');

    const tenantId = await this.ensurePlatformTenant();

    await runWithTenant(tenantId, async () => {
      // Found by role and not by email on purpose: keyed on the email, changing
      // ADMIN_MASTER_EMAIL would try to create a *second* operator and die on the
      // unique index. By role, the same change renames the one that exists.
      const existing = await this.prisma.user.findFirst({
        where: { role: UserRole.ADMIN_MASTER },
      });

      if (!existing) {
        await this.prisma.user.create({
          data: tenantScoped({
            email,
            passwordHash: await this.hashing.hash(password),
            role: UserRole.ADMIN_MASTER,
          }),
        });
        this.logger.log(`Created the ADMIN_MASTER (${email}).`);
        return;
      }

      const passwordIsCurrent = await this.hashing.compare(
        password,
        existing.passwordHash,
      );

      if (
        passwordIsCurrent &&
        existing.email === email &&
        existing.deletedAt === null
      ) {
        this.logger.log(`The ADMIN_MASTER (${email}) is already up to date.`);
        return;
      }

      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          email,
          // Re-hashed only when it actually changed. bcrypt salts randomly, so
          // hashing unconditionally would rewrite the row on every single boot
          // for no reason.
          ...(passwordIsCurrent
            ? {}
            : { passwordHash: await this.hashing.hash(password) }),
          // A deactivated operator is restored rather than replaced — there is
          // only ever one row, and the index makes sure of it.
          deletedAt: null,
        },
      });

      this.logger.log(
        `Updated the ADMIN_MASTER (${email}) from the environment.`,
      );
    });
  }

  /**
   * `Tenant` is the one tenant-agnostic model, so this needs `runWithoutTenant()`
   * — under a tenant scope the extension would rewrite the `where` to the current
   * tenant's id, and at boot there is no current tenant at all.
   */
  private async ensurePlatformTenant(): Promise<string> {
    const tenant = await runWithoutTenant(() =>
      this.prisma.tenant.upsert({
        where: { isPlatform: true },
        create: {
          name: PLATFORM_TENANT_NAME,
          domain: PLATFORM_TENANT_DOMAIN,
          isPlatform: true,
        },
        // Left alone: the name and domain are constants, and an operator who
        // renamed the row by hand had a reason.
        update: {},
      }),
    );

    return tenant.id;
  }
}
