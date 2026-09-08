# Roteiro de teste manual — `identity`, `platform` e `helpdesk`

O que abrir, com que conta, e o que observar em cada tela. As contas abaixo vivem no **banco de
desenvolvimento** do backend; um `prisma:reset` leva as de company embora, e a seção
[Semear do zero](#semear-do-zero) recria em meio minuto. **O operador da plataforma não**: ele é
semeado do `.env` a cada boot e volta sozinho.

O desenho por trás do que este roteiro exercita está em
[`specs/2026-08-23-identity-login-users-design.md`](./specs/2026-08-23-identity-login-users-design.md),
[`specs/2026-08-25-platform-operator-console-design.md`](./specs/2026-08-25-platform-operator-console-design.md)
e [`specs/2026-09-01-helpdesk-core-design.md`](./specs/2026-09-01-helpdesk-core-design.md).

> **`POST /auth/register` não existe mais.** Responde 404, inclusive com token válido. Companies
> nascem pelo console do operador — é a mudança que quebrou a versão anterior deste roteiro.

## Subir as duas pontas

O backend escuta na 3333 e o frontend na 3000 — nenhum dos dois precisa ser movido.

```bash
# no repositório do backend
npm run infra:up && npm run start:dev        # http://localhost:3333

# aqui
cp .env.example .env.local                   # NEXUSOPS_API_URL=http://localhost:3333
npm run dev                                  # http://localhost:3000
```

> **Se faz tempo que você não atualiza o backend, ele não vai subir.** O Row-Level Security entrou, e
> com ele três variáveis novas — `DATABASE_URL_APP`, `POSTGRES_APP_PASSWORD` e `DATABASE_POOL_MAX` —
> que o backend valida no boot e sem as quais ele se recusa a iniciar. Copie-as do `.env.example`
> dele. E o container de banco que você já tem **não** possui o papel restrito que a aplicação passou
> a usar: para criá-lo é `npm run infra:reset`, que **apaga os dados locais** — inclusive as empresas
> que você criou em roteiros anteriores. O README do backend tem o passo a passo.

`npm run dev` serve o desenvolvimento. Para exercitar exatamente o que a imagem Docker roda:
`npm run build && NEXUSOPS_API_URL=http://localhost:3333 npm run start:standalone`.

## As contas

### O operador da plataforma

Não está em company nenhuma e **não nasce por `curl`**: `PlatformBootstrapService` o cria no boot a
partir de `ADMIN_MASTER_EMAIL` e `ADMIN_MASTER_PASSWORD` do `.env` do backend, e reconcilia os dois
a cada reinício. É por isso que ele não tem tela de _Account_ — uma senha trocada pela API seria
revertida no próximo boot.

No login, marque **Sign in as platform operator**, embaixo do campo _Company domain_. O campo trava
mostrando `platform` — o domínio reservado — e você preenche só e-mail e senha:

| Campo          | Valor                                                       |
| -------------- | ----------------------------------------------------------- |
| Company domain | travado em `platform` pela caixinha; não se digita nada ali |
| Email          | o de `ADMIN_MASTER_EMAIL` no `.env` do backend              |
| Senha          | a de `ADMIN_MASTER_PASSWORD`                                |

Existe **exatamente um**, sempre: um índice único parcial no PostgreSQL recusa o segundo.

### As contas de company

Todas no tenant **`acme.com`** — é o que vai no campo _Company domain_ do login.

| Email                  | Senha                   | Papel     | O que a conta mostra                                                                 |
| ---------------------- | ----------------------- | --------- | ------------------------------------------------------------------------------------ |
| `admin@acme.com`       | `correct horse battery` | ADMIN     | tudo: criar, editar, desativar, restaurar e o switch _Show deactivated_              |
| `agent@acme.com`       | `another good password` | AGENT     | lista os usuários, mas sem _New user_, sem o switch e sem o menu de ações da linha   |
| `helpdesk@acme.com`    | `another good password` | AGENT     | segundo agente — dá o que filtrar em _Any role_                                      |
| `requester@acme.com`   | `another good password` | REQUESTER | o item _Users_ some do menu; entrar em `/users` na mão dá "You don't have access…"   |
| `deactivated@acme.com` | —                       | REQUESTER | **desativado**: serve ao fluxo de restaurar, e o login dele responde o 401 de sempre |

> Trocar a senha em _Account_ **invalida a linha correspondente desta tabela** — o backend revoga
> todas as sessões e a senha antiga deixa de valer. Se fizer isso com o admin, anote a nova.

## Os papéis

Os papéis das contas acima são o enum `UserRole` do PostgreSQL, criado pelas migrations do backend
— quatro valores, e nenhum outro é possível: a coluna `users.role` é do tipo do enum, então um
valor inventado é recusado pelo banco, não pela aplicação. O padrão da coluna é `REQUESTER`, que é
o papel de menor alcance: uma conta criada sem dizer o papel nasce sem enxergar nada além do que
ela própria abriu.

> Não confunda com _roles_ do PostgreSQL (`CREATE ROLE`). Não existe nenhuma: a aplicação ainda
> conecta com um único usuário de banco, e o papel de baixo privilégio só entra quando o
> Row-Level Security for implementado (`documents/important/RLS_NOTES.md`).

| Papel          | Onde vive                      | Quantos existem   | Quem o atribui                            |
| -------------- | ------------------------------ | ----------------- | ----------------------------------------- |
| `ADMIN_MASTER` | no tenant reservado `platform` | **exatamente um** | ninguém — só o boot, a partir do `.env`   |
| `ADMIN`        | na company                     | um ou mais        | o operador (ao criar a company) e o ADMIN |
| `AGENT`        | na company                     | quantos quiser    | o ADMIN da company e o operador           |
| `REQUESTER`    | na company                     | quantos quiser    | o ADMIN da company e o operador           |

**Os papéis não são hierárquicos.** `RolesGuard` compara por igualdade, não por nível: uma rota que
pede `ADMIN` recusa o `ADMIN_MASTER` do mesmo jeito que recusa um `REQUESTER`. É por isso que o
operador toma 403 em `/users` e o admin de company toma 403 em `/platform/companies` — os dois
casos que o roteiro manda testar na barra de endereço.

### `ADMIN_MASTER` — o operador da plataforma

Administra a **plataforma**, não uma empresa. Vive no tenant reservado `platform`, que não tem
chamados nem usuários de negócio, e sua única jurisdição são as rotas `/platform/*`: criar,
listar, editar, bloquear e apagar companies, e gerir os usuários de qualquer uma delas
(`/platform/companies/:id/users`).

Duas coisas que o distinguem dos outros três:

- **Nenhuma rota o atribui.** `ASSIGNABLE_ROLES` (`src/users/assignable-role.ts`) o deixa de fora
  de todos os DTOs, então pedi-lo em `POST /users` é 400 antes de qualquer service rodar — se
  fosse aceito, o ADMIN de uma company criaria um operador dentro dela e escaparia do próprio
  tenant. A segunda camada é o índice `users_single_admin_master`, que recusa a segunda linha
  mesmo que algo passe por cima do pipe.
- **Ele não é super-usuário do helpdesk.** `seesEveryTicket()` e `handlesInternalNotes()` não o
  incluem: como o tenant dele não tem chamados, ele cai no ramo "só os meus" e vê lista vazia.
  Nenhuma rota oferece ler os chamados de uma company. E `POST /tickets` responde **403** a ele —
  antes de a rota ter papéis declarados, isso era um **500**, porque o tenant reservado não tem
  linha em `ticket_counters`.

### `ADMIN` — o administrador da company

É quem administra **uma** empresa, e o único papel que mexe em contas:
`POST /users`, `PATCH /users/:id`, `DELETE /users/:id` (que desativa, não apaga),
`POST /users/:id/restore` e o filtro que mostra desativados na listagem.
Também é o único que lê a auditoria da empresa inteira (`GET /audit`) — a trilha cruza todos os
chamados, então a regra de visibilidade não consegue estreitá-la e só um papel consegue.

No helpdesk ele é o papel de alcance total, e agora o **único**: enxerga todos os chamados da
empresa, abre, muda status, escreve nota interna e entra na sala `tenant:<id>:admins` do WebSocket.
**Atribuir é só dele** — e atribuir é o que decide quem enxerga um chamado, então a fila dos não
atribuídos é dele também: ninguém mais a vê.

Duas recusas existem justamente para não sobrar empresa sem administrador — as duas que o roteiro
exercita em [Os 409 que não têm](#os-409-que-não-têm): ninguém se desativa a si mesmo, e o último
ADMIN ativo não é rebaixado nem desativado.

### `AGENT` — quem trabalha os chamados atribuídos a ele

O papel operacional, e o de caixa de entrada pessoal: ele enxerga **os chamados atribuídos a ele** e
mais nada. Nos que são dele faz o trabalho todo — muda status, comenta, escreve e lê nota interna,
lê a timeline, exporta relatório. Fora deles, a mesma URL responde **404**, igual à de um estranho
de outra empresa.

Três coisas que ele **não** faz, e as três são novas:

- **não abre chamado** — `POST /tickets` responde 403. Quem trabalha o chamado não é quem o abre, e
  deixar a rota aberta a ele seria uma porta de saída da regra, porque o autor de um chamado o vê;
- **não atribui nada**, nem para si nem para outro, **nem para se desatribuir** de um chamado que é
  dele — sair de um chamado seria apagá-lo da única fila que o mostra;
- **não vê a fila dos não atribuídos**. `unassigned=true` intersecta com o escopo dele e sobra o que
  ele próprio abriu antes desta regra existir; a fila de entrada é do admin.

Com contas, o de sempre: lista usuários e para por aí. Sem _New user_, sem editar, sem desativar,
sem ver desativados, sem `GET /audit`.

No WebSocket ele **não** está na sala de admins: recebe os eventos dos chamados dele pela sala
pessoal `user:<id>`. A exceção deliberada é a reatribuição — quando um chamado sai dele, ele recebe
esse último evento justamente para a tela remover a linha (buscar o chamado daria 404).

Só um `AGENT` ou um `ADMIN` pode ser destinatário de uma atribuição: atribuir a um `REQUESTER`
responde 409 (`Only an AGENT or an ADMIN works tickets.`). Quem **faz** a atribuição, porém, é só o
ADMIN.

### `REQUESTER` — quem abre chamado

O papel padrão, e o mais estreito. Abre chamado, edita e acompanha **os seus**, comenta neles e
exporta relatório dos seus. Tudo o mais some ou responde 403/404:

- a listagem de chamados devolve só os dele, e `meta.total` acompanha — dois totais diferentes na
  mesma tela para contas diferentes é a prova disso;
- a URL do chamado de outro responde **404, nunca 403** — um 403 confirmaria que aquele id existe
  em algum lugar;
- pedir `?requesterId=<outro>` devolve **lista vazia**, e não os próprios chamados: o filtro é
  obedecido e o escopo o esvazia. Estreitar é a única coisa que um filtro consegue fazer aqui;
- não muda status nem atribui (403 do guard), e nem vê nem conta notas internas;
- `/users` responde 403, e no WebSocket ele entra só em `user:<id>` — a sala de admins é o que
  impede que um evento de chamado alheio chegue nele sem controller nenhum no caminho.

## O roteiro

### Login

- Senha errada → `Invalid credentials`. Domínio inexistente → **a mesma** mensagem. Usuário que não
  existe → a mesma. Conta desativada → a mesma. O backend não diferencia nem no tempo de resposta, e
  a tela não tenta ser mais esperta que ele.
- Deixe os campos vazios: a validação é local, e nada é enviado.
- Entre com `admin@acme.com`. Você cai em `/users`.
- Saia e marque **Sign in as platform operator**: o campo de domínio trava em `platform`. Entre com
  as credenciais do `.env` e você cai em **`/platform/companies`** — mesmo formulário, destino
  diferente. Desmarcar devolve o campo e o que estava digitado nele. O menu mostra _Companies_ e **não** mostra _Users_ nem
  _Account_: os papéis não são hierárquicos, e ele toma 403 em `/users`.

### Papéis

- Saia e entre como `agent@acme.com`: a lista aparece, o botão _New user_ não.
- Entre como `requester@acme.com`: _Users_ some do menu lateral. Vá em `http://localhost:3000/users`
  na barra de endereço — a tela explica que a listagem é de admins e agentes, em vez de mostrar um
  erro cru. É um **403**, e é diferente de 404 de propósito.

### O console do operador

Entre marcando **Sign in as platform operator**.

- **Bloquear.** Desmarque a caixinha _Active_ da `Acme Inc`. Ela não muta no clique: confirma
  primeiro, e o texto diz que ninguém daquela empresa vai conseguir entrar e que dá para desfazer.
  Confirme, saia, e tente entrar como `admin@acme.com` → `Invalid credentials`, **a mesma** mensagem
  de senha errada. Uma empresa suspensa é indistinguível de um erro de digitação, de propósito.
  Volte como operador e remarque para devolver o acesso.
- **Criar company.** _New company_ pede empresa e primeiro administrador no mesmo formulário — a API
  recusa criar uma sem ADMIN, porque nela ninguém entraria e ninguém criaria o primeiro usuário. No
  sucesso o diálogo mostra as credenciais e **não fecha sozinho**: não há email de convite nem reset
  de senha, então é a única vez que aquela senha aparece. Copie e entre com ela noutra aba.
- **Domínio repetido.** Tente criar outra com `acme.com` → `The domain "acme.com" is already
registered`. Tente com o domínio `platform` → 400, ele é reservado.
- **Usuários de uma company.** Menu de ações da linha → _Manage users_. É a mesma tela de `/users`,
  com o nome da company no topo. O operador cria, edita, desativa, restaura e enxerga desativados
  sempre — ele não é ADMIN de company nenhuma, e restaurar exige achar primeiro.
- **Apagar.** _Delete permanently_ exige **digitar o nome** da company e oferece bloquear no meio do
  caminho. Some com usuários, chamados e auditoria por cascade, sem restore e sem undo — só faça
  numa company descartável.
- **403 como estado.** Ainda logado como `admin@acme.com`, digite `/platform/companies` na barra de
  endereço: a tela explica que aquilo é do operador, em vez de mostrar erro cru. E como operador,
  `/users` faz o mesmo no sentido contrário.

**A confirmar contra a API real:** `PATCH /users/me/password` como `ADMIN_MASTER` responde 403? E
uma senha trocada por lá sobrevive ao restart? A tela de _Account_ foi escondida dele supondo que
**não** — se estiver errado, o item volta ao menu.

### O 409 que tem saída

Como `admin@acme.com`:

1. _New user_ → email `deactivated@acme.com` → qualquer senha → _Create user_.
2. O erro não é um beco sem saída: vem com o botão **Restore this user**, porque o backend devolveu o
   id do usuário desativado justamente para isso. Um endereço de um desativado continua ocupado — não
   dá para criar um substituto, e restaurar traz a mesma conta com o histórico dela.
3. Restaure e ligue _Show deactivated_ para ver o antes e o depois.

### Os 409 que não têm

Ainda como admin, e nos dois casos o diálogo **fica aberto** com a mensagem do backend:

- desativar a si mesmo → `You cannot deactivate yourself. Ask another ADMIN to do it.`
- editar o próprio papel para Agent → `The last active ADMIN cannot be demoted. Promote another user first.`

### Senha é contada em bytes

Em _Account_, o texto embaixo do campo diz `x of 72 bytes`. Cole um emoji e veja pular de quatro em
quatro: o bcrypt ignora em silêncio tudo depois do byte 72, então contar caracteres deixaria passar
uma senha que vale muito menos do que parece.

Concluir a troca desloga na hora e manda para o login com um aviso — é honesto, porque o backend
acabou de revogar todas as sessões.

### A prova da arquitetura

Isto é o que a fatia existe para demonstrar:

- DevTools → Application → Cookies: os dois `nexusops_*` estão marcados como **HttpOnly**.
- No console, `document.cookie` **não** mostra nenhum deles — o JavaScript da página não alcança a
  sessão, e por isso um XSS não a rouba.
- Aba Network: nenhuma resposta de `/api/*` carrega `accessToken` ou `refreshToken`. O browser fala
  com os Route Handlers do Next; quem fala com o NestJS é o servidor.

### Renovação, sem esperar 15 minutos

Apague **só** o cookie `nexusops_at` (DevTools → Cookies → botão direito → Delete) e navegue ou
recarregue. Nada acontece na tela: o servidor renova a sessão sozinho e o valor de `nexusops_rt`
muda. Um refresh token reapresentado revogaria todas as suas sessões, então essa renovação é
serializada de propósito — ver §3.2 da spec.

## O helpdesk

Depois do login, qualquer conta de company cai em **`/tickets`** — não mais em `/users`. A mudança
não é estética: listar usuários exige ADMIN ou AGENT, e um `REQUESTER` mandado para lá caía num 403
na primeira tela que via.

### Visibilidade: a mesma URL, respostas diferentes

É o roteiro mais importante desta fatia, e o passo 3 é o que mudou.

1. Entre como `requester@acme.com` e abra um chamado. Anote a URL.
2. Saia, entre como outro requester e cole aquela URL → **"Ticket not found"**, com um link de volta
   para a lista e não um alerta vermelho. É a regra, não uma falha: um `REQUESTER` só enxerga o que
   abriu, e o backend responde 404 (nunca 403) para não confirmar que o id existe em algum lugar.
3. Entre como `agent@acme.com` e cole a mesma URL → **também "Ticket not found"**. Ninguém atribuiu
   aquele chamado a ele, e ser staff deixou de ser a pergunta. É a parte surpreendente e é o motivo
   de este roteiro existir.
4. Entre como `admin@acme.com` → **200**. Atribua o chamado a `agent@acme.com`.
5. Volte como `agent@acme.com` e recarregue → **200**. Agora ele comenta, muda status e lê a
   timeline. `helpdesk@acme.com`, o outro agente, continua tomando 404 na mesma URL.
6. Peça a desatribuição como agente (`PATCH /tickets/<id>/assignee` por `curl`) → **403**. Nem para
   largar o que é dele.

Repare também que o rodapé da lista mostra totais diferentes para cada conta — `meta.total` respeita
visibilidade, então o do agente conta só os atribuídos a ele.

E um detalhe de filtro que confunde se não for dito: como `requester@acme.com`, peça
`/tickets?requesterId=<id de outro>`. A resposta é **lista vazia**, não os chamados dele — o filtro
é obedecido e o escopo o esvazia.

### O ciclo de vida, e a transição que não existe

Como agente, no chamado: **Start work** → **Resolve** → **Close**. Depois de _Resolve_, os únicos
botões são _Close_ e _Reopen_ — **não** existe "Start work". O backend recusaria
`RESOLVED → IN_PROGRESS` com 409, e um botão que sempre falha é pior que nenhum.

Para ver a recusa de verdade, force pelo `curl`:

```bash
curl -s -X PATCH http://localhost:3333/tickets/<id>/status -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"status":"IN_PROGRESS","version":<v>}'
```

Depois de fechar, o compositor de comentário some com uma explicação e a thread continua legível —
frozen, não hidden.

### O 409 de concorrência — o mais importante desta fatia

Duas janelas anônimas, as duas logadas (podem ser a mesma conta), as duas no **mesmo chamado**.

1. Na janela A, _Edit_ → mude a descrição → _Save_.
2. Na janela B, que ainda está na versão anterior, _Edit_ → mude a descrição → _Save_.

O esperado em B:

- um **diálogo**, não um alerta: "Someone else changed this ticket";
- a frase dizendo de qual versão para qual — a versão atual vem na mensagem do backend;
- os **dois lados** lado a lado: o que está no servidor e o que você tentou salvar;
- **Reapply mine** salva com a versão nova sem que ninguém a digite, e **Keep theirs** descarta.

Confira no DevTools → Network que **exatamente um** `PATCH` saiu quando o diálogo abriu. Repetir a
requisição com a mesma versão só produziria outro 409, e nada na tela faz isso.

Recarregue a janela A: ela vê o que B reaplicou.

### A nota interna

Como agente, escreva um comentário com **Internal note** ligado. Depois entre como o requester do
chamado: a nota não aparece **nem na thread nem na linha do tempo**, e o `total` da thread também
não a conta — um total que contasse o que ele não pode ler anunciaria que algo está escondido.

O switch nem aparece para um `REQUESTER`: ele receberia 403.

### A lista longa

Abra uns 60 chamados (o `for` do [Semear do zero](#semear-do-zero) serve de modelo) e role a lista.
Duas coisas a observar:

- as páginas se acumulam sozinhas ao chegar ao fim, e **não há** Previous/Next;
- no DevTools → Elements, o container mantém ~20 linhas no DOM enquanto o total no rodapé continua
  sendo o do servidor.

Não há cabeçalho clicável para ordenar, e isso é de propósito: a API não aceita parâmetro de
ordenação, e um cabeçalho ordenável ordenaria só o que já foi carregado.

### As três suposições, agora respondidas

Estavam abertas na §4 da spec. As três foram medidas contra a API real durante a mudança de
visibilidade, e as três se confirmaram:

- [x] `PATCH /tickets/:id/status` **exige** `version` — `ChangeStatusDto` o declara obrigatório, e
      omiti-lo é 400 no `ValidationPipe`, antes de qualquer serviço rodar.
- [x] `PATCH /tickets/:id/assignee` **também exige**, e `assigneeId` é anulável mas não opcional:
      omitir o campo é 400 e não "desatribuir". `test/e2e/tickets.e2e-spec.ts` fixa os dois.
- [x] As transições legais são exatamente `OPEN → IN_PROGRESS | RESOLVED`,
      `IN_PROGRESS → RESOLVED | OPEN`, `RESOLVED → CLOSED | OPEN`, com `CLOSED` terminal, e cada
      recusa vem como **409** — a tabela está em `src/tickets/ticket-transitions.ts`, exaustiva por
      tipo sobre o enum, de modo que um status novo sem destino declarado é erro de compilação.

O que continua em aberto é o do operador, lá em cima: se `PATCH /users/me/password` responde 403 ao
`ADMIN_MASTER`, e se uma senha trocada por lá sobrevive ao restart.

## Semear do zero

Depois de um `prisma:reset`, com o backend no ar:

```bash
# 1. a company e o primeiro ADMIN nascem juntos, e agora quem os cria é o operador.
#    Pela UI: entre com o domínio `platform` e use *New company*. Por curl:
OP=$(curl -s -X POST http://localhost:3333/auth/login -H 'content-type: application/json' \
  -d '{"tenantDomain":"platform","email":"'"$ADMIN_MASTER_EMAIL"'","password":"'"$ADMIN_MASTER_PASSWORD"'"}' \
  | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

curl -s -X POST http://localhost:3333/platform/companies -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' \
  -d '{"name":"Acme Inc","domain":"acme.com","admin":{"email":"admin@acme.com","password":"correct horse battery"}}'

# 2. um token de admin **da company** para as chamadas seguintes — o do operador
#    recebe 403 em /users, porque os papéis não são hierárquicos
TOKEN=$(curl -s -X POST http://localhost:3333/auth/login -H 'content-type: application/json' \
  -d '{"tenantDomain":"acme.com","email":"admin@acme.com","password":"correct horse battery"}' \
  | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

# 3. as outras quatro contas
for entry in 'agent@acme.com AGENT' 'helpdesk@acme.com AGENT' 'requester@acme.com REQUESTER' 'deactivated@acme.com REQUESTER'; do
  set -- ${=entry}   # em bash, use: set -- $entry
  curl -s -X POST http://localhost:3333/users -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"another good password\",\"role\":\"$2\"}" -o /dev/null -w "$1 -> %{http_code}\n"
done

# 4. e uma delas desativada, para o fluxo de restaurar
ID=$(curl -s "http://localhost:3333/users?search=deactivated" -H "authorization: Bearer $TOKEN" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -X DELETE "http://localhost:3333/users/$ID" -H "authorization: Bearer $TOKEN" -o /dev/null -w "desativado -> %{http_code}\n"

# 5. dois chamados do requester, e um deles atribuído -- é o que o roteiro de
#    Visibilidade precisa ter na frente. Quem atribui é o admin: o agente toma 403.
REQ=$(curl -s -X POST http://localhost:3333/auth/login -H 'content-type: application/json' \
  -d '{"tenantDomain":"acme.com","email":"requester@acme.com","password":"another good password"}' \
  | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

for title in 'Impressora pegando fogo' 'VPN caindo toda hora'; do
  curl -s -X POST http://localhost:3333/tickets -H "authorization: Bearer $REQ" \
    -H 'content-type: application/json' -d "{\"title\":\"$title\"}" \
    -o /dev/null -w "$title -> %{http_code}\n"
done

AGENT_ID=$(curl -s "http://localhost:3333/users?search=agent@acme.com" -H "authorization: Bearer $TOKEN" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
TICKET=$(curl -s "http://localhost:3333/tickets?perPage=1" -H "authorization: Bearer $TOKEN")
TICKET_ID=$(echo "$TICKET" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X PATCH "http://localhost:3333/tickets/$TICKET_ID/assignee" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"version\":1,\"assigneeId\":\"$AGENT_ID\"}" \
  -o /dev/null -w "atribuido -> %{http_code}\n"
```

O `version` é obrigatório em toda mutação de chamado, inclusive nesta — se a linha já tiver sido
tocada, o 409 devolve a versão atual na mensagem.

O `set -- ${=entry}` é sintaxe do zsh (o shell deste ambiente): o zsh não divide expansão em
palavras sem o `${= }`. Em bash, `set -- $entry`.

## Sem backend nenhum

`npm run e2e` não precisa de nada disso: o Playwright sobe o artefato standalone **e**
`e2e/support/fake-api.mjs`, um dublê que serve os mesmos caminhos, códigos e envelopes de erro,
para os dois consoles. É o que roda na CI. O que ele não substitui é este roteiro — foi contra a
API real que apareceu o problema de renovação descrito na spec.

> **Rode `npm run build` antes.** A suíte E2E não constrói nada: ela sobe o `.next/standalone` que
> já estiver lá. Sem o build, você testa o código da última vez que alguém buildou — e passa verde
> por engano.
