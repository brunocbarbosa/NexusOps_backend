> **Documento histórico — não é a fonte de verdade.**
>
> Este é o roteiro original de CI/CD e testes, preservado como registro da visão que deu origem
> ao trabalho. Ele **não** foi reescrito à medida que a implementação avançou, e diverge deste
> repositório em oito pontos concretos.
>
> - O que foi de fato implementado, item a item: [`CHECKLIST_TESTS_CICD.md`](./CHECKLIST_TESTS_CICD.md)
> - O porquê de cada decisão, as notas de **Como saiu** por fase e a **tabela de correções** que
>   lista onde este roteiro diverge da realidade: [`PLANO_TESTS_CICD.md`](./PLANO_TESTS_CICD.md)
>
> As divergências maiores, em resumo: a branch principal é a `development` e não a `main`; o
> `services:` do GitHub Actions não serve aqui porque não sobrescreve o `command` do Redis; o Snyk
> foi descartado por ser redundante com o Dependabot; e os testes de banco exigem
> `node --experimental-vm-modules` por causa do Prisma 7.

---

Com certeza. Ajustar a documentação para refletir com exatidão as ferramentas que serão utilizadas é fundamental. Sendo o NexusOps um projeto com foco em excelência técnica, ter a clareza de que o **Supertest** atua na camada HTTP integrada ao Jest faz toda a diferença.

Aqui está o roteiro de CI/CD e testes refatorado, agora explicitando o papel exato do combo Jest + Supertest na sua infraestrutura.

### Visão Geral da Pipeline do NexusOps Atualizada

| Estágio        | Ferramenta         | Objetivo Principal                         |
| -------------- | ------------------ | ------------------------------------------ |
| **Pré-commit** | Husky + Commitlint | Padronizar mensagens de commit localmente. |

|
| **Setup & Cache** | Actions Setup Node | Instalar dependências e otimizar o tempo de execução.

|
| **Análise Estática** | SonarCloud + Snyk | Medir qualidade do código, cobertura do Jest e buscar vulnerabilidades.

|
| **Integração** | Services (GH Actions) | Subir instâncias efêmeras de PostgreSQL e Redis.

|
| **Validação** | Prisma + **Jest & Supertest** | Rodar migrations no banco efêmero e testar a API simulando requisições HTTP reais.

|
| **Release** | Docker + GHCR | Fazer o build otimizado da imagem e publicar no registro do GitHub.

|

---

### Roteiro de Configuração (Passo a Passo)

Siga esta ordem para implementar a infraestrutura de testes e integração contínua sem bloqueios:

1. **Padronização Local (Husky e Commitlint):** Configure ganchos de pré-commit na sua máquina. Isso garante que todo código enviado ao repositório siga o padrão _Conventional Commits_ (ex: `feat: add RBAC`, `fix: auth bug`), mantendo o histórico limpo para geração automática de changelogs.

2. **Fundação do Jest e Supertest:** Instale e configure a dupla dinâmica no seu projeto NestJS. O Jest atuará como o _test runner_ (executando o código e validando asserções) e o Supertest será o seu cliente HTTP embutido. Crie a estrutura de pastas separando claramente os testes unitários (com mocks) dos testes de integração/E2E (onde o Supertest disparará as requisições contra o banco de dados e Redis reais).

3.

**Preparação para Testes de Integração:** Crie um arquivo `docker-compose.test.yml` exclusivo para o ambiente de testes local. Ele deve subir um PostgreSQL e um Redis limpos rapidamente para que o Jest e o Supertest possam rodar localmente antes de você fazer o push para o GitHub.

4.

**Estrutura Base do Workflow (CI):** Crie o arquivo `.github/workflows/ci.yml`. Defina os gatilhos (triggers) para que a pipeline rode automaticamente a cada _Push_ na branch `main` ou a cada _Pull Request_ aberto.

5.

**Estratégia de Cache de Dependências:** No seu workflow, adicione o passo `actions/setup-node` habilitando o cache para o gerenciador de pacotes (npm, yarn ou pnpm). Projetos com Prisma e TypeScript demoram para compilar, e o cache reduzirá o tempo da pipeline de minutos para segundos.

6.

**Integração de Qualidade e Segurança:** Adicione os passos na pipeline para executar a análise do SonarCloud (que vai ler os relatórios de cobertura do Jest em busca de _code smells_) e do Snyk ou Dependabot para garantir que não há vulnerabilidades nas bibliotecas instaladas.

7.

**Configuração de Serviços Efêmeros na CI:** Utilize a diretiva `services` do GitHub Actions para configurar contêineres do PostgreSQL e do Redis que rodarão em background durante a execução da pipeline. Eles simularão o ambiente de produção do NexusOps de forma isolada.

8.

**Validação de Banco de Dados e Testes:** Adicione um passo (step) crucial que executa `npx prisma migrate deploy` apontando para o PostgreSQL efêmero que você acabou de subir. Isso atesta que o seu esquema compartilhado (Shared Schema) não quebrará o banco real. Em seguida, rode a suíte de testes. É aqui que o Supertest fará o trabalho sujo simulando requisições programáticas (`GET`, `POST`, `PUT`, `DELETE`) contra as rotas da sua API (ex: um `POST` com dados inválidos para validar um `400 Bad Request`), de forma totalmente automatizada contra o banco efêmero.

9.

**Build Multi-stage e Publicação:** Por fim, crie o passo final que só será executado se o Jest passar sem erros. Configure o build multi-stage do Docker para gerar uma imagem leve da API e utilize o GitHub Container Registry (GHCR) para armazenar essa imagem, deixando-a pronta para o deploy contínuo.
