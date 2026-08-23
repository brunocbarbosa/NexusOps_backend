# Row-Level Security

> **Status: not implemented.** There is no policy, no `set_config` and no low-privilege role in the
> code today. This document is the preparation for when that layer gets written, and it exists
> because the measurements below cost real debugging time — losing them would mean paying for them
> again.

Two parts, as with the other references here, though the split lands differently because there is
nothing to integrate against yet.

**Part I is the work that remains**: why this layer exists, the four steps to build it, and how to
tell whether it is actually doing anything once built. It is what someone picking up this task
needs, and it is deliberately first.

**Part II is the measured behaviour**: two traps that were measured against this repository's own
container and that will otherwise be rediscovered the expensive way.

---

## Part I — the work that remains

### Why RLS, if the extension already filters

The Prisma Client extension in `src/tenancy/` is the first layer of isolation between tenants. RLS
is the **second**, deliberately redundant one, for the case where the first is bypassed — raw SQL,
or a defect in the extension itself.

`$queryRaw` / `$executeRaw` are client operations, not model operations, and never go through the
extension. That is the concrete hole RLS closes. See
[`TENANCY_EXTENSION.md`](./TENANCY_EXTENSION.md) for what the extension covers and what it cannot
reach.

### The four steps

1. **Provision a `NOSUPERUSER NOBYPASSRLS` role that does not own the tables**, with DML only.
   `.env.example` already reserves `DATABASE_URL_APP` for it; migrations keep using the owning
   role. Without this step every other step is decoration — see Part II.
2. **Create the policies** and apply `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. Five tables need
   them: `users`, `tickets`, `comments`, `audit_logs`, `refresh_tokens`. `tenants` is the tenant
   rather than being scoped by one, and `_prisma_migrations` is not application data.
3. **Set the tenant with `set_config('app.tenant_id', $1, true)`** inside an **interactive**
   `$transaction(async (tx) => ...)`. Not `SET`, and not outside a transaction — both fail, in
   different and non-obvious ways described in Part II.
4. **Write the integration tests that prove the policies block cross-tenant access.**
   `docker-compose.test.yml` will need to provision the low-privilege role for that.

Step 4 is what turns this layer from "configured" into "verified", and it is not optional
diligence: without it the policies may be inert while every catalogue view reports success.

### How to tell whether RLS is actually on

The failure mode this layer invites is silence — a configuration that looks complete and enforces
nothing. Three queries answer it, and they are worth running after each of the steps above rather
than at the end.

**Is the connecting role able to bypass everything?** This is the first question, because a `t` in
either column makes the other two queries meaningless:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

**Is RLS on, and forced?** `relrowsecurity` without `relforcerowsecurity` still lets the table
owner through:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM   pg_class
WHERE  relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER  BY relname;
```

**Do the policies exist?**

```sql
SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public';
```

Run today against the development container, as the application's own user, they report the state
this document describes:

```
 rolname  | rolsuper | rolbypassrls
----------+----------+--------------
 nexusops | t        | t
```

Every table comes back `f | f`, and `pg_policies` is empty. The first line is the one that matters:
even with policies in place and `FORCE` applied, that `t` would make all of them dead weight.

None of these three prove enforcement — only step 4 does. They prove the _absence_ of enforcement
quickly, which is the failure this layer is prone to.

---

## Part II — measured behaviour

Both of the following were measured against this repository's own container, not taken from
documentation.

### A superuser bypasses RLS, and `FORCE` does not help

RLS will be inert in this project until the application stops connecting as `nexusops`. Two
mechanisms, and the second is the one that bites:

- The **table owner** bypasses RLS. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` fixes that case.
- A **superuser** bypasses RLS unconditionally, and `FORCE` does _not_ help. `docker-compose.yml`
  sets `POSTGRES_USER=nexusops`, and `initdb` makes that role a superuser: `pg_roles` reports
  `rolsuper = t, rolbypassrls = t`. So with the default `DATABASE_URL`, every policy is dead
  weight while `pg_policies` still shows the setup as correct — a silent failure that looks like
  protection.

The fix is a dedicated low-privilege role holding DML only, not owning the tables and not a
superuser; migrations keep using the owning role. `.env.example` reserves `DATABASE_URL_APP` for it.
Verified: as `nexusops` a tenant-scoped query returned every tenant's rows even with `FORCE` on; as
a `NOSUPERUSER NOBYPASSRLS` non-owner it returned only the scoped rows, and zero rows with no tenant
set.

### Setting the tenant must be transaction-scoped, and `SET` cannot do it

Two traps:

1. `prisma.$executeRaw` always parameterizes interpolated values, and PostgreSQL's `SET` accepts no
   bind parameters — `` $executeRaw`SET app.tenant_id = ${tenantId}` `` fails every call with
   `42601: syntax error at or near "$1"`. Use `set_config` instead.
2. `@prisma/adapter-pg` sends any query outside `$transaction()` straight to the `pg.Pool`, one
   checkout per call, so a standalone `set_config` and the following query can land on different
   physical connections — and a session-scoped value lingers on whichever connection last set it.
   Under concurrency that yields _another single tenant's_ rows, intermittently. Measured on a pool
   of 4 with 60 concurrent requests: 46 of 60 observed the wrong tenant. Pinning one connection per
   request and using transaction-local scope brought it to 0 of 60.

So the tenant must be set with `set_config('app.tenant_id', $1, true)` — the third argument is
`is_local` — inside an **interactive** `$transaction(async (tx) => ...)`, which pins one connection
and resets the value at commit. The array form of `$transaction` does not give that guarantee.
