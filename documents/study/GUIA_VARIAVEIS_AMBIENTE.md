# Guia das variáveis de ambiente do NexusOps — explicado do zero

> **Para quem é este documento.** Para você, daqui a três meses, olhando um `.env` com quinze
> linhas e tentando lembrar por que existem **duas** URLs de banco, por que `POSTGRES_PASSWORD` e
> `DATABASE_URL` precisam concordar, e o que exatamente quebra se você apagar uma linha.
>
> Ele explica cada variável: o que é, **quem a lê**, o que acontece sem ela, e as armadilhas que
> só aparecem depois. Não pressupõe conhecimento prévio de Docker ou de doze-fatores.
>
> Documentos vizinhos, com propósitos diferentes:
>
> - [`GUIA_CI_CD.md`](./GUIA_CI_CD.md) — o mesmo tratamento didático, para a esteira de CI/CD.
> - [`../important/USERS.md`](../important/USERS.md) — o porquê medido das decisões de autenticação,
>   incluindo por que existem duas chaves JWT.
> - [`../../CLAUDE.md`](../../CLAUDE.md) — a referência curta e operacional.
>
> Este aqui é **didático**: ensina. Os outros são referência.

---

## Índice

1. [Por que variáveis de ambiente](#1-por-que-variáveis-de-ambiente)
2. [Os três arquivos, e por que um deles é commitado](#2-os-três-arquivos-e-por-que-um-deles-é-commitado)
3. [Os quatro leitores](#3-os-quatro-leitores)
4. [Variável por variável](#4-variável-por-variável)
5. [As armadilhas](#5-as-armadilhas)
6. [Como adicionar uma variável nova](#6-como-adicionar-uma-variável-nova)
7. [Produção e a imagem Docker](#7-produção-e-a-imagem-docker)

---

## 1. Por que variáveis de ambiente

O mesmo código roda na sua máquina, na CI e em produção. O que muda entre os três não é o
programa — é **para onde ele aponta** e **com que segredos**. Se essa diferença estiver dentro do
código, você precisa de um build por ambiente e de um commit para trocar uma senha.

Variável de ambiente é a forma padrão de manter essa diferença **fora** do artefato: a mesma imagem
Docker sobe em qualquer lugar, e o ambiente decide o resto.

Daí saem duas regras que este projeto leva a sério:

- **Segredo nunca entra no repositório.** `.env` é gitignored. A exceção é o `.env.test`, e a
  seção 2 explica por que ela é segura.
- **Faltar variável tem que falhar alto, no boot.** Não adianta descobrir que `JWT_SECRET` está
  vazio no primeiro login de um usuário real. Quem garante isso é o
  `src/config/env.validation.ts`, e a seção 3 mostra como.

---

## 2. Os três arquivos, e por que um deles é commitado

| Arquivo        | Rastreado pelo git?   | Para quê                                       |
| -------------- | --------------------- | ---------------------------------------------- |
| `.env`         | **Não**               | Seus valores locais de desenvolvimento         |
| `.env.example` | Sim                   | O template documentado — a lista do que existe |
| `.env.test`    | **Sim, de propósito** | O ambiente das suítes de integração e e2e      |

O `.env.example` não tem valor nenhum de verdade. Ele existe para responder "quais variáveis este
projeto precisa?" sem que ninguém tenha que ler o código — e por isso **manter ele em dia ao
adicionar uma variável não é opcional** (ver seção 6).

O `.env.test` é commitado e isso parece errado até você olhar para onde essas credenciais vão: o
`docker-compose.test.yml` sobe um PostgreSQL **efêmero**, na porta 5433, com o diretório de dados em
`tmpfs` — ou seja, em RAM, que morre com o container. A senha `nexusops_test` não abre nada que
sobreviva ao fim do teste. E a CI precisa exatamente dos mesmos valores; commitá-los evita uma volta
por um cofre de secrets para uma credencial que não protege nada. O `.gitignore` carrega uma exceção
explícita `!.env.test` por causa disso.

> O _secret scanning_ do GitHub fica com os "non-provider patterns" desligados neste repositório
> justamente por causa desse arquivo: os padrões genéricos marcariam o `.env.test` e criariam um
> alerta permanente sobre um não-problema.

**A separação importa mais do que parece.** As suítes de integração e e2e dão `TRUNCATE` nas
tabelas. Se elas rodarem apontando para o `.env`, elas apagam o seu banco de desenvolvimento. O que
impede isso é uma variável só, explicada na seção seguinte.

---

## 3. Os quatro leitores

Esta é a parte que confunde: **não existe um lugar só que lê o `.env`**. São quatro mecanismos
independentes, e saber qual lê o quê é o que faz o resto do documento fazer sentido.

### 3.1. `ConfigModule` — a aplicação rodando

`src/app.module.ts` registra `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`.
Isso faz três coisas:

1. **Carrega o `.env`.** E é o único que faz isso para a aplicação: `nest start` **não** lê arquivo
   de ambiente sozinho. Antes deste módulo existir, o servidor de desenvolvimento rodava sem
   `DATABASE_URL` nenhuma.
2. **Valida.** `validateEnv` roda no boot e, se algo faltar ou estiver malformado, o processo morre
   listando **todos** os problemas de uma vez, e não um por vez.
3. **Não sobrescreve.** Se a variável já estiver em `process.env`, o valor do arquivo é ignorado.
   Guarde isso: é a peça central da próxima subseção.

### 3.2. `dotenv` + `DOTENV_CONFIG_PATH` — as suítes de teste

Os scripts `test:int` e `test:e2e` começam com `DOTENV_CONFIG_PATH=.env.test`, e as configurações
Jest desses dois níveis carregam `dotenv/config` em `setupFiles`. Resultado: quando o Nest sobe
dentro de um teste, o `process.env` **já** está preenchido com os valores do `.env.test`.

E aí entra a regra 3 acima: como o `ConfigModule` não sobrescreve o que já existe, o `.env.test`
**vence** o `.env`. É literalmente a única coisa separando as suítes do seu banco de
desenvolvimento.

Isso é comportamento de uma dependência, não do projeto — então está travado por um teste,
`test/integration/env-precedence.int-spec.ts`, para que um upgrade do `@nestjs/config` não redirecione
as suítes em silêncio.

> O nível **unitário** não carrega `dotenv` nenhum, de propósito. Ele não deve ter acesso a banco;
> dar `setupFiles: ["dotenv/config"]` a ele seria entregar uma conexão que ele não deveria ter.

### 3.3. `prisma.config.ts` — a CLI do Prisma

O Prisma 7 **não** lê o `.env` sozinho. O `prisma.config.ts` na raiz faz `import 'dotenv/config'`, e
é só por isso que `prisma migrate`, `prisma generate` e `prisma studio` enxergam a `DATABASE_URL`.

Consequência que surpreende: o bloco `datasource` do `prisma/schema.prisma` **não tem `url`** — ela
vem do `prisma.config.ts`. Não "conserte" o schema colocando `env("DATABASE_URL")` de volta.

### 3.4. Docker Compose — os containers

O `docker compose` carrega o `.env` do diretório do projeto por conta própria, para substituir
`${VARIAVEL}` dentro do YAML. É um mecanismo **totalmente separado** dos três de cima — nada a ver
com Node, dotenv ou NestJS.

O `docker-compose.yml` usa isso para `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_PORT` e `REDIS_PORT`, todos com valor padrão (`${POSTGRES_USER:-nexusops}`), então o
compose sobe mesmo sem `.env`.

Já o `docker-compose.test.yml` **não lê variável nenhuma**: credenciais e portas estão escritas
literalmente nele. Por isso o `.env.test` não tem `POSTGRES_*` — não haveria quem lesse.

### Resumo

| Leitor               | Lê o arquivo | Enxerga                        |
| -------------------- | ------------ | ------------------------------ |
| `ConfigModule` (app) | `.env`       | tudo, e valida oito variáveis  |
| `dotenv` (testes)    | `.env.test`  | tudo, e vence o `.env`         |
| `prisma.config.ts`   | `.env`       | só `DATABASE_URL`              |
| `docker compose`     | `.env`       | só `POSTGRES_*` e `REDIS_PORT` |

---

## 4. Variável por variável

A coluna **Validada** diz se `validateEnv` recusa o boot quando ela falta ou está malformada.

### Aplicação

| Variável   | Validada | Quem lê                            |
| ---------- | -------- | ---------------------------------- |
| `NODE_ENV` | ✅       | `validateEnv`, e o Node/Nest       |
| `PORT`     | ✅       | `src/main.ts`, via `ConfigService` |

**`NODE_ENV`** — só aceita `development`, `test` ou `production`. É um enum e não texto livre porque
`NODE_ENV=produciton` não é erro para ninguém: a aplicação simplesmente segue em modo de
desenvolvimento, que é o pior tipo de falha — silenciosa. Em `production` ela liga uma checagem
extra: recusa os segredos placeholder do `.env.example`.

**`PORT`** — inteiro entre 1 e 65535. Vem do `ConfigService` e não de `process.env` direto porque
tudo em `process.env` é string, e é a validação que converte para número e prova que é uma porta
legal.

### PostgreSQL

| Variável            | Validada | Quem lê                                  |
| ------------------- | -------- | ---------------------------------------- |
| `POSTGRES_USER`     | ❌       | só o `docker-compose.yml`                |
| `POSTGRES_PASSWORD` | ❌       | só o `docker-compose.yml`                |
| `POSTGRES_DB`       | ❌       | só o `docker-compose.yml`                |
| `POSTGRES_PORT`     | ❌       | só o `docker-compose.yml`                |
| `DATABASE_URL`      | ✅       | `prisma.config.ts` e o `PrismaModule`    |
| `DATABASE_URL_APP`  | ❌       | **ninguém ainda** — reservada para a RLS |

As quatro `POSTGRES_*` configuram o **container**: com que usuário, senha e banco o PostgreSQL vai
subir, e em que porta do host ele aparece. Elas **não chegam na aplicação** — o Prisma não sabe que
existem.

A `DATABASE_URL` é o que a aplicação de fato usa, e ela repete os mesmos dados em outro formato:

```
postgresql://nexusops:nexusops@localhost:5432/nexusops?schema=public
             └─user─┘ └─senha┘ └─host──┘ └port┘ └─db──┘
```

**As duas metades precisam concordar.** Trocar `POSTGRES_PASSWORD` sem trocar a senha dentro da
`DATABASE_URL` faz o container subir feliz e a aplicação apanhar na autenticação. É a armadilha nº 1
da seção 5.

A validação da `DATABASE_URL` só confere o esquema (`postgresql://`). Ir mais fundo duplicaria o que
o driver `pg` já faz e recusaria URLs válidas — socket unix, parâmetros extras.

**`DATABASE_URL_APP`** está comentada e não é lida por nada hoje. Ela é a preparação para o
Row-Level Security: um superusuário **ignora** as policies de RLS incondicionalmente, e o dono da
tabela também — então a aplicação vai precisar conectar com um papel restrito, diferente do que roda
as migrations. Enquanto a camada de RLS não existir, ela fica comentada. Ver
[`../important/RLS_NOTES.md`](../important/RLS_NOTES.md).

### Redis

| Variável         | Validada | Quem lê                       |
| ---------------- | -------- | ----------------------------- |
| `REDIS_HOST`     | ❌       | **ninguém ainda**             |
| `REDIS_PORT`     | ❌       | só o `docker-compose.yml`     |
| `REDIS_PASSWORD` | ❌       | **ninguém ainda** (comentada) |

Vale ser honesto sobre o estado: o Redis **sobe** (`npm run infra:up`), mas nenhum código da
aplicação fala com ele. As filas BullMQ e o cache de permissões que o `MAIN.md` prevê ainda não
existem. `REDIS_PORT` só decide em que porta do host o container aparece; `REDIS_HOST` e
`REDIS_PASSWORD` estão ali para quando a fila for escrita.

Quando isso acontecer, elas entram no `validateEnv` junto — porque aí passa a valer a regra de que
faltar variável tem que quebrar no boot.

> Uma coisa do Redis que **não** é variável de ambiente e vale conhecer: ele sobe com
> `--maxmemory-policy noeviction` nos dois arquivos de compose. Se o Redis puder despejar chaves por
> falta de memória e despejar uma chave de job no meio do voo, a fila corrompe.

### Autenticação

| Variável                 | Validada | Quem lê                      |
| ------------------------ | -------- | ---------------------------- |
| `JWT_SECRET`             | ✅       | `AuthModule` e `JwtStrategy` |
| `JWT_EXPIRES_IN`         | ✅       | `AuthModule`                 |
| `JWT_REFRESH_SECRET`     | ✅       | `RefreshTokenService`        |
| `JWT_REFRESH_EXPIRES_IN` | ✅       | `RefreshTokenService`        |
| `BCRYPT_SALT_ROUNDS`     | ✅       | `HashingService`             |

**`JWT_SECRET`** — a chave que assina e verifica o **access token**. Mínimo de 16 caracteres. Quem
tem essa chave pode forjar um token para qualquer usuário de qualquer tenant, então gere com
`openssl rand -base64 48` e use um valor diferente por ambiente.

**`JWT_REFRESH_SECRET`** — uma chave **diferente**, para o refresh token. Esta é a que mais gera a
pergunta "por que não usar a mesma com validade maior?", e a resposta é concreta: access e refresh
carregam quase as mesmas claims. Sob uma chave só, o refresh token — que vale sete dias — passa na
verificação de assinatura do `JwtStrategy` e é aceito como bearer. Os quinze minutos do access
deixam de significar qualquer coisa. Com duas chaves, a assinatura recusa, e ninguém precisa lembrar
de conferir uma claim `type`.

O `validateEnv` **recusa o boot se as duas forem iguais**, porque isso desfaz a separação sem
sintoma nenhum.

**`JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN`** — validade de cada token, no formato `15m`, `24h`,
`7d`. Validadas por regex, e não por gosto de rigor: um valor malformado **não lança** no
`jsonwebtoken` — ele trata como segundos ou ignora. A falha apareceria como tokens com a validade
errada, que é bem mais difícil de perceber do que um erro no boot.

**`BCRYPT_SALT_ROUNDS`** — o custo do hash de senha, entre 4 e 31. Cada ponto **dobra** o trabalho.
12 é um padrão razoável para produção; o `.env.test` usa **4** de propósito, porque a 12 a derivação
de chave dominaria o tempo de toda suíte de autenticação sem acrescentar confiança nenhuma.

### Não estão em arquivo nenhum

**`DOTENV_CONFIG_PATH`** — não mora no `.env`; os scripts do `package.json` a definem na linha de
comando (`DOTENV_CONFIG_PATH=.env.test node ...`). É o que diz ao `dotenv` qual arquivo carregar, e
portanto o que mantém os testes longe do banco de desenvolvimento.

**As variáveis da CI** vivem nas configurações do repositório no GitHub, não em arquivo:

| Nome                 | Tipo       | Para quê                                         |
| -------------------- | ---------- | ------------------------------------------------ |
| `SONAR_ENABLED`      | _variable_ | liga o job do Sonar quando vale `'true'`         |
| `SONAR_PROJECT_KEY`  | _variable_ | identifica o projeto no SonarCloud               |
| `SONAR_ORGANIZATION` | _variable_ | identifica a organização                         |
| `SONAR_TOKEN`        | _secret_   | autentica o scanner                              |
| `GITHUB_TOKEN`       | _secret_   | fornecido pelo Actions; publica a imagem no GHCR |

A condição do job usa `vars.SONAR_ENABLED` e não `secrets.*` por um detalhe do Actions: o contexto
`secrets` não pode ser avaliado num `if:` de job.

---

## 5. As armadilhas

**1. `POSTGRES_*` e `DATABASE_URL` desalinhados.** São dois lugares descrevendo o mesmo banco. Trocou
um, troque o outro — senão o container sobe com uma senha e a aplicação tenta com outra, e o erro
("password authentication failed") não aponta para o `.env`.

**2. Trocar `POSTGRES_USER`/`POSTGRES_DB` depois do primeiro `up`.** A imagem do PostgreSQL só roda
o `initdb` quando o diretório de dados está vazio. Com o volume já criado, mudar essas variáveis não
tem efeito nenhum: o banco antigo continua lá, com o usuário antigo. Para valer, é
`npm run infra:reset` — que **destrói o volume**, e portanto os dados locais.

**3. Rodar as suítes sem `DOTENV_CONFIG_PATH`.** Chamar o Jest direto, sem os scripts do
`package.json`, faz os testes de integração e e2e apontarem para o `.env` — e eles dão `TRUNCATE`.
Use sempre `npm run test:int` / `npm run test:e2e`. E se precisar de um teste específico, carregue as
duas flags:

```bash
DOTENV_CONFIG_PATH=.env.test node --experimental-vm-modules \
  node_modules/jest/bin/jest.js --config ./test/jest-integration.js -t "trecho do nome"
```

**4. Achar que o `.env` é lido pela aplicação em produção.** Não é: `.env` é gitignored e não entra
na imagem Docker. Em produção as variáveis vêm do orquestrador. Ver a seção 7.

**5. Copiar o `JWT_SECRET` para o `JWT_REFRESH_SECRET`.** A aplicação recusa subir. É de propósito.

**6. Deixar os placeholders do `.env.example` em produção.** Eles estão num arquivo público, então
qualquer pessoa poderia assinar um token para qualquer tenant. Com `NODE_ENV=production` a aplicação
recusa subir com eles.

---

## 6. Como adicionar uma variável nova

São quatro lugares, e pular qualquer um dá um sintoma diferente:

1. **`src/config/env.validation.ts`** — declare o campo na classe `EnvironmentVariables` com seus
   decoradores. Sem isso ela não é validada, e faltar não quebra no boot: quebra tarde.
2. **`.env.example`** — documente com um comentário dizendo _por que_ ela existe. Sem isso ninguém
   descobre que precisa dela ao clonar o projeto.
3. **`.env.test`** — se a variável for validada, **tem que estar aqui**, senão toda suíte de
   integração e e2e falha no boot da aplicação de teste.
4. **Seu `.env` local** — pelo mesmo motivo, para o `start:dev`.

E mais dois, quando se aplicar:

5. **O boot check da imagem no `.github/workflows/ci.yml`** — o passo "A imagem sobe e responde
   HTTP" repassa as variáveis validadas para o container. Uma variável validada e não repassada mata
   o job.
6. **Este guia** e o `CLAUDE.md`.

> As variáveis que **não** aparecem na classe de validação não são perdidas: o `validateEnv`
> deliberadamente não descarta o que não conhece, senão `ConfigService.get('REDIS_HOST')` devolveria
> `undefined` para uma variável que está claramente definida.

---

## 7. Produção e a imagem Docker

A imagem construída pelo `Dockerfile` define **uma** variável: `NODE_ENV=production`. Todo o resto
tem que vir de fora — do `docker run -e`, do compose, do Kubernetes, do que for.

E como a aplicação valida o ambiente no boot, subir a imagem sem variáveis **não é um erro
silencioso**: o processo morre listando o que falta.

```
Error: Invalid environment (11 problem(s)):
  - PORT: PORT must be an integer number
  - DATABASE_URL: DATABASE_URL must be a postgresql:// connection string
  - JWT_SECRET: JWT_SECRET must be at least 16 characters; generate one with `openssl rand -base64 48`
  ...
```

Isso é desejável, e é por isso que o próprio job `docker` da CI passa os valores do `.env.test` para
o container antes de fazer o `curl`. Um detalhe daquele passo é intencional: ele **não** repassa
`NODE_ENV`, deixando o `production` da imagem valer — assim o boot check também exercita a recusa
dos segredos placeholder.

**Ao promover uma versão para produção**, confira se o ambiente de lá tem todas as variáveis
validadas. Uma que falte não degrada nada: ela impede o container de subir.
