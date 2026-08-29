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

_Written in Fase 3._

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

### Whether the tenant context survives an event-emitter `emit`

_Fase 4._

### The audit write lands outside the mutation's transaction

_Fase 4._

### The report worker has no request context

_Fase 5._

### The staff room is what keeps a requester out of another ticket's events

_Fase 6._
