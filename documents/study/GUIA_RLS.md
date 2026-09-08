# Guia de Row-Level Security no NexusOps — explicado do zero

> **Para quem é este documento.** Para você, daqui a três meses, abrindo uma migration cheia de
> `CREATE POLICY` e tentando lembrar por que ela existe, por que o app conecta com um usuário
> diferente do que roda as migrations, e por que abrir um escopo de tenant virou abrir uma
> transação.
>
> Ele explica o RLS **do zero**: o que é, que problema resolve, por que este projeto quer duas
> camadas de isolamento em vez de uma, o que já foi decidido, e o que ainda falta construir. Não
> pressupõe que você saiba o que é uma _policy_ do PostgreSQL.
>
> Documentos vizinhos, com propósitos diferentes:
>
> - [`../RLS_DESIGN.md`](../RLS_DESIGN.md) — o **projeto** da implementação: a forma exata que ela
>   toma e o porquê de cada decisão. É a referência de quem vai escrever o código.
> - [`../important/RLS_NOTES.md`](../important/RLS_NOTES.md) — as **medições**: as três armadilhas
>   que custaram tempo de depuração e as queries que dizem se a camada está ligada.
> - [`../important/TENANCY_EXTENSION.md`](../important/TENANCY_EXTENSION.md) — a primeira camada de
>   isolamento, a que já existe e funciona.
>
> Este aqui é o **didático**: ensina. Os outros são referência — consulta pontual, não leitura.

---

## Índice

1. [O problema, sem jargão](#1-o-problema-sem-jargão)
2. [Os conceitos, em linguagem simples](#2-os-conceitos-em-linguagem-simples)
3. [Como o NexusOps isola hoje, e onde essa camada não alcança](#3-como-o-nexusops-isola-hoje-e-onde-essa-camada-não-alcança)
4. [O que o RLS acrescenta](#4-o-que-o-rls-acrescenta)
5. [A restrição que decide o desenho inteiro](#5-a-restrição-que-decide-o-desenho-inteiro)
6. [As três armadilhas medidas](#6-as-três-armadilhas-medidas)
7. [As quatro decisões que foram fechadas](#7-as-quatro-decisões-que-foram-fechadas)
8. [O que já está feito](#8-o-que-já-está-feito)
9. [O que vem agora, passo a passo](#9-o-que-vem-agora-passo-a-passo)
10. [Como saber se está mesmo funcionando](#10-como-saber-se-está-mesmo-funcionando)
11. [Glossário](#11-glossário)

---

## 1. O problema, sem jargão

O NexusOps é **multi-tenant**: várias empresas usam a mesma aplicação e o mesmo banco de dados. Os
chamados da Empresa A e os da Empresa B moram na **mesma tabela** `tickets`, separados apenas por
uma coluna `tenant_id`.

Isso é uma decisão de arquitetura comum e barata. E cria um risco que não existe quando cada
cliente tem seu próprio banco:

> Se **uma única** query esquecer de filtrar por `tenant_id`, a Empresa A vê os chamados da
> Empresa B.

Não é um bug que quebra a tela. É um bug que **funciona perfeitamente** e entrega dados errados.
Ninguém recebe um erro. O cliente A simplesmente vê coisas que não são dele — e talvez ninguém
perceba por meses.

O jeito ingênuo de evitar isso é disciplina: "todo mundo lembra de escrever
`where: { tenantId: ... }`". Isso não é uma proteção, é uma esperança. Basta um desenvolvedor
distraído, ou um `$queryRaw` escrito às pressas numa sexta-feira.

Por isso o projeto tem **duas camadas independentes**, e é isso que o RLS vem fechar.

---

## 2. Os conceitos, em linguagem simples

### Row-Level Security (RLS)

É um recurso do PostgreSQL. Normalmente as permissões de banco são por **tabela**: você pode ler a
tabela `tickets`, ou não pode. O RLS desce um nível: você pode ler a tabela `tickets`, **mas só as
linhas que satisfazem uma condição**.

A analogia: a permissão normal é a chave da porta da biblioteca. O RLS é um bibliotecário que, com
você já dentro, só entrega os livros que são seus.

O ponto que faz o RLS valer a pena: **essa regra vive no banco, não na aplicação**. Não importa se
a query veio do Prisma, de um `$queryRaw`, de um script de manutenção ou de alguém logado no
`psql`. O banco aplica a regra de qualquer jeito.

### Policy

É a regra em si. Uma policy tem duas metades, e esquecer a segunda é o erro clássico:

| Metade       | O que ela controla                                        |
| ------------ | --------------------------------------------------------- |
| `USING`      | o que você consegue **ler** (e apagar, e alterar)         |
| `WITH CHECK` | o que você consegue **escrever** (inserir, ou mover para) |

Sem o `WITH CHECK`, a policy impede a Empresa A de _ler_ os dados da B — mas não impede A de
_inserir_ uma linha carimbada como sendo da B. Metade da proteção.

### Role

É o "usuário" do PostgreSQL. Hoje o NexusOps conecta com um role chamado `nexusops`, que é
**superusuário** — dono das tabelas e capaz de tudo.

E aí está o detalhe que estraga tudo se for ignorado: **um superusuário ignora RLS
incondicionalmente**. Você pode criar todas as policies do mundo; se o app conecta como
superusuário, elas são decoração. Voltaremos a isso na seção 6.

### `set_config` e `current_setting` — a "variável de sessão"

A policy precisa saber **qual tenant está perguntando**. O PostgreSQL deixa você guardar um valor
avulso na conexão e ler de volta depois:

```sql
SELECT set_config('app.tenant_id', 'uuid-da-empresa', true);  -- guarda
SELECT current_setting('app.tenant_id', true);                -- lê de volta
```

O terceiro argumento (`true`) significa **"só vale dentro desta transação"**. Guarde essa palavra —
ela é o eixo de todo o desenho.

Com isso a policy fica legível:

```sql
CREATE POLICY tenant_isolation ON "tickets"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

Em português: _"só enxergue as linhas cujo `tenant_id` é igual ao tenant que está guardado nesta
conexão agora"_. O `nullif` parece ruído; ele não é, e a seção 6 explica por quê.

### Pool de conexões

A aplicação não abre uma conexão nova com o banco a cada query — isso seria lento. Ela mantém um
**pool**: um punhado de conexões prontas, emprestadas e devolvidas o tempo todo.

Isso é ótimo para performance e é a origem de metade das armadilhas deste guia. Se você guarda o
tenant numa conexão e a query seguinte pega **outra** conexão do pool, o valor não está lá.

### Transação

Um bloco de operações que acontece por inteiro ou não acontece. E — o que importa aqui — **uma
transação fica presa a uma única conexão do começo ao fim**.

É por isso que a transação vira a peça central: ela é a única forma de garantir que o
`set_config` e a query que vem depois estejam na **mesma** conexão.

---

## 3. Como o NexusOps isola hoje, e onde essa camada não alcança

A primeira camada já existe, já funciona, e é o coração do projeto. São duas peças:

**1. `AsyncLocalStorage`** (`src/tenancy/tenant-context.ts`). Pense nele como uma "mochila" que
acompanha a requisição inteira, inclusive através de `await`s. Quando alguém faz login e chama
`GET /tickets`, o `TenantContextInterceptor` coloca o `tenant_id` do usuário nessa mochila.

**2. Uma Prisma Client Extension** (`src/tenancy/tenant-extension.ts`). Ela intercepta **toda**
operação do Prisma, lê o tenant da mochila e injeta o filtro sozinha.

O resultado é que o serviço escreve isto:

```ts
this.prisma.ticket.findMany({ where: { status: 'OPEN' } });
```

e o que chega ao banco é isto:

```ts
{ where: { status: 'OPEN', tenantId: 'uuid-da-empresa' } }
```

Ninguém escreveu o filtro de tenant. Ninguém **pode** esquecer de escrever — não é convenção, é
chokepoint. Por isso o `CLAUDE.md` diz, com todas as letras: nunca escreva um filtro de tenant à
mão num serviço.

### Onde essa camada não alcança

A extensão intercepta **operações de model** — `findMany`, `create`, `update`. Ela não intercepta:

- **`$queryRaw` e `$executeRaw`.** São operações de _client_, não de model. Passam direto.
- **Um defeito na própria extensão.** Ela é código; código tem bug.
- **Qualquer coisa que não passe pelo Prisma** — um script de manutenção, alguém no `psql`.

Hoje não existe `$queryRaw` em `src/`. Mas "hoje não existe" é uma proteção com prazo de validade,
e a segunda e a terceira brechas não têm prazo nenhum.

---

## 4. O que o RLS acrescenta

O RLS é a **segunda camada, deliberadamente redundante**. A ideia é simples de enunciar:

> Mesmo que a primeira camada falhe por completo, o banco se recusa a devolver a linha errada.

Uma comparação que ajuda:

|                                 | Extensão do Prisma   | RLS                         |
| ------------------------------- | -------------------- | --------------------------- |
| Onde mora                       | na aplicação         | no banco                    |
| Alcança `$queryRaw`?            | não                  | **sim**                     |
| Alcança um script fora do app?  | não                  | **sim**                     |
| Sobrevive a um bug na extensão? | não                  | **sim**                     |
| Custo se estiver errada         | vazamento silencioso | zero linhas (falha fechada) |

Aquela última linha é a mais importante do guia. Quando o RLS está ligado e o tenant **não** foi
informado, a policy não devolve erro — ela devolve **nenhuma linha**.

Isso se chama **falhar fechado**, e é a escolha certa: a alternativa seria uma policy que deixa
passar quando não sabe quem está perguntando, o que é o mesmo que não ter policy. Mas tem uma
consequência prática dura:

> Não dá para ligar RLS pela metade. No instante em que o app passa a conectar com um role que
> obedece às policies, **toda query do sistema** precisa estar dentro de uma transação que informou
> o tenant — ou ela devolve vazio, em silêncio.

É por isso que este trabalho mexe no runtime inteiro, e não só numa migration.

### As sete tabelas

Sete tabelas carregam `tenant_id` e precisam de policy:

`users` · `tickets` · `comments` · `audit_logs` · `refresh_tokens` · `ticket_counters` · `reports`

Duas ficam de fora, por motivos diferentes: `tenants` **é** o tenant (não é escopada por um), e
`_prisma_migrations` não é dado de aplicação.

---

## 5. A restrição que decide o desenho inteiro

Tudo o que vem a seguir sai de um único fato, então vale ler devagar:

1. A policy lê o tenant com `current_setting`.
2. Esse valor foi guardado com `set_config(..., true)` — **só vale dentro da transação**.
3. Uma transação está presa a **uma** conexão.
4. Logo: o `set_config` e a query **precisam estar na mesma transação**.

Se você guardar o tenant fora de uma transação, o driver devolve a conexão ao pool, a próxima query
pega outra conexão, e lá não há tenant nenhum — zero linhas. Ou, pior, ela pega uma conexão que
_outro_ pedido acabou de usar e enxerga o tenant errado.

**A conclusão de desenho:** abrir um escopo de tenant passa a ser abrir uma transação. Onde o
código hoje faz isto:

```ts
runWithTenant(tenantId, () => /* ... consultas ... */);   // só guarda na mochila
```

ele passará a fazer, por baixo, isto:

```ts
prisma.$transaction(async (tx) => {
  await setConfig(tx, tenantId); // avisa o banco quem está perguntando
  return storage.run({ tenantId, tx }, fn); // e roda o trabalho ali dentro
});
```

Quem chama não muda. É o mesmo argumento de chokepoint da primeira camada: ninguém precisa lembrar
de nada.

---

## 6. As três armadilhas medidas

Estas três não foram lidas na documentação do PostgreSQL — foram **medidas** neste projeto, contra
o container dele. Cada uma custou tempo, e as três falham de um jeito que _parece_ que está
funcionando.

### Armadilha 1 — superusuário ignora RLS, e `FORCE` não salva

Existem dois jeitos de escapar de uma policy:

- **O dono da tabela** escapa. Isso tem conserto: `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
- **O superusuário** escapa **incondicionalmente**, e o `FORCE` não ajuda em nada.

O `docker-compose.yml` define `POSTGRES_USER=nexusops`, e o `initdb` faz desse role um
superusuário. Rodando hoje, no container de dev:

```
 rolname  | rolsuper | rolbypassrls
----------+----------+--------------
 nexusops | t        | t
```

Ou seja: se criarmos todas as policies e não trocarmos o usuário de conexão, o `pg_policies` mostra
tudo lindo e **nada** está protegido. É a pior forma de falha — a que parece sucesso.

**A saída:** dois roles.

| Role           | Quem é                                | Quem usa                                                |
| -------------- | ------------------------------------- | ------------------------------------------------------- |
| `nexusops`     | superusuário, dono das tabelas        | migrations, Prisma Studio, os testes que limpam o banco |
| `nexusops_app` | `NOSUPERUSER NOBYPASSRLS`, não é dono | **a aplicação rodando**                                 |

Daí nascem as duas variáveis: `DATABASE_URL` (migrations) e `DATABASE_URL_APP` (aplicação). E uma
validação nova no boot: se as duas forem iguais, o app se recusa a subir — porque duas URLs iguais
não é um erro que grita, é RLS silenciosamente desligado.

### Armadilha 2 — fora de transação, o tenant vai parar em outra conexão

O `@prisma/adapter-pg` manda qualquer query fora de `$transaction()` direto para o pool, uma
retirada por chamada. Então um `set_config` solto e a query seguinte podem cair em conexões
diferentes.

Medido: pool de 4 conexões, 60 requisições concorrentes → **46 das 60 enxergaram o tenant errado**.
Com a transação interativa fixando uma conexão: **0 de 60**.

Repare que o erro não é "às vezes vazio". É "às vezes os dados de outra empresa".

### Armadilha 3 — o valor nunca volta para "não definido"

Esta foi descoberta agora, ao revisar o projeto, e é a mais traiçoeira das três.

Depois que uma conexão serviu **uma** transação com tenant, ela passa a ler string vazia — não
`NULL` — para sempre. E não há volta: passar `NULL` para o `set_config` grava `''` também.

| A conexão                          | `current_setting('app.tenant_id', true)` |
| ---------------------------------- | ---------------------------------------- |
| nova, nunca usada                  | `NULL`                                   |
| já serviu uma transação com tenant | `''`                                     |

Por que isso importa: a expressão **óbvia** da policy seria
`tenant_id = current_setting('app.tenant_id', true)::uuid`. E `''::uuid` **não** vira `NULL` — ele
levanta um erro, `22P02 invalid input syntax for type uuid: ""`.

O efeito é perverso:

- numa conexão nova do pool → devolve zero linhas (falha fechada, como se quer)
- numa conexão reciclada → **estoura um erro**

Qual das duas acontece depende de qual conexão o pool entregou. E um teste escrito contra um pool
recém-criado **passa**, enquanto a produção quebra.

**A saída** é o `nullif` que apareceu na seção 2: `nullif(current_setting(...), '')::uuid` trata a
string vazia como "sem tenant". Medido: zero linhas no `SELECT` e `42501` no `INSERT`, tanto na
conexão nova quanto na reciclada.

Um detalhe irmão, para quem for escrever os testes: **`42501` aborta a transação**, como qualquer
erro. Um teste que verifica uma recusa e continua usando a mesma transação recebe
`25P02 current transaction is aborted` em tudo depois. Recusas esperadas vão dentro de um
`SAVEPOINT`.

---

## 7. As quatro decisões que foram fechadas

O projeto do RLS tinha decisões em aberto. Elas foram fechadas lendo o código real contra o
desenho e medindo o que aconteceria — e duas delas só apareceram nessa leitura. Aqui vai o resumo
em linguagem simples; o raciocínio completo está na Parte IV do
[`RLS_DESIGN.md`](../RLS_DESIGN.md).

### #0 — todo escopo é uma transação, inclusive o "sem tenant"

**O problema.** O desenho original dizia que `runWithoutTenant()` não abriria transação, porque só
mexe na tabela `tenants`, que não tem policy. Parecia inofensivo. Mas a criação de empresa
(`CompaniesService.create()`) faz uma coisa incomum: ela **troca de tenant no meio de uma transação
já aberta** — cria o `tenant` sem escopo, e o primeiro ADMIN dentro do escopo daquele tenant novo.

Sem transação no escopo externo, as duas metades caem em conexões diferentes. A metade que escreve
o usuário informa o tenant numa conexão; a escrita acontece na outra, onde ninguém informou nada. E
não há conserto fácil: redirecionar a escrita para a segunda conexão esbarra na chave estrangeira,
porque a empresa ainda não foi confirmada na primeira.

Medido, com dois roles e policies de verdade:

```
escreve pela transação léxica:    42501  violação de row-level security
redireciona para a outra:         23503  violação de chave estrangeira
```

**A decisão.** Todo escopo abre transação — inclusive o sem tenant — e um escopo aninhado **reusa a
que já está aberta**, apenas reavisando o banco de qual tenant é a vez, e devolvendo o anterior ao
sair. Vira uma regra só, mais simples que a original.

Um bônus: como o aninhado reusa, uma requisição do painel da plataforma passa a usar **uma**
conexão em vez de duas.

### #1 — quem abre o escopo é um provider injetado

**O problema.** Para abrir transação, o código do escopo precisa alcançar o cliente do Prisma. O
documento propunha guardar esse cliente numa variável de módulo, preenchida uma vez no boot,
justificando que a alternativa criaria um ciclo de imports.

**O que a medição mostrou.** O ciclo não existe: o cliente chega como argumento em tempo de
execução, então o import necessário é só de tipo — e import de tipo é apagado na compilação. Ou
seja, a justificativa da decisão estava errada.

**A decisão, pelo motivo certo.** Um `TenantScopeService` injetado pelo Nest. E o argumento que
decide já estava escrito no próprio repositório, sobre outra pergunta: o `PrismaModule`
deliberadamente **não** é `@Global()`, para que dê para saber quais módulos tocam o banco só de
olhar. Uma variável de módulo é exatamente esse global, sem a visibilidade — o `runWithTenant`
continuaria com cara de utilitário puro enquanto abre transação num cliente que a classe nunca
declarou.

### #2 — o worker de relatório abre um escopo por página

**O problema.** Hoje o worker de exportação envolve o job inteiro num escopo só. Com escopo virando
transação, isso seria **uma transação segurada pelo export inteiro** — até 500 páginas.

**O que a medição mostrou.** O argumento a favor de manter tudo numa transação era que pelo menos
se ganharia uma leitura consistente do export. Não se ganha: o Prisma não define nível de
isolamento, então vale o padrão do servidor (`read committed`), e nele **cada comando tira uma foto
nova** do banco.

```
READ COMMITTED    página 1 viu 1, página 2 viu 2   -> não é uma foto só
REPEATABLE READ   página 1 viu 1, página 2 viu 1   -> é
```

E o `idle_in_transaction_session_timeout`, que costuma ser a rede de segurança contra transações
esquecidas, está em `0` neste projeto — ninguém recuperaria aquela conexão.

**A decisão.** Uma transação por unidade de trabalho: uma para marcar "processando", uma por
página, uma para o resultado final. Troca uma transação longa por umas 500 curtas, que é o lado
certo dessa balança.

Um efeito colateral honesto, que foi registrado em vez de escondido: a paginação por
`skip`/`take` já **duplica linhas** hoje se alguém abrir um chamado no meio do export. Isso não é
culpa do RLS e esta decisão não muda nada nisso — está anotado para não ser confundido depois com
um problema novo.

### #3 — os eventos só são disparados depois do commit

**O problema.** Este apareceu sozinho, sem ninguém mexer em nada. Hoje `TicketsService.mutate()`
fecha a própria transação e **só então** dispara o evento — tem até um comentário explicando que é
de propósito. Com a transação passando a ser a da requisição inteira, o evento passa a sair **de
dentro** dela, sem que uma linha do arquivo mude.

Isso quebra duas coisas:

- **A trilha de auditoria, de forma determinística.** O disparo do evento não é esperado, e o
  ouvinte é assíncrono — ele escreve depois. E o Prisma invalida a transação no instante em que o
  callback retorna. Resultado medido:
  `P2028 Transaction already closed`. O ouvinte engole o erro no próprio `catch` e loga "a trilha
  está atrasada em relação aos dados" — que é a única frase verdadeira da sequência. **Toda mutação
  de chamado deixaria de ser registrada, em silêncio.**
- **O WebSocket, como corrida.** O cliente é avisado e recarrega o chamado — mas a linha ainda não
  foi confirmada no banco. Ele lê o estado antigo.

**A decisão.** O escopo dono da transação acumula os eventos numa fila e dispara depois do commit;
se der rollback, descarta. Um provider `DomainEvents` com a mesma assinatura de hoje faz isso, então
nenhum lugar que dispara evento muda de forma. É a única saída em que todos os comentários já
escritos nos arquivos continuam verdadeiros.

---

## 8. O que já está feito

**Nenhuma linha de código.** Vale ser explícito: até aqui, o trabalho foi de projeto e medição.

- O `RLS_DESIGN.md` passou a ter **todas** as decisões fechadas — as duas que estavam em aberto e
  as duas que apareceram na revisão. A seção de decisões abertas está vazia de propósito.
- O `RLS_NOTES.md` teve a lista de tabelas corrigida (eram cinco listadas, são sete), ganhou a
  terceira armadilha e passou a mandar ler o design antes de construir.
- Duas correções em coisas já escritas: a expressão da policy precisa do `nullif`, e o motivo dado
  para o timeout de transação apontava para o lugar errado.
- O `CLAUDE.md` acompanhou.

O que **não** existe ainda: role, policies, grants, transação no escopo, provider, eventos adiados,
testes. Tudo isso é a seção seguinte.

---

## 9. O que vem agora, passo a passo

A ordem importa: o teste vem antes do runtime, porque é o teste que prova que a camada existe.

### Passo 1 — criar o role de baixo privilégio

Um arquivo `scripts/initdb/01-app-role.sql` montado em `/docker-entrypoint-initdb.d` pelos **dois**
compose files (o de dev e o de teste), com a senha vindo de `POSTGRES_APP_PASSWORD`.

Esse diretório é rodado pelo Postgres **uma vez, quando o container é criado**. Para o stack de
teste isso é perfeito, porque ele nasce do zero a cada execução, e a CI ganha de graça.

> ⚠️ **O custo cai no seu ambiente de dev.** Um container que já existe **não** roda o initdb de
> novo. Para ganhar o role, é `npm run infra:reset` — que **destrói os dados locais**. Não há
> como contornar isso; é o preço de criar o role dessa forma, e as alternativas eram piores
> (colocar `CREATE ROLE` numa migration gravaria a senha no repositório).

### Passo 2 — as variáveis de ambiente

`DATABASE_URL_APP` deixa de ser opcional, `POSTGRES_APP_PASSWORD` nasce, e o `env.validation.ts`
ganha a regra de recusar as duas URLs iguais. Como sempre neste projeto, mexer numa variável são
quatro lugares — o `GUIA_VARIAVEIS_AMBIENTE.md` lista quais.

### Passo 3 — a migration com policies e grants

Criada com `prisma migrate dev --create-only`, porque o Prisma não modela RLS: o arquivo é escrito
à mão. Para cada uma das sete tabelas:

```sql
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tickets" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tickets"
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

Mais os `GRANT` para o role novo — e o `ALTER DEFAULT PRIVILEGES`, que é uma armadilha com atraso:
sem ele, a **próxima** migration que criar uma tabela quebra a aplicação em produção, e nenhum teste
pega, porque o banco de teste é construído pela mesma rodada de migrations.

### Passo 4 — os testes (`test/integration/rls.int-spec.ts`)

Dez verificações. As três primeiras são baratas e só provam a **ausência** de proteção; as demais é
que provam que ela existe:

| #   | O que prova                                                             |
| --- | ----------------------------------------------------------------------- |
| 1   | o role conectado não é superusuário nem tem `BYPASSRLS`                 |
| 2   | as sete tabelas têm RLS ligado **e** forçado                            |
| 3   | existe uma policy por tabela                                            |
| 4   | SQL cru fora de escopo devolve zero linhas                              |
| 5   | dentro de um escopo, devolve as linhas daquele tenant e nenhuma outra   |
| 6   | um `INSERT` cross-tenant é recusado pelo `WITH CHECK`                   |
| 7   | um escopo aninhado enxerga só o seu, e sair dele **restaura** o de fora |
| 8   | criar empresa continua funcionando (o caso que quebrava na #0)          |
| 9   | mutação que dá rollback não dispara evento (a #3)                       |
| 10  | um export de chamados roda até o fim com o role da aplicação (a #2)     |

Os testes precisam de duas strings de conexão: a limpeza do banco usa `TRUNCATE`, que é um
privilégio que o role da aplicação não tem — e não deve ter.

### Passo 5 — o runtime

As quatro peças da seção 7: o `TenantScopeService` injetado, a transação no escopo (com o reuso e a
restauração no aninhado), o proxy que torna `$transaction` reentrante, e os eventos adiados. Mais a
divisão do `ensureAdminMaster`, para o bcrypt não rodar dentro da transação.

### Passo 6 — medir

O `RLS_DESIGN.md` termina prometendo um número, e não uma frase: quantas conexões cada formato de
requisição segura, e quanta concorrência o pool configurado aguenta. Segurar uma transação pela
duração da requisição muda o perfil de falha da aplicação — uma requisição lenta deixa de ser só
lenta e passa a segurar uma conexão. Isso precisa de medida, não de otimismo.

---

## 10. Como saber se está mesmo funcionando

A falha típica desta camada é o **silêncio**: uma configuração que parece completa e não protege
nada. Três queries respondem rápido, e vale rodá-las depois de cada passo.

**1. O role consegue ignorar tudo?** Esta é a primeira, porque um `t` em qualquer coluna torna as
outras duas irrelevantes:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

**2. O RLS está ligado e forçado?**

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM   pg_class
WHERE  relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER  BY relname;
```

**3. As policies existem?**

```sql
SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public';
```

Rodadas hoje, no container de dev, elas reportam exatamente o estado de "nada implementado":
`nexusops` volta `t | t`, todas as tabelas voltam `f | f`, e `pg_policies` está vazia.

E a ressalva que não pode ser esquecida: **nenhuma das três prova proteção**. Elas provam a
_ausência_ dela, rapidamente. Quem prova que a camada funciona são os itens 4 a 10 dos testes.

---

## 11. Glossário

| Termo                                | O que é                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| **RLS**                              | Row-Level Security. Regra no PostgreSQL que filtra **linhas**, não tabelas inteiras. |
| **Policy**                           | A regra em si. `USING` controla leitura; `WITH CHECK` controla escrita.              |
| **Role**                             | O "usuário" do PostgreSQL.                                                           |
| **Superusuário**                     | Role que ignora RLS incondicionalmente. O app **não** pode ser um.                   |
| **`FORCE ROW LEVEL SECURITY`**       | Faz o **dono** da tabela também obedecer às policies. Não afeta superusuário.        |
| **`set_config` / `current_setting`** | Guardam e leem um valor avulso na conexão. Com `true`, só vale na transação.         |
| **GUC**                              | O nome que a documentação do PostgreSQL dá a esses valores de configuração.          |
| **Pool de conexões**                 | Conjunto de conexões reaproveitadas. Origem de metade das armadilhas aqui.           |
| **Transação**                        | Bloco tudo-ou-nada, preso a **uma** conexão do início ao fim.                        |
| **Transação interativa**             | No Prisma, `$transaction(async (tx) => ...)`. É a que fixa a conexão.                |
| **Escopo (de tenant)**               | O trecho de código que roda "em nome" de uma empresa. `runWithTenant()`.             |
| **`AsyncLocalStorage`**              | Recurso do Node que carrega dados pela requisição inteira, através de `await`s.      |
| **Chokepoint**                       | Ponto único por onde tudo passa, para que ninguém possa esquecer de aplicar a regra. |
| **Falhar fechado**                   | Na dúvida, não entregar nada. O oposto de falhar aberto, que entrega demais.         |
| **`22P02` / `42501` / `25P02`**      | Erros do PostgreSQL: cast inválido / violação de policy / transação abortada.        |
| **`P2028`**                          | Erro do Prisma: uso de uma transação já encerrada.                                   |
