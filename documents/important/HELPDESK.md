# The helpdesk

> **Status: under construction.** The `tickets`, `comments`, `audit`, `reports` and `realtime`
> modules are being written now, one pull request at a time. This file grows with each of them and
> is only complete when the last one lands. Until then, treat an empty section as "not written yet",
> not as "nothing to say" — and read [`../helpdesk/PLANO_HELPDESK.md`](../helpdesk/PLANO_HELPDESK.md)
> for the design that is being executed, and
> [`../helpdesk/CHECKLIST_HELPDESK.md`](../helpdesk/CHECKLIST_HELPDESK.md) for what has actually
> shipped.

The reference for the helpdesk slice — tickets, comments, the audit trail, the report queue and the
notification gateway — in two parts that serve different readers.

**Part I is the contract**: the data model, every endpoint, every request and response shape, and
every error the API can return. It is what a client — the frontend above all — needs in order to
integrate, and nothing in it requires reading the source. Every payload in it is captured from the
running application, not written from the types.

**Part II is the measured behaviour**: the reasons behind the decisions in Part I, each one
something that was measured in this repository rather than read in documentation. Read it before
editing `src/tickets/`, `src/comments/`, `src/audit/`, `src/reports/` or `src/realtime/`.

The rules that apply everywhere else in the codebase — never hand-write a tenant filter, workers
have no request context — are in `CLAUDE.md` under "Architecture". The roles themselves, the page
envelope and the conventions every route follows are in [`USERS.md`](./USERS.md); they are not
redefined here.

---

## Part I — the contract

### Who sees which ticket

Visibility is a property of the slice, not of a guard, and it is the first thing a client has to
understand: two users of the same company can ask for the same URL and get different answers.

| Role           | Sees                                             | May also                                                 |
| -------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `ADMIN_MASTER` | nothing — the operator has no tickets of its own | —                                                        |
| `ADMIN`        | every ticket in the company                      | change status, assign, read and write internal notes     |
| `AGENT`        | every ticket in the company                      | change status, assign, read and write internal notes     |
| `REQUESTER`    | only the tickets it opened                       | comment on its own tickets, edit them while not `CLOSED` |

A ticket the caller cannot see answers **404, never 403** — the same rule the rest of the API
follows, and for the same reason: a 403 would confirm that the id exists somewhere.

### The data model

Five tables. Column names below are the **database** names; the API speaks camelCase. `tenant_id`
is on every one of them and appears in no request or response — the tenancy extension puts it in and
takes it out, and a DTO that mentions it is a `400`.

`tickets` — the chamado itself.

| Column                    | Type             | Notes                                                       |
| ------------------------- | ---------------- | ----------------------------------------------------------- |
| `id`                      | `uuid`           | what the API addresses                                      |
| `number`                  | `integer`        | what a person says out loud; restarts at 1 in every company |
| `requester_id`            | `uuid`           | who opened it; never changes                                |
| `assignee_id`             | `uuid?`          | the agent working it, `NULL` while unassigned               |
| `title`                   | `varchar(255)`   | required                                                    |
| `description`             | `text?`          | optional                                                    |
| `status`                  | `TicketStatus`   | `OPEN`                                                      | `IN_PROGRESS` | `RESOLVED` | `CLOSED`, default `OPEN`   |
| `priority`                | `TicketPriority` | `LOW`                                                       | `MEDIUM`      | `HIGH`     | `URGENT`, default `MEDIUM` |
| `category`                | `TicketCategory` | `HARDWARE`                                                  | `SOFTWARE`    | `NETWORK`  | `ACCESS`                   | `OTHER` |
| `version`                 | `integer`        | optimistic concurrency; starts at 1                         |
| `resolved_at`             | `timestamp?`     | stamped on the transition into `RESOLVED`                   |
| `closed_at`               | `timestamp?`     | stamped on the transition into `CLOSED`                     |
| `closed_by_id`            | `uuid?`          | who closed it                                               |
| `created_at`/`updated_at` | `timestamp`      | `updated_at` is maintained by Prisma                        |

`comments` — the thread inside a ticket. Append-only: there is no update and no delete.

| Column        | Type        | Notes                                            |
| ------------- | ----------- | ------------------------------------------------ |
| `id`          | `uuid`      |                                                  |
| `ticket_id`   | `uuid`      |                                                  |
| `author_id`   | `uuid`      |                                                  |
| `body`        | `text`      | required                                         |
| `is_internal` | `boolean`   | default `false`; a `REQUESTER` never sees a true |
| `created_at`  | `timestamp` |                                                  |

`ticket_counters` — one row per company, holding the last number handed out. It has no API surface
and is listed because it explains `tickets.number`: `tenant_id` is the primary key, `last_number` is
an integer starting at 0.

`audit_logs` — the trail. `entity_type` and `entity_id` say what changed, `action` says how,
`old_values` and `new_values` are `JSONB`, and `user_id` is nullable so a deleted actor can be
anonymised without deleting the history.

`reports` — an asynchronous export. `status` is `PENDING` | `PROCESSING` | `COMPLETED` |
`FAILED`, `filters` is the `JSONB` snapshot of the query that produced it, `content` holds the CSV,
`row_count` and `completed_at` are filled on success, and `error` on failure.

### Endpoints at a glance

Every route is authenticated — `JwtAuthGuard` is global — and the `Auth` column says what more is
required. "any" means any authenticated user, narrowed per caller by the visibility rule above
rather than by a guard.

| Method  | Path                    | Auth             | Success | Purpose                                |
| ------- | ----------------------- | ---------------- | ------- | -------------------------------------- |
| `POST`  | `/tickets`              | any              | `201`   | open a ticket; requester is the caller |
| `GET`   | `/tickets`              | any              | `200`   | paginated, filtered list               |
| `GET`   | `/tickets/:id`          | any              | `200`   | one ticket                             |
| `PATCH` | `/tickets/:id`          | any              | `200`   | title, description, priority, category |
| `PATCH` | `/tickets/:id/status`   | `ADMIN`, `AGENT` | `200`   | move through the lifecycle             |
| `PATCH` | `/tickets/:id/assignee` | `ADMIN`, `AGENT` | `200`   | assign, or unassign with `null`        |

**There is no `DELETE`.** `CLOSED` is the terminal state and takes the role a delete would play. A
ticket is the subject of an audit trail, and deleting it would delete what the trail is about.

Query parameters on `GET /tickets`:

| Parameter     | Default | Rules                                                            |
| ------------- | ------- | ---------------------------------------------------------------- |
| `page`        | `1`     | integer, at least 1                                              |
| `perPage`     | `20`    | integer, 1 to 100                                                |
| `status`      | —       | one of the four `TicketStatus` values                            |
| `priority`    | —       | one of the four `TicketPriority` values                          |
| `category`    | —       | one of the five `TicketCategory` values                          |
| `assigneeId`  | —       | uuid                                                             |
| `requesterId` | —       | uuid; **ignored for a `REQUESTER`**, who always gets their own   |
| `unassigned`  | —       | `true` or `false`; a `400` if sent together with `assigneeId`    |
| `search`      | —       | 1 to 255 characters, case-insensitive over title and description |

The page envelope is the `{ data, meta }` one already defined in [`USERS.md`](./USERS.md); it is
not redefined here. `meta.total` respects visibility — a requester's total counts only their own
tickets, because a count that included invisible rows would announce that they exist.

### `TicketResponse`

Every route that returns a ticket returns exactly this shape:

```ts
type TicketResponse = {
  id: string;
  number: number; // restarts at 1 per company; this is "chamado 142"
  title: string;
  description: string | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  category: 'HARDWARE' | 'SOFTWARE' | 'NETWORK' | 'ACCESS' | 'OTHER';
  version: number; // send it back on the next PATCH, or get a 400
  requester: UserResponse;
  assignee: UserResponse | null;
  closedBy: UserResponse | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

`UserResponse` is the one defined in [`USERS.md`](./USERS.md). The three people are embedded rather
than left as ids so that a list screen does not fetch one user per row. `tenantId` appears nowhere,
on the ticket or on the people.

**`version` is on the wire because it has to be.** A client cannot send it back on the next `PATCH`
without having received it, and every write route requires it.

### The lifecycle

```
OPEN ──────────► IN_PROGRESS ──────► RESOLVED ──────► CLOSED
  ▲                   │                  │
  └───────────────────┴──────────────────┘
              (reopen, clears resolvedAt)
```

`OPEN` also goes straight to `RESOLVED`, for the ticket that answers itself. `CLOSED` goes nowhere:
it is terminal, and a closed ticket also refuses `PATCH /tickets/:id`.

Transitions carry side effects the client does not send and cannot override:

| Destination | What the server stamps                             |
| ----------- | -------------------------------------------------- |
| `RESOLVED`  | `resolvedAt = now`                                 |
| `OPEN`      | `resolvedAt = null` — reopening discards the claim |
| `CLOSED`    | `closedAt = now`, `closedBy` = the caller          |

Closing **keeps** `resolvedAt`. When the work finished is the whole point of a time-to-resolution
report, and closing is an administrative act that happens afterwards.

### `CommentResponse`

The thread inside a ticket. Both routes hang off the ticket, and both resolve it first — a ticket
you cannot see 404s before a comment is read or written.

| Method | Path                          | Auth | Success | Purpose            |
| ------ | ----------------------------- | ---- | ------- | ------------------ |
| `POST` | `/tickets/:ticketId/comments` | any  | `201`   | add to the thread  |
| `GET`  | `/tickets/:ticketId/comments` | any  | `200`   | read it, paginated |

`GET` takes `page` and `perPage` only. There is deliberately **no `includeInternal`**: who sees the
internal notes is decided by the caller's role, and a filter would be a filter a requester could
flip. Comments come oldest first — a thread is read from the top down, unlike the ticket list.

```ts
type CommentResponse = {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  author: UserResponse;
  createdAt: string;
};
```

**The internal note.** `isInternal: true` is the note the customer is not meant to read. Only an
`ADMIN` or an `AGENT` can write one — a `REQUESTER` asking for one gets `403`, not `404`, because
the ticket is theirs and visible and what is missing is only the role.

For a `REQUESTER` the notes are filtered out of the page **and out of `meta.total`**. A total that
counted rows they cannot read would announce that something is being hidden, which is most of what
hiding it was for.

**Comments are append-only.** There is no `PATCH` and no `DELETE`; both answer `404` because the
routes do not exist. The thread is what the audit trail renders as a timeline, and a timeline whose
entries can be rewritten is not one.

**A closed ticket takes no new comments** — `409` — but stays readable. Frozen, not hidden.

### The audit trail

Nothing asks for an entry. `TicketsService` and `CommentsService` emit, `AuditListener` records, and
the two never meet — no domain service imports the audit module. That is the Observer the
architecture calls for, and its practical consequence is that forgetting to log is not a thing a
future method can do.

| Method | Path                          | Auth    | Success | Purpose               |
| ------ | ----------------------------- | ------- | ------- | --------------------- |
| `GET`  | `/tickets/:ticketId/timeline` | any     | `200`   | one ticket's history  |
| `GET`  | `/audit`                      | `ADMIN` | `200`   | the company-wide feed |

The timeline resolves the ticket first, so one you cannot see answers `404` — it is not a side
channel onto the tickets the list route hides. The feed spans every ticket, which is why the ticket
visibility rule cannot narrow it and `ADMIN` is the only thing that can.

Both take `page`, `perPage`, `action` and `userId`; the feed also takes `entityId`. The timeline
reads **oldest first**, the feed **newest first**.

```ts
type AuditResponse = {
  id: string;
  entityType: 'Ticket';
  entityId: string;
  action: AuditAction;
  oldValues: unknown; // JSONB; shape depends on the action, see below
  newValues: unknown;
  user: UserResponse | null; // null once the actor has been anonymised
  createdAt: string;
};
```

**Everything is recorded against the ticket**, comments included. A comment appears as a
`commented` action on the ticket rather than as an entry about itself, because a timeline that had
to chase a second entity to find out somebody replied would not be a timeline. The comment
_bodies_ come from `GET /tickets/:ticketId/comments`; the client interleaves the two by
`createdAt`.

| `action`              | `oldValues`           | `newValues`                                         |
| --------------------- | --------------------- | --------------------------------------------------- |
| `created`             | `{}`                  | `number`, `title`, `status`, `priority`, `category` |
| `updated`             | the fields that moved | the same fields, after                              |
| `status_changed`      | `{ status }`          | `{ status }`                                        |
| `assigned`            | `{ assigneeId }`      | `{ assigneeId }` — `null` when unassigned           |
| `commented`           | —                     | `{ commentId }`                                     |
| `internal_note_added` | —                     | `{ commentId }`                                     |

`updated` carries **only what actually moved**. A partial `PATCH` that resubmits the same title
unchanged does not report a title change.

**`internal_note_added` is a separate action rather than a flag inside `newValues`**, and that is
load-bearing: it lets a `REQUESTER`'s timeline be filtered with a plain column comparison instead of
a JSONB path query. They never see that action, and it is excluded from `meta.total` as well.

**The trail is written after the response.** An entry appears a moment after the mutation returns,
so a client that reads the timeline immediately may be one entry behind. See Part II for why that
is the accepted trade and not an oversight.

### `ReportResponse`

_Written in Fase 5._

### The error catalogue

_Written once every route exists, with real bodies captured from the running application._

---

## Part II — measured behaviour

_Everything in this part is measured in this repository, against Prisma 7.9.1, PostgreSQL 17,
BullMQ 6.2.0 and `@nestjs/event-emitter` 3.1.0 — not taken from documentation. Sections appear here
as each phase produces its measurement._

### Per-tenant ticket numbering, and the operation that makes it safe

`tickets.number` restarts at 1 in every company, so it cannot be the id and it cannot be a PostgreSQL
sequence — a sequence is global. `SELECT MAX(number) + 1` is the obvious alternative and it is a
race: two concurrent opens read the same maximum and claim the same number.

What is used instead is a row in `ticket_counters` incremented inside the same interactive
transaction as the insert:

```ts
const [counter] = await tx.ticketCounter.updateManyAndReturn({
  where: {}, // the extension injects tenantId
  data: { lastNumber: { increment: 1 } },
});
```

Three properties carry it, and the third is the one that made this operation win over `update`:

- `increment` compiles to `SET last_number = last_number + 1`, evaluated by PostgreSQL. Nothing is
  read into Node and written back.
- the UPDATE takes a row lock held until the transaction commits, so a second opener in the same
  tenant blocks rather than reading a stale value.
- `updateManyAndReturn` takes a **filter**, not a unique key, so `where: {}` is legal and the
  tenancy extension supplies the tenant. `update` and `findUnique` would need the tenant id spelled
  out in the service — the hand-written tenant filter this project exists to avoid.

Measured, not assumed: `test/integration/ticket-numbering.int-spec.ts` opens 20 tickets with
`Promise.all` in one tenant that already held number 1, and asserts the batch is exactly 2..21 —
sorted, because commit order is not resolve order. It also asserts that the other tenant, seeded
alongside, is still at `last_number = 1`. `updateManyAndReturn` returning rows on PostgreSQL was
verified against Prisma 7.9.1 rather than taken from the docs, because the design has no fallback
that keeps the "no hand-written filter" rule.

The unique index `@([tenantId, number])` is the backstop, not the mechanism. If the counter
logic ever regresses, the second writer fails with `P2002` instead of producing two "chamado 3".

The cost is real and worth stating: ticket creation serialises per tenant. That is one row lock
held for the length of one insert, and it is the price of a number a human can say.

### `TicketCounter` has no `@@unique([tenantId, id])`, and why that is safe

[`TENANCY_EXTENSION.md`](./TENANCY_EXTENSION.md) lists four requirements for a tenant-scoped model,
and `ticket_counters` meets three. It has no `id` column at all — `tenant_id` is the primary key —
so the composite unique cannot exist.

That requirement is there to give the extension a way to scope a `findUnique`, which needs a unique
`where`. Nothing ever calls `findUnique` on this model: the only two operations are the `create`
that runs with the company and the `updateManyAndReturn` above, and `updateManyAndReturn` takes a
filter. The tenant _is_ the key here, so there is nothing to scope.

Do not copy the shape. It is safe for a model that is one row per tenant and is never read by id;
for anything else the fourth requirement is not optional.

The row is created in `CompaniesService.create`, in the same transaction as the company and its
first ADMIN, rather than upserted when the first ticket is opened. An upsert would let two
concurrent first opens both find it missing, both insert, and one die on the primary key. The
`helpdesk_domain` migration backfills the companies that predate the table.

### `updateMany` and not `update`, and what a version conflict actually returns

`update` requires a unique `where`, and `{ id, version }` is not unique. So the safe write is
`updateMany`, and the signal is its `count`:

```ts
const { count } = await tx.ticket.updateMany({
  where: { id, version }, // tenantId injected by the extension
  data: { ...changes, version: { increment: 1 } },
});
if (count === 0) throw new ConflictException(/* ... */);
```

What makes it work is PostgreSQL's row locking under READ COMMITTED, not anything in the service:
the losing `UPDATE` blocks on the winner's lock, re-evaluates `version = 1` after the winner
commits, matches nothing, and reports zero. Measured in
`test/integration/ticket-occ.int-spec.ts`, which fires two `changeStatus` calls at the same version
with `Promise.allSettled` and asserts one fulfilled, one `ConflictException`, and a version that
moved by exactly one — three, and not two, would mean a change had silently vanished.

**The read and the write share one interactive transaction, and that is what keeps 404 and 409
apart.** Without the read, a caller could not tell "this ticket is not yours" from "somebody just
changed it", and a client would have no way to know whether reloading is worth trying. The 409
carries the current version in its message for the same reason.

`data` is typed `Prisma.TicketUncheckedUpdateManyInput` rather than the checked variant: the checked
one hides the relation scalars, and `assigneeId` and `closedById` are exactly what two of the three
mutations set. The unchecked variant also exposes `tenantId`, which sounds like a hole and is not —
the extension throws `CrossTenantWriteError` on any update whose data mentions it.

### A nested `include` makes the `pg` adapter run two queries on one client

Every ticket response embeds its requester, assignee and closer, which means `include` on every
read. That turns out to emit a deprecation warning from `pg` 8.23:

```
DeprecationWarning: Calling client.query() when the client is already executing a query is
deprecated and will be removed in pg@9.0.
```

Narrowed by elimination rather than guessed at. Three variants of the same `create` were run: with
`include` inside an interactive transaction, with `include` outside one, and without `include`
inside one. The first two warn, the third does not — so it is the `include` itself, and the
transaction is irrelevant. `test/integration/ticket-numbering.int-spec.ts` runs twenty concurrent
transactions and stays silent, which rules out concurrency as the cause.

It is `@prisma/adapter-pg` issuing the relation queries on one checked-out client, not application
code, and it is a warning rather than an error today. The consequence is forward-looking and worth
writing down: **`pg` must not be moved to 9 without re-checking this**, because the behaviour it
depends on is scheduled for removal there. `package.json` pins `^8.23.0`, so semver will not do it
by accident.

The alternative — dropping `include` and resolving the three users separately — was rejected: it
trades a warning about a future major for an N+1 on every list screen today.

### `enableImplicitConversion` converts a JSON body too, not only a query string

[`USERS.md`](./USERS.md) records that `Boolean('false')` is `true` and that the global pipe's
implicit conversion runs before `@Transform`, so a query-string flag needs
`@Type(() => String)` to survive. That write-up frames it as a query-string problem, because that
is where every value arrives as text.

Measured here: **it is not.** The pipe converts by the property's _declared_ type, not by the
value's, so it does the same thing to a JSON body. `CreateCommentDto` was written with a plain
`@IsBoolean()` on `isInternal`, with a comment claiming a body needs no conversion machinery. The
e2e suite disproved it: `{"isInternal": "yes"}` was converted to `true`, passed `@IsBoolean()`, and
reached the service as a genuine request for an internal note.

`"yes"` is the harmless version. `"false"` is the one that matters: a client asking for a **visible**
comment would have got a hidden one.

The fix is the same three decorators, and `src/comments/dto/create-comment.dto.spec.ts` pins it with
`type: 'body'` rather than `type: 'query'` — which is the part that makes it a different test from
the one in `users`.

**The same defect was already shipped in `UpdateCompanyDto.isActive`**, found by grepping for
`@IsBoolean` after this one turned up. `PATCH /platform/companies/:companyId` with
`{"isActive": "false"}` **reactivated** the company the caller was asking to suspend, answered
`200`, and left nothing to notice. `{"isActive": "maybe"}` and `{"isActive": 0}` were accepted too.
Proved with a failing spec before the fix, and fixed in the same commit.

The rule that falls out: **any `@IsBoolean()` in this codebase needs the three decorators**, whether
it reads from a query string or from a body. `@IsInt()` does not — implicit conversion of a numeric
string is what makes the query DTOs work at all, and a non-numeric string fails the validator
honestly.

### The tenant context does survive an `emit`, and the listener ignores that

The question the design turned on: if a service emits inside `runWithTenant`, does the listener run
inside that scope?

**It does — both ways.** Measured with a bare `EventEmitter2` rather than through the application,
so the answer is about the library and not about this wiring
(`test/integration/audit-trail.int-spec.ts`):

- a synchronous listener reading `currentScope()` sees `{ kind: 'tenant', tenantId }`. `emit`
  dispatches on the caller's stack, so there is no boundary to lose the scope at.
- an async listener that awaits a `setImmediate` first _still_ sees it. `AsyncLocalStorage`
  propagates through the continuation.

**`AuditListener` opens the scope from the event payload anyway.** That is not belt-and-braces, it
is a refusal to depend on the measurement: what the two results describe is
`@nestjs/event-emitter`'s dispatch strategy, which is a fact about a dependency and not a decision
this repository made. A future `emitAsync`, a queued dispatcher, or a listener moved onto a BullMQ
queue would each take the scope away, and none of them would fail loudly — the listener would just
start writing into whatever tenant happened to be current, or throw
`TenantContextMissingError` in a background handler nobody is watching.

Carrying `tenantId` in the payload is also exactly what a worker has to do, so there is one rule for
"code that runs outside a request" instead of two that look alike until one of them breaks.

### The audit write lands outside the mutation's transaction

`mutate()` emits **after** `$transaction` resolves, not inside the callback. Inside, an event would
announce a change that a later statement could still roll back, and the trail would record something
that never happened. `test/integration/audit-trail.int-spec.ts` pins the other half of that: a
`changeStatus` refused with a version conflict leaves the ticket with exactly one entry, its
creation.

The cost is that the write is not atomic with the change it describes. If the insert into
`audit_logs` fails, the mutation has already committed and the trail is behind the data.
`AuditListener` catches, logs at error level with the tenant, entity and action, and does not
rethrow — by then the response has gone out, so throwing would surface as an unhandled rejection
rather than as anything a caller could act on.

**This is a real gap, and the alternative was worse.** Writing the entry inside the transaction
would re-couple `TicketsService` to `AuditService` — the exact coupling the Observer exists to
remove — and would make an audit failure roll back a legitimate ticket update. The gap to close
later is a durable one: emit onto a queue and let the worker retry.

### `wildcard: true` is not optional, and its absence is silent

`AuditListener` subscribes to `ticket.*`. Without `wildcard: true` on
`EventEmitterModule.forRoot()`, `eventemitter2` matches names literally: `ticket.*` becomes a
subscription to an event nobody emits, no listener ever fires, and **nothing anywhere reports a
problem** — the mutations still succeed, the trail is simply always empty.

`audit-trail.int-spec.ts` asserts `emitter.listeners('ticket.created')` has length 1 for exactly
that reason. Without it, every other assertion in the suite would fail in a way that looks like a
database problem.

The same wiring caught a second thing worth knowing: `TicketsService` now injects `EventEmitter2`,
which only exists once `forRoot()` has run. Two integration suites that build a `TestingModule` from
`TicketsModule` alone stopped resolving, and had to import it. That failure is the honest signal
that emitting is now part of what a ticket mutation _is_.

### `Prisma.DbNull`, not `null`, for an empty JSONB column

`audit_logs.old_values` is nullable JSON, and Prisma refuses a bare `null` there: it cannot tell
whether the caller means the JSON value `null` or a SQL `NULL`. `Prisma.DbNull` is the one that
means "no row value", `Prisma.JsonNull` the other.

`AuditService` also casts its payloads to `Prisma.InputJsonObject`. `Record<string, unknown>` is
structurally a JSON object, but `InputJsonValue` is recursive in a way TypeScript cannot see
through. What makes the cast true rather than convenient is that everything the domain puts in these
payloads is a string, a number, a boolean or null — a constraint worth re-checking if an entry ever
starts carrying a Date.

### The report worker has no request context

_Fase 5._

### The staff room is what keeps a requester out of another ticket's events

_Fase 6._
