# Checklist — Feature `helpdesk`

Acompanhamento item a item da implementação, mantido durante toda a execução. É o registro do que
foi feito e do que continua pendente.

O [`PLANO_HELPDESK.md`](./PLANO_HELPDESK.md) aprovado é a origem deste arquivo; o conhecimento que
sobreviver à implementação — o que custou medição e seria caro redescobrir — vai para
[`important/HELPDESK.md`](../important/HELPDESK.md), não para cá.

Marcar cada item ao concluir. Cada fase termina com verificação, commit e checkpoint.

**Regra de execução:** implementar → rodar a verificação da fase e mostrar a saída real →
marcar aqui → commit → parar e perguntar antes da próxima fase.

## Decisões tomadas antes de começar

| Assunto      | Decisão                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| Escopo       | Tickets, comentários, auditoria, WebSocket e fila BullMQ (CSV). Sem S3/MinIO         |
| Numeração    | `number` sequencial por tenant, via `TicketCounter` e `updateManyAndReturn` atômico  |
| Visibilidade | `REQUESTER` só os próprios; `AGENT` e `ADMIN` todos do tenant; cross-scope é **404** |
| Exclusão     | Não existe `DELETE /tickets/:id` — `CLOSED` é terminal; comentários são append-only  |
| Entrega      | Quatro PRs: fases 0–2, 3–4, 5–6 e 7                                                  |

## Progresso por PR

| PR  | Branch                         | Fases | Estado         |
| --- | ------------------------------ | ----- | -------------- |
| 1   | `feat/helpdesk-tickets`        | 0–2   | 🚧 em execução |
| 2   | `feat/helpdesk-comments-audit` | 3–4   | ⏳ pendente    |
| 3   | `feat/helpdesk-async`          | 5–6   | ⏳ pendente    |
| 4   | `docs/helpdesk-reference`      | 7     | ⏳ pendente    |

---

## Fase 0 — Branch e documentos

- [x] Branch `feat/helpdesk-tickets` criada a partir de `development` (`development` e `main`
      recusam push direto, admin incluído)
- [x] `documents/MAIN.md` e `documents/MAIN_BACKEND.md` trazidos para a branch
- [x] Links quebrados do `MAIN.md` corrigidos: `./backend/README.md` →
      `./important/README.md`, `./backend/TENANCY_EXTENSION.md` e `./backend/RLS_NOTES.md` →
      `./important/`, e `./MAIN_FRONTEND.md` → `./helpdesk/GUIA_FRONTEND_HELPDESK.md`
- [x] `documents/helpdesk/README.md` — índice da pasta
- [x] `documents/helpdesk/PLANO_HELPDESK.md` — o plano aprovado
- [x] `documents/helpdesk/CHECKLIST_HELPDESK.md` — este arquivo
- [x] `documents/important/HELPDESK.md` — esqueleto com banner de status e a estrutura de duas partes
- [x] `documents/important/README.md` — linha do `HELPDESK.md` na tabela
- [x] `CLAUDE.md` — linha do `HELPDESK.md` na tabela de índice
- [x] `documents/helpdesk/GUIA_FRONTEND_HELPDESK.md` — esqueleto com banner de status

### Verificação

- [x] `npm run format:check` — o job `quality` roda Prettier sobre `documents/`
- [x] Todos os links relativos novos e corrigidos apontam para arquivos que existem

### Não estava no plano

- [x] `GUIA_FRONTEND_HELPDESK.md` criado já na Fase 0, e não só na Fase 7. O plano previa
      escrevê-lo no fim, mas três arquivos já apontam para ele — `MAIN.md`, o `README.md`
      desta pasta e o `PLANO_HELPDESK.md` — e um link que dá 404 no GitHub é exatamente a
      dívida que o commit `9871261` limpou. O esqueleto traz o índice e o banner dizendo que
      o conteúdo depende de payloads capturados da aplicação rodando
- [x] `CLAUDE.md` corrigido além da linha de índice: a frase de abertura ainda apontava o
      `MAIN.md` como especificação do projeto, o que deixou de ser verdade quando ele virou a visão
      de produto e o `MAIN_BACKEND.md` passou a ser a especificação. A tabela ganhou as linhas dos
      dois arquivos e a de `documents/helpdesk/`

---

## Fase 1 — Schema e migration

### Enums

- [x] `TicketPriority` — `LOW`, `MEDIUM`, `HIGH`, `URGENT`
- [x] `TicketCategory` — `HARDWARE`, `SOFTWARE`, `NETWORK`, `ACCESS`, `OTHER`
- [x] `ReportStatus` — `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`
- [x] `TicketStatus` confirmado **intocado** — acrescentar valor a enum existente não pode
      compartilhar migration com o uso do valor

### `Ticket`

- [x] `number Int` sequencial por tenant
- [x] `priority TicketPriority @default(MEDIUM)`
- [x] `category TicketCategory @default(OTHER)`
- [x] `resolvedAt DateTime?`, `closedAt DateTime?`
- [x] `closedById String? @db.Uuid` com FK composta `[tenantId, closedById]` → `users`, `Restrict`
- [x] `@@unique([tenantId, number])`
- [x] `@@index([tenantId, assigneeId])`, `@@index([tenantId, requesterId])`,
      `@@index([tenantId, createdAt])`

### `Comment`

- [x] `isInternal Boolean @default(false) @map("is_internal")`

### `TicketCounter`

- [x] Modelo criado com `tenantId` como PK, `lastNumber Int @default(0)` e relação `Cascade`
- [x] **Confirmado que `updateManyAndReturn` existe no Prisma 7.9.1 para PostgreSQL** — se não,
      cair no fallback `update({ where: { tenantId: requireTenantId() } })` e registrar o desvio
- [x] Linha criada na mesma transação que cria a empresa, em `src/platform/companies.service.ts`
- [x] Backfill na migration: `INSERT INTO ticket_counters (tenant_id, last_number) SELECT id, 0 FROM tenants;`
- [x] Desvio do checklist de `TENANCY_EXTENSION.md` (sem `@@unique([tenantId, id])`) anotado para a
      Parte II do `HELPDESK.md`

### `Report`

- [x] Modelo criado com `filters Json?`, `content String? @db.Text`, `rowCount`, `error`,
      `completedAt` e FK composta para `users` com `Restrict`
- [x] `@@unique([tenantId, id])` e `@@index([tenantId, requestedById])`

### `AuditLog`

- [x] `@@index([tenantId, createdAt])`

### Verificação

- [x] Uma única migration gerada (`20260829131500_helpdesk_domain`), aplicada e conferida com
      `npx prisma migrate status`
- [x] `npm run prisma:generate` e `npm run typecheck`
- [x] `npm run test:int` — suítes de tenancy existentes continuam verdes
- [x] `test/integration/ticket-numbering.int-spec.ts` — N creates concorrentes produzem N números
      distintos e sequenciais, sem buraco e sem repetição

### Não estava no plano

- [x] `test/integration/tenant-isolation.int-spec.ts` teve de ganhar `number` em seis
      fixtures de ticket. Metade delas usa `as Parameters<typeof prisma.ticket.create>[0]`,
      então o `typecheck` passou e a falta só apareceu como erro de runtime do Prisma —
      lembrete de que aquele cast desliga a checagem que teria pego isso na hora
- [x] O backfill cobre também o tenant reservado da plataforma, que nunca terá chamado. Uma
      linha inútil custa menos que um caso especial no código que lê o contador. Num banco
      novo ele simplesmente não ganha contador, e nada lê
- [x] A migration foi gerada com `prisma migrate diff --from-config-datasource --to-schema` e
      aplicada com `migrate deploy`, e não com `npm run prisma:migrate`: o `migrate dev` é
      interativo e aborta aqui com "non-interactive environment" ao pedir confirmação do aviso
      sobre a unique nova em `tickets`. O SQL é o mesmo; o backfill foi acrescentado à mão ao fim
      do arquivo, que é a única parte que o `diff` não teria como inferir

---

## Fase 2 — Módulo `tickets`

### Arquivos

- [ ] `src/tickets/tickets.module.ts`, `tickets.controller.ts`, `tickets.service.ts`
- [ ] `src/tickets/ticket-response.ts` — `TicketResponse` + `toTicketResponse()`, allowlist campo a
      campo, sem `tenantId`
- [ ] `src/tickets/ticket-visibility.ts` — `seesEveryTicket(role)`, no padrão de
      `administers-users.ts`
- [ ] `src/tickets/ticket-transitions.ts` — mapa de transições legais
- [ ] `src/tickets/dto/` — `create-ticket`, `update-ticket`, `change-status`, `assign-ticket`,
      `query-tickets`
- [ ] `TicketsModule` registrado em `src/app.module.ts` e exportando `TicketsService`

### Regras

- [ ] Nenhum filtro de tenant escrito à mão em nenhum arquivo do módulo
- [ ] `tenantScoped()` no create de topo
- [ ] Envelope `{ data, meta }` como `PaginatedTickets`, com `$transaction` em array para
      `count` + `findMany`, `orderBy` com desempate e `totalPages || 1`
- [ ] `load(id, requester)` privado, 404 para invisível e para outro tenant
- [ ] `ParseUUIDPipe` em todo path param
- [ ] `unassigned` com os três decorators (`@IsBoolean`, `@Transform`, `@Type(() => String)`)
- [ ] Transição ilegal responde `409`; `RESOLVED` carimba `resolvedAt`; `CLOSED` carimba `closedAt`
      e `closedById`
- [ ] OCC: `updateMany({ where: { id, version } })` com `version: { increment: 1 }`, e `count === 0`
      vira `409` com a version atual na mensagem

### Verificação

- [ ] `npm run test:unit` — `tickets.service.spec.ts` dentro de `runWithTenant` real, provando que o
      service não escreve filtro de tenant
- [ ] `npm run test:unit` — `query-tickets.dto.spec.ts` pelo `VALIDATION_PIPE_OPTIONS` real
- [ ] `test/integration/ticket-occ.int-spec.ts` — dois updates concorrentes na mesma version
      produzem exatamente um `409`
- [ ] `test/integration/tickets-tenancy.int-spec.ts` — id de outro tenant responde 404
- [ ] `test/e2e/tickets.e2e-spec.ts` — papéis, validação e visibilidade do requester
- [ ] `npm run typecheck` e `npx eslint "src/**/*.ts"` (read-only)

---

## Fase 3 — Comentários

- [ ] `src/comments/` com controller em `tickets/:ticketId/comments`
- [ ] `POST` → `201`; `isInternal: true` só de `ADMIN`/`AGENT`, senão `403`
- [ ] `GET` paginado; para `REQUESTER` o where ganha `isInternal: false` e o `total` também
- [ ] Ticket pai resolvido por `TicketsService.load()` antes de qualquer coisa
- [ ] `CommentsModule` importa `TicketsModule` e é registrado em `src/app.module.ts`

### Verificação

- [ ] `npm run test:unit` — spec do service
- [ ] `test/e2e/comments.e2e-spec.ts` — nota interna invisível para o requester, e 404 em ticket de
      outro tenant

---

## Fase 4 — Trilha de auditoria

- [ ] `src/audit/` — module, service, listener, events, controller, response
- [ ] `EventEmitterModule.forRoot()` em `src/app.module.ts`
- [ ] `TicketsService` e `CommentsService` **só emitem** — nenhuma chamada ao `AuditService`
- [ ] `tenantId` e `actorId` no payload do evento; o listener abre `runWithTenant` explicitamente
- [ ] **Medido** se o `AsyncLocalStorage` sobrevive ao `emit` síncrono, com o resultado anotado para
      a Parte II do `HELPDESK.md`
- [ ] Falha de auditoria logada em nível de erro, e a lacuna (escrita fora da transação) declarada
- [ ] `GET /tickets/:id/timeline` respeitando visibilidade
- [ ] `GET /audit` restrito a `ADMIN`, com filtros

### Verificação

- [ ] `test/integration/audit-trail.int-spec.ts` — linha em `audit_logs` com o `tenantId` certo,
      `oldValues`/`newValues` em JSONB, e nenhum vazamento entre tenants
- [ ] `npm run test:all`

---

## Fase 5 — Fila BullMQ e relatórios

- [ ] `src/reports/` — module, service, controller, processor, response, dto
- [ ] `BullModule.forRoot()` em `src/app.module.ts`
- [ ] `POST /reports/tickets` responde **`202`** com o `Report` em `PENDING`
- [ ] Worker abre `runWithTenant(job.data.tenantId, ...)` **antes de qualquer query**
- [ ] `GET /reports`, `GET /reports/:id`, `GET /reports/:id/download` (`text/csv`, `409` se não
      `COMPLETED`)
- [ ] `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` e `REPORTS_MAX_ROWS` em
      `src/config/env.validation.ts`
- [ ] `.env.example` e `.env.test` atualizados com `REPORTS_MAX_ROWS`
- [ ] `.github/workflows/ci.yml` — `REDIS_*` no passo de boot do job `docker`, senão a validação de
      ambiente derruba o container antes do `curl`

### Verificação

- [ ] `test/integration/reports-queue.int-spec.ts` — job enfileirado e processado contra o Redis de
      teste, CSV correto, e nenhum vazamento com dado de outro tenant presente
- [ ] `npm run test:all`

---

## Fase 6 — WebSocket

- [ ] `src/realtime/` — `notifications.gateway.ts` e `realtime.module.ts`
- [ ] Handshake valida o token de acesso; inválido leva a `disconnect()`
- [ ] Salas `user:<userId>` e `tenant:<tenantId>:staff` (só `ADMIN` e `AGENT`)
- [ ] `report.completed` / `report.failed` → `user:<id>`
- [ ] `ticket.created` / `ticket.updated` / `comment.created` → `tenant:<id>:staff` e
      `user:<requesterId>`
- [ ] O gateway consome os eventos do `EventEmitter2` — nenhum service conhece o gateway

### Verificação

- [ ] `test/e2e/realtime.e2e-spec.ts` com `socket.io-client` real: recebe o próprio evento, não
      recebe o de outro tenant, e um `REQUESTER` não recebe evento de chamado alheio
- [ ] `npm run test:all`

---

## Fase 7 — Documentação final

- [ ] `documents/important/HELPDESK.md` Parte I completa, com payloads **capturados da aplicação
      rodando**, não deduzidos dos tipos
- [ ] `documents/important/HELPDESK.md` Parte II com as medições da execução
- [ ] `documents/helpdesk/GUIA_FRONTEND_HELPDESK.md`
- [ ] `CLAUDE.md` — índice, parágrafo do catálogo, ponteiro no bloco de OCC, e correção da frase que
      afirma que nada disso foi escrito
- [ ] `README.md` da raiz — tabela de documentos e roadmap
- [ ] Este checklist fechado, com o commit de cada fase

### Verificação

- [ ] `npm run format:check`
- [ ] Links relativos conferidos um a um
- [ ] Percurso manual de ponta a ponta do `PLANO_HELPDESK.md` executado numa base limpa

---

## Não estava no plano

Itens que apareceram durante a execução e não estavam previstos. Cada um anotado com a razão de ter
surgido.

- _(vazio por enquanto)_
