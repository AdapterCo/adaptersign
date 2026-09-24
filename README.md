# Adapter Sign

Plataforma SaaS de assinatura eletrônica de documentos baseada em **identificação, autenticação,
manifestação de vontade, integridade (SHA-256), trilha de auditoria encadeada e evidências
verificáveis** — não apenas em inserir uma imagem de assinatura no PDF.

> Nome provisório. O branding é centralizado (`BRAND_*` / `NEXT_PUBLIC_BRAND_NAME`).

## ⚠️ Estado de verificação

O código foi escrito sem acesso a Docker, PostgreSQL ou Redis no ambiente de desenvolvimento, e
**nenhum comando foi executado** (nem `npm install`, typecheck, lint, testes ou build). Antes de usar
em produção, execute na VPS o roteiro de validação em [docs/deployment.md](docs/deployment.md#validação-obrigatória-antes-de-produção).
Pendências conhecidas estão em [docs/decisions.md](docs/decisions.md#limitações-e-pendências-conhecidas).

## Funcionalidades (MVP)

- Multiempresa com isolamento por `organization_id` validado no backend; papéis OWNER/ADMIN/MEMBER/VIEWER (RBAC extensível).
- Cadastro, login, logout, refresh com rotação e detecção de reuso, recuperação/redefinição de senha,
  verificação de e-mail, encerramento de sessões (Argon2id; cookies HttpOnly/Secure/SameSite).
- Upload de PDF com validação de extensão, MIME, magic bytes, tamanho e estrutura; SHA-256; versões imutáveis.
- Envelopes com state machine centralizada, ordem paralela/sequencial/por grupos, prazo, lembretes, cancelamento, recusa.
- Links individuais com token opaco de 256 bits (somente hash no banco), OTP por e-mail com limite de tentativas,
  cooldown, rate limiting, expiração e uso único.
- `SignatureEngine` isolado: elegibilidade, autenticação, consentimento versionado, integridade, registro,
  evidência, estado e auditoria numa única transação; idempotente por signatário.
- Auditoria append-only com encadeamento `SHA256(previous_hash + JSON canônico)` e proteção por trigger no banco.
- Finalização atômica: recalcula hashes, valida a trilha, gera PDF final (original preservado) e relatório de evidências.
- Validação pública por código (`ADP-XXXX-XXXX-XXXX`) ou upload do arquivo, com dados mascarados.
- API REST `/api/v1` com OpenAPI (`/api/docs`), API keys (só hash), `Idempotency-Key`, webhooks HMAC com retentativas.
- Planos/limites/consumo configuráveis, `BillingProvider` desacoplado, painel da plataforma (somente metadados).
- Worker BullMQ (e-mail, webhooks, finalização, expiração, lembretes, varreduras), outbox transacional.
- Docker Compose, Nginx, backup criptografado + teste de restauração, CI.

## Estrutura

```text
apps/api   NestJS 11 + Prisma 7 (API HTTP e worker na mesma base de código)
apps/web   Next.js 16 + React 19 + Tailwind CSS 4
infra/     Nginx e scripts de backup
docs/      Documentação
```

## Início rápido (VPS)

```bash
cp .env.example .env   # edite TODOS os valores
docker compose up -d --build
```

Guia completo: [docs/deployment.md](docs/deployment.md).

## Documentação

| Tema | Arquivo |
| --- | --- |
| Arquitetura e fluxos | [docs/architecture.md](docs/architecture.md) |
| Instalação, produção, variáveis, storage, backup, migrations | [docs/deployment.md](docs/deployment.md) |
| Desenvolvimento e testes | [docs/development.md](docs/development.md) |
| API REST e webhooks | [docs/api.md](docs/api.md) |
| Segurança e LGPD | [docs/security.md](docs/security.md) |
| Decisões técnicas e limitações | [docs/decisions.md](docs/decisions.md) |

## Aviso jurídico

O sistema registra **exatamente** quais métodos, autenticações e evidências foram usados e não afirma
validade jurídica universal. Assinatura qualificada ICP-Brasil não faz parte do MVP; a arquitetura está
preparada para ela.
