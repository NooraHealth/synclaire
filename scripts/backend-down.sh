#!/usr/bin/env bash
# Stops the dev servers started by backend-up.sh. Pass --all to also stop the Postgres container.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/test/integration/.state"

for pid_file in "$STATE_DIR"/*.pid; do
  [ -f "$pid_file" ] || continue
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
done

if [ "${1:-}" = "--all" ]; then
  docker stop "${PG_CONTAINER:-synclaire-hep-pg}" >/dev/null 2>&1 || true
fi
echo "stopped"
