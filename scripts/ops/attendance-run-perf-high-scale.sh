#!/usr/bin/env bash
set -euo pipefail

# 100k+ high-scale baseline runner for attendance import perf.
# Defaults are aligned with workflow profile=high-scale but can be overridden via env.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

API_BASE="${API_BASE:-http://142.171.239.56:8081/api}"
ORG_ID="${ORG_ID:-default}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
ROWS="${ROWS:-100000}"
MODE="${MODE:-commit}"
ROLLBACK="${ROLLBACK:-true}"
COMMIT_ASYNC="${COMMIT_ASYNC:-true}"
UPLOAD_CSV="${UPLOAD_CSV:-true}"
EXPORT_CSV="${EXPORT_CSV:-true}"
PAYLOAD_SOURCE="${PAYLOAD_SOURCE:-auto}"
CSV_ROWS_LIMIT_HINT="${CSV_ROWS_LIMIT_HINT:-100000}"
MAX_PREVIEW_MS="${MAX_PREVIEW_MS:-240000}"
MAX_COMMIT_MS="${MAX_COMMIT_MS:-420000}"
MAX_EXPORT_MS="${MAX_EXPORT_MS:-90000}"
MAX_ROLLBACK_MS="${MAX_ROLLBACK_MS:-30000}"
IMPORT_JOB_POLL_TIMEOUT_MS="${IMPORT_JOB_POLL_TIMEOUT_MS:-3600000}"
IMPORT_JOB_POLL_TIMEOUT_LARGE_MS="${IMPORT_JOB_POLL_TIMEOUT_LARGE_MS:-5400000}"

if [[ -z "${AUTH_TOKEN}" ]]; then
  echo "[attendance-run-perf-high-scale] ERROR: AUTH_TOKEN is required" >&2
  exit 1
fi

echo "[attendance-run-perf-high-scale] API_BASE=${API_BASE}"
echo "[attendance-run-perf-high-scale] ORG_ID=${ORG_ID}"
echo "[attendance-run-perf-high-scale] ROWS=${ROWS}"
echo "[attendance-run-perf-high-scale] MODE=${MODE}"
echo "[attendance-run-perf-high-scale] COMMIT_ASYNC=${COMMIT_ASYNC}"
echo "[attendance-run-perf-high-scale] UPLOAD_CSV=${UPLOAD_CSV}"
echo "[attendance-run-perf-high-scale] PAYLOAD_SOURCE=${PAYLOAD_SOURCE}"
echo "[attendance-run-perf-high-scale] CSV_ROWS_LIMIT_HINT=${CSV_ROWS_LIMIT_HINT}"

node scripts/ops/attendance-import-perf.mjs
