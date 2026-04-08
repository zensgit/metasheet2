#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.staging.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.staging.env}"
DEPLOY_IMAGE_OWNER="${DEPLOY_IMAGE_OWNER:-zensgit}"
DEPLOY_IMAGE_TAG="${DEPLOY_IMAGE_TAG:-latest}"

function info() {
  echo "[deploy-dingtalk-staging] $*" >&2
}

function die() {
  echo "[deploy-dingtalk-staging] ERROR: $*" >&2
  exit 1
}

function resolve_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  return 1
}

COMPOSE_CMD="$(resolve_compose_cmd || true)"
[[ -n "${COMPOSE_CMD}" ]] || die "docker compose v2 is required"
[[ -f "${COMPOSE_FILE}" ]] || die "missing compose file: ${COMPOSE_FILE}"
[[ -f "${ENV_FILE}" ]] || die "missing env file: ${ENV_FILE}"

info "Compose: ${COMPOSE_FILE}"
info "Env:     ${ENV_FILE}"
info "Image owner: ${DEPLOY_IMAGE_OWNER}"
info "Image tag:   ${DEPLOY_IMAGE_TAG}"

eval "APP_ENV_FILE=\"${ENV_FILE}\" IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\" config >/dev/null"
eval "APP_ENV_FILE=\"${ENV_FILE}\" IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\" up -d postgres redis"
eval "APP_ENV_FILE=\"${ENV_FILE}\" IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\" pull backend web"
eval "APP_ENV_FILE=\"${ENV_FILE}\" IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\" up -d backend web"

info "Waiting for backend health endpoint"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18900/health >/dev/null 2>&1; then
    eval "APP_ENV_FILE=\"${ENV_FILE}\" ${COMPOSE_CMD} --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\" ps"
    info "Staging deploy complete"
    exit 0
  fi
  sleep 2
done

die "backend health endpoint did not become ready on 127.0.0.1:18900"
