# documents/important

Referências profundas que o `CLAUDE.md` **aponta** em vez de conter.

Elas moram aqui por um motivo específico: são detalhes que ninguém precisa na maioria dos dias, mas
que custaram tempo de medição real e seriam caros de redescobrir. Inline no `CLAUDE.md`, diluíam o
que se aplica a toda tarefa; espalhados pelo repositório, se perdem.

**A regra desta pasta:** o que entra aqui é conhecimento medido — comportamento observado neste
repositório, com o número e a consequência — e não explicação didática. Guias que ensinam ficam em
`documents/`; registros de execução (plano, checklist) também.

| Arquivo                                          | Leia antes de                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| [`TENANCY_EXTENSION.md`](./TENANCY_EXTENSION.md) | editar `src/tenancy/`, ou depois de qualquer upgrade do Prisma      |
| [`RLS_NOTES.md`](./RLS_NOTES.md)                 | implementar Row-Level Security — que **ainda não existe** no código |

Ambos foram medidos contra o Prisma 7.9.1 e o PostgreSQL 17 deste repositório, não tirados de
documentação. Um upgrade de qualquer um dos dois é motivo para reconferi-los; o
`test/integration/tenant-isolation.int-spec.ts` é quem avisa se algo deixou de ser verdade.
