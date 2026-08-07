#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output/releases/attendance-onprem}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
BUILD_WEB="${BUILD_WEB:-1}"
BUILD_BACKEND="${BUILD_BACKEND:-1}"
WINDOWS_NATIVE_QA_V2="${WINDOWS_NATIVE_QA_V2:-0}"
PACKAGE_PREFIX="${PACKAGE_PREFIX:-metasheet-attendance-onprem}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)}"
PACKAGE_TAG="${PACKAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="${PACKAGE_PREFIX}-v${PACKAGE_VERSION}-${PACKAGE_TAG}"
BUILD_ROOT="${OUTPUT_DIR}/.build/${PACKAGE_NAME}"
PACKAGE_ROOT="${BUILD_ROOT}/${PACKAGE_NAME}"
ARCHIVE_TGZ_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.tgz"
ARCHIVE_ZIP_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.zip"
CHECKSUM_FILE="${OUTPUT_DIR}/SHA256SUMS"
PACKAGE_RUN_LABEL="${PACKAGE_TAG%%-*}"
SOURCE_SHA="${SOURCE_SHA:-}"
if [[ -z "${SOURCE_SHA}" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "${ROOT_DIR}" rev-parse --verify HEAD >/dev/null 2>&1; then
    SOURCE_SHA="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
  fi
fi
SOURCE_SHA="$(printf '%s' "${SOURCE_SHA}" | tr '[:upper:]' '[:lower:]')"
if [[ ! "${SOURCE_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[attendance-onprem-package-build] ERROR: SOURCE_SHA must be an exact 40-char git SHA (got: ${SOURCE_SHA:-empty})" >&2
  exit 1
fi
QA_TOOLING_SHA="${QA_TOOLING_SHA:-${SOURCE_SHA}}"
QA_TOOLING_SHA="$(printf '%s' "${QA_TOOLING_SHA}" | tr '[:upper:]' '[:lower:]')"
if [[ ! "${QA_TOOLING_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[attendance-onprem-package-build] ERROR: QA_TOOLING_SHA must be an exact 40-char git SHA (got: ${QA_TOOLING_SHA:-empty})" >&2
  exit 1
fi
if [[ "${WINDOWS_NATIVE_QA_V2}" != "0" && "${WINDOWS_NATIVE_QA_V2}" != "1" ]]; then
  echo "[attendance-onprem-package-build] ERROR: WINDOWS_NATIVE_QA_V2 must be 0 or 1" >&2
  exit 1
fi

REQUIRED_PATHS=(
  "apps/web/dist"
  "apps/web/package.json"
  "packages/core-backend/dist"
  "packages/core-backend/package.json"
  "packages/mssql-readonly-utils"
  # The packaged migration runner resolves compiled TS migrations from dist,
  # source SQL migrations from src/db/migrations, and legacy SQL bridge
  # migrations from packages/core-backend/migrations.
  "packages/core-backend/src/db/migrations"
  "packages/core-backend/migrations"
  "plugins/plugin-attendance"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "scripts/ops/attendance-onprem-deploy-easy.sh"
  "scripts/ops/attendance-onprem-start-pm2.ps1"
  "scripts/ops/attendance-onprem-deploy-run.ps1"
  "scripts/ops/multitable-onprem-bootstrap-admin.ps1"
  "scripts/ops/attendance-onprem-bootstrap.sh"
  "scripts/ops/attendance-onprem-bootstrap-admin.sh"
  "scripts/ops/attendance-onprem-env-check.sh"
  "scripts/ops/attendance-onprem-healthcheck.sh"
  "scripts/ops/attendance-onprem-update.sh"
  "scripts/ops/attendance-onprem-publish-web-dist.sh"
  "scripts/ops/attendance-onprem-publish-web-dist.ps1"
  "run-migrate.bat"
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

if [[ "${WINDOWS_NATIVE_QA_V2}" == "1" ]]; then
  REQUIRED_PATHS+=(
    "scripts/ops/attendance-windows-native-common.ps1"
    "scripts/ops/attendance-windows-native-preflight.ps1"
    "scripts/ops/attendance-windows-native-start.ps1"
    "scripts/ops/attendance-windows-native-stop.ps1"
    "scripts/ops/attendance-windows-native-healthcheck.ps1"
    "scripts/ops/attendance-windows-native-bootstrap-admin.ps1"
    "scripts/ops/attendance-windows-native-gateway.mjs"
    "scripts/ops/attendance-windows-native-qa-v2.pin.json"
    "scripts/ops/attendance-windows-native-qa-risk-matrix.json"
    "scripts/ops/attendance-windows-native-qa-runner.mjs"
    # Fix 5 (version-binding): ship the executable QA harnesses IN the ZIP, bound to this package SHA.
    # The runtime artifacts (.runtime/, evidence/, qa-identities.json, summary.json) are stripped after
    # copy so no minted synthetic identities or evidence ever enter the package.
    "scripts/ops/windows-qa"
    "docker/app.env.attendance-windows-native.qa.example"
    "ecosystem.windows-native.config.cjs"
    "docs/deployment/attendance-windows-native-qa-v2-20260804.md"
    "docs/development/attendance-windows-native-qa-v2-verification-20260804.md"
  )
fi

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

function build_web_dist() {
  local env_dir
  env_dir="$(mktemp -d)"
  trap 'rm -rf "$env_dir"' RETURN
  info "Using isolated env dir for web build: ${env_dir}"
  run env METASHEET_ENV_DIR="$env_dir" pnpm --filter @metasheet/web build
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
  cat > "${PACKAGE_ROOT}/start-pm2.bat" <<'EOF'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\attendance-onprem-start-pm2.ps1" -RootDir "%~dp0."
exit /b %ERRORLEVEL%
EOF

  cat > "${PACKAGE_ROOT}/start-pm2-remote.bat" <<'EOF'
@echo off
setlocal
if not exist "%~dp0output\logs" mkdir "%~dp0output\logs"
call "%~dp0start-pm2.bat" >> "%~dp0output\logs\start-pm2-remote.log" 2>&1
exit /b %ERRORLEVEL%
EOF

  if [[ "${WINDOWS_NATIVE_QA_V2}" == "1" ]]; then
    cat > "${PACKAGE_ROOT}/windows-native-preflight.bat" <<'EOF'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\attendance-windows-native-preflight.ps1" -RootDir "%~dp0."
exit /b %ERRORLEVEL%
EOF

    cat > "${PACKAGE_ROOT}/windows-native-start.bat" <<'EOF'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\attendance-windows-native-start.ps1" -RootDir "%~dp0."
exit /b %ERRORLEVEL%
EOF

    cat > "${PACKAGE_ROOT}/windows-native-stop.bat" <<'EOF'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\attendance-windows-native-stop.ps1" -RootDir "%~dp0."
exit /b %ERRORLEVEL%
EOF

    cat > "${PACKAGE_ROOT}/windows-native-healthcheck.bat" <<'EOF'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\attendance-windows-native-healthcheck.ps1" -RootDir "%~dp0."
exit /b %ERRORLEVEL%
EOF

    cat > "${PACKAGE_ROOT}/windows-native-bootstrap-admin.bat" <<'EOF'
@echo off
setlocal
if "%~1"=="" (
  echo Usage: windows-native-bootstrap-admin.bat ^<admin-email^> ^<admin-password^> [admin-name]
  exit /b 2
)
if "%~2"=="" (
  echo Usage: windows-native-bootstrap-admin.bat ^<admin-email^> ^<admin-password^> [admin-name]
  exit /b 2
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\attendance-windows-native-bootstrap-admin.ps1" -RootDir "%~dp0." -AdminEmail "%~1" -AdminPassword "%~2" -AdminName "%~3"
exit /b %ERRORLEVEL%
EOF
  fi

  cat > "${PACKAGE_ROOT}/deploy-${PACKAGE_RUN_LABEL}.bat" <<EOF
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\ops\\attendance-onprem-deploy-run.ps1" -RootDir "%~dp0." -RunLabel "${PACKAGE_RUN_LABEL}"
exit /b %ERRORLEVEL%
EOF
}

function write_onprem_workspace_manifest() {
  cat > "${PACKAGE_ROOT}/pnpm-workspace.yaml" <<'EOF'
packages:
  - 'packages/*'
  - 'plugins/*'
EOF
}

if [[ "$INSTALL_DEPS" == "1" ]]; then
  run pnpm install --frozen-lockfile
fi

if [[ "$BUILD_WEB" == "1" ]]; then
  build_web_dist
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

if [[ "${WINDOWS_NATIVE_QA_V2}" == "1" ]]; then
  # Fix 5 (security): the windows-qa tree is copied with `cp -R`, which would also copy any local
  # gitignored runtime artifacts (minted synthetic identities / host evidence). Strip them from the
  # packaged copy so the ZIP ships only the harness code, never runtime secrets.
  qa_pkg_dir="${PACKAGE_ROOT}/scripts/ops/windows-qa"
  # The gitignored runtime dir lives at harness/.runtime (see qa-runtime.mjs DEFAULT_* paths, which
  # write the evidence dir INSIDE .runtime). Remove any `.runtime` dir at any depth (covers it), plus
  # the top-level `evidence/` the .gitignore anchors — but NOT a name match on `evidence` at arbitrary
  # depth, which could silently drop an unrelated tracked directory. Then strip stray identity/evidence
  # files by exact name.
  rm -rf "${qa_pkg_dir}/evidence"
  find "${qa_pkg_dir}" -depth -type d -name '.runtime' -exec rm -rf {} + 2>/dev/null || true
  find "${qa_pkg_dir}" \( -name 'qa-identities.json' -o -name 'summary.json' -o -name '*.evidence.json' \) -delete 2>/dev/null || true
fi

write_onprem_workspace_manifest
write_windows_entrypoints

printf '%s\n' "${SOURCE_SHA}" > "${PACKAGE_ROOT}/SOURCE_SHA"
printf '%s\n' "${QA_TOOLING_SHA}" > "${PACKAGE_ROOT}/QA_TOOLING_SHA"
if [[ "${WINDOWS_NATIVE_QA_V2}" == "1" ]]; then
  cp "${ROOT_DIR}/scripts/ops/attendance-windows-native-qa-v2.pin.json" \
    "${PACKAGE_ROOT}/attendance-windows-native-qa-v2.pin.json"
fi

cat > "${PACKAGE_ROOT}/INSTALL.txt" <<EOF
MetaSheet Attendance On-Prem Package
Version: ${PACKAGE_VERSION}
Tag: ${PACKAGE_TAG}
Exact source SHA: ${SOURCE_SHA}
QA tooling SHA: ${QA_TOOLING_SHA}
EOF

if [[ "${WINDOWS_NATIVE_QA_V2}" == "1" ]]; then
  cat >> "${PACKAGE_ROOT}/INSTALL.txt" <<'EOF'

STATUS: Draft/HOLD — internal synthetic QA preparation only.
This package does NOT authorize deployment, staging soak, customer UAT,
feature-flag enablement, external notifications, or issue closure.

Windows native exact-SHA internal QA v2 (no WSL2):
  docs/deployment/attendance-windows-native-qa-v2-20260804.md
EOF
fi

cat >> "${PACKAGE_ROOT}/INSTALL.txt" <<'EOF'

Install quickstart:
  docs/deployment/attendance-windows-onprem-easy-start-20260306.md

Package layout guide:
  docs/deployment/attendance-onprem-package-layout-20260306.md
EOF

PACKAGE_NAME_JSON="${PACKAGE_NAME}" \
PACKAGE_VERSION_JSON="${PACKAGE_VERSION}" \
PACKAGE_TAG_JSON="${PACKAGE_TAG}" \
SOURCE_SHA_JSON="${SOURCE_SHA}" \
QA_TOOLING_SHA_JSON="${QA_TOOLING_SHA}" \
WINDOWS_NATIVE_QA_V2_JSON="${WINDOWS_NATIVE_QA_V2}" \
ARCHIVE_TGZ_JSON="$(basename "$ARCHIVE_TGZ_PATH")" \
ARCHIVE_ZIP_JSON="$(basename "$ARCHIVE_ZIP_PATH")" \
CHECKSUM_FILE_JSON="$(basename "$CHECKSUM_FILE")" \
node - "${OUTPUT_DIR}/${PACKAGE_NAME}.json" <<'NODE'
const fs = require('node:fs')
const manifest = {
  name: process.env.PACKAGE_NAME_JSON,
  version: process.env.PACKAGE_VERSION_JSON,
  tag: process.env.PACKAGE_TAG_JSON,
  sourceSha: process.env.SOURCE_SHA_JSON,
  qaToolingSha: process.env.QA_TOOLING_SHA_JSON,
  attendanceOnly: true,
  includedPlugins: ['plugin-attendance'],
  archive: process.env.ARCHIVE_TGZ_JSON,
  archiveZip: process.env.ARCHIVE_ZIP_JSON,
  checksumFile: process.env.CHECKSUM_FILE_JSON,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
}
if (process.env.WINDOWS_NATIVE_QA_V2_JSON === '1') {
  manifest.windowsNativeQa = {
    campaign: 'attendance-windows-native-qa-v2-20260804',
    status: 'DRAFT_HOLD',
    deploymentAuthorized: false,
    syntheticDataOnly: true,
  }
}
fs.writeFileSync(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`)
NODE
cp "${OUTPUT_DIR}/${PACKAGE_NAME}.json" "${PACKAGE_ROOT}/${PACKAGE_NAME}.json"

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

info "Package built:"
info "  source_sha: ${SOURCE_SHA}"
info "  qa_tooling_sha: ${QA_TOOLING_SHA}"
info "  archive_tgz: ${ARCHIVE_TGZ_PATH}"
info "  archive_zip: ${ARCHIVE_ZIP_PATH}"
info "  checksum_tgz: ${ARCHIVE_TGZ_PATH}.sha256"
info "  checksum_zip: ${ARCHIVE_ZIP_PATH}.sha256"
info "  index: ${CHECKSUM_FILE}"
if [[ "${WINDOWS_NATIVE_QA_V2}" == "1" ]]; then
  info "  status: Draft/HOLD — no deployment/staging authorization"
fi
