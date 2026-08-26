# The platform operator

The reference for `src/platform/`: the single `ADMIN_MASTER`, the company CRUD and the company-user
CRUD. In two parts that serve different readers.

**Part I is the contract**: every route, with the request and response payloads a client actually
receives, and the full error catalogue. Its reader is somebody integrating against this API —
nothing in it requires reading the source. Hand it to whoever writes the platform console.

**Part II is the measured behaviour**: why the operator lives in a reserved tenant rather than in a
`User` with no tenant, why `Tenant.isPlatform` is `Boolean?` and not `Boolean`, why creating a
company demands its first ADMIN, and the two database constraints that hold when the application
layer is bypassed. Read it before editing `src/platform/`.

Every payload below was captured from the running application, not written from the DTOs.

---

## Part I — the contract

### What changed, if you have integrated before

**`POST /auth/register` no longer exists.** It answers `404`, and it answers `404` with a valid
token too — the route is gone, not locked down. A company does not sign itself up any more: the
platform operator creates it, together with its first ADMIN, at `POST /platform/companies`.

### The three roles a request can carry

| Role           | Is                                 | Sees                                                         |
| -------------- | ---------------------------------- | ------------------------------------------------------------ |
| `ADMIN_MASTER` | the platform operator. Exactly one | `/platform/**`. Gets `403` on `/users` and the rest          |
| `ADMIN`        | a company's administrator          | its own company's `/users`. Gets `403` on all of `/platform` |
| `AGENT`        | works tickets                      | may list its own company's users                             |
| `REQUESTER`    | opens tickets; the default         | itself                                                       |

**The roles are not hierarchical.** `RolesGuard` checks membership in a list, never an ordering, so
"higher" never implies access. `ADMIN_MASTER` does not inherit anything from `ADMIN` — it operates a
company's users through `/platform/companies/:companyId/users`, not through `/users`.

There is **exactly one** `ADMIN_MASTER`, ever. It is seeded from `ADMIN_MASTER_EMAIL` and
`ADMIN_MASTER_PASSWORD` at boot, no route can assign the role, and a partial unique index in
PostgreSQL refuses a second row.

### How the operator signs in

Through the ordinary login route. There is no separate one:

```http
POST /auth/login
{ "tenantDomain": "platform", "email": "admin@nexusops.local", "password": "…" }
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": {
    "id": "820d40ea-0072-477d-b2da-fd7269decf04",
    "email": "admin@nexusops.local",
    "role": "ADMIN_MASTER",
    "createdAt": "2026-08-25T13:03:00.339Z",
    "deletedAt": null
  }
}
```

`tenantDomain` is `"platform"`, a reserved value. It is the only thing that differs from any other
login, so **one login form serves both** — what changes is where the domain comes from, not the
shape of the request. The reserved domain cannot be claimed by a company: `POST /platform/companies`
refuses it with `400`.

Everything about tokens, refresh and logout is unchanged and lives in
[`USERS.md`](./USERS.md#tokens-and-the-session-lifecycle).

### Conventions

Same as everywhere else in this API, and stated in full in
[`USERS.md`](./USERS.md#conventions-that-hold-on-every-route): no route prefix,
`Authorization: Bearer <accessToken>`, `application/json`, unknown fields are a `400` rather than
ignored, e-mails and domains are normalised server-side, dates are ISO 8601 UTC.

Two that matter more here than elsewhere:

**No route accepts a `tenantId`.** The company is named in the path, and the scope is opened from
it. There is nothing to pass.

**`404` is not `403`.** A company that does not exist, a company id that is the reserved platform
tenant, and a user belonging to a different company all answer `404`. A `403` would confirm the id
exists somewhere, which is a fact about somebody else's data. `403` is reserved for insufficient
role, where there is nothing to reveal.

### Endpoints at a glance

| Method   | Path                                                   | Auth           | Success | Purpose                           |
| -------- | ------------------------------------------------------ | -------------- | ------- | --------------------------------- |
| `POST`   | `/platform/companies`                                  | `ADMIN_MASTER` | 201     | create a company and its ADMIN    |
| `GET`    | `/platform/companies`                                  | `ADMIN_MASTER` | 200     | list companies, paginated         |
| `GET`    | `/platform/companies/:companyId`                       | `ADMIN_MASTER` | 200     | one company                       |
| `PATCH`  | `/platform/companies/:companyId`                       | `ADMIN_MASTER` | 200     | rename, re-domain, or suspend     |
| `DELETE` | `/platform/companies/:companyId`                       | `ADMIN_MASTER` | 204     | **delete for real**, irreversible |
| `POST`   | `/platform/companies/:companyId/users`                 | `ADMIN_MASTER` | 201     | create a user in that company     |
| `GET`    | `/platform/companies/:companyId/users`                 | `ADMIN_MASTER` | 200     | list its users, paginated         |
| `GET`    | `/platform/companies/:companyId/users/:userId`         | `ADMIN_MASTER` | 200     | one user                          |
| `PATCH`  | `/platform/companies/:companyId/users/:userId`         | `ADMIN_MASTER` | 200     | change e-mail or role             |
| `DELETE` | `/platform/companies/:companyId/users/:userId`         | `ADMIN_MASTER` | 204     | deactivate (soft)                 |
| `POST`   | `/platform/companies/:companyId/users/:userId/restore` | `ADMIN_MASTER` | 200     | reactivate                        |

The user half is the same service `/users` uses, run inside the named company. Every rule documented
in [`USERS.md`](./USERS.md) — the last-ADMIN guard, the deactivated-e-mail conflict, the response
shape — holds identically here.

### `CompanyResponse`

Every route that returns a company returns exactly this:

```json
{
  "id": "cf60742a-f70e-4d03-9c4b-d8ea8683d295",
  "name": "Acme Industries",
  "domain": "acme.example",
  "isActive": true,
  "createdAt": "2026-08-25T14:06:01.234Z"
}
```

`UserResponse` and the `{ data, meta }` page envelope are the ones already defined in
[`USERS.md`](./USERS.md); they are not redefined here.

### `POST /platform/companies` — ADMIN_MASTER

**The first ADMIN is mandatory, in the same call.** This is not a convenience: a company with no
ADMIN is one where nobody can create the first user, nobody can log in, and the last-ADMIN guard can
never be satisfied. There is no route out of that state, so it is not reachable.

```json
{
  "name": "Acme Industries",
  "domain": "acme.example",
  "admin": {
    "email": "admin@acme.example",
    "password": "a-long-enough-password"
  }
}
```

| Field            | Rules                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `name`           | 2–255 characters, trimmed                                                 |
| `domain`         | 3–100 characters, a hostname (`acme.com` or `acme`), lowercased, unique   |
| `admin.email`    | a valid e-mail, 3–255 characters, lowercased                              |
| `admin.password` | at least 8 characters and at most 72 **bytes** — bcrypt truncates past it |

`201`:

```json
{
  "company": {
    "id": "cf60742a-f70e-4d03-9c4b-d8ea8683d295",
    "name": "Acme Industries",
    "domain": "acme.example",
    "isActive": true,
    "createdAt": "2026-08-25T14:06:01.234Z"
  },
  "admin": {
    "id": "4bee9818-fbf7-4ca3-9519-ce2e5418e516",
    "email": "admin@acme.example",
    "role": "ADMIN",
    "createdAt": "2026-08-25T14:06:01.235Z",
    "deletedAt": null
  }
}
```

No token comes back. The operator created the company; it did not become its ADMIN. That ADMIN signs
in for itself at `POST /auth/login` with the new domain.

| Status | When                                                                   |
| ------ | ---------------------------------------------------------------------- |
| `400`  | validation, including `"platform"` as the domain and a missing `admin` |
| `401`  | no token, or an expired one                                            |
| `403`  | the caller is not the `ADMIN_MASTER`                                   |
| `409`  | `The domain "acme.example" is already registered`                      |

### `GET /platform/companies` — ADMIN_MASTER

| Parameter  | Default | Rules                                                             |
| ---------- | ------- | ----------------------------------------------------------------- |
| `page`     | `1`     | at least 1                                                        |
| `perPage`  | `20`    | 1–100. **101 is a `400`, not a silent clamp**                     |
| `search`   | —       | 1–255 characters, matched case-insensitively on name _and_ domain |
| `isActive` | —       | `true` or `false`. **Absent means both**                          |

```json
{
  "data": [
    {
      "id": "baee00af-c456-46ed-a294-8f2aaead4ef9",
      "name": "Acme Inc",
      "domain": "acme.com",
      "isActive": true,
      "createdAt": "2026-08-23T22:39:29.224Z"
    }
  ],
  "meta": { "total": 3, "page": 1, "perPage": 2, "totalPages": 2 }
}
```

Ordered by `createdAt` ascending, with `id` as a stable tiebreak. `totalPages` is at least 1 even
when `total` is 0.

**The platform tenant is never in this list.** It is not a company.

### `GET /platform/companies/:companyId` — ADMIN_MASTER

`200` with a `CompanyResponse`. `404` if there is no such company, **and `404` for the platform
tenant's own id** — see Part II. `400` if the id is not a UUID:
`{"message":"Validation failed (uuid is expected)","error":"Bad Request","statusCode":400}`.

### `PATCH /platform/companies/:companyId` — ADMIN_MASTER

Any subset of `name`, `domain` and `isActive`, with the same rules as on create.

```json
{ "name": "Acme Industries Ltd", "isActive": true }
```

`200` with the updated `CompanyResponse`. `409` on a domain another company already holds.

**`isActive: false` is how a company is suspended.** Login refuses an inactive company for every one
of its users at once, with the ordinary `401 Invalid credentials`, and not a single user row is
touched. It is fully reversible, and it is what to reach for instead of `DELETE`.

### `DELETE /platform/companies/:companyId` — ADMIN_MASTER

`204`, no body. **Irreversible, and it takes everything with it**: the company's users, tickets,
comments, refresh tokens and its entire audit trail, by database cascade. There is no restore.

A console must treat this as a destructive action and confirm it explicitly. `PATCH` with
`isActive: false` is the reversible one.

### The company-user routes

`POST`, `GET`, `PATCH`, `DELETE` and `/restore` under `/platform/companies/:companyId/users`,
carrying exactly the payloads and rules documented in [`USERS.md`](./USERS.md) for `/users`. Two
differences, both consequences of who is calling:

**The assignable roles are `ADMIN`, `AGENT` and `REQUESTER`.** `ADMIN_MASTER` is refused here as it
is everywhere else — a role selector should offer three options:

```json
{
  "message": [
    "role must be one of the following values: ADMIN, AGENT, REQUESTER"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

**`?includeDeleted=true` is allowed for the operator**, because restoring a user requires seeing it
first.

An example, `POST /platform/companies/:companyId/users`:

```json
{
  "email": "agent@acme.example",
  "password": "a-long-enough-password",
  "role": "AGENT"
}
```

```json
{
  "id": "197b05b8-4081-48d9-a70f-7b5cafb4e93a",
  "email": "agent@acme.example",
  "role": "AGENT",
  "createdAt": "2026-08-25T14:06:01.623Z",
  "deletedAt": null
}
```

### The error catalogue

The envelope is the one used everywhere: `message` is a **string** for a business error and an
**array** for validation. `401` carries no `error` key. `204` carries no body at all.

| Status | Meaning here                                                                                 |
| ------ | -------------------------------------------------------------------------------------------- |
| `400`  | validation, or a path parameter that is not a UUID                                           |
| `401`  | no token, an expired one, or a company that has been suspended                               |
| `403`  | insufficient role — and only that                                                            |
| `404`  | no such company, the platform tenant, or a user of a different company                       |
| `409`  | well-formed but refused by the current state: duplicate domain, duplicate e-mail, last ADMIN |

Real bodies:

```json
{
  "message": "The domain \"acme.example\" is already registered",
  "error": "Conflict",
  "statusCode": 409
}
```

```json
{
  "message": ["domain \"platform\" is reserved for the platform itself"],
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": ["property isPlatform should not exist"],
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": ["admin must be a non-empty object"],
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": "No company 00000000-0000-4000-8000-000000000000",
  "error": "Not Found",
  "statusCode": 404
}
```

```json
{
  "message": "This route requires one of: ADMIN_MASTER",
  "error": "Forbidden",
  "statusCode": 403
}
```

```json
{ "message": "Unauthorized", "statusCode": 401 }
```

---

## Part II — measured behaviour

### The operator lives in a reserved tenant, not outside every tenant

`User.tenantId` is `NOT NULL`, and the composite foreign keys the tenancy layer depends on —
`Ticket.requester`, `Ticket.assignee`, `AuditLog.user`, `RefreshToken.user` — all point at
`@@unique([tenantId, id])`. An operator with no tenant would have meant making that column nullable,
and two things break at once if it does: `@@unique([tenantId, email])` stops enforcing anything
(NULLs are distinct in PostgreSQL, so two operators with the same address both fit), and the
composite FKs stop being checked at all, because `MATCH SIMPLE` skips the constraint when any
referencing column is NULL. That is the exact hole the tenancy layer exists to close.

So the operator is an ordinary `User` inside one reserved tenant, and the payoff is visible in what
did **not** have to change: `AuthService.login`, `JwtStrategy`, `RefreshToken`, the JWT payload and
`TenantContextInterceptor` are untouched. The operator authenticates, refreshes and logs out through
the code that was already there.

### `Tenant.isPlatform` is `Boolean?`, and that is the whole trick

PostgreSQL treats NULLs as distinct in a unique index. A nullable, unique boolean therefore permits
**at most one `true`** and any number of NULLs — which is exactly "one platform tenant, unlimited
companies", expressed as a constraint `schema.prisma` can state. A partial index would have said the
same thing and been invisible to Prisma, showing up as drift on every `migrate dev`.

It also keeps the company listing exact. Filtering is `where: { isPlatform: null }`, not
`domain: { not: "platform" }` — the latter drops every company whose domain is NULL, because
`NOT (NULL = 'platform')` is NULL rather than true, and a row that evaluates to NULL is not returned.

Measured directly against the database: a second row with `isPlatform: true` is refused, and two
companies with `is_platform` NULL are both accepted.

### At most one ADMIN_MASTER, and the migration that cannot be merged

```sql
CREATE UNIQUE INDEX "users_single_admin_master"
  ON "users" ((true))
  WHERE "role" = 'ADMIN_MASTER';
```

No `AND deleted_at IS NULL`: exactly one row, always. A deactivated operator is restored by the
bootstrap rather than replaced, so there is never a reason for a second.

**It lives in its own migration, and that is not tidiness.** PostgreSQL refuses to _use_ an enum
value added in the same transaction — "unsafe use of new value of enum type" — and Prisma runs each
migration file in one transaction. `ALTER TYPE "UserRole" ADD VALUE 'ADMIN_MASTER'` and an index
referencing that value therefore cannot share a file.

**Known cost:** a partial index is not expressible in `schema.prisma`, so `prisma migrate dev` reads
this one as drift and offers to drop it. Keep it. If that friction ever outweighs the constraint, the
fallback is the same trick used for the tenant — `isPlatformAdmin Boolean? @unique` on `User` — at
the price of a column restating what `role` already says.

### The escalation the enum opened, and the two layers that close it

Adding `ADMIN_MASTER` to `UserRole` was not free. With the DTOs on `@IsEnum(UserRole)`, any company's
own ADMIN could have sent `POST /users { "role": "ADMIN_MASTER" }` and minted a platform operator
inside their own company — an escalation straight out of the tenant, which is the boundary this
project exists to hold.

Two layers, mirroring the two layers of tenancy:

1. `ASSIGNABLE_ROLES` in `src/users/assignable-role.ts`, used with `@IsIn` on `CreateUserDto`,
   `UpdateUserDto` and `QueryUsersDto`. It fails closed in the global `ValidationPipe`, so such a
   request is a `400` before any service runs.
2. The partial unique index above, which refuses a second row even if something bypasses the pipe.

The query DTO uses the same list deliberately: filtering by a role no company user can hold would
answer an empty page, and "there are none" is a different statement from "you cannot ask that".

### Why company creation demands an ADMIN, and why it is one transaction

A company with no ADMIN cannot be administered and cannot be entered: creating users, restoring them
and changing roles all require one, and `UsersService.assertNotLastAdmin` can never be satisfied
starting from zero. So the two halves are created together, and they commit together — a duplicate
domain that left a tenant behind would leave exactly that unreachable company.

This is `AuthService.register` moved rather than rewritten, and the delicate part came with it: the
tenant scope changes halfway through a single transaction, because `Tenant` is tenant-agnostic and
`User` is not. Two Prisma 7.9.1 properties make it work, and both are pinned in
`test/integration/platform-companies.int-spec.ts`: extensions apply to the interactive transaction
client `tx`, and `AsyncLocalStorage` survives the awaits inside the callback.

### Every company query runs unscoped, and it has to say so

`Tenant` is the one model in `TENANT_AGNOSTIC`. Exempt is not unguarded: under a tenant scope the
extension rewrites a `Tenant` read to `where.id = <current tenant>`. The operator's request carries
the platform tenant's scope, opened by `TenantContextInterceptor` from its own token — so without
`runWithoutTenant()`, `GET /platform/companies` would return the platform row and nothing else.

That is why `CompaniesService` wraps every query in it, and why the wrapper is explicit rather than
ambient: `grep -rn runWithoutTenant src/` is a complete audit of every unscoped read in the codebase,
and this file has to appear in it.

### `requireCompany()` is the chokepoint, and it 404s on two different things

Every nested route starts there. The first reason is the obvious one: `runWithTenant()` accepts any
non-empty string, so an id belonging to no company would open a scope over nothing and
`GET .../users` would answer `200` with an empty page — "this company has no users" instead of "there
is no such company".

The second is not obvious and matters more. **The platform tenant answers `404` here too.** Without
that half, `/platform/companies/<platform-id>/users/<self>` lets the operator deactivate itself, and
the installation is left with no operator and no way to mint another short of a restart. The e2e
suite asserts `404` on reading it, listing its users and deleting it.

### The cascade that looked like it would fail, and does not

`DELETE /platform/companies/:companyId` is a plain `tenant.delete`. Every child relation cascades
from `Tenant` — but `audit_logs.user_id` and `tickets.assignee_id` are `ON DELETE RESTRICT`, so a
cascade that reached the users while those rows still referenced them would be refused.

Measured before the method was written, with a tenant holding two users, a ticket with an assignee
and an audit log row: the delete succeeds and every table comes back empty. The rows referencing a
user are removed by their own tenant cascade within the same statement, so nothing is left to
restrict. Re-check this if the foreign keys change.

### The bootstrap converges rather than accumulates

`PlatformBootstrapService.onModuleInit` runs on every boot, including every e2e suite's
`createTestApp()`. Three decisions follow from that, and each one was wrong in the first draft:

**It finds the existing operator by `role`, not by e-mail.** Keyed on the e-mail, changing
`ADMIN_MASTER_EMAIL` would try to create a _second_ operator and die on the unique index. By role,
the same change renames the one that exists — verified against a running server: the old address
stops authenticating, the new one starts, and the table still holds one row.

**It re-hashes only when the password actually changed.** bcrypt salts randomly, so hashing
unconditionally rewrites the row on every boot and makes "nothing changed" indistinguishable from
"the password rotated".

**It is not a single transaction, unlike `register`.** Register cannot be interrupted: a tenant
without its first ADMIN is unreachable and nothing retries it. This runs again on the next boot, so a
partial application self-heals — and wrapping it would hold a database connection open across a
bcrypt hash at production cost, which the register path already refuses to do.

A deactivated operator is restored, never replaced. `.env` is the source of truth for both the
address and the password.

### The CI boot check now needs a database

`.github/workflows/ci.yml` boots the built image and curls it. Its comment used to say, correctly,
that the database did not need to exist because Prisma connects on the first query and none happened
there. The bootstrap made that false.

The database was never missing — `npm run test:setup` starts it two steps earlier. It was
unreachable: `DATABASE_URL` points at `localhost:5433`, which under bridge networking is the
container itself. The step now runs `--network host`, as the smoke step below it always has, and
passes `ADMIN_MASTER_EMAIL` and `ADMIN_MASTER_PASSWORD` through from the same `.env.test`.

The check is stronger for it: it stopped being only "the build emitted something" and became "the
image boots against a real database and provisions its operator". Verified by reproducing both
variants locally — with `--network host` the container's own log reports
`Created the ADMIN_MASTER`, and with the old `-p 3000:3000` it never answers and dies.
