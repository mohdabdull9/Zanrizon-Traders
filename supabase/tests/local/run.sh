#!/bin/bash
# Rebuild a fresh local test database and apply schema + migrations (+ optional extra files).
set -e
P="psql -h /tmp/pg -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
D=$(cd "$(dirname "$0")" && pwd); M="$D/../../migrations"
$P -d postgres -c "drop database if exists dqtest" -c "create database dqtest"
for f in "$D/00_supabase_stub.sql" "$D/01_base_schema.sql" "$D/02_seed.sql" "$M"/*.sql "$@"; do
  echo ">> $(basename "$f")"; $P -d dqtest -f "$f"
done
