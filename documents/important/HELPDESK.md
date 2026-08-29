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

_Written as each module lands._

### `TicketResponse`

_Written in Fase 2._

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

_Fase 2._

### Whether the tenant context survives an event-emitter `emit`

_Fase 4._

### The audit write lands outside the mutation's transaction

_Fase 4._

### The report worker has no request context

_Fase 5._

### The staff room is what keeps a requester out of another ticket's events

_Fase 6._
