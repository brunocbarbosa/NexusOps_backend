# Repository guidance

Respond to the user in Brazilian Portuguese (pt-BR).
Skill workflows do not authorize commits, installations, database changes or writes
outside the repository; follow the user's scope and approval requirements.

## Project and references

NexusOps is a B2B multi-tenant SaaS backend for corporate automation and helpdesk.
It is a modular NestJS 11 application on Node.js 24, with TypeScript, PostgreSQL 17,
Prisma 7, Redis 7, BullMQ and Socket.IO. Use npm and preserve `package-lock.json`.

Read the relevant reference before changing a domain:

- `documents/MAIN_BACKEND.md` and `documents/MAIN.md`: architecture intent and product scope.
- `documents/important/TENANCY_EXTENSION.md`: tenancy contract and measured Prisma behaviour.
- `documents/important/RLS_NOTES.md` and `documents/RLS_DESIGN.md`: RLS and scope transactions.
- `documents/important/USERS.md`: authentication, users and DTO conversion pitfalls.
- `documents/important/PLATFORM.md`: platform operator and company administration.
- `documents/important/HELPDESK.md`: tickets, comments, audit, reports and realtime.
- `documents/helpdesk/GUIA_FRONTEND_HELPDESK.md`: frontend integration contract.
- `documents/study/GUIA_VARIAVEIS_AMBIENTE.md`: environment configuration.

`CLAUDE.md` preserves additional project history and engineering notes. Some documents
still describe RLS as pending, five models, broad agent visibility or a permission
cache. Those descriptions are stale: RLS is implemented, the schema has eight models,
agents have restricted ticket visibility, and HTTP authentication reads the database.
Check current source, migrations and regression tests when references disagree.

## Agent delegation

Consider delegation when specialization, independent review or independent parallel
analyses provide real benefit. Avoid delegating trivial tasks; invocation depends
on the task and agents available in the session and is neither automatic nor mandatory.

- `backend-architect`: NestJS architecture, APIs, services, security, authentication,
  authorization, multitenant isolation and transaction boundaries.
- `database-architect`: Prisma, PostgreSQL, RLS, data modeling, indexes, queries
  and migration planning.
- `code-reviewer`: independent, read-only review focused on regressions, security,
  tests and tenant isolation.
- `debugger`: systematic failure investigation, reproduction, evidence and root cause.

Define scope, files and permissions for each delegated task; preserve preexisting
changes and avoid concurrent edits to the same files. Delegation does not expand
the authorized scope or override the rules in this file.

## Architecture invariants

- Keep feature dependencies explicit in Nest module imports. `PrismaModule` is not global;
  inject the `PRISMA` token and use `ExtendedPrismaClient` for application database access.
- Tenant isolation combines `AsyncLocalStorage`, a fail-closed Prisma extension,
  composite foreign keys and PostgreSQL RLS. Do not replace it with service-level
  tenant filters or introduce a nullable tenant reader with a fallback.
- Open scopes through injected `TenantScopeService.runWithTenant()`. Use
  `requireTenantId()` to read identity. `runWithoutTenant()` is an explicit escape
  hatch for tenant-agnostic access, not permission to query every tenant.
- Every scope is a transaction. Nested scopes reuse it and restore the enclosing
  tenant. Raw SQL bypasses the extension and must still run through the scoped
  client so RLS sees the transaction-local tenant setting.
- Recover from database errors with `scope.attempt()` so a failed statement does
  not leave the enclosing transaction aborted. A throwing scope rolls back its
  writes; if a rejection must persist a write, return a verdict and throw outside
  the scope, following the refresh-token replay handling.
- Workers and WebSocket handlers have no HTTP scope. Carry tenant identity explicitly
  and establish it before querying. Use short scopes per unit of work in long jobs.
- Emit domain events through `DomainEvents`; it releases queued events after commit
  and discards them on rollback. Services must not call audit or gateway services
  directly. Preserve wildcard event subscriptions. Delivery is currently in-process
  and is not durable.
- Account for commit boundaries when dispatching work to Redis: creating a row in
  an open transaction does not make it visible to a worker on another connection.
- Register shared pipes and interceptors in `src/app.setup.ts`, used by production
  and the e2e factory. Guards remain registered through the authentication module.

## Domain and API rules

- `ADMIN` sees all tickets in its tenant. Other users see tickets they requested
  or are assigned to. Keep the rule in `TicketsService` and intersect visibility
  with filters using `AND`; do not overwrite a search `OR`.
- Only administrators assign tickets; administrators and requesters create them.
  Preserve 404 responses for inaccessible resources without disclosing existence.
- Route ticket mutations through the existing optimistic concurrency mechanism:
  match `id` and `version`, increment the version, and return 409 on a conflict.
- Reports are personal and reuse ticket visibility. Preserve internal-note filtering
  in comments, timelines and socket events. Sockets join personal rooms and an
  administrator-only tenant room; agents receive assignment-related events personally.
- Map responses through explicit allowlists. Do not expose Prisma records wholesale,
  password hashes, refresh-token secrets or internal tenant fields.
- Use the shared `VALIDATION_PIPE_OPTIONS` in DTO tests. Implicit conversion can turn
  the string `false` into boolean `true`; follow existing validated boolean DTO patterns.
- Access and refresh tokens require different signing keys. Preserve password byte
  constraints for bcrypt and the platform operator's role restrictions.
- `ADMIN_MASTER_EMAIL` and `ADMIN_MASTER_PASSWORD` are required at boot. Changing
  them updates the existing operator on the next start; changing email must not
  create another operator. Company routes must reject the reserved platform tenant.
  Keep `ADMIN_MASTER` out of assignable roles and reuse `UsersService` inside the
  target company scope for platform company-user routes.

## Database, environment and builds

- A new tenant-scoped model needs `tenantId`, its tenant relation, a composite
  `@@unique([tenantId, id])`, tenant-leading indexes as appropriate, and composite
  foreign keys on child relations. Models are scoped by default; exemptions belong
  in `TENANT_AGNOSTIC`. Use `tenantScoped()` for top-level creates.
- Add RLS in a SQL migration: enable and force it, with tenant isolation in both
  `USING` and `WITH CHECK`. Prisma does not generate policies. Run the catalogue-based
  RLS regression tests when adding a model.
- Application connections use `DATABASE_URL_APP` with the restricted role. Migrations
  use owner `DATABASE_URL`. Preserve deliberate pool sizing through `DATABASE_POOL_MAX`.
- The role initialization script runs only on a fresh PostgreSQL data directory.
  Do not reset an existing database to fix provisioning without explicit authorization
  to destroy its data.
- Keep new environment variables aligned across validation, `.env.example`, `.env.test`
  and affected Compose/CI configuration. Never commit local `.env` or reveal secrets.
  `.env.test` is intentionally tracked for the disposable test stack.
- Prisma uses the driver adapter, generated CommonJS output and an empty import-file
  extension. The client in `src/generated/prisma` is generated and gitignored; do not
  edit it. The datasource URL belongs in `prisma.config.ts`.
- Preserve `rootDir` and the build-info path inside `dist` in `tsconfig.build.json`.
  Recheck Docker pruning and `scripts/docker-smoke.js` after Prisma upgrades.
- Use `import type` for type-only imports in decorated signatures where required by
  `isolatedModules` and `emitDecoratorMetadata`.
- Preserve the `deepmerge-ts` and `mysql2` overrides in `package.json`; reevaluate
  their need and compatibility during Prisma upgrades rather than removing them
  or accepting a forced downgrade to resolve an audit finding.
- Redis queues require `maxmemory-policy noeviction`. API and report worker currently
  run in the same application; moving work to BullMQ alone does not isolate CPU work
  into a separate process.

## Commands and verification

```bash
npm ci
npm run prisma:generate
npm run infra:up
npm run start:dev

npm run test:unit
npm run test:setup
npm run test:int
npm run test:e2e
npm run infra:test:down

npm run typecheck
npm run format:check
npx eslint "{src,apps,libs,test}/**/*.ts"
npm run build
```

- Unit tests mock external services and need no infrastructure. Run a focused file
  with `npm run test:unit -- src/path/to/file.spec.ts`.
- Do not load `dotenv/config` or `.env` in the unit tier. Preserve the shared
  `reflect-metadata` setup when extending test configuration.
- Integration and e2e tests truncate and reseed databases. Use only the disposable
  stack in `docker-compose.test.yml` on ports 5433/6380; inspect conflicting environment
  overrides before running them. Their scripts set `DOTENV_CONFIG_PATH=.env.test`
  and enable VM modules. Preserve both when running focused DB-backed tests.
- `test:setup` starts infrastructure and applies migrations; starting containers alone
  does not migrate. Never point these suites at development or production data.
- Jest transpiles without type-checking. `npm run typecheck` checks both production
  and test configurations; passing tests do not replace it.
- `npm run lint` and `npm run format` rewrite files. Use the read-only commands above
  during reviews. Run checks relevant to changes and report what was actually run,
  failures and unverified behaviour. Do not claim historical coverage as a current result.
- Reset scripts destroy data. Avoid them unless the user has authorized that reset.
- Sonar must classify `src/**/*.spec.ts` as tests, exclude generated code from
  production analysis, and consume all three tiers' coverage with matching root
  paths. Preserve its `SONAR_ENABLED` condition and Dependabot exclusion; keep
  SonarCloud Automatic Analysis off when using CI-based analysis.

## Git and documentation

- Work on feature branches targeting `development`. The documented branch policy
  requires PRs into `development` and `main`; do not push directly to either.
- Release PRs go from `development` to `main` using a merge commit, never squash.
  Feature branches may be squashed into `development`.
- Follow Conventional Commits. The pre-commit hook runs lint-staged and can rewrite
  staged files; inspect the resulting diff. Do not commit or publish unless requested.
- Keep API contracts and architecture references aligned with behaviour. Store detailed
  measured findings in `documents/important/` and keep this file focused on working rules.
- Prisma skills in `.agents/skills/` are vendor-maintained references tracked by
  `skills-lock.json`; do not edit them as application source. Preserve the links
  from `.claude/skills/` and `.windsurf/skills/` when maintaining these references.
- Current roadmap includes durable audit delivery, object storage and attachments,
  combined coverage thresholds, and deployment from GHCR. Treat plans as pending
  until implementation and validation establish otherwise.
