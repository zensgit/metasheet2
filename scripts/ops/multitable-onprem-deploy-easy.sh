#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
SERVICE_MANAGER="${SERVICE_MANAGER:-pm2}"
CHECK_NGINX="${CHECK_NGINX:-1}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-platform}"
API_BASE="${API_BASE:-http://127.0.0.1/api}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_NAME="${ADMIN_NAME:-Administrator}"
VERIFY_LOGIN="${VERIFY_LOGIN:-1}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
BUILD_WEB="${BUILD_WEB:-1}"
BUILD_BACKEND="${BUILD_BACKEND:-1}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
START_SERVICE="${START_SERVICE:-1}"

function die() {
  echo "[multitable-onprem-deploy-easy] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[multitable-onprem-deploy-easy] $*" >&2
}

function run() {
  # Environment arguments include credentials; log only the executable.
  info "+ $1"
  "$@"
}

function verify_prebuilt_dist() {
  local web_index="${ROOT_DIR}/apps/web/dist/index.html"
  local backend_migrate="${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js"

  if [[ "$BUILD_WEB" != "1" && ! -f "$web_index" ]]; then
    die "Prebuilt web dist missing after dependency/bootstrap step: ${web_index}. Avoid \`pnpm add -w\` inside the packaged workspace; restore dist or rerun with BUILD_WEB=1."
  fi

  if [[ "$BUILD_BACKEND" != "1" && ! -f "$backend_migrate" ]]; then
    die "Prebuilt backend dist missing after dependency/bootstrap step: ${backend_migrate}. Avoid \`pnpm add -w\` inside the packaged workspace; restore dist or rerun with BUILD_BACKEND=1."
  fi
}

function require_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "Missing required command: ${name}"
}

function wait_for_api() {
  local attempt code
  for ((attempt = 0; attempt < 30; attempt++)); do
    if code="$(curl -sS --connect-timeout 1 --max-time 1 -o /dev/null -w '%{http_code}' "${api_base}/health")" && [[ "$code" == "200" ]]; then
      return
    fi
    sleep 1
  done
  die "API did not become ready after service startup; admin bootstrap was not attempted"
}

function to_web_base() {
  local input="${1%/}"
  if [[ "$input" == */api ]]; then
    echo "${input%/api}"
  else
    echo "$input"
  fi
}

[[ -f "$ENV_FILE" ]] || die "ENV_FILE not found: ${ENV_FILE}"
[[ -n "$ADMIN_EMAIL" ]] || die "ADMIN_EMAIL is required"
[[ -n "$ADMIN_PASSWORD" ]] || die "ADMIN_PASSWORD is required"

require_cmd curl
require_cmd env

api_base="${API_BASE%/}"
web_base="$(to_web_base "$api_base")"
auth_token=""

effective_service_receipt="$(mktemp)" || die "Could not create effective service receipt"
readonly effective_service_receipt
trap 'status=$?; if ! rm -f "$effective_service_receipt"; then
  info "ERROR: Could not remove effective service receipt"
  if [[ "$status" -eq 0 ]]; then status=1; fi
fi; exit "$status"' EXIT

run env \
  ENV_FILE="$ENV_FILE" \
  MS_EFFECTIVE_SERVICE_RECEIPT="$effective_service_receipt" \
  REQUIRE_ATTENDANCE_ONLY=0 \
  SERVICE_MANAGER="$SERVICE_MANAGER" \
  INSTALL_DEPS="$INSTALL_DEPS" \
  BUILD_WEB="$BUILD_WEB" \
  BUILD_BACKEND="$BUILD_BACKEND" \
  RUN_MIGRATIONS="$RUN_MIGRATIONS" \
  START_SERVICE="$START_SERVICE" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-bootstrap.sh"

if {
  IFS= read -r -d '' effective_service_manager &&
  IFS= read -r -d '' effective_pm2_app_name &&
  IFS= read -r -d '' effective_systemd_service_name &&
  { ! IFS= read -r -d '' effective_service_extra && [[ -z "$effective_service_extra" ]]; }
} < "$effective_service_receipt"; then
  :
else
  die "Effective service receipt must contain exactly three NUL-terminated fields"
fi

verify_prebuilt_dist
wait_for_api

run env \
  ENV_FILE="$ENV_FILE" \
  API_BASE="$api_base" \
  VERIFY_LOGIN="$VERIFY_LOGIN" \
  ADMIN_EMAIL="$ADMIN_EMAIL" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  ADMIN_NAME="$ADMIN_NAME" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-bootstrap-admin.sh"

tmp_login_file="$(mktemp)"
set +e
login_code="$(
  curl -sS -o "$tmp_login_file" -w '%{http_code}' \
    -X POST "${api_base}/auth/login" \
    -H 'Content-Type: application/json' \
    --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}"
)"
curl_rc="$?"
set -e

if [[ "$curl_rc" -eq 0 && "$login_code" == "200" ]] && command -v node >/dev/null 2>&1; then
  auth_token="$(
    node -e '
      const raw = process.argv[1] || "{}";
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      const token = parsed?.data?.token || parsed?.token || "";
      process.stdout.write(typeof token === "string" && token.trim() ? token : "");
    ' "$(cat "$tmp_login_file")"
  )"
fi
rm -f "$tmp_login_file"

if [[ "$VERIFY_LOGIN" == "1" && -z "$auth_token" ]]; then
  die "Fresh admin login token required before healthcheck"
fi

if [[ -n "$auth_token" ]]; then
  run env \
    BASE_URL="$web_base" \
    API_BASE="$api_base" \
    CHECK_NGINX="$CHECK_NGINX" \
    SERVICE_MANAGER="$effective_service_manager" \
    PM2_APP_NAME="$effective_pm2_app_name" \
    SYSTEMD_SERVICE_NAME="$effective_systemd_service_name" \
    MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY=1 \
    AUTH_TOKEN="$auth_token" \
    EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
    "${ROOT_DIR}/scripts/ops/multitable-onprem-healthcheck.sh"
else
  info "Auth token auto-fetch skipped; running healthcheck without /auth/me mode assertion"
  run env \
    BASE_URL="$web_base" \
    API_BASE="$api_base" \
    CHECK_NGINX="$CHECK_NGINX" \
    SERVICE_MANAGER="$effective_service_manager" \
    PM2_APP_NAME="$effective_pm2_app_name" \
    SYSTEMD_SERVICE_NAME="$effective_systemd_service_name" \
    MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY=1 \
    "${ROOT_DIR}/scripts/ops/multitable-onprem-healthcheck.sh"
fi

info "Deployment finished."
info "Open: ${web_base}/"
info "Multitable: ${web_base}/multitable"
info "Admin: ${ADMIN_EMAIL}"
