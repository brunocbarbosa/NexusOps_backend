-- The role the application connects as, and the whole reason Row-Level Security
-- can work at all.
--
-- A superuser bypasses RLS unconditionally, and `FORCE ROW LEVEL SECURITY` does
-- not help -- measured, see documents/important/RLS_NOTES.md. `POSTGRES_USER`
-- is made a superuser by initdb, so an application connecting with
-- `DATABASE_URL` would sail through every policy while `pg_policies` still
-- reported the setup as correct. That is the failure this file prevents.
--
-- It is `NOSUPERUSER NOBYPASSRLS` and it does **not** own the tables: the owner
-- is `POSTGRES_USER`, which keeps running the migrations. Ownership matters
-- because the owner escapes policies too, and `FORCE` is what subjects it --
-- so the application is kept out of that question entirely by not being one.
--
-- Privileges are deliberately not granted here. The role exists at cluster
-- level and the tables do not exist yet when this runs, so the `GRANT`s live in
-- the RLS migration alongside the policies, together with the
-- `ALTER DEFAULT PRIVILEGES` that covers tables a future migration adds.
--
-- **This runs once, when the container is created.** The ephemeral test stack is
-- created fresh on every run and CI gets it for free, but an existing
-- development container will not pick it up: that costs `npm run infra:reset`,
-- which destroys local data. See documents/study/GUIA_RLS.md.

\getenv app_password POSTGRES_APP_PASSWORD

\if :{?app_password}
\else
\echo ''
\echo 'FATAL: POSTGRES_APP_PASSWORD is not set.'
\echo '       The application role cannot be created without it, and the'
\echo '       application would then fall back to connecting as the superuser,'
\echo '       where every RLS policy is silently inert. Refusing to initialise.'
\echo ''
DO $$ BEGIN RAISE EXCEPTION 'POSTGRES_APP_PASSWORD is not set'; END $$;
\endif

-- `format(%L)` rather than string interpolation: the password is a literal, and
-- %L is what quotes and escapes it correctly. Interpolating it directly would
-- break on any password containing a quote -- and break by creating a role with
-- the *wrong* password, which fails later and somewhere else.
SELECT format(
  'CREATE ROLE nexusops_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
  :'app_password'
)
\gexec
