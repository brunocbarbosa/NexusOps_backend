# Authentication and users

The reference for the `auth` and `users` slice, in two parts that serve different readers.

**Part I is the contract**: the data model, every endpoint, every request and response shape, and
every error the API can return. It is what a client — the frontend above all — needs in order to
integrate, and nothing in it requires reading the source. Every payload in it was captured from the
running application, not written from the types.

**Part II is the measured behaviour**: the reasons behind the decisions in Part I, each one
something that was measured in this repository rather than read in documentation. Read it before
editing `src/auth/`, `src/users/`, or the DTOs of any new module.

The rules that apply everywhere else in the codebase — never hand-write a tenant filter, workers
have no request context — are in `CLAUDE.md` under "Architecture".

---

## Part I — the contract

### Roles

Three, on `User.role`, and they are hierarchical only by convention: the code checks membership in
a list, never an ordering.

| Role        | Means                                      |
| ----------- | ------------------------------------------ |
| `ADMIN`     | administers the tenant: manages every user |
| `AGENT`     | works tickets; may list users              |
| `REQUESTER` | opens tickets; the default for a new user  |

`REQUESTER` is the schema default, and deliberately the least privileged: adding a user without
saying a role cannot accidentally grant more than intended.

The first `ADMIN` of a tenant is created by `POST /auth/register`, together with the tenant itself.
There is no other way to bootstrap one.

### The data model

Three tables back this slice. Column names below are the **database** names; the API speaks
camelCase, and the mapping is in `prisma/schema.prisma`.

**`tenants`** — the customer company. The one model that is _not_ tenant-scoped, because it _is_
the tenant.

| Column       | Type           | Notes                                          |
| ------------ | -------------- | ---------------------------------------------- |
| `id`         | `uuid` PK      |                                                |
| `name`       | `varchar(255)` | display name                                   |
| `domain`     | `varchar(100)` | **unique**, nullable; the login discriminator  |
| `is_active`  | `boolean`      | default `true`; a `false` tenant cannot log in |
| `created_at` | `timestamp`    |                                                |

**`users`** — access control.

| Column          | Type           | Notes                                             |
| --------------- | -------------- | ------------------------------------------------- |
| `id`            | `uuid` PK      |                                                   |
| `tenant_id`     | `uuid` FK      | `ON DELETE CASCADE`; never accepted from a client |
| `email`         | `varchar(255)` | unique **within the tenant**, not globally        |
| `password_hash` | `varchar(255)` | bcrypt; never leaves the server                   |
| `role`          | `UserRole`     | default `REQUESTER`                               |
| `created_at`    | `timestamp`    |                                                   |
| `deleted_at`    | `timestamp?`   | **soft delete**: null means active                |

Two composite uniques do real work: `@@unique([tenantId, email])` is why the same address can exist
in two different companies, and `@@unique([tenantId, id])` is what lets the tenancy extension scope
a `findUnique` and what the child tables point their composite foreign keys at.

**`refresh_tokens`** — so that logging out means something.

| Column       | Type          | Notes                                                     |
| ------------ | ------------- | --------------------------------------------------------- |
| `id`         | `uuid` PK     |                                                           |
| `tenant_id`  | `uuid` FK     |                                                           |
| `user_id`    | `uuid` FK     | composite FK against `(tenant_id, id)` on `users`         |
| `token_hash` | `varchar(64)` | **unique**; sha256 hex of the JWT, never the token itself |
| `expires_at` | `timestamp`   | read from the token's own `exp`                           |
| `revoked_at` | `timestamp?`  | null while valid; set on logout, rotation and reuse       |
| `created_at` | `timestamp`   |                                                           |

The frontend never sees any of these rows. They matter to it only through their consequences: a
refresh rotates, and a reused token ends every session.

### Conventions that hold on every route

**Base URL.** `http://localhost:3000` in development (`PORT`, default `3000`). There is **no global
route prefix** — paths are `/auth/login`, not `/api/auth/login`. If a prefix is ever added it goes
in `configureApp()` in `src/app.setup.ts`, and it will move every path in this document at once.

**Authentication.** `Authorization: Bearer <accessToken>` on every route except the four public
ones. `JwtAuthGuard` is global, so a route is protected unless it explicitly says otherwise — the
public ones are `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` and the liveness
`GET /`.

**Content type.** `application/json` on every request with a body.

**Unknown fields are a 400, not ignored.** The global `ValidationPipe` runs with `whitelist` and
`forbidNonWhitelisted`, so posting a field no DTO declares fails the request:

```json
{
  "message": ["property tenantId should not exist"],
  "error": "Bad Request",
  "statusCode": 400
}
```

This is deliberate — a typo in a field name surfaces immediately instead of becoming a silent no-op
write — and it means the frontend must not send extra keys, not even `id` or `tenantId` echoed back
from a previous response.

**Emails and domains are normalised server-side**: trimmed and lowercased before anything else
happens. `  ADMIN@Acme.com  ` and `admin@acme.com` are the same account, on both registration and
login. The client does not need to do it, and doing it anyway changes nothing.

**Tenant scoping is implicit and non-negotiable.** No endpoint accepts a `tenantId`. It comes from
the access token, and the Prisma extension injects it into every query. A client cannot ask for, or
accidentally reach, another company's data.

**Dates are ISO 8601 UTC strings** — `"2026-08-23T13:29:18.546Z"`.

**The error envelope** is Nest's default, always these three keys:

```json
{ "message": "...", "error": "Conflict", "statusCode": 409 }
```

`message` is a **string** for business errors and an **array of strings** for validation failures.
A client that renders it has to handle both. Two exceptions worth knowing: a missing or invalid
bearer token returns `{"message":"Unauthorized","statusCode":401}` with **no** `error` key, and a
204 has no body at all.

### Endpoints at a glance

| Method   | Path                 | Auth        | Success | Purpose                               |
| -------- | -------------------- | ----------- | ------- | ------------------------------------- |
| `POST`   | `/auth/register`     | public      | 201     | create a tenant and its first ADMIN   |
| `POST`   | `/auth/login`        | public      | 200     | exchange credentials for a token pair |
| `POST`   | `/auth/refresh`      | public      | 200     | rotate the token pair                 |
| `POST`   | `/auth/logout`       | any         | 204     | end one session                       |
| `GET`    | `/auth/me`           | any         | 200     | the caller's identity                 |
| `POST`   | `/users`             | ADMIN       | 201     | create a user                         |
| `GET`    | `/users`             | ADMIN,AGENT | 200     | list users, paginated                 |
| `GET`    | `/users/:id`         | any         | 200     | one user                              |
| `PATCH`  | `/users/:id`         | ADMIN       | 200     | change email or role                  |
| `DELETE` | `/users/:id`         | ADMIN       | 204     | deactivate (soft delete)              |
| `POST`   | `/users/:id/restore` | ADMIN       | 200     | reactivate                            |
| `PATCH`  | `/users/me/password` | any         | 204     | change one's own password             |

"any" means any authenticated user, of any role.

Two response shapes recur, and it is worth naming them:

```ts
// UserResponse — every route that returns a user returns exactly this.
// Built as an allowlist, so a new column stays out of the API until someone decides otherwise.
{ id: string, email: string, role: 'ADMIN'|'AGENT'|'REQUESTER', createdAt: string, deletedAt: string|null }

// AuthResult — every route that issues tokens returns exactly this.
{ accessToken: string, refreshToken: string, user: UserResponse }
```

### `POST /auth/register` — public

Creates a tenant and its first `ADMIN` in one transaction. The only way either comes into
existence.

```json
{
  "tenantName": "Acme Inc",
  "tenantDomain": "acme.com",
  "email": "admin@acme.com",
  "password": "correct horse battery"
}
```

| Field          | Rules                                                                          |
| -------------- | ------------------------------------------------------------------------------ |
| `tenantName`   | string, 2–255 chars, trimmed                                                   |
| `tenantDomain` | string, 3–100 chars, hostname shape (`acme` or `acme.com`), lowercased, unique |
| `email`        | valid email, 3–255 chars, lowercased                                           |
| `password`     | string, min 8 chars, **max 72 bytes**                                          |

**201** → `AuthResult`. **409** if the domain is taken. **400** on any validation failure.

The 72-byte ceiling is not arbitrary and is not a character count: bcrypt silently ignores
everything past byte 72, and one emoji costs four bytes. See Part II.

### `POST /auth/login` — public

```json
{
  "tenantDomain": "acme.com",
  "email": "admin@acme.com",
  "password": "correct horse battery"
}
```

**200** (not 201 — logging in creates no resource) → `AuthResult`.

`tenantDomain` is required and is not a convenience: `email` alone is ambiguous, because the same
address can exist in several tenants. The frontend has to obtain it — a subdomain, a field on the
login form, a value kept from registration — before it can log anyone in.

**401** `Invalid credentials` for **every** failure: unknown tenant, inactive tenant, unknown user,
deactivated user, wrong password. The client cannot distinguish them, by design, and should not try
to phrase a message that implies it did.

Only `password` is loosely validated here (non-empty). Applying the registration policy would
answer "does this account use a short password?" with a 400 before checking any credential.

### `POST /auth/refresh` — public

```json
{ "refreshToken": "eyJhbGciOi..." }
```

**200** → a **new** `AuthResult`. The old refresh token is spent by this call: rotation, not reuse.
Store the new pair and discard the old one.

**401** `Invalid refresh token` when the token is unknown, expired, already spent, revoked, or
belongs to a user who has since been deactivated. **400** if it is not a JWT at all.

**The consequence the frontend must handle:** presenting an already-spent refresh token revokes
**every** session of that user, not just the one. Two tabs racing to refresh the same stored token
will log the user out entirely. Serialise refreshes — a single in-flight promise shared by all
callers is the usual shape — and persist the rotated token before issuing the next request.

Public because the access token has expired by definition; the refresh token is itself the
credential, and it carries the tenant the lookup needs.

### `POST /auth/logout` — authenticated

```json
{ "refreshToken": "eyJhbGciOi..." }
```

**204**, always, and with no body. Revoking a token that is not the caller's is silent — the
response does not distinguish it, so a client cannot probe for other people's tokens.

Ends one session. To end all of them, change the password.

### `GET /auth/me` — authenticated

**200**, and note that this is the one shape that is **not** `UserResponse`:

```json
{
  "id": "c0af5b5d-27d1-4533-9a6f-3b79a1457463",
  "tenantId": "5d656bfe-d9ab-4942-bb5c-cf5587371288",
  "email": "admin@acme.com",
  "role": "ADMIN"
}
```

It carries `tenantId` and omits `createdAt` / `deletedAt`. This is `request.user` — what the token
resolved to — rather than a database projection.

**The role here is authoritative and the token's is not.** `JwtStrategy` reads the row on every
request, so an admin demoted thirty seconds ago is an `AGENT` on the next call even though their
access token still says `ADMIN`. A frontend that decodes the JWT client-side to decide what to
render will be wrong for up to 15 minutes; call this route instead.

**401** if the token is missing, malformed, expired, or belongs to a deactivated user.

### `POST /users` — ADMIN

```json
{
  "email": "agent@acme.com",
  "password": "another good password",
  "role": "AGENT"
}
```

`role` is optional and defaults to `REQUESTER`. `password` follows the registration policy (min 8
chars, max 72 bytes). There is no `tenantId` field, and sending one is a 400.

**201** → `UserResponse`. **403** for a non-ADMIN.

**409** on a taken address, with two distinct messages that the frontend should branch on:

```
agent@acme.com is already in use
agent@acme.com belongs to a deactivated user (95e8836c-…). Restore them instead of creating a duplicate.
```

The second one carries the id precisely so the UI can offer "restore this user" instead of a dead
end. A deactivated user still occupies the address — the row survives — so creating a replacement
is impossible and restoring is the intended path.

### `GET /users` — ADMIN or AGENT

Query parameters, all optional:

| Parameter        | Type    | Default | Notes                                                    |
| ---------------- | ------- | ------- | -------------------------------------------------------- |
| `page`           | integer | `1`     | 1-based                                                  |
| `perPage`        | integer | `20`    | **max 100**; a larger value is a 400, not a silent clamp |
| `role`           | enum    | —       | `ADMIN` \| `AGENT` \| `REQUESTER`                        |
| `search`         | string  | —       | 1–255 chars, case-insensitive `contains` on the email    |
| `includeDeleted` | boolean | `false` | **ADMIN only** — 403 for anyone else                     |

```json
{
  "data": [
    {
      "id": "c0af…",
      "email": "admin@acme.com",
      "role": "ADMIN",
      "createdAt": "2026-08-23T13:29:18.546Z",
      "deletedAt": null
    }
  ],
  "meta": { "total": 2, "page": 1, "perPage": 20, "totalPages": 1 }
}
```

Ordered by `createdAt` ascending, then `id` — a stable tiebreak, so a row does not jump between
pages when two share a timestamp. `totalPages` is at least `1` even when `total` is `0`, so a UI can
render "page 1 of 1" on an empty list without a special case.

`includeDeleted` being ADMIN-only is enforced as a **403 rather than a silent ignore**: a caller is
never told "there are no deactivated users" when the real answer is "you may not ask".

Send it as the literal string `true` or `false`. `?includeDeleted=maybe` is a 400.

### `GET /users/:id` — any authenticated user

**200** → `UserResponse`. Any role, because a requester needs to see who an agent is.

**400** `Validation failed (uuid is expected)` if `:id` is not a UUID — before any query runs.

**404** `No user <id>` for: an id that does not exist, an id belonging to **another tenant**, and a
deactivated user when the caller is not an ADMIN.

**Another tenant's id is a 404 and never a 403**, and this is a security property rather than an
oversight. A 403 would confirm the id exists somewhere, which is a fact about another company's
data. 403 is reserved for insufficient role, where there is nothing to reveal.

### `PATCH /users/:id` — ADMIN

```json
{ "email": "new@acme.com", "role": "AGENT" }
```

Both fields optional; send only what changes. **200** → the updated `UserResponse`.

**There is no `password` field here, deliberately.** Changing someone else's password through the
route that renames them is how an over-broad admin action becomes an account takeover. Passwords
change only through `PATCH /users/me/password`, which demands the current one.

**409** on an address already in use, or `The last active ADMIN cannot be demoted. Promote another
user first.` — a tenant with no active ADMIN has no route back, since creating users, restoring
them and changing roles all require one.

### `DELETE /users/:id` — ADMIN

**Deactivates; it does not delete.** The row survives with `deletedAt` set, because the `RESTRICT`
foreign keys from `audit_logs` and `tickets.assignee` make a real delete fail in the database.

**204**, no body. Every refresh token of that user is revoked, so their sessions end.

**409** in three cases, all of them state rather than input, which is why they are not 400s:

- `You cannot deactivate yourself. Ask another ADMIN to do it.`
- `This user is already deactivated`
- `The last active ADMIN cannot be deactivated. Promote another user first.`

### `POST /users/:id/restore` — ADMIN

**200** → the restored `UserResponse`, with `deletedAt` back to `null`. The same row, with its
history still attached — which a fresh create would not give.

Cannot collide on the email: the address stayed occupied the whole time, so nobody could have taken
it. **409** `This user is not deactivated` if it was already active.

### `PATCH /users/me/password` — any authenticated user

```json
{
  "currentPassword": "correct horse battery",
  "newPassword": "a brand new password"
}
```

**204**, no body.

**401** `The current password is incorrect` — a 401 and not a 400, because the request is well
formed and it is the credential that fails.

**409** `The new password must differ from the current one`.

**This ends every other session.** All refresh tokens for the user are revoked, which is the reason
a password change is worth anything after a leak. The caller's own access token keeps working until
it expires — it is stateless — but their refresh token does not, so the current session survives
roughly 15 minutes and then needs a fresh login. A frontend that changes a password should either
log the user out immediately or log them back in with the new credentials.

`currentPassword` is only checked for non-emptiness, not against the current policy: it may predate
a policy change, and rejecting it would lock the user out of the very route that fixes that.

### Tokens, and the session lifecycle

Two tokens, signed with **two different keys**, and both lifetimes are configurable:

| Token   | Env var                  | Default | Carries                            |
| ------- | ------------------------ | ------- | ---------------------------------- |
| access  | `JWT_EXPIRES_IN`         | `15m`   | `sub`, `tenantId`, `email`, `role` |
| refresh | `JWT_REFRESH_EXPIRES_IN` | `7d`    | `sub`, `tenantId`, `jti`           |

The refresh token deliberately carries fewer claims. The application refuses to boot if the two
signing keys are equal — under one key a refresh token would be accepted as a bearer token and the
15 minutes would stop meaning anything.

The claims are readable by anyone holding the token; they are signed, not encrypted. Nothing secret
belongs in them, and the client should treat `role` there as a hint rather than a fact — see
`GET /auth/me`.

The flow a client implements:

```
register / login  ──► { accessToken, refreshToken, user }
                          │
     every request ───────┤ Authorization: Bearer <accessToken>
                          │
        401 received ─────► POST /auth/refresh { refreshToken }
                          │        │
                          │        ├─ 200 → store the NEW pair, retry the request once
                          │        └─ 401 → the session is over, send the user to login
                          │
             logout  ─────► POST /auth/logout { refreshToken }  (204)
```

Two failure modes worth designing for up front. A 401 on a normal route means "refresh and retry
once" — retrying more than once loops. A 401 from the refresh route itself means the session is
genuinely over, including the case where someone else's reuse of the token revoked the family.

### Known gaps

Real today, and a client will hit them:

- **CORS is not configured.** `configureApp()` enables no CORS, so a browser on another origin is
  blocked. It has to be added in `src/app.setup.ts` before a separate frontend can call this API at
  all.
- **No rate limiting on `POST /auth/login`.** Nothing throttles credential guessing yet.
- **No password reset and no email invitation.** An ADMIN sets the initial password directly, and a
  forgotten password has no self-service path. Both wait on email delivery, which the project does
  not have.
- **No OpenAPI/Swagger document.** This file is the contract; there is no generated spec to point a
  client generator at.

The pending list lives in `documents/CHECKLIST_USERS_AUTH.md`.

---

## Part II — measured behaviour

Everything below was **measured in this repository**, against Prisma 7.9.1, bcrypt 6.0.0,
class-transformer 0.5.1 and `@nestjs/config` 4. These are not recommendations taken from
documentation: they are things the code depends on being true, each with the test that will tell
you when one of them stops being so.

This is the _why_ behind Part I.

### The tenant before a tenant exists

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

### A `$transaction` that changes scope halfway through

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

### The interceptor and the laziness of the Observable

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

### `tenantScoped()` exists because of the types, not the runtime

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

### Refresh tokens

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

### bcrypt truncates at 72 bytes and says nothing

Measured against bcrypt 6.0.0: `hash()` of 81 characters followed by `compare()` with a different
password that shares the first 72 returns **`true`**, and `hash()` does not throw on long input. Two
long passwords become the same credential, and whoever chose a passphrase gets far less security
than its length suggests.

Hence `@MaxBytes(72)` in `src/auth/password.constraints.ts` — **bytes**, not characters: an emoji
costs four, and a `@MaxLength(72)` would let through 288 bytes of which bcrypt would keep 18.

### An identical message is not enough: timing gives it away too

Login answers the same 401 for a nonexistent tenant, a nonexistent user and a wrong password. That
alone does not settle it: skipping bcrypt on the not-found path made the response come back in ~1ms
against ~50ms on the found path, and a stopwatch answers "does this account exist?" — the question
the message refused to answer.

`HashingService.compareWithDecoy()` spends the same time. The decoy hash is built in `onModuleInit`
from the configured cost, not hard-coded: a bcrypt hash carries its own cost factor, so a fixed
decoy would burn a different amount of time than the real hashes and reintroduce the very difference
it exists to hide.

### Soft delete versus the unique email

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

### `Boolean('false')` is `true`

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

### Two API choices that look like details

**404 and never 403 for another tenant's resource.** The extension filters, so the id is simply not
found. A 403 would confirm that the id exists somewhere, which is a fact about another company's
data. 403 is reserved for insufficient role, where there is nothing to reveal.

**`UpdateUserDto` is written by hand, not `PartialType(CreateUserDto)`.** The derived version would
inherit `password`, and changing someone else's password through the same route that renames them is
exactly how an overly broad admin action turns into an account takeover. Passwords only through
`PATCH /users/me/password`, which requires the current one and ends every session.
