# Instalação e produção (VPS)

## Pré-requisitos

- VPS Linux com Docker Engine e o plugin Compose v2 (`docker compose version`).
- Traefik já em execução no servidor (provider Docker) e registro DNS `sign.adapterco.com.br` (A/AAAA) apontando para a VPS.
- Bucket S3-compatible **privado**: Cloudflare R2 ou Amazon S3 (recomendados em produção) ou MinIO.
- Servidor SMTP: Amazon SES, Resend (SMTP) ou equivalente, com SPF/DKIM configurados no domínio remetente.

## Validação obrigatória antes de produção

Lint, typecheck, testes unitários e build já foram verificados. Migrations em banco real e o E2E ainda não.
Rode numa máquina com Node 22 e Docker (de preferência **não** no servidor de produção):

```bash
npm install                      # gera package-lock.json — versione-o
npm run lint
npm run typecheck                # gera o Prisma Client e checa os tipos da API e da web
npm test                         # testes unitários
DATABASE_URL=postgresql://x:x@localhost:5432/x npm run build

# E2E com infraestrutura real (perfil "local")
cp .env.example .env             # ajuste para teste: NODE_ENV=test, URLs http://localhost, COOKIE_SECURE=false
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile local up -d adaptersign-postgres adaptersign-redis adaptersign-minio adaptersign-minio-init adaptersign-mailpit
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
| `APP_PUBLIC_URL`, `API_PUBLIC_URL` | ambos `https://sign.adapterco.com.br` (domínio único) |
| `STORAGE_*` | credenciais do bucket privado (veja "Storage") |
| `SMTP_*`, `EMAIL_FROM` | credenciais do provedor SMTP |
| `TRUST_PROXY_HOPS` | `1` (Traefik à frente da API) |
| `ADAPTERSIGN_DOMAIN`, `TRAEFIK_*` | domínio e parâmetros do Traefik existente (veja "Traefik") |

A lista completa, com comentários, está em [.env.example](../.env.example).

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
docker compose ps
docker compose exec adaptersign-api node -e "fetch('http://127.0.0.1:4000/ready').then(r=>r.text()).then(console.log)"
```

### Convivência com as aplicações já em produção

O AdapterSign foi ajustado para **não interferir** nas demais aplicações do servidor:

- **Portas:** nenhuma porta é publicada no host (80/443 continuam exclusivas do Traefik).
- **Nomes:** projeto `adaptersign` e serviços com prefixo `adaptersign-`. Containers, volumes (`adaptersign_pgdata`…),
  imagens (`adaptersign-api`, `adaptersign-web`) e **nomes DNS na rede compartilhada** são únicos, então nenhum
  `web`/`api`/`postgres`/`redis` de outra aplicação é resolvido para o AdapterSign, nem o contrário.
- **Rede:** só `adaptersign-web` e `adaptersign-api` entram na rede do Traefik. Postgres, Redis e worker ficam
  apenas na rede interna do projeto.
- **Traefik:** routers e services com nomes `adaptersign-*`, com regra restrita a `Host(sign.adapterco.com.br)`.
  Nenhuma configuração do Traefik ou de outra aplicação é alterada.
- **Dados:** banco, Redis e volumes dedicados; os comandos deste guia (`docker compose …`) só atuam no projeto `adaptersign`.

O `docker-compose.dev.yml`, que publica portas, é só para desenvolvimento e CI; não use em produção.

### Planos (configuração)

Os planos ficam no banco e nunca são fixados no código. Crie o arquivo real fora do repositório, a partir de `apps/api/config/plans.example.json`:

```bash
cp apps/api/config/plans.example.json /etc/adaptersign-plans.json   # edite limites e preços
docker compose run --rm --no-deps -v /etc/adaptersign-plans.json:/tmp/plans.json:ro adaptersign-api node dist/cli/plans-sync.js /tmp/plans.json
```

Deve existir o plano indicado em `DEFAULT_PLAN_CODE` (padrão `FREE`); sem ele a API responde `PLAN_NOT_CONFIGURED`.

### Administrador da plataforma

Nenhum usuário é criado com senha padrão. Cadastre-se pela aplicação, confirme o e-mail e conceda o acesso:

```bash
docker compose run --rm --no-deps adaptersign-api node dist/cli/grant-platform-admin.js voce@seudominio.com.br
```

### Traefik

A exposição é feita por **labels** em `docker-compose.traefik.yml`, lidas pelo Traefik já existente (provider Docker):

| Router | Regra | Destino |
| --- | --- | --- |
| `adaptersign-api` (prioridade 100) | `Host(sign.adapterco.com.br) && (PathPrefix(/api) \|\| Path(/ready))` | `adaptersign-api:4000` |
| `adaptersign-web` (prioridade 10) | `Host(sign.adapterco.com.br)` | `adaptersign-web:3000` |

URLs: aplicação `https://sign.adapterco.com.br`, assinatura `…/sign/{token}`, validação pública `…/verify`,
API `…/api/v1`, OpenAPI `…/api/docs`. O `/api` vai direto para a API (e não via Next.js), então o IP do cliente
registrado nas evidências é o correto com `TRUST_PROXY_HOPS=1`.

Defina no `.env` os parâmetros do **seu** Traefik. Descubra-os só com comandos de leitura, sem alterar nada:

```bash
# rede, entrypoints e certresolver usados pelo Traefik em execução
docker inspect $(docker ps -q --filter ancestor=traefik:3.6.7) --format '{{json .Args}}{{println}}{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# como uma aplicação já publicada declara suas rotas (labels e rede)
docker inspect adapterflow-web --format '{{json .Config.Labels}}{{println}}{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

- `TRAEFIK_NETWORK`: rede Docker em que o Traefik alcança os containers.
- `TRAEFIK_ENTRYPOINT`: entrypoint HTTPS (ex.: `websecure`, `https`), conforme os argumentos `--entrypoints.*`.
- `TRAEFIK_CERT_RESOLVER`: nome do resolver ACME (`--certificatesresolvers.<nome>.*`).

Se o Traefik **não** tiver o provider Docker ativo (as rotas das outras aplicações vierem de arquivo), as labels
serão ignoradas. Nesse caso, as mesmas rotas da tabela acima precisam ser declaradas no mesmo mecanismo que o
Traefik já usa, apontando para `adaptersign-web:3000` e `adaptersign-api:4000` na rede do Traefik.

### Atualização

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build   # adaptersign-migrate aplica migrations antes de api/worker
```

## Storage

- **Cloudflare R2**: `STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `STORAGE_REGION=auto`, `STORAGE_FORCE_PATH_STYLE=false`.
- **Amazon S3**: deixe `STORAGE_ENDPOINT` vazio, `STORAGE_REGION=<região>`, bloqueie todo acesso público do bucket.
- **MinIO** (perfil `local`, só desenvolvimento): `http://adaptersign-minio:9000`, `STORAGE_FORCE_PATH_STYLE=true`. O serviço `adaptersign-minio-init` cria o bucket sem acesso anônimo.
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
