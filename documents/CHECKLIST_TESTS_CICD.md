# Checklist — Infraestrutura de Testes e CI/CD

Acompanhamento item a item da implementação. O plano completo — com o porquê de cada decisão,
a tabela de correções ao `ROTEIRO_TESTS.md` e as notas de **Como saiu** de cada fase concluída —
está em [`PLANO_TESTS_CICD.md`](./PLANO_TESTS_CICD.md).

Marcar cada item ao concluir. Cada fase termina com verificação + commit + checkpoint.

**Regra de execução:** implementar → rodar a verificação da fase e mostrar a saída real →
marcar aqui → commit → parar e perguntar antes da próxima fase.

---

## Fase 0 — Branch e visibilidade

- [x] Auditoria de segredos no histórico do git (`.env` nunca rastreado; sem padrões `ghp_`,
      `AKIA…`, `BEGIN PRIVATE KEY`, `xox…`, `sk-…`)
- [x] Branch `development` criada a partir da `main` e enviada para o remoto
- [x] `development` definida como branch default do repositório
- [x] Repositório tornado público (libera CodeQL, rulesets e SonarCloud no plano Free)

---

## Fase 1 — Padronização local (Husky + Commitlint + lint-staged)

- [x] Dependências instaladas: `husky`, `@commitlint/cli`, `@commitlint/config-conventional`,
      `lint-staged`
- [x] `commitlint.config.js` com `config-conventional` e os tipos usados no repo
      (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`)
- [x] `.husky/commit-msg` → `npx --no -- commitlint --edit "$1"`
- [x] `.husky/pre-commit` → `npx lint-staged`
- [x] Bloco `lint-staged` no `package.json`: `*.ts` → `eslint --fix` (o eslint-plugin-prettier
      já formata; encadear `prettier --write` faria os dois brigarem); `*.{json,md,yml,yaml}`
      → `prettier --write`
- [x] Script `"prepare": "husky || true"` — o `|| true` é obrigatório, senão `npm ci` no build
      Docker (sem `.git`) falha
- [x] **Verificação:** commit com mensagem fora do padrão é rejeitado

---

## Fase 2 — Três níveis de teste

### Estrutura

- [x] `test/integration/` e `test/e2e/` e `test/utils/` criados
- [x] `test/prisma.e2e-spec.ts` → `test/integration/prisma-wiring.int-spec.ts`
- [x] `test/tenant-isolation.e2e-spec.ts` → `test/integration/tenant-isolation.int-spec.ts`
- [x] `test/app.e2e-spec.ts` → `test/e2e/app.e2e-spec.ts`
- [x] Os dois specs de integração alterados **apenas** no caminho de import — são as regressões
      que travam o design de tenancy

### Configurações Jest

- [x] `test/jest-unit.js` — `testMatch: src/**/*.spec.ts`, sem `setupFiles`, roda sem Docker
- [x] `test/jest-integration.js` — `testMatch: test/integration/**/*.int-spec.ts`,
      `setupFiles: ["dotenv/config"]`, `maxWorkers: 1`
- [x] `test/jest-e2e.js` — `testMatch: test/e2e/**/*.e2e-spec.ts`,
      `setupFiles: ["dotenv/config"]`, `maxWorkers: 1`
- [x] Os três herdam de `test/jest.base.js` (`rootDir: ".."`, transform e exclusão de
      `src/generated/`). Configs em `.js`, não `.json`: o Jest emite
      `Unknown option "$comment"` em toda execução se a documentação for embutida em JSON
- [x] Bloco `jest` inline removido do `package.json`

### Scripts

- [x] `test`, `test:unit`, `test:int`, `test:e2e`, `test:all`, `test:cov`
- [x] `test:int` e `test:e2e` rodam sob `node --experimental-vm-modules` (exigência do Prisma 7)
      e com `DOTENV_CONFIG_PATH=.env.test`

### Chokepoint de configuração da app

- [x] `src/app.setup.ts` com `configureApp(app: INestApplication): void`
- [x] `src/main.ts` chama `configureApp`
- [x] `test/utils/create-test-app.ts` chama `configureApp` — garante que o e2e testa a mesma
      configuração que roda em produção
- [x] `test/utils/reset-database.ts` — TRUNCATE de todas as tabelas de domínio, com a lista
      lida do `pg_tables` em vez de fixa (uma lista fixa envelhece em silêncio ao adicionar
      um model)
- [x] `src/app.setup.spec.ts` — prova que o `ValidationPipe` global continua registrado
- [x] `test/e2e/app.e2e-spec.ts` reescrito sobre `createTestApp`, com asserção extra de 404

### Verificação

- [x] `npm run test:unit` verde sem Docker
- [x] `npm run test:int` verde (mesmo resultado de antes da mudança)
- [x] `npm run test:e2e` verde
- [x] `npm run test:cov` e `grep -c "generated/prisma" coverage/lcov.info` retorna `0`

---

### Antecipado da Fase 3 (sem banco efêmero não há como verificar esta fase)

- [x] `docker-compose.test.yml` — portas `5433`/`6380`, Postgres em `tmpfs` com
      `PGDATA` em subdiretório (initdb recusa um data dir 1777), Redis com
      `noeviction`, healthchecks para permitir `--wait`
- [x] `.env.test` commitado e `!.env.test` no `.gitignore`
- [x] Scripts `infra:test:up`, `infra:test:down`, `test:setup`

## Fase 3 — Build de produção e imagem Docker

> O ambiente efêmero (`docker-compose.test.yml`, `.env.test`, scripts `infra:test:*`) foi
> antecipado para a Fase 2: sem banco não havia como verificar os três níveis de teste.

- [x] **Correção do build:** `rootDir: "./src"` e `exclude: ["prisma.config.ts"]` em
      `tsconfig.build.json` — hoje `nest build` emite `dist/src/main.js` e `start:prod`
      (`node dist/main`) está quebrado
- [x] `Dockerfile` multi-stage (builder: `npm ci` → `prisma generate` → `build`;
      runner: `npm ci --omit=dev`, `dist/` + `prisma/`, usuário não-root)
- [x] `.dockerignore`
- [x] **Poda do runtime:** `prisma` e `typescript` são _optional peers_ de
      `@prisma/client@7` e sobrevivem a `--omit=dev` **e** a `--omit=peer`, arrastando
      Prisma Studio (`effect`, `@electric-sql`, `react-dom`, `elkjs`) e as engines
      binárias legadas. Removidos explicitamente, junto dos compiladores WASM de todos
      os providers exceto PostgreSQL: **778MB → 406MB**
- [x] `scripts/docker-smoke.js` embutido na imagem — instancia o cliente e roda
      `$queryRaw` + `tenant.count()`. É o que impede a poda de virar uma alegação não
      verificada: os arquivos removidos carregam sob demanda, então uma poda errada só
      aparece na primeira query real, nunca no boot
- [x] **`tsBuildInfoFile` fixado dentro de `dist/`** — efeito colateral do `rootDir`:
      o tsc passou a gravar o cache incremental na raiz, fora do que o `deleteOutDir`
      limpa. Um build limpo emitia zero arquivos e saía com código 0

### Verificação

- [x] `npm run build && test -f dist/main.js` e `node dist/main` sobe na porta 3000
- [x] `docker build -t nexusops-backend:local .` e o container responde em `curl localhost:3000`
- [x] Container roda como `uid=1000(node)`, não root
- [x] `docker build --no-cache` reproduz os 406MB e o smoke do Prisma passa
- [x] Três builds limpos seguidos emitem `dist/main.js` (guarda do bug do `.tsbuildinfo`)

---

## Fase 4 — Pipeline GitHub Actions

- [x] `.github/workflows/ci.yml` com gatilho em PR **e** push para `development` e `main`
- [x] Os jobs que compilam (`quality`, `test`) rodam `npm ci` + **`npm run prisma:generate`**
      antes de qualquer outra coisa (`src/generated/prisma` é gitignored — sem isso nada
      compila). `guard-main-source`, `commitlint`, `audit` e `docker` não compilam e não
      geram o client
- [x] Job `guard-main-source` — falha PR para `main` vindo de branch != `development`
      (rulesets do GitHub não restringem a branch de origem; este job é a única imposição real).
      Roda sempre, sem `if:` no nível do job, para publicar uma conclusão real em toda execução
- [x] Job `commitlint` — valida os commits do PR (o hook local é burlável com `--no-verify`)
- [x] Job `quality` — `eslint` sem `--fix`, `prettier --check`, `tsc --noEmit`
- [x] Job `test` — sobe `docker-compose.test.yml` via `npm run test:setup`, aplica as
      migrations, roda os três níveis, publica `coverage/` como artifact
- [x] Job `audit` — `npm audit --audit-level=high`
- [x] Job `sonar` — escrito e condicionado a `vars.SONAR_ENABLED == 'true'`
- [x] Job `docker` — build em todo PR, `push` só em push na `main`, tags `latest` e `sha-<short>`
- [x] Job `docker` — a imagem sobe e responde em `localhost:3000` (guarda do bug do
      `.tsbuildinfo`: um `dist/` vazio passa pelo `COPY` sem erro) e o
      `scripts/docker-smoke.js` roda contra um banco vivo (guarda da poda do Prisma)
- [x] `.github/workflows/codeql.yml` — `javascript-typescript`, em PR + push + semanal
- [x] `.github/dependabot.yml` — `npm` e `github-actions`, semanal, apontando para a
      `development` e com prefixos de commit que passam no commitlint
- [x] `.github/pull_request_template.md`

### Correções de base exigidas pelo job `quality`

- [x] `.prettierignore` — as skills vendorizadas do Prisma (`.agents/`, e os symlinks
      `.claude/` e `.windsurf/`), `src/generated/`, `dist/`, `coverage/`, `package-lock.json`
      e os arquivos que o `prisma format` governa. Sem isso o `prettier --check` reprovava em
      66 arquivos que não são deste projeto
- [x] `prettier --write` nos 6 arquivos do projeto que reprovavam (`CLAUDE.md`, `README.md`,
      `documents/MAIN.md`, `documents/DATABASE_MODEL.md`, `prisma.config.ts`,
      `eslint.config.mjs` e o spec em `docs/`)
- [x] Scripts `format` (`prettier --write .`) e `format:check` (`prettier --check .`) — o
      `format` antigo cobria só `src/` e `test/`, então nunca teria detectado o que a CI detecta

### Verificação

- [x] `actionlint` sem erros nos dois workflows
- [x] `npx eslint "{src,test}/**/*.ts"`, `npm run format:check` e
      `npx tsc --noEmit -p tsconfig.build.json` verdes (o job `quality` inteiro, local)
- [x] `npm run test:setup` + os três níveis verdes (o job `test` inteiro, local)
- [x] `npm audit --audit-level=high` → `found 0 vulnerabilities`
- [x] `npx commitlint --from <ref> --to HEAD --verbose` → `0 problems`
- [x] Passos do job `docker` rodados localmente: boot + `curl localhost:3000` → `Hello World!`
      e `docker run ... node scripts/docker-smoke.js` → `raw=1, tenant.count=0`
- [ ] **Pendente do PR:** confirmar os jobs verdes numa execução real do GitHub Actions
      (só observável depois do push — fecha junto com a Fase 5)

---

## Fase 5 — Proteção de branch

- [x] Ruleset `main-protected` (id `21113502`) — exige PR (0 aprovações, dev solo),
      `dismiss_stale_reviews_on_push`, status checks `quality` / `test` / `guard-main-source`,
      bloqueia force-push e deleção, `bypass_actors: []`
- [x] Ruleset `development-protected` (id `21113511`) — **exige PR** com status checks
      `quality` / `test`, bloqueia force-push e deleção, `bypass_actors: []`
- [x] Ambos com `strict_required_status_checks_policy: false` — exigir a branch atualizada
      transformaria cada merge numa rebase de todos os PRs abertos do Dependabot

> **Desvio decidido com o usuário.** O plano pedia, para a `development`, status checks
> obrigatórios **e** commit direto liberado. Os dois não coexistem: no GitHub, exigir status check
> bloqueia também o push direto, porque o commit chega sem check e é rejeitado. Escolhido exigir
> PR e checks nas duas branches — é o que cumpre o critério de aceite ("um PR com teste quebrado
> não pode ser mergeado em nenhuma das duas"). Consequência prática: todo trabalho passa a sair de
> uma branch de feature, e nem o admin escapa (`bypass_actors` vazio).

### Verificação

- [x] PR de branch qualquer → `development` (#5): CI verde nos sete jobs, incluindo
      `guard-main-source` passando (não é PR para a `main`)
- [x] PR de branch qualquer → `main` (#6): `guard-main-source` falha com
      _"main only accepts pull requests from development"_ e o GitHub reporta
      `mergeStateStatus: BLOCKED`
- [x] PR `development` → `main` passa

---

## Fase 6 — Documentação

- [x] `documents/ROTEIRO_TESTS.md` — cabeçalho apontando para este checklist e para a tabela
      de correções (corpo original preservado como registro da visão)
- [x] `CLAUDE.md` — caminho `test/prisma.e2e-spec.ts` (citado 2× como guarda de regressão do
      Prisma 7) atualizado para `test/integration/prisma-wiring.int-spec.ts`
- [x] `CLAUDE.md` — seção de comandos com os novos scripts (`test:unit` / `test:int` /
      `test:all`, `infra:test:*`, `test:setup`, `format:check`)
- [x] `CLAUDE.md` — seção **Three test tiers**: a tabela dos três níveis, o porquê do `rootDir`
      compartilhado e das configs em `.js`, e o `.env.test` como única coisa que mantém as suítes
      fora do banco de desenvolvimento
- [x] `CLAUDE.md` — seção **CI and branch flow** (extra, não prevista no plano): um agente que
      não souber do `guard-main-source` desperdiça um PR descobrindo

---

## Passos manuais (fora do escopo automatizável)

- [x] Criar conta no SonarCloud e vincular o repositório
      (`brunocbarbosa` / `brunocbarbosa_NexusOps_backend`)
- [x] Cadastrar `SONAR_TOKEN` em _Settings → Secrets and variables → Actions → Secrets_
- [x] Definir as variáveis de repositório `SONAR_ENABLED=true`, `SONAR_PROJECT_KEY` e
      `SONAR_ORGANIZATION` — o job lê as três de `vars`, nada está fixo no workflow
- [x] **Desligar o _Automatic Analysis_** no SonarCloud (projeto → Administration → Analysis
      Method). Não estava previsto: o SonarCloud liga sozinho ao importar o projeto, e recusa
      análise vinda de CI enquanto ele estiver ativo. Também é o que produzia as 23
      "vulnerabilidades" que a análise da CI reporta como 0 — o Automatic Analysis varre o
      repositório inteiro, incluindo as skills vendorizadas do Prisma, enquanto o job usa
      `sonar.sources=src`
- [x] Habilitar _Dependabot alerts_ e _security updates_ em _Settings → Code security_
      (confirmado: `dependabot_security_updates: enabled`, `/vulnerability-alerts` → 204)
- [ ] Decidir o destino do PR #2 (`typescript@7`): reprovado por incompatibilidade real de peer
      com `ts-jest@29`, não por defeito do pipeline. Fica vermelho até o ts-jest suportar TS 7

### Verificação da integração com o SonarCloud

- [x] `sonar` sai do `skipping` e roda: `EXECUTION SUCCESS`, análise publicada no PR #8
- [x] Quality gate `OK` — `new_coverage` 100% (limite 80), duplicação 0% (limite 3),
      0 bugs / 0 vulnerabilidades / 0 hotspots
- [x] A cobertura chega mesmo: `Sensor JavaScript/TypeScript Coverage` lê
      `coverage/lcov.info` baixado do artifact do job `test`

> A cobertura do **projeto** fica em 11,1% e isso não é defeito: o repo ainda é scaffold e o
> denominador é quase só `src/tenancy/`. O gate mede `new_coverage`, não o total — ver
> `coverageThreshold` em Pendências futuras.

---

## Pendências futuras

- [ ] `coverageThreshold` no Jest — só faz sentido quando existirem módulos de domínio;
      hoje o repo é scaffold e qualquer piso reprovaria
- [ ] Papel de baixo privilégio para RLS (`DATABASE_URL_APP`) provisionado no
      `docker-compose.test.yml`, com testes que provem que as policies barram cross-tenant.
      Depende de a camada RLS existir (ver `CLAUDE.md` → Architecture)
- [ ] Merge dos relatórios de cobertura dos três níveis num único `lcov` para o Sonar
- [ ] Job de deploy consumindo a imagem do GHCR
- [ ] Subir `SonarSource/sonarqube-scan-action` de `@v5` para `@v6` — a própria ação avisa em
      toda execução que a v5 não é mais suportada e contém uma vulnerabilidade. O Dependabot
      abre esse PR sozinho na próxima segunda
- [ ] Considerar ligar _secret scanning_ e _push protection_ (grátis em repo público, hoje
      `disabled`). A auditoria da Fase 0 varreu o histórico uma vez; isto varreria continuamente
- [ ] Reconsiderar `commitlint` como status check obrigatório — hoje é o único job cujo defeito
      não bloqueia merge nenhum, o que enfraquece o argumento de que ele existe porque
      `--no-verify` burla o hook local
