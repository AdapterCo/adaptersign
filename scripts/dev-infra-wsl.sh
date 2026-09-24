#!/usr/bin/env bash
# Infraestrutura local SEM Docker (para máquinas onde Docker não está disponível).
# Executar dentro do WSL/Linux, sem sudo. Tudo fica em $ADS_DEV_HOME.
#   bash scripts/dev-infra-wsl.sh setup   # instala (uma vez)
#   bash scripts/dev-infra-wsl.sh start   # sobe postgres, redis, minio
#   bash scripts/dev-infra-wsl.sh stop
#   bash scripts/dev-infra-wsl.sh status
# Somente desenvolvimento. Credenciais abaixo são locais e fictícias.
set -euo pipefail

ADS_DEV_HOME="${ADS_DEV_HOME:-$HOME/adaptersign-dev}"
PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"
MINIO_PORT="${MINIO_PORT:-59000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-59001}"
REDIS_VERSION="7.2.5"
PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"

mkdir -p "$ADS_DEV_HOME"/{logs,bin}

setup() {
  if [ ! -d "$ADS_DEV_HOME/pg" ]; then
    [ -n "$PG_BIN" ] || { echo "PostgreSQL server não encontrado em /usr/lib/postgresql"; exit 1; }
    echo "adaptersign" > "$ADS_DEV_HOME/.pgpass-init"
    "$PG_BIN/initdb" -D "$ADS_DEV_HOME/pg" -U adaptersign --auth=scram-sha-256 \
      --pwfile="$ADS_DEV_HOME/.pgpass-init" -E UTF8 --locale=C.UTF-8
    rm -f "$ADS_DEV_HOME/.pgpass-init"
    {
      echo "listen_addresses = '*'"
      echo "port = $PG_PORT"
      echo "unix_socket_directories = '$ADS_DEV_HOME'"
    } >> "$ADS_DEV_HOME/pg/postgresql.conf"
    echo "host all all 0.0.0.0/0 scram-sha-256" >> "$ADS_DEV_HOME/pg/pg_hba.conf"
  fi

  if [ ! -x "$ADS_DEV_HOME/bin/redis-server" ]; then
    cd "$ADS_DEV_HOME"
    curl -fsSLO "https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz"
    tar xzf "redis-${REDIS_VERSION}.tar.gz"
    make -C "redis-${REDIS_VERSION}" -j"$(nproc)" BUILD_TLS=no >/dev/null
    cp "redis-${REDIS_VERSION}/src/redis-server" "redis-${REDIS_VERSION}/src/redis-cli" "$ADS_DEV_HOME/bin/"
  fi

  if [ ! -x "$ADS_DEV_HOME/bin/minio" ]; then
    curl -fsSL -o "$ADS_DEV_HOME/bin/minio" "https://dl.min.io/server/minio/release/linux-amd64/minio" \
      && chmod +x "$ADS_DEV_HOME/bin/minio" \
      || echo "AVISO: download do MinIO falhou; configure STORAGE_* para outro S3-compatible."
  fi
  echo "setup ok"
}

start() {
  "$PG_BIN/pg_ctl" -D "$ADS_DEV_HOME/pg" -l "$ADS_DEV_HOME/logs/pg.log" status >/dev/null 2>&1 \
    || "$PG_BIN/pg_ctl" -D "$ADS_DEV_HOME/pg" -l "$ADS_DEV_HOME/logs/pg.log" -w start
  "$ADS_DEV_HOME/bin/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1 \
    || "$ADS_DEV_HOME/bin/redis-server" --port "$REDIS_PORT" --bind 0.0.0.0 --protected-mode no \
         --daemonize yes --dir "$ADS_DEV_HOME" --logfile "$ADS_DEV_HOME/logs/redis.log" --appendonly yes
  if [ -x "$ADS_DEV_HOME/bin/minio" ] && ! pgrep -f "minio server $ADS_DEV_HOME/minio" >/dev/null; then
    mkdir -p "$ADS_DEV_HOME/minio"
    MINIO_ROOT_USER=adaptersign MINIO_ROOT_PASSWORD=adaptersign-dev-secret \
      nohup "$ADS_DEV_HOME/bin/minio" server "$ADS_DEV_HOME/minio" \
      --address ":$MINIO_PORT" --console-address ":$MINIO_CONSOLE_PORT" \
      > "$ADS_DEV_HOME/logs/minio.log" 2>&1 &
    sleep 2
  fi
  status
}

stop() {
  "$PG_BIN/pg_ctl" -D "$ADS_DEV_HOME/pg" stop -m fast || true
  "$ADS_DEV_HOME/bin/redis-cli" -p "$REDIS_PORT" shutdown nosave 2>/dev/null || true
  pkill -f "minio server $ADS_DEV_HOME/minio" || true
}

status() {
  "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" || true
  echo -n "redis: "; "$ADS_DEV_HOME/bin/redis-cli" -p "$REDIS_PORT" ping 2>&1 || true
  echo -n "minio: "; curl -fsS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$MINIO_PORT/minio/health/live" 2>&1 || echo down
}

case "${1:-}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "uso: $0 {setup|start|stop|status}"; exit 1 ;;
esac
