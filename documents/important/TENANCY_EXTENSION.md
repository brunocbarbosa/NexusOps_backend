# The tenancy layer

The reference for `src/tenancy/`, in two parts that serve different readers.

**Part I is the contract**: what `src/tenancy/` offers its callers, and what you have to do when
you add a model or a module. Its reader is a developer writing a feature on top of this layer, and
nothing in it requires reading the extension's source.

**Part II is the measured behaviour**: what Prisma 7.9.1 was measured to do in this repository, and
which of those facts the design depends on. Read it before editing `src/tenancy/tenant-extension.ts`
or `src/tenancy/tenant-context.ts`, and re-check it after a Prisma upgrade —
`test/integration/tenant-isolation.int-spec.ts` is what will tell you when one of them stops being
true.

---

## Part I — the contract

### The two rules

Everything else in this part follows from these.

**Never hand-write a tenant filter.** The extension injects it into every `where` and stamps it
into every `data`. A hand-written filter is one that can be wrong, and worse, one a reader has to
verify. If you find yourself typing `tenantId` in a service, something is off — with the one
exception of `tenantScoped()`, below.

**Never reach for a nullable tenant getter.** There is no `currentTenantId(): string | undefined`,
on purpose, because `currentTenantId() ?? fallback` is exactly the silent bypass this layer exists
to prevent. Use `requireTenantId()`, which returns a string or throws.

### The API

Everything a feature needs, from `src/tenancy/tenant-context.ts` and
`src/tenancy/tenant-scoped.ts`:

| Export                      | Signature                                     | Use it when                                                               |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `requireTenantId()`         | `(): string`                                  | you need the current tenant id; throws when there is none                 |
| `runWithTenant(id, fn)`     | `(string, () => T \| Promise<T>): Promise<T>` | you are outside a request — a worker, a socket handler, a test            |
| `runWithoutTenant(fn)`      | `(() => T \| Promise<T>): Promise<T>`         | a read genuinely must not be scoped: login, and the platform's own routes |
| `tenantScoped(data)`        | `<T>(T): T & { tenantId: string }`            | wrapping the `data` of a top-level `create`                               |
| `currentScope()`            | `(): TenantScope`                             | the extension's own branching; application code wants `requireTenantId()` |
| `TenantContextMissingError` | error class                                   | catching or asserting the absence of a scope                              |

`runWithTenant` is **async and must be awaited**, and that is not a style choice — see Part II on
`PrismaPromise` laziness.

`runWithoutTenant()` is deliberately explicit and greppable: `grep -rn runWithoutTenant src/` is a
complete audit of every unscoped read in the codebase. Keep that list short enough to read. There
are three callers today, and they are enumerated in
[`USERS.md`](./USERS.md#the-tenant-before-a-tenant-exists): the login path, `CompaniesService` —
where every query is unscoped, because the platform operator is asking about _every_ company — and
`PlatformBootstrapService`, which creates the platform tenant at boot with no request at all.

### Where the scope comes from

**In an HTTP request, from nothing you write.** `TenantContextInterceptor`, registered in
`src/app.setup.ts`, opens the scope from `request.user` before the handler runs. It is an
interceptor and not middleware because `request.user` does not exist until the guards have run.
`JwtStrategy` opens its own scope by hand for its freshness check, for the same reason inverted:
guards run _before_ interceptors, so at that point there is no scope yet. Those are the only two
places in the request path that establish one.

**Outside a request, from you, explicitly.** A BullMQ worker and a WebSocket handler have no HTTP
request, so `AsyncLocalStorage` is empty there and the first query throws
`TenantContextMissingError`. The tenant has to travel in the job payload and be re-established
before any query runs:

```ts
// The shape every worker must have.
async function process(job: Job<{ tenantId: string; ticketId: string }>) {
  await runWithTenant(job.data.tenantId, async () => {
    // every query in here is scoped
  });
}
```

**This is the single most likely place in the project for a tenant leak.** Not because the
mechanism is fragile — the query throws rather than running unfiltered — but because the fix under
deadline pressure is to reach for whatever tenant is at hand.

### What the extension does to each operation

It hooks `$allOperations` on `$allModels`, so there is no way to opt out. Every operation falls
into exactly one of these:

| Class             | Operations                                                                                                                              | What happens                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| filter by `where` | `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `delete`, `deleteMany` | `where.tenantId` is injected                                       |
| update            | `update`, `updateMany`, `updateManyAndReturn`                                                                                           | `where.tenantId` injected; a `tenantId` in `data` is refused       |
| create            | `create`, `createMany`, `createManyAndReturn`                                                                                           | `tenantId` stamped into `data`                                     |
| `upsert`          | —                                                                                                                                       | both at once: `where` filtered, `create` stamped, `update` checked |
| Mongo-only        | `findRaw`, `aggregateRaw`                                                                                                               | refused — unreachable on PostgreSQL                                |
| anything else     | —                                                                                                                                       | **refused**                                                        |

The last row is the important one. An operation nobody classified — one a Prisma upgrade
introduced, say — throws `TenantScopeUnknownOperationError` instead of running unfiltered. The
extension fails closed, so an upgrade cannot leak silently; it breaks loudly and you classify the
new operation in `src/tenancy/tenant-extension.ts`.

**A caller-supplied `where.tenantId` is overridden, not merged.** The injection happens last. You
cannot widen a query by asking nicely.

**Raw SQL is not covered.** `$queryRaw` and `$executeRaw` are client operations, not model
operations, and never reach the hook. Row-Level Security is the intended cover and is **not written
yet** — see [`RLS_NOTES.md`](./RLS_NOTES.md). Until it is, raw SQL against a tenant-scoped table
carries its own filter or it is a leak.

### Adding a new tenant-scoped model

The schema is doing half the isolation work, so a new model is not protected by the extension
alone. Four things, and the third is the one that gets forgotten:

1. **A `tenantId` column** mapped to `tenant_id`, plus the `Tenant` relation with `onDelete: Cascade`.
2. **`@@unique([tenantId, id])`.** This is what lets the extension scope a `findUnique`, and it
   doubles as the tenant-leading index — so no separate `@@index([tenantId])` is needed.
3. **Composite foreign keys on every child relation**, pointing at the parent's
   `@@unique([tenantId, id])` rather than at its `id`. Nested access is invisible to the extension,
   and this is what closes that hole: Postgres rejects a cross-tenant reference, and Prisma
   regenerates the nested create input _without_ a `tenantId` field, so the wrong tenant stops
   being expressible at the type level.
4. **Nothing in the extension.** Every model is scoped by default; only the `TENANT_AGNOSTIC`
   allowlist is exempt. Forgetting to register a new model leaves it already protected.

Then in the service: `prisma.thing.create({ data: tenantScoped({ ... }) })` for a top-level create,
and plain queries everywhere else.

**Cost to know before you choose an optional relation.** Part of a composite key cannot be nulled
while `tenant_id` is `NOT NULL`, so an optional relation loses `ON DELETE SET NULL` and becomes
`RESTRICT`. There are two today — `Ticket.assignee` and `AuditLog.user` — and they are why deleting
a user is a soft delete. Plan for that rather than discovering it at the first delete.

### Adding a tenant-agnostic model

Rare. Add its name to `TENANT_AGNOSTIC` in `src/tenancy/tenant-extension.ts`. Only `Tenant` is in
it today, and a model belongs there only if it genuinely has no `tenant_id` column — passing
`tenantId` to a model that lacks the column raises `PrismaClientValidationError`, so a wrong entry
here breaks loudly rather than silently.

**Exempt is not unguarded**, and this catches people. Inside a tenant scope, a `Tenant` query is
rewritten to `where.id = <current tenant>` — so `tenant.findMany()` returns _your_ tenant, not
every tenant. Reading across tenants requires `runWithoutTenant()` explicitly, and having no
context at all is refused like anywhere else.

This is exactly what `src/platform/` runs into. The `ADMIN_MASTER`'s request carries the platform
tenant's scope like any other request, so `GET /platform/companies` without `runWithoutTenant()`
would list the platform row and nothing else. See
[`PLATFORM.md`](./PLATFORM.md#every-company-query-runs-unscoped-and-it-has-to-say-so).

### `tenantScoped()`, and why a create needs it at all

The extension stamps `tenantId` at runtime, so a service has no reason to mention it. Prisma's
generated types disagree: `UserCreateInput` demands either `tenantId` or `tenant: { connect }`, so
a bare `{ email, passwordHash }` is a compile error. `tenantScoped()` is the bridge, and it is
**not a cast** — it computes the real value from `requireTenantId()`, so the two halves check each
other instead of trusting each other.

Nested creates need nothing: the composite foreign keys mean Prisma regenerates the nested input
without a `tenantId` field at all.

### The three errors, and what each one means

| Error                              | Thrown when                                             | What to do                                                                 |
| ---------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `TenantContextMissingError`        | a query ran with no scope                               | you are outside a request — wrap in `runWithTenant()` from the job payload |
| `CrossTenantWriteError`            | a write supplied a `tenantId` other than the active one | a bug: the write was trying to move a row between tenants                  |
| `TenantScopeUnknownOperationError` | an unclassified operation, or a Mongo-only one          | classify it in `src/tenancy/tenant-extension.ts`                           |

`TenantContextMissingError` firing from code that _visibly_ established a tenant has one usual
cause, and it is in Part II: a `PrismaPromise` awaited outside the scope that created it.

None of the three is an HTTP exception. They are programming errors, not client errors, and they
surface as 500s — which is the honest status for "the server has a bug".

---

## Part II — measured behaviour

Everything below was **measured against Prisma 7.9.1 in this repository**, not taken from
documentation. The design of the extension depends on all of it, so a Prisma upgrade means
re-checking these — `test/integration/tenant-isolation.int-spec.ts` is what will tell you if one
of them stopped being true.

This is the _why_ behind Part I.

### What the extension can and cannot see

- **`findUnique` accepts a non-unique extra field in `where`.** `{ where: { id, tenantId } }` is
  valid and filters correctly, so the extension injects `where.tenantId` uniformly and never
  rewrites `findUnique` into `findFirst`. Cross-tenant `update`/`delete` surface as `P2025` with the
  other tenant's row untouched — which makes the API answer 404, not 403, so it does not confirm
  that another tenant's resource exists.
- **`PrismaPromise` is lazy, and that will eat your context.** The query is dispatched when the
  promise is awaited, not when the method is called. So `als.run(store, () => prisma.x.findMany())`
  dispatches _outside_ the scope. `runWithTenant` is therefore `async` and awaits `fn()` inside
  `storage.run`; do not "simplify" it back to a synchronous wrapper. Symptom when this regresses:
  `TenantContextMissingError` from code that visibly established a tenant.
- **Query extensions never fire for nested access.** `include: {}` intercepts only the parent
  operation, and so does a nested `create`. The extension cannot filter a nested read or fix a
  nested child's `tenantId`.
- **That hole is closed in the schema, not in the extension.** Child relations use composite foreign
  keys against `@@unique([tenantId, id])`. Prisma then regenerates the nested create input _without_
  a `tenantId` field, so the wrong tenant stops being expressible, and a cross-tenant child cannot
  exist for a nested read to return. Cost: the two optional relations lose `ON DELETE SET NULL` and
  become `RESTRICT`, because part of a composite key cannot be nulled while `tenant_id` is
  `NOT NULL`. Deleting a user therefore requires anonymising `audit_logs.user_id` first.
- **Scoping every model by default fails closed in both directions.** The extension filters every
  model except an explicit `TENANT_AGNOSTIC` allowlist. Passing `tenantId` to a model that lacks the
  column raises `PrismaClientValidationError`, so forgetting to exempt an agnostic model breaks
  loudly, while forgetting to register a new scoped model leaves it already protected. Unknown
  operations throw rather than run unfiltered, so a Prisma upgrade that adds one cannot leak.

### Two things it deliberately refuses to make convenient

There is no `currentTenantId(): string | undefined`, because `?? fallback` is the silent bypass the
design exists to prevent — `requireTenantId()` returns a string or throws, and `currentScope()`
returns a union whose cases must all be handled.

And reading `Tenant` unscoped, which the login path needs before any tenant identity exists,
requires an explicit `runWithoutTenant()`; a merely absent context is refused, so a lost context
cannot quietly widen into a read of every tenant.

### What is left for RLS

`$queryRaw` / `$executeRaw` are client operations, not model ones, and never reach the extension.
That, plus a defect in the extension itself, is the entire remaining job for Row-Level Security —
considerably smaller than it looked before these measurements. The RLS notes, including two traps
that cost real debugging time, are in [`RLS_NOTES.md`](./RLS_NOTES.md).
