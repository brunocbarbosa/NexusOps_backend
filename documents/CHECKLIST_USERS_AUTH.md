# Checklist — Feature `users` (CRUD + autenticação)

Acompanhamento item a item da implementação, mantido durante toda a execução. É o registro do que
foi feito e do que continua pendente.

O plano aprovado é a origem deste arquivo; o conhecimento que sobreviver à implementação — o que
custou medição e seria caro redescobrir — vai para
[`important/USERS.md`](./important/USERS.md), não para cá.

Marcar cada item ao concluir. Cada fase termina com verificação + commit + checkpoint.

**Regra de execução:** implementar → rodar a verificação da fase e mostrar a saída real →
marcar aqui → commit → parar e perguntar antes da próxima fase.

## Decisões tomadas antes de começar

| Assunto       | Decisão                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| Login         | `tenantDomain` no corpo — `runWithoutTenant()` resolve o `Tenant` primeiro |
| Refresh token | Com tabela `refresh_tokens` (revogação real + rotação)                     |
| Exclusão      | Soft delete (`deleted_at` em `users`)                                      |
| Bootstrap     | `POST /auth/register` público cria `Tenant` + primeiro `ADMIN`             |

---

## Fase 0 — Branch e checklist

- [x] Branch `feat/users-auth` criada a partir de `development` (`development` e `main` recusam
      push direto, admin incluído)
- [x] Este checklist criado em `documents/`

---

## Fase 1 — Fundação: config, Prisma no Nest, contexto de tenant

### Configuração

- [x] `src/config/env.validation.ts` — validação com `class-validator` (já instalado; evita
      adicionar `joi`/`zod`) de `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_SECRET`,
      `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `BCRYPT_SALT_ROUNDS`
- [x] `ConfigModule.forRoot({ isGlobal: true, validate })` no `AppModule` — é o que faz
      `npm run start:dev` enxergar o `.env` (hoje nada carrega, `nest start` não lê)
- [x] Confirmado que `.env.test` continua vencendo nas tiers de integração/e2e

### Prisma dentro do Nest

- [x] `src/prisma/prisma.client.ts` — `createPrismaClient()` com o adapter `PrismaPg` e
      `$extends(tenantIsolationExtension)`, mais o tipo `ExtendedPrismaClient`
- [x] `src/prisma/prisma.module.ts` — provider sob o token `PRISMA`, exportado, com
      `onModuleDestroy` chamando `$disconnect()`

### Contexto de tenant por requisição

- [x] `src/tenancy/tenant-context.interceptor.ts` — roda o handler dentro de `runWithTenant`
      a partir de `request.user.tenantId`
- [x] Registrado em `configureApp()` (`src/app.setup.ts`), o chokepoint que o e2e compartilha
- [x] `src/app.setup.spec.ts` atualizado para provar que o interceptor continua registrado

### Verificação

- [x] `npm run test:unit` — spec do interceptor (ALS real, handler falso) e do `env.validation`
- [x] `npm run test:int` — spec novo provando que o client de `createPrismaClient()` filtra por
      tenant dentro de `runWithTenant` e lança `TenantContextMissingError` fora dele
- [x] `test/integration/env-precedence.int-spec.ts` — prova que `@nestjs/config` não sobrescreve
      `process.env`. Não estava previsto: é comportamento de dependência, e é a única coisa que
      mantém as suítes fora do banco de desenvolvimento agora que a app lê o `.env`

### Não estava no plano

- [x] `src/tenancy/tenant-scoped.ts` — o `create` gerado pelo Prisma exige `tenantId` em tempo de
      compilação mesmo a extension injetando em runtime, então sem esta ponte todo service seria
      obrigado a escrever o tenant à mão, que é justamente o que a camada existe para eliminar
- [x] `setupFiles: ['reflect-metadata']` em `test/jest.base.js` — o polyfill só chegava
      implicitamente pelo `@nestjs/core`, então um spec unitário que importa uma classe decorada
      sem subir o Nest falhava com `Reflect.getMetadata is not a function`
- [x] `npx tsc --noEmit -p tsconfig.json` no job `quality` e script `npm run typecheck`. Medido:
      o `isolatedModules` põe o ts-jest em transpile-only, então `const n: number = 'texto'` num
      spec passa na suíte inteira — `test/` não era checado por ninguém. O comentário do workflow
      afirmava o contrário e foi corrigido

---

## Fase 2 — Schema: soft delete e refresh tokens

- [ ] `User.deletedAt DateTime? @map("deleted_at")`
- [ ] Model `RefreshToken` nas convenções do arquivo: `@@unique([tenantId, id])`, FK composta
      contra `@@unique([tenantId, id])` de `User`, `@@index([tenantId, userId])`,
      `@@map("refresh_tokens")`
- [ ] Relações inversas em `Tenant` e `User`
- [ ] Migration `users_auth` criada e `prisma generate` rodado

### Verificação

- [ ] `npm run test:setup && npm run test:int` — a migration aplica no banco efêmero e os specs
      de tenancy continuam verdes

---

## Fase 3 — Auth: registro, login, guards

- [ ] `src/auth/dto/` — `RegisterDto`, `LoginDto`, `RefreshDto`
- [ ] `src/auth/hashing.service.ts` — `bcrypt` com custo vindo de `BCRYPT_SALT_ROUNDS`
- [ ] `src/auth/jwt.strategy.ts` — payload `{ sub, tenantId, role, email }`; `validate()` recusa
      usuário soft-deleted (senão um token válido sobrevive à desativação até expirar)
- [ ] `jwt-auth.guard.ts` + `@Public()` — `APP_GUARD` global, autenticado por padrão
- [ ] `roles.guard.ts` + `@Roles()` sobre `UserRole` — segundo `APP_GUARD`
- [ ] `@CurrentUser()`
- [ ] `auth.service.register()` — `Tenant` + primeiro `ADMIN` numa `$transaction` que troca de
      escopo no meio; `tenantDomain` duplicado → 409
- [ ] `auth.service.login()` — tenant inexistente, senha errada e usuário desativado devolvem
      **a mesma** 401
- [ ] `auth.controller.ts` — `POST /auth/register`, `POST /auth/login`, `GET /auth/me`

### Verificação

- [ ] `npm run test:unit` — service com Prisma mockado
- [ ] `npm run test:e2e` — `auth.e2e-spec.ts`: registro → login → `/auth/me`, 401 sem token,
      401 com senha errada
- [ ] `npm run test:int` — o `$transaction` do `register()` com troca de escopo

---

## Fase 4 — Refresh, rotação e logout

- [ ] Refresh token como JWT `{ sub, tenantId, jti }`; a linha guarda o **sha256** do token
- [ ] `POST /auth/refresh` público, com rotação (revoga a atual, emite par novo)
- [ ] Detecção de reúso: token já revogado → revoga todos os do usuário e devolve 401
- [ ] `POST /auth/logout` autenticado, revoga o token apresentado

### Verificação

- [ ] `npm run test:e2e` — login → refresh → o antigo vira 401; reusar o antigo invalida o novo;
      logout invalida o refresh

---

## Fase 5 — CRUD de usuários

- [ ] `POST /users` (ADMIN) — e-mail de usuário soft-deleted → 409 apontando o restore
- [ ] `GET /users` (ADMIN, AGENT) — paginado; `includeDeleted` só para ADMIN
- [ ] `GET /users/:id` (autenticado) — outro tenant → 404, nunca 403
- [ ] `PATCH /users/:id` (ADMIN) — não aceita `passwordHash` nem `tenantId`
- [ ] `PATCH /users/me/password` — exige `currentPassword`, revoga os refresh tokens do usuário
- [ ] `DELETE /users/:id` (ADMIN) — soft delete; recusa auto-exclusão e o último ADMIN ativo
- [ ] `POST /users/:id/restore` (ADMIN)
- [ ] Nenhum filtro de tenant escrito à mão em lugar nenhum do módulo
- [ ] `passwordHash` nunca sai na resposta — mapeamento explícito, não `exclude` implícito
- [ ] O filtro `deletedAt: null` fica no service, **não** na extension

### Verificação

- [ ] `npm run test:unit` + `npm run test:e2e` (`users.e2e-spec.ts`)
- [ ] `test/integration/users-tenancy.int-spec.ts` — ADMIN do tenant A não enxerga nem altera
      usuário do tenant B, com o filtro vindo só da extension

---

## Fase 6 — Documentação

- [ ] `documents/important/USERS.md` — conhecimento medido desta fatia (não tutorial)
- [ ] `documents/important/README.md` — nova linha na tabela
- [ ] `CLAUDE.md` — tabela de documentos, a frase de que `src/` ainda é scaffold, e uma seção
      curta em **Architecture** que **aponta** para `USERS.md` em vez de repeti-lo
- [ ] `.env.example` revisado
- [ ] Este checklist fechado

### Verificação final

- [ ] `npm run test:all`
- [ ] `npx eslint "src/**/*.ts"` (read-only; `npm run lint` reescreve) e `npm run format:check`
- [ ] `npm run build` — `dist/main.js` existe de verdade
- [ ] Fluxo manual ponta a ponta contra `npm run start:dev`
- [ ] PR de `feat/users-auth` para `development` com `quality` + `test` verdes

---

## Pendências futuras

- [ ] Rate limiting no `POST /auth/login` (`@nestjs/throttler`) — hoje nada limita tentativa de
      senha
- [ ] Convite de usuário por e-mail em vez de o ADMIN definir a senha inicial
- [ ] Recuperação de senha (depende de envio de e-mail, que ainda não existe no projeto)
- [ ] Cache de permissões no Redis, que o `MAIN.md` prevê e o `RolesGuard` hoje resolve indo ao
      banco em toda requisição via `JwtStrategy.validate()`
