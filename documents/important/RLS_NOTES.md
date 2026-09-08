# Row-Level Security

> **Status: provisioned, not enforcing.** The low-privilege role and the seven policies now exist —
> `scripts/initdb/01-app-role.sql` and the `row_level_security` migration. What does not exist is
> `set_config`: the application still connects with `DATABASE_URL`, as the owning superuser, which
> bypasses every policy. So step 1 of the four below is done, step 2 is done, and steps 3 and 4 are
> what stands between "configured" and "protecting anything". This document is the preparation for when that layer gets written, and it exists
> because the measurements below cost real debugging time — losing them would mean paying for them
> again.
>
> Never seen RLS before? [`../study/GUIA_RLS.md`](../study/GUIA_RLS.md) teaches it from zero, in
> Portuguese, and is the gentler way in.
>
> **Read [`../RLS_DESIGN.md`](../RLS_DESIGN.md) before building any of it.** This document says why
> the layer exists and what it must survive; that one says what shape it takes, and every decision
> in it is settled. The four steps below are still the right four, but each has detail there that
> they do not carry — step 2 in particular, where the obvious policy expression is wrong.

Two parts, as with the other references here, though the split lands differently because there is
nothing to integrate against yet.

**Part I is the work that remains**: why this layer exists, the four steps to build it, and how to
tell whether it is actually doing anything once built. It is what someone picking up this task
needs, and it is deliberately first.

**Part II is the measured behaviour**: three traps that were measured against this repository's own
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
2. **Create the policies** and apply `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. **Seven** tables
   need them: `users`, `tickets`, `comments`, `audit_logs`, `refresh_tokens`, `ticket_counters` and
   `reports` — the last two arrived with the helpdesk slice, after an earlier version of this list
   was written, and both carry `tenant_id` and are scoped by the extension exactly like the others.
   `tenants` is the tenant rather than being scoped by one, and `_prisma_migrations` is not
   application data. Write the comparison as
   `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`; without the `nullif` the
   policy raises an error instead of returning nothing, for the reason in Part II.
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

All three of the following were measured against this repository's own container, not taken from
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
and takes the value out of scope at commit. The array form of `$transaction` does not give that
guarantee. "Out of scope" is not "back to unset", and the difference is the third trap.

### A transaction-local setting does not go back to unset

Once a connection has served one scoped transaction, `current_setting('app.tenant_id', true)` on it
returns the **empty string** rather than NULL, forever after. There is no way back: passing NULL to
`set_config` writes `''` too. Measured against this repository's container, PostgreSQL 17.11:

| the connection                    | `current_setting('app.tenant_id', true)` |
| --------------------------------- | ---------------------------------------- |
| fresh                             | `NULL`                                   |
| has served one scoped transaction | `''`                                     |

This matters because the obvious policy expression is
`tenant_id = current_setting('app.tenant_id', true)::uuid`, and `''::uuid` does not evaluate to
NULL — it raises `22P02 invalid input syntax for type uuid: ""`. So a query made outside any scope
returns zero rows on a connection the pool has not used yet and **errors** on one it has, which is
the opposite of the fail-closed behaviour the whole design leans on. Worse, a test written against a
freshly built pool passes.

`nullif(current_setting('app.tenant_id', true), '')::uuid` restores it: measured, zero rows on a
`SELECT` and `42501` on an `INSERT`, on a fresh connection and a recycled one alike.

One more thing that follows, and is easy to get wrong when writing the tests: **`42501` aborts the
transaction like any other error.** A test that asserts a refusal and then keeps using the same
transaction gets `25P02 current transaction is aborted` on everything after it. Take expected
refusals inside a `SAVEPOINT`.
