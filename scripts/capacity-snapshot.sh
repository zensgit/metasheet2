#!/usr/bin/env bash
set -euo pipefail

# Capacity snapshot script
# Usage: scripts/capacity-snapshot.sh [output-dir]
# Default output directory: docs/sprint2/capacity

OUT_DIR=${1:-docs/sprint2/capacity}
TS=$(date +%Y%m%d-%H%M%S)
FILE_JSON="$OUT_DIR/capacity-$TS.json"
FILE_MD="$OUT_DIR/capacity-$TS.md"

mkdir -p "$OUT_DIR"

echo "[capacity] collecting..." >&2

psql_cmd() {
  psql "$DATABASE_URL" -Xt -c "$1" 2>/dev/null || psql -Xt -c "$1" 2>/dev/null || return 1
}

DB_SIZE=$(psql_cmd "SELECT pg_database_size(current_database());")
DB_SIZE_H=$(psql_cmd "SELECT pg_size_pretty(pg_database_size(current_database()));")

TABLE_SIZES=$(psql_cmd "SELECT relname, pg_relation_size(relid) AS size_bytes FROM pg_catalog.pg_statio_user_tables ORDER BY pg_relation_size(relid) DESC;")
INDEX_SIZES=$(psql_cmd "SELECT relname, pg_indexes_size(relid) AS index_bytes FROM pg_catalog.pg_statio_user_tables ORDER BY pg_indexes_size(relid) DESC;")

JSON_TMP=$(mktemp)
{
  echo '{'
  echo '  "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
  echo '  "database_size_bytes": '"${DB_SIZE:-0}",
  echo '  "database_size_pretty": "'"${DB_SIZE_H}"'",'
  echo '  "tables": ['
  echo "$TABLE_SIZES" | awk 'NF==2 {printf"    {\"name\":\"%s\",\"size_bytes\":%s},\n", $1,$2}' | sed '$ s/},/}/'
  echo '  ],'
  echo '  "indexes": ['
  echo "$INDEX_SIZES" | awk 'NF==2 {printf"    {\"name\":\"%s\",\"index_bytes\":%s},\n", $1,$2}' | sed '$ s/},/}/'
  echo '  ]'
  echo '}'
} > "$JSON_TMP"

mv "$JSON_TMP" "$FILE_JSON"

cat > "$FILE_MD" <<EOF
# Capacity Snapshot $TS

Database Size: $DB_SIZE_H ($DB_SIZE bytes)

Top Tables (raw):
\n
$(echo "$TABLE_SIZES")

Top Indexes (raw):
\n
$(echo "$INDEX_SIZES")

Source JSON: $FILE_JSON
EOF

echo "[capacity] written $FILE_JSON and $FILE_MD" >&2
