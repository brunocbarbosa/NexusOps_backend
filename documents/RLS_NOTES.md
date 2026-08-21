# Row-Level Security — notas de implementação

> **Status: não implementado.** Não existe nenhuma policy, nenhum `set_config` e nenhuma role de
> baixo privilégio no código hoje. Este documento é a preparação para quando essa camada for
> escrita, e existe porque as medições abaixo custaram tempo de depuração real — perdê-las
> significaria pagar de novo.

## Por que RLS, se a extensão já filtra

A extensão do Prisma Client em `src/tenancy/` é a primeira camada de isolamento entre tenants. A
RLS é a **segunda**, deliberadamente redundante, para o caso de a primeira ser contornada — SQL
cru, ou um defeito na própria extensão.

`$queryRaw` / `$executeRaw` são operações de client, não de model, e nunca passam pela extensão.
Esse é o buraco concreto que a RLS fecha. Ver [`../src/tenancy/README.md`](../src/tenancy/README.md)
para o que a extensão cobre e o que ela não alcança.

## As duas armadilhas, medidas neste repositório

RLS will be inert in this project until the application stops connecting as `nexusops`. Two
mechanisms, and the second is the one that bites — both measured against this repo's own container,
not taken from documentation:

- The **table owner** bypasses RLS. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` fixes that case.
- A **superuser** bypasses RLS unconditionally, and `FORCE` does _not_ help. `docker-compose.yml`
  sets `POSTGRES_USER=nexusops`, and `initdb` makes that role a superuser: `pg_roles` reports
  `rolsuper = t, rolbypassrls = t`. So with the default `DATABASE_URL`, every policy is dead
  weight while `pg_policies` still shows the setup as correct — a silent failure that looks like
  protection.

The fix is a dedicated low-privilege role holding DML only, not owning the tables and not a
superuser; migrations keep using the owning role. `.env.example` reserves `DATABASE_URL_APP` for it.
Verified: as `nexusops` a tenant-scoped query returned every tenant's rows even with `FORCE` on; as
a `NOSUPERUSER NOBYPASSRLS` non-owner it returned only the scoped rows, and zero rows with no tenant set.

**Setting the tenant for RLS must be transaction-scoped, and `SET` cannot do it.** Two traps:

1. `prisma.$executeRaw` always parameterizes interpolated values, and PostgreSQL's `SET` accepts no
   bind parameters — `` $executeRaw`SET app.tenant_id = ${tenantId}` `` fails every call with
   `42601: syntax error at or near "$1"`. Use `set_config` instead.
2. `@prisma/adapter-pg` sends any query outside `$transaction()` straight to the `pg.Pool`, one
   checkout per call, so a standalone `set_config` and the following query can land on different
   physical connections — and a session-scoped value lingers on whichever connection last set it.
   Under concurrency that yields _another single tenant's_ rows, intermittently. Measured on a pool
   of 4 with 60 concurrent requests: 46 of 60 observed the wrong tenant. Pinning one connection per
   request and using transaction-local scope brought it to 0 of 60.

So the tenant must be set with `set_config('app.tenant_id', $1, true)` — the third argument is
`is_local` — inside an **interactive** `$transaction(async (tx) => ...)`, which pins one connection
and resets the value at commit. The array form of `$transaction` does not give that guarantee.

## Resumo do que precisa ser feito

1. Provisionar uma role `NOSUPERUSER NOBYPASSRLS` que **não** seja dona das tabelas, com DML apenas.
   `.env.example` já reserva `DATABASE_URL_APP` para ela; as migrations continuam usando a role
   proprietária.
2. Criar as policies e aplicar `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
3. Fazer a aplicação estabelecer o tenant com `set_config('app.tenant_id', $1, true)` dentro de um
   `$transaction(async (tx) => ...)` **interativo**.
4. Escrever os testes de integração que provem que as policies barram acesso cross-tenant — o
   `docker-compose.test.yml` precisará provisionar a role de baixo privilégio para isso.

O item 4 é o que transforma esta camada de "configurada" em "verificada". Sem ele, as policies
podem estar inertes e o `pg_policies` continuaria mostrando tudo correto.
