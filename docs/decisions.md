# Decisões técnicas e limitações

## Stack e versões (verificadas no registro npm em 23/09/2026)

| Pacote | Versão | Motivo |
| --- | --- | --- |
| NestJS | 11.2.x | A linha 12 (atual) passou a ser ESM puro e tem APIs recentes; a 11 é CommonJS, madura e compatível com todo o ecossistema usado (swagger 11, nestjs-pino 4, jwt 11). Upgrade para a 12 planejado. |
| TypeScript | 5.9 | O CLI do NestJS e o `@nestjs/swagger` ainda não suportam o TS 7. |
| Prisma | 7.10 (generator `prisma-client`, `@prisma/adapter-pg`, `prisma.config.ts`) | A tag `latest` do npm aponta para 8.0 **RC**; a 7.10 é a estável. Configuração conforme a documentação oficial do v7. |
| BullMQ / ioredis | 5.x / 5.x | A linha 6 do BullMQ mudou o modelo de conexão (peers `pg`/`redis`/`ioredis`); a 5 é estável e conhecida. |
| Next.js / React / Tailwind | 16.3 / 19 / 4 | Versões estáveis atuais. |
| pdf-lib | 1.17.1 | API estável e amplamente usada para ler, gerar e modificar PDFs. **Risco**: sem release desde 2021. Alternativas avaliadas: `@pdfme/pdf-lib` (fork mantido, com mais dependências). Reavaliar. |
| pdfjs-dist | 6.3 | Renderização no navegador (visualizador). A 5.x tinha vulnerabilidade alta. |
| argon2 | 0.45 | Argon2id nativo. |
| nodemailer | 10 | SMTP (SES/Resend/servidor próprio) atrás da interface `EmailProvider`. A ≤9.1 tinha vulnerabilidades altas. |

Todas as licenças são MIT, MIT-0 ou Apache-2.0. Rode `npm audit` antes de cada release (o CI faz isso).

## Decisões de arquitetura

- **Monólito modular + worker** a partir da mesma imagem, sem microserviços.
- **Outbox transacional** para notificações, webhooks e finalização: nenhum efeito colateral dentro da transação
  ou da requisição, e nada se perde se o Redis falhar.
- **API na mesma origem** (`/api/v1` via proxy/rewrite): cookies first-party e sem CORS para a aplicação web.
  Domínio único `sign.adapterco.com.br`; integrações usam o mesmo host com API key.
- **Sessão do signatário separada** da sessão de usuário (cookie e tabela próprios), limitada ao processo.
- **Finalização no worker**: `COMPLETED` só depois de persistidos o documento final e o relatório. Chaves de
  storage únicas por tentativa, então retentativas nunca substituem arquivos.
- **Documento final** = páginas originais (com rodapé de referência) + página de assinaturas. O original fica
  intacto no storage. A validação aceita o hash do final, do original ou do relatório.
- **Endpoints**: segue a sugestão da seção 41, com `DELETE` para remover documentos e signatários de rascunhos e
  `/envelopes/:id/timeline`, `/final` e `/evidence` para resultados.
- **Planos** na tabela `plans`, sincronizados por CLI a partir de arquivo de configuração. Não há preço no código.
- **Consentimento**: textos versionados em código e registrados de forma imutável no banco (hash conferido na inicialização).
- **Templates de e-mail** em `notifications/templates.ts`. **Textos de UI** em `web/src/lib/i18n.ts`.

## Limitações e pendências conhecidas

1. **Verificado localmente**: `npm install`, lint, typecheck (API e web), 34 testes unitários e build (API e web)
   passam. **Não executado** (sem Docker/PostgreSQL/Redis na máquina de desenvolvimento): migrations num banco
   real, teste E2E de integração e subida via Docker Compose. Rode essas etapas na VPS (`deployment.md`).
2. A migration inicial foi escrita à mão seguindo as convenções do Prisma. O CI (`migrate diff --exit-code`)
   detecta divergências. Se houver, gere a correção com `prisma migrate diff`.
9. `npm audit` aponta duas falhas altas em `mysql2` e `deepmerge-ts`, versões fixadas **dentro** do CLI do
   Prisma 7.10 (`overrides` do npm não as substituem). Só afetam o CLI, que roda no container `migrate`; `mysql2`
   nem é usado (o banco é PostgreSQL). Correção: atualizar o Prisma quando houver versão estável que as resolva.
3. Termos de uso e política de privacidade não existem (dependem do jurídico).
4. Checkout de pagamento não implementado: `ManualBillingProvider` responde "indisponível" de forma explícita, e os planos são atribuídos no painel.
5. WhatsApp: implementado para convites, lembretes, códigos e conclusão (número central, Evolution API v2).
   Mensagens interativas e respostas do signatário pelo WhatsApp não são tratadas.
6. Envio em lote, SMS, biometria, ICP-Brasil e white label estão apenas preparados (enum, schema e feature flags), não implementados.
7. Rotina de expurgo por retenção não implementada (exige política explícita).
8. Textos com caracteres fora do Latin-1 aparecem como `?` nos PDFs gerados (fontes padrão WinAnsi). Para suporte completo, embutir uma fonte TTF (ex.: Noto Sans via `@pdf-lib/fontkit`).
9. Testes de UI (Playwright) ainda não escritos.
