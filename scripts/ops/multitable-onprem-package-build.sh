#!/usr/bin/env bash
set -euo pipefail

export COPYFILE_DISABLE=1

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
BOOTSTRAP_PS1_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}-deploy-bootstrap.ps1"
BOOTSTRAP_BAT_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}-deploy-bootstrap.bat"
BOOTSTRAP_PS1_TMP_PATH="${TMP_OUTPUT_DIR}/${PACKAGE_NAME}-deploy-bootstrap.ps1"
BOOTSTRAP_BAT_TMP_PATH="${TMP_OUTPUT_DIR}/${PACKAGE_NAME}-deploy-bootstrap.bat"
BOOTSTRAP_PS1_SHA_TMP_PATH="${BOOTSTRAP_PS1_TMP_PATH}.sha256"
BOOTSTRAP_BAT_SHA_TMP_PATH="${BOOTSTRAP_BAT_TMP_PATH}.sha256"
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
  "packages/core-backend/scripts/smoke-sqlserver.ts"
  "packages/mssql-readonly-utils"
  # The packaged migration runner loads SQL migrations from
  # packages/core-backend/migrations via migration-provider.ts. Keep this
  # source directory in the package so Windows/on-prem installs apply
  # post-build SQL schema changes such as users.must_change_password.
  "packages/core-backend/migrations"
  "plugins/plugin-attendance"
  "plugins/plugin-integration-core"
  "scripts/ops/attendance-onprem-bootstrap.sh"
  "scripts/ops/attendance-onprem-bootstrap-admin.sh"
  "scripts/ops/attendance-onprem-env-check.sh"
  "scripts/ops/attendance-onprem-update.sh"
  "scripts/ops/attendance-onprem-deploy-easy.sh"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "scripts/ops/attendance-onprem-healthcheck.sh"
  "scripts/ops/attendance-onprem-start-pm2.ps1"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "scripts/ops/multitable-onprem-bootstrap-admin.ps1"
  "scripts/ops/multitable-onprem-deploy-easy.sh"
  "scripts/ops/multitable-onprem-apply-package.sh"
  "scripts/ops/multitable-onprem-apply-package.ps1"
  "scripts/ops/multitable-onprem-deploy-launcher.ps1"
  "scripts/ops/multitable-onprem-package-install.sh"
  "scripts/ops/multitable-onprem-package-upgrade.sh"
  "scripts/ops/multitable-onprem-healthcheck.sh"
  # K3 WISE PoC operator tooling — preflight (C1/C2), live PoC packet builder
  # (C3), evidence compiler (C10), delivery readiness compiler, postdeploy
  # smoke + summary, the #1542 metadata seed helper, mock fixtures, and the
  # K3 operator runbooks.
  # The package also ships
  # plugins/plugin-integration-core above so the backend registers
  # /api/integration/* routes and the offline mock chain can resolve its
  # adapter imports from the package root.
  "scripts/ops/integration-k3wise-onprem-preflight.mjs"
  "scripts/ops/integration-k3wise-live-poc-preflight.mjs"
  "scripts/ops/integration-k3wise-live-poc-evidence.mjs"
  "scripts/ops/integration-k3wise-delivery-readiness.mjs"
  "scripts/ops/integration-k3wise-postdeploy-smoke.mjs"
  "scripts/ops/integration-issue1542-seed-workbench-systems.mjs"
  "scripts/ops/integration-k3wise-postdeploy-summary.mjs"
  "scripts/ops/integration-k3wise-gate-contract-check.mjs"
  "scripts/ops/fixtures/integration-k3wise"
  # Legacy SQL readonly Bridge Agent tooling. BA-M0.5 proves the approved
  # Windows SQL driver can connect with SELECT @@VERSION only. BA-M1 then
  # exposes a localhost-only, readonly, allowlisted HTTP bridge for operator
  # validation before MetaSheet runtime integration begins.
  "scripts/ops/bridge-agent-driver-smoke.ps1"
  "scripts/ops/fixtures/bridge-agent-driver-smoke"
  "scripts/ops/bridge-agent-readonly.ps1"
  "scripts/ops/bridge-agent-readonly-scheduled-task.ps1"
  "scripts/ops/fixtures/bridge-agent-readonly"
  "docs/operations/k3-poc-onprem-preflight-runbook.md"
  "docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md"
  "docs/operations/integration-k3wise-internal-trial-runbook.md"
  "docs/operations/integration-k3wise-live-gate-execution-package.md"
  "docs/operations/integration-k3wise-material-only-process-control-plane-20260527.md"
  "docs/operations/integration-k3wise-sql-executor-bridge-handoff.md"
  "docs/operations/data-source-system-integration-c5-k3-mssql-smoke-runbook-20260615.md"
  "docs/operations/bridge-agent-driver-smoke-runbook-20260520.md"
  "docs/operations/bridge-agent-readonly-runbook-20260521.md"
  "docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md"
  "docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md"
  "docs/development/k3wise-bridge-machine-codex-handoff-20260513.md"
  "docs/development/data-factory-workbench-todo-20260514.md"
  "docs/development/data-factory-workbench-development-20260514.md"
  "docs/development/data-factory-workbench-verification-20260514.md"
  "docs/development/data-factory-cleansed-export-development-20260514.md"
  "docs/development/data-factory-cleansed-export-verification-20260514.md"
  "docs/development/data-factory-postdeploy-smoke-development-20260514.md"
  "docs/development/data-factory-postdeploy-smoke-verification-20260514.md"
  "docs/development/data-factory-adapter-discovery-postdeploy-development-20260514.md"
  "docs/development/data-factory-adapter-discovery-postdeploy-verification-20260514.md"
  "docs/development/data-factory-postdeploy-summary-adapter-details-development-20260514.md"
  "docs/development/data-factory-postdeploy-summary-adapter-details-verification-20260514.md"
  "docs/development/data-factory-issue1542-postdeploy-smoke-design-20260515.md"
  "docs/development/data-factory-issue1542-postdeploy-smoke-verification-20260515.md"
  "docs/development/data-factory-issue1542-seed-workbench-systems-development-20260515.md"
  "docs/development/data-factory-issue1542-seed-workbench-systems-verification-20260515.md"
  "docs/development/data-factory-issue1542-install-smoke-development-20260515.md"
  "docs/development/data-factory-issue1542-install-smoke-verification-20260515.md"
  "docs/development/data-factory-sql-executor-diagnostic-development-20260515.md"
  "docs/development/data-factory-sql-executor-diagnostic-verification-20260515.md"
  "docs/development/data-factory-sql-executor-bridge-handoff-development-20260515.md"
  "docs/development/data-factory-sql-executor-bridge-handoff-verification-20260515.md"
  "docs/development/data-factory-delivery-readiness-evidence-gates-development-20260515.md"
  "docs/development/data-factory-delivery-readiness-evidence-gates-verification-20260515.md"
  "docs/development/data-factory-issue1526-gate-contract-check-design-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-check-verification-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-template-init-design-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-template-init-verification-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-install-entry-design-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-install-entry-verification-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-package-verify-design-20260518.md"
  "docs/development/data-factory-issue1526-gate-contract-package-verify-verification-20260518.md"
  "docs/development/integration-k3wise-material-only-gate-checker-design-20260526.md"
  "docs/development/integration-k3wise-material-only-gate-checker-verification-20260526.md"
  "docs/development/data-factory-issue1526-delivery-readiness-gate-contract-design-20260518.md"
  "docs/development/data-factory-issue1526-delivery-readiness-gate-contract-verification-20260518.md"
  "docs/development/data-factory-sqlserver-readonly-executor-design-20260519.md"
  "docs/development/data-factory-sqlserver-readonly-executor-verification-20260519.md"
  "docs/development/onprem-package-dependency-refresh-design-20260519.md"
  "docs/development/onprem-package-dependency-refresh-verification-20260519.md"
  "docs/development/onprem-package-dependency-refresh-diagnostics-design-20260519.md"
  "docs/development/onprem-package-dependency-refresh-diagnostics-verification-20260519.md"
  "docs/development/onprem-package-dependency-refresh-wrapper-design-20260519.md"
  "docs/development/onprem-package-dependency-refresh-wrapper-verification-20260519.md"
  "docs/development/data-factory-issue1526-wrapper-sql-followup-design-20260519.md"
  "docs/development/data-factory-issue1526-wrapper-sql-followup-verification-20260519.md"
  "docs/development/bridge-agent-source-refresh-staging-design-20260522.md"
  "docs/development/bridge-agent-source-refresh-staging-verification-20260522.md"
  "docs/development/metasheet-multitable-target-fieldid-map-design-20260522.md"
  "docs/development/metasheet-multitable-target-fieldid-map-verification-20260522.md"
  "docs/development/data-factory-readiness-package-verify-delivery-development-20260515.md"
  "docs/development/data-factory-readiness-package-verify-delivery-verification-20260515.md"
  "docs/development/onprem-migration-gap-guard-development-20260514.md"
  "docs/development/onprem-migration-gap-guard-verification-20260514.md"
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
    prune_node_modules "$dst"
  else
    cp "$src" "$dst"
  fi
}

function prune_node_modules() {
  local root="$1"
  [[ -e "$root" ]] || return 0
  # On-prem packages intentionally refresh dependencies on apply. Bundling
  # pnpm node_modules symlinks makes Windows extraction/copy fail on staged
  # paths before the dependency refresh can run.
  while IFS= read -r -d '' path; do
    rm -rf "$path"
  done < <(find "$root" -name node_modules -prune -print0)
}

function assert_no_macos_metadata_entries() {
  local archive="$1"
  local archive_type="$2"
  local label="$3"
  local matches
  case "$archive_type" in
    tgz)
      matches="$(tar -tzf "$archive" | LC_ALL=C grep -E '(^|/)(\._[^/]+|__MACOSX)(/|$)' | head -20 || true)"
      ;;
    zip)
      if command -v zipinfo >/dev/null 2>&1; then
        matches="$(zipinfo -1 "$archive" | LC_ALL=C grep -E '(^|/)(\._[^/]+|__MACOSX)(/|$)' | head -20 || true)"
      elif command -v unzip >/dev/null 2>&1; then
        matches="$(unzip -Z -1 "$archive" | LC_ALL=C grep -E '(^|/)(\._[^/]+|__MACOSX)(/|$)' | head -20 || true)"
      else
        die "zipinfo or unzip is required to inspect zip package entries"
      fi
      ;;
    *)
      die "Unknown archive type for macOS metadata check: ${archive_type}"
      ;;
  esac
  if [[ -n "$matches" ]]; then
    die "${label} must not contain macOS AppleDouble/resource-fork metadata entries. First entries: ${matches//$'\n'/, }"
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
REM Call the self-bootstrapping launcher so the FIRST apply on an upgrade uses
REM the freshest apply helper from inside the supplied package, not the stale
REM helper sitting in the installed root. The launcher extracts to a staging
REM temp dir, locates the staged apply helper, and invokes it with this
REM installed root as -RootDir. See multitable-onprem-deploy-launcher.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\multitable-onprem-deploy-launcher.ps1" -RootDir "%~dp0." -PackageArchive "%~1"
set "APPLY_EXIT=%ERRORLEVEL%"
echo [multitable-onprem-deploy] apply exit=%APPLY_EXIT%
exit /b %APPLY_EXIT%
EOF

  # deploy-remote.bat is what Windows scheduled tasks typically call.
  # Previous versions fired deploy.bat in the background via `start ""`
  # and exited 0 immediately, so the scheduled-task Last Result never
  # reflected the actual apply outcome. #1526 follow-up makes it
  # synchronous: invoke deploy.bat in-process, redirect stdout/stderr to
  # deploy-remote.log, capture ERRORLEVEL, append "apply exit=N" to the
  # log AND to stdout, and propagate the captured code as the wrapper's
  # exit.
  cat > "${PACKAGE_ROOT}/deploy-remote.bat" <<'EOF'
@echo off
setlocal
if "%~1"=="" (
  echo Usage: deploy-remote.bat ^<package.zip^|package.tgz^>
  exit /b 64
)
if not exist "%~dp0output\logs" mkdir "%~dp0output\logs"
call "%~dp0deploy.bat" "%~1" >> "%~dp0output\logs\deploy-remote.log" 2>&1
set "APPLY_EXIT=%ERRORLEVEL%"
>> "%~dp0output\logs\deploy-remote.log" echo [multitable-onprem-deploy-remote] apply exit=%APPLY_EXIT%
echo [multitable-onprem-deploy-remote] apply exit=%APPLY_EXIT%. See output\logs\deploy-remote.log
exit /b %APPLY_EXIT%
EOF

  cat > "${PACKAGE_ROOT}/deploy-${PACKAGE_RUN_LABEL}.bat" <<'EOF'
@echo off
setlocal
call "%~dp0deploy.bat" "%~1"
set "APPLY_EXIT=%ERRORLEVEL%"
echo [multitable-onprem-deploy-label] apply exit=%APPLY_EXIT%
exit /b %APPLY_EXIT%
EOF

  cat > "${PACKAGE_ROOT}/bootstrap-admin.bat" <<'EOF'
@echo off
setlocal
if "%~1"=="" (
  echo Usage: bootstrap-admin.bat ^<admin-email^> ^<admin-password^> [admin-name]
  exit /b 64
)
if "%~2"=="" (
  echo Usage: bootstrap-admin.bat ^<admin-email^> ^<admin-password^> [admin-name]
  exit /b 64
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ops\multitable-onprem-bootstrap-admin.ps1" -RootDir "%~dp0." -AdminEmail "%~1" -AdminPassword "%~2" -AdminName "%~3"
exit /b %ERRORLEVEL%
EOF

  cat > "${PACKAGE_ROOT}/bootstrap-admin-${PACKAGE_RUN_LABEL}.bat" <<'EOF'
@echo off
setlocal
call "%~dp0bootstrap-admin.bat" "%~1" "%~2" "%~3"
exit /b %ERRORLEVEL%
EOF
}

function write_windows_first_hop_bootstrap_assets() {
  cp "${ROOT_DIR}/scripts/ops/multitable-onprem-deploy-launcher.ps1" "$BOOTSTRAP_PS1_TMP_PATH"

  cat > "$BOOTSTRAP_BAT_TMP_PATH" <<EOF
@echo off
setlocal
if "%~1"=="" (
  echo Usage: ${PACKAGE_NAME}-deploy-bootstrap.bat ^<package.zip^|package.tgz^> [installed-root]
  exit /b 64
)
set "INSTALL_ROOT=%~2"
if "%INSTALL_ROOT%"=="" set "INSTALL_ROOT=%cd%"
REM First-hop bootstrap sidecar. Use this from a release download when the
REM already-installed deploy.bat/launcher is too old to stage the new package
REM under C:\ms-tmp. It intentionally bypasses the installed launcher and runs
REM the fresh launcher sidecar next to this .bat file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${PACKAGE_NAME}-deploy-bootstrap.ps1" -RootDir "%INSTALL_ROOT%" -PackageArchive "%~1"
set "APPLY_EXIT=%ERRORLEVEL%"
echo [multitable-onprem-deploy-bootstrap] apply exit=%APPLY_EXIT%
exit /b %APPLY_EXIT%
EOF
}

function write_deployment_guides() {
  cat > "${PACKAGE_ROOT}/DEPLOYMENT.txt" <<EOF
MetaSheet Multitable On-Prem Deployable Package
Version: ${PACKAGE_VERSION}
Tag: ${PACKAGE_TAG}

What this archive is:
  This is a deployable on-prem application package. It contains the built
  frontend bundle, built backend dist, migrations, packaged plugins, deploy
  scripts, environment templates, nginx/systemd examples, and operator docs.

Why it looks like a source tree:
  The runtime uses workspace-relative paths, so the archive intentionally keeps
  directories such as apps/web/dist, packages/core-backend/dist, plugins,
  scripts, docker, ops, and docs. That layout does not mean this is a
  source-only archive.

What this archive is not:
  It is not a single binary.
  It is not a node_modules snapshot.
  It is not meant to be applied by hand-copying only selected source folders.
  It is not direct-replace-safe for a running installation without the apply
  helper or documented install flow.

Fresh install:
  Extract the archive into a new deploy root, create docker/app.env from the
  template, then follow:
    docs/deployment/multitable-windows-onprem-easy-start-20260319.md

Upgrade / corrective reroll:
  Copy the downloaded package archive to the target host. From the existing
  deploy root, run:
    deploy.bat <downloaded-package.zip>

  Windows deploy defaults staging to C:\ms-tmp when no override is supplied, so
  .zip and .tgz applies avoid deep %TEMP% / MAX_PATH failures by default. You
  can still pin a different short local root before running deploy.bat:
    mkdir C:\ms-tmp 2>NUL
    set "METASHEET_ONPREM_STAGING_ROOT=C:\ms-tmp"
    deploy.bat <downloaded-package.zip>

  Or run the PowerShell helper directly:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\multitable-onprem-apply-package.ps1 -RootDir . -PackageArchive <downloaded-package.zip> -StagingRoot C:\ms-tmp

Dependency policy:
  node_modules are intentionally not bundled. The apply helper defaults to
  InstallDeps=1 and refreshes dependencies with pnpm install --frozen-lockfile
  on every package apply. This is deliberate for corrective rerolls: an
  existing deploy root may already have node_modules while the new package adds
  a workspace runtime dependency. Manual deployments must run the same command
  before migrations, PM2 restart, or admin bootstrap.

Verification:
  A valid delivery asset passes:
    scripts/ops/multitable-onprem-package-verify.sh <package.zip|package.tgz>
EOF

  cat > "${PACKAGE_ROOT}/PACKAGE-METADATA.json" <<EOF
{
  "name": "${PACKAGE_NAME}",
  "version": "${PACKAGE_VERSION}",
  "tag": "${PACKAGE_TAG}",
  "artifactKind": "deployable-onprem-app-package",
  "deployMode": "fresh-extract-or-existing-root-apply",
  "directReplaceSafe": false,
  "nodeModulesBundled": false,
  "dependencyInstallMode": "refresh-on-apply",
  "windowsEntryPoint": "deploy.bat <package.zip|package.tgz>",
  "windowsFirstHopBootstrap": "release sidecar: ${PACKAGE_NAME}-deploy-bootstrap.ps1",
  "windowsFirstHopBootstrapWrapper": "release sidecar: ${PACKAGE_NAME}-deploy-bootstrap.bat",
  "windowsStagingRootEnv": "METASHEET_ONPREM_STAGING_ROOT",
  "windowsDefaultStagingRoot": "C:\\\\ms-tmp",
  "linuxEntryPoint": "scripts/ops/multitable-onprem-package-install.sh",
  "includedRuntimeRoots": [
    "apps/web/dist",
    "packages/core-backend/dist",
    "packages/core-backend/migrations",
    "packages/mssql-readonly-utils",
    "plugins",
    "scripts/ops",
    "docker",
    "ops",
    "docs"
  ]
}
EOF
}

function write_build_provenance() {
  # Build-time source provenance + #1912 fix-marker attestation. The verify flow
  # (multitable-onprem-package-verify.sh) requires this file, asserts a real
  # 40-hex gitCommit, and cross-checks the issue1912 marker against the packaged
  # adapter. Helpers only — no customer runtime is touched here.
  local git_commit git_commit_short git_ref on_main marker_file marker_str embedded
  git_commit="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)}"
  if [[ "$git_commit" =~ ^[0-9a-f]{40}$ ]]; then
    git_commit_short="${git_commit:0:12}"
  else
    git_commit="unknown"
    git_commit_short="unknown"
  fi
  git_ref="${GITHUB_REF_NAME:-$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
  # Soft provenance signal: is the build commit reachable on origin/main? Never fail
  # (offline/disconnected builds are legitimate) — just record it for the reviewer.
  on_main="unknown"
  if [[ "$git_commit" != "unknown" ]] && git -C "$ROOT_DIR" rev-parse --verify -q origin/main >/dev/null 2>&1; then
    if git -C "$ROOT_DIR" merge-base --is-ancestor "$git_commit" origin/main 2>/dev/null; then
      on_main="true"
    else
      on_main="false"
      info "WARNING: build commit ${git_commit_short} is not on origin/main; package provenance is local-only"
    fi
  fi
  # Compute the #1912 marker presence from the STAGED adapter (the exact file about
  # to be packaged) — not a hardcoded literal — so the verify cross-check is real.
  marker_file="${PACKAGE_ROOT}/plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs"
  marker_str="material-k3wise-customer-profile-v1"
  if [[ -f "$marker_file" ]] && grep -qF -- "$marker_str" "$marker_file"; then
    embedded="true"
  else
    embedded="false"
  fi
  cat > "${PACKAGE_ROOT}/BUILD_PROVENANCE.json" <<EOF
{
  "schema": "metasheet-onprem-build-provenance/v1",
  "packageName": "${PACKAGE_NAME}",
  "version": "${PACKAGE_VERSION}",
  "tag": "${PACKAGE_TAG}",
  "gitCommit": "${git_commit}",
  "gitCommitShort": "${git_commit_short}",
  "gitRef": "${git_ref}",
  "sourceIsOnOriginMain": "${on_main}",
  "ciRunId": "${GITHUB_RUN_ID:-local}",
  "ciRunAttempt": "${GITHUB_RUN_ATTEMPT:-local}",
  "builtAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "fixMarkers": {
    "issue1912": {
      "title": "K3 WISE M1 Material Save-only backend fix",
      "adapter": "plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs",
      "marker": "${marker_str}",
      "embedded": ${embedded}
    }
  }
}
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
prune_node_modules "$PACKAGE_ROOT"

stamp_packaged_version "package.json"
stamp_packaged_version "packages/core-backend/package.json"
write_windows_entrypoints
write_deployment_guides
write_build_provenance

cat > "${PACKAGE_ROOT}/INSTALL.txt" <<EOF
MetaSheet Multitable On-Prem Package
Version: ${PACKAGE_VERSION}
Tag: ${PACKAGE_TAG}

Artifact type:
  deployable-onprem-app-package

Read first:
  DEPLOYMENT.txt

Important:
  This archive is a deployable on-prem package, not a source-only archive.
  It intentionally preserves workspace-style runtime paths because the backend,
  frontend, plugins, migrations, and ops scripts are resolved from those
  locations. Do not hand-copy selected directories into a running installation.
  For upgrades, run deploy.bat <package.zip|package.tgz> from the existing
  deploy root, or use scripts/ops/multitable-onprem-apply-package.ps1.

Install quickstart:
  docs/deployment/multitable-windows-onprem-easy-start-20260319.md

Package layout guide:
  docs/deployment/multitable-onprem-package-layout-20260319.md

Server-side apply helpers:
  deploy.bat <package.zip|package.tgz>
  deploy-remote.bat <package.zip|package.tgz>
  deploy-${PACKAGE_RUN_LABEL}.bat <package.zip|package.tgz>
  bootstrap-admin.bat <admin-email> <admin-password> [admin-name]
  bootstrap-admin-${PACKAGE_RUN_LABEL}.bat <admin-email> <admin-password> [admin-name]

deploy.bat now calls scripts/ops/multitable-onprem-deploy-launcher.ps1 first,
which extracts the supplied package to a staging temp dir and invokes the
apply helper *from inside the new package*. This avoids the prior
"first apply uses the stale installed helper" issue on upgrades.

First-hop bootstrap sidecar:
  If an existing Windows install still has an old deploy.bat / launcher that
  fails before the new package can take over, download the release sidecar
  ${PACKAGE_NAME}-deploy-bootstrap.ps1 (or the .bat wrapper) next to the package
  archive and run it from the existing install root:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\${PACKAGE_NAME}-deploy-bootstrap.ps1 -RootDir . -PackageArchive .\${PACKAGE_NAME}.zip
  The sidecar uses the current launcher logic immediately, defaults staging to
  C:\ms-tmp on Windows, and invokes the staged package's fresh apply helper.

K3 WISE PoC operator tools (Node only; no Docker needed to run these):
  Runtime plugin:
    plugins/plugin-integration-core
      -> registers /api/integration/* routes used by the K3 WISE setup page.
  node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --out-dir <art>
    -> deployment readiness preflight (env / Postgres / migrations / fixtures).
       Add --live --gate-file <gate.json> once the customer GATE answers arrive.
  node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input <gate.json> --out-dir <packet-dir>
    -> builds the Save-only live PoC packet from the GATE answer JSON.
  node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <safe-dir>
    -> creates a fillable O1-O6/R1-R7 GATE contract packet,
       README-CUSTOMER-HANDOFF.zh.md, and 8 redacted sample skeletons outside
       Git. Fill the generated directory with customer evidence before running
       the checker below.
  node scripts/ops/integration-k3wise-gate-contract-check.mjs --input <contract.json> --out-dir <art>
    -> verifies O1-O6 and R1-R7 customer evidence before WebAPI read/list or
       relationship runtime work starts.
  node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet <packet.json> --evidence <evidence.json>
    -> compiles the live PoC evidence into a PASS / PARTIAL / FAIL signoff.
  Runbooks:
    docs/operations/k3-poc-onprem-preflight-runbook.md           (per-check fix recipes)
    docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md (deploy-to-live handoff checklist)
    docs/operations/integration-k3wise-internal-trial-runbook.md  (post-deploy auth smoke)
    docs/operations/integration-k3wise-live-gate-execution-package.md (C0-C10 sequence + customer GATE fields)
    docs/operations/data-source-system-integration-c5-k3-mssql-smoke-runbook-20260615.md (C5 generic/K3 SQL Server smoke)

Legacy SQL readonly Bridge Agent tools (Windows bridge host only):
  powershell -ExecutionPolicy Bypass -File scripts\ops\bridge-agent-driver-smoke.ps1 ...
    -> BA-M0.5 driver smoke, runs connection.Open() and SELECT @@VERSION only.
  powershell -ExecutionPolicy Bypass -File scripts\ops\bridge-agent-readonly.ps1 -ConfigPath <local-config>
    -> BA-M1 localhost-only readonly bridge for allowlisted SQL views.
  powershell -ExecutionPolicy Bypass -File scripts\ops\bridge-agent-readonly-scheduled-task.ps1 -Action Install -StartAfterInstall
    -> persistent Windows Scheduled Task launcher for the readonly bridge.
  Runbooks:
    docs/operations/bridge-agent-driver-smoke-runbook-20260520.md
    docs/operations/bridge-agent-readonly-runbook-20260521.md

Runtime dependencies:
  node_modules are intentionally not bundled. deploy.bat defaults to
  InstallDeps=1 and refreshes dependencies with pnpm install --frozen-lockfile
  on every package apply. This prevents upgrade roots with existing
  node_modules from missing newly added workspace runtime dependencies. If
  applying files manually without deploy.bat, run pnpm install --frozen-lockfile
  from the package root before migrations/bootstrap.

Windows staging root:
  The Windows helpers default staging to C:\ms-tmp when no override is supplied.
  If you need a different short local directory, set METASHEET_ONPREM_STAGING_ROOT
  before running deploy.bat:
    mkdir C:\ms-tmp 2>NUL
    set "METASHEET_ONPREM_STAGING_ROOT=C:\ms-tmp"
    deploy.bat <downloaded-package.zip>
EOF

run rm -f "$ARCHIVE_TGZ_TMP_PATH" "$ARCHIVE_ZIP_TMP_PATH" "$ARCHIVE_TGZ_SHA_TMP_PATH" "$ARCHIVE_ZIP_SHA_TMP_PATH" "$BOOTSTRAP_PS1_TMP_PATH" "$BOOTSTRAP_BAT_TMP_PATH" "$BOOTSTRAP_PS1_SHA_TMP_PATH" "$BOOTSTRAP_BAT_SHA_TMP_PATH" "$METADATA_JSON_TMP_PATH"
write_windows_first_hop_bootstrap_assets
find "$PACKAGE_ROOT" \( -name '._*' -o -name '__MACOSX' \) -prune -exec rm -rf {} +
run env COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE_TGZ_TMP_PATH" -C "$BUILD_ROOT" "$PACKAGE_NAME"
run bash -lc "cd \"$BUILD_ROOT\" && COPYFILE_DISABLE=1 zip -X -qr \"$ARCHIVE_ZIP_TMP_PATH\" \"$PACKAGE_NAME\""
assert_no_macos_metadata_entries "$ARCHIVE_TGZ_TMP_PATH" tgz "tgz package"
assert_no_macos_metadata_entries "$ARCHIVE_ZIP_TMP_PATH" zip "zip package"
write_sha_file "$ARCHIVE_TGZ_TMP_PATH"
write_sha_file "$ARCHIVE_ZIP_TMP_PATH"
write_sha_file "$BOOTSTRAP_PS1_TMP_PATH"
write_sha_file "$BOOTSTRAP_BAT_TMP_PATH"

checksum_tmp="$(mktemp)"
if [[ -f "$CHECKSUM_FILE" ]]; then
  awk \
    -v tgz="${PACKAGE_NAME}.tgz" \
    -v zip="${PACKAGE_NAME}.zip" \
    -v ps1="${PACKAGE_NAME}-deploy-bootstrap.ps1" \
    -v bat="${PACKAGE_NAME}-deploy-bootstrap.bat" \
    '$2 != tgz && $2 != zip && $2 != ps1 && $2 != bat { print }' \
    "$CHECKSUM_FILE" > "$checksum_tmp"
else
  : > "$checksum_tmp"
fi
add_checksum_entry "$ARCHIVE_TGZ_TMP_PATH" >> "$checksum_tmp"
add_checksum_entry "$ARCHIVE_ZIP_TMP_PATH" >> "$checksum_tmp"
add_checksum_entry "$BOOTSTRAP_PS1_TMP_PATH" >> "$checksum_tmp"
add_checksum_entry "$BOOTSTRAP_BAT_TMP_PATH" >> "$checksum_tmp"

cat > "${METADATA_JSON_TMP_PATH}" <<EOF
{
  "name": "${PACKAGE_NAME}",
  "version": "${PACKAGE_VERSION}",
  "tag": "${PACKAGE_TAG}",
  "artifactKind": "deployable-onprem-app-package",
  "deployMode": "fresh-extract-or-existing-root-apply",
  "directReplaceSafe": false,
  "nodeModulesBundled": false,
  "windowsEntryPoint": "deploy.bat <package.zip|package.tgz>",
  "windowsFirstHopBootstrap": "$(basename "$BOOTSTRAP_PS1_PATH")",
  "windowsFirstHopBootstrapWrapper": "$(basename "$BOOTSTRAP_BAT_PATH")",
  "windowsStagingRootEnv": "METASHEET_ONPREM_STAGING_ROOT",
  "windowsDefaultStagingRoot": "C:\\\\ms-tmp",
  "attendanceOnly": false,
  "productMode": "platform",
  "includedPlugins": ["plugin-attendance", "plugin-integration-core"],
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
mv "$BOOTSTRAP_PS1_TMP_PATH" "$BOOTSTRAP_PS1_PATH"
mv "$BOOTSTRAP_BAT_TMP_PATH" "$BOOTSTRAP_BAT_PATH"
mv "$BOOTSTRAP_PS1_SHA_TMP_PATH" "${BOOTSTRAP_PS1_PATH}.sha256"
mv "$BOOTSTRAP_BAT_SHA_TMP_PATH" "${BOOTSTRAP_BAT_PATH}.sha256"
mv "$checksum_tmp" "$CHECKSUM_FILE"
checksum_tmp=""
mv "${METADATA_JSON_TMP_PATH}" "${METADATA_JSON_PATH}"
rm -rf "$TMP_OUTPUT_DIR"

info "Package built:"
info "  archive_tgz: ${ARCHIVE_TGZ_PATH}"
info "  archive_zip: ${ARCHIVE_ZIP_PATH}"
info "  checksum_tgz: ${ARCHIVE_TGZ_PATH}.sha256"
info "  checksum_zip: ${ARCHIVE_ZIP_PATH}.sha256"
info "  bootstrap_ps1: ${BOOTSTRAP_PS1_PATH}"
info "  bootstrap_bat: ${BOOTSTRAP_BAT_PATH}"
info "  checksum_bootstrap_ps1: ${BOOTSTRAP_PS1_PATH}.sha256"
info "  checksum_bootstrap_bat: ${BOOTSTRAP_BAT_PATH}.sha256"
info "  index: ${CHECKSUM_FILE}"
info "  metadata_json: ${METADATA_JSON_PATH}"
