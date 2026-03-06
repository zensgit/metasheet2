#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
API_BASE="${API_BASE:-http://127.0.0.1/api}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_NAME="${ADMIN_NAME:-Administrator}"
VERIFY_LOGIN="${VERIFY_LOGIN:-1}"
REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-1}"
SERVICE_MANAGER="${SERVICE_MANAGER:-pm2}"
CHECK_NGINX="${CHECK_NGINX:-1}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-attendance}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
BUILD_WEB="${BUILD_WEB:-0}"
BUILD_BACKEND="${BUILD_BACKEND:-0}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
START_SERVICE="${START_SERVICE:-1}"

function die() {
  echo "[attendance-onprem-package-install] ERROR: $*" >&2
  exit 1
}

[[ -f "$ENV_FILE" ]] || die "ENV_FILE not found: ${ENV_FILE}"
[[ -n "$ADMIN_EMAIL" ]] || die "ADMIN_EMAIL is required"
[[ -n "$ADMIN_PASSWORD" ]] || die "ADMIN_PASSWORD is required"

if [[ "$RUN_MIGRATIONS" == "1" && "$BUILD_BACKEND" != "1" ]]; then
  [[ -f "${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js" ]] || die "Missing backend dist migrate.js. Provide prebuilt dist or set BUILD_BACKEND=1."
fi

if [[ "$BUILD_WEB" != "1" ]]; then
  [[ -f "${ROOT_DIR}/apps/web/dist/index.html" ]] || die "Missing web dist index.html. Provide prebuilt dist or set BUILD_WEB=1."
fi

exec env \
  ENV_FILE="$ENV_FILE" \
  API_BASE="$API_BASE" \
  ADMIN_EMAIL="$ADMIN_EMAIL" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  ADMIN_NAME="$ADMIN_NAME" \
  VERIFY_LOGIN="$VERIFY_LOGIN" \
  REQUIRE_ATTENDANCE_ONLY="$REQUIRE_ATTENDANCE_ONLY" \
  SERVICE_MANAGER="$SERVICE_MANAGER" \
  CHECK_NGINX="$CHECK_NGINX" \
  EXPECT_PRODUCT_MODE="$EXPECT_PRODUCT_MODE" \
  INSTALL_DEPS="$INSTALL_DEPS" \
  BUILD_WEB="$BUILD_WEB" \
  BUILD_BACKEND="$BUILD_BACKEND" \
  RUN_MIGRATIONS="$RUN_MIGRATIONS" \
  START_SERVICE="$START_SERVICE" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-deploy-easy.sh"
