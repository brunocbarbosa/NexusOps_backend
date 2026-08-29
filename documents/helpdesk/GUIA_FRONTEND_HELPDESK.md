# Guia de frontend — helpdesk

> **Status: escrito na Fase 7.** Este arquivo existe desde a Fase 0 apenas para que os links que
> apontam para ele não deem 404 no GitHub — o esqueleto abaixo é o índice do que ele vai conter, e
> cada seção só é preenchida quando o endpoint correspondente existir de verdade.
>
> A razão de esperar: a regra dos documentos deste repositório é que payload é **capturado da
> aplicação rodando**, nunca deduzido dos tipos. Escrever o contrato antes da API existir seria
> inventá-lo, e um guia de frontend que mente é pior do que um guia que ainda não existe.
>
> Enquanto isso, o [`PLANO_HELPDESK.md`](./PLANO_HELPDESK.md) já traz os endpoints planejados e as
> regras de visibilidade, e serve para dimensionar o trabalho do cliente.

O contrato da API é a **Parte I** de [`important/HELPDESK.md`](../important/HELPDESK.md). Este guia
não repete payloads: ele trata do que o cliente Next.js precisa **decidir** por causa do desenho do
backend.

## O que este guia vai cobrir

### As telas

Lista de chamados, detalhe com timeline, formulário de abertura, fila do agente e a área de
relatórios.

### A máquina de estados do ticket

`OPEN → IN_PROGRESS | RESOLVED`, `IN_PROGRESS → RESOLVED | OPEN`, `RESOLVED → CLOSED | OPEN` e
`CLOSED` como terminal. Quais botões cada papel enxerga em cada estado.

### O `409` de concorrência otimista, e por que ele não é um erro de rede

Todo `PATCH` carrega a `version` que a tela leu. Se outra pessoa salvou primeiro, a resposta é
`409` — a interface tem de recarregar o chamado e reapresentar a alteração ao usuário, não repetir
a requisição. É o caso de uso que justifica a coluna `version` existir.

### A visibilidade muda o que a mesma URL responde

Um `REQUESTER` e um `AGENT` pedindo `GET /tickets/:id` podem receber `200` e `404`. A interface não
deve tratar `404` como "erro do sistema".

### O envelope `{ data, meta }` na TanStack Table e na TanStack Query

Paginação server-side, chaves de cache e invalidação depois de cada mutação.

### Virtualização da lista

`@tanstack/react-virtual` sobre a lista paginada, o ponto E do [`MAIN.md`](../MAIN.md).

### O fluxo assíncrono: `202` → WebSocket → download

`POST /reports/tickets` responde `202` com um id. Nada de polling: a conclusão chega pelo socket.

### O handshake do socket

Token de acesso em `handshake.auth.token`, o que fazer quando ele expira, e por que um `REQUESTER`
recebe menos eventos que um `AGENT`.
