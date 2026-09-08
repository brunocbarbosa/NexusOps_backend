-- Row-Level Security: the second isolation layer.
--
-- Hand-written, and created with `prisma migrate dev --create-only`, because
-- Prisma does not model RLS -- there is nothing in schema.prisma for it to
-- diff. See documents/RLS_DESIGN.md, Part I, for the reasoning behind every
-- choice below, and documents/study/GUIA_RLS.md if this is new to you.
--
-- Ordering requirement: the role `nexusops_app` must already exist. It is
-- created by scripts/initdb/01-app-role.sql, which both compose files mount
-- into /docker-entrypoint-initdb.d and which runs at container creation --
-- before any migration. A development container created before that script
-- existed does not have the role, and this migration will refuse to apply
-- until `npm run infra:reset` recreates it. That destroys local data, and
-- there is no way around it: creating the role from a migration would write
-- its password into committed SQL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexusops_app') THEN
    RAISE EXCEPTION
      'The role "nexusops_app" does not exist, so these policies would have '
      'nobody to protect against and the GRANTs below cannot run. It is created '
      'by scripts/initdb/01-app-role.sql at container creation; an existing '
      'container needs `npm run infra:reset` (this destroys local data). See '
      'documents/study/GUIA_RLS.md.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The role owns nothing and gets DML only. No DDL, no TRUNCATE: the test
-- suites truncate to reset, and they do that as the owner through DATABASE_URL
-- precisely so that the application role never needs a privilege that would let
-- it empty a tenant's tables in one statement.

GRANT USAGE ON SCHEMA public TO nexusops_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "tenants",
  "users",
  "tickets",
  "comments",
  "audit_logs",
  "refresh_tokens",
  "ticket_counters",
  "reports"
TO nexusops_app;

-- `tenants` is granted but carries no policy: it *is* the tenant rather than
-- being scoped by one, and login has to find it before any tenant identity
-- exists. `_prisma_migrations` is granted nothing -- the application never
-- reads it, and the migration runner connects as the owner.

-- Without this, the next migration that adds a model breaks the application in
-- production while every test stays green, because the test database is built
-- by the same migration run that created the table -- and so the owner sees it
-- and the application role does not. A trap with a delay on it.
--
-- No `FOR ROLE`: default privileges attach to the role running this statement,
-- which is the owner in every environment (`nexusops` locally, `nexusops_test`
-- in the suites). Naming one would silently do nothing in the other.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexusops_app;

-- There are no sequences today -- every primary key is a uuid. This covers the
-- day one arrives, because a table with an `autoincrement()` column is unusable
-- without USAGE on the sequence behind it, and that failure would look like a
-- permissions bug in application code.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nexusops_app;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
--
-- One policy per tenant-scoped table, all identical.
--
-- `USING` covers reads, UPDATE and DELETE; `WITH CHECK` covers INSERT and the
-- UPDATE that tries to move a row into another tenant. Without the second half
-- the policy still allows writing *out* of the tenant, which is the half that
-- is easy to forget.
--
-- `nullif(..., '')` is not decoration. A transaction-local setting never goes
-- back to unset: once a connection has served one scoped transaction, its reset
-- value is the empty string rather than NULL, and `''::uuid` raises
-- `22P02 invalid input syntax for type uuid` instead of yielding NULL. Without
-- the nullif this policy fails *loudly and non-deterministically* -- zero rows
-- on a connection the pool has not used yet, an error on one it has. Measured;
-- see documents/important/RLS_NOTES.md.
--
-- No `TO` clause, so the policy applies to every role that is subject to RLS.
--
-- `FORCE` subjects the table **owner** to the policies, which the owner
-- otherwise escapes. Measured here: it buys nothing in this repository's own
-- containers, because `POSTGRES_USER` is made a superuser by initdb and a
-- superuser bypasses RLS unconditionally -- FORCE does not reach it. As the
-- owner, an INSERT with no tenant set still succeeds.
--
-- It goes on anyway, for production. A managed PostgreSQL rarely hands out a
-- real superuser, so the role that owns the tables and runs the migrations
-- there *is* subject to these policies once FORCE is set -- which is the case
-- FORCE exists for, and the only one in which it does anything.
--
-- That asymmetry is the trap, and it points the opposite way from the obvious
-- reading: a future migration that backfills data (`UPDATE tickets SET ...`)
-- touches every row locally, where the owner is a superuser, and can silently
-- touch **zero** rows in production, where it is not. Such a migration has to
-- set the tenant per statement, or wrap itself in
-- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and put FORCE back.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tickets" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tickets"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comments" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "comments"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_tokens"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "ticket_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_counters" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ticket_counters"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reports" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reports"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
