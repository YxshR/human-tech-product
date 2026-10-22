#!/usr/bin/env bash
# Starts a throw-away local Postgres 16 for tests when Docker is unavailable (CI/sandbox use).
# Usage: scripts/pg-local.sh [start|stop]   Requires postgres binaries and permission to run as the postgres user.
set -euo pipefail
D=${PG_LOCAL_DIR:-/var/lib/postgresql/htpg}
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
case "${1:-start}" in
  start)
    if [ ! -d "$D/main" ]; then
      mkdir -p "$D" && chown postgres:postgres "$D"
      su postgres -c "$BIN/initdb -D $D/main -A trust -U postgres >$D/initdb.log 2>&1"
    fi
    su postgres -c "$BIN/pg_ctl -D $D/main -l $D/server.log -o '-p 5432 -c fsync=off -c unix_socket_directories=$D' start" ;;
  stop) su postgres -c "$BIN/pg_ctl -D $D/main stop" ;;
esac
