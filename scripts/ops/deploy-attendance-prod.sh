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

info "Starting production deploy (attendance)"
info "Compose: ${COMPOSE_FILE}"
info "Env:     ${ENV_FILE}"
info "Compose cmd: ${COMPOSE_CMD}"

run "${ROOT_DIR}/scripts/ops/attendance-preflight.sh"

eval "${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" pull backend web"
eval "${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" up -d"

info "Running DB migrations inside backend container"
eval "${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" exec -T backend node packages/core-backend/dist/src/db/migrate.js"

info "Restarting web (nginx) to ensure it picks up the latest config and resolves backend via Docker DNS"
eval "${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" restart web"

info "Deploy complete"
