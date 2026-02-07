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

info "Starting production deploy (attendance)"
info "Compose: ${COMPOSE_FILE}"
info "Env:     ${ENV_FILE}"

run "${ROOT_DIR}/scripts/ops/attendance-preflight.sh"

run docker compose -f "${COMPOSE_FILE}" pull backend web
run docker compose -f "${COMPOSE_FILE}" up -d

info "Running DB migrations inside backend container"
run docker compose -f "${COMPOSE_FILE}" exec -T backend node packages/core-backend/dist/src/db/migrate.js

info "Restarting web (nginx) to ensure it picks up the latest config and resolves backend via Docker DNS"
run docker compose -f "${COMPOSE_FILE}" restart web

info "Deploy complete"

