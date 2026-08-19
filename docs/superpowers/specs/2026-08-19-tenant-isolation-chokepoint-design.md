# Tenant isolation chokepoint — AsyncLocalStorage + Prisma Client Extension

Status: implemented 2026-08-19. Supersedes the assumptions recorded in the domain-modeling slice.
Three sections were revised during implementation, each marked with what forced the change.

## Problem

The domain schema exists but nothing scopes queries to a tenant. `test/tenant-isolation.e2e-spec.ts`
records the starting point: a plain client returns rows from every tenant when a query carries no
filter. This slice makes the tenant filter impossible to forget, by putting it in one place a
developer cannot route around.

Two constraints come from `CLAUDE.md > Architecture` and shape everything below. The filter must be a
chokepoint, not a per-handler convention. And BullMQ workers and WebSocket handlers have no HTTP
request, so the `AsyncLocalStorage` context is empty there — tenant identity has to be carried in the
job payload and re-established before any query runs.

## What was measured, not assumed

Five facts established empirically against this repo's own Postgres 17 container and Prisma 7.9.1.
Three of them changed the design.

**1. `findUnique` accepts a non-unique extra field in `where`.**
`findUnique({ where: { id, tenantId } })` is accepted and filters correctly — the foreign-tenant id
returns `null`. So the extension injects `where.tenantId` uniformly across every read, with no need
to rewrite `findUnique` into `findFirst` and no need to translate into the `tenantId_id` accessor.

This corrects the domain-modeling slice, which claimed `@@unique([tenantId, id])` was the mechanism
the extension depends on. It is not. The compound unique remains valuable as an integrity
constraint, as an explicit accessor, and because it subsumes the redundant `@@index([tenantId])` —
but its role was overstated.

**2. Query extensions do not fire for nested access.**
`ticket.findMany({ include: { comments: true } })` intercepts only `Ticket.findMany`. A nested
`comments: { create: [...] }` intercepts only `Ticket.create`. The extension can neither filter a
nested relation read nor correct the `tenantId` of a nested child write.

**3. Composite foreign keys remove the nested-write hole from the API surface.**
With `comments.(tenant_id, ticket_id)` referencing `tickets.(tenant_id, id)`, Prisma regenerates
`CommentUncheckedCreateWithoutTicketInput` **without a `tenantId` field** — the child's tenant is
derived from the parent. A nested write with the wrong tenant is not rejected at runtime; it stops
being expressible.

Nested *reads* are then safe by construction rather than by filtering: a `Comment` belonging to
another tenant cannot exist while pointing at this tenant's `Ticket`, so `include` has nothing to
leak.

**4. Every model operation is intercepted; raw queries are not.**
Verified firing: `findMany`, `findFirst`, `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow`,
`count`, `aggregate`, `groupBy`, `create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`,
`delete`, `deleteMany`, `upsert`. `$queryRaw` produced no interception at all — it is a client
operation, not a model one, so raw SQL is outside the extension by construction.

`update` and `delete` also accept the extra non-unique `tenantId` in `where`, so writes scope the same
way reads do. A cross-tenant `update` or `delete` raises `P2025` (record not found) and leaves the
other tenant's row untouched — verified by reading it back afterwards. That error code is the right
externally-visible behaviour: the API answers 404 rather than 403, so it does not confirm that another
tenant's resource exists.

**5. Scoping every model by default fails loudly.**
Passing `tenantId` to a model that has no such column raises `PrismaClientValidationError`. So an
allowlist of exempt models is fail-closed in both directions: forgetting to exempt a tenant-agnostic
model breaks on first use, and forgetting to register a new tenant-scoped model leaves it already
protected.

## Design

### Migration: composite foreign keys

A pure constraint swap — no column changes, no data movement. Generated and reviewed via
`prisma migrate diff --from-schema ... --to-schema ... --script` (note: Prisma 7 renamed these flags;
`--from-schema-datasource` was removed).

| Table | Old | New |
|---|---|---|
| `tickets` | `(requester_id) → users(id)` | `(tenant_id, requester_id) → users(tenant_id, id)` |
| `tickets` | `(assignee_id) → users(id)` | `(tenant_id, assignee_id) → users(tenant_id, id)` |
| `comments` | `(ticket_id) → tickets(id)` | `(tenant_id, ticket_id) → tickets(tenant_id, id)` |
| `comments` | `(author_id) → users(id)` | `(tenant_id, author_id) → users(tenant_id, id)` |
| `audit_logs` | `(user_id) → users(id)` | `(tenant_id, user_id) → users(tenant_id, id)` |

`tenant_id` participates in several relations per model; Prisma validates this and generates it
without complaint.

**Accepted consequence.** The two optional relations lose `ON DELETE SET NULL` and become
`RESTRICT`, because Prisma cannot null part of a composite key while `tenant_id` is `NOT NULL`.
For `tickets.assignee` this is unremarkable — reassign before deleting. For `audit_logs.user_id` it
means the audit trail now blocks deletion of any user with history. This was chosen deliberately over
dropping the foreign key: there is no user-deletion feature yet, so it costs nothing today, and
whoever builds one meets a loud error instead of silently losing audit rows. That flow must
anonymize first:

```ts
await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });
await tx.user.delete({ where: { tenantId_id: { tenantId, id: userId } } });
```

### `src/tenancy/tenant-context.ts`

An `AsyncLocalStorage` store with four exports:

- `runWithTenant<T>(tenantId, fn): Promise<T>` — establishes the scope.
- `runWithoutTenant<T>(fn): Promise<T>` — unlocks tenant-agnostic models only.
- `requireTenantId(): string` — the current tenant, or `TenantContextMissingError`.
- `currentScope(): TenantScope` — for the extension's own branching.

**Both runners are async, and they await `fn()` inside `storage.run`.** This was discovered during
implementation, by a test failure: `PrismaPromise` is lazy, so the query is dispatched when the
promise is awaited rather than when the method is called. A synchronous wrapper lets
`runWithTenant(id, () => prisma.ticket.findMany())` dispatch *outside* the scope. Eight tests failed
this way before the fix. Do not simplify it back.

Deliberately **no** `currentTenantId(): string | undefined`. A getter that can return `undefined`
invites `?? someDefault`, which is the silent bypass this whole design exists to prevent.
`currentScope()` returns a discriminated union instead, so every case has to be handled.

`runWithTenant` is also the worker and gateway entry point: a BullMQ processor reads the tenant from
its job payload and wraps its body in it. Forgetting to wrap does not leak, because
`requireTenantId()` throws.

### `src/tenancy/tenant-extension.ts`

`Prisma.defineExtension` over `query.$allModels.$allOperations` — a single interception point, so
"I forgot to scope this query" is not a reachable state.

```
TENANT_AGNOSTIC = new Set(['Tenant'])
```

For every other model, `requireTenantId()` first, then by operation:

| Operations | Injection |
|---|---|
| `findUnique` `findUniqueOrThrow` `findFirst` `findFirstOrThrow` `findMany` `count` `aggregate` `groupBy` `delete` `deleteMany` | `args.where = { ...args.where, tenantId }` |
| `update` `updateMany` `updateManyAndReturn` | same, **and** `data.tenantId` is rejected outright |
| `create` | `args.data.tenantId = tenantId` |
| `createMany` `createManyAndReturn` | inject into every element of `args.data` |
| `upsert` | `args.where` and `args.create`; `args.update.tenantId` rejected |
| anything else, including `findRaw` / `aggregateRaw` | **throws** |

Two corrections to the operation list as first drafted. `updateManyAndReturn` exists and was missing —
an unclassified write operation is a leak, which is why the final branch throws instead of falling
through: a Prisma upgrade that adds an operation now breaks loudly.

And an update must not be allowed to touch `tenantId` at all. The `where` filter confines an update to
the caller's own rows, but `data: { tenantId: other }` would move a row *out* of the tenant — a leak
the where-filter does not catch. Both the `{ tenantId: x }` and `{ tenantId: { set: x } }` forms are
rejected.

Two rules about conflicts, chosen to differ on purpose:

- In `where`, the injected `tenantId` is spread last and wins. A caller-supplied tenant filter is
  harmless to override.
- In `data`, a caller-supplied `tenantId` that differs from the context **throws**. Explicitly
  writing into another tenant is a bug, not a preference, and overwriting it silently would hide it.

**`Tenant` is exempt from tenant filtering but not unguarded.** Leaving it fully unscoped would make
`tenant.findMany({ include: { tickets: true } })` a leak path. So inside a tenant context, `Tenant`
operations that take a `where` get `where.id = tenantId`.

Reading it in full requires `runWithoutTenant()` explicitly; a merely **absent** context is refused
like anywhere else. The first draft of this design had absent-context mean unscoped, which was the
one fail-open. The lazy-`PrismaPromise` failure above is exactly what made that unacceptable: losing
a context by accident is easy, and under the old rule it silently widened a `Tenant` read into a read
of every tenant. Under the new rule that same accident throws.

### What this slice provably does not cover

- `$queryRaw` / `$executeRaw` — measured: no interception. Raw SQL is RLS territory.
- A defect in the extension itself.

That is the whole remaining job for the RLS slice, and it is considerably smaller than assumed before
these measurements. Nested access is closed by the composite keys, not by RLS.

## Tests

`test/tenant-isolation.e2e-spec.ts` grows a second suite. The existing raw-client leak assertion
**stays as it is** and is not inverted: it remains true, and it is the contrast that shows why the
extended client must be the only client the application is given.

New assertions against the extended client:

1. Inside `runWithTenant(A)`, `ticket.findMany()` returns only tenant A's rows.
2. With no context, `ticket.findMany()` throws — fail-closed.
3. Per-operation coverage: `count`, `aggregate`, `groupBy`, `findFirst`, `updateMany`, `deleteMany`,
   `upsert` each scoped; `findUnique` on a foreign id returns `null`.
4. `create` injects the tenant with no `tenantId` in the call.
5. `create` carrying a foreign `tenantId` throws.
6. Worker shape: a handler given only a job payload re-establishes scope via `runWithTenant` and sees
   one tenant; the same handler without the wrapper throws rather than leaking.
7. A nested comment create lands in the parent ticket's tenant, and a cross-tenant author is rejected
   by the composite foreign key.
8. `$queryRaw` is **not** scoped — asserted, so the RLS gap is a recorded fact rather than folklore.
9. `Tenant` is scoped by `id` inside a context and unscoped outside one.

## Implementation order

1. Schema relations → composite; `prisma migrate dev --name composite_tenant_fks`; `prisma generate`.
2. `src/tenancy/tenant-context.ts`.
3. `src/tenancy/tenant-extension.ts`.
4. Extend `test/tenant-isolation.e2e-spec.ts`.
5. Update `CLAUDE.md` with facts 1–5 and the `migrate diff` flag rename.

## Verification

```bash
npx prisma validate
npm run prisma:migrate -- --name composite_tenant_fks
npm run prisma:generate
npx tsc --noEmit
npm test
npm run test:e2e
npx eslint "src/**/*.ts" "test/**/*.ts"
docker compose exec -T postgres psql -U nexusops -d nexusops -c "\d comments"
```

The `\d comments` output must show `comments_tenant_id_ticket_id_fkey` and
`comments_tenant_id_author_id_fkey` as two-column foreign keys.

## Out of scope

NestJS wiring — `PrismaModule`, `PrismaService`, the request middleware that reads the tenant from a
verified JWT, `AppModule` registration, the global `ValidationPipe`. There is no auth module yet, so
any middleware written now would have to trust a client-supplied header, and a provisional trusted
header that outlives its provisional status is an open door. It waits for auth.

RLS and the non-superuser role also remain their own slice.
