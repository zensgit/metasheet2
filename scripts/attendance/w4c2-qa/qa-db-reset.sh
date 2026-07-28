#!/usr/bin/env bash
# W4C-2 QA — isolated database create/reset script.
#
# Scope guard: LOCAL/ISOLATED functional testing with synthetic data only.
# This script refuses non-localhost hosts and refuses database names that do
# not carry the w4c2_qa marker, so it cannot be pointed at a shared CI DB,
# staging, or production by accident. Staging flag + 7-day soak are a separate
# authorization (post W4C-4) and are OUT of scope here.
#
# Usage:
#   scripts/attendance/w4c2-qa/qa-db-reset.sh [db_name]
# Defaults: db_name=w4c2_qa, host=localhost, user=postgres (override via
# QA_PGHOST / QA_PGUSER). Run from the PR #4612 head checkout root.
set -euo pipefail

DB_NAME="${1:-w4c2_qa}"
PGHOST="${QA_PGHOST:-localhost}"
PGUSER="${QA_PGUSER:-postgres}"

case "$PGHOST" in
  localhost|127.0.0.1) ;;
  *)
    echo "REFUSED: QA reset only runs against localhost/127.0.0.1 (got: $PGHOST)" >&2
    exit 2
    ;;
esac

case "$DB_NAME" in
  *w4c2_qa*) ;;
  *)
    echo "REFUSED: database name must contain 'w4c2_qa' (got: $DB_NAME) — this guard" >&2
    echo "prevents dropping a non-QA database by accident." >&2
    exit 2
    ;;
esac

if [ ! -f "packages/core-backend/package.json" ]; then
  echo "REFUSED: run from the repo root of the PR #4612 head checkout" >&2
  exit 2
fi

echo "== Dropping (if exists) and recreating database '$DB_NAME' on $PGHOST =="
dropdb --if-exists -h "$PGHOST" -U "$PGUSER" "$DB_NAME"
createdb -h "$PGHOST" -U "$PGUSER" "$DB_NAME"

export DATABASE_URL="postgresql://${PGUSER}@${PGHOST}:5432/${DB_NAME}"
# Same exclusion list as .github/workflows/plugin-tests.yml "Run DB migrations"
# (the CI per-PR gate list; see that step's comment for per-item provenance).
export MIGRATION_EXCLUDE="008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql"

echo "== Running migrations against $DATABASE_URL =="
pnpm --filter @metasheet/core-backend db:migrate

echo "== Done. Export before running suites: =="
echo "  export DATABASE_URL=$DATABASE_URL"
echo "  export ATTENDANCE_TEST_DATABASE_URL=$DATABASE_URL"
