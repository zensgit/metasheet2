#!/usr/bin/env bash
set -euo pipefail

PACKAGE_FILE="${1:-}"
VERIFY_SHA="${VERIFY_SHA:-1}"
VERIFY_NO_GITHUB_LINKS="${VERIFY_NO_GITHUB_LINKS:-1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-}"
cleanup_extract_root=0
list_file=""

function die() {
  echo "[attendance-onprem-package-verify] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-package-verify] $*" >&2
}

function search_fixed_string() {
  local needle="$1"
  shift

  if command -v rg >/dev/null 2>&1; then
    rg --fixed-strings -- "$needle" "$@" >/dev/null 2>&1
    return
  fi

  grep -rIF -- "$needle" "$@" >/dev/null 2>&1
}

function search_extended_regex() {
  local pattern="$1"
  shift

  if command -v rg >/dev/null 2>&1; then
    rg -- "$pattern" "$@" >/dev/null 2>&1
    return
  fi

  grep -rIE -- "$pattern" "$@" >/dev/null 2>&1
}

function verify_windows_entrypoints() {
  local root="$1"
  local start_script="${root}/start-pm2.bat"
  local deploy_script="${root}/deploy-${run_label}.bat"
  local native_entrypoint

  if ! search_fixed_string '-RootDir "%~dp0."' "$start_script"; then
    die "start-pm2.bat must pass -RootDir \"%~dp0.\" to avoid Windows path quoting bugs"
  fi

  if [[ -n "$run_label" ]] && [[ -f "$deploy_script" ]]; then
    if ! search_fixed_string '-RootDir "%~dp0."' "$deploy_script"; then
      die "deploy-${run_label}.bat must pass -RootDir \"%~dp0.\" to avoid Windows path quoting bugs"
    fi
  fi

  for native_entrypoint in \
    "windows-native-preflight.bat" \
    "windows-native-start.bat" \
    "windows-native-stop.bat" \
    "windows-native-healthcheck.bat" \
    "windows-native-bootstrap-admin.bat"
  do
    if ! search_fixed_string '-RootDir "%~dp0."' "${root}/${native_entrypoint}"; then
      die "${native_entrypoint} must pass -RootDir \"%~dp0.\""
    fi
    if search_fixed_string 'wsl.exe' "${root}/${native_entrypoint}"; then
      die "${native_entrypoint} must not invoke WSL"
    fi
  done
}

function verify_workspace_manifest() {
  local root="$1"
  local workspace_file="${root}/pnpm-workspace.yaml"
  [[ -f "$workspace_file" ]] || die "pnpm-workspace.yaml missing from package root"

  grep -q "^  - 'packages/\\*'\$" "$workspace_file" || die "on-prem workspace must include packages/*"
  grep -q "^  - 'plugins/\\*'\$" "$workspace_file" || die "on-prem workspace must include plugins/*"

  if grep -q "^  - 'apps/\\*'\$" "$workspace_file"; then
    die "on-prem workspace must exclude apps/* to avoid reinstalling prebuilt web sources"
  fi

  if grep -q "^  - 'packages/openapi/dist-sdk'\$" "$workspace_file"; then
    die "on-prem workspace must exclude packages/openapi/dist-sdk"
  fi
}

function verify_workspace_runtime_dependencies() {
  local root="$1"
  command -v node >/dev/null 2>&1 || die "node is required to verify packaged workspace runtime dependencies"

  node - "$root" <<'NODE' || die "One or more packaged workspace runtime dependencies are missing"
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
const consumerManifests = [
  'packages/core-backend/package.json',
  'plugins/plugin-attendance/package.json',
]
const packageRoots = ['packages', 'plugins']
const packagedByName = new Map()

for (const packageRoot of packageRoots) {
  const absoluteRoot = path.join(root, packageRoot)
  if (!fs.existsSync(absoluteRoot)) continue

  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(absoluteRoot, entry.name, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest.name) packagedByName.set(manifest.name, { manifest, manifestPath })
  }
}

const failures = []
for (const relativeManifest of consumerManifests) {
  const manifestPath = path.join(root, relativeManifest)
  const consumer = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [dependencyName, version] of Object.entries(consumer[section] || {})) {
      if (!String(version).startsWith('workspace:')) continue
      const packaged = packagedByName.get(dependencyName)
      if (!packaged) {
        failures.push(`${relativeManifest}: missing workspace runtime dependency ${dependencyName}`)
        continue
      }

      for (const entrypointField of ['main', 'module']) {
        const entrypoint = packaged.manifest[entrypointField]
        if (!entrypoint) continue
        const entrypointPath = path.resolve(path.dirname(packaged.manifestPath), entrypoint)
        if (!fs.existsSync(entrypointPath)) {
          failures.push(`${dependencyName}: missing ${entrypointField} entrypoint ${entrypoint}`)
        }
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}
NODE
}

function verify_onprem_env_templates() {
  local root="$1"
  local rel
  for rel in \
    "docker/app.env.attendance-onprem.template" \
    "docker/app.env.attendance-onprem.ready.env"
  do
    local abs="${root}/${rel}"
    grep -q '^JWT_SECRET=change-me$' "$abs" || die "${rel} must retain JWT_SECRET=change-me placeholder"
    grep -q '^BCRYPT_SALT_ROUNDS=12$' "$abs" || die "${rel} must pin BCRYPT_SALT_ROUNDS=12"
  done

  local windows_env="${root}/docker/app.env.attendance-windows-native.qa.example"
  grep -q '^JWT_SECRET=change-me$' "$windows_env" \
    || die "Windows native QA env must retain JWT_SECRET=change-me placeholder"
  grep -q '^ATTENDANCE_IMPORT_UPLOAD_DIR=storage/attendance-import$' "$windows_env" \
    || die "Windows native QA env must use a package-relative upload path"
  grep -q '^WINDOWS_NATIVE_GATEWAY_HOST=127.0.0.1$' "$windows_env" \
    || die "Windows native QA gateway must bind to loopback by default"
  grep -q '^POSTGRES_DB=metasheet_windows_qa$' "$windows_env" \
    || die "Windows native QA package must pin the dedicated database name"
  grep -q '/metasheet_windows_qa$' "$windows_env" \
    || die "Windows native QA DATABASE_URL must target the dedicated database"
}

function verify_windows_native_gateway() {
  local root="$1"
  local gateway="${root}/scripts/ops/attendance-windows-native-gateway.mjs"
  local config="${root}/ecosystem.windows-native.config.cjs"
  local start="${root}/scripts/ops/attendance-windows-native-start.ps1"

  command -v node >/dev/null 2>&1 || die "node is required to verify the Windows native gateway"
  node --check "$gateway" >/dev/null \
    || die "Windows native gateway has invalid JavaScript syntax"
  node --check "$config" >/dev/null \
    || die "Windows native PM2 config has invalid JavaScript syntax"
  search_fixed_string 'metasheet-windows-gateway' "$config" \
    || die "Windows native PM2 config must name the gateway process"
  search_fixed_string 'attendance-windows-native-preflight.ps1' "$start" \
    || die "Windows native start must run preflight before deployment"
  search_fixed_string 'attendance-onprem-deploy-run.ps1' "$start" \
    || die "Windows native start must run migrations and the packaged backend"
  search_fixed_string 'Run windows-native-stop.bat before starting again' "$start" \
    || die "Windows native start must reject ambiguous reuse of existing PM2 apps"
  search_fixed_string 'Remove-WindowsNativePm2Apps' "$start" \
    || die "Windows native start must clean up both package-owned PM2 apps after failure"
  search_fixed_string 'PM2 cleanup failed' \
    "${root}/scripts/ops/attendance-windows-native-common.ps1" \
    || die "Windows native PM2 cleanup must surface delete/save failures"
  search_fixed_string 'multitable-onprem-bootstrap-admin.ps1' \
    "${root}/scripts/ops/attendance-windows-native-bootstrap-admin.ps1" \
    || die "Windows native admin bootstrap must delegate to the existing native PostgreSQL helper"
  search_fixed_string 'Assert-WindowsNativeLoopbackHost' \
    "${root}/scripts/ops/attendance-windows-native-preflight.ps1" \
    || die "Windows native preflight must enforce loopback-only runtime hosts"
  search_fixed_string 'Attendance opt-in is forbidden' \
    "${root}/scripts/ops/attendance-windows-native-preflight.ps1" \
    || die "Windows native preflight must reject attendance rollout opt-ins"
  search_fixed_string 'External integration configuration is forbidden' \
    "${root}/scripts/ops/attendance-windows-native-preflight.ps1" \
    || die "Windows native preflight must reject external integration configuration"
  search_fixed_string 'APPROVAL_BREACH_DINGTALK_' \
    "${root}/scripts/ops/attendance-windows-native-preflight.ps1" \
    || die "Windows native preflight must reject DingTalk breach webhooks"
  search_fixed_string 'ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK' \
    "${root}/scripts/ops/attendance-windows-native-preflight.ps1" \
    || die "Windows native preflight must reject the attendance leader-lock opt-in"
  search_fixed_string 'metasheet_windows_qa' \
    "${root}/scripts/ops/attendance-windows-native-preflight.ps1" \
    || die "Windows native preflight must pin the dedicated local QA database"
  search_fixed_string "headers['x-forwarded-for'] = remoteAddress" "$gateway" \
    || die "Windows native gateway must replace client-supplied forwarding identity"
  search_fixed_string 'gateway host must be loopback' "$gateway" \
    || die "Windows native gateway must enforce a loopback listener"
  local native_dependency
  for native_dependency in \
    "${root}/windows-native-bootstrap-admin.bat" \
    "${root}/scripts/ops/attendance-windows-native-"* \
    "${root}/scripts/ops/attendance-onprem-deploy-run.ps1" \
    "${root}/scripts/ops/attendance-onprem-start-pm2.ps1" \
    "${root}/scripts/ops/attendance-onprem-publish-web-dist.ps1" \
    "${root}/scripts/ops/multitable-onprem-bootstrap-admin.ps1"
  do
    if grep -Eiq 'wsl\.exe|wsl[[:space:]]+-' "$native_dependency"; then
      die "Windows native dependency must not invoke WSL: ${native_dependency#${root}/}"
    fi
  done
}

function verify_web_dist_publish_entrypoints() {
  local root="$1"

  search_fixed_string 'attendance-onprem-publish-web-dist.sh' "${root}/scripts/ops/attendance-onprem-bootstrap.sh" \
    || die "attendance-onprem-bootstrap.sh must publish apps/web/dist to the nginx root"
  search_fixed_string 'attendance-onprem-publish-web-dist.sh' "${root}/scripts/ops/attendance-onprem-update.sh" \
    || die "attendance-onprem-update.sh must publish apps/web/dist to the nginx root"
  search_fixed_string 'attendance-onprem-publish-web-dist.ps1' "${root}/scripts/ops/attendance-onprem-deploy-run.ps1" \
    || die "attendance-onprem-deploy-run.ps1 must publish apps/web/dist to the nginx root"
}

function verify_core_backend_migration_set() {
  local root="$1"
  local provider="${root}/packages/core-backend/dist/src/db/migration-provider.js"
  local dist_dir="${root}/packages/core-backend/dist/src/db/migrations"
  local source_dir="${root}/packages/core-backend/src/db/migrations"
  local legacy_sql_dir="${root}/packages/core-backend/migrations"
  local required_upgrade_migrations=(
    "zzzz20260318123000_formalize_meta_comments"
    "zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions"
  )

  [[ -f "$provider" ]] || die "Required package content missing: packages/core-backend/dist/src/db/migration-provider.js"
  [[ -d "$dist_dir" ]] || die "Required package content missing: packages/core-backend/dist/src/db/migrations"
  [[ -d "$source_dir" ]] || die "Required package content missing: packages/core-backend/src/db/migrations"
  [[ -d "$legacy_sql_dir" ]] || die "Required package content missing: packages/core-backend/migrations"

  search_fixed_string 'MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL' "$provider" \
    || die "migration-provider.js must expose the superseded legacy SQL opt-in"
  search_fixed_string '032_create_approval_records' "$provider" \
    || die "migration-provider.js must carry the superseded legacy SQL skip list"
  search_fixed_string '20250926_create_audit_tables' "$provider" \
    || die "migration-provider.js must no-op the superseded audit SQL on upgraded on-prem databases"

  [[ -f "${source_dir}/20250925_create_view_tables.sql" ]] \
    || die "Source SQL migration missing from package: 20250925_create_view_tables.sql"
  [[ -f "${source_dir}/20250926_create_audit_tables.sql" ]] \
    || die "Source SQL migration missing from package: 20250926_create_audit_tables.sql"
  [[ -f "${legacy_sql_dir}/056_add_users_must_change_password.sql" ]] \
    || die "Legacy SQL migration missing from package: 056_add_users_must_change_password.sql"

  local migration_name
  for migration_name in "${required_upgrade_migrations[@]}"; do
    [[ -f "${source_dir}/${migration_name}.ts" ]] \
      || die "Required upgraded-database migration missing from source set: ${migration_name}.ts"
    [[ -f "${dist_dir}/${migration_name}.js" ]] \
      || die "Required upgraded-database migration missing from dist set: ${migration_name}.js"
  done

  local missing_compiled=""
  local source_file
  while IFS= read -r source_file; do
    migration_name="$(basename "$source_file" .ts)"
    if [[ ! -f "${dist_dir}/${migration_name}.js" ]]; then
      missing_compiled+="${migration_name}"$'\n'
    fi
  done < <(find "$source_dir" -maxdepth 1 -type f -name '*.ts' ! -name '_*' | sort)

  if [[ -n "$missing_compiled" ]]; then
    echo "$missing_compiled" >&2
    die "Package missing compiled JS for one or more core backend TS migrations"
  fi
}

function verify_no_github_links() {
  local root="$1"
  local patterns='github\.com|githubusercontent\.com|github\.io'
  local targets=()

  [[ -f "${root}/INSTALL.txt" ]] && targets+=("${root}/INSTALL.txt")
  [[ -d "${root}/docs/deployment" ]] && targets+=("${root}/docs/deployment")

  if [[ ${#targets[@]} -eq 0 ]]; then
    return 0
  fi

  if command -v rg >/dev/null 2>&1; then
    if rg -n --ignore-case "$patterns" "${targets[@]}" >/tmp/attendance_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/attendance_onprem_link_hits.txt >&2 || true
      rm -f /tmp/attendance_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/attendance_onprem_link_hits.txt || true
  else
    if grep -RInE "$patterns" "${targets[@]}" >/tmp/attendance_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/attendance_onprem_link_hits.txt >&2 || true
      rm -f /tmp/attendance_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/attendance_onprem_link_hits.txt || true
  fi
}

function verify_sha() {
  local archive="$1"
  local dir
  local base
  local checksums_abs
  local line
  dir="$(dirname "$archive")"
  base="$(basename "$archive")"
  checksums_abs="$(cd "$dir" && pwd)/SHA256SUMS"
  [[ -f "$checksums_abs" ]] || die "SHA256SUMS not found next to package: ${checksums_abs}"
  line="$(grep " ${base}\$" "$checksums_abs" || true)"
  [[ -n "$line" ]] || die "Checksum entry missing for ${base} in SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && printf '%s\n' "$line" | sha256sum -c -)
  elif command -v shasum >/dev/null 2>&1; then
    local expected
    local actual
    expected="$(printf '%s\n' "$line" | awk '{print $1}')"
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || die "Checksum mismatch for ${base}"
  else
    die "Missing checksum tool: sha256sum or shasum"
  fi
}

[[ -n "$PACKAGE_FILE" ]] || die "Usage: scripts/ops/attendance-onprem-package-verify.sh <package.tgz|package.zip>"
[[ -f "$PACKAGE_FILE" ]] || die "Package not found: ${PACKAGE_FILE}"

if [[ "$VERIFY_SHA" == "1" ]]; then
  verify_sha "$PACKAGE_FILE"
fi

if [[ -z "$EXTRACT_ROOT" ]]; then
  EXTRACT_ROOT="$(mktemp -d)"
  cleanup_extract_root=1
else
  mkdir -p "$EXTRACT_ROOT"
fi

list_file="$(mktemp)"
cleanup() {
  [[ -n "$list_file" ]] && rm -f "$list_file" || true
  if [[ "$cleanup_extract_root" == "1" ]]; then
    rm -rf "$EXTRACT_ROOT"
  fi
}
trap cleanup EXIT

case "$PACKAGE_FILE" in
  *.tgz|*.tar.gz)
    tar -xzf "$PACKAGE_FILE" -C "$EXTRACT_ROOT"
    tar -tzf "$PACKAGE_FILE" > "$list_file"
    ;;
  *.zip)
    command -v unzip >/dev/null 2>&1 || die "unzip is required to verify zip packages"
    unzip -q "$PACKAGE_FILE" -d "$EXTRACT_ROOT"
    if command -v zipinfo >/dev/null 2>&1; then
      zipinfo -1 "$PACKAGE_FILE" > "$list_file"
    else
      find "$EXTRACT_ROOT" -mindepth 1 -maxdepth 3 -print | sed "s#^${EXTRACT_ROOT}/##" > "$list_file"
    fi
    ;;
  *)
    die "Unsupported package extension (expected .tgz/.tar.gz/.zip): ${PACKAGE_FILE}"
    ;;
esac

pkg_name="$(head -n 1 "$list_file" | cut -d/ -f1)"
pkg_root="${EXTRACT_ROOT}/${pkg_name}"
run_label="$(printf '%s' "$pkg_name" | sed -nE 's/^.*-(run[0-9]+)(-.+)?$/\1/p')"

required=(
  "start-pm2.bat"
  "start-pm2-remote.bat"
  "windows-native-preflight.bat"
  "windows-native-start.bat"
  "windows-native-stop.bat"
  "windows-native-healthcheck.bat"
  "windows-native-bootstrap-admin.bat"
  "apps/web/dist/index.html"
  "apps/web/package.json"
  "packages/core-backend/dist/src/index.js"
  "packages/core-backend/dist/src/db/migrate.js"
  "packages/core-backend/dist/src/db/migration-provider.js"
  "packages/core-backend/package.json"
  "packages/core-backend/src/db/migrations/20250925_create_view_tables.sql"
  "packages/core-backend/src/db/migrations/20250926_create_audit_tables.sql"
  "packages/core-backend/src/db/migrations/zzzz20260318123000_formalize_meta_comments.ts"
  "packages/core-backend/src/db/migrations/zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions.ts"
  "packages/core-backend/dist/src/db/migrations/zzzz20260318123000_formalize_meta_comments.js"
  "packages/core-backend/dist/src/db/migrations/zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions.js"
  "packages/core-backend/migrations/056_add_users_must_change_password.sql"
  "plugins/plugin-attendance/plugin.json"
  "plugins/plugin-attendance/index.cjs"
  "scripts/ops/attendance-onprem-start-pm2.ps1"
  "scripts/ops/attendance-onprem-deploy-run.ps1"
  "scripts/ops/attendance-windows-native-common.ps1"
  "scripts/ops/attendance-windows-native-preflight.ps1"
  "scripts/ops/attendance-windows-native-start.ps1"
  "scripts/ops/attendance-windows-native-stop.ps1"
  "scripts/ops/attendance-windows-native-healthcheck.ps1"
  "scripts/ops/attendance-windows-native-bootstrap-admin.ps1"
  "scripts/ops/attendance-windows-native-gateway.mjs"
  "scripts/ops/multitable-onprem-bootstrap-admin.ps1"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "scripts/ops/attendance-onprem-publish-web-dist.sh"
  "scripts/ops/attendance-onprem-publish-web-dist.ps1"
  "run-migrate.bat"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "docker/app.env.example"
  "docker/app.env.attendance-onprem.template"
  "docker/app.env.attendance-onprem.ready.env"
  "docker/app.env.attendance-windows-native.qa.example"
  "ecosystem.windows-native.config.cjs"
  "ops/nginx/attendance-onprem.conf.example"
  "docs/deployment/attendance-windows-onprem-easy-start-20260306.md"
  "docs/deployment/attendance-windows-wsl-onprem-20260306.md"
  "docs/deployment/attendance-windows-wsl-direct-commands-20260306.md"
  "docs/deployment/attendance-windows-wsl-customer-profiled-commands-20260306.md"
  "docs/deployment/attendance-windows-native-qa-20260727.md"
)

for rel in "${required[@]}"; do
  [[ -e "${pkg_root}/${rel}" ]] || die "Required package content missing: ${rel}"
done

if [[ -n "$run_label" ]]; then
  [[ -e "${pkg_root}/deploy-${run_label}.bat" ]] || die "Required package content missing: deploy-${run_label}.bat"
fi

verify_windows_entrypoints "$pkg_root"

if [[ -d "${pkg_root}/plugins" ]]; then
  extra_plugins="$({
    find "${pkg_root}/plugins" -mindepth 1 -maxdepth 1 -type d -exec basename {} \;
  } | grep -v '^plugin-attendance$' || true)"
  if [[ -n "$extra_plugins" ]]; then
    echo "$extra_plugins" >&2
    die "Attendance on-prem package must only include plugin-attendance under plugins/"
  fi
fi

if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
  verify_no_github_links "$pkg_root"
fi

verify_onprem_env_templates "$pkg_root"
verify_workspace_manifest "$pkg_root"
verify_workspace_runtime_dependencies "$pkg_root"
verify_web_dist_publish_entrypoints "$pkg_root"
verify_windows_native_gateway "$pkg_root"
verify_core_backend_migration_set "$pkg_root"

if search_extended_regex 'VITE_API_(URL|BASE):"http://(127\.0\.0\.1|localhost)' "${pkg_root}/apps/web/dist"; then
  die "Frontend bundle embeds loopback VITE_API_* config; rebuild package with isolated web env"
fi

info "Package verify OK"
info "  package: ${PACKAGE_FILE}"
info "  root: ${pkg_root}"
