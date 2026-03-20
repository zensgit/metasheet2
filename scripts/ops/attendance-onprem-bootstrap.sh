#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-1}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
BUILD_WEB="${BUILD_WEB:-1}"
BUILD_BACKEND="${BUILD_BACKEND:-1}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
START_PM2="${START_PM2:-1}"
PM2_ENV="${PM2_ENV:-production}"
SERVICE_MANAGER="${SERVICE_MANAGER:-pm2}" # pm2|systemd|none
START_SERVICE="${START_SERVICE:-$START_PM2}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-metasheet-backend.service}"
PM2_APP_NAME="${PM2_APP_NAME:-metasheet-backend}"

function info() {
  echo "[attendance-onprem-bootstrap] $*" >&2
}

function run() {
  info "+ $*"
  "$@"
}

function verify_prebuilt_dist() {
  local web_index="${ROOT_DIR}/apps/web/dist/index.html"
  local backend_migrate="${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js"

  if [[ "$BUILD_WEB" != "1" && ! -f "$web_index" ]]; then
    cat >&2 <<EOF
[attendance-onprem-bootstrap] ERROR: Prebuilt web dist disappeared: ${web_index}
Likely cause: a workspace dependency mutation (for example \`pnpm add -w ...\`) rebuilt the workspace and removed prebuilt artifacts.
Fix: restore the packaged dist or rerun with BUILD_WEB=1.
EOF
    exit 1
  fi

  if [[ "$BUILD_BACKEND" != "1" && ! -f "$backend_migrate" ]]; then
    cat >&2 <<EOF
[attendance-onprem-bootstrap] ERROR: Prebuilt backend dist disappeared: ${backend_migrate}
Likely cause: a workspace dependency mutation rebuilt the workspace and removed prebuilt artifacts.
Fix: restore the packaged dist or rerun with BUILD_BACKEND=1.
EOF
    exit 1
  fi
}

function load_env_file() {
  set +u
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  set -u
}

[[ -f "$ENV_FILE" ]] || { echo "[attendance-onprem-bootstrap] ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

run env ENV_FILE="$ENV_FILE" REQUIRE_ATTENDANCE_ONLY="$REQUIRE_ATTENDANCE_ONLY" "${ROOT_DIR}/scripts/ops/attendance-onprem-env-check.sh"

if [[ "$INSTALL_DEPS" == "1" ]]; then
  run pnpm install --frozen-lockfile
  verify_prebuilt_dist
fi

if [[ "$BUILD_WEB" == "1" ]]; then
  run pnpm --filter @metasheet/web build
fi

if [[ "$BUILD_BACKEND" == "1" ]]; then
  run pnpm --filter @metasheet/core-backend build
fi

verify_prebuilt_dist

load_env_file

if [[ "$RUN_MIGRATIONS" == "1" ]]; then
  run node "${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js"
fi

if [[ "$START_SERVICE" == "1" ]]; then
  if [[ "$SERVICE_MANAGER" == "pm2" ]]; then
    run mkdir -p "${ROOT_DIR}/output/logs"
    # Start or reload backend process with latest env.
    if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
      run pm2 restart "$PM2_APP_NAME" --update-env
    else
      run pm2 start "${ROOT_DIR}/ecosystem.config.cjs" --only "$PM2_APP_NAME" --env "${PM2_ENV}" --update-env
    fi
    run pm2 save
  elif [[ "$SERVICE_MANAGER" == "systemd" ]]; then
    run systemctl daemon-reload
    if systemctl is-active --quiet "$SYSTEMD_SERVICE_NAME"; then
      run systemctl restart "$SYSTEMD_SERVICE_NAME"
    else
      run systemctl start "$SYSTEMD_SERVICE_NAME"
    fi
  elif [[ "$SERVICE_MANAGER" == "none" ]]; then
    info "START_SERVICE=1 but SERVICE_MANAGER=none; skipping service start"
  else
    echo "[attendance-onprem-bootstrap] ERROR: SERVICE_MANAGER must be pm2|systemd|none (got: ${SERVICE_MANAGER})" >&2
    exit 1
  fi
fi

info "Bootstrap complete"
