## O que muda

<!-- Uma frase. O "porquê" vale mais que o "o quê" — o diff já mostra o quê. -->

## Como verificar

<!-- Comandos que quem revisa pode rodar, ou o passo a passo manual. -->

## Checklist

- [ ] Os três níveis passam localmente (`npm run test:all`, com `npm run infra:test:up`)
- [ ] Nenhuma consulta com filtro de tenant escrito à mão (o chokepoint em `src/tenancy/`
      é quem injeta — ver `CLAUDE.md` → Architecture)
- [ ] Se um model novo entrou no schema: registrado como escopado ou em `TENANT_AGNOSTIC`
- [ ] Se uma variável de ambiente nova entrou: `.env.example` e `.env.test` atualizados
- [ ] `CLAUDE.md` atualizado se alguma decisão de arquitetura mudou

<!-- PR para a main: só é aceito vindo da development (job guard-main-source). -->
