#!/usr/bin/env bash
# Backup criptografado do PostgreSQL (executar na VPS via cron/systemd timer).
#   BACKUP_DIR=/var/backups/adaptersign BACKUP_PASSPHRASE_FILE=/root/.adaptersign-backup-pass \
#   RETENTION_DAYS=30 ./infra/backup/pg-backup.sh
# Requisitos: docker compose (serviço "adaptersign-postgres"), gpg.
# O backup só é estratégia completa com TESTE DE RESTAURAÇÃO (ver pg-restore-test.sh).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?defina BACKUP_DIR}"
PASS_FILE="${BACKUP_PASSPHRASE_FILE:?defina BACKUP_PASSPHRASE_FILE (arquivo com a senha, chmod 600)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
COMPOSE="${COMPOSE:-docker compose}"

mkdir -p "$BACKUP_DIR"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/adaptersign-$stamp.dump.gpg"

# pg_dump em formato custom (comprimido) → cifrado com AES-256 (gpg simétrico).
$COMPOSE exec -T adaptersign-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS_FILE" -o "$out"

sha256sum "$out" > "$out.sha256"
echo "backup gerado: $out"

# Retenção: remove backups mais antigos que RETENTION_DAYS (política explícita).
find "$BACKUP_DIR" -name 'adaptersign-*.dump.gpg*' -type f -mtime "+$RETENTION_DAYS" -print -delete

# Recomendado: copiar $out para armazenamento externo (outro provedor/região), p.ex.:
#   aws s3 cp "$out" s3://bucket-de-backup/ --storage-class STANDARD_IA
