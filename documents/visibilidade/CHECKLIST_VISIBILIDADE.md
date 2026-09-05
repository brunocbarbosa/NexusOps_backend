# Checklist — Visibilidade por atribuição

Acompanhamento item a item da implementação, mantido durante toda a execução. É o registro do que
foi feito e do que continua pendente.

O [`PLANO_VISIBILIDADE.md`](./PLANO_VISIBILIDADE.md) aprovado é a origem deste arquivo; o
conhecimento que sobreviver à implementação — o que custou medição e seria caro redescobrir — vai
para [`important/HELPDESK.md`](../important/HELPDESK.md), não para cá.

**Regra de execução:** implementar → rodar a verificação da fase e mostrar a saída real → marcar
aqui → commit → parar e perguntar antes da próxima fase.

## Decisões tomadas antes de começar

| Assunto        | Decisão                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| Visibilidade   | `ADMIN` vê tudo; todo o resto vê `requesterId = eu OR assigneeId = eu`; cross-scope é 404 |
| Não atribuídos | Só o `ADMIN` e o autor. Não existe fila aberta para agentes                               |
| Atribuição     | `PATCH /tickets/:id/assignee` só para `ADMIN` — nem para o agente se desatribuir          |
| Abertura       | `POST /tickets` só para `ADMIN` e `REQUESTER`. Um `AGENT` recebe 403                      |
| Escopo         | Um `OR` único para os quatro papéis, e não um ramo por papel                              |
| Composição     | Interseção em `AND`, não sobrescrita — um filtro só consegue estreitar                    |
| WebSocket      | `tenant:<id>:staff` vira `tenant:<id>:admins`; o agente é endereçado por `user:<id>`      |
| Migration      | Nenhuma — os dois índices que o `OR` usa já existem                                       |
| Entrega        | Um PR, `feat/ticket-visibility-by-assignee` → `development`                               |

## Progresso por fase

| Fase                           | Estado      | Commit |
| ------------------------------ | ----------- | ------ |
| 0 — Branch e documentos        | ⏳ em curso | —      |
| 1 — O escopo                   | ⏳ pendente | —      |
| 2 — Os guards                  | ⏳ pendente | —      |
| 3 — Eventos e WebSocket        | ⏳ pendente | —      |
| 4 — Documentação de referência | ⏳ pendente | —      |
| 5 — O plano de frontend        | ⏳ pendente | —      |

---

## Fase 0 — Branch e documentos

- [x] Branch `feat/ticket-visibility-by-assignee` criada a partir de `development` (`development` e
      `main` recusam push direto, admin incluído)
- [x] `documents/visibilidade/CHECKLIST_VISIBILIDADE.md` — este arquivo
- [x] `documents/visibilidade/PLANO_VISIBILIDADE.md` — o plano aprovado
- [x] `documents/visibilidade/README.md` — índice da pasta
- [x] `CLAUDE.md` — linha de `documents/visibilidade/` na tabela de índice

### Verificação

- [x] `npm run format:check` — o job `quality` roda Prettier sobre `documents/`
- [x] Todo link relativo novo aponta para arquivo que existe

### Não estava no plano

- [x] `PLANO_FRONTEND_VISIBILIDADE.md` criado já na Fase 0, como esqueleto, e não só na Fase 5. O
      plano previa escrevê-lo no fim, mas o `README.md` desta pasta já aponta para ele, e um link
      que dá 404 no GitHub é a mesma dívida que a Fase 0 do helpdesk teve de limpar. O esqueleto traz
      o índice do que vai entrar e o banner dizendo que o conteúdo depende da aplicação rodando
- [x] `documents/TESTE_MANUAL.md` **fica de fora deste commit**. Ele chegou de fora da branch, não
      passa em `npm run format:check` por questões anteriores a esta mudança (itálico com `*` e
      alinhamento de tabela), e a Fase 4 o edita de qualquer forma — é lá que ele entra, já limpo

---

## Fase 1 — O escopo

O coração da mudança, e a fase de maior raio: quase todo o custo de teste está aqui.

### `src/tickets/ticket-visibility.ts`

- [ ] `seesEveryTicket()` passa a ser `role === UserRole.ADMIN` — mesmo nome e mesma assinatura,
      porque a pergunta não mudou, só a resposta
- [ ] `ticketsInvolving(userId)` criado, devolvendo `{ OR: [{ requesterId }, { assigneeId }] }`
- [ ] Docblocks reescritos: por que o agente saiu, que o custo é declarado (ninguém além do `ADMIN`
      vê um chamado sem responsável, e é por isso que atribuir virou rota de admin), e que
      `ADMIN_MASTER` continua ausente pelo motivo de sempre

### `src/tickets/tickets.service.ts`

- [ ] `visibleTo()` devolve `{}` para o admin e `{ AND: [ticketsInvolving(id)] }` para o resto
- [ ] **Confirmado que `load()` não muda uma linha** — `{ id, ...visibleTo() }` vira
      `{ id, AND: [...] }`, e o chokepoint dos 404 não precisa ser editado
- [ ] Comentário do `findAll` (`:169`) reescrito: `AND` porque o `search` já ocupa a chave `OR`, e
      um segundo `OR` apagaria o primeiro **alargando** a página
- [ ] Docblock da classe (`:61-64`) reescrito — o truque de "espalhar por último" deixou de existir
- [ ] Docblock de `load()` (`:322-333`) — "outro requester" vira "quem não abriu nem está atendendo"

### `src/tickets/dto/query-tickets.dto.ts`

- [ ] Comentário do `requesterId` (`:72-74`) reescrito: interseção, não sobrescrita

### Testes

- [ ] `src/tickets/ticket-visibility.spec.ts` (novo) — `seesEveryTicket` sim para `ADMIN` e **não
      para `AGENT`**, que é a asserção que importa; `ticketsInvolving` com os dois braços
- [ ] `tickets.service.spec.ts` — fixture `admin` adicionada; `:176`, `:185` (vira dois testes),
      `:196` (interseção), `:207` (ator → admin) e `describe('assign')` (ator → admin)
- [ ] `tickets.service.spec.ts` — novo: o escopo **não apaga o `OR` do `search`**
- [ ] `test/integration/tickets-tenancy.int-spec.ts` — `:133` e `:150`; novos: o agente vê no
      instante em que é atribuído e some quando deixa de ser, e o chamado legado aberto pelo próprio
      agente continua visível a ele
- [ ] `test/integration/ticket-occ.int-spec.ts` — atribuir no `open()`; hoje quebra inteiro
- [ ] `test/integration/audit-trail.int-spec.ts` — atribuir no setup
- [ ] `test/integration/reports-queue.int-spec.ts` — `seed()` ganha um `ADMIN`, atores company-wide
      trocados; novo: o export do agente traz só os atribuídos
- [ ] `test/e2e/tickets.e2e-spec.ts` — `describe('visibility')` inteiro, helper `assign()` criado
- [ ] `test/e2e/comments.e2e-spec.ts` — atribuir onde `agentA` age; novo: 404 na thread e abertura
      no instante da atribuição
- [ ] `test/e2e/audit.e2e-spec.ts` — `:145`, `:175`, e `:192` ganha o agente não atribuído
- [ ] `test/e2e/reports.e2e-spec.ts` — atribuir no `beforeAll`

### Verificação

- [ ] `npm run test:all` verde
- [ ] `npm run typecheck` — os dois `tsconfig`
- [ ] `npx eslint "src/**/*.ts"` sem `--fix`

---

## Fase 2 — Os guards (regras A e C)

- [ ] `PATCH /tickets/:id/assignee` → `@Roles(UserRole.ADMIN)`, com o comentário dizendo que
      atribuir virou concessão de acesso e não passo de fluxo
- [ ] `POST /tickets` → `@Roles(UserRole.ADMIN, UserRole.REQUESTER)`, e o comentário "Any
      authenticated user opens a ticket" reescrito
- [ ] Docblock da classe do controller (`:23-34`) — a divisão agora é tripla
- [ ] `src/tickets/dto/create-ticket.dto.ts` — o docblock do "on behalf of"

### Testes

- [ ] 403 do agente em `POST /tickets`
- [ ] 403 do agente em `/assignee`, **inclusive tentando se desatribuir**
- [ ] 403 do `ADMIN_MASTER` em `POST /tickets` — **hoje é 500**, porque o tenant reservado não tem
      linha em `ticket_counters`; confirmar o 500 antes de mudar, para o teste registrar o ganho
- [ ] `describe('assignment')` do e2e: os quatro testes trocam o ator para `adminA`. Atenção à ordem
      guard-antes-de-pipe: como agente eles receberiam 403 e falhariam pelo motivo errado
- [ ] `unassigned=true` de um agente devolve só os dele — o comportamento documentado

### Verificação

- [ ] `npm run test:all`, `npm run typecheck`, eslint

---

## Fase 3 — Eventos e WebSocket

Os tipos primeiro: o campo obrigatório quebra o build em todo emissor, e é assim que o compilador
nomeia os três lugares.

- [ ] `TicketEvent` ganha `assigneeIds: string[]`, obrigatório, logo depois de `requesterId`
- [ ] `TicketsService.emit()` recebe um `Audience` e normaliza num lugar só (filtra nulos, deduplica)
- [ ] `mutate()` passa `before.assigneeId` e o assignee de depois — a reatribuição entrega as duas
      pessoas sem ramo por ação
- [ ] `create()` emite com lista vazia
- [ ] `CommentsService` preenche com o `ticket.assigneeId` que já tem em mãos
- [ ] `staffRoom()` → `adminRoom()`, string `tenant:<id>:admins`
- [ ] `joinsStaffRoom()` → `joinsAdminRoom()`, corpo `role === ADMIN`
- [ ] `handleConnection` e o docblock que fala em "staff room"
- [ ] Fan-out reescrito: uma lista de salas e **um** `.to([...]).emit()`, que deduplica quem está em
      duas salas — duas chamadas separadas não deduplicam
- [ ] O literal `'internal_note_added'` some em favor de `STAFF_ONLY_ACTIONS`, a mesma constante da
      timeline
- [ ] `src/comments/internal-notes.ts` — só o docblock: o corpo deixou de ser idêntico ao de
      `seesEveryTicket()`, que é exatamente o dia que aquele comentário antecipava

### Testes

- [ ] `src/realtime/rooms.spec.ts` (novo)
- [ ] `src/realtime/notifications.gateway.spec.ts` (novo) — a sala de admin sempre na lista, cada id
      de `assigneeIds` também, o requester exceto em nota interna, e nenhuma sala órfã
- [ ] `tickets.service.spec.ts` — `assigneeIds` com dois nomes na reatribuição, vazio, deduplicado
- [ ] `test/e2e/realtime.e2e-spec.ts` — `:211` conecta um `ADMIN`; `:243` e `:274` com atribuição
- [ ] Novo e o que mais importa: **o agente não atribuído não ouve nada** — a asserção negativa
- [ ] Novo: o agente atribuído passa a ouvir, e o agente que perdeu o chamado ouve o `assigned` que
      o tirou

### Verificação

- [ ] `npm run test:all`, `npm run typecheck`, eslint

---

## Fase 4 — Documentação de referência

- [ ] `CLAUDE.md` — "Real-time notifications" (`:360-369`), errado no nome da sala e na composição;
      e a linha final da seção de concorrência otimista, que fala em "staff room"
- [ ] `documents/important/HELPDESK.md` Parte I — tabela "Who sees which ticket", tabela de
      endpoints, tabela de query params (o que `unassigned` significa para um não-admin), a seção do
      socket, o catálogo de erros e **"Known gaps"**
- [ ] `HELPDESK.md` Parte II — quatro seções novas: por que A e B são a mesma regra; interseção no
      lugar da sobrescrita e o `OR` do `search` que a força; os três predicados que divergiram; e a
      reescrita de "The staff room is what keeps a requester out of another ticket's events"
- [ ] `documents/TESTE_MANUAL.md` — as subseções `ADMIN_MASTER`, `ADMIN`, `AGENT` (três afirmações
      falsas) e `REQUESTER`; o roteiro `### Visibilidade`, cujo passo "entre como agente: 200" vira
      404; e um passo no "Semear do zero" para haver o que testar
- [ ] `documents/helpdesk/GUIA_FRONTEND_HELPDESK.md` — o contrato novo inteiro
- [ ] `CHECKLIST_HELPDESK.md` e `PLANO_HELPDESK.md` recebem **nota datada**, não reescrita: são
      registro histórico da fase

### Verificação

- [ ] `npm run format:check`
- [ ] Nenhuma afirmação sobre visibilidade sobrou desatualizada — varrer `documents/` e `CLAUDE.md`
      atrás de "todos os chamados", "every ticket" e "staff"

---

## Fase 5 — O plano de frontend

- [ ] `documents/visibilidade/PLANO_FRONTEND_VISIBILIDADE.md` escrito **por último**, porque
      descreve o contrato já implementado e verificado
- [ ] `README.md` da pasta atualizado com a linha dele

### Verificação

- [ ] `npm run format:check`
- [ ] Os payloads e códigos citados batem com o que a aplicação rodando devolve, não com o que o
      plano supôs

---

## Fechamento

- [ ] `npm run test:all` e `npm run typecheck` numa árvore limpa
- [ ] Verificação de ponta a ponta do `PLANO_VISIBILIDADE.md` executada contra a aplicação rodando
- [ ] PR aberto para `development`
