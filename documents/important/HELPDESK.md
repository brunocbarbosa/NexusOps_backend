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

_Written in Fase 1, once the migration lands._

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

_Fase 1._

### `TicketCounter` has no `@@unique([tenantId, id])`, and why that is safe

_Fase 1._

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
