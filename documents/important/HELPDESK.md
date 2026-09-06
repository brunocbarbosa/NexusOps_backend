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

| Role           | Sees                                             | May also                                                    |
| -------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `ADMIN_MASTER` | nothing — the operator has no tickets of its own | —                                                           |
| `ADMIN`        | every ticket in the company                      | open, change status, assign, read and write internal notes  |
| `AGENT`        | only the tickets assigned to it                  | change status and internal notes **on those**; never assign |
| `REQUESTER`    | only the tickets it opened                       | open one, comment on its own, edit them while not `CLOSED`  |

Precisely: an `ADMIN` sees everything, and everybody else sees
`requesterId = me OR assigneeId = me`. A `REQUESTER` can never be an assignee, so for them the
second arm never matches; an `AGENT` can no longer open a ticket, so for them the first arm only
matches rows opened before this rule existed.

**Assignment is what grants and revokes sight of a ticket.** That is why it is an `ADMIN` route:
an agent assigning one to itself would be an agent granting itself visibility, and an agent
unassigning itself would be one erasing a ticket from the only queue that shows it. It is also why
a ticket **nobody is assigned to is invisible to every agent** — the unassigned queue belongs to
the admin, and nothing gets worked until somebody hands it over.

A ticket the caller cannot see answers **404, never 403** — the same rule the rest of the API
follows, and for the same reason: a 403 would confirm that the id exists somewhere. An agent asking
for a colleague's ticket therefore gets the same answer as a stranger from another company.

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

| Method  | Path                    | Auth                 | Success | Purpose                                |
| ------- | ----------------------- | -------------------- | ------- | -------------------------------------- |
| `POST`  | `/tickets`              | `ADMIN`, `REQUESTER` | `201`   | open a ticket; requester is the caller |
| `GET`   | `/tickets`              | any                  | `200`   | paginated, filtered list               |
| `GET`   | `/tickets/:id`          | any                  | `200`   | one ticket                             |
| `PATCH` | `/tickets/:id`          | any                  | `200`   | title, description, priority, category |
| `PATCH` | `/tickets/:id/status`   | `ADMIN`, `AGENT`     | `200`   | move through the lifecycle             |
| `PATCH` | `/tickets/:id/assignee` | `ADMIN`              | `200`   | assign, or unassign with `null`        |

**There is no `DELETE`.** `CLOSED` is the terminal state and takes the role a delete would play. A
ticket is the subject of an audit trail, and deleting it would delete what the trail is about.

**An `AGENT` cannot open a ticket** — `POST /tickets` answers it `403`. The role that _works_ a
ticket is not the role that _opens_ it, and leaving the route open to an agent would hand it a way
around the rule above, because the author of a ticket sees it. `ADMIN_MASTER` gets the same 403,
which is an improvement on the `500` it used to get: the reserved platform tenant has no
`ticket_counters` row, so the route reached the service and threw.

Query parameters on `GET /tickets`:

| Parameter     | Default | Rules                                                            |
| ------------- | ------- | ---------------------------------------------------------------- |
| `page`        | `1`     | integer, at least 1                                              |
| `perPage`     | `20`    | integer, 1 to 100                                                |
| `status`      | —       | one of the four `TicketStatus` values                            |
| `priority`    | —       | one of the four `TicketPriority` values                          |
| `category`    | —       | one of the five `TicketCategory` values                          |
| `assigneeId`  | —       | uuid                                                             |
| `requesterId` | —       | uuid; **intersected** with the caller's scope, never overriding  |
| `unassigned`  | —       | `true` or `false`; a `400` if sent together with `assigneeId`    |
| `search`      | —       | 1 to 255 characters, case-insensitive over title and description |

**Every filter is intersected with what the caller may see, never overridden by it.** A
`REQUESTER` sending `?requesterId=<somebody else>` gets an **empty page**, not their own tickets:
the filter is obeyed and the scope leaves it matching nothing. The same goes for an agent asking
about a colleague's queue. It narrows and never widens, which is the only thing a filter is allowed
to do here.

`unassigned=true` is worth stating outright, because a client will otherwise think it is broken:
for an `ADMIN` it is the company's unassigned queue, and for anybody else it is
`assigneeId = null AND (requesterId = me OR assigneeId = me)`, whose second arm cannot hold — so
what comes back is **the tickets they opened that nobody has picked up**. An agent has no unassigned
queue, by design.

The page envelope is the `{ data, meta }` one already defined in [`USERS.md`](./USERS.md); it is
not redefined here. `meta.total` respects visibility — an agent's total counts only the tickets
assigned to it, because a count that included invisible rows would announce that they exist.

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

Captured from the running application —
`POST /tickets` with `{ "title": "Printer on the 3rd floor is jammed", "description": "It jams on
every duplex job.", "priority": "HIGH", "category": "HARDWARE" }` as a `REQUESTER`:

```json
{
  "id": "14dd6147-c887-492e-bc08-a47b55457931",
  "number": 1,
  "title": "Printer on the 3rd floor is jammed",
  "description": "It jams on every duplex job.",
  "status": "OPEN",
  "priority": "HIGH",
  "category": "HARDWARE",
  "version": 1,
  "requester": {
    "id": "369d7447-5a4c-49f6-8027-9c2e08c73cb9",
    "email": "req@capture.example",
    "role": "REQUESTER",
    "createdAt": "2026-08-29T23:14:49.857Z",
    "deletedAt": null
  },
  "assignee": null,
  "closedBy": null,
  "resolvedAt": null,
  "closedAt": null,
  "createdAt": "2026-08-29T23:14:49.897Z",
  "updatedAt": "2026-08-29T23:14:49.897Z"
}
```

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

`POST /tickets/:ticketId/comments` with `{ "body": "Still jamming this morning." }`:

```json
{
  "id": "8675b459-8de7-4252-898f-96bcc0c6e536",
  "ticketId": "14dd6147-c887-492e-bc08-a47b55457931",
  "body": "Still jamming this morning.",
  "isInternal": false,
  "author": {
    "id": "369d7447-5a4c-49f6-8027-9c2e08c73cb9",
    "email": "req@capture.example",
    "role": "REQUESTER",
    "createdAt": "2026-08-29T23:14:49.857Z",
    "deletedAt": null
  },
  "createdAt": "2026-08-29T23:14:49.995Z"
}
```

The same ticket read back by the requester, after an agent has left an internal note on it. The note
is in neither the page nor the `total`:

```json
{
  "data": [
    {
      "id": "8675b459-8de7-4252-898f-96bcc0c6e536",
      "ticketId": "14dd6147-c887-492e-bc08-a47b55457931",
      "body": "Still jamming this morning.",
      "isInternal": false,
      "author": {
        "id": "369d7447-5a4c-49f6-8027-9c2e08c73cb9",
        "email": "req@capture.example",
        "role": "REQUESTER",
        "createdAt": "2026-08-29T23:14:49.857Z",
        "deletedAt": null
      },
      "createdAt": "2026-08-29T23:14:49.995Z"
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "perPage": 20,
    "totalPages": 1
  }
}
```

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

`GET /tickets/:ticketId/timeline?perPage=3`, after the ticket above was opened, assigned and moved
to `IN_PROGRESS`:

```json
{
  "data": [
    {
      "id": "05985a2b-b0b2-4674-ae0a-6115d6b063c3",
      "entityType": "Ticket",
      "entityId": "14dd6147-c887-492e-bc08-a47b55457931",
      "action": "created",
      "oldValues": {},
      "newValues": {
        "title": "Printer on the 3rd floor is jammed",
        "number": 1,
        "status": "OPEN",
        "category": "HARDWARE",
        "priority": "HIGH"
      },
      "user": {
        "id": "369d7447-5a4c-49f6-8027-9c2e08c73cb9",
        "email": "req@capture.example",
        "role": "REQUESTER",
        "createdAt": "2026-08-29T23:14:49.857Z",
        "deletedAt": null
      },
      "createdAt": "2026-08-29T23:14:49.909Z"
    },
    {
      "id": "d6f0383f-dc8e-47e6-a12d-d95c2633d216",
      "entityType": "Ticket",
      "entityId": "14dd6147-c887-492e-bc08-a47b55457931",
      "action": "assigned",
      "oldValues": {
        "assigneeId": null
      },
      "newValues": {
        "assigneeId": "01f57da2-8f2f-4d52-9f76-d1a6a941d9ed"
      },
      "user": {
        "id": "01f57da2-8f2f-4d52-9f76-d1a6a941d9ed",
        "email": "agent@capture.example",
        "role": "AGENT",
        "createdAt": "2026-08-29T23:14:49.850Z",
        "deletedAt": null
      },
      "createdAt": "2026-08-29T23:14:49.955Z"
    },
    {
      "id": "ffa8ae34-63e3-4c00-8a70-4adf6b24b43a",
      "entityType": "Ticket",
      "entityId": "14dd6147-c887-492e-bc08-a47b55457931",
      "action": "status_changed",
      "oldValues": {
        "status": "OPEN"
      },
      "newValues": {
        "status": "IN_PROGRESS"
      },
      "user": {
        "id": "01f57da2-8f2f-4d52-9f76-d1a6a941d9ed",
        "email": "agent@capture.example",
        "role": "AGENT",
        "createdAt": "2026-08-29T23:14:49.850Z",
        "deletedAt": null
      },
      "createdAt": "2026-08-29T23:14:49.966Z"
    }
  ],
  "meta": {
    "total": 6,
    "page": 1,
    "perPage": 3,
    "totalPages": 2
  }
}
```

Note `"oldValues": {}` on `created` against `"oldValues": null` on a comment entry: an empty object
means "nothing changed because nothing existed", while `null` is a column that was never written.
They are different values in the database and the API does not smooth them over.

**The trail is written after the response.** An entry appears a moment after the mutation returns,
so a client that reads the timeline immediately may be one entry behind. See Part II for why that
is the accepted trade and not an oversight.

### `ReportResponse`

The asynchronous export. `POST` hands the work to a queue and answers immediately; the CSV appears
on the row a moment later.

| Method | Path                    | Auth | Success | Purpose                      |
| ------ | ----------------------- | ---- | ------- | ---------------------------- |
| `POST` | `/reports/tickets`      | any  | `202`   | request a CSV of tickets     |
| `GET`  | `/reports`              | any  | `200`   | your own requests, paginated |
| `GET`  | `/reports/:id`          | any  | `200`   | one request's status         |
| `GET`  | `/reports/:id/download` | any  | `200`   | the CSV itself, `text/csv`   |

**`202`, not `201`.** What was created is a _request_, not a report: the file does not exist yet and
may still fail. A `201` would tell a client the thing is ready, and the next thing it would do is
download an empty file.

```ts
type ReportResponse = {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  filters: unknown; // the JSON body that was requested, echoed back
  rowCount: number | null; // filled on COMPLETED
  error: string | null; // filled on FAILED
  requestedBy: UserResponse;
  createdAt: string;
  completedAt: string | null;
};
```

`content` is deliberately absent from this shape: the CSV can be tens of thousands of rows, and a
client polling `GET /reports/:id` would carry the whole file on every poll. It has its own route.

The `POST` body is the ticket filters only — `status`, `priority`, `category`, `assigneeId`,
`requesterId`, `search`. **No `page` or `perPage`**: a report is every matching row up to
`REPORTS_MAX_ROWS`, and offering a page size would invite a client to queue a report of twenty
tickets and wonder why it did not come back synchronously.

**Reports are personal, and that is a security property rather than a simplification.** Every route
here filters by who requested it. The CSV was built through the requester's own visibility — a
`REQUESTER`'s export holds only their tickets, an `AGENT`'s holds the company's — so letting a third
person download somebody else's report would hand them rows the ticket routes would refuse them.
Another person's report is `404`, in the same company or not.

`GET /reports/:id/download` answers `409` while the job has not finished, rather than `200` with an
empty body: a file downloaded too early is indistinguishable from a report with no matching tickets.
On `FAILED` the `409` carries the recorded reason.

`POST /reports/tickets` with `{ "status": "RESOLVED" }` — the `202`:

```json
{
  "id": "a36d136f-816e-419c-8a98-0647c1b7f0f9",
  "status": "PENDING",
  "filters": {
    "status": "RESOLVED"
  },
  "rowCount": null,
  "error": null,
  "requestedBy": {
    "id": "01f57da2-8f2f-4d52-9f76-d1a6a941d9ed",
    "email": "agent@capture.example",
    "role": "AGENT",
    "createdAt": "2026-08-29T23:14:49.850Z",
    "deletedAt": null
  },
  "createdAt": "2026-08-29T23:14:50.453Z",
  "completedAt": null
}
```

The same report a moment later, on `GET /reports/:id`:

```json
{
  "id": "a36d136f-816e-419c-8a98-0647c1b7f0f9",
  "status": "COMPLETED",
  "filters": {
    "status": "RESOLVED"
  },
  "rowCount": 1,
  "error": null,
  "requestedBy": {
    "id": "01f57da2-8f2f-4d52-9f76-d1a6a941d9ed",
    "email": "agent@capture.example",
    "role": "AGENT",
    "createdAt": "2026-08-29T23:14:49.850Z",
    "deletedAt": null
  },
  "createdAt": "2026-08-29T23:14:50.453Z",
  "completedAt": "2026-08-29T23:14:50.470Z"
}
```

And `GET /reports/:id/download`:

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="tickets-a36d136f-816e-419c-8a98-0647c1b7f0f9.csv"

"number","title","status","priority","category","requester","assignee","createdAt","resolvedAt","closedAt"
"1","Printer on the 3rd floor is jammed","RESOLVED","HIGH","HARDWARE","req@capture.example","agent@capture.example","2026-08-29T23:14:49.897Z","2026-08-29T23:14:49.972Z",""
```

**Every CSV cell is quoted**, including the header, and a cell beginning with `=`, `+`, `-` or `@`
is prefixed with a single quote. The first is RFC 4180 and means a ticket title containing a comma
survives; the second is because spreadsheets execute a leading `=` as a formula, which would turn a
ticket title into an injection against whoever opens the file. Line endings are CRLF.

### The notification socket

A socket.io endpoint on the same origin as the API. It pushes; it accepts no commands.

**The handshake carries the access token in `auth`, not in a header** — the browser `WebSocket` API
cannot set headers, and socket.io's `auth` field is the supported way through:

```ts
const socket = io('https://api.example.com', {
  auth: { token: accessToken },
});
```

The server answers with `ready` (`{ userId, role }`) on success, or `unauthorized`
(`{ message }`) followed by a disconnect. A refresh token is refused: the two are signed with
different keys.

The token expires long before a tab is closed, so a client has to reconnect with a fresh one after a
refresh. **Set `reconnection: false` if you do not**, or a socket refused for an expired token
retries forever.

| Event              | Sent to                                                    | Payload                                               |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| `ready`            | the socket that just connected                             | `{ userId, role }`                                    |
| `unauthorized`     | a socket about to be disconnected                          | `{ message }`                                         |
| `ticket.changed`   | the company's admins, the ticket's assignee, its requester | `{ ticketId, action, actorId, oldValues, newValues }` |
| `report.completed` | only whoever requested it                                  | `{ reportId, rowCount, error: null }`                 |
| `report.failed`    | only whoever requested it                                  | `{ reportId, rowCount: null, error }`                 |

`ticket.changed` carries the same `action` vocabulary as the timeline, so a client can reuse one
renderer for both.

**Two rooms, and they are the whole access-control story.** A connection joins `user:<id>` always,
and `tenant:<id>:admins` only if it is an `ADMIN`. Broadcasting to a plain per-tenant room would
hand a `REQUESTER` every ticket in the company over the socket — with no controller involved to
refuse it, and nothing in the HTTP tests to notice. An `AGENT` is not in the admin room either, for
the same reason it does not see those tickets over HTTP: it hears about the tickets assigned to it,
through its own `user:<id>`.

**One event goes to somebody who can no longer read the ticket, on purpose.** A reassignment is
delivered to the agent it _left_ as well as the agent it reached, because that agent's queue has to
drop the row. Use it to remove the row — do not refetch the ticket, which now answers 404.

**`internal_note_added` skips the requester.** It still reaches the company's admins and the agent
working the ticket. The whole point of it being a separate action is that the customer never learns
the note exists, and that has to hold on the socket as much as on the timeline.

A report notification is addressed to one person, never to a room: the file was built through its
requester's own visibility, so its very existence is theirs.

**The event is emitted after the row is written**, so a client woken by `report.completed` can
download immediately rather than racing the update that woke it.

### The error catalogue

The envelope is the one used everywhere: `message` is a **string** for a business error and an
**array** for validation. `401` carries no `error` key.

| Status | Meaning here                                                                       |
| ------ | ---------------------------------------------------------------------------------- |
| `400`  | the payload or the query failed validation, or two filters contradicted each other |
| `401`  | no token, an expired one, or a refresh token presented as an access token          |
| `403`  | the route needs a role the caller does not have, or an internal note does          |
| `404`  | the ticket, comment thread, timeline or report is not visible to this caller       |
| `409`  | the request is well formed and the current state refuses it                        |

**`404` and `403` are not interchangeable.** A `404` means the resource is outside what the caller
can see — another company's, or another requester's — and says so without confirming that the id
exists anywhere. A `403` means the resource is visible and the _action_ is not allowed, which leaks
nothing the caller did not already know.

Real bodies:

```json
{
  "message": "This ticket was changed by someone else (it is now at version 4). Reload it and reapply your change.",
  "error": "Conflict",
  "statusCode": 409
}
```

```json
{
  "message": "A ticket cannot go from RESOLVED to IN_PROGRESS",
  "error": "Conflict",
  "statusCode": 409
}
```

```json
{
  "message": "req@capture.example is a REQUESTER and cannot be assigned a ticket. Only an AGENT or an ADMIN works tickets.",
  "error": "Conflict",
  "statusCode": 409
}
```

```json
{
  "message": [
    "version must not be less than 1",
    "version must be an integer number",
    "title must be longer than or equal to 3 characters"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": [
    "property tenantId should not exist",
    "title must be longer than or equal to 3 characters"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": "unassigned and assigneeId contradict each other. Send one or the other.",
  "error": "Bad Request",
  "statusCode": 400
}
```

```json
{
  "message": "No ticket 14dd6147-c887-492e-bc08-a47b55457931",
  "error": "Not Found",
  "statusCode": 404
}
```

```json
{
  "message": "Only an ADMIN or an AGENT can leave an internal note",
  "error": "Forbidden",
  "statusCode": 403
}
```

```json
{
  "message": "This route requires one of: ADMIN, AGENT",
  "error": "Forbidden",
  "statusCode": 403
}
```

The other two `RolesGuard` bodies are the ones a client meets because of the visibility rule, and
they are worth quoting because the message names the roles the route accepts — an agent opening a
ticket, and an agent touching `/assignee`, including to unassign itself:

```json
{
  "message": "This route requires one of: ADMIN, REQUESTER",
  "error": "Forbidden",
  "statusCode": 403
}
```

```json
{
  "message": "This route requires one of: ADMIN",
  "error": "Forbidden",
  "statusCode": 403
}
```

```json
{
  "message": "Unauthorized",
  "statusCode": 401
}
```

The `409` on a version conflict **carries the current version in its message**, so a client can tell
the user how far behind they were before reloading.

### Known gaps

Real today, and a client will meet them:

- **A ticket cannot be reopened once `CLOSED`.** The intended flow is a new ticket that references
  it; there is no field for that reference yet.
- **A ticket cannot be opened on somebody else's behalf, and an `AGENT` cannot open one at all.**
  The requester is always the caller, so the person taking the phone call is an `ADMIN` and the
  ticket ends up theirs rather than the caller's. This got worse rather than better with the
  visibility rule, and it was a deliberate trade: leaving `POST /tickets` open to an agent would
  have handed it a way around the rule, since the author of a ticket sees it. An "on behalf of"
  field that names a requester the admin may not impersonate is the fix, and it is not written.
- **Nobody sees an unassigned ticket except an `ADMIN` and its author.** An agent cannot pick work
  out of a shared queue, because there is no queue it can see. That is the cost of assignment being
  the permission, and it is stated rather than hidden: a company with no admin watching the inbox
  has tickets nobody is working.
- **A staff member who is a ticket's requester but not its assignee is not pushed
  `internal_note_added`.** An `ADMIN` is unaffected — the admin room gets it — so this only bites a
  legacy ticket opened by an agent. The note is not hidden from them, merely not pushed: the thread
  shows it on the next read, and any client refetches on `ticket.changed`.
- **There is no attachment.** `MAIN.md` foresees object storage; nothing in the API accepts a file.
- **The report CSV lives in a database column**, bounded by `REPORTS_MAX_ROWS`. A report that hits
  the cap is truncated rather than refused, and `rowCount` is the only signal.
- **The timeline can lag the mutation by a moment.** The trail is written after the response — see
  Part II.

---

## Part II — measured behaviour

_Everything in this part is measured in this repository, against Prisma 7.9.1, PostgreSQL 17,
BullMQ 6.2.0 and `@nestjs/event-emitter` 3.1.0 — not taken from documentation. Sections appear here
as each phase produces its measurement._

### Assignment became the permission, and that forced it to be an ADMIN route

The two rules read like two restrictions and they are one. Once an agent stops seeing a ticket
nobody assigned to it, an agent **cannot assign one to itself**: `mutate()` calls `load()` first, and
`load()` answers 404 for a ticket outside the caller's scope, long before the version check or the
write. So the agent-assigns-itself path was already dead the moment the scope changed; putting
`@Roles(ADMIN)` on the route only says out loud what the scope enforced silently.

Unassigning is the direction that needed the guard for its own sake. An agent dropping a ticket it
already holds _was_ reachable — it can see what is assigned to it — and it would erase the ticket
from the only queue that shows it, leaving nothing but an admin's inbox to find it again. That is
the case the 403 exists for, and `test/e2e/tickets.e2e-spec.ts` asserts it explicitly rather than
assuming the route-level answer covers it.

`POST /tickets` follows from the same place. The author of a ticket sees it, so an agent that could
open one could open its way to visibility — the rule would hold on every path except the one that
creates rows.

### Intersection replaced the spread-last trick, and the `OR` that `search` writes is why

The old scope was one column, so the mechanism was ordering: spread `{ requesterId: me }` last and it
physically overwrote whatever the caller had asked for. `{ OR: [...] }` has no column to overwrite,
and spread into the same object it does something worse — `findAll` already writes a top-level `OR`
for `search`, and the second one **replaces** the first. The page would come back wider than the
caller asked for rather than narrower, which is the one direction a visibility scope must never
move. `AND` is a key no caller filter uses, so the scope can only ever remove rows.
`src/tickets/tickets.service.spec.ts` pins it: with `search` set, both keys survive.

Choosing `AND` over a strip-list — deleting `requesterId`, `assigneeId` and `unassigned` from a
non-admin's query before composing — was deliberate. The strip-list preserves the old observable
behaviour, and it costs a list somebody has to remember to extend the next time a filter is added.
It also makes the API answer a question nobody asked: `?assigneeId=<colleague>` would come back
holding the caller's own tickets, under a heading the client wrote saying "colleague's queue". Under
intersection the answer is empty, which is honest, and narrowing can never leak.

The e2e test that covered the old behaviour is worth a note of its own: it asserted
`page.data.every(t => t.requester.email === mine)`, and `[].every()` is `true` — so it would have
passed against the new behaviour without asserting anything at all. It was replaced with an explicit
`toHaveLength(0)` and `meta.total === 0`.

`unassigned=true` needed no special case and gets a sensible answer by construction: intersected
with the caller's scope it becomes `assigneeId = null AND (requesterId = me OR assigneeId = me)`,
whose second arm is unsatisfiable, leaving the tickets they opened that nobody picked up. The 400
that refuses `unassigned` together with `assigneeId` stays where it is — it is about a contradiction
in what the _caller_ said, and empty and 400 are different answers.

### `load()` did not change, and that was the point of keying on `AND`

`{ id, ...visibleTo(requester) }` became `{ id, AND: [{ OR: [...] }] }` without an edit, because the
fragment is keyed rather than spread. That matters more than it looks: `load()` is the chokepoint
every 404 in this slice comes out of, reached by `requireTicket()` and by `mutate()`, so a rule
change that cannot touch it is a rule change that cannot break it.

Everything downstream inherited the new scope with no code of its own — the comment routes, the
ticket timeline, the report export, and all three mutations. The tests moved; the code did not. The
report export is the strongest evidence: `test/integration/reports-queue.int-spec.ts` asserts that an
agent's CSV holds only the ticket assigned to it, which means the scope survived the trip through
Redis into a worker that has no request context to inherit one from.

### The three predicates finally diverged

`seesEveryTicket()`, `handlesInternalNotes()` and `joinsStaffRoom()` had identical bodies, and each
carried a docblock explaining that they were deliberate duplicates because they answered different
questions that happened to share an answer — and that binding them would be an accident waiting for
one to change.

One changed. `seesEveryTicket()` is now `ADMIN` alone; `joinsAdminRoom()` followed it, because the
broadcast room is exactly the company-wide view; and `handlesInternalNotes()` stayed `ADMIN || AGENT`,
because an agent working a ticket still writes its internal note — the ticket-level 404 decides
_which_ ticket it reaches, and that predicate only decides _what_ it may do on one it can already
see.

Had the three been collapsed into one helper when they looked identical, narrowing visibility would
have silently taken the internal note away from the only person using it. This is the clearest
argument in the repository for the convention, and it is worth keeping the comments updated rather
than deleting them: the first line of `internal-notes.ts` now says the bodies _used to_ match.

### A `400` does not prove the ticket exists, and a `403` can hide a malformed body

Nest runs the guard, then the pipe, then the handler, and the visibility rule lives in the handler's
service. So the order decides which of three answers a caller gets, and two of the outcomes read
backwards from the outside. Measured against the running application, as an `AGENT` on a ticket
assigned to somebody else:

| Request                                            | Answer | Why                                                |
| -------------------------------------------------- | ------ | -------------------------------------------------- |
| `PATCH /tickets/:id` with a valid body             | `404`  | the service ran and `load()` found nothing visible |
| `PATCH /tickets/:id` with `title` shorter than 3   | `400`  | the pipe rejected it before the service ever ran   |
| `PATCH /tickets/:id/assignee` with any body at all | `403`  | the guard rejected it before the pipe ever ran     |

The middle row is the one that matters, and it is the reason this is written down: **a `400` says
nothing about whether the ticket exists**, only that the payload never got far enough to be asked.
A client that treats a validation error as evidence of a real resource — enabling a form, keeping a
row on screen, retrying with a fix — is reading a signal that is not there. It is not a leak either:
the message describes the caller's own payload and names no row.

The third row is the mirror image and is harmless, but it surprises a test. The same empty body
`{}`, sent to the same ticket, measured three ways:

| Sent by | To          | Answer                                                                  |
| ------- | ----------- | ----------------------------------------------------------------------- |
| `AGENT` | `/status`   | `400` — `version` and `status` both reported missing                    |
| `AGENT` | `/assignee` | `403` — `This route requires one of: ADMIN`, and the DTO is never asked |
| `ADMIN` | `/assignee` | `400` — `version` and `assigneeId` both reported missing                |

So a spec that asserts `400` while acting as an agent is asserting the guard, not the DTO. That is
why the assignment specs in `test/e2e/tickets.e2e-spec.ts` switch the **actor** to an `ADMIN` rather
than switching the expectation: `rejects a missing assigneeId rather than treating it as unassign`
runs as `adminA` and still expects `400`, while `refuses an agent the assignment route with 403`
keeps the agent and expects the guard.

### `POST /tickets` answered the operator with a 500, and the guard is what fixed it

Measured before changing anything, by writing the test first and reading the failure:

```
● refuses the platform operator with 403
  expected 403 "Forbidden", got 500 "Internal Server Error"
```

`CompaniesService.create` creates a `ticket_counters` row per company; `PlatformBootstrapService`
does not create one for the reserved platform tenant. So `TicketsService.create` found no counter
and threw the deliberate plain `Error` that says the data is broken rather than the request — which
is the right exception for the situation it was written for, and the wrong answer to a route the
operator should never have reached. `@Roles(ADMIN, REQUESTER)` stops it at the guard.

Worth remembering as a shape rather than a fact: a route with no `@Roles()` is reachable by the
`ADMIN_MASTER`, whose tenant is not a company and does not have a company's rows.

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

### The report worker has no request context, and the proof is one assertion

CLAUDE.md calls a background handler the single most likely place in this project for a tenant leak.
The reason is that nothing about the code _looks_ different: a Prisma call in
`ReportsProcessor` reads exactly like one in a controller, and the thing that makes the controller's
version safe — the `TenantContextInterceptor` having opened a scope — is simply not there.

`test/integration/reports-queue.int-spec.ts` states the premise rather than assuming it:

```ts
it('runs the worker with no ambient tenant scope', () => {
  expect(currentScope()).toEqual({ kind: 'none' });
});
```

If that ever came back as a tenant scope, carrying the actor in the payload could be dropped — and
it must not be, so the assertion is what would notice.

Everything the worker needs travels in the job, serialised through Redis as JSON: not just
`tenantId`, but the whole `AuthenticatedUser`. The tenant opens the scope; the id and the role decide
which rows belong in the file. A `REQUESTER`'s export must not contain another person's tickets, and
the role is the only thing that says so.

**The rows are gathered by paging `TicketsService.findAll`, not by a query written in the worker.**
That costs one round trip per hundred rows and is worth it: `findAll` is where the visibility rule
lives, so an export built through it cannot contain a ticket the requester could not have listed. A
second `where` in the processor would be a second place for that rule to drift, and the drift would
only ever be visible inside a file somebody downloads — the slowest possible way to find out.

The suite seeds four tickets across two requesters and two companies for exactly this: an agent's
export has three rows and never `B-one elsewhere`; the same request from a requester has two and
never their colleague's.

### The report row is written before the job is enqueued

The other order has a race. A job whose report row does not exist yet fails on its first statement,
and BullMQ retries it into the same failure until it gives up — a report stuck as a queue error with
no row anywhere to explain it. Inserting first has no such window: the worst case is a row that
stays `PENDING` because the enqueue failed, which is visible and recoverable.

Failures are recorded **on the row and rethrown**. Only recording them would leave BullMQ thinking
the job succeeded; only throwing would leave the client polling a report stuck in `PROCESSING`
forever with nothing to explain it. The row and the queue disagreeing about what happened is worse
than either being wrong.

### The queue made a missing environment variable a boot failure, on purpose

`REDIS_HOST`, `REDIS_PORT` and `REPORTS_MAX_ROWS` are validated in
`src/config/env.validation.ts` now, and were not before. Until this queue existed nothing in the
process opened a Redis connection, so an unset `REDIS_HOST` failed at nobody; now the application
connects at boot, and an unset one should stop it there rather than surface as a job that is
enqueued and never runs.

That change has a consequence outside the application, and it is the kind that is found late: **the
`docker` job's boot check feeds the container an explicit list of variables**, and a container
missing `REDIS_HOST` exits on validation before it can answer the `curl`. The failure then reads as
"the image did not answer on port 3000", which points at the build rather than at the missing
variable. The three names are in that list now. Redis is already running on 6380 from
`npm run test:setup`, and `--network host` is what makes it reachable.

Verified locally the same way the job does it: `npm run build`, then `node dist/main` with
`NODE_ENV=production` and the `.env.test` values, answering `GET /` while `BullModule` reported its
dependencies initialised.

One knock-on in the unit suite worth knowing: `env.validation.spec.ts` used `REDIS_HOST` as its
example of an _undeclared_ variable that survives validation untouched. It is declared now, so the
example moved to `POSTGRES_USER` — which only `docker-compose` reads and which nothing will ever
declare.

### The CSV is in a `TEXT` column, and `REPORTS_MAX_ROWS` is what bounds it

MAIN.md calls for S3/MinIO and that remains the right answer; this is the scoped-down version, and
the cap is the whole mitigation. It **truncates rather than failing**: a report that says "here are
the first N" is more useful than one that refuses, and `rowCount` on the row tells the client what
it actually got. `.env.test` sets it to 100 so the cap is assertable without seeding 50001 tickets.

Every cell is quoted, including the header, rather than only the ones that need it. Conditional
quoting means a rule about which characters are special, and getting that rule slightly wrong
produces a file that opens fine until one ticket title contains a comma.

The leading-character guard is not about CSV at all. A cell beginning with `=`, `+`, `-` or `@` is
executed as a formula by Excel and Google Sheets, so a ticket titled `=cmd|...` becomes an injection
against whoever opens the export. Prefixing a single quote is the standard defence and is invisible
in the spreadsheet.

`cell()` takes a narrow union rather than `unknown`, and that is deliberate: `String(someObject)`
yields `"[object Object]"` without complaining, so a column added later that carries an object would
land in a customer's spreadsheet rather than failing to compile.

### The admin room, and the personal room that replaced it for agents

Three phases went into making a `REQUESTER` unable to read somebody else's ticket over HTTP. A
gateway that broadcast every change to `tenant:<id>` would hand it to them anyway, over a socket,
with no controller involved to refuse it — and **not one HTTP test would fail**. The visibility rule
has to be re-established at this boundary, because the boundary is new.

That argument then applied to the agents unchanged. When an agent stopped seeing the company's
queue over HTTP, `tenant:<id>:staff` was still delivering all of it over the socket — the same hole,
one role over. So the room became `tenant:<id>:admins` and holds admins alone, and an agent is
addressed through its own `user:<id>`: it is the _ticket_ that entitles it to an event, not the
role.

The rename of the string is not cosmetic. A room still called `staff` while excluding the agents is
a name somebody reads as a bug and then "fixes". It costs nothing on the wire, because this gateway
pushes and takes no commands, so no client ever names a room.

`assigneeIds` rides in the payload alongside `requesterId`, for the same reason that one does:
looking it up in the gateway would mean a database read per event, on a listener with no request
scope to read it in. It is **required rather than optional**, and that is doing work — an emit site
that forgot it would silently stop notifying the one person actually working the ticket, with no
error and no failing HTTP test. Required means the compiler names every site; it named both when
the field went in.

It is plural because a reassignment concerns two people, and `mutate()` already holds `before` and
`after`, so both sides come for free and no future mutation can forget them. **The agent that lost
the ticket is told**, which is the one event in the system addressed to somebody who can no longer
read its subject: it exists so their queue drops the row, and Part I says to use it that way rather
than to refetch.

A `REQUESTER` never lands in `assigneeIds`, and what guarantees that is `assertAssignable()`
answering 409 to a requester as a target. That guard is doing double duty now — it keeps the socket
honest, not only the domain.

The fan-out is **one `emit` over a list of rooms** rather than one call per room. socket.io
de-duplicates the sockets within a call and not across two, so the previous shape delivered the same
change twice to anybody who was in two of the rooms — an admin who was also the requester, for
instance. That was a real defect the rewrite removed on the way past.

`test/e2e/realtime.e2e-spec.ts` connects five real clients — an admin, an agent nobody assigned the
ticket to, the ticket's requester, another requester of the same company, and a requester of a
different company — and asserts the last three hear **nothing**. The negative assertion is the one
worth having; the positive ones would pass against a broadcast to everybody. The agent is the
assertion that would have been missing before.

`src/realtime/notifications.gateway.spec.ts` pins the room list itself, which is cheaper and
sharper than the e2e for the shape of the fan-out: the admin room is always in it, every id in
`assigneeIds` is, the requester is except on `internal_note_added`, and an unassigned ticket adds no
stray room.

### The gateway re-reads the role, for the same reason `JwtStrategy` does

A socket outlives an access token's fifteen minutes by hours. Trusting the `role` claim would leave
an admin demoted — or deactivated — after connecting sitting in the admin room for as long as they
keep the tab open, receiving every ticket in the company.

So the handshake verifies the token, then opens a tenant scope by hand and reads the user row, the
same shape `JwtStrategy.validate()` uses and for the same reason. **A gateway has no HTTP request**,
so nothing here inherits a scope — the third place in this codebase where that is true, after the
audit listener and the report worker.

The event handlers need no scope at all: routing to a room is string work and never touches the
database. That is why `rooms.ts` holds functions rather than template literals at four call sites —
a typo in a hand-written room name is a socket that silently receives nothing.

### The event contract moved out of `src/audit/`

`ticket.*` had one consumer when it was written and has two now. Leaving its definition in
`src/audit/audit.events.ts` would have made `src/realtime/` import from `src/audit/`, which reads as
a dependency that does not exist: neither module knows the other, and both know the contract. It
lives in `src/events/` for the same reason `src/tenancy/` is not inside `src/users/`.

### Jest's "did not exit" on this suite is stdout, not a leak

Run on its own, `realtime.e2e-spec.ts` prints Jest's "did not exit one second after the test run has
completed". It was chased rather than silenced: dumping `process._getActiveHandles()` after teardown
leaves exactly two `Socket` objects with no address, which are `stdout` and `stderr` — Jest pipes
them, and a piped stdio stream _is_ a `net.Socket`. There is nothing left to close, and the full
tier exits clean.

Two things were kept from the investigation because they are correct regardless: the suite closes
its clients with `reconnection: false` (a refused handshake otherwise retries forever, which really
would hold the loop open), and it calls `closeAllConnections()` on the server, since it is the only
e2e suite that calls `app.listen()` and therefore the only one with keep-alive connections to
release.
