#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"

function info() {
  echo "[deploy-attendance-prod] $*" >&2
}

function run() {
  info "+ $*"
  "$@"
}

function resolve_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return 0
  fi
  return 1
}

COMPOSE_CMD="$(resolve_compose_cmd || true)"
[[ -n "$COMPOSE_CMD" ]] || { echo "[deploy-attendance-prod] ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2; exit 125; }
DEPLOY_IMAGE_OWNER="${DEPLOY_IMAGE_OWNER:-zensgit}"
DEPLOY_IMAGE_TAG="${DEPLOY_IMAGE_TAG:-latest}"

info "Starting production deploy (attendance)"
info "Compose: ${COMPOSE_FILE}"
info "Env:     ${ENV_FILE}"
info "Compose cmd: ${COMPOSE_CMD}"
info "Image owner: ${DEPLOY_IMAGE_OWNER}"
info "Image tag:   ${DEPLOY_IMAGE_TAG}"

for container_name in metasheet-backend metasheet-web; do
  if docker ps -a --format '{{.Names}}' | grep -Fxq "${container_name}"; then
    info "Removing existing container before recreate: ${container_name}"
    docker rm -f "${container_name}"
  fi
done

run "${ROOT_DIR}/scripts/ops/attendance-preflight.sh"

eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" up -d postgres redis"
eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" pull backend web"
eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" up -d"

info "Running DB migrations inside backend container"
eval "${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" exec -T backend node packages/core-backend/dist/src/db/migrate.js"

info "Restarting web (nginx) to ensure it picks up the latest config and resolves backend via Docker DNS"
eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" restart web"

info "Deploy complete"
