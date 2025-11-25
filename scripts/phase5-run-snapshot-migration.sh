#!/bin/bash
# Run Phase 9 snapshot tables migration if not present (for local validation)
set -euo pipefail
SCRIPT="packages/core-backend/src/db/migrations/20251116120000_create_snapshot_tables.ts"
if [ ! -f "$SCRIPT" ]; then
  echo "Migration script not found: $SCRIPT" >&2
  exit 1
fi
echo "Checking snapshot_restore_log table existence..."
psql_cmd=${PSQL_CMD:-psql}
DB_URL=${DATABASE_URL:-}
if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL not set; skipping DB migration." >&2
  exit 1
fi
echo "Using DATABASE_URL (redacted)."
TABLE_EXISTS=$($psql_cmd "$DB_URL" -t -c "SELECT to_regclass('public.snapshot_restore_log');" 2>/dev/null | tr -d ' \n')
if [ "$TABLE_EXISTS" != "snapshot_restore_log" ]; then
  echo "Table snapshot_restore_log missing; running embedded TypeScript migration via ts-node.";
  if ! command -v ts-node >/dev/null 2>&1; then
    echo "ts-node not found; install dev dependency or use node -r ts-node/register." >&2
    exit 1
  fi
  ts-node "$SCRIPT" || { echo "Migration execution failed" >&2; exit 1; }
else
  echo "Table snapshot_restore_log already exists; skipping.";
fi
