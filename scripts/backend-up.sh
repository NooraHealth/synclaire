#!/usr/bin/env bash
# Starts everything the integration suite needs, for each country in $COUNTRIES (default "India Nepal"):
#   - Postgres in Docker (container synclaire-hep-pg, port 55432), one database per country
#   - Django migrations and a fresh factory-based seed
#   - the Django dev server (India on 8765, Nepal on 8766, ...)
# and writes test/integration/.state/<country>.json with the base URL, tokens and seeded ids.
# Idempotent: reuses a running container and dev servers. Stop with scripts/backend-down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$ROOT/../hep-unified-backend/hep_backend}"
STATE_DIR="$ROOT/test/integration/.state"
CONTAINER="${PG_CONTAINER:-synclaire-hep-pg}"
PG_PORT="${PG_PORT:-55432}"
COUNTRIES="${COUNTRIES:-India Nepal Bangladesh Indonesia}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)" >&2; exit 1; }
[ -f "$BACKEND_DIR/manage.py" ] || { echo "backend not found at $BACKEND_DIR (set BACKEND_DIR)" >&2; exit 1; }
[ -f "$BACKEND_DIR/.env" ] || { echo "missing $BACKEND_DIR/.env (copy .env.example and fill it in)" >&2; exit 1; }
mkdir -p "$STATE_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker start "$CONTAINER" >/dev/null
  else
    docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p "$PG_PORT:5432" postgres:16-alpine >/dev/null
  fi
fi
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

port_for() {
  case "$1" in
    India) echo 8765 ;;
    Nepal) echo 8766 ;;
    Bangladesh) echo 8767 ;;
    Indonesia) echo 8768 ;;
    *) echo "unknown country $1" >&2; exit 1 ;;
  esac
}

for COUNTRY in $COUNTRIES; do
  lower="$(echo "$COUNTRY" | tr '[:upper:]' '[:lower:]')"
  db="synclaire_${lower}"
  port="$(port_for "$COUNTRY")"
  export COUNTRY
  export DATABASE_URL="postgresql://postgres:postgres@localhost:${PG_PORT}/${db}"

  docker exec "$CONTAINER" psql -U postgres -tAc "select 1 from pg_database where datname='${db}'" | grep -q 1 ||
    docker exec "$CONTAINER" createdb -U postgres "$db"

  echo "[$COUNTRY] migrating $db"
  (cd "$BACKEND_DIR" && uv run manage.py migrate --noinput >/dev/null)

  echo "[$COUNTRY] seeding"
  seed_line="$(cd "$BACKEND_DIR" && uv run manage.py shell < "$ROOT/test/integration/seed.py" | grep '^SEED_RESULT=')"
  seed_json="${seed_line#SEED_RESULT=}"

  pid_file="$STATE_DIR/${lower}.pid"
  if ! { [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }; then
    echo "[$COUNTRY] starting dev server on :$port"
    # Detach stdio and close inherited descriptors so callers waiting on this script's output return.
    (
      cd "$BACKEND_DIR"
      nohup uv run manage.py runserver "127.0.0.1:${port}" --noreload \
        </dev/null >"$STATE_DIR/${lower}.log" 2>&1 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
      echo $! >"$pid_file"
    )
  fi
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/v1/sync/" || true)"
    [ "$code" != "000" ] && break
    sleep 1
  done

  cat >"$STATE_DIR/${lower}.json" <<EOF
{"country": "$COUNTRY", "baseUrl": "http://127.0.0.1:${port}/api/v1", "database": "$db", "container": "$CONTAINER", "seed": $seed_json}
EOF
  echo "[$COUNTRY] ready: $STATE_DIR/${lower}.json"
done
