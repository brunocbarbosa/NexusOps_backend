## What changes

<!-- One sentence. The "why" is worth more than the "what" — the diff already shows the what. -->

## How to verify

<!-- Commands a reviewer can run, or the manual steps. -->

## Checklist

- [ ] The three tiers pass locally (`npm run test:all`, after `npm run test:setup` —
      `infra:test:up` alone leaves the database unmigrated)
- [ ] No query with a hand-written tenant filter (the chokepoint in `src/tenancy/`
      is what injects it — see `CLAUDE.md` → Architecture)
- [ ] If a new model entered the schema: registered as scoped or in `TENANT_AGNOSTIC`,
      **and given a Row-Level Security policy** in a hand-written migration — Prisma
      does not model RLS, so nothing generates it. Full checklist in
      `documents/important/TENANCY_EXTENSION.md` → Adding a new tenant-scoped model
- [ ] If a new environment variable was added: `.env.example` and `.env.test` updated
- [ ] `CLAUDE.md` updated if any architecture decision changed

<!-- A PR into main: only accepted when it comes from development (guard-main-source job). -->
