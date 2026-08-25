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

- [x] `ADMIN_MASTER_EMAIL` (`@IsEmail()`) em `EnvironmentVariables`
- [x] `ADMIN_MASTER_PASSWORD` (`@IsString() @MinLength(8) @MaxBytes(BCRYPT_MAX_BYTES)`,
      reaproveitando `src/auth/password.constraints.ts`)
- [x] Recusa do placeholder em produção, no mesmo bloco que já recusa o `JWT_SECRET` de exemplo
- [x] `.env.example` atualizado
- [x] `.env.test` atualizado (e o `.env` local, que é gitignored, para o `start:dev` subir)
- [ ] (o passo de boot da CI é a Fase 5 — a quarta porta)

### O seeder

- [x] `src/platform/platform.constants.ts` — `PLATFORM_TENANT_DOMAIN = 'platform'`,
      `PLATFORM_TENANT_NAME`. Em código, não no `.env`: menos peças móveis
- [x] `src/platform/platform-bootstrap.service.ts` — `OnModuleInit`, idempotente, com o mesmo
      escopo que muda no meio (`runWithoutTenant` para o `Tenant`, `runWithTenant` para o `User`).
      **Sem transação única, ao contrário de `register`**, e de propósito: aqui uma aplicação
      parcial se cura no boot seguinte, enquanto em `register` ela deixaria um tenant sem
      ninguém que consiga entrar. Evita também segurar uma conexão durante um bcrypt
- [x] O `.env` é a fonte da verdade: senha e email rotacionados lá têm efeito, e um
      admin_master desativado volta (`deletedAt: null`).
      **Busca por `role`, não por email** — divergência deliberada do plano: com a chave no
      email, mudar `ADMIN_MASTER_EMAIL` tentaria criar um _segundo_ operador e morreria no
      índice único; por `role`, a mesma mudança renomeia o que existe.
      O hash só é reescrito quando a senha muda de fato — bcrypt saliza aleatoriamente, então
      hashear sempre reescreveria a linha a cada boot à toa
- [x] `PlatformModule` importa `AuthModule` (ordem de init: `HashingService.onModuleInit` precisa
      ter construído o decoy hash antes)
- [x] Registrado no `AppModule`

### Verificação

- [x] Login do admin_master funciona **sem nenhuma mudança em `src/auth/`**:
      `POST /auth/login { tenantDomain: "platform", … }` → 200 com `role: "ADMIN_MASTER"`;
      `GET /auth/me` → 200; senha errada → 401
- [x] Idempotência em boot limpo: segundo boot sem mudança no `.env` loga
      "already up to date" e não escreve
- [x] Rotação de **senha** pelo `.env`: senha antiga → 401, nova → 200
- [x] Rotação de **email** pelo `.env`: renomeia em vez de duplicar — email antigo → 401,
      novo → 200, e o banco segue com exatamente 1 `ADMIN_MASTER` e 1 platform tenant
- [x] `npm run typecheck` verde
- [x] `npm run test:all` verde — 112 unit, 50 integration, 52 e2e
- [x] `npx eslint` (read-only) e `npm run format:check` verdes
- [x] `env.validation.spec.ts` estendido: email malformado, senha curta, o placeholder de
      produção e a truncagem de 72 bytes do bcrypt
- [x] Commit + checkpoint

---

## Fase 3 — `src/platform/`, os dois CRUDs

### Companies

- [x] `src/platform/companies.service.ts` + `companies.controller.ts`, tudo sob
      `@Roles(UserRole.ADMIN_MASTER)`
- [x] `POST /platform/companies` → 201. **Exige o primeiro ADMIN no mesmo payload**
      (`{ name, domain, admin: { email, password } }`): uma company sem `ADMIN` é uma em que
      `assertNotLastAdmin` nunca pode ser satisfeito e na qual ninguém entra. É a transação de
      `AuthService.register` **movida**, não reescrita
- [x] `GET /platform/companies` → 200, paginado, `where: { isPlatform: null }`
- [x] `GET /platform/companies/:id` → 200
- [x] `PATCH /platform/companies/:id` → 200 (`name`, `domain`, `isActive`)
- [x] `DELETE /platform/companies/:id` → 204, hard delete (cascade)
- [x] `CreateCompanyDto` herda o regex de hostname de `RegisterDto` e recusa explicitamente o
      valor reservado `platform` com 400 (o `@unique` já daria 409, mas 400 é mais claro)

### Usuários de uma company

- [x] `src/platform/company-users.controller.ts` — casca fina: `runWithTenant(companyId, () => usersService.…)`
- [x] `POST /platform/companies/:id/users` → 201
- [x] `GET /platform/companies/:id/users` → 200, paginado
- [x] `GET /platform/companies/:id/users/:userId` → 200
- [x] `PATCH /platform/companies/:id/users/:userId` → 200
- [x] `DELETE /platform/companies/:id/users/:userId` → 204
- [x] `POST /platform/companies/:id/users/:userId/restore` → 200

### `loadCompany(id)` — o chokepoint das rotas aninhadas

- [x] Sob `runWithoutTenant()`, 404 se a company não existe — sem ele um UUID inexistente
      devolveria lista vazia em vez de 404, porque `runWithTenant` aceita qualquer string
- [x] 404 também se o id é o **tenant de plataforma** — sem isso,
      `/platform/companies/<platform-id>/users/<self>` deixaria o admin_master se apagar

### A mudança cirúrgica no `UsersService`

Dois pontos comparam com `UserRole.ADMIN` e recusariam o admin_master agindo dentro de uma company.

- [x] `administersUsers(role)` — predicado nomeado (`ADMIN || ADMIN_MASTER`), em vez de um
      `requester` sintético, que seria mentira
- [x] Aplicado no gate de `includeDeleted` em `findAll` (403)
- [x] Aplicado no gate de soft-deleted em `load()` (404)
- [x] `assertNotLastAdmin` **não muda**: conta `role: ADMIN` no escopo corrente, que é a company
      alvo — correto por construção
- [x] `RolesGuard` **não muda**: continua não-hierárquico (`includes()`, não ordenação)

### Verificação

- [x] `npm run typecheck` verde
- [x] `npm run test:all` verde — 112 unit, 50 integration, 52 e2e
- [x] `npx eslint` (read-only) e `npm run format:check` verdes

Exercitado contra o servidor rodando, com saída real:

- [x] `POST /platform/companies` → 201 com `{ company, admin }` nas duas metades
- [x] AGENT e REQUESTER criados dentro dela → 201; a listagem devolve os três papéis
- [x] `GET /platform/companies` → o platform tenant **não** aparece
- [x] ADMIN de uma company em `/platform/**` → **403** em GET, POST e nas rotas aninhadas
- [x] `/platform/companies/<platform-id>` em GET, `/users` e DELETE → **404** nos três
- [x] `domain: "platform"` → 400 `domain "platform" is reserved for the platform itself`
- [x] `role: "ADMIN_MASTER"` pela rota de plataforma → 400 `role must be one of the
following values: ADMIN, AGENT, REQUESTER`
- [x] UUID de company inexistente → **404**, não página vazia (é o `requireCompany`)
- [x] Desativar → 204; lista sem `includeDeleted` 2, com `includeDeleted` 3 (é a mudança
      do `administersUsers` — antes o ADMIN_MASTER levava 403 aqui); GET do desativado 200;
      restore 200
- [x] Usuário de outra company → **404** em GET e PATCH, nunca 403
- [x] `DELETE` de company → 204 e os 3 usuários somem junto (cascade)
- [x] Cascade **medido no banco** antes de escrever o delete: `audit_logs.user_id` e
      `tickets.assignee_id` são `ON DELETE RESTRICT`, e ainda assim o cascade a partir do
      `Tenant` passa — as linhas que referenciam o usuário são removidas pelo próprio
      cascade de tenant dentro da mesma instrução, então não sobra nada para restringir
- [x] Commit + checkpoint

---

## Fase 4 — Fechar `/auth/register`

- [x] Rota removida de `src/auth/auth.controller.ts`
- [x] `AuthService.register` removido (a transação já viveu para `CompaniesService.create`)
- [x] `src/auth/dto/register.dto.ts` removido
- [x] Rotas públicas passam a ser: `POST /auth/login`, `POST /auth/refresh`, `GET /`

### Os fixtures que isto quebra

- [x] `test/utils/platform-session.ts` — `loginAsAdminMaster(app)` (login real, credenciais de
      `.env.test`) e `createCompany(app, session, label)`
- [x] `test/e2e/users.e2e-spec.ts` — `newTenant()` migrado para o helper novo
- [x] `test/integration/users-tenancy.int-spec.ts` — `seed()` migrado
- [x] `test/integration/auth-registration.int-spec.ts` → `platform-companies.int-spec.ts`
- [x] `test/e2e/auth.e2e-spec.ts` atualizado

### Onde a cobertura foi parar

Os testes de validação que viviam em `POST /auth/register` não foram apagados: mudaram de dono
junto com a responsabilidade.

- [x] `src/platform/companies.service.spec.ts` — o `describe('register')` de
      `auth.service.spec.ts` reapontado para `CompaniesService.create` (hash antes da
      transação, 409 no domínio duplicado, erro de banco não traduzido), mais o escopo
      `unscoped` de toda query de company e os dois 404 do `requireCompany`
- [x] `test/e2e/platform.e2e-spec.ts` — criado já nesta fase, não na 6, para a cobertura não
      cair no intervalo: email malformado, senha curta, senha além dos 72 bytes do bcrypt,
      domínio que não é hostname, o domínio reservado, company sem admin, campo inesperado,
      403 do ADMIN de company e 401 sem token
- [x] `test/utils/platform-session.ts` — `loginAsAdminMaster`, `createCompany`,
      `newCompanySession` e `loginAs`. Tudo pelas rotas HTTP reais: nenhum token forjado,
      nenhum provider sobrescrito, nenhuma linha inserida por trás da aplicação. Logar como
      ADMIN_MASTER é, ele próprio, o teste de que o bootstrap rodou
- [x] Os tipos `UserBody` / `AuthBody` passaram a vir do helper em vez de serem redeclarados
      no spec — a forma que o fixture constrói e a que a asserção lê viraram uma declaração só

### Verificação

- [x] `npm run typecheck` verde
- [x] `npm run test:all` verde — 120 unit, 52 integration, 59 e2e (eram 112/50/52)
- [x] `npx eslint` (read-only) e `npm run format:check` verdes
- [x] `POST /auth/register` → **404**, e 404 também com um token de ADMIN_MASTER: a rota
      sumiu, não foi apenas trancada. Um frontend que ainda a chame precisa do "não existe"
      honesto, não de um 401 que se lê como "faça login primeiro"
- [x] Caso do domínio reservado **falsificado**: remover `@NotEquals` faz o teste e2e falhar;
      restaurar faz passar
- [x] Comentários que ficaram falsos corrigidos em `public.decorator.ts` ("só três rotas:
      register, login, refresh") e `tenant-context.interceptor.ts` (mesma lista)
- [x] Imports órfãos removidos de `auth.service.ts` e `auth.service.spec.ts`
      (`ConflictException`, `Prisma` — só o `register` os usava)
- [x] Commit + checkpoint

---

## Fase 5 — CI, e o boot que passa a tocar o banco

O passo "The image boots and answers HTTP" diz hoje, textualmente: _"The database does not need
to exist: Prisma connects on the first query, and none happens here."_ Um seeder em
`OnModuleInit` desfaz essa premissa — o container roda em bridge e `DATABASE_URL` aponta para
`localhost:5433`, que lá dentro é o próprio container.

- [x] `.github/workflows/ci.yml`, job `docker`: `-p 3000:3000` → `--network host` (o banco já
      existe, o passo anterior roda `npm run test:setup`; só não era alcançável)
- [x] `-e ADMIN_MASTER_EMAIL` e `-e ADMIN_MASTER_PASSWORD` acrescentados, do mesmo `.env.test`
- [x] Comentário do passo reescrito: ele deixa de ser "só um boot" e passa a exercitar o
      bootstrap contra um banco real — cobertura melhor, não pior
- [x] `npm run format:check` verde e o YAML parseia

O passo foi **reproduzido localmente**, não só editado. Imagem construída com `docker build`
e rodada exatamente como a CI a roda:

- [x] Com `--network host`: responde na 3000 e o log do próprio container mostra
      `Created the ADMIN_MASTER (admin-master@nexusops.test)` — provado contra uma tabela que
      tinha sido esvaziada segundos antes, não contra o log sozinho
- [x] **Contrafactual medido**: com o `-p 3000:3000` antigo, a aplicação não responde dentro
      dos 30s e o container morre. O passo da CI falharia — que é exatamente o motivo da
      mudança, e agora está demonstrado em vez de afirmado
- [x] A recusa do placeholder em produção verificada **dentro da imagem**, que carrega o
      próprio `NODE_ENV=production`:
      `Invalid environment (1 problem(s)): - ADMIN_MASTER_PASSWORD: still the .env.example
placeholder, which is public, and it guards the account that creates every company`
- [x] `npm run test:all` verde — 120 / 52 / 59
- [ ] Pipeline verde no PR (só verificável depois de abrir o PR)
- [x] Commit + checkpoint

**Um falso positivo que quase passou.** Na primeira tentativa o `curl` respondeu "OK após 1
tentativa" — mas era um dev server esquecido na porta 3000, não o container, que tinha morrido
com `EADDRINUSE`. A prova real não é o `curl`: é o log do container mais a linha reaparecendo
no banco.

---

## Fase 6 — Testes e documentação

### Unit

- [x] `platform-bootstrap.service.spec.ts` — mocks à mão dentro de `runWithTenant`/`runWithoutTenant`,
      no molde de `src/users/users.service.spec.ts`
- [x] DTOs novos passando pelo `VALIDATION_PIPE_OPTIONS` real, no molde de `query-users.dto.spec.ts`
- [x] **`role: 'ADMIN_MASTER'` recusado com 400** — o teste da barreira de escalação.
      Antecipado para a Fase 1: um guard que entra sem teste, junto com a superfície que ele
      protege, é o que regride primeiro. `src/users/dto/user-role.dto.spec.ts`

### Integration

Semear com o cliente **sem** extensão, como `tenant-isolation.int-spec.ts` faz — "um fixture
construído pela coisa sob teste não prova nada".

- [x] `platform-bootstrap.int-spec.ts` — idempotência em dois boots (converge, não acumula)
- [x] A senha do `.env` re-hasheada no segundo boot
- [x] Um segundo `ADMIN_MASTER` inserido pelo cliente cru viola o índice único
- [x] Um segundo tenant com `isPlatform: true` viola o `@unique`

### E2E

Números: **128 unit, 59 integration, 76 e2e** (eram 120/52/59 no fim da Fase 4).

- [x] `platform.e2e-spec.ts` — admin_master cria company, cria usuários de cada nível, lista,
      atualiza, desativa, restaura, apaga a company
- [x] Um `ADMIN` comum leva 403 em toda `/platform/**`
- [x] `/platform/companies/<platform-id>/users` dá 404
- [x] A company apagada some junto com seus usuários

### Documentação

- [x] `documents/important/PLATFORM.md` — novo, em duas partes no formato de `USERS.md`.
      Parte I: rotas, payloads reais capturados, catálogo de erros. Parte II, o medido: por que
      o tenant de plataforma em vez de `tenantId` nullable, por que `isPlatform` é `Boolean?`,
      por que a criação de company exige um ADMIN, e o índice parcial com a nota de drift
- [x] `documents/important/USERS.md` — `ADMIN_MASTER` na tabela de papéis, `/auth/register`
      removido das rotas e das públicas, `ASSIGNABLE_ROLES` documentado
- [x] `documents/important/TENANCY_EXTENSION.md` — `runWithoutTenant()` deixa de ter "três usos,
      só o login"; a lista precisa incluir os da plataforma
- [x] `CLAUDE.md` — `src/platform/` no "what this is", a seção nova do operador de plataforma com
      os três pontos load-bearing, `ADMIN_MASTER_*` na seção Environment, `--network host` na
      descrição do job `docker`, e a lista de rotas públicas corrigida
- [x] `README.md` — linha nova na tabela de status
- [x] `documents/important/README.md` — `PLATFORM.md` no índice
- [x] `documents/CHECKLIST_USERS_AUTH.md` — **nota de superação, sem reescrever o registro**: ele
      diz que `POST /auth/register` público cria o tenant, e isso era verdade naquela fase. Um
      checklist é registro de execução; reescrevê-lo apagaria o que de fato aconteceu
- [x] Todos os payloads da Parte I de `PLATFORM.md` **capturados da aplicação rodando**, não
      deduzidos dos DTOs — inclusive os corpos de erro exatos
- [x] `npm run format:check` verde e `npm run test:all` verde (128 / 59 / 76)
- [x] Commit + checkpoint

---

## Fase 7 — Spec de frontend

`documents/FRONTEND_PLATFORM_SPEC.md` — documento fechado, entregável a quem for escrever o
frontend sem abrir uma linha do backend. Payloads **capturados da aplicação rodando**, não
deduzidos dos DTOs.

- [x] **Autenticação**: o par de tokens, `Authorization: Bearer`, rotação por `/auth/refresh`, e
      o ponto que muda a tela de login — `tenantDomain` é obrigatório, e o admin_master entra com
      o domínio reservado `platform`
- [x] **Os dois papéis de tela**, e por que a UI ramifica: `ADMIN_MASTER` vê o console de
      plataforma e nunca `/users`; `ADMIN` vê `/users` da própria company e leva 403 em
      `/platform/**`. Papéis **não são hierárquicos** — pertinência numa lista, não ordenação
- [x] **`/auth/register` não existe mais** — dito explicitamente, porque é a mudança que quebra
      um frontend já escrito
- [x] Tabela de rotas no formato de `USERS.md`, e uma entrada por rota com request/response reais
- [x] Formas nomeadas reaproveitadas de `USERS.md` (`UserResponse`, `AuthResult`, `{ data, meta }`),
      mais a nova `CompanyResponse`
- [x] **Catálogo de erros** com o envelope exato (`message` string em erro de negócio, **array**
      em validação; 401 sem a chave `error`; 204 sem corpo) e as regras que a UI trata como
      estado, não como exceção:
  - [x] **404, nunca 403, para recurso de outra company** — a UI não deve inferir "existe mas não
        posso" a partir de um 404
  - [x] **403 é sempre papel insuficiente**, e só isso
  - [x] **409 é pedido bem-formado recusado pelo estado** (email duplicado, último ADMIN ativo,
        usuário já desativado) — os que merecem mensagem específica na tela
  - [x] **400 com `role: "ADMIN_MASTER"`** — o seletor de papel oferece só ADMIN/AGENT/REQUESTER
  - [x] **`perPage` acima de 100 é 400**, não clamp silencioso
- [x] **Fluxos completos**, na ordem em que uma tela os executa: login → criar company com seu
      primeiro ADMIN (um formulário só, porque o backend exige os dois juntos) → criar usuários →
      listar/filtrar/paginar → desativar e restaurar → apagar company (**cascade irreversível**,
      exige confirmação destrutiva explícita)
- [x] Commit + checkpoint

### Verificação

- [x] Todos os payloads capturados da aplicação rodando, **dos dois consoles** — não só do de
      plataforma. As strings de erro são as strings reais, não parafraseadas
- [x] Os 18 blocos ```json` do documento parseiam como JSON válido (checado programaticamente)
- [x] `npm run format:check`, `npm run typecheck`, `npx eslint` e `npm run test:all` verdes
      (128 / 59 / 76)

### O que a captura corrigiu, e eu teria escrito errado

- **`401` nem sempre vem sem a chave `error`.** O do guard vem (`{"message":"Unauthorized",
"statusCode":401}`); um `401` lançado de propósito — senha atual errada, refresh token inválido,
  credenciais inválidas — vem **com** `error`. Um frontend que use a presença de `error` para
  decidir "faça login de novo" erra. Está dito explicitamente na spec
- **A mensagem do último ADMIN tem o verbo parametrizado**: existe `cannot be deactivated` e
  `cannot be demoted`. A tabela lista as duas
- **`Validation failed (uuid is expected)` é uma string, não um array**, ao contrário dos outros
  400 de validação
- **O conflito de email desativado carrega o id do usuário** no texto, o que permite ao formulário
  de "criar usuário" virar um "restaurar este usuário" em vez de um beco sem saída
