#!/usr/bin/env bash
# Phase 5: Run snapshot migration (shell wrapper)
# Creates snapshot tables required for restore metrics.
# Usage:
#   export DATABASE_URL=postgres://user:pass@host:5432/db
#   ./packages/core-backend/scripts/phase5-run-snapshot-migration.sh

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[Phase5] ERROR: DATABASE_URL env not set" >&2
  exit 1
fi

echo "[Phase5] Starting snapshot migration (DATABASE_URL configured)"

if ! command -v npx >/dev/null 2>&1; then
  echo "[Phase5] ERROR: npx not found (need Node.js)" >&2
  exit 1
fi

SCRIPT="packages/core-backend/scripts/run-snapshot-migration.ts"
if [[ ! -f "$SCRIPT" ]]; then
  echo "[Phase5] ERROR: migration runner script missing: $SCRIPT" >&2
  exit 1
fi

npx tsx "$SCRIPT"
echo "[Phase5] Migration finished"

