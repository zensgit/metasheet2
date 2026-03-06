#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-1}"
GIT_BRANCH="${GIT_BRANCH:-main}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
BUILD_WEB="${BUILD_WEB:-1}"
BUILD_BACKEND="${BUILD_BACKEND:-1}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
RESTART_PM2="${RESTART_PM2:-1}"
RELOAD_NGINX="${RELOAD_NGINX:-1}"
SERVICE_MANAGER="${SERVICE_MANAGER:-pm2}" # pm2|systemd|none
RESTART_SERVICE="${RESTART_SERVICE:-$RESTART_PM2}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-metasheet-backend.service}"
PM2_APP_NAME="${PM2_APP_NAME:-metasheet-backend}"

function info() {
  echo "[attendance-onprem-update] $*" >&2
}

function run() {
  info "+ $*"
  "$@"
}

function load_env_file() {
  set +u
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  set -u
}

[[ -f "$ENV_FILE" ]] || { echo "[attendance-onprem-update] ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

run env ENV_FILE="$ENV_FILE" REQUIRE_ATTENDANCE_ONLY="$REQUIRE_ATTENDANCE_ONLY" "${ROOT_DIR}/scripts/ops/attendance-onprem-env-check.sh"

if [[ "$SKIP_GIT_PULL" != "1" ]]; then
  run git fetch origin "$GIT_BRANCH"
  run git checkout "$GIT_BRANCH"
  run git pull --ff-only origin "$GIT_BRANCH"
fi

if [[ "$INSTALL_DEPS" == "1" ]]; then
  run pnpm install --frozen-lockfile
fi

if [[ "$BUILD_WEB" == "1" ]]; then
  run pnpm --filter @metasheet/web build
fi

if [[ "$BUILD_BACKEND" == "1" ]]; then
  run pnpm --filter @metasheet/core-backend build
fi

load_env_file

if [[ "$RUN_MIGRATIONS" == "1" ]]; then
  run node "${ROOT_DIR}/packages/core-backend/dist/src/db/migrate.js"
fi

if [[ "$RESTART_SERVICE" == "1" ]]; then
  if [[ "$SERVICE_MANAGER" == "pm2" ]]; then
    run mkdir -p "${ROOT_DIR}/output/logs"
    if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
      run pm2 restart "$PM2_APP_NAME" --update-env
    else
      run pm2 start "${ROOT_DIR}/ecosystem.config.cjs" --only "$PM2_APP_NAME" --env production --update-env
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
    info "RESTART_SERVICE=1 but SERVICE_MANAGER=none; skipping service restart"
  else
    echo "[attendance-onprem-update] ERROR: SERVICE_MANAGER must be pm2|systemd|none (got: ${SERVICE_MANAGER})" >&2
    exit 1
  fi
fi

if [[ "$RELOAD_NGINX" == "1" && "$(command -v systemctl || true)" != "" ]]; then
  if systemctl is-active --quiet nginx; then
    run systemctl reload nginx
  fi
fi

info "Update complete"
