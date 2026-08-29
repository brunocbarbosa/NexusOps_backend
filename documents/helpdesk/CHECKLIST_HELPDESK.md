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

| PR  | Branch                         | Fases | Estado       |
| --- | ------------------------------ | ----- | ------------ |
| 1   | `feat/helpdesk-tickets`        | 0–2   | ✅ concluída |
| 2   | `feat/helpdesk-comments-audit` | 3–4   | ✅ concluída |
| 3   | `feat/helpdesk-async`          | 5–6   | ⏳ pendente  |
| 4   | `docs/helpdesk-reference`      | 7     | ⏳ pendente  |

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

- [x] `src/tickets/tickets.module.ts`, `tickets.controller.ts`, `tickets.service.ts`
- [x] `src/tickets/ticket-response.ts` — `TicketResponse` + `toTicketResponse()`, allowlist campo a
      campo, sem `tenantId`
- [x] `src/tickets/ticket-visibility.ts` — `seesEveryTicket(role)`, no padrão de
      `administers-users.ts`
- [x] `src/tickets/ticket-transitions.ts` — mapa de transições legais
- [x] `src/tickets/dto/` — `create-ticket`, `update-ticket`, `change-status`, `assign-ticket`,
      `query-tickets`
- [x] `TicketsModule` registrado em `src/app.module.ts` e exportando `TicketsService`

### Regras

- [x] Nenhum filtro de tenant escrito à mão em nenhum arquivo do módulo
- [x] `tenantScoped()` no create de topo
- [x] Envelope `{ data, meta }` como `PaginatedTickets`, com `$transaction` em array para
      `count` + `findMany`, `orderBy` com desempate e `totalPages || 1`
- [x] `load(id, requester)` privado, 404 para invisível e para outro tenant
- [x] `ParseUUIDPipe` em todo path param
- [x] `unassigned` com os três decorators (`@IsBoolean`, `@Transform`, `@Type(() => String)`)
- [x] Transição ilegal responde `409`; `RESOLVED` carimba `resolvedAt`; `CLOSED` carimba `closedAt`
      e `closedById`
- [x] OCC: `updateMany({ where: { id, version } })` com `version: { increment: 1 }`, e `count === 0`
      vira `409` com a version atual na mensagem

### Verificação

- [x] `npm run test:unit` — `tickets.service.spec.ts` dentro de `runWithTenant` real, provando que o
      service não escreve filtro de tenant
- [x] `npm run test:unit` — `query-tickets.dto.spec.ts` pelo `VALIDATION_PIPE_OPTIONS` real
- [x] `test/integration/ticket-occ.int-spec.ts` — dois updates concorrentes na mesma version
      produzem exatamente um `409`
- [x] `test/integration/tickets-tenancy.int-spec.ts` — id de outro tenant responde 404
- [x] `test/e2e/tickets.e2e-spec.ts` — papéis, validação e visibilidade do requester
- [x] `npm run typecheck` e `npx eslint "src/**/*.ts"` (read-only)

### Não estava no plano

- [x] `ExtendedTransactionClient` acrescentado a `src/prisma/prisma.client.ts`. O `mutate()` é o
      chokepoint do OCC e precisa receber o `tx`, e `Prisma.TransactionClient` do client gerado é
      `Omit<DefaultPrismaClient, ...>` — o client **sem** a extension, ou seja, o tipo errado
- [x] O e2e pegou um bug que nenhum teste unitário meu pegava: fechar um chamado apagava o
      `resolvedAt`, porque eu havia escrito "limpa quando o destino não é RESOLVED" em vez de
      "limpa quando volta para OPEN". Corrigido, com um teste unitário novo travando a regra
- [x] Medido que um `include` aninhado faz o `@prisma/adapter-pg` rodar duas queries no mesmo
      client, o que o `pg` 8.23 deprecia e o `pg` 9 remove. Isolado por eliminação (com e sem
      `include`, dentro e fora de transação) e registrado na Parte II do `HELPDESK.md`: o `pg` não
      pode subir para 9 sem reavaliar isso

---

## Fase 3 — Comentários

- [x] `src/comments/` com controller em `tickets/:ticketId/comments`
- [x] `POST` → `201`; `isInternal: true` só de `ADMIN`/`AGENT`, senão `403`
- [x] `GET` paginado; para `REQUESTER` o where ganha `isInternal: false` e o `total` também
- [x] Ticket pai resolvido por `TicketsService.load()` antes de qualquer coisa
- [x] `CommentsModule` importa `TicketsModule` e é registrado em `src/app.module.ts`

### Verificação

- [x] `npm run test:unit` — spec do service
- [x] `test/e2e/comments.e2e-spec.ts` — nota interna invisível para o requester, e 404 em ticket de
      outro tenant

### Não estava no plano

- [x] `src/comments/dto/create-comment.dto.spec.ts` — o e2e provou que a armadilha do
      `enableImplicitConversion` **também vale para corpo JSON**, não só query string:
      `{"isInternal": "yes"}` virava `true` e chegava ao service como pedido real de nota interna.
      O comentário que eu tinha escrito no DTO afirmava exatamente o contrário. Corrigido com os
      três decorators e um spec com `type: 'body'`
- [x] **Bug encontrado em código já entregue:** `UpdateCompanyDto.isActive` tinha o mesmo defeito.
      `PATCH /platform/companies/:companyId` com `{"isActive": "false"}` **reativava** a empresa que
      o chamador pedia para suspender, respondia 200 e não deixava rastro. Provado com um spec que
      falhava antes da correção (`src/platform/dto/update-company.dto.spec.ts`) e corrigido aqui
- [x] `src/comments/internal-notes.ts` — predicado próprio em vez de reusar `seesEveryTicket()`.
      Os corpos são idênticos hoje, mas "vê todos os chamados" e "lê a nota que o cliente não deve
      ver" são perguntas diferentes, e responder a segunda chamando a primeira amarra as duas
- [x] Comentar num chamado `CLOSED` responde 409. Não estava especificado; segue a mesma regra de
      que um chamado fechado é registro — continua legível, não recebe escrita

---

## Fase 4 — Trilha de auditoria

- [x] `src/audit/` — module, service, listener, events, controller, response
- [x] `EventEmitterModule.forRoot()` em `src/app.module.ts`
- [x] `TicketsService` e `CommentsService` **só emitem** — nenhuma chamada ao `AuditService`
- [x] `tenantId` e `actorId` no payload do evento; o listener abre `runWithTenant` explicitamente
- [x] **Medido** se o `AsyncLocalStorage` sobrevive ao `emit` síncrono, com o resultado anotado para
      a Parte II do `HELPDESK.md`
- [x] Falha de auditoria logada em nível de erro, e a lacuna (escrita fora da transação) declarada
- [x] `GET /tickets/:id/timeline` respeitando visibilidade
- [x] `GET /audit` restrito a `ADMIN`, com filtros

### Verificação

- [x] `test/integration/audit-trail.int-spec.ts` — linha em `audit_logs` com o `tenantId` certo,
      `oldValues`/`newValues` em JSONB, e nenhum vazamento entre tenants
- [x] `npm run test:all`

### Não estava no plano

- [x] **A medição respondeu ao contrário do que o plano supunha.** O plano dizia que o `emit`
      síncrono "provavelmente" preserva o `AsyncLocalStorage`. Medido com um `EventEmitter2` puro:
      preserva sim, e também sobrevive a um listener assíncrono que dá `await` antes de ler o
      escopo. O listener continua abrindo o escopo pelo payload — o que foi medido é a estratégia
      de dispatch de uma dependência, não uma decisão deste repositório
- [x] `wildcard: true` no `EventEmitterModule.forRoot()` não é opcional e sua ausência é
      **silenciosa**: sem ele o `ticket.*` vira assinatura de um evento que ninguém emite, nenhum
      listener dispara e nada reclama — a trilha só fica sempre vazia. O
      `audit-trail.int-spec.ts` afirma `listeners('ticket.created').length === 1` por causa disso
- [x] Duas suítes de integração quebraram ao montar `TestingModule` só com `TicketsModule`: o
      service passou a injetar `EventEmitter2`, que só existe depois do `forRoot()`. Corrigido
      importando o módulo nas duas — a falha é o sinal honesto de que emitir agora faz parte do
      que uma mutação de ticket é
- [x] Comentário é registrado **contra o ticket**, não contra si mesmo, e nota interna ganhou ação
      própria (`internal_note_added`). Não estava especificado; é o que permite filtrar a timeline
      de um requester com comparação de coluna em vez de query em caminho JSONB
- [x] `Prisma.DbNull` em vez de `null` nas colunas JSONB — o Prisma recusa um `null` cru porque não
      distingue "valor JSON null" de "SQL NULL"

---

## Fase 5 — Fila BullMQ e relatórios

- [x] `src/reports/` — module, service, controller, processor, response, dto
- [x] `BullModule.forRoot()` em `src/app.module.ts`
- [x] `POST /reports/tickets` responde **`202`** com o `Report` em `PENDING`
- [x] Worker abre `runWithTenant(job.data.tenantId, ...)` **antes de qualquer query**
- [x] `GET /reports`, `GET /reports/:id`, `GET /reports/:id/download` (`text/csv`, `409` se não
      `COMPLETED`)
- [x] `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` e `REPORTS_MAX_ROWS` em
      `src/config/env.validation.ts`
- [x] `.env.example` e `.env.test` atualizados com `REPORTS_MAX_ROWS`
- [x] `.github/workflows/ci.yml` — `REDIS_*` no passo de boot do job `docker`, senão a validação de
      ambiente derruba o container antes do `curl`

### Verificação

- [x] `test/integration/reports-queue.int-spec.ts` — job enfileirado e processado contra o Redis de
      teste, CSV correto, e nenhum vazamento com dado de outro tenant presente
- [x] `npm run test:all`

### Não estava no plano

- [x] **Relatório é pessoal**, e isso virou propriedade de segurança e não simplificação: o CSV é
      montado pela visibilidade de quem pediu, então entregá-lo a outra pessoa daria linhas que as
      rotas de ticket recusariam a ela. Relatório de terceiro responde 404, na mesma empresa ou não
- [x] O worker pagina o `TicketsService.findAll` em vez de escrever query própria. Custa uma ida ao
      banco a cada 100 linhas e paga: a regra de visibilidade tem uma casa só, e uma segunda `where`
      no processor só apareceria errada dentro de um arquivo que alguém baixou
- [x] A linha do relatório é criada **antes** de enfileirar. A ordem inversa tem corrida: um job cujo
      registro ainda não existe falha na primeira instrução e o BullMQ o repete até desistir
- [x] Falha é gravada na linha **e** relançada. Só gravar deixaria o BullMQ achando que deu certo;
      só relançar deixaria o cliente esperando um `PROCESSING` eterno sem explicação
- [x] Toda célula do CSV é aspeada e célula iniciada por `=`, `+`, `-` ou `@` ganha aspa simples —
      planilha executa `=` como fórmula, então um título de chamado viraria injeção contra quem
      abre o arquivo. Não estava previsto no plano
- [x] `cell()` recebe união estreita em vez de `unknown`: o ESLint pegou que `String(objeto)` vira
      `"[object Object]"` sem reclamar
- [x] `env.validation.spec.ts` usava `REDIS_HOST` como exemplo de variável **não declarada** que
      sobrevive à validação. Agora ela é declarada, então o exemplo passou a ser `POSTGRES_USER`
- [x] Verificado localmente o que o job `docker` faz: `npm run build` e `node dist/main` com
      `NODE_ENV=production` e os valores do `.env.test`, respondendo `GET /` com o `BullModule`
      inicializado

---

## Fase 6 — WebSocket

- [x] `src/realtime/` — `notifications.gateway.ts` e `realtime.module.ts`
- [x] Handshake valida o token de acesso; inválido leva a `disconnect()`
- [x] Salas `user:<userId>` e `tenant:<tenantId>:staff` (só `ADMIN` e `AGENT`)
- [x] `report.completed` / `report.failed` → `user:<id>`
- [x] `ticket.created` / `ticket.updated` / `comment.created` → `tenant:<id>:staff` e
      `user:<requesterId>`
- [x] O gateway consome os eventos do `EventEmitter2` — nenhum service conhece o gateway

### Verificação

- [x] `test/e2e/realtime.e2e-spec.ts` com `socket.io-client` real: recebe o próprio evento, não
      recebe o de outro tenant, e um `REQUESTER` não recebe evento de chamado alheio
- [x] `npm run test:all`

### Não estava no plano

- [x] O contrato dos eventos saiu de `src/audit/audit.events.ts` para `src/events/ticket-events.ts`.
      Com dois consumidores, deixá-lo no módulo de auditoria faria `src/realtime/` importar de
      `src/audit/` — uma dependência que não existe: nenhum dos dois conhece o outro, os dois
      conhecem o contrato
- [x] `requesterId` acrescentado ao payload do evento. Sem ele o gateway teria de ler o banco a
      cada evento, num listener que não tem escopo de requisição para ler dentro
- [x] `JwtModule` passou a ser exportado pelo `AuthModule`. O handshake verifica o mesmo token de
      acesso do lado HTTP, e um segundo `JwtModule` no `RealtimeModule` seria um segundo lugar para
      manter segredo e expiração em sincronia
- [x] O worker de relatório passou a emitir `report.completed` / `report.failed`, **depois** de
      gravar a linha — assim um cliente acordado pelo socket lê o relatório já pronto em vez de
      correr com o update que o acordou
- [x] `socket.io-client` adicionado como devDependency; não havia cliente para testar o gateway
- [x] O `createTestApp` só chama `init()`, então a suíte de realtime precisa de `app.listen(0)` —
      é a única do tier que sobe servidor de verdade
- [x] **Investigado e não silenciado:** rodando sozinha, a suíte imprime o "Jest did not exit" do
      Jest. Dump de `process._getActiveHandles()` após o teardown deixa exatamente dois `Socket`
      sem endereço — `stdout` e `stderr`, que o Jest encana e que _são_ `net.Socket`. Não há nada
      a fechar, e o tier completo sai limpo

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
