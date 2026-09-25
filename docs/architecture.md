# Arquitetura

## Visão geral

Monólito modular (NestJS) com dois processos a partir da mesma imagem:

- **api** (`dist/main.js`) — HTTP `/api/v1`, `/health`, `/ready`, `/api/docs`.
- **worker** (`dist/worker.js`) — BullMQ: outbox, e-mail, webhooks, finalização, manutenção.

```text
Navegador ──HTTPS──► Traefik ─► web (Next.js)     sign.adapterco.com.br
                         └──► api (NestJS) ◄──────  sign.adapterco.com.br/api
                                   │
             ┌─────────────────────┼──────────────────────┐
         PostgreSQL              Redis                S3-compatible
       (estado, auditoria)   (filas, rate limit)   (PDFs, evidências)
                                   ▲
                               worker (BullMQ)
```

A aplicação web chama a API na **mesma origem** (`/api/v1`), então os cookies HttpOnly são first-party.
Integrações usam o mesmo host (`https://sign.adapterco.com.br/api/v1`) com API key.

## Módulos (`apps/api/src/modules`)

| Módulo | Responsabilidade |
| --- | --- |
| auth | cadastro, login, sessões (família de refresh tokens), senha, verificação de e-mail |
| organizations | organização atual, membros, papéis |
| documents | upload validado, SHA-256, versões imutáveis, download |
| envelopes | state machine, rascunho, documentos, signatários, campos posicionados, ativação, cancelamento, lembretes, expiração |
| templates | modelos de contrato (papéis) e posicionamento automático de campos por âncoras `[[AS:tipo:papel]]` no PDF (pdf.js) |
| integrations | contrato por modelo em uma chamada (`/envelopes/from-template`), assinatura da empresa pela integração autorizada, links de assinatura |
| signing | fluxo público do signatário, OTP, `SignatureEngine`, registro de métodos de autenticação |
| evidence | documento final, relatório de evidências, finalização atômica |
| audit | eventos append-only encadeados |
| outbox | eventos de domínio transacionais |
| notifications | templates, criação idempotente, envio (worker) |
| webhooks | endpoints, assinatura HMAC, entrega com backoff, proteção SSRF |
| api-keys | chaves de integração (prefixo + hash) |
| billing | planos, consumo, limites, `BillingProvider` |
| admin | painel da plataforma (somente metadados) |
| verify | validação pública |
| legal | textos de consentimento versionados e imutáveis |

## Eventos de domínio e outbox

Mudanças de estado gravam, **na mesma transação**, uma linha em `outbox_events`. Depois do commit, um job é
enfileirado (caminho rápido); um sweeper periódico reprocessa eventos pendentes, então nada se perde se o Redis
falhar. Handlers idempotentes:

- **Notificações** — `notifications.dedupe_key` único (convite por signatário, conclusão por envelope etc.).
- **Webhooks** — `webhook_deliveries (endpoint_id, event_id)` único.
- **Finalização** — o job `finalize-{envelopeId}` reverifica o estado sob lock.

## Fluxo de assinatura

```text
Ativação → evento internal.signers.invite_requested → worker gera o token do link (só o hash vai ao banco) e envia o e-mail
Signatário abre /sign/{token} → POST /sign/sessions → sessão restrita ao processo (cookie path=/api/v1/sign)
  → (EMAIL_OTP) /sign/otp/request + /sign/otp/verify
  → visualização (DOCUMENT_VIEWED) → aceite versionado + assinatura (SignatureEngine, 1 transação)
  → próximo grupo convidado  |  todos obrigatórios assinaram → finalization_requested
Worker: FinalizationService → recalcula hashes → valida trilha → PDF final + relatório → COMPLETED (atômico)
```

## State machine

`apps/api/src/modules/envelopes/envelope-state.ts` centraliza as transições:

```text
DRAFT → ACTIVE | CANCELLED
ACTIVE → PARTIALLY_SIGNED | COMPLETED | EXPIRED | CANCELLED | DECLINED
PARTIALLY_SIGNED → COMPLETED | EXPIRED | CANCELLED | DECLINED
COMPLETED, EXPIRED, CANCELLED, DECLINED → (terminais; também protegidos por trigger)
```

O status do signatário só avança (PENDING → INVITED → VIEWED → AUTHENTICATED → SIGNED | DECLINED | EXPIRED).
Grupos: o grupo N começa quando todos os **obrigatórios** dos grupos anteriores assinaram.

## Auditoria encadeada

Cada evento pertence a uma cadeia (`envelope:<id>`, `org:<id>` ou `platform`) com `sequence` contígua:

```text
event_hash = SHA256(previous_hash + canonicalJson(evento sem id/hashes))
```

A serialização canônica ordena as chaves recursivamente. As escritas são serializadas por cadeia com
`pg_advisory_xact_lock`, e `(chain_key, sequence)` é único. Um trigger impede UPDATE/DELETE.

## Armazenamento

```text
documents/{org}/{document}/v{n}-{versionId}/original.pdf       (imutável; If-None-Match: *)
documents/{org}/{document}/envelopes/{envelope}/final-{attempt}.pdf
envelopes/{org}/{envelope}/evidence-{attempt}.pdf
signatures/{org}/{envelope}/{signer}-{uuid}.png
```

## Frontend (`apps/web`)

- Next.js App Router; páginas cliente consumindo `/api/v1`.
- Textos centralizados em `src/lib/i18n.ts` (pt-BR) e branding em `src/lib/branding.ts`.
- Visualizador de PDF: pdf.js renderizando em canvas a partir de endpoint autenticado.
- Página de assinatura mobile-first e acessível (foco visível, labels, navegação por teclado).
