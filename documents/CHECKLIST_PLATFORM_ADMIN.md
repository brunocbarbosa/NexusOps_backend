# Checklist — `ADMIN_MASTER` (administrador de plataforma + CRUD de companies)

Acompanhamento item a item da implementação, mantido durante toda a execução. É o registro do que
foi feito e do que continua pendente.

O plano aprovado é a origem deste arquivo; o conhecimento que sobreviver à implementação — o que
custou medição e seria caro redescobrir — vai para
[`important/PLATFORM.md`](./important/PLATFORM.md), não para cá.

Marcar cada item ao concluir. Cada fase termina com verificação + commit + checkpoint.

**Regra de execução:** implementar → rodar a verificação da fase e mostrar a saída real →
marcar aqui → commit → parar e perguntar antes da próxima fase.

## O problema

O NexusOps não tem dono. `POST /auth/register` é público, então qualquer pessoa cria uma company
e vira o primeiro `ADMIN` dela. Não existe papel acima do tenant: ninguém cadastra clientes,
ninguém provisiona o primeiro usuário de um cliente novo, ninguém desativa um cliente que saiu.

## A restrição que molda tudo

`User.tenantId` é `NOT NULL`, e as FKs compostas do schema (`Ticket.requester`, `AuditLog.user`,
`RefreshToken.user`) apontam para `@@unique([tenantId, id])`. Um usuário literalmente sem tenant
quebraria essa camada — que é a parte load-bearing do projeto. Daí a escolha do tenant de
plataforma reservado.

## Decisões tomadas antes de começar

| Assunto                   | Decisão                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Onde o ADMIN_MASTER mora  | `User` com `role = ADMIN_MASTER` dentro de um tenant de plataforma reservado            |
| `POST /auth/register`     | **Removido.** Company só nasce por `POST /platform/companies`                           |
| Seed do admin_master      | `OnModuleInit` idempotente; o `.env` é a fonte da verdade (re-hasheia se a senha mudar) |
| Exclusão de company       | Hard delete, cascade (irreversível)                                                     |
| Unicidade da plataforma   | `Tenant.isPlatform Boolean? @unique` — NULLs distintos no Postgres dão "no máximo um"   |
| Unicidade do admin_master | Índice parcial único em `users`, SQL cru na migration                                   |

## A ideia central

A camada de tenancy já oferece as duas primitivas necessárias, então quase não há código novo:

- **CRUD de company** → `Tenant` é o único modelo em `TENANT_AGNOSTIC`; sob `runWithoutTenant()`
  o `scopeAgnostic` devolve os args intactos e o CRUD completo funciona.
- **CRUD de usuários dentro da company X** → `runWithTenant(companyId, () => usersService.…)`,
  exatamente a forma que a documentação prescreve para um worker BullMQ. **Todo o `UsersService`
  é reaproveitado verbatim** — nenhuma query duplicada, nenhum filtro de tenant escrito à mão.

---

## Fase 0 — Branch e checklist

- [x] Branch `feat/platform-admin-master` criada a partir de `development` (`development` e
      `main` recusam push direto, admin incluído)
- [x] Este checklist criado em `documents/`

---

## Fase 1 — Schema, enum e a barreira de escalação

### Schema

- [x] `enum UserRole` ganha `ADMIN_MASTER` em `prisma/schema.prisma`
- [x] `model Tenant` ganha `isPlatform Boolean? @unique @map("is_platform")` — nullable de
      propósito: NULLs são distintos num índice único no Postgres, então "no máximo um `true`"
      sai de graça, é expressável no schema (sem drift) e a listagem vira `where: { isPlatform: null }`
- [x] Migrations criadas e aplicadas — **duas**, e a separação é obrigatória:
      `20260825125236_platform_admin_master` (enum + coluna) e
      `20260825125237_admin_master_uniqueness` (o índice). O PostgreSQL recusa _usar_ um
      valor de enum adicionado na mesma transação, e o Prisma roda cada arquivo numa
      transação — o `ADD VALUE` e o índice que o referencia não cabem no mesmo arquivo
- [x] SQL cru na migration: `CREATE UNIQUE INDEX users_single_admin_master ON users ((true)) WHERE role = 'ADMIN_MASTER'`
      — sem filtro por `deleted_at`: exatamente uma linha, sempre
- [x] Nota de drift registrada: índice parcial não é expressável em `schema.prisma`, então
      `prisma migrate dev` vai propor um `DROP`. Fallback documentado (`isPlatformAdmin Boolean? @unique`)
- [x] `npm run prisma:generate` rodado

### A barreira de escalação

O defeito a evitar: assim que `UserRole` ganha `ADMIN_MASTER`, o `@IsEnum(UserRole)` do
`CreateUserDto` deixaria um `ADMIN` comum criar um `ADMIN_MASTER` dentro da própria company.

- [x] `src/users/assignable-role.ts` — `ASSIGNABLE_ROLES = [ADMIN, AGENT, REQUESTER]`
- [x] `CreateUserDto.role` usa `@IsIn(ASSIGNABLE_ROLES)` e tipa `AssignableRole`
- [x] `UpdateUserDto.role` usa `@IsIn(ASSIGNABLE_ROLES)` e tipa `AssignableRole`
- [x] `QueryUsersDto.role` usa `@IsIn(ASSIGNABLE_ROLES)` e tipa `AssignableRole`
- [x] Falha fechado no `ValidationPipe` (400), antes de qualquer service — o índice único é a
      segunda camada, na mesma lógica das duas camadas de tenancy

### Verificação

- [x] `npm run typecheck` verde
- [x] `npm run test:unit` verde — 108 testes, 11 suítes
- [x] `npx eslint "src/**/*.ts"` (read-only) e `npm run format:check` verdes
- [x] Constraints verificadas **no banco**, não só no SQL aplicado: segundo platform tenant
      recusado, segundo `ADMIN_MASTER` recusado, e duas companies com `is_platform` NULL ambas
      aceitas — o truque de NULLs distintos confirmado
- [x] Barreira de escalação **falsificada**: trocar `@IsIn(ASSIGNABLE_ROLES)` por
      `@IsIn(Object.values(UserRole))` faz o teste falhar; restaurar faz passar
- [x] Commit + checkpoint

---

## Fase 2 — Bootstrap a partir do `.env`

### Variáveis

- [ ] `ADMIN_MASTER_EMAIL` (`@IsEmail()`) em `EnvironmentVariables`
- [ ] `ADMIN_MASTER_PASSWORD` (`@IsString() @MinLength(8) @MaxBytes(BCRYPT_MAX_BYTES)`,
      reaproveitando `src/auth/password.constraints.ts`)
- [ ] Recusa do placeholder em produção, no mesmo bloco que já recusa o `JWT_SECRET` de exemplo
- [ ] `.env.example` atualizado
- [ ] `.env.test` atualizado
- [ ] (o passo de boot da CI é a Fase 5 — a quarta porta)

### O seeder

- [ ] `src/platform/platform.constants.ts` — `PLATFORM_TENANT_DOMAIN = 'platform'`,
      `PLATFORM_TENANT_NAME`. Em código, não no `.env`: menos peças móveis
- [ ] `src/platform/platform-bootstrap.service.ts` — `OnModuleInit`, upsert idempotente com a
      mesma forma da transação de `AuthService.register` (escopo que muda no meio:
      `runWithoutTenant` para o `Tenant`, `runWithTenant` para o `User`)
- [ ] O upsert do usuário reescreve `passwordHash` e zera `deletedAt` — o `.env` é a fonte da
      verdade, então rotacionar a senha lá tem efeito, e um admin_master desativado volta
- [ ] `PlatformModule` importa `AuthModule` (ordem de init: `HashingService.onModuleInit` precisa
      ter construído o decoy hash antes)
- [ ] Registrado no `AppModule`

### Verificação

- [ ] Login do admin_master funciona **sem nenhuma mudança em `src/auth/`**:
      `POST /auth/login { tenantDomain: "platform", … }` — saída real mostrada
- [ ] `npm run typecheck` verde
- [ ] Commit + checkpoint

---

## Fase 3 — `src/platform/`, os dois CRUDs

### Companies

- [ ] `src/platform/companies.service.ts` + `companies.controller.ts`, tudo sob
      `@Roles(UserRole.ADMIN_MASTER)`
- [ ] `POST /platform/companies` → 201. **Exige o primeiro ADMIN no mesmo payload**
      (`{ name, domain, admin: { email, password } }`): uma company sem `ADMIN` é uma em que
      `assertNotLastAdmin` nunca pode ser satisfeito e na qual ninguém entra. É a transação de
      `AuthService.register` **movida**, não reescrita
- [ ] `GET /platform/companies` → 200, paginado, `where: { isPlatform: null }`
- [ ] `GET /platform/companies/:id` → 200
- [ ] `PATCH /platform/companies/:id` → 200 (`name`, `domain`, `isActive`)
- [ ] `DELETE /platform/companies/:id` → 204, hard delete (cascade)
- [ ] `CreateCompanyDto` herda o regex de hostname de `RegisterDto` e recusa explicitamente o
      valor reservado `platform` com 400 (o `@unique` já daria 409, mas 400 é mais claro)

### Usuários de uma company

- [ ] `src/platform/company-users.controller.ts` — casca fina: `runWithTenant(companyId, () => usersService.…)`
- [ ] `POST /platform/companies/:id/users` → 201
- [ ] `GET /platform/companies/:id/users` → 200, paginado
- [ ] `GET /platform/companies/:id/users/:userId` → 200
- [ ] `PATCH /platform/companies/:id/users/:userId` → 200
- [ ] `DELETE /platform/companies/:id/users/:userId` → 204
- [ ] `POST /platform/companies/:id/users/:userId/restore` → 200

### `loadCompany(id)` — o chokepoint das rotas aninhadas

- [ ] Sob `runWithoutTenant()`, 404 se a company não existe — sem ele um UUID inexistente
      devolveria lista vazia em vez de 404, porque `runWithTenant` aceita qualquer string
- [ ] 404 também se o id é o **tenant de plataforma** — sem isso,
      `/platform/companies/<platform-id>/users/<self>` deixaria o admin_master se apagar

### A mudança cirúrgica no `UsersService`

Dois pontos comparam com `UserRole.ADMIN` e recusariam o admin_master agindo dentro de uma company.

- [ ] `administersUsers(role)` — predicado nomeado (`ADMIN || ADMIN_MASTER`), em vez de um
      `requester` sintético, que seria mentira
- [ ] Aplicado no gate de `includeDeleted` em `findAll` (403)
- [ ] Aplicado no gate de soft-deleted em `load()` (404)
- [ ] `assertNotLastAdmin` **não muda**: conta `role: ADMIN` no escopo corrente, que é a company
      alvo — correto por construção
- [ ] `RolesGuard` **não muda**: continua não-hierárquico (`includes()`, não ordenação)

### Verificação

- [ ] `npm run typecheck` verde
- [ ] `npm run test:unit` verde
- [ ] Commit + checkpoint

---

## Fase 4 — Fechar `/auth/register`

- [ ] Rota removida de `src/auth/auth.controller.ts`
- [ ] `AuthService.register` removido (a transação já viveu para `CompaniesService.create`)
- [ ] `src/auth/dto/register.dto.ts` removido
- [ ] Rotas públicas passam a ser: `POST /auth/login`, `POST /auth/refresh`, `GET /`

### Os fixtures que isto quebra

- [ ] `test/utils/platform-session.ts` — `loginAsAdminMaster(app)` (login real, credenciais de
      `.env.test`) e `createCompany(app, session, label)`
- [ ] `test/e2e/users.e2e-spec.ts` — `newTenant()` migrado para o helper novo
- [ ] `test/integration/users-tenancy.int-spec.ts` — `seed()` migrado
- [ ] `test/integration/auth-registration.int-spec.ts` → `platform-companies.int-spec.ts`
- [ ] `test/e2e/auth.e2e-spec.ts` atualizado

### Verificação

- [ ] `npm run test:all` verde — saída real mostrada
- [ ] Commit + checkpoint

---

## Fase 5 — CI, e o boot que passa a tocar o banco

O passo "The image boots and answers HTTP" diz hoje, textualmente: _"The database does not need
to exist: Prisma connects on the first query, and none happens here."_ Um seeder em
`OnModuleInit` desfaz essa premissa — o container roda em bridge e `DATABASE_URL` aponta para
`localhost:5433`, que lá dentro é o próprio container.

- [ ] `.github/workflows/ci.yml`, job `docker`: `-p 3000:3000` → `--network host` (o banco já
      existe, o passo anterior roda `npm run test:setup`; só não era alcançável)
- [ ] `-e ADMIN_MASTER_EMAIL` e `-e ADMIN_MASTER_PASSWORD` acrescentados, do mesmo `.env.test`
- [ ] Comentário do passo reescrito: ele deixa de ser "só um boot" e passa a exercitar o
      bootstrap contra um banco real — cobertura melhor, não pior
- [ ] Pipeline verde no PR
- [ ] Commit + checkpoint

---

## Fase 6 — Testes e documentação

### Unit

- [ ] `platform-bootstrap.service.spec.ts` — mocks à mão dentro de `runWithTenant`/`runWithoutTenant`,
      no molde de `src/users/users.service.spec.ts`
- [ ] DTOs novos passando pelo `VALIDATION_PIPE_OPTIONS` real, no molde de `query-users.dto.spec.ts`
- [x] **`role: 'ADMIN_MASTER'` recusado com 400** — o teste da barreira de escalação.
      Antecipado para a Fase 1: um guard que entra sem teste, junto com a superfície que ele
      protege, é o que regride primeiro. `src/users/dto/user-role.dto.spec.ts`

### Integration

Semear com o cliente **sem** extensão, como `tenant-isolation.int-spec.ts` faz — "um fixture
construído pela coisa sob teste não prova nada".

- [ ] `platform-bootstrap.int-spec.ts` — idempotência em dois boots
- [ ] A senha do `.env` re-hasheada no segundo boot
- [ ] Um segundo `ADMIN_MASTER` inserido pelo cliente cru viola o índice único
- [ ] Um segundo tenant com `isPlatform: true` viola o `@unique`

### E2E

- [ ] `platform.e2e-spec.ts` — admin_master cria company, cria usuários de cada nível, lista,
      atualiza, desativa, restaura, apaga a company
- [ ] Um `ADMIN` comum leva 403 em toda `/platform/**`
- [ ] `/platform/companies/<platform-id>/users` dá 404
- [ ] A company apagada some junto com seus usuários

### Documentação

- [ ] `documents/important/PLATFORM.md` — novo, em duas partes no formato de `USERS.md`.
      Parte I: rotas, payloads reais capturados, catálogo de erros. Parte II, o medido: por que
      o tenant de plataforma em vez de `tenantId` nullable, por que `isPlatform` é `Boolean?`,
      por que a criação de company exige um ADMIN, e o índice parcial com a nota de drift
- [ ] `documents/important/USERS.md` — `ADMIN_MASTER` na tabela de papéis, `/auth/register`
      removido das rotas e das públicas, `ASSIGNABLE_ROLES` documentado
- [ ] `documents/important/TENANCY_EXTENSION.md` — `runWithoutTenant()` deixa de ter "três usos,
      só o login"; a lista precisa incluir os da plataforma
- [ ] `CLAUDE.md` e `README.md`
- [ ] Commit + checkpoint

---

## Fase 7 — Spec de frontend

`documents/FRONTEND_PLATFORM_SPEC.md` — documento fechado, entregável a quem for escrever o
frontend sem abrir uma linha do backend. Payloads **capturados da aplicação rodando**, não
deduzidos dos DTOs.

- [ ] **Autenticação**: o par de tokens, `Authorization: Bearer`, rotação por `/auth/refresh`, e
      o ponto que muda a tela de login — `tenantDomain` é obrigatório, e o admin_master entra com
      o domínio reservado `platform`
- [ ] **Os dois papéis de tela**, e por que a UI ramifica: `ADMIN_MASTER` vê o console de
      plataforma e nunca `/users`; `ADMIN` vê `/users` da própria company e leva 403 em
      `/platform/**`. Papéis **não são hierárquicos** — pertinência numa lista, não ordenação
- [ ] **`/auth/register` não existe mais** — dito explicitamente, porque é a mudança que quebra
      um frontend já escrito
- [ ] Tabela de rotas no formato de `USERS.md`, e uma entrada por rota com request/response reais
- [ ] Formas nomeadas reaproveitadas de `USERS.md` (`UserResponse`, `AuthResult`, `{ data, meta }`),
      mais a nova `CompanyResponse`
- [ ] **Catálogo de erros** com o envelope exato (`message` string em erro de negócio, **array**
      em validação; 401 sem a chave `error`; 204 sem corpo) e as regras que a UI trata como
      estado, não como exceção:
  - [ ] **404, nunca 403, para recurso de outra company** — a UI não deve inferir "existe mas não
        posso" a partir de um 404
  - [ ] **403 é sempre papel insuficiente**, e só isso
  - [ ] **409 é pedido bem-formado recusado pelo estado** (email duplicado, último ADMIN ativo,
        usuário já desativado) — os que merecem mensagem específica na tela
  - [ ] **400 com `role: "ADMIN_MASTER"`** — o seletor de papel oferece só ADMIN/AGENT/REQUESTER
  - [ ] **`perPage` acima de 100 é 400**, não clamp silencioso
- [ ] **Fluxos completos**, na ordem em que uma tela os executa: login → criar company com seu
      primeiro ADMIN (um formulário só, porque o backend exige os dois juntos) → criar usuários →
      listar/filtrar/paginar → desativar e restaurar → apagar company (**cascade irreversível**,
      exige confirmação destrutiva explícita)
- [ ] Commit + checkpoint
