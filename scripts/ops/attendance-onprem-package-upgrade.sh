#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-1}"
SERVICE_MANAGER="${SERVICE_MANAGER:-pm2}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
BUILD_WEB="${BUILD_WEB:-0}"
BUILD_BACKEND="${BUILD_BACKEND:-0}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
RESTART_SERVICE="${RESTART_SERVICE:-1}"
RELOAD_NGINX="${RELOAD_NGINX:-1}"
RUN_HEALTHCHECK="${RUN_HEALTHCHECK:-1}"
API_BASE="${API_BASE:-http://127.0.0.1/api}"
BASE_URL="${BASE_URL:-http://127.0.0.1}"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-http://127.0.0.1:8900/health}"
CHECK_NGINX="${CHECK_NGINX:-1}"

function die() {
  echo "[attendance-onprem-package-upgrade] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-package-upgrade] $*" >&2
}

[[ -f "$ENV_FILE" ]] || die "ENV_FILE not found: ${ENV_FILE}"

if [[ "$RUN_MIGRATIONS" == "1" && "$BUILD_BACKEND" != "1" ]]; then
  if [[ ! -f "${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js" ]]; then
    die "Missing packages/core-backend/dist/src/db/migrate.js. Set BUILD_BACKEND=1 or provide prebuilt dist."
  fi
fi

info "Applying package upgrade (no git pull)"
env \
  ENV_FILE="$ENV_FILE" \
  REQUIRE_ATTENDANCE_ONLY="$REQUIRE_ATTENDANCE_ONLY" \
  SKIP_GIT_PULL=1 \
  SERVICE_MANAGER="$SERVICE_MANAGER" \
  INSTALL_DEPS="$INSTALL_DEPS" \
  BUILD_WEB="$BUILD_WEB" \
  BUILD_BACKEND="$BUILD_BACKEND" \
  RUN_MIGRATIONS="$RUN_MIGRATIONS" \
  RESTART_SERVICE="$RESTART_SERVICE" \
  RELOAD_NGINX="$RELOAD_NGINX" \
  "${ROOT_DIR}/scripts/ops/attendance-onprem-update.sh"

if [[ "$RUN_HEALTHCHECK" == "1" ]]; then
  # A process manager can report online before the API binds its socket.
  # Keep the full healthcheck below; readiness only absorbs startup transients.
  if [[ "$RESTART_SERVICE" == "1" ]]; then
    info "Waiting for backend readiness"
    curl -fsS --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 60 \
      --max-time "${MAX_TIME:-10}" "$BACKEND_HEALTH_URL" >/dev/null \
      || die "Backend did not become ready after upgrade"
  fi
  info "Running healthcheck"
  env \
    BASE_URL="$BASE_URL" \
    BACKEND_HEALTH_URL="$BACKEND_HEALTH_URL" \
    API_BASE="$API_BASE" \
    CHECK_NGINX="$CHECK_NGINX" \
    SERVICE_MANAGER=auto \
    "${ROOT_DIR}/scripts/ops/attendance-onprem-healthcheck.sh"
fi

info "Package upgrade complete"
