# documents/helpdesk

O registro de execução da feature **helpdesk** — tickets, comentários, trilha de auditoria,
processamento assíncrono e notificações em tempo real.

Esta pasta guarda **processo**, não conhecimento: o que vai ser feito, o que já foi feito, e o que
o frontend precisa saber para consumir o resultado. O conhecimento que sobreviver à implementação —
o que custou medição e seria caro redescobrir — vai para
[`important/HELPDESK.md`](../important/HELPDESK.md), não para cá. É a mesma divisão que
[`important/README.md`](../important/README.md) declara: guias e registros de execução moram em
`documents/`; conhecimento medido mora em `documents/important/`.

| Arquivo                                                    | Leia quando                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| [`PLANO_HELPDESK.md`](./PLANO_HELPDESK.md)                 | quiser entender o desenho da feature e o banco inteiro de uma vez |
| [`CHECKLIST_HELPDESK.md`](./CHECKLIST_HELPDESK.md)         | quiser saber o que já foi entregue e o que continua pendente      |
| [`GUIA_FRONTEND_HELPDESK.md`](./GUIA_FRONTEND_HELPDESK.md) | for escrever o cliente Next.js que consome esta API               |

Os três estão em português, como o resto de `documents/`. O `HELPDESK.md` em `documents/important/`
está em inglês, como o resto daquela pasta.
