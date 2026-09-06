# Feature `helpdesk` — plano de implementação

> **Plano aprovado.** O acompanhamento item a item vive em
> [`CHECKLIST_HELPDESK.md`](./CHECKLIST_HELPDESK.md); o conhecimento medido que sobreviver à
> implementação vai para [`important/HELPDESK.md`](../important/HELPDESK.md).
>
> | Fase                         | Estado       | Commit    |
> | ---------------------------- | ------------ | --------- |
> | 0 — Branch e documentos      | ✅ concluída | `c47c4f9` |
> | 1 — Schema e migration       | ✅ concluída | `548e5ce` |
> | 2 — Módulo `tickets`         | ✅ concluída | `1c1c2c1` |
> | 3 — Comentários              | ✅ concluída | `4c28670` |
> | 4 — Trilha de auditoria      | ✅ concluída | `8032196` |
> | 5 — Fila BullMQ e relatórios | ✅ concluída | `600810f` |
> | 6 — WebSocket                | ✅ concluída | `311ff9e` |
> | 7 — Documentação final       | ✅ concluída | —         |
>
> As seções das fases concluídas ganham uma nota **Como saiu** ao final, com os desvios em relação
> ao que estava planejado e os defeitos encontrados durante a execução.

> **Nota de 2026-09-05.** A visibilidade descrita aqui mudou depois desta fase: um `AGENT` deixou de
> ver todos os chamados da empresa e passou a ver os atribuídos a ele, atribuir virou rota exclusiva
> do `ADMIN`, e `POST /tickets` deixou de aceitar um agente. Este arquivo é o registro do que foi
> executado naquela fase e **não** foi reescrito — o estado corrente está em
> [`visibilidade/`](../visibilidade/) e em [`important/HELPDESK.md`](../important/HELPDESK.md).

## Context

O NexusOps tem hoje a fundação pronta — tenancy medido, autenticação, `users`, `platform` — e
**nenhum domínio de helpdesk escrito**. `prisma/schema.prisma` já traz `Ticket`, `Comment` e
`AuditLog` modelados, com as FKs compostas e a coluna `version` de OCC, e o `package.json` já traz
`bullmq`, `@nestjs/event-emitter`, `@nestjs/websockets`, `socket.io` e `ioredis` instalados. Nada
disso tem uma linha de código: o `CLAUDE.md` declara exatamente isso.

Esta feature é o que fecha os cinco pilares de senioridade do [`MAIN.md`](../MAIN.md):
multi-tenancy (já feito), **controle otimista de concorrência**, **trilha de auditoria reativa**,
**processamento assíncrono** e **notificações em tempo real**. Sem ela o projeto tem uma fundação
excelente e nenhum produto em cima dela.

O resultado esperado: um helpdesk completo — abrir, listar, atribuir, mudar status e comentar
chamados, com auditoria automática, exportação assíncrona de relatório e notificação por WebSocket —
construído inteiramente sobre os chokepoints que já existem, sem um único filtro de tenant escrito
à mão.

## Decisões tomadas antes de começar

| Assunto      | Decisão                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Escopo       | Completo, em fases: tickets, comentários, auditoria, WebSocket e fila BullMQ (CSV). Sem S3/MinIO                               |
| Modelo       | `priority`, `category`, `number` sequencial por tenant, `resolvedAt`/`closedAt`/`closedById`, `Comment.isInternal`. Sem anexos |
| Visibilidade | `REQUESTER` só os próprios chamados; `AGENT` e `ADMIN` todos do tenant; status, atribuição e notas internas só para staff      |
| Cross-scope  | Responde **404**, nunca 403 — um 403 confirmaria que o id existe em algum lugar                                                |
| Exclusão     | Não existe `DELETE /tickets/:id`. `CLOSED` é o estado terminal                                                                 |
| Comentários  | Append-only: sem `PATCH`, sem `DELETE`. A timeline é artefato de auditoria                                                     |
| Idioma       | Esta pasta em pt-BR; `important/HELPDESK.md` em inglês, como o resto daquela pasta                                             |
| Entrega      | Quatro PRs, não um: o gate do Sonar é sobre código novo, e um PR de oito fases é irrevisável                                   |

---

## Regra de execução — checkpoint por fase

**Ao final de cada fase: rodar a verificação da fase e mostrar a saída real → marcar os itens no
[`CHECKLIST_HELPDESK.md`](./CHECKLIST_HELPDESK.md) → commit → parar e perguntar antes da próxima.**
Nenhuma fase começa sem aprovação explícita da anterior, e nada é dado como verde sem a saída do
comando.

`development` e `main` recusam push direto, admin incluído. Cada grupo de fases vive numa branch de
feature e entra por pull request em `development`.

| PR  | Branch                         | Fases |
| --- | ------------------------------ | ----- |
| 1   | `feat/helpdesk-tickets`        | 0–2   |
| 2   | `feat/helpdesk-comments-audit` | 3–4   |
| 3   | `feat/helpdesk-async`          | 5–6   |
| 4   | `docs/helpdesk-reference`      | 7     |

---

## Fase 0 — Branch e documentos (PR 1)

Cria `feat/helpdesk-tickets` a partir de `development` e leva junto os dois arquivos de escopo que
já estavam na árvore de trabalho: o `MAIN.md` novo (visão geral do produto) e o `MAIN_BACKEND.md`
(o antigo `MAIN.md`, a especificação técnica do backend).

Os links do `MAIN.md` novo apontavam para uma árvore que não existe — `./backend/README.md`,
`./backend/TENANCY_EXTENSION.md`, `./backend/RLS_NOTES.md` e `./MAIN_FRONTEND.md`. Os três primeiros
passam a apontar para `./important/`, que é a pasta real; o quarto passa a apontar para o
[`GUIA_FRONTEND_HELPDESK.md`](./GUIA_FRONTEND_HELPDESK.md) desta pasta, escrito na Fase 7.

Cria também esta pasta (`README.md`, este plano e o checklist) e o esqueleto de
[`important/HELPDESK.md`](../important/HELPDESK.md), que cresce a cada PR e só fica completo na
Fase 7.

**Verificação:** `npm run format:check` — o job `quality` roda Prettier sobre `documents/`.

---

## Fase 1 — Schema e migration (PR 1)

Aqui está **todo o banco como vai ficar**. Nada é renomeado e nada é removido; tudo é aditivo.

### Enums novos

```prisma
enum TicketPriority { LOW  MEDIUM  HIGH  URGENT }
enum TicketCategory { HARDWARE  SOFTWARE  NETWORK  ACCESS  OTHER }
enum ReportStatus   { PENDING  PROCESSING  COMPLETED  FAILED }
```

`TicketStatus` fica **intocado** — `OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED` — e isso é
deliberado. `ALTER TYPE ... ADD VALUE` não pode ser usado na mesma transação que consome o valor
novo, a armadilha que [`PLATFORM.md`](../important/PLATFORM.md) já registra ("why the enum value and
its index cannot share a migration"). Criar um tipo novo não tem esse problema; acrescentar um valor
a um tipo existente tem. Quatro status bastam para o fluxo desenhado, então o custo é zero.

### `Ticket` — colunas novas

| Coluna       | Tipo               | Notas                                                      |
| ------------ | ------------------ | ---------------------------------------------------------- |
| `number`     | `Int`              | sequencial **por tenant** — é o "#142" que o usuário fala  |
| `priority`   | `TicketPriority`   | `@default(MEDIUM)`                                         |
| `category`   | `TicketCategory`   | `@default(OTHER)`                                          |
| `resolvedAt` | `DateTime?`        | carimbado na transição para `RESOLVED`                     |
| `closedAt`   | `DateTime?`        | carimbado na transição para `CLOSED`                       |
| `closedById` | `String? @db.Uuid` | FK composta `[tenantId, closedById]` → `users`, `Restrict` |

Índices novos: `@@unique([tenantId, number])`, `@@index([tenantId, assigneeId])`,
`@@index([tenantId, requesterId])` e `@@index([tenantId, createdAt])`. Os existentes
(`@@unique([tenantId, id])` e `@@index([tenantId, status])`) ficam como estão.

`closedBy` é `Restrict` e não `SetNull` pela mesma razão já documentada em `assignee`: não se anula
metade de uma chave composta enquanto `tenant_id` é `NOT NULL`.

### `Comment` — coluna nova

`isInternal Boolean @default(false) @map("is_internal")` — a nota que só `AGENT` e `ADMIN` enxergam.
Sem `updatedAt`, porque comentário é append-only.

### `TicketCounter` — modelo novo, o gerador do `number`

```prisma
model TicketCounter {
  tenantId   String @id @map("tenant_id") @db.Uuid
  lastNumber Int    @default(0) @map("last_number")
  tenant     Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("ticket_counters")
}
```

É o problema real desta fase: numeração sequencial **por tenant**, sem race. `SELECT MAX(number)+1`
é racy por construção. A forma correta, e que não escreve um filtro de tenant à mão:

```ts
const [counter] = await tx.ticketCounter.updateManyAndReturn({
  where: {}, // a extension injeta tenantId
  data: { lastNumber: { increment: 1 } },
});
```

`updateManyAndReturn` está em `UPDATE_OPERATIONS` da extension (`src/tenancy/tenant-extension.ts`),
o `increment` do Prisma vira `SET last_number = last_number + 1` — atômico sob row lock — e o lock
segura até o commit da `$transaction` interativa que cria o ticket, de modo que dois creates
concorrentes no mesmo tenant serializam. **Confirmar nesta fase que `updateManyAndReturn` existe no
Prisma 7.9.1 para PostgreSQL**; se não existir, o fallback é
`update({ where: { tenantId: requireTenantId() } })`, que funciona mas gasta a única exceção
tolerável à regra do filtro escrito à mão.

Duas consequências, e ambas vão para a Parte II do `HELPDESK.md`:

1. `TicketCounter` **não tem `@@unique([tenantId, id])`**, porque não tem `id` — `tenantId` é a
   chave primária. É um desvio consciente do item 2 do checklist de
   [`TENANCY_EXTENSION.md`](../important/TENANCY_EXTENSION.md), e funciona porque nenhuma operação
   sobre esse modelo usa `findUnique`.
2. A linha precisa existir antes do primeiro ticket. Ela é criada na **mesma transação que cria a
   empresa** (`src/platform/companies.service.ts`, no trecho que já troca de escopo no meio para
   criar o primeiro `ADMIN`), e a migration faz o backfill das empresas que já existem:
   `INSERT INTO ticket_counters (tenant_id, last_number) SELECT id, 0 FROM tenants;`

### `Report` — modelo novo, consumido na Fase 5

```prisma
model Report {
  id            String       @id @default(uuid()) @db.Uuid
  tenantId      String       @map("tenant_id") @db.Uuid
  requestedById String       @map("requested_by_id") @db.Uuid
  status        ReportStatus @default(PENDING)
  filters       Json?
  rowCount      Int?         @map("row_count")
  content       String?      @db.Text
  error         String?      @db.Text
  createdAt     DateTime     @default(now()) @map("created_at")
  completedAt   DateTime?    @map("completed_at")

  tenant      Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  requestedBy User   @relation(fields: [tenantId, requestedById], references: [tenantId, id], onDelete: Restrict)

  @@unique([tenantId, id])
  @@index([tenantId, requestedById])
  @@map("reports")
}
```

`filters` guarda o snapshot do `QueryTicketsDto` que originou o relatório, em JSONB. O CSV mora em
`TEXT` no PostgreSQL e não num bucket: é a decisão de escopo tomada com o usuário. O `MAIN.md`
prevê S3/MinIO, então isso é uma lacuna declarada no `HELPDESK.md`, com `REPORTS_MAX_ROWS` como
mitigação.

### `AuditLog`

Sem colunas novas — `entityType`, `entityId`, `action`, `oldValues` e `newValues` em JSONB já
servem. Ganha `@@index([tenantId, createdAt])` para o feed de `GET /audit`.

### O checklist de modelo tenant-scoped

`TicketCounter` e `Report` são tenant-scoped por omissão: a extension usa uma allowlist invertida
(`TENANT_AGNOSTIC = new Set(['Tenant'])`), então esquecer de registrar um modelo o deixa protegido,
não desprotegido. Nada muda em `src/tenancy/`. O que precisa existir é `tenantId`, a relação com
`onDelete: Cascade` e FKs compostas em toda relação filha — atendido acima.

**Verificação:** `npm run prisma:migrate` gerando uma migration, `npm run prisma:generate`,
`npm run typecheck`, `npm run test:int` com as suítes de tenancy existentes ainda verdes, e um
`test/integration/ticket-numbering.int-spec.ts` novo com N creates concorrentes provando N números
distintos e sequenciais.

---

## Fase 2 — Módulo `tickets` (PR 1)

Arquivos, seguindo exatamente a forma de `src/users/` — sem barrel `index.ts`, kebab-case, e um
comentário de bloco explicando o _porquê_ de cada export, que é o estilo da casa:

```
src/tickets/tickets.module.ts
src/tickets/tickets.controller.ts
src/tickets/tickets.service.ts
src/tickets/tickets.service.spec.ts
src/tickets/ticket-response.ts        -> type TicketResponse + toTicketResponse()
src/tickets/ticket-visibility.ts      -> seesEveryTicket(role), no padrão de administers-users.ts
src/tickets/ticket-transitions.ts     -> o mapa de transições legais de status
src/tickets/dto/create-ticket.dto.ts
src/tickets/dto/update-ticket.dto.ts
src/tickets/dto/change-status.dto.ts
src/tickets/dto/assign-ticket.dto.ts
src/tickets/dto/query-tickets.dto.ts
src/tickets/dto/query-tickets.dto.spec.ts
```

Reuso obrigatório, não reimplementação:

- `tenantScoped()` de `src/tenancy/tenant-scoped.ts` em todo create de topo.
- `toUserResponse` de `src/users/user-response.ts` embutido no `TicketResponse` para requester e
  assignee — o precedente já existe: `CompaniesService` importa dele.
- O envelope `{ data, meta }` re-declarado no arquivo do service como `PaginatedTickets`. Não existe
  genérico compartilhado, e `PaginatedUsers` e `PaginatedCompanies` fazem igual.
- `$transaction` em forma de array para `count` + `findMany` numa ida só, `orderBy` sempre com
  desempate (`[{ createdAt: 'desc' }, { id: 'desc' }]`) e `totalPages: Math.ceil(...) || 1`.
- Um `load(id, requester)` privado devolvendo a linha crua do Prisma e lançando
  `NotFoundException`, na forma de `UsersService.load`.
- `isUniqueViolation()` como função livre no rodapé do arquivo — o repositório duplica isso por
  módulo de propósito.
- `ParseUUIDPipe` em todo path param, e `@CurrentUser() requester: AuthenticatedUser` com
  `import type`.

### Endpoints

| Método  | Rota                    | Auth             | Sucesso | Propósito                                 |
| ------- | ----------------------- | ---------------- | ------- | ----------------------------------------- |
| `POST`  | `/tickets`              | autenticado      | `201`   | abre um chamado; o requester é quem chama |
| `GET`   | `/tickets`              | autenticado      | `200`   | lista paginada e filtrada                 |
| `GET`   | `/tickets/:id`          | autenticado      | `200`   | detalhe                                   |
| `PATCH` | `/tickets/:id`          | autenticado¹     | `200`   | título, descrição, prioridade, categoria  |
| `PATCH` | `/tickets/:id/status`   | `ADMIN`, `AGENT` | `200`   | transição de status                       |
| `PATCH` | `/tickets/:id/assignee` | `ADMIN`, `AGENT` | `200`   | atribui ou desatribui                     |

¹ Um `REQUESTER` só no próprio chamado, e só enquanto ele não estiver `CLOSED`.

Filtros de `GET /tickets`: `page`, `perPage`, `status`, `priority`, `category`, `assigneeId`,
`requesterId`, `unassigned` (boolean) e `search` sobre título e descrição, com `contains` e
`mode: 'insensitive'`.

**O boolean `unassigned` precisa dos três decorators** — `@IsBoolean()`,
`@Transform(asOptionalBoolean)` e `@Type(() => String)`. Sem o terceiro,
`enableImplicitConversion` faz `Boolean('false')` valer `true`, a armadilha já registrada na Parte II
de [`USERS.md`](../important/USERS.md). O `query-tickets.dto.spec.ts` roda pelo
`VALIDATION_PIPE_OPTIONS` real exportado de `src/app.setup.ts`, e não por opções próprias — um spec
com opções próprias não provaria nada sobre o pipe que a aplicação usa.

### Visibilidade

Um único ponto no service, aplicado tanto no `findMany` quanto no `load`:

```ts
const scope = seesEveryTicket(requester.role)
  ? {}
  : { requesterId: requester.id };
```

Chamado de outro requester responde **404**, nunca 403. Chamado de outro tenant responde 404
também, e esse vem de graça da extension.

### Controle otimista de concorrência — o ponto da fase

`PATCH /tickets/:id`, `/status` e `/assignee` exigem `version` no corpo. Dentro de uma
`$transaction` interativa:

```ts
const { count } = await tx.ticket.updateMany({
  where: { id, version: dto.version }, // tenantId injetado pela extension
  data: { ...changes, version: { increment: 1 } },
});
if (count === 0) {
  throw new ConflictException(
    `This ticket was changed by someone else (it is now at version ${current.version}). ` +
      'Reload it and reapply your change.',
  );
}
```

`updateMany` e não `update`: `{ id, version }` não é chave única, e `update` exige uma. O `load()`
roda antes, dentro da mesma transação, para que "não existe ou não vejo" (404) e "mudou debaixo de
mim" (409) sejam respostas diferentes — sem isso, as duas colapsariam numa só e o cliente não teria
como saber se vale a pena recarregar.

Transições legais, em `ticket-transitions.ts`: `OPEN → IN_PROGRESS | RESOLVED`,
`IN_PROGRESS → RESOLVED | OPEN`, `RESOLVED → CLOSED | OPEN` (reabertura) e `CLOSED → ∅`. Uma
transição ilegal é `409`. `RESOLVED` carimba `resolvedAt`; `CLOSED` carimba `closedAt` e
`closedById`.

**Verificação:** `npm run test:unit` com o spec do service usando Prisma mockado dentro de um
`runWithTenant('tenant-a', ...)` real, provando que o service **não escreve filtro de tenant
nenhum**; `test/integration/ticket-occ.int-spec.ts` com dois updates concorrentes na mesma version
resultando em exatamente um 409; `test/integration/tickets-tenancy.int-spec.ts` com id de outro
tenant respondendo 404; e `test/e2e/tickets.e2e-spec.ts` cobrindo papéis, validação e a visibilidade
do requester.

---

## Fase 3 — Comentários (PR 2)

`src/comments/`, com o controller montado em `@Controller('tickets/:ticketId/comments')`.

- `POST` responde `201`. `isInternal: true` só é aceito de `ADMIN` e `AGENT`; de um `REQUESTER` é
  `403`, porque aqui o recurso é visível e o que falta é permissão.
- `GET` responde `200` paginado. Para um `REQUESTER` o where ganha `isInternal: false`, de modo que
  a nota interna não aparece nem no `total` — vazar a contagem já entregaria que existe algo escondido.
- O ticket pai é resolvido primeiro pelo `TicketsService.load()`, então um ticket invisível responde
  `404` antes de qualquer coisa. É o padrão `inCompany()` de `company-users.controller.ts` aplicado
  a um recurso aninhado.
- `TicketsModule` exporta `TicketsService`; `CommentsModule` o importa.

**Verificação:** unit mais `test/e2e/comments.e2e-spec.ts`, provando que a nota interna some para o
requester e que comentar em ticket de outro tenant dá 404.

---

## Fase 4 — Trilha de auditoria (PR 2)

`src/audit/` — `audit.module.ts`, `audit.service.ts`, `audit.listener.ts`, `audit.events.ts`,
`audit.controller.ts` e `audit-response.ts`.

A regra do `CLAUDE.md` é dura: **a regra de negócio não chama o `AuditService`**. `TicketsService` e
`CommentsService` fazem `this.events.emit('ticket.updated', payload)` e nada mais. Esse
desacoplamento é o motivo do Observer existir aqui.

O ponto crítico é o contexto de tenant dentro do listener. O `emit` do `@nestjs/event-emitter` é
síncrono, então o `AsyncLocalStorage` provavelmente sobrevive — mas depender disso amarra a
auditoria à estratégia de dispatch do emitter, que é comportamento de dependência e não deste
repositório. O desenho é o mesmo que o `CLAUDE.md` prescreve para um worker de BullMQ: **`tenantId`
e `actorId` viajam no payload do evento** e o listener abre o escopo explicitamente.

```ts
@OnEvent('ticket.*')
async handle(event: AuditEvent) {
  await runWithTenant(event.tenantId, () => this.audit.record(event));
}
```

Medir nesta fase se o ALS de fato sobrevive ao `emit`, e registrar o resultado na Parte II do
`HELPDESK.md` — é exatamente o tipo de conhecimento que `documents/important/` existe para guardar.

Lacuna a declarar, não a esconder: o listener escreve **fora** da transação da mutação. Se o insert
de auditoria falhar, a mutação já commitou. A alternativa — mesma transação — reacoplaria o que o
Observer existe para desacoplar. Falha de auditoria é logada em nível de erro.

| Método | Rota                    | Auth        | Propósito                                      |
| ------ | ----------------------- | ----------- | ---------------------------------------------- |
| `GET`  | `/tickets/:id/timeline` | autenticado | histórico do chamado, respeitando visibilidade |
| `GET`  | `/audit`                | `ADMIN`     | feed do tenant, com filtros                    |

**Verificação:** `test/integration/audit-trail.int-spec.ts` — a mutação gera linha em `audit_logs`
com o `tenantId` certo e `oldValues`/`newValues` em JSONB, e o listener não vaza entre tenants.

---

## Fase 5 — Fila BullMQ e relatórios (PR 3)

`src/reports/` — `reports.module.ts`, `reports.service.ts`, `reports.controller.ts`,
`reports.processor.ts`, `report-response.ts` e `dto/`.

- `POST /reports/tickets` responde **`202 Accepted`** com o `Report` em `PENDING`. Nenhum CSV é
  gerado na requisição: é justamente o trabalho que travaria o event loop.
- O worker `@Processor('reports')` roda **sem requisição HTTP, com o ALS vazio**. `tenantId` e
  `requestedById` vão no payload do job, e o `process()` abre `runWithTenant(job.data.tenantId, ...)`
  antes de qualquer query. O `CLAUDE.md` chama esse ponto de "the single most likely place for a
  tenant leak"; é o que esta fase demonstra.
- `GET /reports`, `GET /reports/:id` e `GET /reports/:id/download` — este último em `text/csv`, e
  `409` enquanto o relatório não estiver `COMPLETED`.
- `src/config/env.validation.ts` ganha `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (opcional) e
  `REPORTS_MAX_ROWS`. Os três primeiros já existem em `.env.example` e `.env.test` mas não são
  validados hoje; o quarto é novo nos dois arquivos.

**Impacto em CI, e é fácil esquecer:** o job `docker` faz boot da imagem, e a partir daqui ela
conecta no Redis. O passo de boot já roda com `--network host` e o `npm run test:setup` já subiu o
`redis-test` na 6380, mas as variáveis `REDIS_*` precisam entrar na lista que o passo passa para o
container — senão a validação de ambiente derruba o processo antes do `curl`.

**Verificação:** `test/integration/reports-queue.int-spec.ts` — job enfileirado e processado contra
o Redis de teste, CSV com as linhas certas, e um job com o `tenantId` da empresa A rodando enquanto
existe dado da empresa B, provando que nada vaza.

---

## Fase 6 — WebSocket (PR 3)

`src/realtime/` — `notifications.gateway.ts` e `realtime.module.ts`.

- Handshake autenticado pelo mesmo `JWT_SECRET` de acesso, com o token em `handshake.auth.token`.
  Token inválido leva a `disconnect()`.
- Salas: `user:<userId>` para todo mundo, e `tenant:<tenantId>:staff` só para `ADMIN` e `AGENT`.
  **A sala de staff é o que impede um `REQUESTER` de receber evento de chamado alheio.** A regra de
  visibilidade da Fase 2 tem de valer aqui também, senão o WebSocket vira o furo que o HTTP fechou.
- Eventos: `report.completed` e `report.failed` vão para `user:<id>`; `ticket.created`,
  `ticket.updated` e `comment.created` vão para `tenant:<id>:staff` e para `user:<requesterId>`.
- O gateway ouve os mesmos eventos do `EventEmitter2` da Fase 4 — nem o `TicketsService` nem o
  processor conhecem o gateway.

**Verificação:** `test/e2e/realtime.e2e-spec.ts` com um cliente `socket.io-client` real: recebe o
próprio evento, não recebe o de outro tenant, e um `REQUESTER` não recebe evento de chamado que não
é dele.

---

## Fase 7 — Documentação final (PR 4)

- [`important/HELPDESK.md`](../important/HELPDESK.md) completo, em inglês, nas duas partes:
  - **Parte I, o contrato**: modelo de dados com uma tabela por tabela do banco, papéis e
    visibilidade, "endpoints at a glance", `TicketResponse`, `CommentResponse` e `ReportResponse`,
    um `###` por endpoint com payload real capturado da aplicação rodando, e o catálogo de erros no
    formato de `PLATFORM.md` — tabela `| Status | Meaning here |` seguida da corrida de blocos
    `json` depois de "Real bodies:".
  - **Parte II, comportamento medido**: a numeração por tenant e por que `updateManyAndReturn`; o
    `TicketCounter` sem `@@unique([tenantId, id])`; o que `updateMany` com `version` responde e por
    que `update` não serve; se o ALS sobrevive ao `emit` do event-emitter, com o número medido; a
    auditoria fora da transação; o worker sem contexto de requisição; e a sala de staff no WebSocket.
- [`GUIA_FRONTEND_HELPDESK.md`](./GUIA_FRONTEND_HELPDESK.md), em pt-BR: o plano para quem for
  escrever o Next.js — telas, máquina de estados do ticket, como tratar o `409` de OCC, o envelope
  `{ data, meta }` na TanStack Table, virtualização da lista com `@tanstack/react-virtual`, o fluxo
  `202 → WebSocket → download` e o handshake do socket. Aponta para a Parte I do `HELPDESK.md` como
  contrato, sem repetir payloads.
- `CLAUDE.md`: a linha do `HELPDESK.md` na tabela de índice, o parágrafo do catálogo em
  `documents/important/`, o ponteiro no fim do bloco **Optimistic concurrency control** da seção
  Architecture, e a correção da frase que hoje afirma que nada disso foi escrito.
- `README.md` da raiz: tabela de documentos e roadmap.
- `CHECKLIST_HELPDESK.md` fechado, com o commit de cada fase.

**Verificação:** `npm run format:check`, links relativos conferidos um a um, e a Parte I lida contra
a aplicação rodando — cada payload copiado de uma chamada real, não do tipo TypeScript.

---

## Verificação de ponta a ponta

Ao final, com `npm run infra:up` e `npm run start:dev`:

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test:setup && npm run test:all
```

E o percurso manual que exercita os cinco pilares de uma vez:

1. `POST /platform/companies` como `ADMIN_MASTER` cria a empresa, o primeiro `ADMIN` e o
   `TicketCounter`.
2. `POST /users` cria um `AGENT` e dois `REQUESTER`.
3. Login como o primeiro `REQUESTER`, `POST /tickets`, e o retorno traz `number: 1`. Repetindo,
   `number: 2`.
4. Login como `AGENT`: `GET /tickets` mostra os dois. A mesma chamada como o segundo `REQUESTER`
   mostra zero.
5. Dois `PATCH /tickets/:id/status` com a **mesma** `version`: o segundo devolve `409`.
6. `POST /tickets/:id/comments` com `isInternal: true` como `AGENT`; o `GET` como `REQUESTER` não vê.
7. `GET /tickets/:id/timeline` mostra as transições registradas, sem ninguém ter chamado o audit.
8. Com um cliente socket.io conectado, `POST /reports/tickets` devolve `202`, chega
   `report.completed`, e `GET /reports/:id/download` devolve o CSV.
9. Repetir de 3 a 8 numa segunda empresa e confirmar que nenhum id da primeira responde algo
   diferente de `404`.

## Arquivos que mudam fora dos módulos novos

- `prisma/schema.prisma` — Fase 1, uma migration.
- `src/app.module.ts` — registra os módulos novos no fim do array, mais `EventEmitterModule.forRoot()`
  e `BullModule.forRoot()`.
- `src/platform/companies.service.ts` — cria a linha de `TicketCounter` na transação da empresa.
- `src/config/env.validation.ts`, `.env.example` e `.env.test` — variáveis de Redis e de relatório.
- `.github/workflows/ci.yml` — `REDIS_*` no passo de boot do job `docker`.
- `documents/MAIN.md` — links corrigidos.
- `CLAUDE.md`, `README.md` e `documents/important/README.md` — ponteiros.
