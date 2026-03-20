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
  info "+ $*"
  "$@"
}

function require_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "Missing required command: ${name}"
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

run env \
  ENV_FILE="$ENV_FILE" \
  REQUIRE_ATTENDANCE_ONLY=0 \
  SERVICE_MANAGER="$SERVICE_MANAGER" \
  INSTALL_DEPS="$INSTALL_DEPS" \
  BUILD_WEB="$BUILD_WEB" \
  BUILD_BACKEND="$BUILD_BACKEND" \
  RUN_MIGRATIONS="$RUN_MIGRATIONS" \
  START_SERVICE="$START_SERVICE" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-bootstrap.sh"

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
      process.stdout.write(String(token));
    ' "$(cat "$tmp_login_file")"
  )"
fi
rm -f "$tmp_login_file"

if [[ -n "$auth_token" ]]; then
  run env \
    BASE_URL="$web_base" \
    API_BASE="$api_base" \
    CHECK_NGINX="$CHECK_NGINX" \
    SERVICE_MANAGER=auto \
    AUTH_TOKEN="$auth_token" \
    EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
    "${ROOT_DIR}/scripts/ops/multitable-onprem-healthcheck.sh"
else
  info "Auth token auto-fetch skipped; running healthcheck without /auth/me mode assertion"
  run env \
    BASE_URL="$web_base" \
    API_BASE="$api_base" \
    CHECK_NGINX="$CHECK_NGINX" \
    SERVICE_MANAGER=auto \
    "${ROOT_DIR}/scripts/ops/multitable-onprem-healthcheck.sh"
fi

info "Deployment finished."
info "Open: ${web_base}/"
info "Multitable: ${web_base}/multitable"
info "Admin: ${ADMIN_EMAIL}"
