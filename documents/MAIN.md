1. Visão Geral:
   O NexusOps é uma plataforma SaaS B2B de automação corporativa e gestão de chamados (helpdesk). O sistema permite que diferentes empresas (tenants) gerenciem seus fluxos internos de trabalho de forma isolada, segura e com alta performance. O foco deste projeto de portfólio não é apenas a funcionalidade, mas sim resolver desafios complexos de engenharia de software de nível sênior.

2. Tecnologias:
   2.1. Linguagem e Framework Base

- Node.js com NestJS (TypeScript): O framework principal escolhido por forçar uma arquitetura limpa (Módulos, Injeção de Dependência) que é muito valorizada no mercado corporativo.

2.2. Banco de Dados e ORM

- PostgreSQL: Banco de dados relacional ideal para dados complexos e essencial para a estratégia de multi-tenancy no modelo Shared Database, Shared Schema. Ele também será usado para aplicar o Row-Level Security (RLS) nativo.
- Prisma: O ORM (Object-Relational Mapper) escolhido pela sua excelente sinergia com o TypeScript e tipagem estrita de ponta a ponta. Utilizaremos o Prisma Client Extensions para injetar o filtro de isolamento de dados automaticamente nas queries.

2.3. Filas, Cache e Processamento Assíncrono

- Redis: Servirá como banco de dados em memória, atuando tanto para cache de permissões da aplicação quanto como base de infraestrutura para o sistema de filas.
- BullMQ: Biblioteca de mensageria que rodará sobre o Redis. Será responsável por gerenciar os workers e processar tarefas pesadas em background (como geração de relatórios), evitando que o Event Loop principal da API fique travado.

2.4. Comunicação Real-time e Eventos

- NestJS WebSockets Gateway: Para gerenciar a comunicação bidirecional com o frontend em tempo real, notificando os usuários quando um job (como um upload de arquivo) for concluído.
- @nestjs/event-emitter: Biblioteca para implementar o padrão Observer (orientação a eventos). Será usada especificamente para o módulo de auditoria, escutando as mutações e salvando os logs no banco de forma desacoplada da regra de negócios.

2.5. Segurança e Isolamento de Contexto

- AsyncLocalStorage (do Node.js): Para armazenar o tenant_id e outras informações do usuário autenticado no escopo global e isolado de cada requisição HTTP.
- JWT (JSON Web Tokens): Para a camada de autenticação, carregando o ID do tenant diretamente no payload.

2.6. Infraestrutura e DevOps

- Docker e Docker Compose: Essenciais para a fundação do projeto, permitindo orquestrar e subir rapidamente os containers das dependências locais da aplicação, como o PostgreSQL e o Redis.
- CI/CD: Práticas de integração e entrega contínuas para preparar toda a infraestrutura para o deploy na nuvem.

3. Arquitetura
   O sistema foi desenhado para contornar problemas reais de escalabilidade e segurança:

- Multi-tenancy e Isolamento de Dados: Utiliza a abordagem Shared Database, Shared Schema. O isolamento é garantido globalmente no backend através do AsyncLocalStorage e extensões do Prisma, além da aplicação de Row-Level Security (RLS) nativa no PostgreSQL.
- Controle Otimista de Concorrência: Previne race conditions (condições de corrida) em chamados simultâneos utilizando uma coluna de versão, bloqueando atualizações conflitantes e garantindo a consistência dos dados.
- Trilha de Auditoria Reativa (Audit Trail): Uma arquitetura orientada a eventos (padrão Observer) desacopla a regra de negócios da auditoria. Toda mutação no banco gera um evento que é salvo na tabela de logs usando o formato flexível JSONB.
- Processamento Assíncrono: Tarefas pesadas que travariam o Event Loop do Node.js (como geração de relatórios) são enviadas para uma fila gerenciada pelo Redis e BullMQ.
- Notificações em Tempo Real: Workers processam as tarefas em background e o backend notifica o cliente instantaneamente sobre a conclusão via WebSockets.
