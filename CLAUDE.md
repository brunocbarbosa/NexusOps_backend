# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NexusOps is a B2B multi-tenant SaaS backend for corporate automation and helpdesk, built as a
portfolio project whose explicit goal is to solve senior-level engineering problems — not just to
deliver CRUD features. `documents/MAIN.md` is the authoritative project specification (in
Portuguese); read it before implementing anything architectural, since the "why" behind each
technology choice is recorded there.

`src/tenancy/` is real, measured code and the load-bearing part of the project. Everything else
under `src/` is still the NestJS scaffold (`src/app.*`); infrastructure, tooling and the CI/CD
pipeline are in place, and the domain modules are not written yet.

Other documents, by purpose:

| File                                | Read it when                                                        |
| ----------------------------------- | ------------------------------------------------------------------- |
| `documents/MAIN.md`                 | implementing anything architectural — the spec                      |
| `documents/DATABASE_MODEL.md`       | touching the schema                                                 |
| `documents/GUIA_CI_CD.md`           | you need the CI/CD setup explained from first principles            |
| `documents/PLANO_TESTS_CICD.md`     | you want the reasoning behind a CI/CD decision                      |
| `documents/CHECKLIST_TESTS_CICD.md` | you want to know what is done and what is still pending             |
| `documents/important/`              | the two deep references below — kept together so they stay findable |
| `documents/ROTEIRO_TESTS.md`        | never — historical, diverges from this repo in 8 places             |

`documents/important/` holds the two deep references that the sections below point at rather than
inline: `TENANCY_EXTENSION.md` (the measured Prisma 7.9.1 behaviour the tenant extension depends on
— read it before editing `src/tenancy/`) and `RLS_NOTES.md` (Row-Level Security, which is **not
implemented yet**). They live together so that detail nobody needs today does not get lost.

> **Before you commit:** `development` and `main` both reject direct pushes, admin included. Work
> starts on a feature branch and lands through a pull request — see "CI and branch flow" below.
> The `pre-commit` hook also rewrites staged files (`eslint --fix` via lint-staged), so a commit
> can legitimately contain more than you staged.

## Commands

```bash
npm run infra:up          # start PostgreSQL + Redis (docker compose, detached)
npm run infra:down        # stop containers
npm run infra:reset       # destroy volumes and recreate (wipes local data)
npm run infra:logs        # tail container logs

npm run start:dev         # dev server, watch mode
npm run build             # nest build -> dist/
npm run start:prod        # node dist/main

npm run infra:test:up     # start the ephemeral test stack (ports 5433/6380)
npm run infra:test:down   # stop it and destroy its volumes
npm run test:setup        # infra:test:up + migrate deploy against .env.test

npm run lint              # eslint --fix over src, apps, libs, test
npm run format            # prettier --write over the whole repo
npm run format:check      # same, read-only (this is what CI runs)

npm test                  # alias for test:unit
npm run test:unit         # tier 1 — mocks only, no Docker (src/**/*.spec.ts)
npm run test:int          # tier 2 — real Postgres, no HTTP (test/integration/*.int-spec.ts)
npm run test:e2e          # tier 3 — Supertest against a booted app (test/e2e/*.e2e-spec.ts)
npm run test:all          # the three in order
npm run test:watch
npm run test:cov          # coverage for the unit tier

npm run prisma:generate   # regenerate client into src/generated/prisma
npm run prisma:migrate    # migrate dev (creates + applies a migration)
npm run prisma:deploy     # migrate deploy (CI/production)
npm run prisma:reset      # drop and rebuild the database from migrations
npm run prisma:studio
```

Run a single unit test file or a single test by name:

```bash
npx jest src/path/to/file.spec.ts
npx jest -t "substring of the test name"

# The integration and e2e tiers must keep both the --experimental-vm-modules flag
# (see "Prisma 7 wiring" below) and DOTENV_CONFIG_PATH, or they will run against
# the development database instead of the ephemeral one:
DOTENV_CONFIG_PATH=.env.test node --experimental-vm-modules \
  node_modules/jest/bin/jest.js --config ./test/jest-integration.js -t "substring"
```

Note that `npm run lint` is `eslint --fix`: it rewrites files. Use `npx eslint "src/**/*.ts"`
when you need a read-only check.

## Three test tiers

The boundary between them is what each one is allowed to touch, and the point is that a failure
tells you where to look before you open the file:

| Tier            | Command             | Reaches                        | Config                     |
| --------------- | ------------------- | ------------------------------ | -------------------------- |
| **unit**        | `npm run test:unit` | nothing — mocks only           | `test/jest-unit.js`        |
| **integration** | `npm run test:int`  | a real Postgres, no HTTP       | `test/jest-integration.js` |
| **e2e**         | `npm run test:e2e`  | HTTP against a booted Nest app | `test/jest-e2e.js`         |

All three inherit from `test/jest.base.js`, which pins `rootDir` at the repository root — a
per-tier `rootDir` makes the emitted lcov paths incomparable and the reports impossible to merge
into one coverage number later. The configs are `.js` and not `.json` because Jest prints
`Unknown option "$comment"` on every run if the documentation is embedded in JSON.

The tenancy regressions live in the integration tier: `test/integration/tenant-isolation.int-spec.ts`
is what holds the chokepoint design in place, and `test/integration/prisma-wiring.int-spec.ts` is
the regression guard for the three Prisma 7 requirements below.

**The database is a separate, ephemeral one.** `docker-compose.test.yml` runs Postgres on 5433 and
Redis on 6380, with the data directory on `tmpfs` — it starts empty and dies with the container.
`.env.test` points at it and is **committed on purpose**: the credentials only ever reach that
throwaway stack, and CI needs the same values without a secret round-trip. `.gitignore` therefore
carries an explicit `!.env.test` exception. The `test:int` / `test:e2e` scripts set
`DOTENV_CONFIG_PATH=.env.test`, which is the only thing keeping the suites off the development
database — they truncate and reseed, so pointing them at `.env` wipes local data.

`npm run test:unit` needs nothing running. The other two need `npm run test:setup` first (or
`infra:test:up` plus `prisma migrate deploy`), and CI runs exactly those same scripts.

**`src/app.setup.ts` is the second chokepoint in this repository**, and it exists for the same
reason as the tenancy one. `configureApp(app)` holds everything that turns a bare Nest application
into _this_ application — today the global `ValidationPipe`, tomorrow filters, interceptors, a
route prefix. `src/main.ts` calls it and so does `test/utils/create-test-app.ts`. Register a pipe
or filter directly in `main.ts` and every e2e assertion about it becomes a lie: the test would be
exercising a differently-configured application than the one that ships. `src/app.setup.spec.ts`
guards that the `ValidationPipe` is still there.

## Environment

`.env` holds local values and is gitignored; `.env.example` is the documented template — keep it in
sync when adding a variable. `docker-compose.yml` reads `POSTGRES_*` / `REDIS_PORT` from the same
`.env`, so the compose credentials and `DATABASE_URL` must agree or the app will point at a
database that does not exist.

Prisma 7 does **not** read `.env` on its own: `prisma.config.ts` imports `dotenv/config`, and that
is the only reason the CLI sees `DATABASE_URL`. The datasource block in `prisma/schema.prisma`
therefore has no `url` — the URL is supplied by `prisma.config.ts`. Don't "fix" the schema by
adding `env("DATABASE_URL")` back to it. Jest never reads `.env`. The unit tier has no `setupFiles` at all; the
integration and e2e tiers load `dotenv/config`, and their npm scripts point `DOTENV_CONFIG_PATH`
at `.env.test`. Adding `setupFiles: ["dotenv/config"]` to the unit tier would silently give it a
database connection it is not supposed to have.

## Prisma 7 wiring

Prisma 7 is a sharp break from v6 and three separate things must all be right, or the client fails.
`test/integration/prisma-wiring.int-spec.ts` is the regression guard for all three — run
`npm run test:int` after touching any of them.

1. **A driver adapter is mandatory** for SQL providers. `new PrismaClient()` with no arguments is a
   _compile-time_ error in v7 ("Expected 1 arguments, but got 0"). The client must be constructed as:

   ```ts
   import { PrismaPg } from '@prisma/adapter-pg';
   const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
   const prisma = new PrismaClient({ adapter });
   ```

   Connection pool settings now come from `pg`, not from Prisma, so configure them on the adapter.

2. **The generator must emit CommonJS.** NestJS compiles to CJS, so `prisma/schema.prisma` sets
   `moduleFormat = "cjs"` and `importFileExtension = ""`. Without the first, `require()` of the
   client throws "exports is not defined in ES module scope". Without the second, the generated
   files import each other as `./enums.js` while the emitted files are TypeScript sources, giving
   `MODULE_NOT_FOUND`. Prisma 7 generates **TypeScript source**, not compiled JS — that is why the
   extension matters at all.

3. **Jest needs VM modules.** The Prisma runtime uses dynamic `import()`, which Jest's default CJS
   VM rejects with "A dynamic import callback was invoked without --experimental-vm-modules". The
   `test:int` and `test:e2e` scripts therefore run Jest through `node --experimental-vm-modules`
   instead of the `jest` binary. Any DB-backed test must run under one of those, not `npm test`.

`npm test` (unit) stays green without Docker running; `npm run test:int` and `npm run test:e2e`
require `npm run test:setup`.

Unrelated v7 rename that costs a minute each time: `prisma migrate diff` dropped
`--from-schema-datasource`. Comparing the live database against a candidate schema is now
`--from-schema prisma/schema.prisma --to-schema <other> --script`.

## Architecture

The five problems below are the reason this project exists. Each has a designated mechanism, and
the mechanism is always a chokepoint rather than a per-handler convention — the point is that a
developer writing a new feature cannot forget to apply it.

**Multi-tenancy — shared database, shared schema.** Two independent layers, deliberately
redundant:

1. `AsyncLocalStorage` (from `node:async_hooks`, no library) holds the authenticated user's
   `tenant_id` for the lifetime of a request. A Prisma Client Extension reads it and injects the
   tenant filter into every query. This is why the tenant filter must never be written by hand in
   a service — a hand-written query is a query that can be wrong.
2. PostgreSQL native Row-Level Security as the backstop, in case the extension is bypassed
   (raw SQL, a mistake in the extension itself).

The critical consequence: **BullMQ workers and WebSocket handlers have no HTTP request**, so the
`AsyncLocalStorage` context is empty there. Tenant identity must be carried explicitly in the job
payload and re-established inside the worker before any query runs. This is the single most
likely place for a tenant leak.

`src/tenancy/` implements the first of those two layers. Two rules follow from it, and they hold
everywhere in the codebase:

- **Never hand-write a tenant filter in a service.** The extension injects it; a hand-written one
  is a filter that can be wrong or forgotten.
- **Never reach for a `currentTenantId(): string | undefined`.** It does not exist on purpose,
  because `?? fallback` is exactly the silent bypass this design prevents. Use `requireTenantId()`,
  which returns a string or throws, and `runWithoutTenant()` when a read genuinely must be unscoped.

The extension's measured behaviour against Prisma 7.9.1 — five findings the design depends on,
including why nested access cannot be intercepted and why that hole is closed in the schema instead
— is in **`documents/important/TENANCY_EXTENSION.md`**. Read it before editing anything in
`src/tenancy/`, and re-check it after a Prisma upgrade.

**RLS is not implemented yet** — there is no policy, no `set_config` and no low-privilege role in
the code today. Two things will bite whoever writes it, both measured here rather than read in
documentation: a superuser bypasses RLS unconditionally and `FORCE` does not help, and the app
currently connects as one; and setting the tenant outside an interactive `$transaction` lands on a
different pooled connection than the query, which under concurrency serves _another tenant's_ rows.
The measurements and the remaining work are in **`documents/important/RLS_NOTES.md`**.

**Optimistic concurrency control.** Simultaneous ticket updates are a real race in a helpdesk. A
version column guards mutable rows; a conflicting update must fail loudly rather than silently
overwrite. Any new mutable aggregate needs the same guard.

**Reactive audit trail.** `@nestjs/event-emitter` implements an Observer pattern: mutations emit
events, and the audit module listens and persists log rows in `JSONB`. Business logic must not
call the audit service directly — that coupling is exactly what this design removes.

**Asynchronous processing.** Anything that would block the Node event loop (report generation,
file processing) goes to a BullMQ queue on Redis instead of running in the request. Redis is
configured with `maxmemory-policy noeviction` in `docker-compose.yml` because evicting a BullMQ
key mid-flight corrupts the queue.

**Real-time notifications.** A NestJS WebSockets Gateway (socket.io) notifies the client when a
background job finishes. Redis therefore serves double duty: queue backend and permission cache.

## Stack notes

NestJS 11 on Node 24, TypeScript in `strict` mode with `module`/`moduleResolution` set to
`nodenext`. Prisma 7 generates its client to `src/generated/prisma`, which is gitignored — run
`npm run prisma:generate` after cloning or after any schema change, or imports will fail to
resolve.

**Two lines of `tsconfig.build.json` are load-bearing and look like clutter.** `rootDir: "./src"`
keeps `prisma.config.ts` out of the program — without it tsc infers a rootDir of `.`, the build
lands in `dist/src/main.js`, and `start:prod` plus the Dockerfile `CMD` both point at a file that
is not there. Setting it moves the incremental cache to the repository root, outside anything
`nest build` cleans, so `tsBuildInfoFile` pins it back inside `dist/`. Without that pin,
`deleteOutDir` wipes `dist/` while the cache survives insisting the build is current: **a clean
build emits zero files and exits 0**, and `COPY` of an empty `dist/` raises no error either. That
is why CI boots the image and curls it — the smoke test runs `scripts/docker-smoke.js`, not
`dist/main`, and would not catch it.

**The Dockerfile deletes packages on purpose** (778MB → 406MB): the Prisma CLI and Studio, which
survive `--omit=dev` because `@prisma/client@7` declares them as _optional_ peers, plus every WASM
query compiler that is not PostgreSQL. All of it loads lazily, so a wrong prune fails on the first
real query rather than at boot. `scripts/docker-smoke.js` runs inside the image against a live
database and issues both a `$queryRaw` and a model query — the model query is the one that reaches
the compiler. Re-check the prune when upgrading Prisma; the smoke test is what turns that from a
hope into a check.

`package.json` pins an npm `overrides` entry forcing `deepmerge-ts` to `^8.0.1`. This resolves a
high-severity advisory reachable through the Prisma CLI; removing it reintroduces the
vulnerability, and the alternative was downgrading Prisma. Re-check whether it is still needed
when upgrading Prisma.

Auth is JWT-based with the tenant id in the token payload, using `@nestjs/jwt` + Passport
(`passport-jwt`) and `bcrypt` for password hashing. Validation uses `class-validator` /
`class-transformer` through the global `ValidationPipe`, registered in `src/app.setup.ts`.

## CI and branch flow

`development` is the default branch and the one all work targets. `main` receives **only** from
`development`, and that is enforced by a job, not by a convention: GitHub rulesets can require a
pull request but cannot restrict the branch it comes _from_, so `.github/workflows/ci.yml` carries
a `guard-main-source` job that fails any PR into `main` whose head is not `development`.

Both branches require a pull request with `quality` and `test` green; `main` additionally requires
`guard-main-source`. There are no bypass actors, so a direct push to either branch is rejected —
including one from an admin. Work starts on a feature branch.

The pipeline runs seven jobs. Three are worth knowing about before you touch them:

- **`test`** runs `npm run test:setup` and then the three tiers, against the same
  `docker-compose.test.yml` you run locally. GitHub Actions' `services:` directive cannot override
  a container's command, and Redis must start with `--maxmemory-policy noeviction`, which is why
  one compose file serves both environments instead of two definitions drifting apart.
- **`docker`** builds the image on every PR and pushes to GHCR only on push to `main`. It boots the
  image and curls it before pushing — a build that emits nothing exits 0 and the `COPY` of an empty
  `dist/` succeeds, so only a boot catches that — and then runs `scripts/docker-smoke.js` against a
  live database, which is what keeps the Dockerfile's aggressive prune honest.
- **`commitlint`** re-checks the commit messages that `git commit --no-verify` skipped locally.
  `commitlint.config.js` exempts commits carrying Dependabot's `Signed-off-by` trailer: its subject
  is sentence-case and not configurable, so without the exemption every bot PR is permanently red.

`sonar` is live: SonarCloud analyses every PR against a quality gate on **new** code (80% coverage,
3% duplication), fed by the coverage artifact the `test` job uploads. Two things keep it working and
both look like bugs when they break. It skips `dependabot[bot]`, because Dependabot pull requests
get their secrets from a separate store and `SONAR_TOKEN` arrives empty — the job runs, since `vars`
do arrive, and then fails with "Not authorized". And SonarCloud's **Automatic Analysis must stay
off**: it refuses CI-based analysis while enabled, and it scans the whole repository, vendored
Prisma docs included, where the job scopes itself to `src`.

`documents/GUIA_CI_CD.md` explains the whole setup from first principles, in Portuguese — every
tool, why it is there, and what each pipeline job guards against. It is the long-form companion to
this section.

## Repo conventions

`prisma init` installed vendor-maintained Prisma skill files, tracked by `skills-lock.json`.
`.agents/skills/` holds the real content (~500K, version-pinned to Prisma 7.9.1); `.claude/skills/`
and `.windsurf/skills/` are **symlink farms pointing into it**. Deleting `.agents/` therefore breaks
the Claude Code skills too — remove all three or none. These are Prisma's own reference docs, not
project rules, and they are what documented the three wiring requirements above.
