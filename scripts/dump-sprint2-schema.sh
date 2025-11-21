#!/usr/bin/env bash
set -euo pipefail

DB_NAME=${DB_NAME:-metasheet_v2}
OUT="docs/sprint2/performance/schema-sprint2.txt"
mkdir -p "$(dirname "$OUT")"

echo "# Sprint 2 Schema Snapshot — $(date)" > "$OUT"
echo "DB: $DB_NAME" >> "$OUT"

dump() {
  echo -e "\n## $1" >> "$OUT"
  psql "$DB_NAME" -c "$2" >> "$OUT" 2>/dev/null || echo "(psql not available)" >> "$OUT"
}

dump "snapshots" "\\d+ snapshots"
dump "snapshot_items" "\\d+ snapshot_items"
dump "protection_rules" "\\d+ protection_rules"
dump "rule_execution_log" "\\d+ rule_execution_log"
dump "snapshot_restore_log" "\\d+ snapshot_restore_log"

echo "Saved -> $OUT"

