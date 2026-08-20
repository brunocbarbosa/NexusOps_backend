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
- [ ] Cadastrar `SONAR_TOKEN` em _Settings → Secrets and variables → Actions → Secrets_
- [ ] Definir a variável de repositório `SONAR_ENABLED=true` para ligar o job
- [ ] Habilitar _Dependabot alerts_ e _security updates_ em _Settings → Code security_

---

## Pendências futuras

- [ ] `coverageThreshold` no Jest — só faz sentido quando existirem módulos de domínio;
      hoje o repo é scaffold e qualquer piso reprovaria
- [ ] Papel de baixo privilégio para RLS (`DATABASE_URL_APP`) provisionado no
      `docker-compose.test.yml`, com testes que provem que as policies barram cross-tenant.
      Depende de a camada RLS existir (ver `CLAUDE.md` → Architecture)
- [ ] Merge dos relatórios de cobertura dos três níveis num único `lcov` para o Sonar
- [ ] Job de deploy consumindo a imagem do GHCR
