# Guia de CI/CD e Qualidade do NexusOps — explicado do zero

> **Para quem é este documento.** Para você, daqui a três meses, tentando lembrar por que existe
> um arquivo chamado `.husky/commit-msg` e o que acontece quando você digita `git push`.
>
> Ele explica **tudo** que foi montado na infraestrutura de testes e CI/CD: cada ferramenta
> instalada, para que serve, que problema resolve, e como as peças se encaixam. Não pressupõe
> conhecimento prévio de CI/CD.
>
> Documentos vizinhos, com propósitos diferentes:
>
> - [`CHECKLIST_TESTS_CICD.md`](../CHECKLIST_TESTS_CICD.md) — o acompanhamento item a item do que
>   foi implementado e do que continua pendente.
> - [`important/`](../important/) — as referências profundas: o comportamento medido da extensão de
>   tenancy e as notas de RLS.
> - [`../../CLAUDE.md`](../../CLAUDE.md) — a referência curta e operacional, para consulta rápida.
>
> Este aqui é o **didático**: ensina. Os outros são referência — consulta pontual, não leitura.

---

## Índice

1. [O problema que tudo isto resolve](#1-o-problema-que-tudo-isto-resolve)
2. [Os conceitos, em linguagem simples](#2-os-conceitos-em-linguagem-simples)
3. [Camada 1 — A sua máquina (antes do commit)](#3-camada-1--a-sua-máquina-antes-do-commit)
4. [Camada 2 — Os três níveis de teste](#4-camada-2--os-três-níveis-de-teste)
5. [Camada 3 — O empacotamento (Docker)](#5-camada-3--o-empacotamento-docker)
6. [Camada 4 — A pipeline no GitHub Actions](#6-camada-4--a-pipeline-no-github-actions)
7. [Camada 5 — Segurança automatizada](#7-camada-5--segurança-automatizada)
8. [Camada 6 — As regras de branch](#8-camada-6--as-regras-de-branch)
9. [O fluxo do dia a dia](#9-o-fluxo-do-dia-a-dia)
10. [Quando algo fica vermelho](#10-quando-algo-fica-vermelho)
11. [Glossário](#11-glossário)

---

## 1. O problema que tudo isto resolve

O NexusOps tem um design de isolamento entre tenants — o chokepoint em `src/tenancy/`, as chaves
estrangeiras compostas no schema, a Row-Level Security planejada. Esse design é o motivo de o
projeto existir.

Mas um design só vale enquanto continua verdadeiro. Basta **uma** refatoração distraída para que
uma consulta deixe de ser filtrada por tenant, e a partir daí a empresa A passa a enxergar os
chamados da empresa B. Ninguém percebe. O código compila, os testes que existem passam, a tela
abre normalmente. O vazamento só aparece quando um cliente reclama.

A infraestrutura descrita aqui existe para tornar isso **impossível de passar despercebido**. A
ideia central, que se repete em todas as camadas, é:

> Uma regra que depende de alguém lembrar é uma regra que uma hora vai ser esquecida.
> Toda regra importante vira um **chokepoint**: um ponto obrigatório por onde o código tem que
> passar, que reprova sozinho.

O commit passa por um hook. O push passa por uma pipeline. O merge passa por um ruleset. Em nenhum
desses pontos existe a opção "ah, dessa vez deixa passar".

---

## 2. Os conceitos, em linguagem simples

Antes das ferramentas, os cinco termos que aparecem o tempo todo daqui para frente.

### CI — Integração Contínua

**Continuous Integration.** A prática de, a cada mudança de código, rodar automaticamente tudo que
verifica se o projeto continua são: compilar, checar estilo, rodar testes.

O "contínua" é o ponto. A alternativa é testar de vez em quando — e aí, quando algo quebra, você
tem quinze mudanças candidatas a culpada. Testando a cada mudança, a culpada é sempre a última.

### CD — Entrega Contínua

**Continuous Delivery.** O passo seguinte: se a CI passou, o sistema **empacota** o resultado
automaticamente, pronto para ir ao ar. Neste projeto, empacotar significa construir uma imagem
Docker e publicá-la num registro.

Ainda não há deploy automático — a imagem é publicada, mas nada a coloca em produção sozinha. Isso
é uma pendência futura anotada no checklist.

### Pipeline

A sequência de etapas automatizadas que roda a cada mudança. Uma "esteira": o código entra de um
lado, passa por estações de verificação, e sai do outro lado aprovado ou reprovado.

Aqui a pipeline tem **sete estações**, chamadas de _jobs_.

### Pull Request (PR)

Um pedido formal de "quero juntar o meu trabalho ao trabalho principal". Você trabalha numa branch
separada, abre um PR, a pipeline roda em cima dele, e só depois de tudo verde o merge é permitido.

O PR é o lugar onde a pipeline vira um portão em vez de um relatório. Sem PR, a pipeline apenas
avisa que algo quebrou — depois de já estar quebrado.

### Status check

Cada job da pipeline reporta um resultado ao GitHub: verde (passou), vermelho (falhou) ou cinza
(pulado). Um status check **obrigatório** é aquele que, se não estiver verde, bloqueia o botão de
merge.

Neste repositório, `quality` e `test` são obrigatórios nas duas branches; a `main` exige também o
`guard-main-source`.

---

## 3. Camada 1 — A sua máquina (antes do commit)

A primeira barreira roda **no seu computador**, no instante em que você digita `git commit`. O
objetivo é dar o retorno em dois segundos, em vez de em dois minutos na nuvem.

### Git hooks e o Husky

O Git tem um recurso nativo chamado **hook**: scripts que ele executa sozinho em momentos
específicos (antes do commit, ao validar a mensagem, antes do push). O problema é que hooks vivem
em `.git/hooks/`, que **não é versionado** — cada pessoa teria que instalar os seus à mão.

O **Husky** (`husky@9`) resolve isso: guarda os hooks numa pasta `.husky/`, que vai para o
repositório, e instala o apontamento automaticamente. Quem clonar o projeto e rodar `npm install`
já ganha os hooks funcionando.

O que liga uma coisa na outra é um script no `package.json`:

```json
"prepare": "husky || true"
```

`prepare` é um script que o npm executa sozinho depois de `npm install`. O **`|| true` é
obrigatório** e não é preguiça: dentro do build Docker não existe pasta `.git`, o `husky` falha
nesse ambiente, e sem o `|| true` o `npm ci` da imagem inteira abortaria por causa de um hook que
nem faz sentido ali.

Existem dois hooks no projeto.

#### `.husky/pre-commit` → verifica o código

```bash
npx lint-staged
```

#### `.husky/commit-msg` → verifica a mensagem

```bash
npx --no -- commitlint --edit "$1"
```

### lint-staged — verificar só o que mudou

O **lint-staged** (`lint-staged@17`) roda ferramentas apenas nos arquivos **em stage** (aqueles que
você já adicionou com `git add`). A diferença é de tempo: verificar o projeto inteiro a cada commit
levaria dezenas de segundos e você acabaria usando `--no-verify` para escapar. Verificando três
arquivos, leva menos de um segundo e ninguém tenta escapar.

A configuração fica no `package.json`:

```json
"lint-staged": {
  "*.ts": ["eslint --fix"],
  "*.{json,md,yml,yaml}": ["prettier --write"]
}
```

Repare que arquivos `.ts` **não** passam pelo Prettier. Não é esquecimento: o
`eslint-plugin-prettier` já aplica a formatação como se fosse uma regra de lint. Encadear
`prettier --write` depois faria as duas ferramentas reescreverem o mesmo arquivo com configurações
levemente diferentes — elas brigariam e o arquivo mudaria a cada commit.

### ESLint — o revisor de código

O **ESLint** (`eslint@9`, com `typescript-eslint@8`) é um _linter_: lê o código sem executá-lo e
aponta problemas. Não erros de sintaxe (o compilador pega esses), mas padrões suspeitos —
variável declarada e nunca usada, `await` esquecido numa Promise, comparação que sempre dá falso.

O `--fix` faz o ESLint corrigir sozinho o que for corrigível automaticamente.

> ⚠️ **Atenção com `npm run lint`.** Esse script é `eslint --fix`: ele **reescreve seus arquivos**.
> Quando você só quer _ver_ os problemas, sem alterar nada, use `npx eslint "src/**/*.ts"` sem o
> `--fix`. É exatamente isso que a CI faz — reescrever arquivos numa CI só esconderia o problema.

### Prettier — o formatador

O **Prettier** (`prettier@3`) cuida da aparência: aspas simples ou duplas, vírgula no final,
largura da linha, indentação. Ele não tem opinião sobre a qualidade do código, só sobre o formato.

O valor não é estético. É que **discussões sobre formatação desaparecem** e os diffs ficam limpos:
uma mudança de verdade não fica escondida no meio de vinte linhas que só mudaram de indentação.

A configuração está em `.prettierrc`:

```json
{ "singleQuote": true, "trailingComma": "all", "endOfLine": "auto" }
```

E o `.prettierignore` marca o que ele **não** deve tocar — principalmente `.agents/`, que contém a
documentação do Prisma instalada por terceiros. Reformatar conteúdo de terceiros transforma todo
upgrade deles num conflito de merge.

Dois scripts:

| Comando                | O que faz                                    |
| ---------------------- | -------------------------------------------- |
| `npm run format`       | reescreve o repositório inteiro              |
| `npm run format:check` | só verifica e reprova — é o que a CI executa |

### Commitlint e Conventional Commits

O **Commitlint** (`@commitlint/cli@21`) valida a **mensagem** do commit contra um padrão chamado
**Conventional Commits**:

```
tipo(escopo opcional): descrição curta

corpo opcional explicando o porquê

rodapé opcional
```

Exemplos válidos neste repositório:

```
feat(auth): add refresh token rotation
fix: stop commitlint from rejecting Dependabot's own commits
docs: fold the pipeline and the branch rules into CLAUDE.md
ci: add the GitHub Actions pipeline
```

Os tipos aceitos estão listados explicitamente em `commitlint.config.js`: `feat`, `fix`, `docs`,
`style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

**Por que isso importa?** Um histórico padronizado é legível por máquina. Dá para gerar changelog
automático, descobrir a próxima versão semântica, e filtrar "todas as correções desde a última
entrega". Um histórico com "ajustes", "correções finais" e "agora vai" não permite nada disso.

Duas regras próprias do projeto merecem explicação:

- **`subject-case`** rejeita descrição em maiúscula inicial (`Adiciona coisa`) mas **não** exige
  tudo minúsculo — porque o vocabulário deste projeto é cheio de siglas: CI/CD, RLS, JWT, WASM,
  GHCR.
- **`ignores` do Dependabot.** O robô de atualização de dependências escreve
  `Bump @eslint/js from 9.39.5 to 10.0.1` — maiúscula inicial, que a regra acima rejeitaria — e não
  permite configurar o texto. Sem a isenção, todo PR dele nasceria vermelho. A isenção é feita pelo
  rodapé `Signed-off-by: dependabot[bot]`, não pela palavra "Bump", porque um humano pode
  legitimamente escrever "Bump" e deve continuar sendo reprovado.

### O furo desta camada, e como ele é tapado

Todos os hooks locais são contornáveis:

```bash
git commit --no-verify -m "mensagem qualquer"
```

Isso pula os dois hooks. É por isso que **as mesmas verificações se repetem na CI**, onde não
existe `--no-verify`. A camada local existe para dar retorno rápido; a camada remota existe para
ser inescapável. Elas são redundantes de propósito.

---

## 4. Camada 2 — Os três níveis de teste

### Por que três, e não um só

Um teste que reprova precisa dizer **onde** olhar. Se todos os testes fizerem tudo — subir a
aplicação, abrir o banco, disparar HTTP —, uma falha não distingue "a regra de negócio está
errada" de "o banco não subiu".

Separando por **o que cada nível pode tocar**, a própria falha localiza o problema:

| Nível          | Comando             | Toca o quê                         | Precisa de Docker? | Velocidade |
| -------------- | ------------------- | ---------------------------------- | ------------------ | ---------- |
| **unitário**   | `npm run test:unit` | nada — só mocks                    | não                | ~1s        |
| **integração** | `npm run test:int`  | PostgreSQL real, sem HTTP          | sim                | ~1s        |
| **e2e**        | `npm run test:e2e`  | HTTP contra a aplicação de verdade | sim                | ~1s        |

Um teste unitário vermelho aponta para uma função. Um teste de integração vermelho aponta para uma
consulta ou para o schema. Um e2e vermelho aponta para o encanamento entre eles — rota, pipe de
validação, serialização.

### Jest — o executor de testes

O **Jest** (`jest@30`) é quem encontra os arquivos de teste, executa, compara o resultado com o
esperado e imprime o relatório. É o padrão do ecossistema NestJS.

O **ts-jest** (`ts-jest@29`) é o adaptador que ensina o Jest a ler TypeScript. Bônus importante:
ele **checa os tipos** durante os testes. Por isso os arquivos em `test/` não precisam de uma
passagem separada de `tsc` na CI — rodar a suíte já os verifica.

### Supertest — HTTP de mentira, mas de verdade

O **Supertest** (`supertest@7`) dispara requisições HTTP reais contra a aplicação, sem precisar
abrir uma porta de rede nem ter um servidor rodando de verdade:

```ts
await request(app.getHttpServer()).get('/').expect(200).expect('Hello World!');
```

É o que torna o nível e2e possível: você testa a aplicação como um cliente a veria, com rotas,
middlewares, validação e códigos de status.

### As quatro configurações do Jest

```
test/jest.base.js         ← o que os três compartilham
├── test/jest-unit.js
├── test/jest-integration.js
└── test/jest-e2e.js
```

O `jest.base.js` guarda o que precisa ser igual nos três. Se a lista de exclusões de cobertura
estivesse copiada em três arquivos, uma mudança acabaria aplicada em dois e esquecida no terceiro.

Três decisões dentro dele que valem entender:

1. **`rootDir` é a raiz do repositório nos três**, e não `src/` em um e `test/` em outro. Um
   `rootDir` diferente por nível faria os caminhos nos relatórios de cobertura ficarem
   incomparáveis, e um dia seria impossível juntá-los num número único.
2. **`src/generated` fica fora da cobertura.** É código gerado pelo Prisma, do tamanho do código
   escrito à mão. Deixá-lo na conta afogaria o número real e reportaria sobre código que ninguém
   escreveu.
3. **Os arquivos são `.js`, não `.json`.** Configuração em JSON não aceita comentários, e o Jest
   imprime `Unknown option "$comment"` em toda execução se você tentar contrabandear documentação
   para dentro dele. Em `.js` dá para comentar à vontade.

E duas decisões específicas dos níveis com banco:

- **`maxWorkers: 1`** — é correção, não desempenho. Todos os arquivos compartilham **um** banco. Um
  segundo processo apagaria as linhas que o primeiro ainda está verificando.
- **`node --experimental-vm-modules`** — exigência do Prisma 7, cujo runtime usa `import()`
  dinâmico, que o Jest recusa por padrão. É por isso que `test:int` e `test:e2e` invocam o Jest por
  um caminho esquisito em vez de chamar o binário direto.

### O banco de teste efêmero

Este é um dos pontos mais importantes de todo o guia.

Os testes de integração **apagam e recriam dados** (`TRUNCATE`). Se apontassem para o banco de
desenvolvimento, rodar a suíte destruiria o que você estivesse construindo à mão.

Por isso existe um segundo ambiente, completamente separado, em `docker-compose.test.yml`:

|                     | Desenvolvimento (`docker-compose.yml`) | Teste (`docker-compose.test.yml`)                   |
| ------------------- | -------------------------------------- | --------------------------------------------------- |
| PostgreSQL          | porta **5432**                         | porta **5433**                                      |
| Redis               | porta **6379**                         | porta **6380**                                      |
| Dados               | volume em disco, persistem             | **`tmpfs`** — vivem em RAM e morrem com o container |
| Arquivo de ambiente | `.env` (não versionado)                | `.env.test` (**versionado**)                        |

Três detalhes com história:

- **`tmpfs`** faz o banco viver na memória. Sobe rápido e cada execução começa de um banco
  garantidamente vazio. O `PGDATA` aponta para uma **subpasta** porque o `initdb` do PostgreSQL
  recusa um diretório com permissão `1777`, que é como um `tmpfs` é montado.
- **`.env.test` é versionado de propósito.** As credenciais só chegam a containers descartáveis, e
  a CI precisa dos mesmos valores sem passar por um cofre de secrets. Por isso o `.gitignore`, que
  ignora `.env.*`, tem uma exceção explícita: `!.env.test`.
- **O Redis sobe com `--maxmemory-policy noeviction`** nos dois ambientes. O BullMQ guarda o estado
  das filas no Redis, e se o Redis descartar uma chave no meio do caminho para liberar memória, a
  fila corrompe.

**O que mantém os testes longe do banco de desenvolvimento** é uma única variável nos scripts:

```
DOTENV_CONFIG_PATH=.env.test
```

Sem ela, os testes leriam o `.env` normal. Essa variável é o chokepoint deste nível.

### `src/app.setup.ts` — o chokepoint da configuração

Um teste e2e só prova alguma coisa se testar a aplicação **como ela roda em produção**. Se
`src/main.ts` registrar um pipe de validação global e o teste montar a aplicação sem ele, o teste
está verificando um programa que não existe.

A solução é ter **uma** função que configura a aplicação, chamada pelos dois lados:

```
src/app.setup.ts  →  configureApp(app)
    ├── chamado por src/main.ts            (produção)
    └── chamado por test/utils/create-test-app.ts  (e2e)
```

Registrar algo só no `main.ts` passa a ser impossível de esquecer, porque não existe outro lugar
onde registrar. Existe até um teste unitário (`src/app.setup.spec.ts`) que verifica se o
`ValidationPipe` global continua registrado.

É o mesmo princípio do chokepoint de tenancy em `src/tenancy/`, aplicado à configuração.

### Cobertura de testes

**Cobertura** é a porcentagem de linhas do seu código que foram executadas durante os testes.
`npm run test:cov` gera o relatório em `coverage/`.

Cuidado com a interpretação: cobertura alta não significa testes bons. Significa apenas que aquelas
linhas rodaram — não que alguém verificou se o resultado estava certo. Cobertura baixa, por outro
lado, é informação sólida: aquelas linhas **ninguém** testou.

Hoje o número do projeto é 11,1%, e isso é esperado — o repositório ainda é um scaffold. Por isso o
`coverageThreshold` (um piso mínimo obrigatório) está anotado como pendência futura: qualquer piso
hoje reprovaria o build por um motivo falso.

---

## 5. Camada 3 — O empacotamento (Docker)

### O que é uma imagem, e por que usar uma

Uma **imagem Docker** é um pacote que contém a aplicação **e** tudo de que ela precisa para rodar:
o Node.js na versão certa, as dependências, os arquivos compilados. Um **container** é uma execução
dessa imagem.

O ganho é acabar com o "na minha máquina funciona". A imagem que passou nos testes é bit a bit a
imagem que vai para o servidor.

### O build multi-stage

O `Dockerfile` do projeto tem **dois estágios**, e a razão é tamanho.

Para _construir_ a aplicação você precisa do compilador TypeScript, do gerador do Prisma, do CLI do
Nest — centenas de megabytes de ferramenta. Para _rodar_ a aplicação, nada disso é necessário.

```
┌─ estágio "builder" ───────────────────┐
│ npm ci        (tudo, inclusive dev)   │
│ prisma generate                       │
│ npm run build → dist/                 │
│ npm ci --omit=dev --omit=peer         │
└───────────────────────────────────────┘
                  ↓ copia só dist/ e node_modules
┌─ estágio "runner" ────────────────────┐
│ node:24-alpine                        │
│ usuário node (não-root)               │
│ CMD ["node", "dist/main"]             │
└───────────────────────────────────────┘
```

O primeiro estágio é **descartado** no final. Só o que for explicitamente copiado sobrevive.

### A poda que levou 778 MB a 406 MB

Um multi-stage feito de forma direta produzia 778 MB. Investigando, descobriu-se que
`@prisma/client@7` declara `prisma` e `typescript` como _peers opcionais_ — e o npm instala peers
opcionais mesmo com `--omit=dev` **e** `--omit=peer`. Isso arrastava o CLI do Prisma e, junto dele,
a interface inteira do Prisma Studio (`react-dom`, `effect`, `elkjs`) e as engines binárias
antigas.

Some a isso que o `@prisma/client` embute compiladores WebAssembly para **cinco** bancos de dados,
em duas variantes de tamanho e dois formatos de módulo. Este projeto usa PostgreSQL e CommonJS.

O `Dockerfile` remove tudo isso explicitamente. Resultado: **406 MB**.

Só que apagar arquivos de uma biblioteca é uma aposta: eles carregam **sob demanda**, então uma
poda errada não quebra no boot — quebra na primeira consulta real, em produção.

### `scripts/docker-smoke.js` — o que impede a poda de ser uma aposta

É um script minúsculo, embarcado na imagem, que roda contra um banco de verdade:

```js
await prisma.$queryRaw`SELECT 1 AS ok`; // exercita o adapter e a conexão
const tenants = await prisma.tenant.count(); // exercita o compilador WASM
```

A segunda linha é a essencial: `$queryRaw` sozinho não aciona o compilador de consultas, que é
justamente a parte que a poda toca. A CI roda esse script depois de **todo** build. Se um upgrade
do Prisma invalidar a poda, quem descobre é a pipeline, não o cliente.

### Boot test — a lição de um bug real

A CI também sobe a imagem e faz um `curl localhost:3000`. Isso parece redundante com o smoke test,
mas cobre um caso que ele não cobre.

Durante a implementação, apareceu um defeito assustador: por causa de um cache incremental do
TypeScript gravado fora da pasta que o build limpa, **um build limpo emitia zero arquivos e saía
com código de sucesso**. O `COPY` de uma pasta `dist/` vazia não dá erro nenhum. A imagem seria
construída, publicada, e só falharia ao subir.

O smoke test do Prisma não pegaria isso, porque ele executa `node scripts/docker-smoke.js`, não
`dist/main`. Só um boot de verdade pega.

### `.dockerignore`

Lista o que **não** entra no contexto do build. Mantém a imagem pequena e, mais importante, mantém
segredo fora dela: `.env` e `.env.*` estão bloqueados — inclusive o `.env.test`, porque uma imagem
de produção jamais deve carregar configuração apontando para um banco de teste.

### GHCR — onde a imagem fica guardada

O **GitHub Container Registry** é a prateleira de imagens do GitHub. Depois de um push na `main`, a
imagem deste projeto fica em:

```
ghcr.io/brunocbarbosa/nexusops_backend:latest
ghcr.io/brunocbarbosa/nexusops_backend:sha-42c8a0c
```

São **duas tags para a mesma imagem**, com propósitos diferentes:

- **`latest`** — sempre a mais recente. Conveniente, mas ambígua: `latest` de hoje não é `latest` de
  ontem.
- **`sha-42c8a0c`** — o commit exato que a produziu. É essa que torna um rollback possível: você
  sabe precisamente qual código está rodando, e pode voltar para a anterior sem adivinhação.

---

## 6. Camada 4 — A pipeline no GitHub Actions

### O que é o GitHub Actions

É o serviço de automação embutido no GitHub. Você descreve, num arquivo YAML dentro de
`.github/workflows/`, o que deve acontecer quando certos eventos ocorrem. O GitHub aluga uma
máquina virtual limpa (aqui, `ubuntu-latest`), executa os passos e reporta o resultado.

Três termos:

- **workflow** — um arquivo `.yml`. Este projeto tem dois: `ci.yml` e `codeql.yml`.
- **job** — uma unidade que roda numa máquina própria. Jobs rodam **em paralelo** por padrão.
- **step** — um comando dentro de um job, executado em sequência.

### Quando a pipeline dispara

```yaml
on:
  pull_request:
    branches: [development, main]
  push:
    branches: [development, main]
```

Em PR **e** em push. O PR cobre o caminho normal; o push cobre o que chega por outros caminhos —
um merge, uma edição pela interface do GitHub.

Há também um bloco `concurrency`, que cancela a execução anterior quando uma nova começa na mesma
referência. Sem ele, uma sequência rápida de commits enfileira builds que ninguém vai ler.

### Os sete jobs

```
        ┌──────────────────┬───────────┬───────────┬─────────┐
  em    │ guard-main-source│ commitlint│  quality  │  test   │  ← em paralelo
paralelo└──────────────────┴───────────┴───────────┴─────────┘
        ┌─────────┐
        │  audit  │
        └─────────┘
                              ↓ (quality e test verdes)
                       ┌──────────┐   ┌────────┐
                       │  docker  │   │ sonar  │ (depende de test)
                       └──────────┘   └────────┘
```

---

#### 1. `guard-main-source` — o porteiro da `main`

**O que faz:** reprova qualquer Pull Request para a `main` que não venha da `development`.

**Por que existe:** os rulesets do GitHub sabem exigir que exista um PR, mas **não sabem restringir
de qual branch ele vem**. Sem este job, qualquer branch poderia abrir PR direto para a `main` e o
ruleset aprovaria. Este job é a única imposição real da regra.

Dois detalhes de implementação que valem como aprendizado:

- Ele **roda sempre**, mesmo quando não é um PR para a `main` (nesse caso sai com sucesso
  imediatamente). Se ele fosse pulado com um `if:` no nível do job, o GitHub reportaria "pulado",
  que num status check obrigatório conta como neutro. Num porteiro, "passou" e "nem rodou" não
  podem ser indistinguíveis.
- O nome da branch chega ao script por uma **variável de ambiente**, não interpolado direto no
  comando. Quem abre o PR escolhe o nome da branch; uma branch chamada `$(rm -rf /)` executaria no
  runner se fosse colada direto no shell.

#### 2. `commitlint` — as mensagens, de novo

**O que faz:** valida todas as mensagens de commit do PR, comparando com a branch de destino.

**Por que existe:** porque `git commit --no-verify` burla o hook local. Aqui não há como burlar.

Precisa de `fetch-depth: 0` no checkout — um clone raso não tem o ancestral comum necessário para
calcular o intervalo de commits.

#### 3. `quality` — estilo e tipos

Três verificações, sem alterar arquivo nenhum:

```bash
npx eslint "{src,test}/**/*.ts"          # lint, SEM --fix
npm run format:check                     # Prettier, só verifica
npx tsc --noEmit -p tsconfig.build.json  # compila sem gerar saída, só para checar tipos
```

`--noEmit` significa "compile para verificar, mas não escreva nada". Interessa saber se compila,
não o resultado.

Antes de tudo isso, dois passos obrigatórios: `npm ci` e **`npm run prisma:generate`**. O cliente
do Prisma é gerado em `src/generated/prisma`, que **não vai para o Git**. Sem gerá-lo, nada compila.

> `npm ci` (de _clean install_) é diferente de `npm install`: apaga o `node_modules`, instala
> exatamente as versões travadas no `package-lock.json` e falha se o lockfile estiver
> dessincronizado do `package.json`. É a instalação determinística, própria para CI.

#### 4. `test` — os três níveis

```bash
npm run test:setup      # sobe o compose de teste e aplica as migrations
npm run test:unit -- --coverage
npm run test:int
npm run test:e2e
```

Repare que ele chama exatamente os mesmos scripts que você roda na sua máquina. Isso é intencional:
a CI não tem uma receita própria que possa divergir da sua.

Ao final, publica a pasta `coverage/` como **artifact** — um arquivo que fica anexado à execução,
disponível para download e para outros jobs consumirem. É assim que o `sonar` recebe a cobertura.

> **Por que `docker compose` e não o `services:` do GitHub Actions?** O Actions tem um recurso
> nativo para subir bancos de dados auxiliares. Ele não foi usado por um motivo concreto:
> `services:` **não permite sobrescrever o comando** do container, e o Redis aqui precisa subir com
> `--maxmemory-policy noeviction`. Além disso, um arquivo de compose único serve os dois ambientes
> e impede que eles se distanciem com o tempo.

#### 5. `audit` — vulnerabilidades nas dependências

```bash
npm audit --audit-level=high
```

Consulta a base pública de vulnerabilidades do npm e reprova se encontrar algo de severidade alta
ou crítica.

Complementa o Dependabot em vez de duplicá-lo: o Dependabot **abre PRs** com correções, mas não
reprova build nenhum. Este job reprova. Um traz a solução, o outro impede que o problema seja
ignorado.

#### 6. `sonar` — análise profunda de qualidade

Envia o código ao **SonarCloud** (detalhado na próxima seção). Depende do job `test`, porque
precisa do relatório de cobertura.

A condição de execução guarda duas lições:

```yaml
if: vars.SONAR_ENABLED == 'true' && github.actor != 'dependabot[bot]'
```

- **`vars` e não `secrets`** — o contexto `secrets` não pode ser avaliado num `if:` de job. Por isso
  o liga/desliga é uma variável comum e não "existe token?".
- **`!= dependabot[bot]`** — PRs do Dependabot **não recebem os secrets normais** do Actions. Eles
  rodam contra um cofre separado, então `secrets.SONAR_TOKEN` chega vazio e o scanner morre com
  "Not authorized". As `vars` chegam, o que torna a falha bem confusa: o job roda porque
  `SONAR_ENABLED` está lá, e falha porque o token não está.

#### 7. `docker` — construir, testar, publicar

Depende de `quality` e `test`: não faz sentido empacotar código que não passou.

1. Sobe um banco efêmero (o smoke test precisa de um banco vivo).
2. Constrói a imagem com `load: true` — carrega no Docker local **sem publicar**.
3. **Boot test:** sobe o container e faz `curl localhost:3000`.
4. **Smoke test:** roda `scripts/docker-smoke.js` dentro da imagem, contra o banco.
5. **Só se for push na `main`:** faz login no GHCR e publica.

A ordem é o ponto: publicar antes de testar seria publicar no escuro. E o push é um `docker push`
sobre as tags já construídas, em vez de um segundo build — reconstruir para publicar significaria
publicar um artefato que não é exatamente o que passou nos testes.

```yaml
if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

Em PR a imagem é construída e testada, mas **não** publicada. O Dockerfile é código e quebra como
código; validá-lo em todo PR evita descobrir na hora da entrega.

### `.github/pull_request_template.md`

Um formulário que o GitHub preenche automaticamente ao abrir um PR. Tem um checklist curto com as
armadilhas específicas deste projeto — "nenhuma consulta com filtro de tenant escrito à mão",
"se entrou um model novo, foi registrado como escopado ou agnóstico?".

É a memória do projeto no lugar onde ela é útil, em vez de num documento que ninguém reabre.

---

## 7. Camada 5 — Segurança automatizada

Cinco mecanismos, com sobreposição pequena e proposital.

### CodeQL — análise estática de segurança

`.github/workflows/codeql.yml`, mantido pelo próprio GitHub.

O **CodeQL** trata o código como um banco de dados e executa consultas em cima dele, procurando
padrões de vulnerabilidade: dados vindos do usuário que chegam a uma consulta SQL sem tratamento,
caminhos de arquivo montados com entrada externa, comparação de senha suscetível a ataque de tempo.

Roda em PR, em push e **semanalmente** (segunda-feira, 04:12 UTC). O agendamento é o que pega
vulnerabilidade nova em código antigo: uma consulta publicada depois do merge nunca rodaria sobre
um arquivo que ninguém mais toca.

É gratuito porque o repositório é público — foi por isso que a Fase 0 do plano tornou o repositório
público.

### Dependabot — atualização de dependências

`.github/dependabot.yml`. Um robô que verifica semanalmente se há versões novas e abre um PR para
cada atualização.

Configurações do projeto que valem entender:

- **Dois ecossistemas:** `npm` (as bibliotecas) e `github-actions` (as próprias actions usadas nos
  workflows). O segundo é fácil de esquecer e foi exatamente ele que apontou a primeira
  vulnerabilidade real do repositório.
- **`target-branch: development`** — sem isso os PRs dele iriam para a `main` e seriam reprovados
  pelo `guard-main-source`. O robô se auto-sabotaria.
- **`commit-message.prefix`** — `build` para npm, `ci` para actions, senão todo PR dele reprova no
  `commitlint`.
- **Grupos** — um PR por família em vez de um por pacote. Sete PRs separados para sete pacotes do
  Nest é ruído.
- **`ignore` de major para `typescript` e `@types/node`** — aprendizado caro. O TypeScript precisa
  subir de major junto com o `ts-jest`, o `typescript-eslint` e o Nest; um PR automático que tentou
  ir para o TS 7 sozinho reprovou já no `npm ci`. E o `@types/node` tem que acompanhar o Node que o
  projeto **realmente roda** (24), senão o compilador aprova API que não existe em produção.

### Dependabot alerts e security updates

Diferentes do arquivo acima, e ligados nas configurações do GitHub:

- **Alerts** — avisam quando uma dependência que você já usa passa a ter vulnerabilidade conhecida.
- **Security updates** — abrem o PR de correção sozinhos, sem esperar o dia agendado.

Assim que foram ligados, apontaram uma vulnerabilidade **alta** que o job `audit` não via — porque
não era um pacote npm, e sim uma GitHub Action (`sonarqube-scan-action@v5`, com uma falha de
injeção de argumentos). Boa ilustração de que os dois se complementam: `npm audit` só enxerga npm.

### Secret scanning e push protection

- **Secret scanning** varre código, commits, issues e PRs procurando credenciais com formato
  reconhecível (token do GitHub, chave da AWS, chave privada SSH). Em chaves de parceiros ele
  notifica o **emissor**, que revoga sozinho — um token vazado num commit público costuma morrer em
  minutos.
- **Push protection** é a mesma detecção um passo antes: **bloqueia o `git push`** em vez de avisar
  depois. É a diferença entre "sua chave vazou" e "sua chave não vazou".

O terceiro interruptor, _non-provider patterns_, foi deixado **desligado** de propósito: ele pega
padrões genéricos, e marcaria o `.env.test` — que é versionado por design e contém apenas
credenciais descartáveis. Um alerta permanente sobre um não-problema é como as pessoas aprendem a
ignorar a lista de alertas inteira.

### SonarCloud — qualidade contínua

Plataforma externa (gratuita para projetos públicos) que faz uma análise mais profunda do que um
linter: complexidade, duplicação, cobertura, e uma classificação de manutenibilidade.

O conceito central dele é o **Quality Gate**: um conjunto de condições que o código precisa cumprir.
O detalhe inteligente é que o gate mede **código novo**, não o projeto inteiro:

| Condição                           | Limite |
| ---------------------------------- | ------ |
| Cobertura do código novo           | ≥ 80%  |
| Duplicação no código novo          | ≤ 3%   |
| Confiabilidade / segurança do novo | nota A |

Isso permite melhorar um projeto legado de forma incremental: você não precisa cobrir 80% de tudo
que já existe, só do que está escrevendo agora.

Quatro configurações no GitHub fazem o job funcionar:

| Nome                 | Tipo     | Para quê                           |
| -------------------- | -------- | ---------------------------------- |
| `SONAR_TOKEN`        | _secret_ | credencial de envio                |
| `SONAR_ENABLED`      | variável | liga/desliga o job                 |
| `SONAR_PROJECT_KEY`  | variável | identifica o projeto no SonarCloud |
| `SONAR_ORGANIZATION` | variável | identifica a organização           |

Só o token é segredo. Os outros três são identificadores públicos, e precisam ser variáveis porque
o job os lê na condição `if:`.

> ⚠️ **Automatic Analysis tem que ficar desligado.** O SonarCloud liga sozinho um modo de análise
> automática ao importar o projeto, e ele **recusa** análise vinda de CI enquanto estiver ativo. Além
> disso, o modo automático varre o repositório inteiro — incluindo documentação de terceiros —
> enquanto o job usa `sonar.sources=src`. Foi a diferença entre "23 vulnerabilidades" e "0".

---

## 8. Camada 6 — As regras de branch

### As duas branches

| Branch        | Papel                                                               |
| ------------- | ------------------------------------------------------------------- |
| `development` | branch principal de trabalho; é a branch **default** do repositório |
| `main`        | histórico estável; só recebe da `development`                       |

### Rulesets

Um **ruleset** é o conjunto de regras que o GitHub aplica a uma branch. Existem dois:

**`main-protected`**

- exige Pull Request (com 0 aprovações — o projeto tem um desenvolvedor só)
- exige `quality`, `test` e `guard-main-source` verdes
- bloqueia force-push e deleção
- **sem bypass** — nem administrador escapa

**`development-protected`**

- exige Pull Request
- exige `quality` e `test` verdes
- bloqueia force-push e deleção
- **sem bypass**

**Consequência prática:** `git push origin development` é **rejeitado**. Todo trabalho sai de uma
branch de feature e entra por PR.

> **Por que a `development` também exige PR?** O plano original queria commit direto nela _e_
> status checks obrigatórios. Descobriu-se durante a execução que os dois não coexistem: no GitHub,
> exigir status check bloqueia também o push direto, porque o commit chega sem check e é rejeitado.
> Escolheu-se o rigor — é o que cumpre o critério "um PR com teste quebrado não pode ser mesclado
> em nenhuma das duas branches".

### Força-bruta bloqueada

- **force-push** reescreve o histórico e pode apagar o trabalho de outra pessoa. Bloqueado.
- **deleção** da branch. Bloqueado.

### Merge commit ou squash?

| Situação                          | Método     | Por quê                                                   |
| --------------------------------- | ---------- | --------------------------------------------------------- |
| branch de feature → `development` | **squash** | a branch é descartável; vira um commit limpo              |
| `development` → `main`            | **merge**  | as duas são permanentes e precisam continuar relacionadas |

O segundo caso não é gosto pessoal. Um merge commit faz o histórico da `development` virar
ancestral da `main`, e a base de comparação entre as duas avança. Com squash, a `main` ganha um
commit que **não** tem a `development` como ancestral: a base de comparação fica parada, e o
próximo PR entre elas reapresenta todos os commits antigos como se fossem novos.

---

## 9. O fluxo do dia a dia

### Preparar a máquina (uma vez)

```bash
npm install               # instala tudo e configura os hooks do Husky
npm run prisma:generate   # gera o client em src/generated/prisma
npm run infra:up          # sobe o Postgres e o Redis de desenvolvimento
npm run prisma:migrate    # aplica as migrations
```

### Trabalhar numa mudança

```bash
git checkout development
git pull origin development
git checkout -b feat/nome-da-feature     # sempre uma branch nova

# ... escreve o código ...

npm run test:unit                        # retorno rápido, sem Docker
npm run test:setup                       # sobe o banco efêmero e migra
npm run test:all                         # os três níveis
```

### Commitar

```bash
git add .
git commit -m "feat(tickets): add optimistic locking on update"
```

Nesse instante, sem você pedir:

1. `pre-commit` → `lint-staged` → ESLint nos `.ts` em stage, Prettier nos demais
2. `commit-msg` → Commitlint valida a mensagem

Se qualquer um reprovar, o commit não acontece.

### Abrir o PR

```bash
git push -u origin feat/nome-da-feature
gh pr create --base development
```

A pipeline dispara. Acompanhar:

```bash
gh pr checks          # o estado de cada job
gh run watch          # acompanhar em tempo real
```

Com tudo verde:

```bash
gh pr merge --squash --delete-branch
```

### Promover para a `main`

```bash
gh pr create --base main --head development
gh pr merge --merge          # merge commit, nunca squash
```

O push na `main` dispara o `docker`, que publica a imagem no GHCR.

### Comandos de referência

```bash
# testes
npm run test:unit         # nível 1 — sem Docker
npm run test:int          # nível 2 — precisa do banco efêmero
npm run test:e2e          # nível 3 — precisa do banco efêmero
npm run test:all          # os três em sequência
npm run test:cov          # cobertura do nível unitário

# banco efêmero de teste
npm run infra:test:up     # sobe (portas 5433/6380)
npm run test:setup        # sobe e aplica as migrations
npm run infra:test:down   # derruba e apaga os volumes

# banco de desenvolvimento
npm run infra:up / infra:down / infra:reset / infra:logs

# qualidade
npm run lint              # ATENÇÃO: reescreve arquivos
npx eslint "src/**/*.ts"  # só verifica
npm run format            # reescreve
npm run format:check      # só verifica — é o que a CI roda

# build e imagem
npm run build             # gera dist/
npm run start:prod        # roda o dist/
npm run docker:build      # constrói a imagem localmente
```

---

## 10. Quando algo fica vermelho

### O commit é recusado localmente

**"subject must not be sentence-case"** — a descrição começa com maiúscula. Use
`feat: adiciona x`, não `feat: Adiciona x`.

**"type must be one of..."** — o tipo não está na lista. Consulte `commitlint.config.js`.

**ESLint reclamando de formatação** — rode `npm run lint` (com `--fix`) e commite de novo.

### O job `quality` falha

| Erro                               | Solução                                         |
| ---------------------------------- | ----------------------------------------------- |
| Prettier reprova                   | `npm run format` e commite                      |
| ESLint reprova                     | `npm run lint` e revise o que ele não corrigiu  |
| `tsc` reprova                      | erro de tipo real — precisa ser corrigido à mão |
| "Cannot find module .../generated" | faltou `npm run prisma:generate`                |

### O job `test` falha

Reproduza localmente com o mesmo ambiente que a CI usa:

```bash
npm run infra:test:down    # começa de um banco limpo
npm run test:setup
npm run test:all
```

Se passar na sua máquina e falhar na CI, suspeite de **ordem de execução** ou de dado deixado para
trás por um teste anterior. É por isso que existe `maxWorkers: 1`.

### O job `guard-main-source` falha

Só acontece em PR para a `main`. A mensagem é literal:

```
main only accepts pull requests from development
```

Não é bug: feche esse PR, leve a mudança para a `development` primeiro, e abra o PR de lá.

### O job `docker` falha

- **falhou no boot** — a aplicação não sobe. Teste local: `npm run build && npm run start:prod`.
- **falhou no smoke do Prisma** — provavelmente um upgrade do Prisma invalidou a poda do
  `Dockerfile`. É preciso revisar quais arquivos estão sendo removidos.

### O job `sonar` falha

- **"Not authorized or project not found"** — token ausente ou chaves erradas. Se for um PR do
  Dependabot, é esperado e o job deveria estar pulando.
- **"Automatic Analysis is enabled"** — desligue-a nas configurações do projeto no SonarCloud.

### Não consigo dar push na `development`

Correto, é o desenho. Crie uma branch e abra um PR.

---

## 11. Glossário

**Artifact** — arquivo produzido por um job e guardado pelo GitHub, para download ou para outro job
consumir. Aqui, o relatório de cobertura.

**Chokepoint** — ponto obrigatório de passagem, que aplica uma regra sem depender de alguém lembrar.
O conceito central de todo este projeto.

**CI / CD** — Integração Contínua (verificar a cada mudança) / Entrega Contínua (empacotar
automaticamente o que passou).

**Container** — uma execução de uma imagem Docker.

**Conventional Commits** — padrão de mensagem de commit no formato `tipo(escopo): descrição`.

**Cobertura** — porcentagem de linhas do código executadas durante os testes.

**Dependabot** — robô do GitHub que abre PRs atualizando dependências.

**e2e** — _end to end_. Teste que exercita o sistema inteiro, como um cliente o usaria.

**Efêmero** — que existe só durante a execução e some depois. O banco de teste é efêmero.

**GHCR** — GitHub Container Registry, a prateleira de imagens Docker do GitHub.

**Hook** — script que o Git executa sozinho em momentos específicos.

**Imagem** — pacote com a aplicação e tudo de que ela precisa para rodar.

**Job** — unidade de trabalho da pipeline, executada numa máquina própria.

**Linter** — ferramenta que lê o código sem executá-lo e aponta problemas.

**Lockfile** — `package-lock.json`. Trava as versões exatas de tudo que foi instalado.

**Merge base** — o commit ancestral comum entre duas branches, usado para calcular o que é "novo".

**Multi-stage build** — Dockerfile com estágios; o de construção é descartado e só o resultado é
copiado para o final.

**Peer dependency** — dependência que um pacote espera que **você** instale. _Opcional_ quando ele
funciona sem ela — e o npm instala assim mesmo, que foi a origem dos 372 MB extras na imagem.

**Pipeline** — a esteira de verificações automatizadas.

**Pull Request** — pedido de incorporar o trabalho de uma branch em outra.

**Quality Gate** — conjunto de condições do SonarCloud que o código novo precisa cumprir.

**Ruleset** — conjunto de regras que o GitHub aplica a uma branch.

**Runner** — a máquina virtual onde um job roda.

**Secret** — valor sensível guardado criptografado pelo GitHub, disponível aos workflows. Nunca
aparece no log.

**Smoke test** — verificação mínima de que a coisa funciona minimamente. Origem: ligar o aparelho e
ver se sai fumaça.

**Squash** — juntar todos os commits de uma branch num só na hora do merge.

**Status check** — resultado de um job reportado ao PR. Obrigatório = bloqueia o merge se vermelho.

**Tenant** — cliente/empresa dentro do sistema multi-tenant. Isolar tenants é o motivo de tudo isto
existir.

**Variável (`vars`)** — valor de configuração não sensível, legível em condições `if:` de job.

**Workflow** — arquivo YAML descrevendo uma automação.
