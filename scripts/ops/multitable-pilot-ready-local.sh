#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/multitable-pilot-ready-local/${timestamp}}"
SMOKE_ROOT="${OUTPUT_ROOT}/smoke"
PROFILE_ROOT="${OUTPUT_ROOT}/profile"
GATE_ROOT="${OUTPUT_ROOT}/gates"
READINESS_MD="${OUTPUT_ROOT}/readiness.md"
READINESS_JSON="${OUTPUT_ROOT}/readiness.json"
GATE_REPORT_JSON="${OUTPUT_ROOT}/gates/report.json"
GATE_REPORT_MD="${OUTPUT_ROOT}/gates/report.md"
LOCAL_UI_GRID_OPEN_MAX_MS="${LOCAL_UI_GRID_OPEN_MAX_MS:-500}"
LOCAL_UI_GRID_SEARCH_HIT_MAX_MS="${LOCAL_UI_GRID_SEARCH_HIT_MAX_MS:-300}"
LOCAL_API_GRID_INITIAL_LOAD_MAX_MS="${LOCAL_API_GRID_INITIAL_LOAD_MAX_MS:-75}"
LOCAL_API_GRID_SEARCH_HIT_MAX_MS="${LOCAL_API_GRID_SEARCH_HIT_MAX_MS:-75}"
ROW_COUNT="${ROW_COUNT:-2000}"
PROFILE_RETRY_ON_FAIL="${PROFILE_RETRY_ON_FAIL:-true}"
FALLBACK_OUTPUT_ROOT="${FALLBACK_OUTPUT_ROOT:-output/playwright/multitable-pilot-ready-local-current}"
PILOT_DATABASE_URL="${PILOT_DATABASE_URL:-${DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}}"
RUNNER_REPORT_BASENAME="${RUNNER_REPORT_BASENAME:-local-report}"
PROFILE_USE_PREVIEW="${PROFILE_USE_PREVIEW:-true}"
PROFILE_WEB_BASE="${PROFILE_WEB_BASE:-http://127.0.0.1:4173}"
PROFILE_WEB_PID=""

function parse_port() {
  python3 - <<'PY' "$1"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
if url.port:
    print(url.port)
elif url.scheme == 'https':
    print(443)
else:
    print(80)
PY
}

function wait_for_url() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 45); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[multitable-pilot-ready-local] ERROR: ${name} failed to become ready: ${url}" >&2
  return 1
}

function cleanup() {
  if [[ -n "$PROFILE_WEB_PID" ]]; then
    kill "$PROFILE_WEB_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

print_signoff_recovery_path() {
  local readiness_json="$1"
  if [[ ! -f "$readiness_json" ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "[multitable-pilot-ready-local] WARN: jq not found, skipping sign-off recovery summary output" >&2
    return 0
  fi

  local step1_command
  local repair_instruction
  local repair_helper
  step1_command="$(jq -r '.signoffRecoveryPath.step1RunPreflight // empty' "$readiness_json")"
  if [[ -z "$step1_command" ]]; then
    return 0
  fi
  repair_instruction="$(jq -r '.signoffRecoveryPath.step2RepairInstruction // empty' "$readiness_json")"
  repair_helper="$(jq -r '.signoffRecoveryPath.step2RepairHelper // empty' "$readiness_json")"

  echo "[multitable-pilot-ready-local] signoff_recovery=preflight -> quick-fix -> return evidence" >&2
  echo "[multitable-pilot-ready-local] step1_command=${step1_command}" >&2
  if [[ -n "$repair_instruction" ]]; then
    echo "[multitable-pilot-ready-local] repair_instruction=${repair_instruction}" >&2
  fi
  if [[ -n "$repair_helper" ]]; then
    echo "[multitable-pilot-ready-local] repair_helper=${repair_helper}" >&2
  fi

  while IFS= read -r evidence_path; do
    [[ -z "$evidence_path" ]] && continue
    echo "[multitable-pilot-ready-local] return_evidence=${evidence_path}" >&2
  done < <(jq -r '.signoffRecoveryPath.step3ReturnEvidence[]? // empty' "$readiness_json")
}

if ! mkdir -p "$SMOKE_ROOT" "$PROFILE_ROOT" "$GATE_ROOT" 2>/dev/null; then
  echo "[multitable-pilot-ready-local] WARN: failed to create ${OUTPUT_ROOT}, falling back to ${FALLBACK_OUTPUT_ROOT}" >&2
  OUTPUT_ROOT="$FALLBACK_OUTPUT_ROOT"
  SMOKE_ROOT="${OUTPUT_ROOT}/smoke"
  PROFILE_ROOT="${OUTPUT_ROOT}/profile"
  GATE_ROOT="${OUTPUT_ROOT}/gates"
  READINESS_MD="${OUTPUT_ROOT}/readiness.md"
  READINESS_JSON="${OUTPUT_ROOT}/readiness.json"
  GATE_REPORT_JSON="${OUTPUT_ROOT}/gates/report.json"
  GATE_REPORT_MD="${OUTPUT_ROOT}/gates/report.md"
  PROFILE_RETRY_ON_FAIL="${PROFILE_RETRY_ON_FAIL:-true}"
  mkdir -p "$SMOKE_ROOT" "$PROFILE_ROOT" "$GATE_ROOT"
fi

echo "[multitable-pilot-ready-local] Running multitable pilot smoke" >&2
OUTPUT_ROOT="$SMOKE_ROOT" \
ENSURE_PLAYWRIGHT="${ENSURE_PLAYWRIGHT:-true}" \
HEADLESS="${HEADLESS:-true}" \
TIMEOUT_MS="${TIMEOUT_MS:-30000}" \
API_BASE="${API_BASE:-http://127.0.0.1:7778}" \
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}" \
PILOT_DATABASE_URL="${PILOT_DATABASE_URL}" \
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}" \
pnpm verify:multitable-pilot:local

PROFILE_WEB_BASE_EFFECTIVE="${WEB_BASE:-http://127.0.0.1:8899}"
if [[ "${PROFILE_USE_PREVIEW}" == "true" ]]; then
  PROFILE_WEB_BASE_EFFECTIVE="${PROFILE_WEB_BASE}"
  echo "[multitable-pilot-ready-local] Building web preview bundle for profile" >&2
  pnpm --filter @metasheet/web build
  if ! curl -fsS "${PROFILE_WEB_BASE_EFFECTIVE}/" >/dev/null 2>&1; then
    echo "[multitable-pilot-ready-local] Starting web preview for profile" >&2
    PROFILE_WEB_PORT="$(parse_port "${PROFILE_WEB_BASE_EFFECTIVE}")"
    pnpm --filter @metasheet/web preview --host 127.0.0.1 --port "${PROFILE_WEB_PORT}" >"${PROFILE_ROOT}/web-preview.log" 2>&1 &
    PROFILE_WEB_PID=$!
    wait_for_url "${PROFILE_WEB_BASE_EFFECTIVE}/" "web preview"
  else
    echo "[multitable-pilot-ready-local] Reusing running web preview at ${PROFILE_WEB_BASE_EFFECTIVE}" >&2
  fi
fi

echo "[multitable-pilot-ready-local] Running multitable grid profile" >&2
OUTPUT_ROOT="$PROFILE_ROOT" \
ROW_COUNT="$ROW_COUNT" \
ENSURE_PLAYWRIGHT=false \
HEADLESS="${HEADLESS:-true}" \
TIMEOUT_MS="${TIMEOUT_MS:-30000}" \
API_BASE="${API_BASE:-http://127.0.0.1:7778}" \
WEB_BASE="${PROFILE_WEB_BASE_EFFECTIVE}" \
PILOT_DATABASE_URL="${PILOT_DATABASE_URL}" \
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}" \
pnpm profile:multitable-grid:local

echo "[multitable-pilot-ready-local] Validating profile thresholds" >&2
if ! REPORT_JSON="${PROFILE_ROOT}/report.json" \
SUMMARY_MD="${PROFILE_ROOT}/summary.md" \
UI_GRID_OPEN_MAX_MS="${UI_GRID_OPEN_MAX_MS:-${LOCAL_UI_GRID_OPEN_MAX_MS}}" \
UI_GRID_SEARCH_HIT_MAX_MS="${UI_GRID_SEARCH_HIT_MAX_MS:-${LOCAL_UI_GRID_SEARCH_HIT_MAX_MS}}" \
API_GRID_INITIAL_LOAD_MAX_MS="${API_GRID_INITIAL_LOAD_MAX_MS:-${LOCAL_API_GRID_INITIAL_LOAD_MAX_MS}}" \
API_GRID_SEARCH_HIT_MAX_MS="${API_GRID_SEARCH_HIT_MAX_MS:-${LOCAL_API_GRID_SEARCH_HIT_MAX_MS}}" \
pnpm verify:multitable-grid-profile:summary; then
  if [[ "${PROFILE_RETRY_ON_FAIL}" != "true" ]]; then
    exit 1
  fi
  echo "[multitable-pilot-ready-local] Profile thresholds failed, rerunning profile once to smooth local cold-start variance" >&2
  OUTPUT_ROOT="$PROFILE_ROOT" \
  ROW_COUNT="$ROW_COUNT" \
  ENSURE_PLAYWRIGHT=false \
  HEADLESS="${HEADLESS:-true}" \
  TIMEOUT_MS="${TIMEOUT_MS:-30000}" \
  API_BASE="${API_BASE:-http://127.0.0.1:7778}" \
  WEB_BASE="${PROFILE_WEB_BASE_EFFECTIVE}" \
  PILOT_DATABASE_URL="${PILOT_DATABASE_URL}" \
  RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}" \
  pnpm profile:multitable-grid:local

  REPORT_JSON="${PROFILE_ROOT}/report.json" \
  SUMMARY_MD="${PROFILE_ROOT}/summary.md" \
  UI_GRID_OPEN_MAX_MS="${UI_GRID_OPEN_MAX_MS:-${LOCAL_UI_GRID_OPEN_MAX_MS}}" \
  UI_GRID_SEARCH_HIT_MAX_MS="${UI_GRID_SEARCH_HIT_MAX_MS:-${LOCAL_UI_GRID_SEARCH_HIT_MAX_MS}}" \
  API_GRID_INITIAL_LOAD_MAX_MS="${API_GRID_INITIAL_LOAD_MAX_MS:-${LOCAL_API_GRID_INITIAL_LOAD_MAX_MS}}" \
  API_GRID_SEARCH_HIT_MAX_MS="${API_GRID_SEARCH_HIT_MAX_MS:-${LOCAL_API_GRID_SEARCH_HIT_MAX_MS}}" \
  pnpm verify:multitable-grid-profile:summary
fi

echo "[multitable-pilot-ready-local] Running release gate" >&2
RUN_MODE=local \
REPORT_JSON="${GATE_REPORT_JSON}" \
REPORT_MD="${GATE_REPORT_MD}" \
LOG_PATH="${GATE_ROOT}/release-gate.log" \
PILOT_SMOKE_REPORT="${SMOKE_ROOT}/report.json" \
PILOT_SMOKE_REPORT_MD="${SMOKE_ROOT}/report.md" \
SKIP_MULTITABLE_PILOT_SMOKE=true \
bash scripts/ops/multitable-pilot-release-gate.sh >"${GATE_ROOT}/release-gate.log" 2>&1

echo "[multitable-pilot-ready-local] Writing readiness summary" >&2
SMOKE_REPORT_JSON="${SMOKE_ROOT}/report.json" \
SMOKE_REPORT_MD="${SMOKE_ROOT}/report.md" \
SMOKE_RUNNER_REPORT_JSON="${SMOKE_ROOT}/${RUNNER_REPORT_BASENAME}.json" \
SMOKE_RUNNER_REPORT_MD="${SMOKE_ROOT}/${RUNNER_REPORT_BASENAME}.md" \
PROFILE_REPORT_JSON="${PROFILE_ROOT}/report.json" \
PROFILE_SUMMARY_MD="${PROFILE_ROOT}/summary.md" \
GATE_REPORT_JSON="${GATE_REPORT_JSON}" \
GATE_REPORT_MD="${GATE_REPORT_MD}" \
GATE_LOG_PATH="${GATE_ROOT}/release-gate.log" \
READINESS_MD="${READINESS_MD}" \
READINESS_JSON="${READINESS_JSON}" \
node scripts/ops/multitable-pilot-readiness.mjs

echo "[multitable-pilot-ready-local] PASS: readiness complete" >&2
echo "[multitable-pilot-ready-local] readiness_md=${READINESS_MD}" >&2
echo "[multitable-pilot-ready-local] readiness_json=${READINESS_JSON}" >&2
echo "[multitable-pilot-ready-local] gate_report_json=${GATE_REPORT_JSON}" >&2
echo "[multitable-pilot-ready-local] gate_report_md=${GATE_REPORT_MD}" >&2
print_signoff_recovery_path "${READINESS_JSON}"
