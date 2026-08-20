# Checklist — Infraestrutura de Testes e CI/CD

Fonte de verdade executável para a implementação descrita em `ROTEIRO_TESTS.md`.
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

- [ ] Dependências instaladas: `husky`, `@commitlint/cli`, `@commitlint/config-conventional`,
      `lint-staged`
- [ ] `commitlint.config.js` com `config-conventional` e os tipos usados no repo
      (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`)
- [ ] `.husky/commit-msg` → `npx --no -- commitlint --edit "$1"`
- [ ] `.husky/pre-commit` → `npx lint-staged`
- [ ] Bloco `lint-staged` no `package.json`: `"*.ts": ["eslint --fix", "prettier --write"]`
- [ ] Script `"prepare": "husky || true"` — o `|| true` é obrigatório, senão `npm ci` no build
      Docker (sem `.git`) falha
- [ ] **Verificação:** commit com mensagem fora do padrão é rejeitado

---

## Fase 2 — Três níveis de teste

### Estrutura

- [ ] `test/integration/` e `test/e2e/` e `test/utils/` criados
- [ ] `test/prisma.e2e-spec.ts` → `test/integration/prisma-wiring.int-spec.ts`
- [ ] `test/tenant-isolation.e2e-spec.ts` → `test/integration/tenant-isolation.int-spec.ts`
- [ ] `test/app.e2e-spec.ts` → `test/e2e/app.e2e-spec.ts`
- [ ] Os dois specs de integração alterados **apenas** no caminho de import — são as regressões
      que travam o design de tenancy

### Configurações Jest

- [ ] `test/jest-unit.json` — `testMatch: src/**/*.spec.ts`, sem `setupFiles`, roda sem Docker
- [ ] `test/jest-integration.json` — `testMatch: test/integration/**/*.int-spec.ts`,
      `setupFiles: ["dotenv/config"]`, `maxWorkers: 1`
- [ ] `test/jest-e2e.json` — `testMatch: test/e2e/**/*.e2e-spec.ts`,
      `setupFiles: ["dotenv/config"]`, `maxWorkers: 1`
- [ ] Os três com `rootDir: ".."` e `src/generated/` fora de `collectCoverageFrom` e
      `coveragePathIgnorePatterns`
- [ ] Bloco `jest` inline removido do `package.json`

### Scripts

- [ ] `test`, `test:unit`, `test:int`, `test:e2e`, `test:all`, `test:cov`
- [ ] `test:int` e `test:e2e` rodam sob `node --experimental-vm-modules` (exigência do Prisma 7)
      e com `DOTENV_CONFIG_PATH=.env.test`

### Chokepoint de configuração da app

- [ ] `src/app.setup.ts` com `configureApp(app: INestApplication): void`
- [ ] `src/main.ts` chama `configureApp`
- [ ] `test/utils/create-test-app.ts` chama `configureApp` — garante que o e2e testa a mesma
      configuração que roda em produção
- [ ] `test/utils/reset-database.ts` (TRUNCATE entre arquivos de teste)

### Verificação

- [ ] `npm run test:unit` verde sem Docker
- [ ] `npm run test:int` verde (mesmo resultado de antes da mudança)
- [ ] `npm run test:e2e` verde
- [ ] `npm run test:cov` e `grep -c "generated/prisma" coverage/lcov.info` retorna `0`

---

## Fase 3 — Ambiente de teste efêmero e build

- [ ] `docker-compose.test.yml` — portas `5433`/`6380`, containers `nexusops-*-test`,
      Postgres em `tmpfs`, Redis com `--maxmemory-policy noeviction`, healthchecks nos dois
- [ ] `.env.test` commitado (credenciais descartáveis, `DATABASE_URL` na 5433, `REDIS_PORT=6380`)
- [ ] `!.env.test` adicionado ao `.gitignore` (que hoje ignora `.env.*`)
- [ ] Scripts `infra:test:up`, `infra:test:down`, `test:setup`
- [ ] **Correção do build:** `rootDir: "./src"` e `exclude: ["prisma.config.ts"]` em
      `tsconfig.build.json` — hoje `nest build` emite `dist/src/main.js` e `start:prod`
      (`node dist/main`) está quebrado
- [ ] `Dockerfile` multi-stage (builder: `npm ci` → `prisma generate` → `build`;
      runner: `npm ci --omit=dev`, `dist/` + `prisma/`, usuário não-root)
- [ ] `.dockerignore`

### Verificação

- [ ] `npm run infra:test:up` sobe os dois containers saudáveis
- [ ] `npm run test:setup` aplica as migrations no banco efêmero
- [ ] `npm run build && test -f dist/main.js` e `node dist/main` sobe na porta 3000
- [ ] `docker build -t nexusops-backend:local .` e o container responde em `curl localhost:3000`

---

## Fase 4 — Pipeline GitHub Actions

- [ ] `.github/workflows/ci.yml` com gatilho em PR **e** push para `development` e `main`
- [ ] Todos os jobs rodam `npm ci` + **`npm run prisma:generate`** antes de qualquer outra coisa
      (`src/generated/prisma` é gitignored — sem isso nada compila)
- [ ] Job `guard-main-source` — falha PR para `main` vindo de branch != `development`
      (rulesets do GitHub não restringem a branch de origem; este job é a única imposição real)
- [ ] Job `commitlint` — valida os commits do PR (o hook local é burlável com `--no-verify`)
- [ ] Job `quality` — `eslint` sem `--fix`, `prettier --check`, `tsc --noEmit`
- [ ] Job `test` — sobe `docker-compose.test.yml`, `prisma migrate deploy`, os três níveis,
      publica `coverage/` como artifact
- [ ] Job `audit` — `npm audit --audit-level=high`
- [ ] Job `sonar` — escrito e condicionado a `vars.SONAR_ENABLED == 'true'`
- [ ] Job `docker` — build em todo PR, `push` só em push na `main`, tags `latest` e `sha-<short>`
- [ ] `.github/workflows/codeql.yml` — `javascript-typescript`, em PR + semanal
- [ ] `.github/dependabot.yml` — `npm` e `github-actions`, semanal
- [ ] `.github/pull_request_template.md`

---

## Fase 5 — Proteção de branch

- [ ] Ruleset `main-protected` — exige PR (0 aprovações, dev solo), status checks
      `quality` / `test` / `guard-main-source`, bloqueia force-push e deleção
- [ ] Ruleset `development-protected` — status checks `quality` / `test`, bloqueia force-push
      e deleção, sem exigência de PR
- [ ] **Verificação:** PR de branch qualquer → `development` passa; PR de branch qualquer →
      `main` é bloqueado pelo `guard-main-source`; PR `development` → `main` passa

---

## Fase 6 — Documentação

- [ ] `documents/ROTEIRO_TESTS.md` — cabeçalho apontando para este checklist e para a tabela
      de correções (corpo original preservado como registro da visão)
- [ ] `CLAUDE.md` — caminho `test/prisma.e2e-spec.ts` (citado 2× como guarda de regressão do
      Prisma 7) atualizado para `test/integration/prisma-wiring.int-spec.ts`
- [ ] `CLAUDE.md` — seção de comandos com os novos scripts
- [ ] `CLAUDE.md` — nota sobre os três níveis de teste e o `.env.test`

---

## Passos manuais (fora do escopo automatizável)

- [ ] Criar conta no SonarCloud e vincular o repositório
- [ ] Cadastrar `SONAR_TOKEN` em *Settings → Secrets and variables → Actions → Secrets*
- [ ] Definir a variável de repositório `SONAR_ENABLED=true` para ligar o job
- [ ] Habilitar *Dependabot alerts* e *security updates* em *Settings → Code security*

---

## Pendências futuras

- [ ] `coverageThreshold` no Jest — só faz sentido quando existirem módulos de domínio;
      hoje o repo é scaffold e qualquer piso reprovaria
- [ ] Papel de baixo privilégio para RLS (`DATABASE_URL_APP`) provisionado no
      `docker-compose.test.yml`, com testes que provem que as policies barram cross-tenant.
      Depende de a camada RLS existir (ver `CLAUDE.md` → Architecture)
- [ ] Merge dos relatórios de cobertura dos três níveis num único `lcov` para o Sonar
- [ ] Job de deploy consumindo a imagem do GHCR
