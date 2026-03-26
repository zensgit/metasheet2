#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
RUN_LABEL="${RUN_LABEL:-multitable-pilot-staging}"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/${RUN_LABEL}/${timestamp}}"
API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
ENSURE_PLAYWRIGHT="${ENSURE_PLAYWRIGHT:-false}"
HEADLESS="${HEADLESS:-true}"
TIMEOUT_MS="${TIMEOUT_MS:-30000}"
REPORT_NAME="${REPORT_NAME:-report.json}"

echo "[multitable-pilot-staging] Using running services only" >&2
echo "[multitable-pilot-staging] api_base=${API_BASE}" >&2
echo "[multitable-pilot-staging] web_base=${WEB_BASE}" >&2
echo "[multitable-pilot-staging] output_root=${OUTPUT_ROOT}" >&2

RUN_LABEL="${RUN_LABEL}" \
OUTPUT_ROOT="${OUTPUT_ROOT}" \
API_BASE="${API_BASE}" \
WEB_BASE="${WEB_BASE}" \
ENSURE_PLAYWRIGHT="${ENSURE_PLAYWRIGHT}" \
HEADLESS="${HEADLESS}" \
TIMEOUT_MS="${TIMEOUT_MS}" \
REPORT_NAME="${REPORT_NAME}" \
AUTO_START_SERVICES=false \
REQUIRE_RUNNING_SERVICES=true \
bash scripts/ops/multitable-pilot-local.sh
