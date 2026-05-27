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

function fetch_json_with_retry() {
  local label="$1"
  local url="$2"
  local attempts="${3:-15}"
  local delay_seconds="${4:-2}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "${url}" 2>/dev/null; then
      return 0
    fi
    info "Waiting for ${label} to respond at ${url} (attempt ${i}/${attempts})"
    sleep "${delay_seconds}"
  done

  echo "[deploy-attendance-prod] ERROR: ${label} check timed out at ${url}" >&2
  return 1
}

function resolve_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  return 1
}

COMPOSE_CMD="$(resolve_compose_cmd || true)"
if [[ -z "$COMPOSE_CMD" ]]; then
  if command -v docker-compose >/dev/null 2>&1; then
    echo "[deploy-attendance-prod] ERROR: legacy 'docker-compose' detected: $(docker-compose --version | head -n 1)" >&2
    echo "[deploy-attendance-prod] ERROR: install Docker Compose v2 plugin so 'docker compose' is available" >&2
  else
    echo "[deploy-attendance-prod] ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2
  fi
  exit 125
fi
DEPLOY_IMAGE_OWNER="${DEPLOY_IMAGE_OWNER:-zensgit}"
DEPLOY_IMAGE_TAG="${DEPLOY_IMAGE_TAG:-${IMAGE_TAG:-}}"
DEPLOY_EXPECTED_COMMIT="${DEPLOY_EXPECTED_COMMIT:-${DEPLOY_IMAGE_TAG}}"
DEPLOY_BACKEND_HEALTH_URL="${DEPLOY_BACKEND_HEALTH_URL:-http://127.0.0.1:8900/health}"
DEPLOY_WEB_BUILD_INFO_URL="${DEPLOY_WEB_BUILD_INFO_URL:-http://127.0.0.1:8081/build-info.json}"

if [[ -z "${DEPLOY_IMAGE_TAG}" ]]; then
  echo "[deploy-attendance-prod] ERROR: DEPLOY_IMAGE_TAG must be set to a full 40-character commit SHA" >&2
  exit 78
fi

if ! [[ "${DEPLOY_IMAGE_TAG}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[deploy-attendance-prod] ERROR: DEPLOY_IMAGE_TAG must be a full 40-character commit SHA, got: ${DEPLOY_IMAGE_TAG}" >&2
  exit 78
fi

if [[ "${DEPLOY_EXPECTED_COMMIT}" != "${DEPLOY_IMAGE_TAG}" ]]; then
  echo "[deploy-attendance-prod] ERROR: DEPLOY_EXPECTED_COMMIT must match DEPLOY_IMAGE_TAG, expected=${DEPLOY_EXPECTED_COMMIT}, tag=${DEPLOY_IMAGE_TAG}" >&2
  exit 78
fi

info "Starting production deploy (attendance)"
info "Compose: ${COMPOSE_FILE}"
info "Env:     ${ENV_FILE}"
info "Compose cmd: ${COMPOSE_CMD}"
info "Image owner: ${DEPLOY_IMAGE_OWNER}"
info "Image tag:   ${DEPLOY_IMAGE_TAG}"
info "Expected commit: ${DEPLOY_EXPECTED_COMMIT}"

for container_name in metasheet-postgres metasheet-redis metasheet-backend metasheet-web; do
  if docker ps -a --format '{{.Names}}' | grep -Fxq "${container_name}"; then
    info "Removing existing container before recreate: ${container_name}"
    docker rm -f "${container_name}"
  fi
done

while IFS= read -r orphan_name; do
  [[ -n "${orphan_name}" ]] || continue
  info "Removing hashed legacy metasheet container before recreate: ${orphan_name}"
  docker rm -f "${orphan_name}"
done < <(docker ps -a --format '{{.Names}}' | grep -E '^[a-f0-9]+_metasheet-(postgres|redis|backend|web)$' || true)

run "${ROOT_DIR}/scripts/ops/attendance-preflight.sh"

eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" up -d postgres redis"
eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" pull backend web"
backend_image="ghcr.io/${DEPLOY_IMAGE_OWNER}/metasheet2-backend:${DEPLOY_IMAGE_TAG}"
web_image="ghcr.io/${DEPLOY_IMAGE_OWNER}/metasheet2-web:${DEPLOY_IMAGE_TAG}"
backend_repo_digest="$(docker image inspect "${backend_image}" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | grep '/metasheet2-backend@' | head -n 1 || true)"
web_repo_digest="$(docker image inspect "${web_image}" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | grep '/metasheet2-web@' | head -n 1 || true)"
info "Backend image: ${backend_image}"
info "Backend repo digest: ${backend_repo_digest:-missing}"
info "Web image: ${web_image}"
info "Web repo digest: ${web_repo_digest:-missing}"
eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" up -d"

info "Running DB migrations inside backend container"
eval "${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" exec -T backend node packages/core-backend/dist/src/db/migrate.js"

info "Restarting web (nginx) to ensure it picks up the latest config and resolves backend via Docker DNS"
eval "IMAGE_OWNER=\"${DEPLOY_IMAGE_OWNER}\" IMAGE_TAG=\"${DEPLOY_IMAGE_TAG}\" ${COMPOSE_CMD} -f \"${COMPOSE_FILE}\" restart web"

info "Verifying deployed backend/web commit"
backend_health_json="$(fetch_json_with_retry "backend health" "${DEPLOY_BACKEND_HEALTH_URL}")"
web_build_json="$(fetch_json_with_retry "web build-info" "${DEPLOY_WEB_BUILD_INFO_URL}")"
python3 - "${DEPLOY_EXPECTED_COMMIT}" "${backend_health_json}" "${web_build_json}" <<'PY'
import json
import sys

expected, backend_raw, web_raw = sys.argv[1:4]

def fail(message: str) -> None:
    print(f"[deploy-attendance-prod] ERROR: {message}", file=sys.stderr)
    sys.exit(1)

try:
    backend = json.loads(backend_raw)
except Exception as exc:
    fail(f"backend /health did not return valid JSON: {exc}")

if not isinstance(backend, dict):
    fail(f"backend /health response is not a JSON object, got: {type(backend).__name__}")

try:
    web = json.loads(web_raw)
except Exception as exc:
    fail(f"web /build-info.json did not return valid JSON: {exc}")

if not isinstance(web, dict):
    fail(f"web /build-info.json response is not a JSON object, got: {type(web).__name__}")

backend_build = backend.get("build") or {}
if not isinstance(backend_build, dict):
    fail(f"backend /health build field is not a JSON object, got: {type(backend_build).__name__}")

backend_commit = str((backend_build.get("commit") or "")).strip()
web_commit = str((web.get("commit") or "")).strip()

if backend_commit != expected:
    fail(f"backend commit mismatch: expected {expected}, got {backend_commit or '<missing>'}")
if web_commit != expected:
    fail(f"web commit mismatch: expected {expected}, got {web_commit or '<missing>'}")

print(f"[deploy-attendance-prod] backend_commit={backend_commit}")
print(f"[deploy-attendance-prod] web_commit={web_commit}")
PY

info "Deploy complete"
