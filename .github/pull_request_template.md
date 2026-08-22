## What changes

<!-- One sentence. The "why" is worth more than the "what" — the diff already shows the what. -->

## How to verify

<!-- Commands a reviewer can run, or the manual steps. -->

## Checklist

- [ ] The three tiers pass locally (`npm run test:all`, with `npm run infra:test:up`)
- [ ] No query with a hand-written tenant filter (the chokepoint in `src/tenancy/`
      is what injects it — see `CLAUDE.md` → Architecture)
- [ ] If a new model entered the schema: registered as scoped or in `TENANT_AGNOSTIC`
- [ ] If a new environment variable was added: `.env.example` and `.env.test` updated
- [ ] `CLAUDE.md` updated if any architecture decision changed

<!-- A PR into main: only accepted when it comes from development (guard-main-source job). -->
