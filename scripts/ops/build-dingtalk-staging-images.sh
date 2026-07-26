#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"
IMAGE_OWNER="${IMAGE_OWNER:-zensgit}"
IMAGE_TAG="${IMAGE_TAG:-}"
BUILD_SOURCE="${BUILD_SOURCE:-https://github.com/zensgit/metasheet2}"
IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-}"

function info() {
  echo "[build-dingtalk-staging-images] $*" >&2
}

function die() {
  echo "[build-dingtalk-staging-images] ERROR: $*" >&2
  exit 1
}

function require_control_free_path() {
  python3 - "$1" <<'PY' || die "a build path contains control characters"
import sys

value = sys.argv[1]
raise SystemExit(1 if any(ord(char) < 32 or ord(char) == 127 for char in value) else 0)
PY
}

require_control_free_path "${SOURCE_DIR}"
require_control_free_path "${IMAGE_PROVENANCE_FILE}"
[[ -n "${IMAGE_TAG}" ]] || die "IMAGE_TAG is required"
[[ -n "${IMAGE_PROVENANCE_FILE}" ]] || die "IMAGE_PROVENANCE_FILE is required"
[[ "${IMAGE_PROVENANCE_FILE}" == /* ]] || die "IMAGE_PROVENANCE_FILE must be an absolute path"
[[ "${IMAGE_OWNER}" =~ ^[a-z0-9._-]+$ ]] || die "IMAGE_OWNER has an invalid format"
[[ "${IMAGE_TAG}" =~ ^[0-9a-f]{40}$ ]] || die "IMAGE_TAG must be a full 40-character lowercase commit SHA"
[[ "${BUILD_SOURCE}" == "https://github.com/zensgit/metasheet2" ]] || die "BUILD_SOURCE must be the canonical repository URL"
[[ -f "${SOURCE_DIR}/Dockerfile.backend" ]] || die "source checkout is missing the backend Dockerfile"
[[ -f "${SOURCE_DIR}/Dockerfile.frontend" ]] || die "source checkout is missing the frontend Dockerfile"
[[ -d "$(dirname "${IMAGE_PROVENANCE_FILE}")" ]] || die "IMAGE_PROVENANCE_FILE parent directory does not exist"

SOURCE_SHA="$(git -C "${SOURCE_DIR}" rev-parse HEAD 2>/dev/null || true)"
[[ "${SOURCE_SHA}" == "${IMAGE_TAG}" ]] || die "source checkout does not match IMAGE_TAG"
if ! SOURCE_DIRTY="$(git -C "${SOURCE_DIR}" status --porcelain --untracked-files=all 2>/dev/null)"; then
  die "could not verify source checkout cleanliness"
fi
[[ -z "${SOURCE_DIRTY}" ]] || die "source checkout must be clean before building an immutable SHA image"

BACKEND_IMAGE="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${IMAGE_TAG}"
WEB_IMAGE="ghcr.io/${IMAGE_OWNER}/metasheet2-web:${IMAGE_TAG}"
BUILD_CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUILD_CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/metasheet-dingtalk-build.XXXXXX")"

cleanup() {
  rm -rf -- "${BUILD_CONTEXT}"
}
trap cleanup EXIT INT TERM

git -C "${SOURCE_DIR}" archive --format=tar "${IMAGE_TAG}" | tar -xf - -C "${BUILD_CONTEXT}"
[[ -f "${BUILD_CONTEXT}/Dockerfile.backend" ]] || die "archived commit is missing Dockerfile.backend"
[[ -f "${BUILD_CONTEXT}/Dockerfile.frontend" ]] || die "archived commit is missing Dockerfile.frontend"

info "Source checkout validated"
info "Backend image identity validated"
info "Web image identity validated"

COMMON_BUILD_ARGS=(
  --build-arg "VCS_REF=${IMAGE_TAG}"
  --build-arg "BUILD_IMAGE_TAG=${IMAGE_TAG}"
  --build-arg "BUILD_IMAGE_SOURCE=${BUILD_SOURCE}"
  --build-arg "BUILD_CREATED=${BUILD_CREATED}"
)

docker build -f "${BUILD_CONTEXT}/Dockerfile.backend" "${COMMON_BUILD_ARGS[@]}" -t "${BACKEND_IMAGE}" "${BUILD_CONTEXT}"
docker build -f "${BUILD_CONTEXT}/Dockerfile.frontend" "${COMMON_BUILD_ARGS[@]}" -t "${WEB_IMAGE}" "${BUILD_CONTEXT}"

docker image inspect "${BACKEND_IMAGE}" >/dev/null
docker image inspect "${WEB_IMAGE}" >/dev/null

for image in "${BACKEND_IMAGE}" "${WEB_IMAGE}"; do
  revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}")"
  [[ "${revision}" == "${IMAGE_TAG}" ]] || die "built image revision does not match IMAGE_TAG"
done

BACKEND_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "${BACKEND_IMAGE}")"
WEB_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "${WEB_IMAGE}")"
[[ "${BACKEND_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "backend image ID is invalid"
[[ "${WEB_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "web image ID is invalid"

python3 - "${IMAGE_PROVENANCE_FILE}" "${IMAGE_TAG}" "${BACKEND_IMAGE}" "${BACKEND_IMAGE_ID}" "${WEB_IMAGE}" "${WEB_IMAGE_ID}" <<'PY'
import json
import os
import sys

target, commit, backend_image, backend_id, web_image, web_id = sys.argv[1:]
payload = {
    "schema": "metasheet-dingtalk-staging-image-provenance/v1",
    "commit": commit,
    "backendImage": backend_image,
    "backendImageId": backend_id,
    "webImage": web_image,
    "webImageId": web_id,
}
temporary = f"{target}.tmp.{os.getpid()}"
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
os.replace(temporary, target)
PY
chmod 600 "${IMAGE_PROVENANCE_FILE}"

info "Image provenance written"
info "Local image build complete"
