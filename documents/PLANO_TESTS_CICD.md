# Infraestrutura de Testes e CI/CD — NexusOps Backend

> **Plano de implementação.** O acompanhamento item a item vive em
> [`CHECKLIST_TESTS_CICD.md`](./CHECKLIST_TESTS_CICD.md); o `ROTEIRO_TESTS.md` é a visão
> original, e a tabela de correções abaixo registra onde ele diverge deste repositório.
>
> | Fase                                  | Estado       | Commit    |
> | ------------------------------------- | ------------ | --------- |
> | 0 — Branch e visibilidade             | ✅ concluída | `56b74ff` |
> | 1 — Husky + Commitlint + lint-staged  | ✅ concluída | `62a811f` |
> | 2 — Três níveis de teste              | ✅ concluída | `7ac02e6` |
> | 3 — Build de produção e imagem Docker | ✅ concluída | `2830bee` |
> | 4 — Pipeline GitHub Actions           | ✅ concluída | `4672b6b` |
> | 5 — Proteção de branch                | ⬜ pendente  | —         |
> | 6 — Documentação                      | ⬜ pendente  | —         |
>
> As seções das fases concluídas trazem uma nota **Como saiu** ao final, com os desvios
> em relação ao que estava planejado e os defeitos encontrados durante a execução.

## Context

O NexusOps tem hoje uma fundação arquitetural sólida (tenancy chokepoint, Prisma 7 wiring,
schema com FKs compostas) mas **nenhuma rede de proteção automatizada**: não existe `.github/`,
os testes de banco rodam contra o PostgreSQL de desenvolvimento (apagando dados reais), o Jest
tem uma configuração única que ignora `test/`, e a `main` aceita push direto.

Isso é insustentável no momento em que os módulos de domínio começarem a ser escritos. As
garantias de isolamento entre tenants — o motivo de existir do projeto — só valem se forem
verificadas a cada mudança. Um vazamento de tenant introduzido por refatoração e não detectado
anula todo o design documentado no `CLAUDE.md`.

O objetivo é estabelecer, **antes** do primeiro módulo de domínio: um fluxo de branches com a
`development` como principal, três níveis de teste com fronteiras claras, um ambiente de banco
efêmero isolado do de desenvolvimento, e uma pipeline no GitHub Actions que roda tudo isso em
todo PR. O `documents/ROTEIRO_TESTS.md` é o ponto de partida; este plano corrige as divergências
apontadas na análise e preenche as lacunas específicas deste repositório.

**Decisões já tomadas com o usuário:**

- Repositório passa a ser **público** (libera CodeQL, rulesets e SonarCloud gratuitos).
- Segurança GitHub-native primeiro; SonarCloud fica escrito mas condicionado a uma variável.
- Dockerfile agora; `docker push` para o GHCR apenas em push na `main`.
- Três níveis de teste: unit / integration / e2e.
- Branch `development` criada e proteção da `main` configurada via `gh`.

---

## Regra de execução — checkpoint por fase

**Ao final de cada fase, parar e perguntar antes de seguir para a próxima.** Nenhuma fase começa
sem aprovação explícita da anterior. O ciclo de cada fase é:

1. Implementar os arquivos da fase.
2. Rodar a verificação correspondente daquela fase (a seção **Verificação** no final indica qual
   comando cobre cada uma) e mostrar a saída real — não afirmar que passou sem evidência.
3. Marcar os itens da fase em `documents/CHECKLIST_TESTS_CICD.md`.
4. Fazer commit da fase (Conventional Commits, na branch `development`).
5. **Parar e perguntar se pode seguir.**

Exceção de ordem: o `documents/CHECKLIST_TESTS_CICD.md` (Fase 6) é criado **antes** da Fase 1, com
tudo desmarcado, para servir de acompanhamento durante todas as fases. O restante da Fase 6
(ajustes em `ROTEIRO_TESTS.md` e `CLAUDE.md`) fica no fim, na ordem normal.

---

## Correções ao ROTEIRO_TESTS.md

Estas são as divergências que o plano resolve. O roteiro ganha um cabeçalho apontando para o
checklist como fonte de verdade executável; o texto original permanece como registro da visão.

| #     | Roteiro diz                           | Realidade deste repo                                                                                                                                   |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4     | Gatilho em push/PR na `main`          | `development` é a principal → gatilho em PR e push para `development` **e** `main`                                                                     |
| 3 / 7 | Compose local + `services` do Actions | `services` não aceita `command:`, e o Redis **precisa** de `--maxmemory-policy noeviction`. Um `docker-compose.test.yml` único serve os dois ambientes |
| 6     | SonarCloud + Snyk                     | Snyk é redundante com Dependabot. Sonar fica condicionado a `vars.SONAR_ENABLED`                                                                       |
| 8     | Só `prisma migrate deploy`            | `src/generated/prisma` é gitignored → `prisma generate` precisa vir **antes** de lint/build/testes, senão nada compila                                 |
| 8     | "rode a suíte de testes"              | Testes de banco exigem `node --experimental-vm-modules` (Prisma 7). Nunca `npx jest` direto                                                            |
| 2     | "separe unit de e2e"                  | Config atual tem `rootDir: "src"` → nada em `test/` roda no `npm test`. Precisa de três configs                                                        |
| 1     | Husky + Commitlint                    | Sem `lint-staged` o hook só valida a mensagem, não o código. E `--no-verify` burla → job de commitlint também na CI                                    |
| 9     | Build Docker                          | Não existe `Dockerfile`. E `npm run start:prod` está quebrado (ver abaixo)                                                                             |
| —     | _(ausente)_                           | `collectCoverageFrom: ["**/*.(t                                                                                                                        | j)s"]`varre`src/generated/prisma` e distorce a cobertura |

**Bug pré-existente descoberto:** `prisma.config.ts` na raiz do projeto entra no programa do tsc
e puxa o `rootDir` inferido para a raiz. `nest build` emite `dist/src/main.js`, mas
`start:prod` é `node dist/main`. Verificado: `dist/main.js` não existe. O Dockerfile herdaria o
bug, então a correção entra na Fase 3.

---

## Fase 0 — Branch e visibilidade

Ações que alteram o repositório remoto. Confirmar cada uma antes de executar.

1. Auditoria de segredos antes de tornar público — **já executada em modo leitura**: `.env` nunca
   foi rastreado em nenhum commit, e a varredura por padrões conhecidos (`ghp_`, `AKIA…`,
   `BEGIN PRIVATE KEY`, `xox…`) em todo o histórico não retornou nada fora de `.agents/`
   (documentação vendor). Re-confirmar imediatamente antes do flip.
2. `git checkout -b development && git push -u origin development`
3. `gh repo edit --visibility public --accept-visibility-change-consequences`
4. `gh repo edit --default-branch development`

Ordem importa: a branch precisa existir antes de virar default, e o repo precisa ser público
antes dos rulesets funcionarem no plano Free.

**Como saiu.** Sem desvios. A auditoria confirmou que `.env` nunca foi rastreado e que nenhum
padrão conhecido de segredo (`ghp_`, `github_pat_`, `AKIA…`, `BEGIN PRIVATE KEY`, `xox…`, `sk-…`)
aparece em qualquer commit fora de `.agents/` (documentação vendor do Prisma). O único arquivo
sensível rastreado é o `.env.example`, com placeholders.

---

## Fase 1 — Padronização local (Husky + Commitlint + lint-staged)

Dependências: `husky`, `@commitlint/cli`, `@commitlint/config-conventional`, `lint-staged`.

**Arquivos:**

- `commitlint.config.js` — estende `config-conventional`. Tipos permitidos alinhados ao histórico
  atual do repo (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`).
- `.husky/commit-msg` → `npx --no -- commitlint --edit "$1"`
- `.husky/pre-commit` → `npx lint-staged`
- `package.json`: bloco `lint-staged` → `"*.ts": ["eslint --fix", "prettier --write"]`;
  script `"prepare": "husky || true"`.

O `|| true` no `prepare` é obrigatório: sem ele o `npm ci` dentro do build Docker (onde não há
`.git`) falha.

**Como saiu.** Três desvios.

`lint-staged` manda `*.ts` só para `eslint --fix`, sem encadear `prettier --write`. O
`eslint-plugin-prettier` já aplica a formatação como regra de lint; os dois em sequência reescrevem
o mesmo arquivo com configurações levemente diferentes. Prettier ficou para `*.{json,md,yml,yaml}`,
que o eslint não cobre.

`.prettierrc` ganhou `endOfLine: "auto"`. O `eslint.config.mjs` já forçava isso na regra
`prettier/prettier`, mas o `.prettierrc` usava o default `lf` — `eslint --fix` aceitava CRLF
enquanto `prettier --check` exigia LF, o que deixaria o job `quality` vermelho num checkout WSL
sem defeito real.

`commitlint.config.js` lista o `type-enum` explicitamente em vez de só herdar do
`config-conventional`, e força `subject-case: lower-case`.

Verificado com os quatro casos rodados de verdade — mensagem sem tipo, tipo inventado e subject em
maiúscula rejeitados (`exit=1`); mensagem convencional aceita — mais um `git commit` real barrado
pelo hook com o HEAD intacto.

---

## Fase 2 — Três níveis de teste

### Estrutura de arquivos

```
test/
  jest-unit.json          # src/**/*.spec.ts        — mocks, sem Docker
  jest-integration.json   # test/integration/**/*.int-spec.ts — Prisma real, sem HTTP
  jest-e2e.json           # test/e2e/**/*.e2e-spec.ts        — Supertest contra a app
  integration/
    prisma-wiring.int-spec.ts     # movido de test/prisma.e2e-spec.ts
    tenant-isolation.int-spec.ts  # movido de test/tenant-isolation.e2e-spec.ts
  e2e/
    app.e2e-spec.ts               # movido de test/app.e2e-spec.ts
  utils/
    create-test-app.ts            # fábrica da app Nest para e2e
    reset-database.ts             # TRUNCATE entre arquivos de teste
```

`prisma-wiring.int-spec.ts` e `tenant-isolation.int-spec.ts` **não podem ser alterados** além do
caminho de import (`../src/…` → `../../src/…`) — são as regressões que travam o design de tenancy.

### Configurações Jest

Todas com `rootDir: ".."` e `testMatch` explícito (em vez de `rootDir: "src"` + `testRegex`), para
que os caminhos de cobertura fiquem coerentes entre os três. Todas as três excluem
`src/generated/` de `collectCoverageFrom` e `coveragePathIgnorePatterns`.

- **unit** — sem `setupFiles`, roda sem Docker, é o que `npm test` executa.
- **integration** e **e2e** — `setupFiles: ["dotenv/config"]` e `maxWorkers: 1`. O serial é
  necessário: os testes compartilham um único banco e o `tenant-isolation` já depende de estado
  semeado em `beforeAll`.

Rodar sob `node --experimental-vm-modules` nos dois níveis que tocam o Prisma.

### Scripts em `package.json`

```
test          → test:unit
test:unit     → jest --config ./test/jest-unit.json
test:int      → DOTENV_CONFIG_PATH=.env.test node --experimental-vm-modules … --config ./test/jest-integration.json
test:e2e      → DOTENV_CONFIG_PATH=.env.test node --experimental-vm-modules … --config ./test/jest-e2e.json
test:all      → test:unit && test:int && test:e2e
test:cov      → test:unit --coverage
```

`DOTENV_CONFIG_PATH` é lido nativamente pelo `dotenv/config` — é o que redireciona os testes para
o banco efêmero em vez do de desenvolvimento.

### `src/app.setup.ts` — chokepoint de configuração da app

Extrair a configuração da aplicação (hoje inexistente, amanhã o `ValidationPipe` global que o
`CLAUDE.md` registra como pendente) para `configureApp(app: INestApplication): void`, chamado
tanto por `src/main.ts` quanto por `test/utils/create-test-app.ts`.

Sem isso, o e2e testa uma app configurada diferente da que roda em produção — e o primeiro
teste de `400 Bad Request` que o roteiro cita (passo 8) passaria ou falharia pelo motivo errado.
Mesma lógica de chokepoint que o projeto já aplica na tenancy.

**Como saiu.** Três desvios.

As configs viraram `.js` em vez de `.json`, herdando de um `test/jest.base.js` compartilhado. O
Jest imprime `Unknown option "$comment"` a cada execução quando a documentação vai embutida num
config JSON, e o raciocínio por trás dessas escolhas vale mais que a extensão do arquivo. O base
compartilhado eliminou também a triplicação entre os três níveis.

`src/app.setup.ts` já registra o `ValidationPipe` global (`whitelist` + `forbidNonWhitelisted` +
`transform`), que o `CLAUDE.md` listava como pendente. Sem ele o chokepoint existiria vazio, e o
teste de `400 Bad Request` do passo 8 do roteiro passaria por acidente. Acompanha
`src/app.setup.spec.ts`, que falha se o pipe deixar de ser registrado.

`docker-compose.test.yml` e `.env.test` foram antecipados da Fase 3: sem banco efêmero não havia
como verificar esta fase. Custou uma iteração descobrir que o Postgres em `tmpfs` recusa iniciar
porque o mount vem como `1777` — a saída é apontar `PGDATA` para um subdiretório que o `initdb`
cria com as permissões que ele mesmo exige.

Resultado medido: 3 + 20 + 2 testes verdes nos três níveis; `grep -c "generated/prisma"
coverage/lcov.info` retorna `0` e o lcov cobre exatamente os 6 arquivos escritos à mão; o banco de
desenvolvimento reporta 0 tenants após a suíte completa; e com o stack de teste derrubado o nível
de integração falha com `Can't reach database server at 127.0.0.1:5433` — nomeando a porta de
teste, o que prova que não existe fallback silencioso para o banco de dev.

Os dois specs de tenancy diferem dos originais por exatamente quatro linhas de import, verificado
com `diff` contra os blobs em `HEAD`.

---

## Fase 3 — Ambiente de teste efêmero e build

> O `docker-compose.test.yml`, o `.env.test` e os scripts `infra:test:*` acabaram
> antecipados para a Fase 2, porque sem banco efêmero não havia como verificar os três
> níveis de teste. Ficam descritos aqui, onde foram planejados.

**`docker-compose.test.yml`** — arquivo único, usado localmente e na CI:

- Portas `5433` / `6380`, nomes `nexusops-postgres-test` / `nexusops-redis-test`. Isolamento total
  do compose de desenvolvimento: rodar testes deixa de apagar dados locais.
- Postgres com `tmpfs: /var/lib/postgresql/data` — sem volume, sobe limpo e rápido.
- Redis com o mesmo `--maxmemory-policy noeviction` do compose de dev (BullMQ).
- Healthchecks nos dois, para permitir `docker compose up -d --wait`.

**`.env.test`** — commitado (credenciais descartáveis), com `DATABASE_URL` na porta 5433,
`REDIS_PORT=6380`, `JWT_SECRET` fixo. Exige adicionar `!.env.test` ao `.gitignore`, que hoje
ignora `.env.*`.

**Scripts:** `infra:test:up` (`up -d --wait`), `infra:test:down` (`down -v`),
`test:setup` (up + `prisma migrate deploy` apontando para o `.env.test`).

**Correção do build** — em `tsconfig.build.json`: adicionar `"rootDir": "./src"` em
`compilerOptions` e `"prisma.config.ts"` ao `exclude`. Isso faz `nest build` emitir `dist/main.js`
e conserta `npm run start:prod`.

**`Dockerfile` multi-stage** + **`.dockerignore`**:

- _builder_ (`node:24-alpine`): `npm ci` → `npx prisma generate` → `npm run build`
- _runner_ (`node:24-alpine`): `npm ci --omit=dev`, copia `dist/`, `prisma/` (schema + migrations,
  para `migrate deploy` no deploy), usuário não-root, `CMD ["node", "dist/main"]`
- O adapter `pg` é JS puro, então não há binário de engine do Prisma para casar com musl — alpine
  serve sem `libssl`. O client gerado são 13 arquivos `.ts` e nenhum asset binário, verificado —
  o `tsc` compila tudo, não é preciso configurar `assets` no `nest-cli.json`.

**Como saiu.** A imagem ficou em **406 MB**, contra os 778 MB que um multi-stage direto produz. A
diferença não são devDependencies — `--omit=dev` as remove corretamente. `@prisma/client@7` declara
`prisma` e `typescript` como peers **opcionais**, e um peer opcional de dependência de produção
sobrevive tanto a `--omit=dev` quanto a `--omit=peer`; a CLI então arrasta o front-end do Prisma
Studio (`effect`, `@electric-sql`, `react-dom`, `elkjs`) e as engines binárias legadas. Somado a
isso, `@prisma/client/runtime` embarca compiladores WASM em base64 para cinco providers, em duas
variantes de tamanho e dois formatos de módulo, onde este projeto usa PostgreSQL e CommonJS.

Ambos são removidos explicitamente. Isso só é defensável porque os arquivos removidos carregam sob
demanda: uma poda errada falharia na primeira query real, nunca no boot. `scripts/docker-smoke.js`
roda dentro da imagem contra um banco vivo e executa `$queryRaw` **mais** uma query de modelo, que
é o que aciona o compilador WASM. A CI passa a rodá-lo depois de cada build, então um upgrade do
Prisma que invalide a poda falha ali em vez de em produção.

**Dois defeitos encontrados durante a fase**, ambos pré-existentes ou introduzidos pelo próprio
conserto:

1. `npm run start:prod` nunca funcionou. `prisma.config.ts` na raiz entrava no programa do tsc e
   puxava o `rootDir` inferido junto — o build ia para `dist/src/main.js` enquanto o script
   apontava para `dist/main`.
2. Consertar isso moveu o `.tsbuildinfo`. O tsc deriva esse caminho do `rootDir`, então fixá-lo em
   `./src` levou o cache incremental para a raiz do repositório, fora de tudo que o `nest build`
   limpa. O `deleteOutDir` apagava `dist/` enquanto o cache sobrevivia insistindo que o build
   estava atualizado: **um build limpo emitia zero arquivos e saía com código 0**, e um
   `docker build` teria produzido uma imagem vazia sem sinal nenhum. `tsBuildInfoFile` agora aponta
   para dentro de `dist/`, de modo que o cache morre junto com a saída que ele descreve. Verificado
   com três builds limpos consecutivos.

---

## Fase 4 — Pipeline `.github/workflows/ci.yml`

```yaml
on:
  pull_request:
    branches: [development, main]
  push:
    branches: [development, main]
```

**Jobs** (todos com `actions/setup-node@v4`, `node-version: 24`, `cache: npm`; todos rodam
`npm ci` e **`npm run prisma:generate`** antes de qualquer coisa):

1. **`guard-main-source`** — só em PR para `main`. Falha se `github.head_ref != 'development'`.
   Os rulesets do GitHub não sabem restringir a branch de _origem_ de um PR; este job é a única
   forma real de impor "main só recebe da development".
2. **`commitlint`** — só em PR. `npx commitlint --from origin/${{ github.base_ref }} --to HEAD`.
   Existe porque `git commit --no-verify` burla o hook local.
3. **`quality`** — `npx eslint "{src,test}/**/*.ts"` (**sem `--fix`**, read-only),
   `npx prettier --check`, `npx tsc --noEmit -p tsconfig.build.json`.
4. **`test`** — `docker compose -f docker-compose.test.yml up -d --wait` →
   `npx prisma migrate deploy` → `npm run test:unit -- --coverage` → `npm run test:int` →
   `npm run test:e2e`. Publica `coverage/` como artifact.
5. **`audit`** — `npm audit --audit-level=high`. Complementa o Dependabot (que abre PR mas não
   reprova build).
6. **`sonar`** — `if: vars.SONAR_ENABLED == 'true'`, `needs: [test]`. Escrito e desligado; liga
   quando a conta existir. Variável de repositório em vez de secret porque o contexto `secrets`
   não é confiável em `if` de job.
7. **`docker`** — `needs: [quality, test]`. Faz build da imagem em **todo** PR (valida o
   Dockerfile), mas `push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`.
   Tags `latest` e `sha-<short>` em `ghcr.io/brunocbarbosa/nexusops_backend`.

**Arquivos adicionais:**

- `.github/workflows/codeql.yml` — `github/codeql-action`, linguagem `javascript-typescript`,
  em PR + agendamento semanal.
- `.github/dependabot.yml` — ecossistemas `npm` e `github-actions`, semanal.
- `.github/pull_request_template.md` — checklist curto de PR.

**Como saiu.** Os sete jobs e os três arquivos auxiliares saíram como planejado. Quatro desvios,
todos por um motivo específico:

1. **`prisma generate` só nos jobs que compilam.** O plano dizia "todos os jobs"; a justificativa
   real é "`src/generated/prisma` é gitignored e sem ele nada compila", o que só se aplica a
   `quality` e `test`. `commitlint` lê mensagens de commit, `audit` resolve o `package-lock.json`,
   `guard-main-source` é um `if` de shell, e o `docker` gera o client dentro da própria imagem.
   Rodar o generator nos quatro seriam ~80s por execução sem nenhum consumidor.
2. **`guard-main-source` roda sempre, sem `if:` no nível do job.** Um job pulado publica conclusão
   _neutra_ no status check obrigatório, e num guard a diferença entre "passou" e "nem rodou" é
   exatamente o que não pode ser ambíguo. O job roda em toda execução e sai 0 quando não é um PR
   para a `main`. Pelo mesmo motivo de segurança, `head_ref` chega ao script via `env:` em vez de
   interpolado: nome de branch é escolhido por quem abre o PR, e `$(...)` num nome executaria no
   runner.
3. **O job `docker` ganhou dois testes que o plano não previa**, e o primeiro é o mais importante:
   a imagem sobe e responde em `localhost:3000`. É a guarda de CI do defeito do `.tsbuildinfo`
   encontrado na Fase 3 — um `dist/` vazio passa pelo `COPY` do Dockerfile sem erro nenhum, e o
   smoke do Prisma roda `node scripts/docker-smoke.js`, não `dist/main`, então não pegaria isso.
   O segundo é o smoke do Prisma, que a Fase 3 já previa.
   O build usa `load: true` e o push é um `docker push` separado sobre as mesmas tags, em vez de
   um segundo `build-push-action`: publicar depois de testar, e publicar bit a bit o artefato que
   foi testado.
4. **O `prettier --check` do job `quality` exigiu consertar a base antes.** Ele reprovava em 72
   arquivos. 66 eram as skills vendorizadas do Prisma (`.agents/`, com `.claude/` e `.windsurf/`
   apontando para lá) — conteúdo upstream, versionado pelo `skills-lock.json`, que reformatado
   transformaria todo upgrade de skills num conflito de merge. Daí o `.prettierignore`. Os 6
   restantes eram arquivos do projeto e foram formatados. O script `format` cobria só
   `src/` e `test/`, ou seja, nunca teria detectado o que a CI detecta; virou `prettier --write .`
   com um `format:check` simétrico, que é o que o job chama.

O `.github/dependabot.yml` também precisou de duas coisas que o plano não menciona e sem as quais
ele se auto-sabota: `target-branch: development` (um PR do Dependabot para a `main` seria reprovado
pelo próprio `guard-main-source`) e `commit-message.prefix` (`build` para npm, `ci` para actions),
senão todo PR dele reprova no job de `commitlint`.

**Verificado localmente antes do push:** `actionlint` limpo nos dois workflows; o job `quality`
inteiro (`eslint` sem `--fix`, `format:check`, `tsc --noEmit`); o job `test` inteiro
(`test:setup` + os três níveis: 3 unit, 20 integration, 2 e2e); `npm audit --audit-level=high`
com 0 vulnerabilidades; `commitlint` num intervalo real de commits; e os dois passos novos do job
`docker` contra a imagem local — boot respondendo `Hello World!` e
`prisma smoke ok: raw=1, tenant.count=0`. O que só é observável depois do push é a execução real
no GitHub Actions, que fecha junto com a Fase 5.

---

## Fase 5 — Proteção de branch

Via `gh api` (funciona após a Fase 0 tornar o repo público):

- **Ruleset `main-protected`** — alvo `main`: exige PR, `required_approving_review_count: 0`
  (dev solo), `dismiss_stale_reviews_on_push`, status checks obrigatórios
  (`quality`, `test`, `guard-main-source`), bloqueia force-push e deleção.
- **Ruleset `development-protected`** — alvo `development`: status checks `quality` e `test`,
  bloqueia force-push e deleção. Sem exigência de PR, para permitir commit direto durante
  desenvolvimento.

---

## Fase 6 — Documentação

- **`documents/CHECKLIST_TESTS_CICD.md`** (novo) — o entregável pedido. Todas as fases acima como
  itens `- [ ]`, agrupados por fase, com uma seção de "Passos manuais" (criar conta SonarCloud,
  definir `vars.SONAR_ENABLED`) e outra de "Pendências futuras" (`coverageThreshold` quando
  existirem módulos de domínio; papel RLS `DATABASE_URL_APP` no compose de teste; merge de
  cobertura entre os três níveis para o Sonar). Atualizado a cada fase concluída.
- **`documents/ROTEIRO_TESTS.md`** — cabeçalho curto apontando para o checklist e para a tabela de
  correções. Não reescrever o corpo.
- **`CLAUDE.md`** — atualizar: os caminhos `test/prisma.e2e-spec.ts` (citado duas vezes como guarda
  de regressão do Prisma 7) para `test/integration/prisma-wiring.int-spec.ts`; a lista de comandos
  com os novos scripts; e a nota sobre os três níveis e o `.env.test`.

---

## Verificação

Cada bloco pertence a uma fase — rodar o bloco correspondente antes do checkpoint daquela fase,
não tudo no final. Blocos 1–3 fecham a Fase 2, blocos 4–5 a Fase 3, o bloco 6 a Fase 1, e o
bloco 7 as Fases 4 e 5.

```bash
# 1. Ambiente efêmero sobe e migra
npm run infra:test:up
npx dotenv -e .env.test -- npx prisma migrate deploy   # ou o script test:setup

# 2. Os três níveis passam
npm run test:unit      # sem Docker
npm run test:int       # tenant-isolation + prisma-wiring, verdes como antes da mudança
npm run test:e2e       # supertest GET / → 200 "Hello World!"

# 3. Cobertura ignora o client gerado
npm run test:cov && grep -c "generated/prisma" coverage/lcov.info   # deve ser 0

# 4. Build de produção conserta o start:prod
npm run build && test -f dist/main.js && node dist/main   # sobe na porta 3000

# 5. Imagem Docker
docker build -t nexusops-backend:local .
docker run --rm -p 3000:3000 --env-file .env nexusops-backend:local
curl -f localhost:3000

# 6. Hooks locais
git commit -m "mensagem invalida"   # deve ser rejeitado pelo commitlint

# 7. Pipeline
#   abrir PR de uma branch qualquer → development e confirmar todos os jobs verdes
#   abrir PR de uma branch qualquer → main e confirmar que guard-main-source falha
#   abrir PR development → main e confirmar que passa
```

O critério de aceite final: um PR para `main` vindo de branch diferente de `development` é
bloqueado, e um PR com teste quebrado não pode ser mergeado em nenhuma das duas branches.
