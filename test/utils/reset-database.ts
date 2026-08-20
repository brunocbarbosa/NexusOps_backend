import { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Empties every domain table, for suites that need a known-empty database
 * rather than fixtures they clean up themselves.
 *
 * The table list is read from PostgreSQL instead of being hard-coded. A
 * hard-coded list is a list that goes stale the first time someone adds a model
 * and forgets this file — and the failure is silent: the new table simply never
 * gets cleared, and a later suite fails somewhere unrelated with leftover rows.
 *
 * `_prisma_migrations` is excluded; truncating it would make Prisma believe the
 * database has never been migrated.
 *
 * Runs against the unextended client on purpose. This is raw SQL, which never
 * reaches the tenancy extension anyway (see CLAUDE.md > Architecture), and
 * clearing "every tenant" is exactly the intent here.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  if (tables.length === 0) {
    return;
  }

  // One statement, so CASCADE resolves the foreign keys between them and the
  // order of the list stops mattering.
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}
