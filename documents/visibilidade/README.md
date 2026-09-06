# documents/visibilidade

O registro de execução da mudança de **visibilidade por atribuição** — o `AGENT` deixa de ver todos
os chamados da empresa e passa a ver os que lhe foram atribuídos, atribuir vira trabalho de `ADMIN`,
e abrir chamado deixa de ser coisa de agente.

Esta pasta guarda **processo**, não conhecimento: o que vai ser feito, o que já foi feito, e o que o
frontend precisa saber para acompanhar a mudança. O conhecimento que sobreviver à implementação — o
que custou medição e seria caro redescobrir — vai para
[`important/HELPDESK.md`](../important/HELPDESK.md), não para cá. É a mesma divisão que
[`helpdesk/README.md`](../helpdesk/README.md) declara.

| Arquivo                                                              | Leia quando                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`PLANO_VISIBILIDADE.md`](./PLANO_VISIBILIDADE.md)                   | quiser entender a regra nova e o desenho da mudança de uma vez   |
| [`CHECKLIST_VISIBILIDADE.md`](./CHECKLIST_VISIBILIDADE.md)           | quiser saber o que já foi entregue e o que continua pendente     |
| [`PLANO_FRONTEND_VISIBILIDADE.md`](./PLANO_FRONTEND_VISIBILIDADE.md) | for adaptar o cliente Next.js — o delta, com payloads capturados |

A mudança altera o helpdesk descrito em [`helpdesk/`](../helpdesk/), que continua sendo o registro
da feature original — aquela pasta não é reescrita, recebe nota datada.

Os três arquivos estão em português, como o resto de `documents/`. O `HELPDESK.md` em
`documents/important/` está em inglês, como o resto daquela pasta.
