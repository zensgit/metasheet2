#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"
IMAGE_OWNER="${IMAGE_OWNER:-zensgit}"
IMAGE_TAG="${IMAGE_TAG:-}"

function info() {
  echo "[build-dingtalk-staging-images] $*" >&2
}

function die() {
  echo "[build-dingtalk-staging-images] ERROR: $*" >&2
  exit 1
}

[[ -n "${IMAGE_TAG}" ]] || die "IMAGE_TAG is required"
[[ -f "${SOURCE_DIR}/Dockerfile.backend" ]] || die "missing ${SOURCE_DIR}/Dockerfile.backend"
[[ -f "${SOURCE_DIR}/Dockerfile.frontend" ]] || die "missing ${SOURCE_DIR}/Dockerfile.frontend"

BACKEND_IMAGE="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${IMAGE_TAG}"
WEB_IMAGE="ghcr.io/${IMAGE_OWNER}/metasheet2-web:${IMAGE_TAG}"

info "Source: ${SOURCE_DIR}"
info "Backend image: ${BACKEND_IMAGE}"
info "Web image:     ${WEB_IMAGE}"

docker build -f "${SOURCE_DIR}/Dockerfile.backend" -t "${BACKEND_IMAGE}" "${SOURCE_DIR}"
docker build -f "${SOURCE_DIR}/Dockerfile.frontend" -t "${WEB_IMAGE}" "${SOURCE_DIR}"

docker image inspect "${BACKEND_IMAGE}" >/dev/null
docker image inspect "${WEB_IMAGE}" >/dev/null

info "Local image build complete"
