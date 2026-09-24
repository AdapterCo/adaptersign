#!/usr/bin/env bash
# Teste de restauração: restaura um backup em banco TEMPORÁRIO e valida o conteúdo.
# Não toca no banco de produção.
#   BACKUP_PASSPHRASE_FILE=/root/.adaptersign-backup-pass ./infra/backup/pg-restore-test.sh /var/backups/adaptersign/adaptersign-XXXX.dump.gpg
set -euo pipefail

file="${1:?informe o arquivo .dump.gpg}"
PASS_FILE="${BACKUP_PASSPHRASE_FILE:?defina BACKUP_PASSPHRASE_FILE}"
COMPOSE="${COMPOSE:-docker compose}"
tmpdb="restore_test_$(date -u +%Y%m%d%H%M%S)"

if [ -f "$file.sha256" ]; then sha256sum -c "$file.sha256"; fi

$COMPOSE exec -T adaptersign-postgres sh -c "createdb -U \"\$POSTGRES_USER\" $tmpdb"
cleanup() { $COMPOSE exec -T adaptersign-postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists $tmpdb" || true; }
trap cleanup EXIT

gpg --batch --decrypt --passphrase-file "$PASS_FILE" "$file" \
  | $COMPOSE exec -T adaptersign-postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $tmpdb --no-owner --exit-on-error"

echo "Verificações no banco restaurado:"
$COMPOSE exec -T adaptersign-postgres sh -c "psql -U \"\$POSTGRES_USER\" -d $tmpdb -v ON_ERROR_STOP=1 -c \"
  SELECT (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL) AS migrations,
         (SELECT count(*) FROM organizations) AS organizations,
         (SELECT count(*) FROM envelopes) AS envelopes,
         (SELECT count(*) FROM audit_events) AS audit_events,
         (SELECT count(*) FROM evidence_reports) AS evidence_reports;\""
echo "Restauração OK ($tmpdb será removido)."
