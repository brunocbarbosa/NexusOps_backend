import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { tenantIsolationExtension } from '../tenancy/tenant-extension';

/**
 * The one place a Prisma client is built.
 *
 * Two things are non-negotiable here and both are documented in CLAUDE.md: the
 * `pg` driver adapter, which Prisma 7 requires for SQL providers, and
 * `$extends(tenantIsolationExtension)`, which is what makes "I forgot to scope
 * this query" unreachable. A client constructed anywhere else has neither, so
 * this factory exists to make the un-extended client the awkward path rather
 * than the default one.
 *
 * The integration suites call this too. A test that builds its own client is a
 * test that proves nothing about the client the application actually runs — the
 * only exception is `test/integration/tenant-isolation.int-spec.ts`, which
 * deliberately uses a bare client to show what the schema does *without* the
 * extension.
 */
export function createPrismaClient(connectionString: string) {
  // Pool settings live on the adapter in v7, not on PrismaClient.
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter }).$extends(tenantIsolationExtension);
}

/**
 * `$extends` returns a proxy whose type is not `PrismaClient`, so the usual
 * `class PrismaService extends PrismaClient` pattern cannot be used and the type
 * has to be inferred from the factory.
 */
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * Injection token for the client above. It lives next to the factory because
 * every call site needs both — the token to inject and the type to annotate —
 * and importing them from the module file instead would point feature modules
 * at `PrismaModule` for a type they only use structurally.
 */
export const PRISMA = Symbol('PRISMA');
