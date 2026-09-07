# Row-Level Security — implementation design

> **Status: design, not implemented.** This is the plan for the second isolation layer that
> [`important/RLS_NOTES.md`](./important/RLS_NOTES.md) has been holding measurements for. Three
> decisions are settled and recorded below with their reasoning; **two are still open** and are
> collected in the last section. Nothing here has been built.

The companion document, `important/RLS_NOTES.md`, answers "what did we measure and what remains".
This one answers "what shape does the implementation take, and what does it cost". Read that one
first: everything below assumes its two traps, and none of them are re-argued here.

---

## The constraint that forces the whole design

RLS enforces per **connection session**. The tenant reaches PostgreSQL through
`set_config('app.tenant_id', $1, true)`, whose third argument makes the value transaction-local,
and it has to be set on the same physical connection as the query that follows it — which, with
`@prisma/adapter-pg`, is only guaranteed inside an interactive `$transaction`.

Everything else follows from that one fact. A policy that reads `current_setting` returns **zero
rows** when the setting is absent, and it does so without an error. So enabling RLS is not a change
that can be made halfway: the moment the application connects as a role that cannot bypass it,
every query in the codebase must be inside a transaction that has set the tenant, or it silently
returns nothing.

Fail-closed is the right default here, and it is worth saying why the silence is acceptable: the
alternative is a policy that lets an unset tenant through, which is a bypass with extra steps.

### One correction to `RLS_NOTES.md`

That document lists **five** tables needing policies. It was written before the helpdesk slice
landed. There are **seven**: `ticket_counters` and `reports` both carry `tenant_id` and are scoped
by the extension exactly like the others.

| Table                | Policy | Why                                                |
| -------------------- | ------ | -------------------------------------------------- |
| `users`              | yes    |                                                    |
| `tickets`            | yes    |                                                    |
| `comments`           | yes    |                                                    |
| `audit_logs`         | yes    |                                                    |
| `refresh_tokens`     | yes    |                                                    |
| `ticket_counters`    | yes    | missing from `RLS_NOTES.md`                        |
| `reports`            | yes    | missing from `RLS_NOTES.md`                        |
| `tenants`            | no     | it _is_ the tenant rather than being scoped by one |
| `_prisma_migrations` | no     | not application data                               |

Whoever implements this should fix the list in `RLS_NOTES.md` in the same branch, or the stale
count will be believed again.

---

## Part I — the database layer

### Two roles, two jobs

| Role           | What it is                                        | Who connects with it                                             |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `nexusops`     | container superuser, owns the tables              | `prisma migrate`, `prisma studio`, `resetDatabase` in the suites |
| `nexusops_app` | `NOSUPERUSER NOBYPASSRLS`, not an owner, DML only | the running application                                          |

`DATABASE_URL` keeps pointing at `nexusops` and keeps being what migrations use.
`DATABASE_URL_APP` — which `.env.example` already reserves — becomes what `PrismaModule` injects.

Two consequences for `src/config/env.validation.ts`: `DATABASE_URL_APP` becomes required, and the
two URLs must be refused when equal. That second check is the same shape as the one already
guarding the two JWT keys, and for the same reason — a configuration where they match is not a
misconfiguration that announces itself, it is RLS that is quietly inert.

### Where the role is born

A `scripts/initdb/01-app-role.sql` mounted into `/docker-entrypoint-initdb.d` by **both** compose
files, with the password supplied through `POSTGRES_APP_PASSWORD` in `.env` / `.env.test` — the same
pattern the existing `POSTGRES_*` variables already follow, and the same reason one compose file
serves local runs and CI.

It runs once, when the container is created. That fits the ephemeral test stack perfectly, since it
is created fresh on every run, and it fits CI for free. The cost lands on development: **an existing
dev container only gets the role after `npm run infra:reset`**, which destroys local data. That has
to be in the README, not only here.

Alternatives considered and rejected: putting `CREATE ROLE` in a Prisma migration would write the
role's password into committed SQL and would use a migration to create a cluster-level object; a
standalone script in `scripts/` would work in production unchanged but adds a step someone can
forget to run.

### The policies

A hand-written migration, created with `prisma migrate dev --create-only` because Prisma does not
model RLS. For each of the seven tables:

```sql
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "users"
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`USING` covers reads, `UPDATE` and `DELETE`. `WITH CHECK` covers `INSERT` and the `UPDATE` that
tries to move a row into another tenant — **without it the policy would still allow writing out of
the tenant**, which is the half of the problem that is easy to forget.

The `true` is `missing_ok`. With no setting, `current_setting` yields `NULL`, the comparison yields
`NULL`, and no row qualifies.

`FORCE` goes on even though the application role is not the owner, because `FORCE` is what subjects
the **owner** to the policies. Without it, the day somebody runs a script with `DATABASE_URL` the
isolation disappears with no signal.

### Grants

In the same migration: `GRANT SELECT, INSERT, UPDATE, DELETE` on the seven tables plus `tenants`,
`GRANT USAGE ON SCHEMA public`, and `ALTER DEFAULT PRIVILEGES` so that a table created by a future
migration is reachable when it is created. Skipping the default privileges is a trap with a delay
on it: the next migration that adds a model breaks the application in production, and no test
catches it because the test database is built by the same migration run.

**Ordering:** the role must exist before the migration that grants to it. initdb runs at container
creation and migrations run afterwards, so dev, test and CI are ordered by construction. Production
becomes a documented provisioning step.

---

## Part II — the runtime

### Where the transaction is opened

In `runWithTenant()`, not in the HTTP interceptor. Every entry point already goes through it — the
interceptor, the BullMQ processor, the WebSocket gateway, the boot-time bootstrap — so none of them
needs to remember anything. This is the same chokepoint argument the tenancy extension is built on.

```
runWithTenant(id, fn)
  └─ prisma.$transaction(async tx => {
       await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
       return storage.run({ tenantId: id, tx }, fn);
     }, { timeout: 15_000, maxWait: 5_000 })
```

The timeout rises from Prisma's 5s default because login runs a bcrypt comparison inside the scope.
It stays a commented constant rather than becoming another environment variable.

`runWithoutTenant()` opens **no** transaction. The only model it reaches today is `Tenant`, which
has no policy; and a query that escaped into a scoped table would return zero rows anyway, because
a transaction-local setting is already gone by the time the next statement runs on that connection.

### The import cycle this creates, and the way out

`prisma.client.ts` imports `tenant-extension.ts`, which imports `tenant-context.ts`. Having
`tenant-context.ts` import the client to open a transaction closes the cycle.

The proposed way out is to invert it: `tenant-context.ts` gains a `registerTenantSessionOpener()`
that `PrismaModule` calls once at boot, and `runWithTenant` throws if a scope is opened before that
registration has happened. Mutable module state is not pretty, and it is preferred here only
because an import cycle is worse. **This is open decision #1.**

### The proxy

`createPrismaClient` returns a `Proxy` over the extended client:

- **model delegates, `$queryRaw*`, `$executeRaw*`** → the `tx` in the ALS store when there is one;
  the base client when there is not (which, under RLS, fails closed).
- **`$connect` / `$disconnect`** → always the base client. Without this exception,
  `PrismaModule.onModuleDestroy` stops releasing the pool and the e2e suites hang on shutdown.
- **`$transaction`** becomes **re-entrant**, in both of its forms. Given a callback, it runs it with
  the transaction that already exists rather than opening another — Prisma would not allow the
  nesting anyway. Given an array, it awaits the elements in order: they were created _on the
  transaction_ by this same proxy, so they are already in one transaction and the batching was only
  ever a round-trip optimisation.

Re-entrancy is what makes the nine existing `$transaction` call sites keep working untouched. It
also means `TicketsService.mutate()` — which opens an interactive transaction so that 404 and 409
stay distinguishable — starts using the request's transaction instead of its own, with no edit.

### Nesting, and what it costs

A `runWithTenant` inside a `runWithTenant` for the **same** tenant reuses the open transaction. For a
**different** tenant it must open a second one, because the setting is transaction-local and there
is no way to have two values on one connection.

The platform routes are the real case. `TenantContextInterceptor` opens the scope for the platform
tenant and holds it for the whole request; `company-users.controller.ts` then calls `inCompany()`,
which resolves the company and opens `runWithTenant(company.id)` inside it. **Peak of two pooled
connections per platform request.** The pool has to be sized knowing that, which means exposing
`max` on `PrismaPg` — it is at the driver default today.

### What changes in `ReportsProcessor`

This is the only domain code the design forces to change, and it is not cosmetic. Today a single
`runWithTenant` wraps the entire job, paging loop included; under this design that becomes one
transaction held for the length of an export.

It becomes one scope per unit of work: one for the initial `setStatus`, one per page inside
`collect()`, one for the final update, one for the failure path. The file's header comment — the
canonical worked example of the worker pattern, referenced from `CLAUDE.md` — explains why
everything runs inside one scope, and has to be rewritten to explain why it no longer does.
**This is open decision #2.**

---

## Part III — tests and CI

A new `test/integration/rls.int-spec.ts`, covering both what the three diagnostic queries in
`RLS_NOTES.md` report and what only step 4 can prove:

1. the connected role is neither `rolsuper` nor `rolbypassrls`;
2. all seven tables report `relrowsecurity` **and** `relforcerowsecurity`;
3. `pg_policies` has a policy per table;
4. as the application role, raw SQL outside any scope returns zero rows;
5. inside a scope it returns that tenant's rows and no others;
6. a cross-tenant `INSERT` is refused by `WITH CHECK`.

Items 1–3 are cheap and prove only the absence of enforcement. Items 4–6 are the ones that turn
this layer from configured into verified.

`resetDatabase` keeps connecting as the owner: it issues `TRUNCATE`, which is a privilege the
application role does not have and should not get. So the suites carry two connection strings, and
`test/utils/create-test-app.ts` has to build the application against `DATABASE_URL_APP` while the
cleanup helper keeps `DATABASE_URL`.

CI needs `DATABASE_URL_APP` and `POSTGRES_APP_PASSWORD` added to the `docker` job's boot step, which
feeds the container `.env.test` values. The role itself arrives through the test compose file's
initdb mount, so no separate provisioning step is needed there.

---

## Part IV — decisions already settled

Recorded so the reasoning is not re-litigated later.

**RLS enforces on every query, not only on raw SQL.** The alternative was to give the ORM role
`BYPASSRLS` and route only raw SQL through a restricted client. That closes exactly the hole
`RLS_NOTES.md` names, at nearly zero runtime cost — but it leaves the layer unable to catch a defect
in the extension, which is half of why `CLAUDE.md` calls the second layer "deliberately redundant".
And there is no raw SQL in `src/` today, so it would be protection against a future that has not
arrived.

**The role is provisioned by an initdb script in the compose files**, not by a Prisma migration and
not by a standalone script. Reasoning in Part I.

**The transaction is scoped to `runWithTenant`, and the report worker pages in scopes** rather than
holding one transaction for the whole job. The uniform alternative — one scope, no exceptions — is a
simpler rule but puts a pool connection under an export of arbitrary length and invites
`idle_in_transaction_session_timeout`.

---

## Part V — open decisions

**#1 — `registerTenantSessionOpener()`.** Opening the transaction inside `runWithTenant` requires
`tenant-context.ts` to reach the Prisma client, which closes an import cycle. The proposal is
one-time registration at boot, with a loud failure if a scope is opened before it. It is mutable
module state, and it is the least attractive part of this design. Alternatives not yet explored in
depth: moving the ALS store into the prisma module, or accepting a lazily-resolved import.

**#2 — rewriting `ReportsProcessor`.** The change is required by the per-scope transaction
decision, and it touches the file `CLAUDE.md` holds up as the example of how a worker re-establishes
tenant identity. The question is not whether it can be done but whether it should be done here, or
whether the worker deserves a different treatment that leaves it intact.

---

## Part VI — the risk worth writing down

Holding a transaction for the duration of a request changes the application's failure profile.
Today a slow request is slow; afterwards, a slow request holds a pooled connection, and under
enough concurrency pool exhaustion turns latency into errors. The mitigations are the 15s timeout,
a deliberately sized pool, and measurement.

"Measurement" here means a number in this document once the layer exists — connections held per
request shape, and what concurrency the configured pool actually sustains — not a promise that it
was considered.
