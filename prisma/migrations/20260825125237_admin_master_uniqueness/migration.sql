-- At most one ADMIN_MASTER, enforced by the database rather than by the code that
-- happens to create it.
--
-- This lives in its own migration on purpose. PostgreSQL refuses to *use* an enum
-- value that was added in the same transaction ("unsafe use of new value of enum
-- type"), and Prisma runs each migration file in one transaction -- so the
-- ALTER TYPE ... ADD VALUE 'ADMIN_MASTER' of the previous migration and this index,
-- which references that value, cannot share a file.
--
-- No `AND deleted_at IS NULL` filter: exactly one row, always. A deactivated
-- ADMIN_MASTER is restored by the bootstrap, never replaced by a second one.
--
-- Known cost: a partial index is not expressible in schema.prisma, so
-- `prisma migrate dev` reads it as drift and will offer to drop it. Keep it.
CREATE UNIQUE INDEX "users_single_admin_master"
  ON "users" ((true))
  WHERE "role" = 'ADMIN_MASTER';
