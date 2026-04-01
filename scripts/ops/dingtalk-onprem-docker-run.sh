#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
NETWORK="${NETWORK:-metasheet2_default}"

BACKEND_CONTAINER_NAME="${BACKEND_CONTAINER_NAME:-metasheet-backend}"
BACKEND_ALIAS="${BACKEND_ALIAS:-backend}"
BACKEND_IMAGE="${BACKEND_IMAGE:-}"
BACKEND_PORT_BIND="${BACKEND_PORT_BIND:-127.0.0.1:8900:8900}"
BACKEND_VOLUME="${BACKEND_VOLUME:-metasheet-attendance-import-data:/app/uploads/attendance-import}"

WEB_CONTAINER_NAME="${WEB_CONTAINER_NAME:-metasheet-web}"
WEB_IMAGE="${WEB_IMAGE:-}"
WEB_PORT_BIND="${WEB_PORT_BIND:-8081:80}"

DRY_RUN=0

function die() {
  echo "[dingtalk-onprem-docker-run] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[dingtalk-onprem-docker-run] $*" >&2
}

function run() {
  info "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

function print_help() {
  cat <<EOF
Usage:
  bash scripts/ops/dingtalk-onprem-docker-run.sh [--dry-run] backend
  bash scripts/ops/dingtalk-onprem-docker-run.sh [--dry-run] web
  bash scripts/ops/dingtalk-onprem-docker-run.sh [--dry-run] all

Environment:
  ENV_FILE            Backend env file. Default: ${ENV_FILE}
  NETWORK             Docker network. Default: ${NETWORK}
  BACKEND_IMAGE       Required for backend/all.
  WEB_IMAGE           Required for web/all.
  BACKEND_PORT_BIND   Default: ${BACKEND_PORT_BIND}
  WEB_PORT_BIND       Default: ${WEB_PORT_BIND}
  BACKEND_ALIAS       Default: ${BACKEND_ALIAS}
  BACKEND_VOLUME      Default: ${BACKEND_VOLUME}

Guarantees:
  - backend is re-created with --network-alias ${BACKEND_ALIAS}
  - web is re-created with public bind ${WEB_PORT_BIND}
  - both services use --restart unless-stopped
EOF
}

function require_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "Missing required command: ${name}"
}

function require_file() {
  local file="$1"
  [[ -f "$file" ]] || die "Required file not found: ${file}"
}

function ensure_backend_inputs() {
  [[ -n "$BACKEND_IMAGE" ]] || die "BACKEND_IMAGE is required for backend/all"
  require_file "$ENV_FILE"
}

function ensure_web_inputs() {
  [[ -n "$WEB_IMAGE" ]] || die "WEB_IMAGE is required for web/all"
}

function restart_backend() {
  ensure_backend_inputs
  run docker rm -f "$BACKEND_CONTAINER_NAME"
  run docker run -d \
    --name "$BACKEND_CONTAINER_NAME" \
    --restart unless-stopped \
    --network "$NETWORK" \
    --network-alias "$BACKEND_ALIAS" \
    --env-file "$ENV_FILE" \
    -v "$BACKEND_VOLUME" \
    -p "$BACKEND_PORT_BIND" \
    "$BACKEND_IMAGE"
}

function restart_web() {
  ensure_web_inputs
  run docker rm -f "$WEB_CONTAINER_NAME"
  run docker run -d \
    --name "$WEB_CONTAINER_NAME" \
    --restart unless-stopped \
    --network "$NETWORK" \
    -p "$WEB_PORT_BIND" \
    "$WEB_IMAGE"
}

function print_summary() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return
  fi
  info "Backend summary:"
  docker inspect "$BACKEND_CONTAINER_NAME" --format '{{.Name}} {{.Config.Image}} {{json .NetworkSettings.Networks}}' 2>/dev/null || true
  info "Web summary:"
  docker inspect "$WEB_CONTAINER_NAME" --format '{{.Name}} {{.Config.Image}} {{json .HostConfig.PortBindings}}' 2>/dev/null || true
}

require_cmd docker

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    backend|web|all)
      TARGET="$1"
      shift
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$TARGET" ]] || die "Target is required: backend | web | all"

case "$TARGET" in
  backend)
    restart_backend
    ;;
  web)
    restart_web
    ;;
  all)
    restart_backend
    restart_web
    ;;
esac

print_summary
