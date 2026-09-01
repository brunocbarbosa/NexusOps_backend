# NexusOps — Visão geral do projeto

Documento de escopo e de intenção técnica do produto.
O plano do frontend está em
[`GUIA_FRONTEND_HELPDESK.md`](./helpdesk/GUIA_FRONTEND_HELPDESK.md); o comportamento já medido da
API está em [`documents/important/`](./important/README.md).

## O escopo do projeto

Uma plataforma **SaaS B2B** onde empresas se cadastram (**Tenants**) para gerenciar:

- **Chamados internos de TI** — o helpdesk.
- **Controle de ativos** — notebooks, licenças.
- **Auditoria** — o histórico de quem alterou o quê.

---

## 1. Arquitetura e stack tecnológico

A escolha das ferramentas tem propósito claro de **escalabilidade e manutenibilidade**.

| Camada             | Escolha                                  | Motivo                                                            |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------- |
| Backend            | Node.js com NestJS (TypeScript)          | Força arquitetura limpa: injeção de dependências, módulos         |
| Banco de dados     | PostgreSQL                               | Dados relacionais complexos e base da estratégia de multi-tenancy |
| Cache e filas      | Redis + RabbitMQ (ou BullMQ sobre Redis) | Processamento assíncrono; BullMQ simplifica a infra inicial       |
| Frontend           | React (Next.js) + TypeScript             | Roteamento avançado e tipagem ponta a ponta                       |
| Estado de servidor | TanStack Query                           | Cache local e sincronização com a API                             |
| Tabelas            | TanStack Table                           | Data grids complexos                                              |
| UI                 | Tailwind CSS + Radix UI ou Shadcn/ui     | Acessibilidade e Design System sem escrever CSS do zero           |

---

## 2. Os diferenciais de senioridade

É onde está a maior parte do esforço do projeto — e o que o README e a entrevista devem destacar.

### A. Multi-tenancy: isolamento de dados

**O desafio.** Garantir que o "Cliente A" nunca veja um chamado do "Cliente B" por um erro no código.
Não basta um campo `tenant_id` espalhado pelas tabelas de forma ingênua.

**A solução.** Row-Level Security (RLS) no próprio PostgreSQL, ou um middleware robusto no NestJS que
injeta o `tenant_id` automaticamente no contexto global da requisição (via `AsyncLocalStorage` do
Node), garantindo que nenhuma query chegue ao banco sem esse filtro.

> Estado atual no backend: a extensão de tenancy existe e está medida em
> [`TENANCY_EXTENSION.md`](./important/TENANCY_EXTENSION.md); o RLS ainda **não** foi implementado —
> as notas e as duas armadilhas medidas estão em [`RLS_NOTES.md`](./important/RLS_NOTES.md).

### B. Controle de concorrência (race conditions)

**O desafio.** Dois analistas tentando pegar o mesmo chamado simultaneamente.

**A solução.** _Optimistic Concurrency Control_ com uma coluna `version`. Se o Analista A e o
Analista B abrem o ticket na versão 1 e A salva primeiro (indo para a versão 2), B recebe
**409 Conflict** ao tentar salvar, informando que os dados foram alterados por outro usuário.

### C. Processamento assíncrono e mensageria

**O desafio.** Gerar um relatório em PDF de todos os chamados do ano trava o Event Loop do Node.js.

**A solução.** A API responde **202 Accepted** e joga o trabalho para uma fila (RabbitMQ/BullMQ). Um
_worker_ separado gera o PDF, faz upload para um bucket S3 (ou MinIO local) e dispara um evento. O
frontend, ouvindo via Server-Sent Events ou WebSockets, avisa: _"Seu relatório está pronto para
download"_.

### D. Trilha de auditoria (audit trail)

**O desafio.** Sistemas corporativos precisam saber quem alterou o quê.

**A solução.** Toda mutação (create, update, delete) gera um registro em `audit_logs` — por exemplo,
_"Usuário X alterou o status de 'Aberto' para 'Em Progresso' no Ticket Y"_. No frontend, isso é
renderizado como a **timeline** do chamado.

### E. Frontend de alta performance

**O desafio.** A tela de "Todos os Chamados" de uma empresa grande pode ter dezenas de milhares de
registros; renderizar tudo no DOM quebra a página.

**A solução.** Virtualização de listas com `@tanstack/react-virtual`: o DOM renderiza apenas as ~20
linhas visíveis, trocando os dados conforme o scroll.
