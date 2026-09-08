# Row-Level Security — implementation design

> **Status: design, not implemented.** This is the plan for the second isolation layer that
> [`important/RLS_NOTES.md`](./important/RLS_NOTES.md) has been holding measurements for. **Every
> decision is settled**; Part IV has all six with their reasoning. **Part I is built** — the role,
> the policies, the grants and the two connection strings are in the repository, verified against a
> stack created from scratch. Parts II and III are not: the application still connects with
> `DATABASE_URL`, as the owning superuser, so **the policies are provisioned and enforce nothing
> yet**. That is deliberate — it keeps this change from breaking anything — and it is also why the
> layer cannot be called done. Four of the six — #0, #1, #2 and #3 — came from reading the call
> sites against this design and measuring what it would do to them, and all four changed something,
> so Part II describes the design they produced rather than the one this document started with.

If Row-Level Security itself is new to you, [`study/GUIA_RLS.md`](./study/GUIA_RLS.md) teaches it
from zero, in Portuguese, and covers this design in plain language before you read it here.

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
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

`USING` covers reads, `UPDATE` and `DELETE`. `WITH CHECK` covers `INSERT` and the `UPDATE` that
tries to move a row into another tenant — **without it the policy would still allow writing out of
the tenant**, which is the half of the problem that is easy to forget.

The `true` is `missing_ok`. **The `nullif` is not decoration**, and an earlier draft of this section
omitted it: without it the policy raises an error instead of returning nothing, on any connection
that has already served one scope. There is no way to put a custom GUC back to unset —
`set_config(x, NULL, true)` writes the empty string, and once a transaction-local set has committed
the connection's _reset value_ is `''` rather than NULL. Measured against PostgreSQL 17.11:

| the connection                    | `current_setting('app.tenant_id', true)` | bare `::uuid`                                  | with `nullif` |
| --------------------------------- | ---------------------------------------- | ---------------------------------------------- | ------------- |
| fresh                             | `NULL`                                   | `NULL` — no row qualifies                      | no rows       |
| has served one scoped transaction | `''`                                     | `22P02 invalid input syntax for type uuid: ""` | no rows       |

So the bare expression fails **loudly, and non-deterministically** — which of the two happens
depends on the connection the pool handed out. Worse for a design that leans on fail-closed: Part
III's item 4 would pass against a freshly built pool and lie in production. With `nullif(..., '')`
both connections behave alike, measured: zero rows on a `SELECT`, `42501` on an `INSERT`.

`nullif` earns its place a second time in Part II. Leaving a nested scope has to put the enclosing
one back, and "back to unscoped" can only be written as `set_config(..., '')` — so the policy has to
read `''` as "no tenant" rather than as a malformed uuid. The two are one mechanism.

`FORCE` goes on even though the application role is not the owner, because `FORCE` is what subjects
the **owner** to the policies — but not here, and the difference matters. Measured against this
repository's own container after the migration landed: as the owner, an `INSERT` with no tenant set
still succeeds. `POSTGRES_USER` is made a superuser by initdb, and a superuser bypasses RLS
unconditionally, which `FORCE` does not reach. So locally it buys nothing, and "somebody runs a
script with `DATABASE_URL`" loses its isolation with or without it.

It goes on for production, where a managed PostgreSQL rarely hands out a real superuser and the
owning role therefore _is_ subject to the policies. That asymmetry has a consequence pointing the
opposite way from the obvious reading, and it belongs in the head of whoever writes the next data
migration: **a backfill touches every row locally and can silently touch zero in production.**

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

In the scope, not in the HTTP interceptor. Every entry point already opens a scope — the
interceptor, the BullMQ processor, the WebSocket gateway, the boot-time bootstrap — so none of them
needs to remember anything. This is the same chokepoint argument the tenancy extension is built on.

**Every scope is a transaction, `runWithoutTenant()` included, and a nested scope reuses the one
that is already open.** One rule, no exceptions; settled decision #0 in Part IV records why the
narrower version of it does not work.

```
run(id | null, fn)                     // id === null is runWithoutTenant

  no transaction in the store yet  ->  it opens one and owns it
     prisma.$transaction(async tx => {
       if (id !== null) await setConfig(tx, id);      // unscoped opens no GUC at all
       return storage.run({ tenantId: id, tx, pending: [] }, fn);
     }, { timeout: 15_000, maxWait: 5_000 })
     ...then, after it commits, drain `pending`      // settled decision #3

  a transaction already in the store  ->  it borrows it
     const previous = store.tenantId;
     await setConfig(tx, id);                         // '' when id is null
     try    { return await storage.run({ ...store, tenantId: id }, fn); }
     finally{ await setConfig(tx, previous); }        // put the enclosing scope back
```

The timeout rises from Prisma's 5s default to leave room for the slowest thing a scope can hold. It
stays a commented constant rather than becoming another environment variable.

**Not because of login**, which is what an earlier draft of this line said. `AuthService.login`
closes its scope at `auth.service.ts:63`, before the `hashing.compare` on line 70, and
`RefreshTokenService.issue` hashes with sha256 rather than bcrypt. The one place that genuinely
holds bcrypt inside a `runWithTenant` is `PlatformBootstrapService.ensureAdminMaster`, which hashes
_and_ compares in there — and that file's own comment refuses exactly that ("the alternative would
hold a database connection open across a bcrypt hash at production cost"). It runs once at boot on
one connection, so the cost is nothing; it is the comment that would become false. **So
`ensureAdminMaster` splits**: read the existing operator in one scope, do the bcrypt work outside
any scope, write in a second one. That honours the comment rather than deleting it, and it costs a
read-then-write window at boot that the file already accepts by refusing to be one transaction —
the partial unique index on `users` is what actually stops a second operator.

`runWithoutTenant()` opens a transaction too, without ever setting `app.tenant_id`. It reads no
policed table today — `Tenant` is the one model in `TENANT_AGNOSTIC` — so the transaction buys it
nothing on its own; what it buys is that the store always holds a `tx`, which is what makes the
proxy re-entrant everywhere and is the whole of settled decision #0.

### How a scope reaches the client

Opening a transaction means reaching a live `PrismaClient`, and `tenant-context.ts` cannot import
one: the instance is built by `PrismaModule`'s factory from validated configuration, so it exists
only at runtime. It arrives by injection.

Three files, split by what they are:

| File                            | What is in it                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `tenant-store.ts` (new, a leaf) | the `AsyncLocalStorage` instance and the `Store` type — imports nothing of ours    |
| `tenant-context.ts`             | the readers: `requireTenantId`, `currentScope`, `TenantContextMissingError`        |
| `tenant-scope.service.ts` (new) | `TenantScopeService` — `runWithTenant` and `runWithoutTenant`, and the transaction |

The readers stay free functions because what consumes them is the extension, which is not a Nest
provider and never will be. `tenant-extension.ts` imports exactly those three names today, so it
does not change, and neither does anything else that only reads.

`TenantScopeService` is **provided and exported by `PrismaModule`**, next to the client it needs.
That costs nothing in the module graph: every feature module in `src/` already imports
`PrismaModule`, including the two whose scope-opening class does not inject `PRISMA` itself
(`AuditListener`, `CompanyUsersController`).

The methods keep the names `runWithTenant` and `runWithoutTenant` rather than shortening to
`run`/`runUnscoped`. Those two names appear 55 times across `CLAUDE.md` and eight documents; keeping
them means a call site gains a receiver and every sentence written about them stays true.

**`TenantContextInterceptor` is the exception, and it is not resolved by the container.**
`configureApp` constructs it by hand — `new TenantContextInterceptor()` — precisely because it has
had no dependency until now. It gets one here, so `configureApp` resolves the service from the
application it was handed:

```ts
app.useGlobalInterceptors(
  new TenantContextInterceptor(app.get(TenantScopeService)),
);
```

That keeps the interceptor registered in `app.setup.ts`, which is the second chokepoint in this
repository and the reason an e2e test exercises the same wiring production runs. Making it an
`APP_INTERCEPTOR` provider instead would get the injection for free and move that registration out
of the one file that is supposed to hold it. `app.setup.spec.ts`'s fake application grows a `get`.

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

Re-entrancy is what makes all nine existing `$transaction` call sites keep working untouched — but
only because every scope now registers a transaction. Under the narrower rule this document started
with, the ninth (`CompaniesService.create()`) died; settled decision #0 in Part IV has the
measurement. Of the nine, the five array-form pagination sites are `[count, findMany]` built inline
inside the scope, so what their comments claim — "the total matches the page" — gets stronger rather
than weaker: a real transaction replaces Prisma's batch.

Two of the nine keep working while quietly changing what they guarantee, and both are worth naming
because a comment in each file would otherwise stop being true:

- `TicketsService.create()` holds the `ticket_counters` row lock until the **request** commits
  rather than until the create commits. Still correct — the numbers stay unique — but per-tenant
  contention on ticket creation grows from two statements to a whole request. Material for Part VI.
- `TicketsService.mutate()` — which opens an interactive transaction so that 404 and 409 stay
  distinguishable — starts using the request's transaction instead of its own, with no edit. Its
  `emit` therefore moves inside an open transaction, against the comment directly above it that says
  "After the transaction, never inside it". Settled decision #3 keeps that comment true by deferring
  the emit to after the commit rather than by editing the file.

### Events, and why they are deferred

A scope that **owns** its transaction carries a `pending` queue; a scope that borrows one does not.
`DomainEvents.emit(name, event)` enqueues when a transaction is open and emits immediately when none
is, so no emit site in `src/` changes shape — the three services that hold an `EventEmitter2` today
(`tickets.service`, `comments.service`, `reports.processor`) hold a `DomainEvents` instead. The
owning scope drains the queue after the commit, un-awaited, which is exactly what an emit does
today; a rollback discards it.

This is settled decision #3, and Part IV records what it is protecting against. `ReportsProcessor`
needs no special case: under the per-scope rewrite its `announce()` falls outside the small scopes,
`DomainEvents` sees no transaction, and it emits immediately.

### Nesting, and what it costs

A nested scope always reuses the open transaction, for the same tenant and for a different one
alike. The setting is transaction-local and one connection can only hold one value at a time, so a
different tenant is served by **re-emitting** `set_config` on the way in and putting the enclosing
scope's value back on the way out.

The platform routes are the real case. `TenantContextInterceptor` opens the scope for the platform
tenant and holds it for the whole request; `company-users.controller.ts` then calls `inCompany()`,
which resolves the company and opens `runWithTenant(company.id)` inside it. **One pooled connection
per request, platform routes included.** The pool still has to be sized deliberately, which means
exposing `max` on `PrismaPg` — it is at the driver default today — but not for this reason.

The restore is the part that is easy to skip and must not be. Without it, the ALS store says the
enclosing tenant while the database session still says the inner one, and the two layers this design
calls "deliberately redundant" would quietly disagree — which is the exact failure RLS is here to
catch. No call site queries after a nested scope today; that is an accident of the current code and
not something to lean on.

The whole lifecycle in one transaction, measured against PostgreSQL 17.11 as a `NOBYPASSRLS` role:

```
runWithoutTenant opens it, no GUC -> SELECT users   0 rows
unscoped INSERT into users                          refused [42501]
enter scope A: set_config + INSERT                   1 row
  A sees                                             1 rows
enter NESTED scope B: set_config + INSERT            1 row
  B sees (A invisible)                               1 rows
  cross-tenant write from inside B                  refused [42501]
leave B -> restore A                                 1 rows (A only)
leave A -> restore unscoped with ''                  0 rows
  writing while restored-unscoped                   refused [42501]
COMMIT                                              ok
re-scoped to A in a NEW transaction                  1 rows
```

Restoring "unscoped" is `set_config(..., '')`, because there is no way back to unset (Part I). That
line only reads as zero rows rather than as a `22P02` **because** the policy wraps the setting in
`nullif` — the two halves are one mechanism, not two independent fixes.

One consequence for whoever writes the tests: an expected refusal has to be taken inside a
`SAVEPOINT`. `42501` aborts the transaction like any other error, so a test that asserts a refusal
and then keeps using the same transaction gets `25P02` on everything after it.

### What changes in `ReportsProcessor`

This is the only domain code the design forces to change, and it is not cosmetic. Today a single
`runWithTenant` wraps the entire job, paging loop included; leaving it that way would make it one
transaction held for the length of an export.

It becomes one scope per unit of work: one for the initial `setStatus`, one per page inside
`collect()`, one for the final update, one for the failure path — which means the `try` moves inside
the job rather than wrapping a single scope. Settled decision #2 in Part IV records what the
alternative would and would not have bought.

Two consequences worth having in mind while writing it. Each page scope owns a transaction, so
`TicketsService.findAll`'s `$transaction([count, findMany])` goes re-entrant inside it and a page's
total matches its own rows — per page, which is all it ever claimed. And `announce()` stays outside
the scopes, so `DomainEvents` sees no open transaction and emits immediately, which is exactly the
"emitted after the row is written" the file's comment already promises.

The file's header comment — the canonical worked example of the worker pattern, referenced from
`CLAUDE.md` — explains why everything runs inside one scope, and has to be rewritten to explain why
it no longer does. It gets better rather than worse: it goes from "the worker has no request, so
re-establish the identity explicitly" to that plus "and a scope is a unit of work, not a job", which
is the sentence the second worker will need.

---

## Part III — tests and CI

A new `test/integration/rls.int-spec.ts`, covering both what the three diagnostic queries in
`RLS_NOTES.md` report and what only step 4 can prove:

1. the connected role is neither `rolsuper` nor `rolbypassrls`;
2. all seven tables report `relrowsecurity` **and** `relforcerowsecurity`;
3. `pg_policies` has a policy per table;
4. as the application role, raw SQL outside any scope returns zero rows;
5. inside a scope it returns that tenant's rows and no others;
6. a cross-tenant `INSERT` is refused by `WITH CHECK`;
7. a nested scope sees only its own tenant, and **leaving it restores the enclosing one** — the
   guard for settled decision #0, and the one that fails if the restore is dropped;
8. `CompaniesService.create()` still creates a company, its counter and its first ADMIN — the call
   site that the narrower rule killed, kept as a regression rather than as a story in Part IV;
9. a mutation that rolls back emits nothing, and the audit row for one that commits lands after the
   commit — the guard for settled decision #3;
10. a ticket export runs to completion as the application role — the worker is what `CLAUDE.md`
    calls the most likely place in the project for a tenant leak, and settled decision #2 is the one
    that changes how it reaches the database.

Items 1–3 are cheap and prove only the absence of enforcement. Items 4–10 are the ones that turn
this layer from configured into verified.

**An expected refusal has to be taken inside a `SAVEPOINT`.** `42501` aborts the transaction like
any other error, so items 6 and 7 leave the transaction in `25P02` for everything after them unless
they roll back to a savepoint. Measured while writing Part II, by getting it wrong first.

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

**#0 — every scope is a transaction, `runWithoutTenant()` included, and a nested scope reuses it.**
This is about how a scope reaches the database, and it does not reopen the entry above it: that one
is about how much work belongs _in_ one scope, and the worker still pages in several. A scope always
has a transaction; a job is still not one scope.

The narrower rule this document started with — `runWithoutTenant()` opens none, a different tenant
opens a second transaction — breaks `CompaniesService.create()`, the one call site that changes
tenant scope in the middle of a transaction it opened by hand. With no `tx` in the store, the outer
`$transaction` is not re-entrant and opens **T1** unregistered; the inner `runWithTenant()` then
opens **T2** on a second connection and sets the tenant there, while the body keeps writing through
the lexically captured `tx`, which is T1. Measured, as a `NOBYPASSRLS` role against real policies:

```
T1 insert tenant (no policy):         OK
does T1 have app.tenant_id?           NULL
write through the LEXICAL tx (T1):    42501  new row violates row-level security policy
redirect that write to T2 instead:    23503  foreign key violation
```

The second line is why there is no cheap repair: T2 cannot take the writes, because T1's `tenants`
row has not committed. Making every scope a transaction makes the outer `$transaction` re-entrant,
which puts both halves on one connection — the lifecycle is measured in Part II. It costs the
argument that `runWithoutTenant()` needs no transaction, one round trip per nested scope exit for
the restore, and a split in `PlatformBootstrapService.ensureAdminMaster` so that bcrypt stays
outside the scope. It buys back the two-connection peak on platform requests.

**#1 — the scope opener is an injected provider, not a registered singleton.** The alternative was
`registerTenantSessionOpener()`: a module-level `let` in `tenant-context.ts` that `PrismaModule`
sets once at boot, with `runWithTenant` throwing if a scope is opened before it. It keeps every
call site and all 160 test call sites untouched, which is a real advantage and not the deciding one.

Two things had to be checked first, and both came back against the version of this document that
proposed it.

_There is no import cycle._ Part II used to justify the registered singleton as the lesser of two
evils, the greater being a cycle from `tenant-context.ts` back to `prisma.client.ts`. There is
none: the client arrives as a runtime argument, so the only import needed is `import type`, and that
is erased. Measured by adding exactly that import and the `let` to `tenant-context.ts` —
`npm run typecheck` passes over both configs, and the emitted JavaScript contains one `require`,
for `node:async_hooks`. So the cycle was never the cost, and the decision is not a trade against it.

_The premise for the provider was also wrong, in the one place that matters._ The case for injection
was that every scope-opening class is resolved by Nest. Eight of the nine are.
`TenantContextInterceptor` is not: `configureApp` builds it with `new`, and its own comment says why
("It needs no injected dependency, so it belongs here rather than as an APP_INTERCEPTOR provider").
It needs one now, and the answer is `app.get(TenantScopeService)` at the same registration site —
Part II. Not free, but three lines.

What decides it is an argument already written in `prisma.module.ts`, about a different question.
That module is deliberately not `@Global()`, because making it global would "cost the ability to
read a module's dependencies off its `imports` array — and 'which modules touch the database' is
exactly the question worth being able to answer by looking". A registered singleton is that global,
minus the visibility: `runWithTenant` would keep the shape of a pure `AsyncLocalStorage` helper
while opening a database transaction on a client the class never declared. The provider makes a
class that opens transactions say so in its constructor, which is the same rule the codebase already
holds itself to. It also removes the "throws if a scope is opened before boot" branch, which exists
only to catch an ordering Nest already guarantees.

The cost, honestly counted: eight constructors gain a parameter, the interceptor gains an
`app.get()`, `app.setup.spec.ts`'s fake application gains a `get`, and **no module import changes at
all** — every feature module already imports `PrismaModule`. On the test side, 160 call sites across
23 files gain a receiver. That number is worth splitting, because most of it is not this decision's:
settled #0 makes every scope a transaction, so all 23 files need a client that can open one no
matter which way #1 goes. What #1 adds on top is the receiver, and keeping the method names is what
keeps it to that.

**#2 — the report worker pages in scopes** rather than holding one transaction for the whole job.
The uniform alternative — one scope for the whole job — is a simpler rule, and the case against it
used to be that it would hold a pool connection under an export of arbitrary length and invite
`idle_in_transaction_session_timeout`. Half of that is wrong: **nothing in this project sets
`idle_in_transaction_session_timeout`**, and the server default is `0`, so nothing would reclaim
that connection at all.

The other half of the argument was that the uniform rule would at least buy a consistent read of the
whole export. It would not. Prisma sets no isolation level, so a transaction runs at the server
default — measured here, `read committed` — and under it each statement takes a fresh snapshot:

```
READ COMMITTED    page1 saw 1, page2 saw 2   -> not a snapshot; the export shifts under itself
REPEATABLE READ   page1 saw 1, page2 saw 1   -> consistent
```

So one transaction for the whole job is **all cost and no benefit**: it holds one pooled connection
across up to 500 page queries (`REPORTS_MAX_ROWS=50000` over `PAGE_SIZE=100`), nothing times it out,
and the export is no more consistent than it is today. Paging in scopes costs the opposite — roughly
502 short transactions where there was one long one — and that is the trade taken.

The one version of the uniform rule that would buy something is one scope at **`RepeatableRead`**,
and it is worth writing down what it would fix, because the defect is real and predates all of this.
`TicketsService.findAll` pages with `skip`/`take` over `createdAt desc, id desc`, so a ticket opened
mid-export pushes older rows down a page and one of them is exported twice. Measured, six rows and
pages of three:

```
READ COMMITTED    page1=[6,5,4] page2=[4,3,2]   duplicated: [4]
REPEATABLE READ   page1=[6,5,4] page2=[3,2,1]   duplicated: none
```

That is true of the export today and this decision does not change it either way — it is recorded so
it is not later mistaken for something RLS introduced. The cheap fix is keyset paging in `collect()`
rather than a long transaction, and it is out of scope here because `collect()` deliberately goes
through `findAll` to inherit the visibility rule.

**#3 — domain events are queued on the owning scope and emitted after it commits.** Re-entrancy
moves every domain `emit` inside the request transaction without a line of `src/` changing, and that
has two victims. The audit trail fails deterministically: `emit()` returns `void` and
`AuditListener.handle` is `async`, so the write runs in a later continuation, and Prisma invalidates
an interactive transaction client when its callback returns rather than when the `COMMIT` lands —
measured, `P2028 Transaction already closed: A query cannot be executed on a committed transaction`.
The listener's own `catch` swallows it and logs "the trail is now behind the data", which is the
only true sentence in the sequence. The socket fails as a race: `onTicketEvent` is synchronous and
clients refetch on `ticket.changed`, so a pre-commit notification wakes a client to read a row that
does not exist yet — the anti-pattern `ReportsProcessor.announce()` already refuses in writing.

Three alternatives were weighed. `emitAsync`, awaited, is the only one that makes the trail atomic
with the mutation, and it was rejected because a failed audit write would then abort the request
even though the listener catches it — measured, an error inside a transaction poisons it
(`25P02 current transaction is aborted`), so `AuditListener`'s "a failure here does not fail the
request, and cannot" would stop being true — and because the socket would still fire pre-commit. A
`runDetached()` that opens its own transaction lets the trail record a mutation that then rolls
back, and does nothing for the socket. Dropping request-level re-entrancy altogether fixes both and
dismantles the chokepoint this design is built on. Deferring is the only one under which every
comment already in `audit.listener.ts` and `tickets.service.ts` stays true, and the argument is not
new: it is `ReportsProcessor.announce()`'s, generalised.

What deferring does **not** fix, so that it is not discovered later as a surprise: a process that
dies between the commit and the trail write loses the entry. That is already true today. Only an
outbox table closes it, and that is another project.

---

## Part V — open decisions

**None.** #0, #1, #2 and #3 were opened here and closed into Part IV; the design they produced is
what Part II now describes. This section is kept rather than deleted so that the next thing anyone
opens has an obvious place to go.

What remains is not decisions. It is Part I (the role, the policies, the grants), Part III (the
suite, the two connection strings, the CI variables), the four runtime pieces Part II describes, and
then the number Part VI asks for.

---

## Part VI — the risk worth writing down

Holding a transaction for the duration of a request changes the application's failure profile.
Today a slow request is slow; afterwards, a slow request holds a pooled connection, and under
enough concurrency pool exhaustion turns latency into errors. The mitigations are the 15s timeout,
a deliberately sized pool, and measurement.

Lock hold times change with it, and one case is already known: `TicketsService.create()` takes the
`ticket_counters` row lock and, under re-entrancy, keeps it until the request commits rather than
until the create commits (Part II). Ticket creation within one tenant already serialises by design;
what changes is that it now serialises for the length of a request instead of for two statements.

"Measurement" here means a number in this document once the layer exists — connections held per
request shape, and what concurrency the configured pool actually sustains — not a promise that it
was considered.
