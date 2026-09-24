# Instalação e produção (VPS)

## Pré-requisitos

- VPS Linux com Docker Engine e o plugin Compose v2 (`docker compose version`).
- Nginx (ou Traefik) com TLS (ex.: certbot) e DNS de `app.<domínio>` e `api.<domínio>` apontando para a VPS.
- Bucket S3-compatible **privado**: Cloudflare R2 ou Amazon S3 (recomendados em produção) ou MinIO.
- Servidor SMTP: Amazon SES, Resend (SMTP) ou equivalente, com SPF/DKIM configurados no domínio remetente.

## Validação obrigatória antes de produção

O código ainda não foi compilado nem testado (veja o README). Rode na VPS, ou numa máquina com Node 22 e Docker:

```bash
npm install                      # gera package-lock.json — versione-o
npm run lint
npm run typecheck                # gera o Prisma Client e checa os tipos da API e da web
npm test                         # testes unitários
DATABASE_URL=postgresql://x:x@localhost:5432/x npm run build

# E2E com infraestrutura real (perfil "local")
cp .env.example .env             # ajuste para teste: NODE_ENV=test, URLs http://localhost, COOKIE_SECURE=false
docker compose --profile local up -d postgres redis minio minio-init mailpit
cd apps/api && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
MAILPIT_URL=http://localhost:8025 npm run test:integration
```

Corrija qualquer falha antes de continuar. O pipeline em `.github/workflows/ci.yml` executa essas mesmas etapas.

## Implantação

```bash
git clone <repositório> adapter-sign && cd adapter-sign
cp .env.example .env && chmod 600 .env
```

Edite o `.env`. Nenhum valor de exemplo é aceito em produção; a API recusa iniciar:

| Variável | Como gerar / observação |
| --- | --- |
| `JWT_ACCESS_SECRET`, `TOKEN_HASH_SECRET` | `openssl rand -hex 48` (valores diferentes) |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`. **Guarde com segurança**: sem ela, CPFs e segredos de webhook ficam ilegíveis |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | senhas fortes; repita-as em `DATABASE_URL` e `REDIS_URL` |
| `APP_PUBLIC_URL`, `API_PUBLIC_URL` | `https://app.<domínio>` / `https://api.<domínio>` |
| `STORAGE_*` | credenciais do bucket privado (veja "Storage") |
| `SMTP_*`, `EMAIL_FROM` | credenciais do provedor SMTP |
| `TRUST_PROXY_HOPS` | `1` atrás do Nginx |

A lista completa, com comentários, está em [.env.example](../.env.example).

```bash
docker compose up -d --build          # postgres, redis, migrate (one-off), api, worker, web
docker compose ps
curl -fsS http://127.0.0.1:4000/ready
```

### Planos (configuração)

Os planos ficam no banco e nunca são fixados no código. Crie o arquivo real fora do repositório, a partir de `apps/api/config/plans.example.json`:

```bash
cp apps/api/config/plans.example.json /etc/adaptersign-plans.json   # edite limites e preços
docker compose run --rm -v /etc/adaptersign-plans.json:/tmp/plans.json:ro api node dist/cli/plans-sync.js /tmp/plans.json
```

Deve existir o plano indicado em `DEFAULT_PLAN_CODE` (padrão `FREE`); sem ele a API responde `PLAN_NOT_CONFIGURED`.

### Administrador da plataforma

Nenhum usuário é criado com senha padrão. Cadastre-se pela aplicação, confirme o e-mail e conceda o acesso:

```bash
docker compose run --rm api node dist/cli/grant-platform-admin.js voce@seudominio.com.br
```

### Reverse proxy

Use `infra/nginx/adapter-sign.conf` como base: substitua os domínios, emita os certificados e recarregue o Nginx.
Com Traefik, replique as regras: `app.<domínio>/api/*` → `api:4000`, `app.<domínio>/*` → `web:3000`,
`api.<domínio>/*` → `api:4000`, e defina `X-Forwarded-For`/`X-Request-ID`.

### Atualização

```bash
git pull
docker compose up -d --build   # o serviço migrate aplica migrations pendentes antes de api/worker
```

## Storage

- **Cloudflare R2**: `STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `STORAGE_REGION=auto`, `STORAGE_FORCE_PATH_STYLE=false`.
- **Amazon S3**: deixe `STORAGE_ENDPOINT` vazio, `STORAGE_REGION=<região>`, bloqueie todo acesso público do bucket.
- **MinIO** (perfil `local`): `http://minio:9000`, `STORAGE_FORCE_PATH_STYLE=true`. O serviço `minio-init` cria o bucket sem acesso anônimo.
  Observação: a distribuição de imagens da edição comunitária do MinIO mudou em 2025; confirme a disponibilidade da imagem ou use R2/S3.

Regras:

- O bucket **nunca** é público. Downloads passam pela API autenticada, que audita os downloads relevantes.
- Originais são gravados com escrita condicional (`If-None-Match: *`) e nunca são substituídos.
- Recomendado: versionamento e/ou object lock no bucket, credenciais restritas ao bucket e replicação para outra região.
- A credencial da aplicação precisa de `s3:PutObject` com escrita condicional, `GetObject`, `DeleteObject` (usado só para limpar objetos órfãos de transações falhas) e `HeadBucket` (usado pelo `/ready`).

## Backup e restauração

```bash
# senha do backup (guarde fora da VPS também)
openssl rand -base64 48 > /root/.adaptersign-backup-pass && chmod 600 /root/.adaptersign-backup-pass

# backup diário (cron): pg_dump -Fc → gpg AES-256 → retenção de 30 dias
0 3 * * * cd /opt/adapter-sign && BACKUP_DIR=/var/backups/adaptersign BACKUP_PASSPHRASE_FILE=/root/.adaptersign-backup-pass ./infra/backup/pg-backup.sh

# teste de restauração (mensal, obrigatório): restaura em banco temporário e valida
BACKUP_PASSPHRASE_FILE=/root/.adaptersign-backup-pass ./infra/backup/pg-restore-test.sh /var/backups/adaptersign/<arquivo>.dump.gpg
```

- Copie os backups para armazenamento externo (outro provedor ou região).
- Os objetos (PDFs e evidências) ficam no bucket: habilite versionamento/replicação no provedor.
- Backup sem teste de restauração **não** é uma estratégia completa. Registre a data de cada teste.
- Guarde `ENCRYPTION_KEY` e `TOKEN_HASH_SECRET` num cofre separado; sem elas, dados cifrados e tokens não podem ser validados.

## Migrations

- Toda alteração de banco é feita por migration versionada em `apps/api/prisma/migrations`.
- Produção: somente `prisma migrate deploy` (serviço `migrate`), nunca `migrate dev`, `db push` ou `migrate reset`.
- `20260923000100_integrity_guards` contém triggers (append-only e imutabilidade) e CHECKs que o Prisma não representa no schema.
- Antes de uma migration destrutiva: avalie o impacto, faça backup e teste de restauração, planeje o rollback e peça aprovação.
- O CI confere se o banco migrado corresponde ao `schema.prisma` (`migrate diff --exit-code`).

## Observabilidade

- Logs JSON estruturados (pino) com `request_id`. Segredos são redigidos (Authorization, cookies, senhas, OTP, tokens).
- `X-Request-ID` é aceito do proxy ou gerado, e devolvido na resposta; eventos do outbox carregam o `request_id` até o worker.
- `/health` (processo) e `/ready` (banco, Redis e storage).
- O painel da plataforma (`/admin`) mostra contagens das filas, outbox pendente, e-mails e webhooks com falha, e permite reenviar.
