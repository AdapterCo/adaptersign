# Guia de integração — sistema de vendas → Adapter Sign

Tudo o que o sistema de origem (ex.: vendas de motos / locação de celulares) precisa implementar para:

1. gerar o contrato preenchido e enviá-lo **já assinado pela loja** (em nome do vendedor logado);
2. entregar o link de assinatura ao cliente;
3. receber o contrato **assinado por ambos** de volta, automaticamente, na ficha do cliente.

Base da API: `https://sign.adapterco.com.br/api/v1` · Referência completa: [`api.md`](api.md) e `/api/docs`.

```text
Sistema de vendas                                   Adapter Sign
─────────────────                                   ─────────────────────────────────────
1. Vendedor logado fecha a venda
2. Gera o PDF do contrato com os marcadores
3. POST /envelopes/from-template  ────────────────► 4. Confere marcadores, cria e envia
   (PDF + modelo + externalRef + vendedor + cliente)  5. Registra a assinatura da LOJA (vendedor)
   ◄──────── resposta: envelope + signingUrl do cliente 6. Convida o cliente (e-mail)
7. Mostra/envia o link ao cliente                    8. Cliente confirma o código e assina
                                                     9. Gera PDF final + relatório de evidências
10. Recebe webhook envelope.completed ◄──────────────
11. Baixa PDF final + evidências e anexa na ficha
```

---

## 1. Configuração (uma vez por loja)

Cada loja é uma **organização** no Adapter Sign, com plano próprio (incluindo API e webhooks).

| Onde | O quê |
| --- | --- |
| Adapter Sign → **Modelos** | Criar um modelo por tipo de contrato (ex.: `contrato-moto`, `contrato-locacao`) com os papéis **Loja** (`loja`, marcar "Representa a empresa", ordem 1) e **Cliente** (`cliente`, ordem 2). Opcional: "Rubrica em todas as páginas". |
| Adapter Sign → **Configurações → Assinatura da empresa** | O **proprietário** da conta lê e aceita a autorização (uma vez). Sem ela, os envios são recusados. |
| Adapter Sign → **Configurações → API keys** | Criar uma chave (ex.: "Sistema de vendas"). Ela aparece **uma única vez**. |
| Adapter Sign → **Configurações → Webhooks** | Cadastrar a URL do sistema de vendas (ex.: `https://vendas.exemplo.com/webhooks/adapter-sign`) com os eventos da seção 5. Guardar o segredo `whsec_…` (aparece uma vez). |
| Sistema de vendas → configurações da loja | Guardar, **cifrados**, a API key e o segredo do webhook; e o identificador do modelo de cada tipo de contrato. |

> A API key e o segredo **nunca** vão para o navegador ou app: use-os só no servidor.

## 2. Gerar o PDF com os marcadores

O sistema de vendas gera o PDF do contrato (HTML → PDF, por exemplo) e inclui **marcadores de texto** onde
cada campo deve aparecer:

| Marcador | Campo |
| --- | --- |
| `[[AS:assinatura:loja]]` | Assinatura da loja (obrigatório) |
| `[[AS:assinatura:cliente]]` | Assinatura do cliente (obrigatório) |
| `[[AS:rubrica:cliente]]` | Rubrica do cliente naquele ponto (opcional) |
| `[[AS:nome:cliente]]` / `[[AS:data:cliente]]` | Nome / data da assinatura (opcional) |

Regras:

- Coloque o marcador de assinatura **logo acima da linha de assinatura**, alinhado ao início dela.
- Pode ser invisível: cor branca e fonte pequena. Precisa ser **texto** no PDF (não imagem nem texto convertido em curvas).
- Exemplo em HTML: `<span style="color:#fff;font-size:5px">[[AS:assinatura:cliente]]</span>`
- Antes de ir para produção, teste um PDF em **Modelos → (modelo) → Testar com um PDF**: a tela mostra onde
  cada campo vai cair.

## 3. Enviar o contrato

`POST /envelopes/from-template` — `multipart/form-data` com:

- `file`: o PDF;
- `data`: JSON com os dados abaixo.

```json
{
  "template": "contrato-moto",
  "externalRef": "venda-123",
  "title": "Contrato de venda #123 — Maria da Silva",
  "signers": [
    { "role": "loja", "name": "Carlos Vendedor", "email": "carlos@loja.com", "externalId": "usuario-17" },
    { "role": "cliente", "name": "Maria da Silva", "email": "maria@exemplo.com", "cpf": "529.982.247-25", "phone": "+5524999999999" }
  ]
}
```

| Campo | Obrigatório | Observação |
| --- | --- | --- |
| `template` | sim | Identificador do modelo |
| `externalRef` | sim | **Único por contrato** no sistema de vendas (ex.: id da venda/locação). É a chave de idempotência. |
| `title` | sim | Aparece para o cliente e nos e-mails |
| `signers[]` | sim | Exatamente um por papel do modelo |
| `signers[].externalId` | recomendado (loja) | Id do vendedor logado no sistema de vendas — vai para a evidência |
| `signers[].cpf` / `phone` | recomendado (cliente) | CPF é guardado cifrado; com o telefone, convite e código também chegam pelo WhatsApp |
| `message`, `expiresAt`, `representing` | não | `representing` = nome da empresa representada (padrão: nome da organização) |

Exemplo (Node.js 18+):

```js
const form = new FormData();
form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'contrato.pdf');
form.append('data', JSON.stringify(payload));
const res = await fetch('https://sign.adapterco.com.br/api/v1/envelopes/from-template', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
});
const body = await res.json();
if (!res.ok) throw new Error(`${body.error.code}: ${body.error.message} (request_id ${body.error.request_id})`);
```

Resposta (`201`):

```json
{
  "id": "0192…",
  "status": "PARTIALLY_SIGNED",
  "externalRef": "venda-123",
  "validationCode": "ADP-8F7K-29QM-X82P",
  "replayed": false,
  "documents": [{ "id": "0192…", "filename": "contrato.pdf", "originalSha256": "…" }],
  "signers": [
    { "id": "…", "role": "loja", "name": "Carlos Vendedor", "status": "SIGNED", "signingUrl": null },
    { "id": "…", "role": "cliente", "name": "Maria da Silva", "status": "PENDING",
      "signingUrl": "https://sign.adapterco.com.br/sign/…", "signingUrlExpiresAt": "…" }
  ]
}
```

Guarde na venda: `id` (envelope), `validationCode` e os `id` dos signatários. **Não guarde o `signingUrl`**
por longos períodos: ele dá acesso à assinatura. Para reenviar, peça um link novo (seção 4).

### Erros e retentativas

| HTTP / código | Significado | O que fazer |
| --- | --- | --- |
| `400 VALIDATION_ERROR` | Dados inválidos (detalhes em `error.details`) | Corrigir o cadastro |
| `404 TEMPLATE_NOT_FOUND` | Modelo inexistente/arquivado | Conferir o identificador |
| `422 TEMPLATE_ANCHORS_MISMATCH` | PDF sem marcador de algum papel ou com marcador inválido (`details.missing_signature`, `unknown_roles`, `invalid`) | Corrigir o gerador de PDF — nada foi criado |
| `422 COMPANY_SIGNATURE_NOT_AUTHORIZED` | Loja não autorizou a assinatura pela integração | Pedir ao proprietário para autorizar |
| `402 PLAN_LIMIT_REACHED` | Limite do plano | Avisar a loja |
| `409 CONTRACT_IN_PROGRESS` | Mesmo `externalRef` sendo processado agora | Tentar de novo em alguns segundos |
| `429` / `5xx` / timeout | Instabilidade | **Reenviar a mesma requisição** (mesmo `externalRef`) com espera crescente |

Reenviar o mesmo `externalRef` é **seguro**: devolve o mesmo envelope (`replayed: true`), sem duplicar, com um
link novo para o cliente. Para gerar um contrato novo para a mesma venda (ex.: após cancelar), use outro
`externalRef` (ex.: `venda-123-v2`) — ou o mesmo, se o anterior estiver cancelado/expirado/recusado.

## 4. Entregar o link ao cliente

- O cliente **já recebe o convite por e-mail** e, se o `phone` foi informado e o WhatsApp da plataforma
  estiver ativo, **também pelo WhatsApp** (número central do Adapter Sign) — não é preciso enviar nada.
- O sistema de vendas pode também mostrar o `signingUrl` na tela (QR code). Ao abrir um link entregue pela
  API, o código de verificação vai por WhatsApp (quando houver telefone); o cliente pode pedir por e-mail.
- Link novo (ex.: cliente perdeu o e-mail): `POST /envelopes/{id}/signers/{signerId}/link` → `{ "signingUrl", "expiresAt" }`.
- Na abertura do link, o cliente confirma um código de 6 dígitos (pelo mesmo canal do link) antes de assinar.
- Informe o telefone com DDD (ex.: `(24) 99999-1234` ou `+5524999991234`); números inválidos são recusados com `400`.

## 5. Receber o resultado (webhooks)

Eventos recomendados: `signer.signed`, `signer.declined`, `envelope.completed`, `envelope.expired`,
`envelope.cancelled`. Todo payload traz `data.envelope.external_ref` para localizar a venda:

```json
{
  "id": "evt…", "type": "envelope.completed", "created_at": "…", "organization_id": "…",
  "data": {
    "envelope": { "id": "…", "status": "COMPLETED", "validation_code": "ADP-…", "external_ref": "venda-123",
                  "documents": [{ "id": "…", "filename": "contrato.pdf", "final_available": true }] },
    "signer": null
  }
}
```

No endpoint do sistema de vendas:

1. **Verifique a assinatura HMAC** com o corpo **bruto** (exemplo em [`api.md`](api.md#verificação-da-assinatura-hmac-sha256)); recuse se inválida.
2. **Descarte eventos repetidos** (`X-Adapter-Event-ID` já processado).
3. Responda **2xx rápido** e processe em segundo plano (fila). Falhas são reenviadas em 1 min, 5 min, 30 min e 2 h.

## 6. Baixar o contrato assinado para a ficha do cliente

Ao receber `envelope.completed`:

```text
GET /envelopes/{id}/documents/{documents[].id}/final   → PDF assinado (assinaturas nos lugares + página de assinaturas)
GET /envelopes/{id}/evidence                           → relatório de evidências (PDF)
```

Guarde os dois arquivos na ficha do cliente, junto com o `validationCode`. Qualquer pessoa pode conferir a
autenticidade em `https://sign.adapterco.com.br/verify` (código ou arquivo).

## 7. Status para a ficha

| Evento / situação | Status sugerido na venda |
| --- | --- |
| Resposta do envio (`201`) | Aguardando assinatura do cliente |
| `signer.signed` (cliente) | Cliente assinou — finalizando |
| `envelope.completed` | **Contrato assinado** (baixar arquivos) |
| `signer.declined` | Recusado pelo cliente (`data.signer`) |
| `envelope.expired` | Expirado — reenviar com novo `externalRef` |
| `envelope.cancelled` | Cancelado |

Consulta a qualquer momento: `GET /envelopes?externalRef=venda-123` ou `GET /envelopes/{id}`.

## 8. Tabela sugerida no sistema de vendas

| Coluna | Uso |
| --- | --- |
| `venda_id` / `cliente_id` | Relacionamento interno |
| `external_ref` | Enviado ao Adapter Sign (único) |
| `envelope_id`, `validation_code` | Retorno do envio |
| `status` | Atualizado pelos webhooks (seção 7) |
| `pdf_assinado`, `pdf_evidencias` | Caminhos dos arquivos baixados |
| `enviado_em`, `concluido_em` | Datas |

## 9. Checklist

- [ ] Modelos criados e PDFs testados em "Testar com um PDF"
- [ ] Autorização da assinatura da empresa aceita pelo proprietário
- [ ] API key e segredo do webhook guardados cifrados, só no servidor
- [ ] Gerador de PDF inclui os marcadores (texto, não imagem)
- [ ] Envio com `externalRef` único e retentativa com o mesmo `externalRef`
- [ ] Webhook com verificação HMAC, deduplicação por event id e resposta 2xx rápida
- [ ] Download do PDF final + evidências na ficha ao receber `envelope.completed`
- [ ] Tela da venda mostra o status e permite gerar link novo para o cliente
