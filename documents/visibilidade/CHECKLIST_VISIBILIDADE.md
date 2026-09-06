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

| Fase                           | Estado       | Commit    |
| ------------------------------ | ------------ | --------- |
| 0 — Branch e documentos        | ✅ concluída | `a389b2d` |
| 1 — O escopo                   | ✅ concluída | `77ff34b` |
| 2 — Os guards                  | ✅ concluída | `40b2b59` |
| 3 — Eventos e WebSocket        | ✅ concluída | `10ee60a` |
| 4 — Documentação de referência | ✅ concluída | —         |
| 5 — O plano de frontend        | ⏳ pendente  | —         |

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

- [x] `seesEveryTicket()` passa a ser `role === UserRole.ADMIN` — mesmo nome e mesma assinatura,
      porque a pergunta não mudou, só a resposta
- [x] `ticketsInvolving(userId)` criado, devolvendo `{ OR: [{ requesterId }, { assigneeId }] }`
- [x] Docblocks reescritos: por que o agente saiu, que o custo é declarado (ninguém além do `ADMIN`
      vê um chamado sem responsável, e é por isso que atribuir virou rota de admin), e que
      `ADMIN_MASTER` continua ausente pelo motivo de sempre

### `src/tickets/tickets.service.ts`

- [x] `visibleTo()` devolve `{}` para o admin e `{ AND: [ticketsInvolving(id)] }` para o resto
- [x] **Confirmado que `load()` não muda uma linha** — `{ id, ...visibleTo() }` vira
      `{ id, AND: [...] }`, e o chokepoint dos 404 não precisa ser editado
- [x] Comentário do `findAll` (`:169`) reescrito: `AND` porque o `search` já ocupa a chave `OR`, e
      um segundo `OR` apagaria o primeiro **alargando** a página
- [x] Docblock da classe (`:61-64`) reescrito — o truque de "espalhar por último" deixou de existir
- [x] Docblock de `load()` (`:322-333`) — "outro requester" vira "quem não abriu nem está atendendo"

### `src/tickets/dto/query-tickets.dto.ts`

- [x] Comentário do `requesterId` (`:72-74`) reescrito: interseção, não sobrescrita

### Testes

- [x] `src/tickets/ticket-visibility.spec.ts` (novo) — `seesEveryTicket` sim para `ADMIN` e **não
      para `AGENT`**, que é a asserção que importa; `ticketsInvolving` com os dois braços
- [x] `tickets.service.spec.ts` — fixture `admin` adicionada; `:176`, `:185` (vira dois testes),
      `:196` (interseção), `:207` (ator → admin) e `describe('assign')` (ator → admin)
- [x] `tickets.service.spec.ts` — novo: o escopo **não apaga o `OR` do `search`**
- [x] `test/integration/tickets-tenancy.int-spec.ts` — `:133` e `:150`; novos: o agente vê no
      instante em que é atribuído e some quando deixa de ser, e o chamado legado aberto pelo próprio
      agente continua visível a ele
- [x] `test/integration/ticket-occ.int-spec.ts` — atribuir no `open()`; hoje quebra inteiro
- [x] `test/integration/audit-trail.int-spec.ts` — atribuir no setup
- [x] `test/integration/reports-queue.int-spec.ts` — `seed()` ganha um `ADMIN`, atores company-wide
      trocados; novo: o export do agente traz só os atribuídos
- [x] `test/e2e/tickets.e2e-spec.ts` — `describe('visibility')` inteiro, helper `assign()` criado
- [x] `test/e2e/comments.e2e-spec.ts` — atribuir onde `agentA` age; novo: 404 na thread e abertura
      no instante da atribuição
- [x] `test/e2e/audit.e2e-spec.ts` — `:145`, `:175`, e `:192` ganha o agente não atribuído
- [x] `test/e2e/reports.e2e-spec.ts` — atribuir no `beforeAll`

### Não estava no plano

- [x] `test/e2e/reports.e2e-spec.ts` também quebrou, e o plano não o listava na Fase 1: seus
      relatórios são pedidos como agente esperando linhas. O `as()` daquele arquivo só tinha `get` e
      `post`, então ganhou `patch` para poder atribuir no `beforeAll`
- [x] `ticket-occ.int-spec.ts` tinha um `toThrow(/version 2/)` literal. Com o ticket já atribuído no
      setup ele nasce na versão 2, e a mensagem passou a dizer 3 — a asserção virou derivada de
      `ticket.version`, que é o que ela sempre quis dizer
- [x] As contagens da trilha subiram de 2/1 para 3/2 e de 2 para 3 e 4 entradas: atribuir escreve um
      `assigned` no trail. A diferença entre as duas visões continua sendo exatamente a nota interna

### Verificação

- [x] `npm run test:all` verde — 216 unit, 95 integração, 156 e2e
- [x] `npm run typecheck` — os dois `tsconfig`
- [x] `npx eslint "src/**/*.ts"` sem `--fix`

---

## Fase 2 — Os guards (regras A e C)

- [x] `PATCH /tickets/:id/assignee` → `@Roles(UserRole.ADMIN)`, com o comentário dizendo que
      atribuir virou concessão de acesso e não passo de fluxo
- [x] `POST /tickets` → `@Roles(UserRole.ADMIN, UserRole.REQUESTER)`, e o comentário "Any
      authenticated user opens a ticket" reescrito
- [x] Docblock da classe do controller (`:23-34`) — a divisão agora é tripla
- [x] `src/tickets/dto/create-ticket.dto.ts` — o docblock do "on behalf of"

### Testes

- [x] 403 do agente em `POST /tickets`
- [x] 403 do agente em `/assignee`, **inclusive tentando se desatribuir**
- [x] 403 do `ADMIN_MASTER` em `POST /tickets` — **hoje é 500**, porque o tenant reservado não tem
      linha em `ticket_counters`; confirmar o 500 antes de mudar, para o teste registrar o ganho
- [x] `describe('assignment')` do e2e: os quatro testes trocam o ator para `adminA`. Atenção à ordem
      guard-antes-de-pipe: como agente eles receberiam 403 e falhariam pelo motivo errado
- [x] `unassigned=true` de um agente devolve só os dele — o comportamento documentado

### Verificação

- [x] `npm run test:all` verde — 216 unit, 95 integração, 161 e2e
- [x] `npm run typecheck` e eslint sem `--fix`

### Medido antes de mudar

- [x] `POST /tickets` como `ADMIN_MASTER` respondia **500** de fato — confirmado rodando o teste
      novo contra o código antigo, que falhou com `expected 403 "Forbidden", got 500 "Internal
Server Error"`. O agente respondia **201**

---

## Fase 3 — Eventos e WebSocket

Os tipos primeiro: o campo obrigatório quebra o build em todo emissor, e é assim que o compilador
nomeia os três lugares.

- [x] `TicketEvent` ganha `assigneeIds: string[]`, obrigatório, logo depois de `requesterId`
- [x] `TicketsService.emit()` recebe um `Audience` e normaliza num lugar só (filtra nulos, deduplica)
- [x] `mutate()` passa `before.assigneeId` e o assignee de depois — a reatribuição entrega as duas
      pessoas sem ramo por ação
- [x] `create()` emite com lista vazia
- [x] `CommentsService` preenche com o `ticket.assigneeId` que já tem em mãos
- [x] `staffRoom()` → `adminRoom()`, string `tenant:<id>:admins`
- [x] `joinsStaffRoom()` → `joinsAdminRoom()`, corpo `role === ADMIN`
- [x] `handleConnection` e o docblock que fala em "staff room"
- [x] Fan-out reescrito: uma lista de salas e **um** `.to([...]).emit()`, que deduplica quem está em
      duas salas — duas chamadas separadas não deduplicam
- [x] O literal `'internal_note_added'` some em favor de `STAFF_ONLY_ACTIONS`, a mesma constante da
      timeline
- [x] `src/comments/internal-notes.ts` — só o docblock: o corpo deixou de ser idêntico ao de
      `seesEveryTicket()`, que é exatamente o dia que aquele comentário antecipava

### Testes

- [x] `src/realtime/rooms.spec.ts` (novo)
- [x] `src/realtime/notifications.gateway.spec.ts` (novo) — a sala de admin sempre na lista, cada id
      de `assigneeIds` também, o requester exceto em nota interna, e nenhuma sala órfã
- [x] `tickets.service.spec.ts` — `assigneeIds` com dois nomes na reatribuição, vazio, deduplicado
- [x] `test/e2e/realtime.e2e-spec.ts` — `:211` conecta um `ADMIN`; `:243` e `:274` com atribuição
- [x] Novo e o que mais importa: **o agente não atribuído não ouve nada** — a asserção negativa
- [x] Novo: o agente atribuído passa a ouvir, e o agente que perdeu o chamado ouve o `assigned` que
      o tirou

### Verificação

- [x] `npm run test:all` verde — 232 unit, 95 integração, 163 e2e
- [x] `npm run typecheck` e eslint sem `--fix`

### Não estava no plano

- [x] `src/realtime/` não tinha **nenhum** unitário: o gateway era coberto só pelo e2e. Agora tem
      dois arquivos, e é onde a fronteira de acesso do agente fica fixada mais barato
- [x] O `emit` único sobre a lista de salas corrigiu de passagem uma duplicata que já existia: quem
      era admin **e** requester do mesmo chamado recebia o evento duas vezes, porque a de-duplicação
      do socket.io vale dentro de uma chamada e não entre duas

---

## Fase 4 — Documentação de referência

- [x] `CLAUDE.md` — "Real-time notifications" (`:360-369`), errado no nome da sala e na composição;
      e a linha final da seção de concorrência otimista, que fala em "staff room"
- [x] `documents/important/HELPDESK.md` Parte I — tabela "Who sees which ticket", tabela de
      endpoints, tabela de query params (o que `unassigned` significa para um não-admin), a seção do
      socket, o catálogo de erros e **"Known gaps"**
- [x] `HELPDESK.md` Parte II — quatro seções novas: por que A e B são a mesma regra; interseção no
      lugar da sobrescrita e o `OR` do `search` que a força; os três predicados que divergiram; e a
      reescrita de "The staff room is what keeps a requester out of another ticket's events"
- [x] `documents/TESTE_MANUAL.md` — as subseções `ADMIN_MASTER`, `ADMIN`, `AGENT` (três afirmações
      falsas) e `REQUESTER`; o roteiro `### Visibilidade`, cujo passo "entre como agente: 200" vira
      404; e um passo no "Semear do zero" para haver o que testar
- [x] `documents/helpdesk/GUIA_FRONTEND_HELPDESK.md` — o contrato novo inteiro
- [x] `CHECKLIST_HELPDESK.md` e `PLANO_HELPDESK.md` recebem **nota datada**, não reescrita: são
      registro histórico da fase

### Não estava no plano

- [x] `CLAUDE.md` ganhou uma seção nova de arquitetura — **"Who sees which ticket"** — e não só a
      correção do parágrafo de realtime. A regra é a mais load-bearing da fatia e não estava
      declarada em lugar nenhum daquele arquivo
- [x] `TESTE_MANUAL.md`: as **três suposições em aberto** da §4 da spec foram respondidas, porque
      esta fase as mediu de passagem — os dois DTOs exigem `version`, e a tabela de transições é
      exaustiva por tipo em `ticket-transitions.ts`. Sobrou aberta só a do operador
- [x] `documents/TESTE_MANUAL.md` entrou na branch aqui, já passando no `format:check`

### Verificação

- [x] `npm run format:check`
- [x] Nenhuma afirmação sobre visibilidade sobrou desatualizada — varridos `documents/` e
      `CLAUDE.md` atrás de "todos os chamados", "every ticket", "staff" e `tenant:<id>:staff`. O que
      sobrou são as duas notas históricas do helpdesk e as frases da Parte II que falam no passado
- [x] Todo link relativo continua apontando para arquivo que existe

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
