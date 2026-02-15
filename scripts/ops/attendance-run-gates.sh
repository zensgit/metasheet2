#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

API_BASE="${API_BASE:-}"
WEB_URL="${WEB_URL:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-attendance}"
HEADLESS="${HEADLESS:-true}"
OUTPUT_ROOT="${OUTPUT_ROOT:-}"
RUN_PREFLIGHT="${RUN_PREFLIGHT:-auto}" # auto|true|false
PROVISION_USER_ID="${PROVISION_USER_ID:-}" # optional
REQUIRE_ATTENDANCE_ADMIN_API="${REQUIRE_ATTENDANCE_ADMIN_API:-false}"
REQUIRE_IDEMPOTENCY="${REQUIRE_IDEMPOTENCY:-false}"
REQUIRE_IMPORT_EXPORT="${REQUIRE_IMPORT_EXPORT:-false}"
REQUIRE_IMPORT_UPLOAD="${REQUIRE_IMPORT_UPLOAD:-false}"
REQUIRE_IMPORT_ASYNC="${REQUIRE_IMPORT_ASYNC:-false}"
REQUIRE_PREVIEW_ASYNC="${REQUIRE_PREVIEW_ASYNC:-false}"
REQUIRE_BATCH_RESOLVE="${REQUIRE_BATCH_RESOLVE:-false}"

function die() {
  echo "[attendance-run-gates] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-run-gates] $*" >&2
}

function normalize_url() {
  local value="$1"
  value="${value%/}"
  echo "$value"
}

function derive_web_url_from_api_base() {
  local api
  api="$(normalize_url "$1")"
  if [[ "$api" == */api ]]; then
    echo "${api%/api}/attendance"
    return 0
  fi
  # Fallback: assume API_BASE is origin (no /api suffix).
  echo "${api}/attendance"
}

function normalize_web_url_to_attendance() {
  local value
  value="$(normalize_url "$1")"
  if [[ "$value" == */attendance* ]]; then
    echo "$value"
    return 0
  fi
  echo "${value}/attendance"
}

[[ -n "$API_BASE" ]] || die "API_BASE is required (example: http://142.171.239.56:8081/api)"
[[ -n "$AUTH_TOKEN" ]] || die "AUTH_TOKEN is required"

API_BASE="$(normalize_url "$API_BASE")"
if [[ -z "$WEB_URL" ]]; then
  WEB_URL="$(derive_web_url_from_api_base "$API_BASE")"
else
  WEB_URL="$(normalize_url "$WEB_URL")"
fi
WEB_URL="$(normalize_web_url_to_attendance "$WEB_URL")"

timestamp="$(date -u +%Y%m%d-%H%M%S)"
if [[ -z "$OUTPUT_ROOT" ]]; then
  OUTPUT_ROOT="${ROOT_DIR}/output/playwright/attendance-prod-acceptance/${timestamp}"
else
  OUTPUT_ROOT="${OUTPUT_ROOT%/}"
fi

mkdir -p "$OUTPUT_ROOT"

gate_preflight="SKIP"
gate_api="FAIL"
gate_provision="SKIP"
gate_pw_prod="FAIL"
gate_pw_desktop="FAIL"
gate_pw_mobile="FAIL"

info "API_BASE=${API_BASE}"
info "WEB_URL=${WEB_URL}"
info "OUTPUT_ROOT=${OUTPUT_ROOT}"

function maybe_run_preflight() {
  # Keep "auto" mode ergonomic on dev machines (skip when env file is absent),
  # but respect a user-specified ENV_FILE override when present.
  local env_file="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
  if [[ "$RUN_PREFLIGHT" == "false" ]]; then
    gate_preflight="SKIP"
    return 0
  fi
  if [[ "$RUN_PREFLIGHT" == "auto" && ! -f "$env_file" ]]; then
    gate_preflight="SKIP"
    return 0
  fi

  info "Running preflight..."
  if "${ROOT_DIR}/scripts/ops/attendance-preflight.sh" >"${OUTPUT_ROOT}/gate-preflight.log" 2>&1; then
    gate_preflight="PASS"
  else
    gate_preflight="FAIL"
    return 1
  fi
}

function run_api_smoke() {
  info "Running API smoke..."
  if API_BASE="$API_BASE" \
    AUTH_TOKEN="$AUTH_TOKEN" \
    EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
    REQUIRE_ATTENDANCE_ADMIN_API="$REQUIRE_ATTENDANCE_ADMIN_API" \
    REQUIRE_IDEMPOTENCY="$REQUIRE_IDEMPOTENCY" \
    REQUIRE_IMPORT_EXPORT="$REQUIRE_IMPORT_EXPORT" \
    REQUIRE_IMPORT_UPLOAD="$REQUIRE_IMPORT_UPLOAD" \
    REQUIRE_IMPORT_ASYNC="$REQUIRE_IMPORT_ASYNC" \
    REQUIRE_PREVIEW_ASYNC="$REQUIRE_PREVIEW_ASYNC" \
    REQUIRE_BATCH_RESOLVE="$REQUIRE_BATCH_RESOLVE" \
    "${ROOT_DIR}/scripts/ops/attendance-smoke-api.sh" \
    >"${OUTPUT_ROOT}/gate-api-smoke.log" 2>&1; then
    gate_api="PASS"
    return 0
  fi
  gate_api="FAIL"
  return 1
}

function maybe_run_provision() {
  if [[ -z "$PROVISION_USER_ID" ]]; then
    gate_provision="SKIP"
    return 0
  fi

  info "Running permission provisioning gate (PROVISION_USER_ID set)..."
  if API_BASE="$API_BASE" AUTH_TOKEN="$AUTH_TOKEN" USER_ID="$PROVISION_USER_ID" ROLE="employee" "${ROOT_DIR}/scripts/ops/attendance-provision-user.sh" \
    >"${OUTPUT_ROOT}/gate-provision-employee.log" 2>&1 \
    && API_BASE="$API_BASE" AUTH_TOKEN="$AUTH_TOKEN" USER_ID="$PROVISION_USER_ID" ROLE="approver" "${ROOT_DIR}/scripts/ops/attendance-provision-user.sh" \
      >"${OUTPUT_ROOT}/gate-provision-approver.log" 2>&1 \
    && API_BASE="$API_BASE" AUTH_TOKEN="$AUTH_TOKEN" USER_ID="$PROVISION_USER_ID" ROLE="admin" "${ROOT_DIR}/scripts/ops/attendance-provision-user.sh" \
      >"${OUTPUT_ROOT}/gate-provision-admin.log" 2>&1; then
    gate_provision="PASS"
    return 0
  fi
  gate_provision="FAIL"
  return 1
}

function run_playwright_production_flow() {
  info "Running Playwright production flow (desktop)..."
  if AUTH_TOKEN="$AUTH_TOKEN" \
    WEB_URL="$WEB_URL" \
    API_BASE="$API_BASE" \
    OUTPUT_DIR="${OUTPUT_ROOT}/playwright-production-flow" \
    HEADLESS="$HEADLESS" \
    node "${ROOT_DIR}/scripts/verify-attendance-production-flow.mjs" \
    >"${OUTPUT_ROOT}/gate-playwright-production-flow.log" 2>&1; then
    gate_pw_prod="PASS"
    return 0
  fi
  gate_pw_prod="FAIL"
  return 1
}

function run_playwright_full_flow_desktop() {
  info "Running Playwright full flow (focused desktop)..."
  if AUTH_TOKEN="$AUTH_TOKEN" \
    WEB_URL="$WEB_URL" \
    API_BASE="$API_BASE" \
    EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
    OUTPUT_DIR="${OUTPUT_ROOT}/playwright-full-flow-desktop" \
    HEADLESS="$HEADLESS" \
    node "${ROOT_DIR}/scripts/verify-attendance-full-flow.mjs" \
    >"${OUTPUT_ROOT}/gate-playwright-full-flow-desktop.log" 2>&1; then
    gate_pw_desktop="PASS"
    return 0
  fi
  gate_pw_desktop="FAIL"
  return 1
}

function run_playwright_full_flow_mobile() {
  info "Running Playwright full flow (focused mobile)..."
  if AUTH_TOKEN="$AUTH_TOKEN" \
    WEB_URL="$WEB_URL" \
    API_BASE="$API_BASE" \
    EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
    OUTPUT_DIR="${OUTPUT_ROOT}/playwright-full-flow-mobile" \
    HEADLESS="$HEADLESS" \
    UI_MOBILE="true" \
    node "${ROOT_DIR}/scripts/verify-attendance-full-flow.mjs" \
    >"${OUTPUT_ROOT}/gate-playwright-full-flow-mobile.log" 2>&1; then
    gate_pw_mobile="PASS"
    return 0
  fi
  gate_pw_mobile="FAIL"
  return 1
}

exit_code=0

if ! maybe_run_preflight; then
  exit_code=1
fi

if ! run_api_smoke; then
  exit_code=1
fi

if ! maybe_run_provision; then
  exit_code=1
fi

if ! run_playwright_production_flow; then
  exit_code=1
fi

if ! run_playwright_full_flow_desktop; then
  exit_code=1
fi

if ! run_playwright_full_flow_mobile; then
  exit_code=1
fi

function detect_provision_reason() {
  local log="$1"
  if [[ ! -f "$log" ]]; then
    echo "LOG_MISSING"
    return 0
  fi
  if grep -qE 'error: (401|403)' "$log"; then
    echo "AUTH_FAILED"
    return 0
  fi
  if grep -qE 'error: 429' "$log"; then
    echo "RATE_LIMITED"
    return 0
  fi
  if grep -qE 'error: 404' "$log"; then
    echo "ENDPOINT_MISSING"
    return 0
  fi
  if grep -qiE 'Could not resolve host' "$log"; then
    echo "DNS_FAILED"
    return 0
  fi
  if grep -qiE 'Connection refused' "$log"; then
    echo "CONNECTION_REFUSED"
    return 0
  fi
  if grep -qiE 'Operation timed out|timed out' "$log"; then
    echo "TIMEOUT"
    return 0
  fi
  if grep -qE 'curl: \\([0-9]+\\)' "$log"; then
    echo "CURL_FAILED"
    return 0
  fi
  echo "UNKNOWN"
}

function detect_playwright_reason() {
  local log="$1"
  if [[ ! -f "$log" ]]; then
    echo "LOG_MISSING"
    return 0
  fi
  if grep -qE 'HTTP 429 |RATE_LIMITED' "$log"; then
    echo "RATE_LIMITED"
    return 0
  fi
  if grep -qiE 'timeout|timed out' "$log"; then
    echo "TIMEOUT"
    return 0
  fi
  if grep -qE 'COMMIT_TOKEN_(INVALID|REQUIRED)' "$log"; then
    echo "COMMIT_TOKEN_REJECTED"
    return 0
  fi
  if grep -qE 'Legacy /api/attendance/import was used' "$log"; then
    echo "LEGACY_IMPORT_USED"
    return 0
  fi
  if grep -qE 'PUNCH_TOO_SOON' "$log"; then
    echo "PUNCH_TOO_SOON"
    return 0
  fi
  echo "UNKNOWN"
}

function json_string_or_null() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    echo "null"
    return 0
  fi
  # Reason codes are uppercase+underscores; safe to embed without escaping.
  echo "\"$value\""
}

api_smoke_reason=""
provision_reason=""
pw_prod_reason=""
pw_desktop_reason=""
pw_mobile_reason=""

if [[ "$gate_api" == "FAIL" ]]; then
  api_smoke_reason="$("${ROOT_DIR}/scripts/ops/attendance-detect-api-smoke-reason.sh" "${OUTPUT_ROOT}/gate-api-smoke.log")"
fi
if [[ "$gate_provision" == "FAIL" ]]; then
  provision_reason="$(detect_provision_reason "${OUTPUT_ROOT}/gate-provision-employee.log")"
fi
if [[ "$gate_pw_prod" == "FAIL" ]]; then
  pw_prod_reason="$(detect_playwright_reason "${OUTPUT_ROOT}/gate-playwright-production-flow.log")"
fi
if [[ "$gate_pw_desktop" == "FAIL" ]]; then
  pw_desktop_reason="$(detect_playwright_reason "${OUTPUT_ROOT}/gate-playwright-full-flow-desktop.log")"
fi
if [[ "$gate_pw_mobile" == "FAIL" ]]; then
  pw_mobile_reason="$(detect_playwright_reason "${OUTPUT_ROOT}/gate-playwright-full-flow-mobile.log")"
fi

summary_json="${OUTPUT_ROOT}/gate-summary.json"
cat >"$summary_json" <<EOF
{
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "apiBase": "${API_BASE}",
  "webUrl": "${WEB_URL}",
  "expectProductMode": "${EXPECT_PRODUCT_MODE}",
  "exitCode": ${exit_code},
  "gates": {
    "preflight": "${gate_preflight}",
    "apiSmoke": "${gate_api}",
    "provisioning": "${gate_provision}",
    "playwrightProd": "${gate_pw_prod}",
    "playwrightDesktop": "${gate_pw_desktop}",
    "playwrightMobile": "${gate_pw_mobile}"
  },
  "gateReasons": {
    "apiSmoke": $(json_string_or_null "$api_smoke_reason"),
    "provisioning": $(json_string_or_null "$provision_reason"),
    "playwrightProd": $(json_string_or_null "$pw_prod_reason"),
    "playwrightDesktop": $(json_string_or_null "$pw_desktop_reason"),
    "playwrightMobile": $(json_string_or_null "$pw_mobile_reason")
  }
}
EOF

cat <<EOF

✅ Gate Summary
  - Gate 1: Preflight ............ ${gate_preflight}
  - Gate 2: API Smoke ............ ${gate_api}
  - Gate 3: Provisioning ......... ${gate_provision}
  - Gate 4: Playwright Prod ...... ${gate_pw_prod}
  - Gate 5: Playwright Desktop ... ${gate_pw_desktop}
  - Gate 6: Playwright Mobile .... ${gate_pw_mobile}

Artifacts:
  ${OUTPUT_ROOT}
EOF

exit "$exit_code"
