# Plano de frontend — visibilidade por atribuição

> **Esqueleto.** O conteúdo é escrito na **Fase 5**, depois de a mudança estar implementada e
> verificada — os códigos, payloads e nomes de sala aqui têm de vir da aplicação rodando, e não do
> que o [`PLANO_VISIBILIDADE.md`](./PLANO_VISIBILIDADE.md) supôs. Este arquivo existe desde a Fase 0
> só para o [`README.md`](./README.md) não apontar para o vazio.
>
> Companheiro de [`helpdesk/GUIA_FRONTEND_HELPDESK.md`](../helpdesk/GUIA_FRONTEND_HELPDESK.md), que
> descreve o helpdesk inteiro; aqui fica só o **delta** — o que muda no cliente que já existe.

## O que vai entrar

- **O que muda para cada papel na interface.** O agente perde a lista da empresa e ganha uma fila
  pessoal; perde o botão de abrir chamado; perde o controle de responsável, que vira leitura. O
  admin ganha a fila de não atribuídos como tela de trabalho, porque é o único que a enxerga.
- **A tela que deixa de existir.** "Todos os chamados" passa a existir só para o `ADMIN` — é a tela
  cuja virtualização o `GUIA_FRONTEND_HELPDESK.md` descreve.
- **Os erros novos e o que a tela mostra.** 403 em `POST /tickets` e em `PATCH .../assignee` para o
  agente; 404, e não 403, num chamado não atribuído — que a tela já trata como "Ticket not found".
- **O filtro que passou a ser interseção.** `?requesterId=<outro>` devolve lista vazia em vez dos
  próprios chamados, e qualquer estado de filtro guardado no cliente precisa disso em mente.
- **O socket.** A tabela de eventos deixa de dizer "staff da empresa" e passa a dizer "os admins, o
  responsável e o requester". O agente reatribuído recebe um último evento sobre um chamado que já
  não pode ler: a tela deve usá-lo para **remover a linha**, nunca para buscar o chamado — a busca
  daria 404.
- **A ordem de adoção.** O que pode ir para produção antes do backend e o que não pode.
