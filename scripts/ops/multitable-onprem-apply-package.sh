#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_ARCHIVE="${1:-${PACKAGE_ARCHIVE:-}}"
DEPLOY_ROOT="${DEPLOY_ROOT:-${ROOT_DIR}}"
ENV_FILE="${ENV_FILE:-${DEPLOY_ROOT}/docker/app.env}"
API_BASE="${API_BASE:-http://127.0.0.1/api}"
BASE_URL="${BASE_URL:-http://127.0.0.1}"
CHECK_NGINX="${CHECK_NGINX:-1}"
EXTRACT_PARENT="${EXTRACT_PARENT:-${DEPLOY_ROOT}/output/deploy}"
SERVICE_MANAGER="${SERVICE_MANAGER:-pm2}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"
BUILD_WEB="${BUILD_WEB:-0}"
BUILD_BACKEND="${BUILD_BACKEND:-0}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
RESTART_SERVICE="${RESTART_SERVICE:-1}"
RELOAD_NGINX="${RELOAD_NGINX:-1}"
RUN_HEALTHCHECK="${RUN_HEALTHCHECK:-1}"

extract_root=""

function die() {
  echo "[multitable-onprem-apply-package] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[multitable-onprem-apply-package] $*" >&2
}

function run() {
  info "+ $*"
  "$@"
}

function abs_path() {
  local input="$1"
  if [[ -d "$input" ]]; then
    (cd "$input" && pwd)
  else
    local dir
    local base
    dir="$(dirname "$input")"
    base="$(basename "$input")"
    (cd "$dir" && printf '%s/%s\n' "$(pwd)" "$base")
  fi
}

function require_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "Missing required command: ${name}"
}

function extract_package() {
  local archive="$1"
  local target="$2"

  case "$archive" in
    *.tgz|*.tar.gz)
      require_cmd tar
      run tar -xzf "$archive" -C "$target"
      ;;
    *.zip)
      require_cmd unzip
      run unzip -q "$archive" -d "$target"
      ;;
    *)
      die "Unsupported package extension (expected .zip, .tgz, or .tar.gz): ${archive}"
      ;;
  esac
}

function find_package_root() {
  local target="$1"
  local first_dir
  first_dir="$(find "$target" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [[ -n "$first_dir" ]] || die "Failed to locate extracted package root in ${target}"
  printf '%s\n' "$first_dir"
}

function cleanup() {
  [[ -n "$extract_root" ]] && rm -rf "$extract_root" || true
}
trap cleanup EXIT

[[ -n "$PACKAGE_ARCHIVE" ]] || die "Usage: scripts/ops/multitable-onprem-apply-package.sh <package.zip|package.tgz>"
[[ -f "$PACKAGE_ARCHIVE" ]] || die "Package archive not found: ${PACKAGE_ARCHIVE}"

PACKAGE_ARCHIVE="$(abs_path "$PACKAGE_ARCHIVE")"
DEPLOY_ROOT="$(abs_path "$DEPLOY_ROOT")"
mkdir -p "$DEPLOY_ROOT"
mkdir -p "$EXTRACT_PARENT"

extract_root="$(mktemp -d "${EXTRACT_PARENT%/}/package-apply-XXXXXX")"

info "Package archive: ${PACKAGE_ARCHIVE}"
info "Deploy root: ${DEPLOY_ROOT}"
info "Extract root: ${extract_root}"

extract_package "$PACKAGE_ARCHIVE" "$extract_root"
package_root="$(find_package_root "$extract_root")"

[[ -f "${package_root}/scripts/ops/multitable-onprem-package-upgrade.sh" ]] || die "Extracted package is missing multitable upgrade helper"

run mkdir -p "${DEPLOY_ROOT}/output/logs"
run cp -R "${package_root}/." "${DEPLOY_ROOT}"
run chmod +x "${DEPLOY_ROOT}/scripts/ops/"*.sh

[[ -f "$ENV_FILE" ]] || die "ENV_FILE not found after package copy: ${ENV_FILE}"

run env \
  ENV_FILE="$ENV_FILE" \
  API_BASE="$API_BASE" \
  BASE_URL="$BASE_URL" \
  CHECK_NGINX="$CHECK_NGINX" \
  SERVICE_MANAGER="$SERVICE_MANAGER" \
  INSTALL_DEPS="$INSTALL_DEPS" \
  BUILD_WEB="$BUILD_WEB" \
  BUILD_BACKEND="$BUILD_BACKEND" \
  RUN_MIGRATIONS="$RUN_MIGRATIONS" \
  RESTART_SERVICE="$RESTART_SERVICE" \
  RELOAD_NGINX="$RELOAD_NGINX" \
  RUN_HEALTHCHECK="$RUN_HEALTHCHECK" \
  "${DEPLOY_ROOT}/scripts/ops/multitable-onprem-package-upgrade.sh"

info "Package deploy complete"
info "Archive applied: ${PACKAGE_ARCHIVE}"
info "Root: ${DEPLOY_ROOT}"
