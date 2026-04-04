#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output/releases/multitable-onprem}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
BUILD_WEB="${BUILD_WEB:-0}"
BUILD_BACKEND="${BUILD_BACKEND:-0}"
PACKAGE_PREFIX="${PACKAGE_PREFIX:-metasheet-multitable-onprem}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)}"
PACKAGE_TAG="${PACKAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="${PACKAGE_PREFIX}-v${PACKAGE_VERSION}-${PACKAGE_TAG}"
BUILD_ROOT="${OUTPUT_DIR}/.build/${PACKAGE_NAME}"
PACKAGE_ROOT="${BUILD_ROOT}/${PACKAGE_NAME}"
TMP_OUTPUT_DIR="${OUTPUT_DIR}/.tmp/${PACKAGE_NAME}"
ARCHIVE_TGZ_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.tgz"
ARCHIVE_ZIP_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.zip"
ARCHIVE_TGZ_TMP_PATH="${TMP_OUTPUT_DIR}/${PACKAGE_NAME}.tgz"
ARCHIVE_ZIP_TMP_PATH="${TMP_OUTPUT_DIR}/${PACKAGE_NAME}.zip"
ARCHIVE_TGZ_SHA_TMP_PATH="${ARCHIVE_TGZ_TMP_PATH}.sha256"
ARCHIVE_ZIP_SHA_TMP_PATH="${ARCHIVE_ZIP_TMP_PATH}.sha256"
METADATA_JSON_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.json"
METADATA_JSON_TMP_PATH="${TMP_OUTPUT_DIR}/${PACKAGE_NAME}.json"
CHECKSUM_FILE="${OUTPUT_DIR}/SHA256SUMS"
checksum_tmp=""
PACKAGE_RUN_LABEL="${PACKAGE_TAG%%-*}"

REQUIRED_PATHS=(
  "apps/web/dist"
  "apps/web/package.json"
  "packages/core-backend/dist"
  "packages/core-backend/package.json"
  "plugins/plugin-attendance"
  "scripts/ops/attendance-onprem-bootstrap.sh"
  "scripts/ops/attendance-onprem-bootstrap-admin.sh"
  "scripts/ops/attendance-onprem-env-check.sh"
  "scripts/ops/attendance-onprem-update.sh"
  "scripts/ops/attendance-onprem-deploy-easy.sh"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "scripts/ops/attendance-onprem-healthcheck.sh"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "scripts/ops/multitable-onprem-deploy-easy.sh"
  "scripts/ops/multitable-onprem-apply-package.sh"
  "scripts/ops/multitable-onprem-package-install.sh"
  "scripts/ops/multitable-onprem-package-upgrade.sh"
  "scripts/ops/multitable-onprem-healthcheck.sh"
  "docker/app.env.example"
  "docker/app.env.multitable-onprem.template"
  "ops/nginx/multitable-onprem.conf.example"
  "ops/systemd/metasheet-backend.service.example"
  "ops/systemd/metasheet-healthcheck.service.example"
  "ops/systemd/metasheet-healthcheck.timer.example"
  "ecosystem.config.cjs"
  "package.json"
  "pnpm-lock.yaml"
  "pnpm-workspace.yaml"
  "docs/deployment/multitable-windows-onprem-easy-start-20260319.md"
  "docs/deployment/multitable-onprem-package-layout-20260319.md"
  "docs/deployment/multitable-platform-rc-notes-20260404.md"
)

function info() {
  echo "[multitable-onprem-package-build] $*" >&2
}

function die() {
  echo "[multitable-onprem-package-build] ERROR: $*" >&2
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

function write_windows_entrypoints() {
  cat > "${PACKAGE_ROOT}/deploy.bat" <<'EOF'
@echo off
setlocal
if "%~1"=="" (
  echo Usage: deploy.bat ^<package.zip^|package.tgz^>
  exit /b 64
)
bash "%~dp0scripts\ops\multitable-onprem-apply-package.sh" "%~1"
exit /b %ERRORLEVEL%
EOF

  cat > "${PACKAGE_ROOT}/deploy-remote.bat" <<'EOF'
@echo off
setlocal
if "%~1"=="" (
  echo Usage: deploy-remote.bat ^<package.zip^|package.tgz^>
  exit /b 64
)
if not exist "%~dp0output\logs" mkdir "%~dp0output\logs"
start "" /min cmd /c "call \"%~dp0deploy.bat\" \"%~1\" >> \"%~dp0output\logs\deploy-remote.log\" 2>&1"
echo [multitable-onprem-deploy-remote] started. See output\logs\deploy-remote.log
exit /b 0
EOF

  cat > "${PACKAGE_ROOT}/deploy-${PACKAGE_RUN_LABEL}.bat" <<'EOF'
@echo off
setlocal
call "%~dp0deploy.bat" "%~1"
exit /b %ERRORLEVEL%
EOF
}

function cleanup() {
  [[ -n "$checksum_tmp" ]] && rm -f "$checksum_tmp" || true
  rm -rf "$TMP_OUTPUT_DIR" || true
}

function stamp_packaged_version() {
  local rel="$1"
  local file="${PACKAGE_ROOT}/${rel}"
  [[ -f "$file" ]] || return 0
  node - "$file" "$PACKAGE_VERSION" <<'EOF'
const fs = require('fs')

const [, , file, version] = process.argv
const raw = fs.readFileSync(file, 'utf8')
const json = JSON.parse(raw)
json.version = version
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
EOF
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

trap cleanup EXIT

for rel in "${REQUIRED_PATHS[@]}"; do
  [[ -e "${ROOT_DIR}/${rel}" ]] || die "Required file missing before packaging: ${rel}"
done

run rm -rf "$BUILD_ROOT"
run mkdir -p "$PACKAGE_ROOT"
run mkdir -p "$OUTPUT_DIR"
run mkdir -p "$TMP_OUTPUT_DIR"
command -v zip >/dev/null 2>&1 || die "zip command is required to build Windows package"

for rel in "${REQUIRED_PATHS[@]}"; do
  copy_path "$rel"
done

stamp_packaged_version "package.json"
stamp_packaged_version "packages/core-backend/package.json"
write_windows_entrypoints

cat > "${PACKAGE_ROOT}/INSTALL.txt" <<EOF
MetaSheet Multitable On-Prem Package
Version: ${PACKAGE_VERSION}
Tag: ${PACKAGE_TAG}

Install quickstart:
  docs/deployment/multitable-windows-onprem-easy-start-20260319.md

Package layout guide:
  docs/deployment/multitable-onprem-package-layout-20260319.md

Server-side apply helpers:
  deploy.bat <package.zip|package.tgz>
  deploy-remote.bat <package.zip|package.tgz>
  deploy-${PACKAGE_RUN_LABEL}.bat <package.zip|package.tgz>
EOF

run rm -f "$ARCHIVE_TGZ_TMP_PATH" "$ARCHIVE_ZIP_TMP_PATH" "$ARCHIVE_TGZ_SHA_TMP_PATH" "$ARCHIVE_ZIP_SHA_TMP_PATH" "$METADATA_JSON_TMP_PATH"
run tar -czf "$ARCHIVE_TGZ_TMP_PATH" -C "$BUILD_ROOT" "$PACKAGE_NAME"
run bash -lc "cd \"$BUILD_ROOT\" && zip -qr \"$ARCHIVE_ZIP_TMP_PATH\" \"$PACKAGE_NAME\""
write_sha_file "$ARCHIVE_TGZ_TMP_PATH"
write_sha_file "$ARCHIVE_ZIP_TMP_PATH"

checksum_tmp="$(mktemp)"
if [[ -f "$CHECKSUM_FILE" ]]; then
  awk -v tgz="${PACKAGE_NAME}.tgz" -v zip="${PACKAGE_NAME}.zip" '$2 != tgz && $2 != zip { print }' "$CHECKSUM_FILE" > "$checksum_tmp"
else
  : > "$checksum_tmp"
fi
add_checksum_entry "$ARCHIVE_TGZ_TMP_PATH" >> "$checksum_tmp"
add_checksum_entry "$ARCHIVE_ZIP_TMP_PATH" >> "$checksum_tmp"

cat > "${METADATA_JSON_TMP_PATH}" <<EOF
{
  "name": "${PACKAGE_NAME}",
  "version": "${PACKAGE_VERSION}",
  "tag": "${PACKAGE_TAG}",
  "attendanceOnly": false,
  "productMode": "platform",
  "includedPlugins": ["plugin-attendance"],
  "archive": "$(basename "$ARCHIVE_TGZ_PATH")",
  "archiveZip": "$(basename "$ARCHIVE_ZIP_PATH")",
  "checksumFile": "$(basename "$CHECKSUM_FILE")",
  "generatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

mv "$ARCHIVE_TGZ_TMP_PATH" "$ARCHIVE_TGZ_PATH"
mv "$ARCHIVE_ZIP_TMP_PATH" "$ARCHIVE_ZIP_PATH"
mv "$ARCHIVE_TGZ_SHA_TMP_PATH" "${ARCHIVE_TGZ_PATH}.sha256"
mv "$ARCHIVE_ZIP_SHA_TMP_PATH" "${ARCHIVE_ZIP_PATH}.sha256"
mv "$checksum_tmp" "$CHECKSUM_FILE"
checksum_tmp=""
mv "${METADATA_JSON_TMP_PATH}" "${METADATA_JSON_PATH}"
rm -rf "$TMP_OUTPUT_DIR"

info "Package built:"
info "  archive_tgz: ${ARCHIVE_TGZ_PATH}"
info "  archive_zip: ${ARCHIVE_ZIP_PATH}"
info "  checksum_tgz: ${ARCHIVE_TGZ_PATH}.sha256"
info "  checksum_zip: ${ARCHIVE_ZIP_PATH}.sha256"
info "  index: ${CHECKSUM_FILE}"
info "  metadata_json: ${METADATA_JSON_PATH}"
