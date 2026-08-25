# Frontend spec — NexusOps

Everything the frontend needs, in one file. You should not have to open the backend source to build
against this API.

Every payload below was **captured from the running application**. Nothing here was written from the
DTOs or inferred from the code — the exact strings are the exact strings.

> **Read this first if you have integrated before.** `POST /auth/register` no longer exists. It
> answers `404`, and it answers `404` with a valid token too — the route is gone, not locked down. A
> public sign-up screen has to be removed; companies are created by the platform operator. This is
> the change that breaks an existing frontend.

---

## 1. What you are building: two consoles, not one

The API now serves two different kinds of user, and the UI has to branch on which one signed in.

| The operator console                      | The company console                      |
| ----------------------------------------- | ---------------------------------------- |
| Role `ADMIN_MASTER`. Exactly one exists   | Roles `ADMIN`, `AGENT`, `REQUESTER`      |
| Manages **companies** and **their users** | Manages **its own** users                |
| Lives under `/platform/**`                | Lives under `/users` and `/auth`         |
| Gets `403` on `/users`                    | Gets `403` on every `/platform/**` route |

**The roles are not hierarchical.** The backend checks membership in a list, never an ordering, so
"higher" never implies access. `ADMIN_MASTER` genuinely cannot use `/users` — it reaches a company's
users through `/platform/companies/:companyId/users` instead. Do not build a role hierarchy in the
client and assume the API agrees; it does not.

Branch on `user.role` from the login response, and treat the two consoles as separate route trees.

---

## 2. Authentication

### The login form is the same for both

```http
POST /auth/login
Content-Type: application/json

{ "tenantDomain": "acme.example", "email": "admin@acme.example", "password": "…" }
```

`tenantDomain` is **required**, and it is the piece that surprises people: an e-mail address is only
unique _within_ a company, so it alone is ambiguous. Both consoles use the same request; only where
the domain comes from differs.

- The **company console** gets it from the user (a field, a subdomain, whatever you choose).
- The **operator** types the reserved literal `platform`.

`200`:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": {
    "id": "554af5c6-6815-4e65-87e0-4edfabb73563",
    "email": "admin@acme.example",
    "role": "ADMIN",
    "createdAt": "2026-08-25T14:17:48.820Z",
    "deletedAt": null
  }
}
```

Every failure — no such company, no such user, wrong password, **suspended company** — answers the
same body, captured:

```json
{ "message": "Invalid credentials", "error": "Unauthorized", "statusCode": 401 }
```

That is deliberate, so do not try to tell them apart in the UI; you cannot, and a suspended company
looks exactly like a typo in the password.

### The session loop

```
login  ──►  { accessToken, refreshToken, user }
              │
 every call ──┤  Authorization: Bearer <accessToken>
              │
   401 ───────►  POST /auth/refresh { refreshToken }
              │        ├─ 200 → store the NEW pair, retry the original call once
              │        └─ 401 → the session is over, go to login
              │
  logout ─────►  POST /auth/logout { refreshToken }   → 204
```

**Refresh rotates.** The response carries a _new_ refresh token and the old one stops working
immediately. Store the new pair or the next refresh fails.

**Presenting a spent refresh token kills every session that user has.** The backend cannot tell the
legitimate holder from someone who copied it, so it revokes the whole family. Practical consequence:
if two tabs refresh at the same moment with the same token, the user is logged out everywhere.
Serialise refreshes — one in-flight refresh, other calls queue behind it.

`POST /auth/refresh` returns the same shape as login. After logout, reusing the token:

```json
{
  "message": "Invalid refresh token",
  "error": "Unauthorized",
  "statusCode": 401
}
```

### `GET /auth/me`

The only response in the API that carries `tenantId`:

```json
{
  "id": "554af5c6-6815-4e65-87e0-4edfabb73563",
  "tenantId": "4121043a-f2f2-42dc-8b29-8703a4e3fd5c",
  "email": "admin@acme.example",
  "role": "ADMIN"
}
```

The role comes from the database on **every** request, not from the token. A user demoted a moment
ago loses access immediately rather than when their token expires — so a `403` can appear on a
screen that was working, and the UI should handle it as a state, not as an impossibility.

---

## 3. Shapes you will use everywhere

```ts
type Role = 'ADMIN_MASTER' | 'ADMIN' | 'AGENT' | 'REQUESTER';

// Every route that returns a user returns exactly this. No password field ever appears.
type UserResponse = {
  id: string;
  email: string;
  role: Role; // 'ADMIN_MASTER' only ever on GET /auth/me
  createdAt: string; // ISO 8601 UTC
  deletedAt: string | null; // non-null = deactivated
};

// Every route that issues tokens returns exactly this.
type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: UserResponse;
};

// Every route that returns a company returns exactly this.
type CompanyResponse = {
  id: string;
  name: string;
  domain: string | null;
  isActive: boolean;
  createdAt: string;
};

// Every paginated list.
type Page<T> = {
  data: T[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};
```

`totalPages` is at least `1`, even when `total` is `0` — do not render "page 1 of 0".

**Never send a field the API did not define**, not even an `id` or `tenantId` echoed back from a
previous response. Unknown fields are a `400`, not ignored. This bites when a form binds a whole
object and posts it back.

---

## 4. The operator console — `/platform/**`

All of these require `ADMIN_MASTER`. Every other role gets `403`.

| Method   | Path                                                   | Success | Purpose                       |
| -------- | ------------------------------------------------------ | ------- | ----------------------------- |
| `POST`   | `/platform/companies`                                  | 201     | create a company + its ADMIN  |
| `GET`    | `/platform/companies`                                  | 200     | list, paginated               |
| `GET`    | `/platform/companies/:companyId`                       | 200     | one company                   |
| `PATCH`  | `/platform/companies/:companyId`                       | 200     | rename / re-domain / suspend  |
| `DELETE` | `/platform/companies/:companyId`                       | 204     | **delete for real**           |
| `POST`   | `/platform/companies/:companyId/users`                 | 201     | create a user in that company |
| `GET`    | `/platform/companies/:companyId/users`                 | 200     | list its users, paginated     |
| `GET`    | `/platform/companies/:companyId/users/:userId`         | 200     | one user                      |
| `PATCH`  | `/platform/companies/:companyId/users/:userId`         | 200     | change e-mail or role         |
| `DELETE` | `/platform/companies/:companyId/users/:userId`         | 204     | deactivate (reversible)       |
| `POST`   | `/platform/companies/:companyId/users/:userId/restore` | 200     | reactivate                    |

### Creating a company — one form, both halves

**The first ADMIN is part of the same request.** This is not optional and it is not two screens: a
company with no ADMIN is one nobody can log into and nobody can add users to, so the API refuses to
create one. Design a single form with a "company" section and an "administrator" section.

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

| Field            | Rules for client-side validation                                                |
| ---------------- | ------------------------------------------------------------------------------- |
| `name`           | 2–255 characters                                                                |
| `domain`         | 3–100 characters, hostname shape (`acme` or `acme.com`), lowercased server-side |
| `admin.email`    | a valid e-mail, 3–255 characters                                                |
| `admin.password` | at least 8 characters, at most **72 bytes** — see the note below                |

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

**No token comes back.** The operator created the company; it did not become its administrator. Show
the new ADMIN's credentials once and tell the operator to hand them over — there is no invitation
e-mail and no password reset (see §7).

**72 bytes, not 72 characters.** One accented letter costs two, one emoji costs four. If you enforce
a maximum in the client, count bytes (`new TextEncoder().encode(pw).length`), or a password that
looks legal will be rejected.

### Listing companies

`GET /platform/companies?page=1&perPage=20&search=acme&isActive=true`

| Parameter  | Default | Notes                                                             |
| ---------- | ------- | ----------------------------------------------------------------- |
| `page`     | `1`     | at least 1                                                        |
| `perPage`  | `20`    | 1–100. **101 is a `400`, not a silent clamp** — cap your selector |
| `search`   | —       | 1–255 chars, matches name _and_ domain, case-insensitively        |
| `isActive` | —       | `"true"` / `"false"`. **Omit it entirely to get both**            |

Do not send `isActive=""` or `isActive=all` to mean "both" — omit the parameter. Anything that is
not `true` or `false` is a `400`.

### Suspending versus deleting — these are different operations

**`PATCH { "isActive": false }` suspends.** Every user of that company is locked out at the next
login with the ordinary `401 Invalid credentials`, no user row is touched, and it is fully
reversible with `isActive: true`. This is what "offboard a customer" should mean in the UI.

**`DELETE` destroys.** The company, all its users, all its tickets, all its comments and its entire
audit trail, permanently. There is no restore endpoint and no undo.

Treat `DELETE` as a destructive action: a confirmation that names the company, ideally typed, and
not a row-level trash icon next to the suspend toggle. Offer suspend first.

### Managing a company's users

Same payloads as the company console's `/users` (§5). Two differences:

- The **role selector offers `ADMIN`, `AGENT`, `REQUESTER`** and nothing else. `ADMIN_MASTER` is
  refused with a `400`.
- `?includeDeleted=true` **is** allowed for the operator, because restoring a user means finding it
  first.

---

## 5. The company console — `/users`

| Method   | Path                 | Who         | Success | Purpose                   |
| -------- | -------------------- | ----------- | ------- | ------------------------- |
| `POST`   | `/users`             | ADMIN       | 201     | create a user             |
| `GET`    | `/users`             | ADMIN,AGENT | 200     | list, paginated           |
| `GET`    | `/users/:id`         | any         | 200     | one user                  |
| `PATCH`  | `/users/:id`         | ADMIN       | 200     | change e-mail or role     |
| `DELETE` | `/users/:id`         | ADMIN       | 204     | deactivate                |
| `POST`   | `/users/:id/restore` | ADMIN       | 200     | reactivate                |
| `PATCH`  | `/users/me/password` | any         | 204     | change one's own password |

`POST /users`:

```json
{
  "email": "agent@acme.example",
  "password": "a-long-enough-password",
  "role": "AGENT"
}
```

```json
{
  "id": "b66daad8-f011-45bc-865c-fd84fc02b480",
  "email": "agent@acme.example",
  "role": "AGENT",
  "createdAt": "2026-08-25T14:17:49.229Z",
  "deletedAt": null
}
```

`role` is optional and defaults to `REQUESTER`.

`GET /users?role=AGENT&page=1&perPage=20`:

```json
{
  "data": [
    {
      "id": "b66daad8-f011-45bc-865c-fd84fc02b480",
      "email": "agent@acme.example",
      "role": "AGENT",
      "createdAt": "2026-08-25T14:17:49.229Z",
      "deletedAt": null
    }
  ],
  "meta": { "total": 1, "page": 1, "perPage": 20, "totalPages": 1 }
}
```

Query parameters: `page`, `perPage` (max 100), `role`, `search` (matches the e-mail),
`includeDeleted` (**ADMIN only — an AGENT asking gets `403`**).

**Deactivation is a soft delete.** `DELETE` returns `204` and sets `deletedAt`; the user disappears
from the default listing and `POST /users/:id/restore` brings them back unchanged. A "deactivated"
filter and a restore action belong in the UI — otherwise a deactivated user's e-mail stays occupied
and re-creating them fails with a `409` nobody can act on.

---

## 6. Errors — the part worth reading twice

### The envelope, and its two exceptions

```json
{ "message": "...", "error": "Conflict", "statusCode": 409 }
```

`message` is a **string** for a business error and an **array of strings** for validation. A renderer
must handle both, every time:

```ts
const text = Array.isArray(body.message)
  ? body.message.join('\n')
  : body.message;
```

Two exceptions, both captured:

- A missing, malformed or expired bearer token returns **no `error` key**:
  `{"message":"Unauthorized","statusCode":401}`.
- `204` responses have **no body at all** — do not call `.json()` on them.

A `401` that _was_ thrown deliberately does carry `error`, for example a wrong current password:
`{"message":"The current password is incorrect","error":"Unauthorized","statusCode":401}`. So do not
key off the presence of `error` to decide whether a `401` means "log in again".

### What each status means here

| Status | Means                                        | What the UI should do                                  |
| ------ | -------------------------------------------- | ------------------------------------------------------ |
| `400`  | validation, or a path id that is not a UUID  | show the field errors from the array                   |
| `401`  | not authenticated, or a credential was wrong | refresh once; if that fails, go to login               |
| `403`  | **insufficient role, and only that**         | hide or disable the action; do not retry               |
| `404`  | not visible to you                           | treat as "does not exist"                              |
| `409`  | well-formed, refused by the current state    | show the message — these are the ones users can act on |

### `404` is never `403`, and this is a rule about your UI

A company that does not exist, and a user belonging to a **different** company, both answer `404`
with the same body. The API deliberately does not distinguish them, because a `403` would confirm
that the id exists somewhere — a fact about somebody else's data.

**So the client must not infer "it exists but I cannot see it" from a `404`.** Do not render "you do
not have permission to view this company"; render "not found". `403` is exclusively about the
caller's role, where there is nothing to reveal.

### The `409`s, which are the ones worth specific copy

These are well-formed requests refused by the state of the system. Each deserves its own message and
usually its own recovery action:

| Captured message                                                                                         | What the UI should offer                |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `The domain "acme.example" is already registered`                                                        | ask for a different domain              |
| `agent@acme.example is already in use`                                                                   | ask for a different address             |
| `agent@acme.example belongs to a deactivated user (<id>). Restore them instead of creating a duplicate.` | offer a **Restore** button, not a retry |
| `This user is already deactivated`                                                                       | refresh the list; it is stale           |
| `This user is not deactivated`                                                                           | refresh the list; it is stale           |
| `You cannot deactivate yourself. Ask another ADMIN to do it.`                                            | disable the action on one's own row     |
| `The last active ADMIN cannot be deactivated. Promote another user first.`                               | point at promoting somebody first       |
| `The last active ADMIN cannot be demoted. Promote another user first.`                                   | same, on the role selector              |
| `The new password must differ from the current one`                                                      | field-level error                       |

The deactivated-user conflict is the one most worth handling properly: it carries the id, so the
"create user" form can turn straight into a "restore this user" prompt instead of a dead end.

### The `400`s you will actually hit

```json
{
  "message": [
    "role must be one of the following values: ADMIN, AGENT, REQUESTER"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

`ADMIN_MASTER` is never assignable through any route. The role selector offers three options.

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

Sending a field the API did not define. Usually a form posting back a whole object.

```json
{
  "message": ["admin must be a non-empty object"],
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": ["perPage must not be greater than 100"],
  "error": "Bad Request",
  "statusCode": 400
}
```

**Not a silent clamp.** A page-size selector offering 250 will fail rather than return 100.

```json
{
  "message": "Validation failed (uuid is expected)",
  "error": "Bad Request",
  "statusCode": 400
}
```

A path id that is not a UUID. Note this one is a **string**, not an array.

### The `403`s

```json
{
  "message": "This route requires one of: ADMIN_MASTER",
  "error": "Forbidden",
  "statusCode": 403
}
```

```json
{
  "message": "Only an ADMIN may list deactivated users",
  "error": "Forbidden",
  "statusCode": 403
}
```

The second is worth noticing: an AGENT sending `?includeDeleted=true` is refused rather than quietly
given the filtered list, so a shared "show deactivated" toggle must be hidden for non-admins rather
than left to fail.

---

## 7. Flows, in the order the screens run

### Operator: onboard a customer

1. `POST /auth/login` with `tenantDomain: "platform"` → `role` is `ADMIN_MASTER` → operator console.
2. `POST /platform/companies` — **one form**, company plus its first administrator.
3. Show the administrator's credentials once. There is no invitation e-mail (§8).
4. `POST /platform/companies/:companyId/users` for each additional user, role from the three-option
   selector.
5. `GET /platform/companies/:companyId/users` to list, with the same pagination controls as
   everywhere else.

### Operator: offboard a customer

- Reversible: `PATCH /platform/companies/:companyId { "isActive": false }`. Everyone is locked out at
  the next login. Undo with `true`.
- Permanent: `DELETE /platform/companies/:companyId`. Everything is gone, with no undo. Confirm
  destructively.

### Company ADMIN: manage staff

1. `POST /auth/login` with the company's domain → `role` is `ADMIN` → company console.
2. `GET /users` to list; `POST /users` to add; `PATCH /users/:id` for e-mail or role.
3. `DELETE /users/:id` deactivates. Offer a "show deactivated" filter and a restore action.
4. `PATCH /users/me/password` for the caller's own password — **it ends every other session**, which
   is worth telling the user before they submit.

### Any user: the token loop

Implement it once, in the HTTP client, as described in §2. One in-flight refresh, others queued.

---

## 8. Known gaps you must design around

These are real today and a client will hit them.

- **CORS is not configured.** A browser on a different origin is blocked outright. Until the backend
  enables it, develop behind a proxy on the same origin.
- **No password reset and no invitation e-mail.** An ADMIN sets a user's initial password directly
  and hands it over out of band; a forgotten password has no self-service path at all. The operator's
  own password is recoverable only by editing the server's environment. Do not build a "forgot
  password" link yet — there is nothing behind it.
- **No rate limiting on login.** Do not rely on the server to throttle guessing.
- **No OpenAPI document.** This file and `documents/important/PLATFORM.md` are the contract; there is
  nothing to point a client generator at.
- **No tickets yet.** Tickets, comments, the audit trail and the real-time notifications are modelled
  in the database but no endpoint exists. Do not build screens against them.
- **Base URL has no prefix.** Paths are `/auth/login`, not `/api/auth/login`. Put the base URL in one
  constant — a prefix may be added later and would move every path at once.

---

## Where to look for more

- `documents/important/PLATFORM.md` — the operator API in full, plus why it is shaped this way.
- `documents/important/USERS.md` — the auth and users API in full, with the same two-part structure.

Both carry captured payloads too, and Part I of each is written for someone integrating rather than
someone editing the backend.
