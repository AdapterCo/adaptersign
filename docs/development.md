# Desenvolvimento e testes

## Ambiente local

Requisitos: Node.js 22.12+ e Docker.

```bash
npm install
cp .env.example .env
```

No `.env` de desenvolvimento:

```dotenv
NODE_ENV=development
APP_PUBLIC_URL=http://localhost:3000
API_PUBLIC_URL=http://localhost:4000
COOKIE_SECURE=false
TRUST_PROXY_HOPS=0
DATABASE_URL=postgresql://adaptersign:<senha>@localhost:5432/adaptersign?schema=public
REDIS_URL=redis://:<senha>@localhost:6379/0
STORAGE_ENDPOINT=http://localhost:9000
SMTP_HOST=localhost
SEED_USER_PASSWORD=<uma senha local com 10+ caracteres>
```

```bash
docker compose --profile local up -d postgres redis minio minio-init mailpit
cd apps/api
npx prisma migrate dev          # aplica migrations e gera o client
npm run db:seed                 # planos de exemplo + usuário dev@exemplo.test (recusa rodar em produção)
npm run dev                     # API em :4000 (Swagger em /api/docs)
npm run dev:worker              # em outro terminal
cd ../web && npm run dev        # web em :3000 (rewrite /api/v1 → :4000)
```

E-mails (convites, OTP) aparecem no Mailpit: <http://localhost:8025>.

## Convenções

- **Tenant**: toda query de dados empresariais filtra por `auth.organizationId`, vindo da sessão ou da API key e nunca do cliente. Não use `findUnique(id)` sem conferir o escopo.
- **Estados**: toda mudança de status passa por `envelope-state.ts`, com `UPDATE` condicional ou lock `FOR UPDATE`.
- **Auditoria**: toda operação crítica chama `AuditService.record(tx, ...)` na mesma transação.
- **Efeitos colaterais** (e-mail, webhook, finalização): somente via outbox (`OutboxService.emit` + `dispatch`).
- **Erros**: `AppError` com código estável; o filtro global produz `{ error: { code, message, request_id } }`.
- **Textos de UI**: somente em `apps/web/src/lib/i18n.ts`. Templates de e-mail: `modules/notifications/templates.ts`.
- **Datas**: UTC no servidor; formatação no fuso do usuário no frontend.
- **Segredos**: nunca em código ou logs; somente variáveis de ambiente.

## Testes

| Tipo | Comando | Requer |
| --- | --- | --- |
| Unitários | `npm test` | nada (somente `prisma generate`) |
| Integração/E2E | `npm run test:integration -w @adapter-sign/api` | PostgreSQL migrado, Redis, MinIO, Mailpit |

Os testes unitários (`apps/api/test/unit`) cobrem: encadeamento de auditoria e serialização canônica, state
machine e ordem por grupos, geração de tokens/OTP/códigos, mascaramento, CPF, HMAC de webhooks (com replay),
proteção SSRF, validação de PDF (magic bytes, estrutura) e geração do PDF final e do relatório.

O teste E2E (`apps/api/test/integration/signing-flow.int-spec.ts`) cobre o fluxo obrigatório
empresa → usuário → upload → envelope → signatário → convite → OTP → aceite → assinatura → conclusão → relatório → validação,
e também IDOR/acesso entre tenants, CSRF, upload inválido, OTP incorreto, assinatura duplicada (idempotência),
tabela append-only e sessão revogada.

Ainda não cobertos por teste automatizado (fazer antes de produção): brute force de OTP até o bloqueio,
rate limit HTTP (429), token de convite expirado ou revogado, API key revogada, replay de webhook ponta a ponta,
expiração automática pelo worker e testes de UI no navegador.
