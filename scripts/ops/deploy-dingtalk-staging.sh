#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.staging.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.staging.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-metasheet2-dingtalk-staging}"
SKIP_PULL="${SKIP_PULL:-0}"
ENV_VALIDATOR="${ROOT_DIR}/scripts/ops/validate-env-file.sh"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-http://127.0.0.1:18900/health}"
DEPLOY_IMAGE_PROVENANCE_FILE="${DEPLOY_IMAGE_PROVENANCE_FILE:-}"

function info() {
  echo "[deploy-dingtalk-staging] $*" >&2
}

function die() {
  echo "[deploy-dingtalk-staging] ERROR: $*" >&2
  exit 1
}

function require_control_free_path() {
  python3 - "$1" <<'PY' || die "a deploy path contains control characters"
import sys

value = sys.argv[1]
raise SystemExit(1 if any(ord(char) < 32 or ord(char) == 127 for char in value) else 0)
PY
}

function read_env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); gsub(/\r$/, ""); print; exit }' "${file}"
}

docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
require_control_free_path "${COMPOSE_FILE}"
require_control_free_path "${ENV_FILE}"
require_control_free_path "${DEPLOY_IMAGE_PROVENANCE_FILE}"
[[ -f "${COMPOSE_FILE}" ]] || die "managed staging compose file is missing"
[[ -f "${ENV_FILE}" ]] || die "managed staging env file is missing"
[[ -x "${ENV_VALIDATOR}" ]] || die "managed staging env validator is missing"

ENV_IMAGE_OWNER="$(read_env_value IMAGE_OWNER "${ENV_FILE}" || true)"
ENV_IMAGE_TAG="$(read_env_value IMAGE_TAG "${ENV_FILE}" || true)"
DEPLOY_IMAGE_OWNER="${DEPLOY_IMAGE_OWNER:-${ENV_IMAGE_OWNER:-zensgit}}"
DEPLOY_IMAGE_TAG="${DEPLOY_IMAGE_TAG:-${ENV_IMAGE_TAG:-}}"
DEPLOY_EXPECTED_COMMIT="${DEPLOY_EXPECTED_COMMIT:-${DEPLOY_IMAGE_TAG}}"

[[ "${DEPLOY_IMAGE_OWNER}" =~ ^[a-z0-9._-]+$ ]] || die "DEPLOY_IMAGE_OWNER has an invalid format"
[[ "${COMPOSE_PROJECT_NAME}" == "metasheet2-dingtalk-staging" ]] \
  || die "COMPOSE_PROJECT_NAME must be metasheet2-dingtalk-staging"
[[ "${DEPLOY_IMAGE_TAG}" =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_IMAGE_TAG must be a full 40-character lowercase commit SHA"
[[ "${DEPLOY_EXPECTED_COMMIT}" == "${DEPLOY_IMAGE_TAG}" ]] || die "DEPLOY_EXPECTED_COMMIT must match DEPLOY_IMAGE_TAG"
[[ "${SKIP_PULL}" == "0" || "${SKIP_PULL}" == "1" ]] || die "SKIP_PULL must be 0 or 1"
[[ "${BACKEND_HEALTH_URL}" == "http://127.0.0.1:18900/health" ]] || die "BACKEND_HEALTH_URL must be the managed loopback health endpoint"
[[ -n "${DEPLOY_IMAGE_PROVENANCE_FILE}" ]] || die "DEPLOY_IMAGE_PROVENANCE_FILE is required"
[[ "${DEPLOY_IMAGE_PROVENANCE_FILE}" == /* ]] || die "DEPLOY_IMAGE_PROVENANCE_FILE must be an absolute path"
[[ -f "${DEPLOY_IMAGE_PROVENANCE_FILE}" && ! -L "${DEPLOY_IMAGE_PROVENANCE_FILE}" ]] || die "DEPLOY_IMAGE_PROVENANCE_FILE must be a regular file"
provenance_uid="$(stat -c '%u' "${DEPLOY_IMAGE_PROVENANCE_FILE}" 2>/dev/null || stat -f '%u' "${DEPLOY_IMAGE_PROVENANCE_FILE}" 2>/dev/null || true)"
provenance_mode="$(stat -c '%a' "${DEPLOY_IMAGE_PROVENANCE_FILE}" 2>/dev/null || stat -f '%Lp' "${DEPLOY_IMAGE_PROVENANCE_FILE}" 2>/dev/null || true)"
[[ "${provenance_uid}" == "$(id -u)" ]] || die "DEPLOY_IMAGE_PROVENANCE_FILE must be owned by the deploy user"
[[ "${provenance_mode}" == "400" || "${provenance_mode}" == "600" ]] || die "DEPLOY_IMAGE_PROVENANCE_FILE permissions must be 0400 or 0600"

expected_image="ghcr.io/${DEPLOY_IMAGE_OWNER}/metasheet2-backend:${DEPLOY_IMAGE_TAG}"
attested_backend_image_id="$(python3 - "${DEPLOY_IMAGE_PROVENANCE_FILE}" "${DEPLOY_EXPECTED_COMMIT}" "${expected_image}" <<'PY'
import json
import re
import sys

path, expected_commit, expected_image = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
except Exception:
    raise SystemExit(1)

if not isinstance(payload, dict):
    raise SystemExit(1)
image_id = payload.get("backendImageId")
if (
    payload.get("schema") != "metasheet-dingtalk-staging-image-provenance/v1"
    or payload.get("commit") != expected_commit
    or payload.get("backendImage") != expected_image
    or not isinstance(image_id, str)
    or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None
):
    raise SystemExit(1)
print(image_id)
PY
)" || die "image provenance does not match the pinned deploy"

info "Compose file validated"
info "Env file validated"
info "Image owner validated"
info "Image commit validated"
info "Skip pull: ${SKIP_PULL}"

"${ENV_VALIDATOR}" "${ENV_FILE}"

compose() {
  APP_ENV_FILE="${ENV_FILE}" IMAGE_OWNER="${DEPLOY_IMAGE_OWNER}" IMAGE_TAG="${DEPLOY_IMAGE_TAG}" \
    docker compose --project-name "${COMPOSE_PROJECT_NAME}" \
      --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

compose config >/dev/null
compose up -d postgres redis
if [[ "${SKIP_PULL}" != "1" ]]; then
  compose pull backend web
fi
compose up -d --remove-orphans backend web

info "Waiting for backend health endpoint"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 -- "${BACKEND_HEALTH_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

health_json="$(curl -fsS --max-time 10 -- "${BACKEND_HEALTH_URL}" 2>/dev/null || true)"
[[ -n "${health_json}" ]] || die "backend health endpoint did not become ready"

backend_ids="$(compose ps -q --all backend | sed '/^[[:space:]]*$/d')"
backend_count="$(printf '%s\n' "${backend_ids}" | awk 'NF { count += 1 } END { print count + 0 }')"
[[ "${backend_count}" == "1" ]] || die "managed staging stack must have exactly one backend worker"
backend_id="$(printf '%s\n' "${backend_ids}" | head -n 1)"

ingress_backend_ids="$(docker ps -q --filter "publish=18900" | sed '/^[[:space:]]*$/d')"
ingress_backend_count="$(printf '%s\n' "${ingress_backend_ids}" | awk 'NF { count += 1 } END { print count + 0 }')"
[[ "${ingress_backend_count}" == "1" ]] || die "staging backend ingress must resolve to exactly one running container"
[[ "${ingress_backend_ids}" == "${backend_id}" ]] || die "staging backend ingress does not resolve to the managed backend worker"

backend_running="$(docker inspect -f '{{.State.Running}}' "${backend_id}" 2>/dev/null || true)"
[[ "${backend_running}" == "true" ]] || die "managed backend worker is not running"

backend_image="$(docker inspect -f '{{.Config.Image}}' "${backend_id}" 2>/dev/null || true)"
[[ "${backend_image}" == "${expected_image}" ]] || die "managed backend worker image does not match the pinned deploy image"

backend_image_id="$(docker inspect -f '{{.Image}}' "${backend_id}" 2>/dev/null || true)"
[[ "${backend_image_id}" == "${attested_backend_image_id}" ]] || die "managed backend worker image ID does not match build provenance"

backend_revision="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${backend_id}" 2>/dev/null || true)"
[[ "${backend_revision}" == "${DEPLOY_EXPECTED_COMMIT}" ]] || die "managed backend worker revision does not match the pinned deploy commit"

compose_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${backend_id}" 2>/dev/null || true)"
[[ "${compose_project}" == "${COMPOSE_PROJECT_NAME}" ]] \
  || die "managed backend worker Compose project does not match the staging project"
project_container_ids="$(docker ps -q --filter "label=com.docker.compose.project=${compose_project}" | sed '/^[[:space:]]*$/d')"
project_services=""
while IFS= read -r project_container_id; do
  [[ -n "${project_container_id}" ]] || continue
  project_service="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "${project_container_id}" 2>/dev/null || true)"
  project_services="${project_services}${project_service}"$'\n'
done <<< "${project_container_ids}"
project_service_set="$(printf '%s' "${project_services}" | sed '/^[[:space:]]*$/d' | sort)"
expected_service_set="$(printf '%s\n' backend postgres redis web)"
[[ "${project_service_set}" == "${expected_service_set}" ]] || die "managed staging Compose project contains a missing, duplicate, or orphan service"

if ! printf '%s' "${health_json}" | python3 -c '
import json
import sys

expected = sys.argv[1]
try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)

if not isinstance(payload, dict) or payload.get("ok") is not True:
    raise SystemExit(1)
build = payload.get("build")
if not isinstance(build, dict) or build.get("commit") != expected:
    raise SystemExit(1)
' "${DEPLOY_EXPECTED_COMMIT}"; then
  die "backend health build identity does not match the pinned deploy commit"
fi

compose ps
info "WORKER_DRAIN_GATE_PASS expected_project_workers=1 observed_project_workers=1 managed_project_old_workers=0 staging_ingress_workers=1 staging_ingress_unmanaged_workers=0 build_commit_match=1 image_match=1 image_id_match=1 revision_match=1 project_services_match=1"
info "Staging deploy complete"
