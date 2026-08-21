# Autenticação e usuários — comportamento medido

Leia antes de mexer em `src/auth/`, `src/users/` ou nos DTOs de qualquer módulo novo.

Tudo abaixo foi **medido neste repositório**, contra Prisma 7.9.1, bcrypt 6.0.0, class-transformer
0.5.1 e `@nestjs/config` 4. Não são recomendações de documentação: são coisas que o código depende
de serem verdade, com o teste que avisa quando deixarem de ser.

As regras que valem em todo o resto do código — nunca escrever filtro de tenant à mão, workers não
têm contexto de request — estão no `CLAUDE.md`, em "Architecture". Este arquivo é o _porquê_ das
decisões desta fatia.

## O tenant antes de existir tenant

`User.email` só é único dentro de um tenant, então o e-mail sozinho é ambíguo entre empresas. O
login carrega `tenantDomain` no corpo e resolve o `Tenant` primeiro. São **três** os lugares em
todo o código que rodam sem tenant, e a lista é curta de propósito — um `grep runWithoutTenant`
audita a superfície inteira:

| Onde                        | Por quê                                              |
| --------------------------- | ---------------------------------------------------- |
| `AuthService.register`      | o `Tenant` está sendo criado                         |
| `AuthService.login`         | o `Tenant` ainda não foi identificado                |
| limpeza das suítes de teste | apagar "de todos os tenants" é exatamente a intenção |

`AuthService.refresh` **não** está na lista, e essa é a razão de o `tenantId` viajar dentro do
refresh token: refresh acontece justamente quando o access token expirou, então não há usuário
autenticado nem escopo para herdar — e a tabela de tokens é escopada como todas as outras, então a
consulta não roda sem escopo nenhum. Carregar o tenant na claim é o que permite abrir o escopo
antes da primeira query em vez de deixar essa busca desescopada.

## `$transaction` que troca de escopo no meio

`register()` cria o `Tenant` sob `runWithoutTenant()` e o primeiro `ADMIN` sob
`runWithTenant(tenant.id)`, **na mesma transação** — separá-las deixaria uma empresa existindo sem
ninguém que consiga entrar nela.

Duas propriedades do Prisma 7.9.1 sustentam isso, e as duas foram medidas:

- **A extensão se aplica ao client transacional.** O `tx` do callback carimba o `tenantId` e recusa
  escrita cross-tenant igual ao client de fora. Uma transação não é um caminho para contornar o
  chokepoint.
- **O `AsyncLocalStorage` atravessa os `await` de dentro do callback.** O escopo aberto _depois_ de
  a transação já ter começado continua valendo para as queries seguintes.

`test/integration/auth-registration.int-spec.ts` fixa as duas, mais o rollback: quando a escrita
escopada falha, o tenant vai junto.

## O interceptor e a preguiça do Observable

`TenantContextInterceptor` é interceptor e não middleware porque em tempo de middleware
`request.user` ainda não existe — os guards não rodaram — e decodificar o JWT de novo ali criaria
um segundo lugar decidindo quem é o chamador.

A armadilha é a mesma preguiça do `PrismaPromise` descrita em
[`TENANCY_EXTENSION.md`](./TENANCY_EXTENSION.md): devolver `next.handle()` de dentro de
`runWithTenant` entrega um Observable **não inscrito**, e a inscrição acontece depois de o escopo
já ter fechado. O corpo precisa ser
`from(runWithTenant(id, () => firstValueFrom(next.handle(), { defaultValue: undefined })))`.

**Custo aceito:** converter para promise mantém só a primeira emissão, então `@Sse` e qualquer
handler de múltiplas emissões não funcionam sob este interceptor. Rotas REST e `StreamableFile`
(que emite um objeto só) não são afetadas.

O `defaultValue` existe porque `firstValueFrom` rejeita com `EmptyError` num Observable que
completa sem emitir, o que um interceptor mais interno pode produzir.

## `tenantScoped()` existe por causa dos tipos, não do runtime

A extensão carimba `tenantId` em todo `create`. Os tipos gerados pelo Prisma discordam: `User` tem
relação obrigatória com `Tenant`, então `UserCreateInput` exige `tenantId` ou `tenant: { connect }`
e um `{ email, passwordHash }` puro é erro de compilação. Sem uma ponte, todo service acabaria
escrevendo o tenant à mão — o que esta camada existe para eliminar.

`tenantScoped()` **não é um cast**. Ele calcula o valor de verdade, via `requireTenantId()`, da
mesma fonte que a extensão usaria. Um cast satisfaria o compilador deixando o objeto sem o campo, e
no dia em que a extensão parasse de disparar para alguma operação a escrita cairia com
`tenantId: undefined` em vez de falhar. Assim as duas metades se conferem em vez de confiarem uma
na outra: `requireTenantId()` lança sem escopo, e o `stampTenant` da extensão ainda recusa
divergência.

Creates aninhados não precisam dele: as FKs compostas fazem o Prisma regerar o input aninhado sem
campo `tenantId` nenhum.

## Refresh tokens

**Chave separada, não a mesma com validade maior.** Access e refresh carregam quase as mesmas
claims. Sob uma chave só, o refresh token — válido por dias — é aceito como bearer pelo
`JwtStrategy`, e os 15 minutos do access deixam de significar qualquer coisa. Com duas chaves a
checagem de assinatura recusa, sem depender de ninguém lembrar de uma claim `type`. O `validateEnv`
recusa a aplicação subir com as duas iguais, porque isso desfaz a separação em silêncio.

**sha256 e não bcrypt no armazenamento.** bcrypt é lento de propósito, para encarecer adivinhação
de segredo escolhido por humano. Num token de 256 bits assinado não há o que adivinhar: a lentidão
não compraria segurança e seria paga a cada rotação. O hash existe para que um dump do banco não
seja um conjunto de sessões utilizáveis.

**`consume()` é um `updateMany` único filtrado por `revokedAt: null`.** Não é read-then-write, e a
diferença é a única coisa que faz a detecção de reúso funcionar: com read-then-write dois refreshes
simultâneos veem `null`, os dois rotacionam e os dois recebem par novo — exatamente o cenário de
token roubado que a detecção existe para pegar. É a mesma forma de controle otimista do agregado de
ticket. Afirmação de concorrência não se verifica lendo código:
`test/integration/refresh-token.int-spec.ts` dispara cinco consumidores simultâneos no mesmo token
e prova que **exatamente um** ganha.

**Reúso revoga a família inteira.** Um token já gasto voltando significa que duas partes o têm, e
daqui não dá para dizer qual é a legítima. Ambas fazem login de novo; a alternativa deixa o ladrão
com uma cadeia funcionando ao lado do dono.

**`expires_at` é lido do `exp` do token assinado**, não reparseado da string de duração. Uma fonte
de verdade, e a linha não pode alegar validade diferente do token que descreve. A coluna serve para
um job futuro de limpeza e para auditoria; quem barra token expirado é o `jsonwebtoken`.

## bcrypt trunca em 72 bytes e não avisa

Medido contra bcrypt 6.0.0: `hash()` de 81 caracteres seguido de `compare()` com uma senha
diferente que compartilhe os 72 primeiros devolve **`true`**, e `hash()` não lança com entrada
longa. Duas senhas longas viram a mesma credencial, e quem escolheu uma passphrase recebe bem menos
segurança do que o comprimento sugere.

Daí `@MaxBytes(72)` em `src/auth/password.constraints.ts` — **bytes**, não caracteres: um emoji
custa quatro, e um `@MaxLength(72)` deixaria passar 288 bytes dos quais o bcrypt guardaria 18.

## Mensagem igual não basta: o tempo também denuncia

Login responde a mesma 401 para tenant inexistente, usuário inexistente e senha errada. Isso
sozinho não resolve: pular o bcrypt no caminho não-encontrado fazia a resposta sair em ~1ms contra
~50ms do caminho encontrado, e um cronômetro responde "esta conta existe?" que a mensagem se
recusou a responder.

`HashingService.compareWithDecoy()` gasta o mesmo tempo. O hash-isca é construído no
`onModuleInit` a partir do custo configurado, não fixo no código: um hash de bcrypt carrega o
próprio cost factor, então um isca fixo queimaria tempo diferente dos hashes reais e reintroduziria
a diferença que existe para esconder.

## Soft delete contra o e-mail único

Exclusão de usuário é lógica porque as FKs de `audit_logs` e de `tickets.assignee` são `RESTRICT` —
apagar um usuário com histórico falha no próprio banco.

Medido: recriar um usuário com o e-mail de um desativado falha com **`P2002` em
`(tenant_id, email)`**. O endereço continua ocupado enquanto a linha existir. É por isso que:

- `POST /users` distingue os dois casos por trás do mesmo `P2002` e devolve o id a restaurar;
- `POST /users/:id/restore` existe — restaurar traz a **mesma** linha de volta, com o histórico
  ainda ligado a ela, o que um create novo não faria;
- restore nunca colide: o endereço esteve ocupado o tempo todo, ninguém pôde tomá-lo.

**O filtro `deletedAt: null` fica no service, não na extensão.** Colocá-lo ao lado do filtro de
tenant pareceria simétrico e seria um erro: a extensão é sobre tenant, e ensiná-la a esconder
linhas faria todo model futuro perder registros que ninguém pediu para esconder.

## `Boolean('false')` é `true`

O pipe global roda com `enableImplicitConversion`, e query string só carrega texto. O resultado é
que `?includeDeleted=false` chegava como `true` — o oposto do pedido, em silêncio.

A parte que vale registrar: **um `@Transform` sozinho não resolve.** Medido com o pipe real, a
conversão implícita roda **antes** do transform, que então recebe um booleano já errado — `'false'`
e `'maybe'` chegavam os dois como `true`. `@Type(() => String)` na propriedade é o que redireciona a
conversão e deixa o texto cru para o transform ler.

`src/users/dto/query-users.dto.spec.ts` roda pelo **mesmo** `VALIDATION_PIPE_OPTIONS` que
`configureApp` usa, exportado de `src/app.setup.ts` justamente para isso: um spec que montasse as
próprias opções não provaria nada sobre este caso.

Vale para qualquer flag booleana em query string de qualquer módulo futuro.

## Duas escolhas de API que parecem detalhe

**404 e nunca 403 para recurso de outro tenant.** A extensão filtra, então o id simplesmente não é
encontrado. Um 403 confirmaria que o id existe em algum lugar, que é um fato sobre o dado de outra
empresa. O 403 fica para papel insuficiente, onde não há nada a revelar.

**`UpdateUserDto` é escrito à mão, não `PartialType(CreateUserDto)`.** O derivado herdaria
`password`, e trocar a senha de outra pessoa pela mesma rota que a renomeia é exatamente a forma
de uma ação de admin ampla demais virar tomada de conta. Senha só por `PATCH /users/me/password`,
que exige a atual e encerra todas as sessões.
