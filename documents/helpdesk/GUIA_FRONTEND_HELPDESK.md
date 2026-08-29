# Guia de frontend — helpdesk

O **contrato** da API é a Parte I de [`important/HELPDESK.md`](../important/HELPDESK.md): lá estão
todos os endpoints, os payloads capturados da aplicação rodando e o catálogo de erros. Este guia não
repete nada disso.

O que ele trata é o que o cliente Next.js precisa **decidir** por causa do desenho do backend — as
quatro ou cinco coisas que, se forem descobertas durante a implementação, custam retrabalho de tela.

O stack alvo está no [`MAIN.md`](../MAIN.md): Next.js, TanStack Query, TanStack Table,
`@tanstack/react-virtual`, Tailwind com Radix ou shadcn/ui.

---

## 1. A mesma URL responde coisas diferentes

`GET /tickets/:id` pode devolver `200` para um agente e `404` para o colega de sala do requester.
Isso não é erro de sistema, é a regra de visibilidade: um `REQUESTER` só enxerga os chamados que
abriu; `AGENT` e `ADMIN` enxergam todos da empresa.

Consequências para a interface:

- **`404` não deve renderizar "algo deu errado".** Renderize "chamado não encontrado", com um
  caminho de volta para a lista. Um toast de erro genérico faz o usuário abrir um chamado
  reclamando de um chamado.
- **Não esconda botão por papel adivinhando.** O papel vem no `user` do login e no evento `ready` do
  socket. As rotas de status e de atribuição exigem `ADMIN` ou `AGENT` e respondem `403`; a de
  comentário interno também.
- **Não confie em `?requesterId=`.** Para um `REQUESTER` o backend sobrescreve esse filtro com o id
  dele. Um seletor de "ver chamados de" só faz sentido na tela do agente.

## 2. O `409` de concorrência é a tela mais importante do produto

Todo `PATCH` de ticket exige `version` — a que a tela leu. Se outra pessoa salvou primeiro, a
resposta é `409` e a mensagem traz a versão atual.

**O que não fazer:** repetir a requisição. A `version` continua velha, e o retry só produz outro
`409`.

**O que fazer:**

1. Recarregar o chamado (`GET /tickets/:id`).
2. Mostrar ao usuário o que mudou, e o que ele estava tentando salvar.
3. Deixar ele reaplicar — ou descartar.

```ts
// TanStack Query: o cache do detalhe é a fonte da `version`.
const mutation = useMutation({
  mutationFn: (input: UpdateTicket) =>
    api.patch(`/tickets/${id}`, { ...input, version: ticket.version }),
  onSuccess: (updated) => queryClient.setQueryData(['ticket', id], updated),
  onError: async (error) => {
    if (error.status !== 409) throw error;
    await queryClient.invalidateQueries({ queryKey: ['ticket', id] });
    abrirDialogoDeConflito(); // "alguém alterou este chamado enquanto você editava"
  },
});
```

Toda resposta de sucesso já traz a `version` nova, então gravar o retorno no cache
(`setQueryData`) evita um `GET` extra e mantém a próxima edição válida.

**Não use optimistic update aqui.** O ponto do `409` é que o servidor decide quem ganhou; pintar a
tela antes da resposta e desfazer depois é exatamente a experiência que a coluna `version` existe
para evitar.

## 3. O envelope `{ data, meta }` e a TanStack Table

Toda listagem responde:

```ts
{ data: T[], meta: { total, page, perPage, totalPages } }
```

Paginação é **server-side**: `manualPagination: true` na TanStack Table, `pageCount` vindo de
`meta.totalPages`. `perPage` tem teto de 100 — pedir mais é `400`.

Ordenação **não é configurável pelo cliente**. A lista de chamados vem sempre do mais novo para o
mais antigo, e a thread de comentários do mais antigo para o mais novo. Não ofereça cabeçalho
clicável para ordenar; não existe parâmetro para isso.

`meta.total` respeita visibilidade: o total de um requester conta só os chamados dele. Pode usar
direto no rodapé da tabela.

Chaves de cache sugeridas, porque a invalidação depois de cada mutação depende delas:

```
['tickets', filtros]          -> GET /tickets
['ticket', id]                -> GET /tickets/:id
['comments', ticketId, page]  -> GET /tickets/:id/comments
['timeline', ticketId]        -> GET /tickets/:id/timeline
['reports']                   -> GET /reports
```

## 4. Virtualização

A tela de "todos os chamados" de uma empresa grande é o cenário do ponto E do `MAIN.md`. Como a
paginação é server-side e `perPage` para em 100, a virtualização com `@tanstack/react-virtual` vale
para o modo de scroll infinito (`useInfiniteQuery` acumulando páginas), não para a tabela paginada
comum — nela 100 linhas não quebram o DOM.

Escolha um dos dois modos e não os misture: acumular páginas _e_ oferecer paginador confunde o
`meta.total`.

## 5. A timeline é a junção de duas rotas

`GET /tickets/:id/timeline` traz o histórico **de mudanças** (criado, atribuído, status, comentado).
`GET /tickets/:id/comments` traz os **textos**. O backend não junta os dois de propósito — o corpo do
comentário não fica na trilha de auditoria.

O cliente intercala por `createdAt`. As entradas de auditoria com `action: "commented"` trazem
`newValues.commentId`, que é a ligação entre as duas listas.

Um `REQUESTER` nunca vê `action: "internal_note_added"` nem o comentário correspondente — em nenhuma
das duas rotas, nem no `total`. Não é preciso filtrar nada no cliente.

**A trilha é escrita depois da resposta.** Um `GET` da timeline imediatamente após um `PATCH` pode
vir com uma entrada a menos. Invalide a query da timeline com um pequeno atraso, ou deixe o socket
avisar (seção 7).

## 6. O fluxo assíncrono: `202` → socket → download

```
POST /reports/tickets   -> 202 { id, status: "PENDING" }
        │
        │  (worker gera o CSV)
        ▼
socket: report.completed { reportId, rowCount }
        │
        ▼
GET /reports/:id/download  -> 200 text/csv
```

- O `202` **não** significa pronto. Não abra o download com o id que acabou de receber.
- **Não faça polling** se o socket estiver conectado; o `report.completed` é emitido depois de a
  linha ser gravada, então o download logo em seguida encontra o arquivo pronto.
- Se não houver socket (aba sem conexão, fallback), `GET /reports/:id` até `status` virar
  `COMPLETED` ou `FAILED`. Baixar antes disso é `409`.
- **Relatório é pessoal.** Só quem pediu enxerga; o de outra pessoa é `404`. Não construa uma tela de
  "relatórios da equipe".
- O download é `text/csv` com `Content-Disposition`. Como a chamada leva `Authorization`, um
  `<a href>` simples não serve: busque com `fetch`, transforme em `Blob` e dispare o download.

## 7. O socket

```ts
const socket = io(API_URL, {
  auth: { token: accessToken },
  reconnection: false, // ver abaixo
});
```

- Token no `auth`, **não** em header — o `WebSocket` do browser não permite header.
- O servidor responde `ready` (`{ userId, role }`) ou `unauthorized` seguido de desconexão.
- **`reconnection: false` é deliberado.** O token de acesso expira em 15 minutos e o socket vive
  horas; com reconexão automática, um socket recusado por token expirado tenta para sempre. O padrão
  correto é: ao receber `unauthorized` ou `disconnect`, renove o token pelo `/auth/refresh` e conecte
  de novo com o token novo.
- Reconecte também depois de todo refresh bem-sucedido, mesmo sem erro: o papel é relido do banco no
  handshake, então uma reconexão é o que aplica um papel que mudou.

Eventos:

| Evento             | Quem recebe                                | Uso na interface                           |
| ------------------ | ------------------------------------------ | ------------------------------------------ |
| `ticket.changed`   | staff da empresa, e o requester do chamado | invalidar `['ticket', id]` e `['tickets']` |
| `report.completed` | só quem pediu                              | liberar o download                         |
| `report.failed`    | só quem pediu                              | mostrar `error`                            |

`ticket.changed` traz `{ ticketId, action, actorId, oldValues, newValues }`, com o mesmo vocabulário
de `action` da timeline — dá para reusar um renderizador só para os dois.

**Ignore o evento cuja `actorId` é o próprio usuário** se já atualizou o cache pela resposta HTTP;
senão a tela pisca duas vezes na própria ação.

## 8. Autenticação, em uma tela

O login pede `tenantDomain`, e não só e-mail e senha — o mesmo e-mail pode existir em empresas
diferentes. O formulário precisa dos três campos, ou o domínio precisa vir do subdomínio da URL.

Access token vale 15 minutos, refresh vale 7 dias e a rotação é obrigatória: o `/auth/refresh`
devolve um par novo e invalida o antigo. Reusar um refresh token já usado revoga a família inteira —
então **um único ponto no cliente pode chamar o refresh**, com as requisições concorrentes esperando
a mesma promise. Dois refreshes em paralelo derrubam a sessão.

O detalhe completo está na Parte I de [`important/USERS.md`](../important/USERS.md).

## 9. Telas mínimas

| Tela                  | Rotas                                                      |
| --------------------- | ---------------------------------------------------------- |
| Login                 | `POST /auth/login`                                         |
| Lista de chamados     | `GET /tickets` com filtros                                 |
| Abrir chamado         | `POST /tickets`                                            |
| Detalhe do chamado    | `GET /tickets/:id`, `/comments`, `/timeline`               |
| Ações do agente       | `PATCH /tickets/:id/status`, `/assignee`                   |
| Relatórios            | `POST /reports/tickets`, `GET /reports`, `/:id/download`   |
| Usuários (admin)      | `GET`/`POST`/`PATCH` `/users` — ver `USERS.md`             |
| Auditoria (admin)     | `GET /audit`                                               |
| Console da plataforma | `/platform/companies` — ver `PLATFORM.md`, é outro produto |

O console do `ADMIN_MASTER` é uma aplicação separada na prática: papel diferente, tenant reservado,
e nenhuma tela em comum com o helpdesk. Não tente acomodar os dois na mesma navegação.
