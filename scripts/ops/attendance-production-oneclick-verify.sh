#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/attendance-production-oneclick-verify/$(date +%Y%m%d-%H%M%S)}"
RESULTS_TSV="${OUTPUT_ROOT}/results.tsv"
SUMMARY_MD="${OUTPUT_ROOT}/summary.md"

WEB_URL="${WEB_URL:-http://142.171.239.56:8081}"
API_BASE="${API_BASE:-http://142.171.239.56:8081/api}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-attendance}"
PROVISION_USER_ID="${PROVISION_USER_ID:-}"

RUN_PREFLIGHT="${RUN_PREFLIGHT:-true}"
RUN_STRICT_GATES="${RUN_STRICT_GATES:-true}"
RUN_UI_DESKTOP="${RUN_UI_DESKTOP:-true}"
RUN_UI_MOBILE="${RUN_UI_MOBILE:-true}"
RUN_LOCALE_ZH="${RUN_LOCALE_ZH:-true}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.app.yml}"
ENV_FILE="${ENV_FILE:-docker/app.env}"
NGINX_CONF="${NGINX_CONF:-docker/nginx.conf}"

REQUIRE_ATTENDANCE_ADMIN_API="${REQUIRE_ATTENDANCE_ADMIN_API:-true}"
REQUIRE_IDEMPOTENCY="${REQUIRE_IDEMPOTENCY:-true}"
REQUIRE_IMPORT_EXPORT="${REQUIRE_IMPORT_EXPORT:-true}"
REQUIRE_IMPORT_UPLOAD="${REQUIRE_IMPORT_UPLOAD:-true}"
REQUIRE_IMPORT_ASYNC="${REQUIRE_IMPORT_ASYNC:-true}"
REQUIRE_IMPORT_TELEMETRY="${REQUIRE_IMPORT_TELEMETRY:-true}"
REQUIRE_PREVIEW_ASYNC="${REQUIRE_PREVIEW_ASYNC:-true}"
REQUIRE_ADMIN_SETTINGS_SAVE="${REQUIRE_ADMIN_SETTINGS_SAVE:-true}"
REQUIRE_IMPORT_JOB_RECOVERY="${REQUIRE_IMPORT_JOB_RECOVERY:-false}"
REQUIRE_LOCALE_ZH="${REQUIRE_LOCALE_ZH:-true}"
STRICT_RETRY_ON_RATE_LIMITED="${STRICT_RETRY_ON_RATE_LIMITED:-true}"
REQUIRE_TOGGLE_CHECKS="${REQUIRE_TOGGLE_CHECKS:-false}"
VERIFY_HOLIDAY="${VERIFY_HOLIDAY:-true}"

if [[ -z "$AUTH_TOKEN" ]]; then
  echo "[attendance-production-oneclick-verify] ERROR: AUTH_TOKEN is required" >&2
  echo "Set AUTH_TOKEN=<ADMIN_JWT> and rerun." >&2
  exit 1
fi

mkdir -p "$OUTPUT_ROOT"
echo -e "step\tstatus\tlog" >"$RESULTS_TSV"

failures=0

info() {
  echo "[attendance-production-oneclick-verify] $*" >&2
}

run_step() {
  local step="$1"
  shift
  local log_path="${OUTPUT_ROOT}/${step}.log"
  info "running ${step}"
  set +e
  "$@" >"$log_path" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo -e "${step}\tPASS\t${log_path}" >>"$RESULTS_TSV"
    info "${step}: PASS"
  else
    echo -e "${step}\tFAIL\t${log_path}" >>"$RESULTS_TSV"
    info "${step}: FAIL (rc=${rc})"
    failures=$((failures + 1))
  fi
}

if [[ "$RUN_PREFLIGHT" == "true" ]]; then
  run_step "preflight" env \
    COMPOSE_FILE="$COMPOSE_FILE" \
    ENV_FILE="$ENV_FILE" \
    NGINX_CONF="$NGINX_CONF" \
    scripts/ops/attendance-preflight.sh
fi

if [[ "$RUN_STRICT_GATES" == "true" ]]; then
  run_step "strict-gates-twice" env \
    API_BASE="$API_BASE" \
    AUTH_TOKEN="$AUTH_TOKEN" \
    EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
    PROVISION_USER_ID="$PROVISION_USER_ID" \
    REQUIRE_ATTENDANCE_ADMIN_API="$REQUIRE_ATTENDANCE_ADMIN_API" \
    REQUIRE_IDEMPOTENCY="$REQUIRE_IDEMPOTENCY" \
    REQUIRE_IMPORT_EXPORT="$REQUIRE_IMPORT_EXPORT" \
    REQUIRE_IMPORT_UPLOAD="$REQUIRE_IMPORT_UPLOAD" \
    REQUIRE_IMPORT_ASYNC="$REQUIRE_IMPORT_ASYNC" \
    REQUIRE_IMPORT_TELEMETRY="$REQUIRE_IMPORT_TELEMETRY" \
    REQUIRE_PREVIEW_ASYNC="$REQUIRE_PREVIEW_ASYNC" \
    REQUIRE_ADMIN_SETTINGS_SAVE="$REQUIRE_ADMIN_SETTINGS_SAVE" \
    REQUIRE_IMPORT_JOB_RECOVERY="$REQUIRE_IMPORT_JOB_RECOVERY" \
    REQUIRE_LOCALE_ZH="$REQUIRE_LOCALE_ZH" \
    STRICT_RETRY_ON_RATE_LIMITED="$STRICT_RETRY_ON_RATE_LIMITED" \
    RUN_PREFLIGHT="false" \
    OUTPUT_ROOT="${OUTPUT_ROOT}/strict-gates" \
    scripts/ops/attendance-run-strict-gates-twice.sh
fi

if [[ "$RUN_UI_DESKTOP" == "true" ]]; then
  run_step "playwright-desktop" env \
    WEB_URL="$WEB_URL" \
    API_BASE="$API_BASE" \
    AUTH_TOKEN="$AUTH_TOKEN" \
    OUTPUT_DIR="${OUTPUT_ROOT}/playwright-desktop" \
    node scripts/verify-attendance-full-flow.mjs
fi

if [[ "$RUN_UI_MOBILE" == "true" ]]; then
  run_step "playwright-mobile" env \
    WEB_URL="$WEB_URL" \
    API_BASE="$API_BASE" \
    AUTH_TOKEN="$AUTH_TOKEN" \
    UI_MOBILE="true" \
    OUTPUT_DIR="${OUTPUT_ROOT}/playwright-mobile" \
    node scripts/verify-attendance-full-flow.mjs
fi

if [[ "$RUN_LOCALE_ZH" == "true" ]]; then
  run_step "locale-zh-smoke" env \
    WEB_URL="$WEB_URL" \
    API_BASE="$API_BASE" \
    AUTH_TOKEN="$AUTH_TOKEN" \
    REQUIRE_ZH_CORE_LABELS="true" \
    REQUIRE_TOGGLE_CHECKS="$REQUIRE_TOGGLE_CHECKS" \
    VERIFY_HOLIDAY="$VERIFY_HOLIDAY" \
    OUTPUT_DIR="${OUTPUT_ROOT}/locale-zh" \
    node scripts/verify-attendance-locale-zh-smoke.mjs
fi

{
  echo "# Attendance One-Click Verify Summary"
  echo ""
  echo "- Generated: \`$(date -u +%Y-%m-%dT%H:%M:%SZ)\`"
  echo "- Web: \`${WEB_URL}\`"
  echo "- API: \`${API_BASE}\`"
  echo "- Output root: \`${OUTPUT_ROOT}\`"
  echo "- Failures: \`${failures}\`"
  echo ""
  echo "| Step | Status | Log |"
  echo "|---|---|---|"
  tail -n +2 "$RESULTS_TSV" | while IFS=$'\t' read -r step status log_path; do
    echo "| ${step} | ${status} | \`${log_path}\` |"
  done
} >"$SUMMARY_MD"

info "summary: ${SUMMARY_MD}"
info "results: ${RESULTS_TSV}"

if (( failures > 0 )); then
  info "verification failed (${failures} step(s) failed)"
  exit 1
fi

info "all enabled checks passed"
