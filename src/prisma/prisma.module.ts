import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PRISMA, createPrismaClient } from './prisma.client';
// `import type` is required: the constructor below is decorated, and with
// isolatedModules + emitDecoratorMetadata a value import of a type-only symbol
// is a compile error (TS1272).
import type { ExtendedPrismaClient } from './prisma.client';

/**
 * Provides the tenant-scoped Prisma client under the `PRISMA` token.
 *
 * Deliberately not `@Global()`. Making it global would save an import line per
 * feature module and cost the ability to read a module's dependencies off its
 * `imports` array — and "which modules touch the database" is exactly the
 * question worth being able to answer by looking.
 *
 * The module class, not a provider, owns the shutdown: the provider is a Prisma
 * proxy, and Nest only calls lifecycle hooks on instances that actually declare
 * them. `app.close()` triggers `onModuleDestroy`, so the e2e suites release
 * their pool without needing `enableShutdownHooks`.
 */
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        // getOrThrow rather than get: validateEnv already guarantees the value,
        // and `get` would type it as possibly-undefined for no reason.
        createPrismaClient(config.getOrThrow<string>('DATABASE_URL')),
    },
  ],
  exports: [PRISMA],
})
export class PrismaModule implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: ExtendedPrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
