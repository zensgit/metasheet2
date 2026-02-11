#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

API_BASE="${API_BASE:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-attendance}"
RUN_PREFLIGHT="${RUN_PREFLIGHT:-auto}" # auto|true|false
PROVISION_USER_ID="${PROVISION_USER_ID:-}" # optional

# Strictness defaults (can be overridden by env).
REQUIRE_ATTENDANCE_ADMIN_API="${REQUIRE_ATTENDANCE_ADMIN_API:-true}"
REQUIRE_IDEMPOTENCY="${REQUIRE_IDEMPOTENCY:-true}"
REQUIRE_IMPORT_EXPORT="${REQUIRE_IMPORT_EXPORT:-true}"
REQUIRE_IMPORT_ASYNC="${REQUIRE_IMPORT_ASYNC:-true}"

SLEEP_SECONDS="${SLEEP_SECONDS:-90}"

function die() {
  echo "[attendance-run-strict-gates-twice] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-run-strict-gates-twice] $*" >&2
}

[[ -n "$API_BASE" ]] || die "API_BASE is required (example: http://142.171.239.56:8081/api)"
[[ -n "$AUTH_TOKEN" ]] || die "AUTH_TOKEN is required"

timestamp="$(date -u +%Y%m%d-%H%M%S)"
root="${ROOT_DIR}/output/playwright/attendance-prod-acceptance"
out1="${root}/${timestamp}-1"
out2="${root}/${timestamp}-2"

info "Strict gates: admin_api=${REQUIRE_ATTENDANCE_ADMIN_API} idempotency=${REQUIRE_IDEMPOTENCY} import_export=${REQUIRE_IMPORT_EXPORT} import_async=${REQUIRE_IMPORT_ASYNC}"
info "Run #1 output: ${out1}"
REQUIRE_ATTENDANCE_ADMIN_API="$REQUIRE_ATTENDANCE_ADMIN_API" \
REQUIRE_IDEMPOTENCY="$REQUIRE_IDEMPOTENCY" \
REQUIRE_IMPORT_EXPORT="$REQUIRE_IMPORT_EXPORT" \
REQUIRE_IMPORT_ASYNC="$REQUIRE_IMPORT_ASYNC" \
RUN_PREFLIGHT="$RUN_PREFLIGHT" \
API_BASE="$API_BASE" \
AUTH_TOKEN="$AUTH_TOKEN" \
EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
PROVISION_USER_ID="$PROVISION_USER_ID" \
OUTPUT_ROOT="$out1" \
"${ROOT_DIR}/scripts/ops/attendance-run-gates.sh"

info "Waiting ${SLEEP_SECONDS}s before run #2 (reduce punch interval flakiness)..."
sleep "$SLEEP_SECONDS"

info "Run #2 output: ${out2}"
REQUIRE_ATTENDANCE_ADMIN_API="$REQUIRE_ATTENDANCE_ADMIN_API" \
REQUIRE_IDEMPOTENCY="$REQUIRE_IDEMPOTENCY" \
REQUIRE_IMPORT_EXPORT="$REQUIRE_IMPORT_EXPORT" \
REQUIRE_IMPORT_ASYNC="$REQUIRE_IMPORT_ASYNC" \
RUN_PREFLIGHT="$RUN_PREFLIGHT" \
API_BASE="$API_BASE" \
AUTH_TOKEN="$AUTH_TOKEN" \
EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
PROVISION_USER_ID="$PROVISION_USER_ID" \
OUTPUT_ROOT="$out2" \
"${ROOT_DIR}/scripts/ops/attendance-run-gates.sh"

cat <<EOF

✅ Strict gates passed twice

Evidence:
  - ${out1}
  - ${out2}
EOF
