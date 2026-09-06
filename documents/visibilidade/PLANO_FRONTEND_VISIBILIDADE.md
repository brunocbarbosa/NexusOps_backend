# Plano de frontend — visibilidade por atribuição

O **delta**. O contrato inteiro do helpdesk continua em
[`helpdesk/GUIA_FRONTEND_HELPDESK.md`](../helpdesk/GUIA_FRONTEND_HELPDESK.md) e na Parte I de
[`important/HELPDESK.md`](../important/HELPDESK.md); aqui fica só o que muda no cliente Next.js que
já existe, e por quê.

> **Tudo abaixo foi capturado da aplicação rodando** em 06/09/2026 (`npm run start:dev` contra o
> banco de desenvolvimento, com as contas de [`TESTE_MANUAL.md`](../TESTE_MANUAL.md)) — códigos,
> corpos de erro e payloads de socket são cópia da resposta real, não do que o
> [`PLANO_VISIBILIDADE.md`](./PLANO_VISIBILIDADE.md) supôs.

---

## 1. A regra, e as três consequências que custam tela

Quem não é `ADMIN` enxerga `requesterId = eu OR assigneeId = eu`. Nada mais.

| Papel          | Enxergava antes              | Enxerga agora                                                |
| -------------- | ---------------------------- | ------------------------------------------------------------ |
| `ADMIN`        | todos os chamados da empresa | igual — todos                                                |
| `AGENT`        | todos os chamados da empresa | **só os atribuídos a ele**, e os que abriu antes desta regra |
| `REQUESTER`    | só os que abriu              | igual — só os que abriu                                      |
| `ADMIN_MASTER` | lista vazia                  | igual — o tenant dele não tem chamados                       |

Três consequências, e todas as três aparecem na interface:

1. **Atribuir virou concessão de acesso**, e não passo de fluxo. Por isso
   `PATCH /tickets/:id/assignee` é rota de `ADMIN`: se o agente pudesse se atribuir, a regra seria
   decorativa.
2. **O agente não abre chamado.** O autor de um chamado o enxerga, então uma rota de abertura aberta
   a ele seria a mesma porta de saída pelo outro lado.
3. **Um chamado sem responsável só existe para o admin e para quem o abriu.** Não há fila aberta em
   que um agente pesque trabalho — a distribuição é do admin.

## 2. O que muda em cada tela

### A lista de chamados

A rota é a mesma (`GET /tickets`); o que muda é **o nome que a tela merece por papel**:

| Papel       | O que aquela tela é         |
| ----------- | --------------------------- |
| `ADMIN`     | a fila da empresa           |
| `AGENT`     | **a caixa de entrada dele** |
| `REQUESTER` | os chamados que ele abriu   |

Um título fixo "Todos os chamados" passa a mentir para dois dos três papéis. E `meta.total` respeita
a visibilidade — no mesmo instante, com os mesmos filtros, o banco de desenvolvimento respondeu:

| Conta                | `meta.total` |
| -------------------- | ------------ |
| `admin@acme.com`     | 3            |
| `agent@acme.com`     | 1            |
| `helpdesk@acme.com`  | 1            |
| `requester@acme.com` | 3            |

Dois números diferentes na mesma tela para contas diferentes não é cache velho: é a regra.

### A fila de não atribuídos

`?unassigned=true` **é uma tela de admin**, e é a tela de trabalho dele — é onde ele distribui.
Medido no mesmo instante: `admin@acme.com` recebeu `{"total":1}` e `agent@acme.com` recebeu
`{"total":0}`, porque o filtro intersecta com o escopo do agente e sobra só o que ele mesmo abriu e
ninguém pegou. Não é bug, e não vale a pena oferecer o filtro a quem não é admin: ele responde uma
lista quase sempre vazia.

### O controle de responsável

Vira **leitura** para todo mundo que não é `ADMIN`. Sem seletor, sem "pegar este chamado", sem
"largar este chamado" — inclusive para o agente que já é o responsável.

### O botão de abrir chamado

Some para o `AGENT`. Continua para `ADMIN` e `REQUESTER`.

### O detalhe do chamado

Nada muda no código; muda **quem cai no 404**. Antes era só requester olhando chamado alheio; agora
é também agente olhando chamado que não é dele. Se a tela ainda trata 404 como "algo deu errado",
esta é a mudança que transforma isso em chamado aberto reclamando de chamado.

## 3. Os erros novos, com o corpo real

Todos capturados da aplicação rodando:

| Situação                                             | Status | Corpo                                                                                             |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `AGENT` em `POST /tickets`                           | `403`  | `{"message":"This route requires one of: ADMIN, REQUESTER","error":"Forbidden","statusCode":403}` |
| `ADMIN_MASTER` em `POST /tickets`                    | `403`  | o mesmo corpo — antes desta mudança era **500**                                                   |
| `AGENT` em `PATCH /tickets/:id/assignee`             | `403`  | `{"message":"This route requires one of: ADMIN","error":"Forbidden","statusCode":403}`            |
| o mesmo, tentando `assigneeId: null` no chamado dele | `403`  | idêntico — largar também é atribuir                                                               |
| `AGENT` não atribuído em `GET /tickets/:id`          | `404`  | `{"message":"No ticket <id>","error":"Not Found","statusCode":404}`                               |
| `AGENT` em `GET /audit`                              | `403`  | `{"message":"This route requires one of: ADMIN","error":"Forbidden","statusCode":403}`            |

**O `404` é a resposta de todo o resto do chamado**, não só do `GET`. Medido, com o mesmo corpo nas
cinco: `PATCH /tickets/:id`, `PATCH /tickets/:id/status`, `POST /tickets/:id/comments`,
`GET /tickets/:id/comments` e `GET /tickets/:id/timeline`. É 404 e nunca 403 de propósito — um 403
confirmaria que aquele id existe em algum lugar.

Duas armadilhas medidas:

- **O `ValidationPipe` roda antes do serviço.** Um `PATCH /tickets/:id` com `title` curto, num
  chamado que o agente **não** enxerga, respondeu `400` — a mensagem de tamanho mínimo do DTO, e não
  `404`. Não conclua que o chamado existe porque veio um `400`.
- **O guard roda antes do pipe.** Uma requisição malformada do agente para `/assignee` recebe `403`,
  não `400`. Se a tela testa payload por código de erro, esses dois casos se invertem conforme o
  papel.

## 4. O filtro intersecta, nunca sobrescreve

Um filtro só consegue **estreitar** o que o papel já permite. Medido:

| Quem                 | Pedido                       | Resposta                                                              |
| -------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `requester@acme.com` | `?requesterId=<id do admin>` | `{"data":[],"meta":{"total":0,"page":1,"perPage":20,"totalPages":1}}` |
| `requester@acme.com` | `?assigneeId=<id do agente>` | `total: 2` — os **dele** que aquele agente atende                     |
| `agent@acme.com`     | `?assigneeId=<id de outro>`  | `total: 0`                                                            |

A primeira linha é a que morde: `200` com lista vazia, sem erro nenhum. Se a tela guarda filtro em
`localStorage` ou na URL, um filtro herdado de outra sessão — ou um link colado por um colega de
outro papel — esvazia a lista silenciosamente. Vale um estado explícito de "nenhum chamado com estes
filtros", com um botão de limpar, em vez de uma lista vazia sem explicação.

## 5. O socket

**Nada muda no cliente.** O cliente nunca nomeou sala nenhuma: quem entra em que sala é decidido no
handshake, no servidor, a partir do papel relido do banco. O que muda é a **matriz de quem recebe
o quê** — e é ela que derruba qualquer contador global alimentado só pelo socket.

O `ready` continua `{ userId, role }`:

```json
{ "userId": "27d4bfba-3539-466e-8204-0a1889dabaae", "role": "AGENT" }
```

Quem recebe `ticket.changed` de um chamado, medido com quatro sockets abertos ao mesmo tempo:

| Quem                              | `commented` | `status_changed` | `assigned` | `internal_note_added` |
| --------------------------------- | ----------- | ---------------- | ---------- | --------------------- |
| `ADMIN` da empresa                | sim         | sim              | sim        | sim                   |
| o responsável                     | sim         | sim              | sim        | sim                   |
| o requester                       | sim         | sim              | sim        | **não**               |
| `AGENT` sem relação com o chamado | **não**     | **não**          | **não**    | **não**               |

A última linha é a asserção que importa, e é a que a suíte fixa: as três primeiras passariam
igualmente contra um broadcast para a empresa inteira.

### O evento de despedida

Quando o admin reatribui, **o agente que perdeu o chamado recebe esse último evento** — e só ele.
Capturado do socket do ex-responsável:

```json
{
  "ticketId": "173be045-13f5-48b6-8781-10bd313baa73",
  "action": "assigned",
  "actorId": "2c59626b-04e8-4fbd-873d-732eeb532cb9",
  "oldValues": { "assigneeId": "27d4bfba-3539-466e-8204-0a1889dabaae" },
  "newValues": { "assigneeId": "04182b4e-b567-4493-9d60-b3870e324f4a" }
}
```

E, no mesmo segundo, `GET /tickets/173be045-…` respondeu `200` para o admin, `200` para o novo
responsável, `200` para o requester e **`404` para ele**.

Daí a única regra nova de tratamento de evento:

- **`action: "assigned"` cujo `newValues.assigneeId` não é você e cujo `oldValues.assigneeId` é você
  → remova a linha da lista e feche o detalhe.** Não invalide a query do chamado: o `GET` que a
  invalidação dispara responde 404, e a tela pisca um erro no lugar de uma saída limpa.
- Qualquer outro `assigned` continua sendo uma invalidação normal.

Como o cliente conhece o próprio `userId` (vem do `ready` e do login), a comparação é local e não
custa requisição nenhuma.

## 6. O export também respeita a regra

`POST /reports/tickets` sem filtro nenhum, pedido no mesmo instante pelas duas contas:

| Quem pediu       | `rowCount` |
| ---------------- | ---------- |
| `admin@acme.com` | 3          |
| `agent@acme.com` | 1          |

O CSV do agente veio com uma linha e é exatamente o chamado atribuído a ele. Isso é dito aqui porque
é a tentação óbvia: um relatório é a maneira mais natural de contornar uma lista limitada, e ele não
contorna. A tela não precisa avisar nada — só não prometer "exportar todos os chamados" num botão que
para o agente exporta os dele.

## 7. A ordem de adoção

A mudança de backend é uma **restrição**: um cliente antigo contra o backend novo mostra botões que
passam a responder 403, e telas que passam a responder 404. Nada quebra em silêncio, mas quebra feio.
A ordem que minimiza a janela ruim:

| Ordem | O que fazer                                                                  | Pode ir antes do backend?                                          |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1     | `404` do detalhe vira estado "chamado não encontrado" com volta para a lista | **sim** — já é o certo hoje                                        |
| 2     | `403` de mutação vira mensagem de permissão, não erro cru                    | **sim**                                                            |
| 3     | Lista vazia com filtro vira estado explícito, com limpar filtros             | **sim**                                                            |
| 4     | Título da lista por papel; `?unassigned=true` só para admin                  | **sim** — cosmético antes                                          |
| 5     | Esconder _Abrir chamado_ do agente; responsável vira leitura para não-admin  | **não** — antes do backend isso tira função que ainda funciona     |
| 6     | Tratamento do `assigned` de despedida                                        | **não** — hoje o agente vê tudo mesmo, e a linha não deveria sumir |

Os quatro primeiros são endurecimento de tratamento de erro e valem por si, com ou sem esta mudança.
Os dois últimos dependem do backend já estar no ar.

## 8. Aceitação

O roteiro manual está em [`TESTE_MANUAL.md`](../TESTE_MANUAL.md), seção **Visibilidade: a mesma URL,
respostas diferentes**. Da parte do cliente, cinco checagens fecham o delta:

- [ ] O agente não vê _Abrir chamado_ e não vê seletor de responsável
- [ ] O chamado de outro agente mostra "chamado não encontrado", não um erro genérico
- [ ] O rodapé da lista mostra totais diferentes para admin e agente na mesma empresa
- [ ] Um filtro que esvazia a lista se explica e se limpa
- [ ] Reatribuir um chamado faz a linha sumir da tela do agente anterior **sem** um 404 no console
