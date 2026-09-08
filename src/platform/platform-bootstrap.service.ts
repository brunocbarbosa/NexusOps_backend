import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashingService } from '../auth/hashing.service';
import { UserRole } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { TenantScopeService } from '../tenancy/tenant-scope.service';
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
    private readonly scope: TenantScopeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureAdminMaster();
  }

  /**
   * Deliberately **not** wrapped in a single transaction, which is where this
   * departs from what `AuthService.register` used to be.
   *
   * Register cannot be interrupted halfway: a tenant created without its first
   * ADMIN is a company nobody can ever log into, and nothing retries it. This
   * runs again on every boot, so a partial application self-heals on the next
   * start.
   *
   * **It is three scopes and not one, and that is the point.** A scope is now a
   * transaction, and the only reason this method was ever one block was that it
   * was not. Keeping it one would hold a database connection open across a
   * bcrypt hash at production cost — which is precisely what the paragraph above
   * refuses. So the read happens in its own scope, the hashing happens between
   * scopes, and the write happens in another.
   *
   * The cost is a read-then-write window: two boots racing each other could both
   * find no operator and both try to create one. The partial unique index on
   * `users` is what settles that — one of them fails, and the failure is a
   * crashed boot rather than a second operator.
   */
  async ensureAdminMaster(): Promise<void> {
    const email = this.config
      .getOrThrow<string>('ADMIN_MASTER_EMAIL')
      .trim()
      .toLowerCase();
    const password = this.config.getOrThrow<string>('ADMIN_MASTER_PASSWORD');

    const tenantId = await this.ensurePlatformTenant();

    // Found by role and not by email on purpose: keyed on the email, changing
    // ADMIN_MASTER_EMAIL would try to create a *second* operator and die on the
    // unique index. By role, the same change renames the one that exists.
    const existing = await this.scope.runWithTenant(tenantId, () =>
      this.prisma.user.findFirst({
        where: { role: UserRole.ADMIN_MASTER },
      }),
    );

    if (!existing) {
      // Outside the scope, so the transaction is not held open across it.
      const passwordHash = await this.hashing.hash(password);

      await this.scope.runWithTenant(tenantId, () =>
        this.prisma.user.create({
          data: tenantScoped({
            email,
            passwordHash,
            role: UserRole.ADMIN_MASTER,
          }),
        }),
      );

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

    // Re-hashed only when it actually changed. bcrypt salts randomly, so
    // hashing unconditionally would rewrite the row on every single boot for no
    // reason. Also outside the scope, for the same reason as above.
    const passwordHash = passwordIsCurrent
      ? undefined
      : await this.hashing.hash(password);

    await this.scope.runWithTenant(tenantId, () =>
      this.prisma.user.update({
        where: { id: existing.id },
        data: {
          email,
          ...(passwordHash === undefined ? {} : { passwordHash }),
          // A deactivated operator is restored rather than replaced — there is
          // only ever one row, and the index makes sure of it.
          deletedAt: null,
        },
      }),
    );

    this.logger.log(
      `Updated the ADMIN_MASTER (${email}) from the environment.`,
    );
  }

  /**
   * `Tenant` is the one tenant-agnostic model, so this needs `runWithoutTenant()`
   * — under a tenant scope the extension would rewrite the `where` to the current
   * tenant's id, and at boot there is no current tenant at all.
   */
  private async ensurePlatformTenant(): Promise<string> {
    const tenant = await this.scope.runWithoutTenant(() =>
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
