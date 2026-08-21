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
| [`USERS.md`](./USERS.md)                         | mexer em `src/auth/`, `src/users/` ou em DTO de qualquer módulo     |
| [`RLS_NOTES.md`](./RLS_NOTES.md)                 | implementar Row-Level Security — que **ainda não existe** no código |

Todos foram medidos contra as versões deste repositório — Prisma 7.9.1, PostgreSQL 17, bcrypt
6.0.0, class-transformer 0.5.1 — e não tirados de documentação. Um upgrade de qualquer uma delas é
motivo para reconferi-los; as suítes em `test/integration/` são quem avisa se algo deixou de ser
verdade.
