# Authentication and users — measured behaviour

Read this before editing `src/auth/`, `src/users/`, or the DTOs of any new module.

Everything below was **measured in this repository**, against Prisma 7.9.1, bcrypt 6.0.0,
class-transformer 0.5.1 and `@nestjs/config` 4. These are not recommendations taken from
documentation: they are things the code depends on being true, each with the test that will tell
you when one of them stops being so.

The rules that apply everywhere else in the codebase — never hand-write a tenant filter, workers
have no request context — are in `CLAUDE.md` under "Architecture". This file is the _why_ behind
the decisions in this slice.

## The tenant before a tenant exists

`User.email` is only unique within a tenant, so an email address alone is ambiguous across
companies. Login carries `tenantDomain` in the body and resolves the `Tenant` first. There are
**three** places in the whole codebase that run without a tenant, and the list is deliberately
short — a single `grep runWithoutTenant` audits the entire surface:

| Where                  | Why                                                |
| ---------------------- | -------------------------------------------------- |
| `AuthService.register` | the `Tenant` is being created                      |
| `AuthService.login`    | the `Tenant` has not been identified yet           |
| test suite cleanup     | deleting "from every tenant" is exactly the intent |

`AuthService.refresh` is **not** on the list, and that is the reason `tenantId` travels inside the
refresh token: a refresh happens precisely when the access token has expired, so there is no
authenticated user and no scope to inherit — and the token table is scoped like every other one, so
the query does not run unscoped. Carrying the tenant in the claim is what makes it possible to open
the scope before the first query instead of leaving that lookup unscoped.

## A `$transaction` that changes scope halfway through

`register()` creates the `Tenant` under `runWithoutTenant()` and the first `ADMIN` under
`runWithTenant(tenant.id)`, **inside the same transaction** — splitting them would leave a company
existing with nobody able to log into it.

Two properties of Prisma 7.9.1 hold that together, and both were measured:

- **The extension applies to the transactional client.** The callback's `tx` stamps `tenantId` and
  refuses a cross-tenant write exactly like the client outside it. A transaction is not a way around
  the chokepoint.
- **`AsyncLocalStorage` survives the `await`s inside the callback.** A scope opened _after_ the
  transaction has already started still applies to the queries that follow.

`test/integration/auth-registration.int-spec.ts` pins both, plus the rollback: when the scoped write
fails, the tenant goes with it.

## The interceptor and the laziness of the Observable

`TenantContextInterceptor` is an interceptor and not middleware because at middleware time
`request.user` does not exist yet — the guards have not run — and decoding the JWT again there would
create a second place deciding who the caller is.

The trap is the same `PrismaPromise` laziness described in
[`TENANCY_EXTENSION.md`](./TENANCY_EXTENSION.md): returning `next.handle()` from inside
`runWithTenant` hands back an **unsubscribed** Observable, and the subscription happens after the
scope has already closed. The body has to be
`from(runWithTenant(id, () => firstValueFrom(next.handle(), { defaultValue: undefined })))`.

**Accepted cost:** converting to a promise keeps only the first emission, so `@Sse` and any
multi-emission handler do not work under this interceptor. REST routes and `StreamableFile` (which
emits a single object) are unaffected.

The `defaultValue` is there because `firstValueFrom` rejects with `EmptyError` on an Observable that
completes without emitting, which an inner interceptor can produce.

## `tenantScoped()` exists because of the types, not the runtime

The extension stamps `tenantId` on every `create`. Prisma's generated types disagree: `User` has a
required relation to `Tenant`, so `UserCreateInput` demands `tenantId` or `tenant: { connect }`, and
a bare `{ email, passwordHash }` is a compile error. Without a bridge, every service would end up
writing the tenant by hand — which is what this layer exists to eliminate.

`tenantScoped()` is **not a cast**. It computes the real value, via `requireTenantId()`, from the
same source the extension would use. A cast would satisfy the compiler while leaving the object
without the field, and the day the extension stopped firing for some operation the write would land
with `tenantId: undefined` instead of failing. This way the two halves check each other instead of
trusting one another: `requireTenantId()` throws when there is no scope, and the extension's
`stampTenant` still refuses a mismatch.

Nested creates do not need it: the composite FKs make Prisma regenerate the nested input with no
`tenantId` field at all.

## Refresh tokens

**A separate key, not the same one with a longer lifetime.** Access and refresh tokens carry almost
the same claims. Under a single key the refresh token — valid for days — is accepted as a bearer
token by `JwtStrategy`, and the access token's 15 minutes stop meaning anything. With two keys the
signature check refuses it, without depending on anyone remembering a `type` claim. `validateEnv`
refuses to let the application boot with the two equal, because that undoes the separation silently.

**sha256 and not bcrypt for storage.** bcrypt is deliberately slow, to make guessing a
human-chosen secret expensive. In a signed 256-bit token there is nothing to guess: the slowness
would buy no security and would be paid on every rotation. The hash is there so that a database dump
is not a set of usable sessions.

**`consume()` is a single `updateMany` filtered by `revokedAt: null`.** It is not read-then-write,
and that difference is the only thing that makes reuse detection work: with read-then-write two
simultaneous refreshes both see `null`, both rotate, and both get a new pair — exactly the
stolen-token scenario the detection exists to catch. It is the same shape of optimistic control as
the ticket aggregate. A claim about concurrency cannot be verified by reading code:
`test/integration/refresh-token.int-spec.ts` fires five simultaneous consumers at the same token and
proves that **exactly one** wins.

**Reuse revokes the entire family.** An already-spent token coming back means two parties hold it,
and from here there is no telling which one is legitimate. Both log in again; the alternative leaves
the thief with a working chain running alongside the owner's.

**`expires_at` is read from the signed token's `exp`**, not re-parsed from the duration string. One
source of truth, and the row cannot claim a validity different from the token it describes. The
column serves a future cleanup job and auditing; what rejects an expired token is `jsonwebtoken`.

## bcrypt truncates at 72 bytes and says nothing

Measured against bcrypt 6.0.0: `hash()` of 81 characters followed by `compare()` with a different
password that shares the first 72 returns **`true`**, and `hash()` does not throw on long input. Two
long passwords become the same credential, and whoever chose a passphrase gets far less security
than its length suggests.

Hence `@MaxBytes(72)` in `src/auth/password.constraints.ts` — **bytes**, not characters: an emoji
costs four, and a `@MaxLength(72)` would let through 288 bytes of which bcrypt would keep 18.

## An identical message is not enough: timing gives it away too

Login answers the same 401 for a nonexistent tenant, a nonexistent user and a wrong password. That
alone does not settle it: skipping bcrypt on the not-found path made the response come back in ~1ms
against ~50ms on the found path, and a stopwatch answers "does this account exist?" — the question
the message refused to answer.

`HashingService.compareWithDecoy()` spends the same time. The decoy hash is built in `onModuleInit`
from the configured cost, not hard-coded: a bcrypt hash carries its own cost factor, so a fixed
decoy would burn a different amount of time than the real hashes and reintroduce the very difference
it exists to hide.

## Soft delete versus the unique email

Deleting a user is logical because the FKs from `audit_logs` and `tickets.assignee` are `RESTRICT` —
deleting a user with history fails in the database itself.

Measured: recreating a user with a deactivated user's email fails with **`P2002` on
`(tenant_id, email)`**. The address stays taken for as long as the row exists. That is why:

- `POST /users` tells the two cases apart behind the same `P2002` and returns the id to restore;
- `POST /users/:id/restore` exists — restoring brings the **same** row back, with its history still
  attached to it, which a fresh create would not do;
- a restore never collides: the address was taken the whole time, so nobody could claim it.

**The `deletedAt: null` filter lives in the service, not in the extension.** Putting it next to the
tenant filter would look symmetric and would be a mistake: the extension is about the tenant, and
teaching it to hide rows would make every future model lose records nobody asked to hide.

## `Boolean('false')` is `true`

The global pipe runs with `enableImplicitConversion`, and a query string only carries text. The
result was that `?includeDeleted=false` arrived as `true` — the opposite of what was asked, silently.

The part worth recording: **a `@Transform` on its own does not fix it.** Measured with the real
pipe, the implicit conversion runs **before** the transform, which then receives an already-wrong
boolean — `'false'` and `'maybe'` both arrived as `true`. `@Type(() => String)` on the property is
what redirects the conversion and leaves the raw text for the transform to read.

`src/users/dto/query-users.dto.spec.ts` runs through the **same** `VALIDATION_PIPE_OPTIONS` that
`configureApp` uses, exported from `src/app.setup.ts` precisely for this: a spec that built its own
options would prove nothing about this case.

This holds for any boolean query-string flag in any future module.

## Two API choices that look like details

**404 and never 403 for another tenant's resource.** The extension filters, so the id is simply not
found. A 403 would confirm that the id exists somewhere, which is a fact about another company's
data. 403 is reserved for insufficient role, where there is nothing to reveal.

**`UpdateUserDto` is written by hand, not `PartialType(CreateUserDto)`.** The derived version would
inherit `password`, and changing someone else's password through the same route that renames them is
exactly how an overly broad admin action turns into an account takeover. Passwords only through
`PATCH /users/me/password`, which requires the current one and ends every session.
