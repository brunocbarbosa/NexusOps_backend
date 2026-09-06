# Visibilidade por atribuição — plano de implementação

> **Plano aprovado.** O acompanhamento item a item vive em
> [`CHECKLIST_VISIBILIDADE.md`](./CHECKLIST_VISIBILIDADE.md); o conhecimento medido que sobreviver à
> implementação vai para [`important/HELPDESK.md`](../important/HELPDESK.md).
>
> | Fase                           | Estado      | Commit |
> | ------------------------------ | ----------- | ------ |
> | 0 — Branch e documentos        | ⏳ em curso | —      |
> | 1 — O escopo                   | ⏳ pendente | —      |
> | 2 — Os guards                  | ⏳ pendente | —      |
> | 3 — Eventos e WebSocket        | ⏳ pendente | —      |
> | 4 — Documentação de referência | ⏳ pendente | —      |
> | 5 — O plano de frontend        | ⏳ pendente | —      |

## Contexto

O helpdesk tem hoje dois papéis de staff que enxergam exatamente a mesma coisa: `seesEveryTicket()`
(`src/tickets/ticket-visibility.ts:21`) responde sim para `ADMIN` e para `AGENT`, e a única
distinção entre eles está fora dos chamados — contas e auditoria da empresa. Na prática, um agente
de uma empresa de duzentos chamados abre a lista e vê os duzentos.

Isto muda o eixo da separação: **atribuir passa a ser trabalho de administrador, e ver passa a
depender de estar atribuído**. Três regras:

- **A.** `PATCH /tickets/:id/assignee` vira `@Roles(ADMIN)`. Um agente não atribui, não reatribui e
  não devolve o que é dele.
- **B.** Um chamado é visível para os `ADMIN` da empresa, para o `REQUESTER` que o abriu e para o
  `AGENT` a quem foi atribuído. Mais ninguém. Um chamado sem responsável é visto apenas pelos
  administradores e pelo autor — não existe fila aberta para os agentes.
- **C.** `POST /tickets` vira `@Roles(ADMIN, REQUESTER)`. Um agente não abre chamado; ele trabalha
  o que lhe atribuem.

A e B não são duas restrições, são uma só: um agente que não enxerga um chamado sem responsável
também não consegue atribuí-lo a si — o `load()` dentro de `mutate()` responde 404 antes de tudo —
então B já torna A a única leitura coerente.

O resultado é uma fatia em que o agente tem uma caixa de entrada pessoal em vez de um painel da
empresa, e o administrador é quem distribui o trabalho.

**Uma consequência de C que fica registrada de saída:** o `HELPDESK.md` já lista como lacuna
conhecida que "um chamado não pode ser aberto em nome de outra pessoa — um agente atendendo um
telefonema tem de abri-lo como ele mesmo". Com C ele não abre de jeito nenhum: quem abre é um
`ADMIN`, e aí o requester do chamado é o admin, não a pessoa com o problema. É decisão de produto
tomada com os olhos abertos, e entra em "Known gaps" em vez de virar surpresa depois.

## A regra, em uma linha

```
ADMIN      -> todos os chamados da empresa
não-ADMIN  -> requesterId = eu  OU  assigneeId = eu
```

Um `OR` único para os quatro papéis, e não um ramo por papel: chamados abertos por agentes sob a
regra antiga já existem em qualquer banco de desenvolvimento e não podem ficar invisíveis para o
próprio autor; um `ADMIN` que abre um chamado é o requester dele; e um `REQUESTER` nunca é assignee
(`assertAssignable` responde 409 para esse papel, `src/tickets/tickets.service.ts:491`), então o
segundo braço é inerte para ele. Se um dia o corte estrito for desejado, a edição inteira cabe
dentro de `ticketsInvolving()` e nada mais no código se mexe.

`ADMIN_MASTER` continua caindo no ramo do `OR` e vendo lista vazia — o tenant reservado não tem
chamados, que é a resposta certa e a de hoje.

## Decisões tomadas antes de começar

| Assunto        | Decisão                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| Visibilidade   | `ADMIN` vê tudo; todo o resto vê `requesterId = eu OR assigneeId = eu`; cross-scope é 404 |
| Não atribuídos | Só o `ADMIN` e o autor. Não existe fila aberta para agentes                               |
| Atribuição     | Só `ADMIN` — nem para o agente se desatribuir                                             |
| Abertura       | Só `ADMIN` e `REQUESTER`. Um `AGENT` recebe 403                                           |
| Escopo         | Um `OR` único para os quatro papéis                                                       |
| Composição     | Interseção em `AND`, não sobrescrita — um filtro só consegue estreitar                    |
| WebSocket      | `tenant:<id>:staff` vira `tenant:<id>:admins`; o agente é endereçado por `user:<id>`      |
| Migration      | Nenhuma — os dois índices que o `OR` usa já existem                                       |
| Idioma         | Esta pasta em pt-BR; `important/HELPDESK.md` em inglês, como o resto daquela pasta        |
| Entrega        | Um PR, `feat/ticket-visibility-by-assignee` → `development`                               |

## Regra de execução — checkpoint por fase

Cada fase termina com verificação, commit e parada: rodar a verificação da fase, mostrar a saída
real, marcar no [checklist](./CHECKLIST_VISIBILIDADE.md), commitar e **perguntar antes de seguir**.

---

## Fase 0 — Branch e documentos

Branch `feat/ticket-visibility-by-assignee`, a partir de `development` — as duas branches longas
recusam push direto, admin incluído.

Cria `documents/visibilidade/` na mesma divisão que `documents/helpdesk/` declara: processo aqui,
conhecimento medido em `documents/important/`. O checklist sai primeiro e é mantido durante toda a
execução; este plano é a origem dele.

## Fase 1 — O escopo

### Os predicados — `src/tickets/ticket-visibility.ts`

`seesEveryTicket()` mantém nome e assinatura (a pergunta não mudou, a resposta sim) e passa a ser
`role === UserRole.ADMIN`. Ganha um companheiro, porque a pergunta deixou de ser respondível só pelo
papel — agora ela precisa da linha:

```ts
export function ticketsInvolving(userId: string): Prisma.TicketWhereInput {
  return { OR: [{ requesterId: userId }, { assigneeId: userId }] };
}
```

Os docblocks dizem o porquê, no estilo do repositório: que um helpdesk em que todo agente lê todo
chamado transforma "quem está atendendo" em rótulo em vez de fronteira; que o custo é declarado e
não escondido — ninguém além do `ADMIN` vê um chamado sem responsável, e é por isso que atribuir
virou rota de admin; e que `ADMIN_MASTER` continua ausente pelo motivo de sempre.

### A composição do `where` — `src/tickets/tickets.service.ts`

O mecanismo atual é "espalhar a visibilidade por último, para sobrescrever a chave do chamador"
(`:170`). Ele não sobrevive a um escopo em `OR`, por duas razões independentes:

- não há chave única a sobrescrever;
- `findAll` **já usa a chave `OR`** para o `search` (`:161-168`); um segundo `OR` no mesmo objeto
  apagaria o primeiro em silêncio e **alargaria** a página em vez de estreitá-la.

`visibleTo()` passa a contribuir com um `AND` — chave que nenhum filtro do chamador escreve, então o
escopo só consegue remover linhas:

```ts
private visibleTo(requester: AuthenticatedUser): Prisma.TicketWhereInput {
  return seesEveryTicket(requester.role)
    ? {}
    : { AND: [ticketsInvolving(requester.id)] };
}
```

**`load()` não muda uma linha** (`:348-351`): `{ id, ...visibleTo(requester) }` vira
`{ id, AND: [{ OR: [...] }] }`, que é exatamente o certo. É o ganho de chavear em `AND` — o
chokepoint que produz todos os 404 da fatia não precisa ser editado e, portanto, não pode ser
editado errado. Como `requireTicket()` e `mutate()` passam por ele, comentários, timeline,
relatórios e as três mutações herdam a regra nova de graça, e um chamado invisível continua 404 e
nunca 409.

### A decisão observável: interseção, não sobrescrita

Um `REQUESTER` que mande `?requesterId=<outro>` hoje recebe os próprios chamados; passa a receber
lista vazia. Preservar o comportamento antigo exigiria _apagar_ três parâmetros do chamador antes de
compor — uma lista que alguém tem de lembrar de manter quando um filtro novo entrar. Interseção é
monotônica: um filtro só consegue remover linhas, nunca alargar a resposta para algo diferente do
que o cliente pediu. E dá ao agente filtros que passam a ser úteis: `?requesterId=<pessoa>` vira "os
chamados atribuídos a mim que essa pessoa abriu".

O teste que cobre o comportamento antigo (`test/e2e/tickets.e2e-spec.ts:226`) hoje passa **vazio**
(`[].every()` é `true`), então precisa ser reescrito de qualquer forma.

**`unassigned=true` de um não-admin** vira `assigneeId: null AND (requesterId = eu OR assigneeId =
eu)` — o segundo braço é insatisfazível, então sobra "os meus que ninguém pegou". Resposta certa,
sem caso especial, e que precisa estar escrita na Parte I do `HELPDESK.md`, ou um cliente vai achar
que o filtro está quebrado para agentes. O 400 de `unassigned` + `assigneeId` (`:144-148`) fica onde
está: é sobre a query do chamador, não sobre o escopo, e vazio e 400 são respostas diferentes.

## Fase 2 — Os guards (regras A e C)

`src/tickets/tickets.controller.ts`:

| Rota                          | Hoje           | Fica                                                                                |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `POST /tickets`               | nenhum         | `@Roles(ADMIN, REQUESTER)`                                                          |
| `PATCH /tickets/:id/assignee` | `ADMIN, AGENT` | `@Roles(ADMIN)`                                                                     |
| `PATCH /tickets/:id/status`   | `ADMIN, AGENT` | inalterada — o guard diz "esse papel, alguma vez"; o `load()` diz "em quais linhas" |
| `GET`, `GET /:id`, `PATCH`    | nenhum         | inalteradas — quem decide é o serviço                                               |

Dois comentários ficam falsos e são reescritos junto: o docblock da classe (`:23-34`, "status and
assignment belong to staff" — a divisão agora é tripla) e o de `POST` (`:39-42`, "Any authenticated
user opens a ticket; that is the whole point of a helpdesk").

**Um bug corrigido de brinde:** o tenant da plataforma não recebe linha em `ticket_counters` —
`CompaniesService.create` cria uma por company (`src/platform/companies.service.ts:80`), o bootstrap
do operador não. Hoje `POST /tickets` como `ADMIN_MASTER` chega ao `tickets.service.ts:101` e estoura
um `Error` puro: **500**. Com C ele vira 403 no guard, antes do serviço. Merece teste próprio, e
convém confirmar o 500 antes de mudar para o teste registrar o ganho.

`assertAssignable()` (`:479-497`) não muda — 404 para usuário inexistente ou de outro tenant, 409
para um `REQUESTER` como destino. Ele passa a ter uma segunda função: é o que garante que um
`REQUESTER` nunca entre na lista de destinatários do socket.

## Fase 3 — Eventos e WebSocket

É a parte que **nenhum teste HTTP pegaria**: a sala `tenant:<id>:staff` entrega hoje todo evento da
empresa a todo agente, e sem mudança ela entregaria justamente os chamados que a API passou a
esconder.

- `src/realtime/rooms.ts`: `staffRoom()` → `adminRoom(tenantId)` → `tenant:<id>:admins`;
  `joinsStaffRoom()` → `joinsAdminRoom(role)` → `role === ADMIN`. Renomear a string é seguro: o
  gateway só empurra e não aceita comando nenhum, então nenhum cliente nomeia sala. Uma sala ainda
  chamada `staff` sem agentes dentro seria lida como bug e "consertada" depois.
- `src/events/ticket-events.ts`: `TicketEvent` ganha `assigneeIds: string[]`, **obrigatório** e logo
  depois de `requesterId`. Plural porque uma reatribuição diz respeito a duas pessoas — a que
  recebeu e a que perdeu — e vazio enquanto ninguém é responsável. Obrigatório porque um campo
  opcional é um campo que um emissor esquece sem quebrar teste nenhum, e o sintoma seria uma tela de
  agente que nunca se mexe.
- `TicketsService.emit()` (`:427-448`) passa a receber um `Audience { requesterId, assignees }` e a
  normalizar num só lugar: filtra os nulos e deduplica. `mutate()` já tem `before` e `after` em
  mãos, então a reatribuição entrega as duas pessoas **de graça**, sem ramo por ação; `create()`
  emite com lista vazia; `CommentsService` (`:95-105`) preenche com o `ticket.assigneeId` que já tem.
- O fan-out (`notifications.gateway.ts:105-122`) monta a lista de salas e emite **uma vez**:
  `.to([...])` deduplica quem está em duas salas, coisa que duas chamadas separadas não fazem — o
  que corrige de passagem uma duplicata que já existe hoje. E a exclusão do requester passa a usar
  `STAFF_ONLY_ACTIONS` em vez do literal `'internal_note_added'`, a mesma constante que
  `AuditService.timeline()` usa, para o socket e a timeline não conseguirem discordar sobre o que o
  cliente pode saber.

Quem passa a ouvir o quê:

| Evento                | ADMIN | AGENT atribuído | AGENT anterior              | REQUESTER autor | resto |
| --------------------- | ----- | --------------- | --------------------------- | --------------- | ----- |
| `ticket.*`            | sim   | sim             | só o `assigned` que o tirou | sim             | nada  |
| `internal_note_added` | sim   | sim             | —                           | **não**         | nada  |

O evento para o agente anterior é a exceção deliberada: ele descreve um chamado que o agente já não
lê por HTTP, e existe justamente para a fila dele soltar a linha.

### O que não muda

`src/comments/internal-notes.ts` continua `ADMIN || AGENT` — a pergunta dele é "quem lê a nota que o
cliente não deve ver", e a resposta continua sendo os dois; qual chamado ele alcança já é decidido
pelo 404 de `requireTicket()`. **Mas a primeira frase do docblock fica falsa** ("Its body is
identical to `seesEveryTicket()`"), e uma afirmação obsoleta no único comentário que justifica a
duplicação é pior que comentário nenhum.

Esse é o momento em que a duplicação deliberada se paga: `seesEveryTicket`, `handlesInternalNotes` e
`joinsAdminRoom` tinham corpos idênticos e docblocks dizendo que um dia divergiriam. Divergiram
hoje, e vale registrar nos três.

`src/audit/` não muda — `GET /audit` já é `@Roles(ADMIN)` e vira a única visão company-wide da API, e
a timeline já passa por `requireTicket()`. `src/reports/` não muda: o worker pagina por
`TicketsService.findAll` (`reports.processor.ts:130`), então a exportação de um agente estreita
sozinha.

## Fase 4 — Documentação de referência

`CLAUDE.md`, `documents/important/HELPDESK.md` (Partes I e II), `documents/TESTE_MANUAL.md` e
`documents/helpdesk/GUIA_FRONTEND_HELPDESK.md`, conforme a lista do
[checklist](./CHECKLIST_VISIBILIDADE.md). `CHECKLIST_HELPDESK.md` e `PLANO_HELPDESK.md` recebem nota
datada, não reescrita: são registro histórico daquela fase.

## Fase 5 — O plano de frontend

`PLANO_FRONTEND_VISIBILIDADE.md`, escrito por último porque descreve o contrato já implementado e
verificado — não o que este plano supôs. É o que se entrega a quem mantém o cliente Next.js, ao lado
do `GUIA_FRONTEND_HELPDESK.md` atualizado.

## Testes

A regra C custa **zero** de fixture: varrendo todo `tickets.create(` e `post('/tickets')` das três
tiers, **nenhum fixture abre chamado como AGENT** — todos os autores são requesters. O custo está em
B, e o padrão da correção é sempre um de dois: **trocar o ator para um `ADMIN`** ou **atribuir o
chamado ao agente no setup**, via admin, antes de ele agir.

Uma armadilha de ordem: em Nest o guard roda antes do pipe, então testes que hoje esperam 400 ou 409
agindo como agente passariam a receber 403 e falhariam pelo motivo errado — trocar o ator, não a
expectativa.

A colocação mais forte da regra é em `test/integration/reports-queue.int-spec.ts`: um export de
agente que traz só os chamados atribuídos prova que a visibilidade sobrevive à viagem pelo Redis até
um worker sem contexto de requisição — o vazamento que o `CLAUDE.md` chama de mais provável do
projeto.

A segunda mais forte é a asserção **negativa** do `realtime.e2e-spec.ts`: o agente não atribuído não
ouve nada. As positivas passariam contra um broadcast para todo mundo.

O detalhamento arquivo a arquivo está no [checklist](./CHECKLIST_VISIBILIDADE.md).

## Verificação de ponta a ponta

```bash
npm run test:setup                 # stack efêmera (5433/6380)
npm run test:all                   # os três tiers
npm run typecheck                  # nenhum tier faz type-check
npx eslint "src/**/*.ts"           # leitura, sem --fix
```

Com `npm run start:dev` e as contas de [`TESTE_MANUAL.md`](../TESTE_MANUAL.md):

1. `agent@acme.com` tenta abrir chamado → **403**.
2. `requester@acme.com` abre um → `admin@acme.com` o vê na lista; `agent@acme.com` **não**.
3. O admin atribui a `agent@acme.com` → o agente passa a ver, comentar, mudar status e ler a
   timeline; `helpdesk@acme.com`, o outro agente, continua tomando **404** na mesma URL.
4. O agente tenta `PATCH /tickets/<id>/assignee` → **403**, inclusive para se desatribuir.
5. Com dois sockets abertos — o admin e o segundo agente — e um `PATCH` no chamado: o admin recebe
   `ticket.changed`, o segundo agente **não recebe nada**.

## Arquivos que mudam

| Arquivo                                 | Fase |
| --------------------------------------- | ---- |
| `src/tickets/ticket-visibility.ts`      | 1    |
| `src/tickets/tickets.service.ts`        | 1, 3 |
| `src/tickets/dto/query-tickets.dto.ts`  | 1    |
| `src/tickets/tickets.controller.ts`     | 2    |
| `src/tickets/dto/create-ticket.dto.ts`  | 2    |
| `src/events/ticket-events.ts`           | 3    |
| `src/comments/comments.service.ts`      | 3    |
| `src/comments/internal-notes.ts`        | 3    |
| `src/realtime/rooms.ts`                 | 3    |
| `src/realtime/notifications.gateway.ts` | 3    |

Nenhuma migration, em fase nenhuma: `@@index([tenantId, assigneeId])` já existe
(`prisma/schema.prisma:214`) ao lado de `@@index([tenantId, requesterId])` (`:215`), então os dois
braços do `OR` já estão indexados.
