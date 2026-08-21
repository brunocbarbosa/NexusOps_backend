# Tenancy extension — measured behaviour of Prisma 7.9.1

Read this before editing `src/tenancy/tenant-extension.ts` or `src/tenancy/tenant-context.ts`.

Everything below was **measured against Prisma 7.9.1 in this repository**, not taken from
documentation. The design of the extension depends on all of it, so a Prisma upgrade means
re-checking these — `test/integration/tenant-isolation.int-spec.ts` is what will tell you if one
of them stopped being true.

The rules that apply everywhere else in the codebase — never hand-write a tenant filter, and
workers have no request context — are in `CLAUDE.md` under "Architecture". This file is the
_why_ behind them.

## What the extension can and cannot see

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

## Two things it deliberately refuses to make convenient

There is no `currentTenantId(): string | undefined`, because `?? fallback` is the silent bypass the
design exists to prevent — `requireTenantId()` returns a string or throws, and `currentScope()`
returns a union whose cases must all be handled.

And reading `Tenant` unscoped, which the login path needs before any tenant identity exists,
requires an explicit `runWithoutTenant()`; a merely absent context is refused, so a lost context
cannot quietly widen into a read of every tenant.

## What is left for RLS

`$queryRaw` / `$executeRaw` are client operations, not model ones, and never reach the extension.
That, plus a defect in the extension itself, is the entire remaining job for Row-Level Security —
considerably smaller than it looked before these measurements. The RLS notes, including two traps
that cost real debugging time, are in [`RLS_NOTES.md`](./RLS_NOTES.md).
