#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output/releases/attendance-onprem}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
BUILD_WEB="${BUILD_WEB:-0}"
BUILD_BACKEND="${BUILD_BACKEND:-0}"
PACKAGE_PREFIX="${PACKAGE_PREFIX:-metasheet-attendance-onprem}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)}"
PACKAGE_TAG="${PACKAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="${PACKAGE_PREFIX}-v${PACKAGE_VERSION}-${PACKAGE_TAG}"
BUILD_ROOT="${OUTPUT_DIR}/.build/${PACKAGE_NAME}"
PACKAGE_ROOT="${BUILD_ROOT}/${PACKAGE_NAME}"
ARCHIVE_TGZ_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.tgz"
ARCHIVE_ZIP_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.zip"
CHECKSUM_FILE="${OUTPUT_DIR}/SHA256SUMS"

REQUIRED_PATHS=(
  "apps/web/dist/index.html"
  "packages/core-backend/dist/src/db/migrate.js"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "scripts/ops/attendance-onprem-deploy-easy.sh"
  "scripts/ops/attendance-onprem-bootstrap.sh"
  "scripts/ops/attendance-onprem-bootstrap-admin.sh"
  "scripts/ops/attendance-onprem-env-check.sh"
  "scripts/ops/attendance-onprem-healthcheck.sh"
  "scripts/ops/attendance-onprem-update.sh"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "docker/app.env.example"
  "docker/app.env.attendance-onprem.template"
  "docker/app.env.attendance-onprem.ready.env"
  "ops/nginx/attendance-onprem.conf.example"
  "ops/systemd/metasheet-backend.service.example"
  "ops/systemd/metasheet-healthcheck.service.example"
  "ops/systemd/metasheet-healthcheck.timer.example"
  "ecosystem.config.cjs"
  "package.json"
  "pnpm-lock.yaml"
  "pnpm-workspace.yaml"
  "docs/deployment/attendance-windows-onprem-easy-start-20260306.md"
  "docs/deployment/attendance-onprem-package-layout-20260306.md"
  "docs/deployment/attendance-windows-onprem-no-docker-20260306.md"
  "docs/deployment/attendance-windows-wsl-onprem-20260306.md"
  "docs/deployment/attendance-windows-wsl-direct-commands-20260306.md"
  "docs/deployment/attendance-windows-wsl-customer-profiled-commands-20260306.md"
  "docs/deployment/attendance-onprem-app-env-template-20260306.md"
  "docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md"
)

function info() {
  echo "[attendance-onprem-package-build] $*" >&2
}

function die() {
  echo "[attendance-onprem-package-build] ERROR: $*" >&2
  exit 1
}

function run() {
  info "+ $*"
  "$@"
}

function hash_value() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "Missing hash tool: sha256sum or shasum"
  fi
}

function write_sha_file() {
  local archive="$1"
  local hash
  hash="$(hash_value "$archive")"
  printf '%s  %s\n' "$hash" "$(basename "$archive")" > "${archive}.sha256"
}

function add_checksum_entry() {
  local archive="$1"
  local base
  local hash
  base="$(basename "$archive")"
  hash="$(hash_value "$archive")"
  printf '%s  %s\n' "$hash" "$base"
}

function copy_path() {
  local rel="$1"
  local src="${ROOT_DIR}/${rel}"
  local dst="${PACKAGE_ROOT}/${rel}"
  [[ -e "$src" ]] || die "Missing path: ${rel}"
  mkdir -p "$(dirname "$dst")"
  if [[ -d "$src" ]]; then
    cp -R "$src" "$dst"
  else
    cp "$src" "$dst"
  fi
}

if [[ "$INSTALL_DEPS" == "1" ]]; then
  run pnpm install --frozen-lockfile
fi

if [[ "$BUILD_WEB" == "1" ]]; then
  run pnpm --filter @metasheet/web build
fi

if [[ "$BUILD_BACKEND" == "1" ]]; then
  run pnpm --filter @metasheet/core-backend build
fi

for rel in "${REQUIRED_PATHS[@]}"; do
  [[ -e "${ROOT_DIR}/${rel}" ]] || die "Required file missing before packaging: ${rel}"
done

run rm -rf "$BUILD_ROOT"
run mkdir -p "$PACKAGE_ROOT"
run mkdir -p "$OUTPUT_DIR"
command -v zip >/dev/null 2>&1 || die "zip command is required to build Windows package"

for rel in "${REQUIRED_PATHS[@]}"; do
  copy_path "$rel"
done

cat > "${PACKAGE_ROOT}/INSTALL.txt" <<EOF
MetaSheet Attendance On-Prem Package
Version: ${PACKAGE_VERSION}
Tag: ${PACKAGE_TAG}

Install quickstart:
  docs/deployment/attendance-windows-onprem-easy-start-20260306.md

Package layout guide:
  docs/deployment/attendance-onprem-package-layout-20260306.md
EOF

run tar -czf "$ARCHIVE_TGZ_PATH" -C "$BUILD_ROOT" "$PACKAGE_NAME"
run bash -lc "cd \"$BUILD_ROOT\" && zip -qr \"$ARCHIVE_ZIP_PATH\" \"$PACKAGE_NAME\""
write_sha_file "$ARCHIVE_TGZ_PATH"
write_sha_file "$ARCHIVE_ZIP_PATH"

checksum_tmp="$(mktemp)"
trap 'rm -f "$checksum_tmp"' EXIT
if [[ -f "$CHECKSUM_FILE" ]]; then
  awk -v tgz="${PACKAGE_NAME}.tgz" -v zip="${PACKAGE_NAME}.zip" '$2 != tgz && $2 != zip { print }' "$CHECKSUM_FILE" > "$checksum_tmp"
else
  : > "$checksum_tmp"
fi
add_checksum_entry "$ARCHIVE_TGZ_PATH" >> "$checksum_tmp"
add_checksum_entry "$ARCHIVE_ZIP_PATH" >> "$checksum_tmp"
mv "$checksum_tmp" "$CHECKSUM_FILE"
trap - EXIT

cat > "${OUTPUT_DIR}/${PACKAGE_NAME}.json" <<EOF
{
  "name": "${PACKAGE_NAME}",
  "version": "${PACKAGE_VERSION}",
  "tag": "${PACKAGE_TAG}",
  "archive": "$(basename "$ARCHIVE_TGZ_PATH")",
  "archiveZip": "$(basename "$ARCHIVE_ZIP_PATH")",
  "checksumFile": "$(basename "$CHECKSUM_FILE")",
  "generatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

info "Package built:"
info "  archive_tgz: ${ARCHIVE_TGZ_PATH}"
info "  archive_zip: ${ARCHIVE_ZIP_PATH}"
info "  checksum_tgz: ${ARCHIVE_TGZ_PATH}.sha256"
info "  checksum_zip: ${ARCHIVE_ZIP_PATH}.sha256"
info "  index: ${CHECKSUM_FILE}"
