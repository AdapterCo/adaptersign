# API REST e webhooks

- Base: `https://sign.adapterco.com.br/api/v1` (mesma origem da aplicação web).
- OpenAPI/Swagger: `/api/docs`, JSON em `/api/docs/openapi.json` (desative com `SWAGGER_ENABLED=false`).
- Autenticação de integrações: `Authorization: Bearer <api key>`. Chaves são criadas em
  Configurações → API keys e exibidas **uma única vez**. O plano precisa incluir acesso à API.
- Datas em ISO-8601 UTC. IDs são UUID. Listagens paginadas com `?page=&pageSize=` (máximo 100).
- Rotas de gestão de conta (sessões, membros, API keys, webhooks) aceitam apenas usuários, nunca API keys.

## Erros

```json
{ "error": { "code": "ENVELOPE_NOT_FOUND", "message": "Envelope não encontrado.", "request_id": "…" } }
```

| HTTP | Códigos frequentes |
| --- | --- |
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` |
| 402 | `PLAN_LIMIT_REACHED` |
| 403 | `FORBIDDEN`, `CSRF_ORIGIN_REJECTED` |
| 404 | `ENVELOPE_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, … (também para recursos de outro tenant) |
| 409 | `INVALID_ENVELOPE_TRANSITION`, `ENVELOPE_NOT_EDITABLE`, `ALREADY_SIGNED`, `IDEMPOTENCY_IN_PROGRESS` |
| 422 | `EMAIL_NOT_VERIFIED`, `AUTH_METHOD_UNAVAILABLE`, `OTP_INVALID`, `OTP_LOCKED`, `OTP_EXPIRED`, `IDEMPOTENCY_KEY_REUSED` |
| 429 | `RATE_LIMITED`, `OTP_COOLDOWN` (com `Retry-After`) |
| 503 | `PLAN_NOT_CONFIGURED`, `BILLING_PROVIDER_NOT_CONFIGURED` |

Stack traces nunca são retornados. Informe o `request_id` ao suporte.

## Idempotência

`POST /envelopes`, `POST /envelopes/:id/activate` e `POST /envelopes/:id/cancel` aceitam `Idempotency-Key`
(8–128 caracteres, válida por 24 h e por organização):

- mesma chave e mesmo corpo → resposta original (`Idempotent-Replayed: true`), sem reexecutar;
- mesma chave e corpo diferente → `422 IDEMPOTENCY_KEY_REUSED`.

## Recursos principais

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/documents` (multipart `file`, `title`) | Upload de PDF (validação + SHA-256) |
| GET | `/documents` | Lista (busca, `status`, `createdById`, `from`, `to`, paginação) |
| GET | `/documents/:id` | Detalhe com versões e envelopes |
| POST | `/documents/:id/versions` | Nova versão (novo hash e novo ID; a anterior é preservada) |
| GET | `/documents/:id/versions/:versionId/content?mode=view\|download` | Conteúdo (download é auditado) |
| POST | `/envelopes` | Cria rascunho (opcional: `documents[]`, `signers[]`) |
| GET | `/envelopes` | Lista (busca por título, código, signatário ou documento; `status`) |
| GET | `/envelopes/auth-methods` | Métodos de autenticação (indisponíveis vêm marcados) |
| GET/PATCH | `/envelopes/:id` | Detalhe / edição de rascunho |
| POST/DELETE | `/envelopes/:id/documents[/:envelopeDocumentId]` | Documentos do rascunho |
| POST/DELETE | `/envelopes/:id/signers[/:signerId]` | Signatários do rascunho |
| GET/PUT | `/envelopes/:id/fields` | Campos posicionados (assinatura, rubrica, nome, data) — PUT substitui todos; só em rascunho |
| POST | `/envelopes/:id/fields/apply-template` | Posiciona os campos pelas âncoras dos PDFs, conforme um modelo (ver abaixo) |
| GET/POST | `/templates` | Modelos de contrato (papéis) |
| GET/PUT/DELETE | `/templates/:id` | Detalhe / alteração (papéis substituídos) / arquivamento |
| POST | `/templates/:id/test` (multipart `file`) | Testa um PDF de exemplo: âncoras encontradas e campos resultantes (nada é armazenado) |
| POST | `/envelopes/:id/activate` `{ "confirm": true }` | Envia para assinatura (documentos e campos passam a ser imutáveis) |
| POST | `/envelopes/:id/cancel` `{ "reason"? }` | Cancela (histórico preservado) |
| POST | `/envelopes/:id/remind` `{ "signerId"? }` | Lembrete manual (no máximo 1 por hora por signatário) |
| GET | `/envelopes/:id/timeline` | Eventos e verificação da cadeia |
| GET | `/envelopes/:id/documents/:envelopeDocumentId/final` | PDF final (após `COMPLETED`) |
| GET | `/envelopes/:id/evidence` | Relatório de evidências (após `COMPLETED`) |
| GET | `/verify/:code` · POST `/verify/file` | Validação pública |

Exemplo de criação e envio:

```bash
curl -X POST https://sign.adapterco.com.br/api/v1/envelopes \
  -H "Authorization: Bearer $API_KEY" -H "Idempotency-Key: pedido-123" -H "Content-Type: application/json" \
  -d '{"title":"Contrato 123","documents":[{"documentId":"<uuid>"}],
       "signers":[{"name":"Maria Exemplo","email":"maria@exemplo.com","authMethod":"EMAIL_OTP"}]}'

curl -X POST https://sign.adapterco.com.br/api/v1/envelopes/<id>/activate \
  -H "Authorization: Bearer $API_KEY" -H "Idempotency-Key: ativar-123" -H "Content-Type: application/json" \
  -d '{"confirm":true}'
```

Signatário com `signingGroup`: em modo `SEQUENTIAL`, o grupo N só é convidado depois que todos os
signatários **obrigatórios** dos grupos anteriores assinaram. Em `PARALLEL`, todos pertencem ao grupo 1.

## Modelos e âncoras

Um **modelo** define os papéis de um tipo de contrato (ex.: `loja` e `cliente`), a ordem de assinatura e se
um papel rubrica todas as páginas. O PDF de cada contrato (gerado pelo sistema de origem) leva **âncoras** —
marcadores de texto — onde os campos devem aparecer:

| Âncora | Campo criado |
| --- | --- |
| `[[AS:assinatura:<papel>]]` | Assinatura — obrigatória para cada papel do modelo |
| `[[AS:rubrica:<papel>]]` | Rubrica naquele ponto (opcional) |
| `[[AS:nome:<papel>]]` | Nome do signatário (opcional) |
| `[[AS:data:<papel>]]` | Data da assinatura (opcional) |

- Coloque a âncora de assinatura **logo acima da linha de assinatura**, alinhada ao início dela; o campo
  começa na esquerda da âncora e encosta na linha. Nome/data ocupam o lugar da própria âncora.
- A âncora pode ser invisível (cor branca, fonte pequena), mas precisa ser **texto** no PDF (não imagem).
  Espaços e maiúsculas são ignorados, então quebras feitas pelo gerador de PDF não atrapalham.
- "Rubrica em todas as páginas" (opção do papel) coloca a rubrica no canto escolhido de cada página, exceto
  nas páginas que já têm uma âncora de rubrica desse papel.
- `apply-template` recebe `{ "templateId", "roles": [{ "roleKey", "signerId" }] }` e substitui os campos do
  rascunho. Se faltar a âncora de assinatura de algum papel, houver âncora de papel inexistente ou âncora
  malformada, responde `422 TEMPLATE_ANCHORS_MISMATCH` (com `missing_signature`, `unknown_roles` e `invalid`
  em `details`) **sem alterar nada**.

## Webhooks

Configurados em Configurações → Webhooks (OWNER). O plano precisa incluir webhooks. Eventos disponíveis:

`envelope.created`, `envelope.activated`, `document.viewed`, `signer.authenticated`, `signer.signed`,
`signer.declined`, `envelope.completed`, `envelope.expired`, `envelope.cancelled`.

### Entrega

- Assíncrona (fila), nunca dentro da requisição original.
- Tentativas: imediata, 1 min, 5 min, 30 min e 2 h; depois, `DEAD` (visível e reenviável no painel).
- Sucesso = resposta 2xx em até `WEBHOOK_TIMEOUT_MS`. Redirecionamentos não são seguidos.
- Registramos tentativa, status, tempo e erro; **o corpo da resposta não é armazenado**.
- Destinos que resolvem para IPs privados/internos são bloqueados (SSRF).

### Payload

```json
{
  "id": "0192…",
  "type": "envelope.completed",
  "created_at": "2026-09-23T22:35:18.123Z",
  "organization_id": "…",
  "data": {
    "envelope": { "id": "…", "title": "…", "status": "COMPLETED", "validation_code": "ADP-8F7K-29QM-X82P",
                  "completed_at": "…", "expires_at": null },
    "signer": null,
    "document_id": null
  }
}
```

### Verificação da assinatura (HMAC-SHA256)

Cabeçalhos: `X-Adapter-Signature: v1=<hex>`, `X-Adapter-Timestamp`, `X-Adapter-Event-ID`,
`X-Adapter-Event-Type`, `X-Adapter-Delivery-Attempt`.

```text
v1 = hex( HMAC_SHA256( secret, `${timestamp}.${eventId}.${rawBody}` ) )
```

Exemplo (Node.js):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const ts = Number(headers['x-adapter-timestamp']);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false; // janela anti-replay
  const expected = 'v1=' + createHmac('sha256', secret).update(`${ts}.${headers['x-adapter-event-id']}.${rawBody}`).digest('hex');
  const got = String(headers['x-adapter-signature'] ?? '');
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
// Além disso: descarte X-Adapter-Event-ID já processados (idempotência do lado do cliente).
```

Use o corpo **bruto**, sem reserializar o JSON. O segredo (`whsec_…`) é exibido só na criação e na rotação.
