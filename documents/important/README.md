# documents/important

The deep references that `CLAUDE.md` **points at** instead of containing.

They live here for a specific reason: they are details nobody needs on most days, but that cost real
measurement time and would be expensive to rediscover. Inline in `CLAUDE.md` they diluted what
applies to every task; scattered around the repository they get lost.

**The rule for this folder:** what goes in here is measured knowledge — behaviour observed in this
repository, with the number and the consequence — not didactic explanation. Guides that teach live
in `documents/`; execution records (plan, checklist) do too.

| File                                             | Read it before                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| [`TENANCY_EXTENSION.md`](./TENANCY_EXTENSION.md) | editing `src/tenancy/`, or after any Prisma upgrade                        |
| [`USERS.md`](./USERS.md)                         | touching `src/auth/`, `src/users/`, or a DTO in any module                 |
| [`RLS_NOTES.md`](./RLS_NOTES.md)                 | implementing Row-Level Security — which **does not exist yet** in the code |

All of them were measured against this repository's versions — Prisma 7.9.1, PostgreSQL 17, bcrypt
6.0.0, class-transformer 0.5.1 — not taken from documentation. An upgrade of any of them is reason
to re-check these; the suites in `test/integration/` are what will tell you if something stopped
being true.
