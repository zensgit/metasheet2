#!/usr/bin/env bash
set -euo pipefail

PACKAGE_FILE="${1:-}"
VERIFY_SHA="${VERIFY_SHA:-1}"
VERIFY_NO_GITHUB_LINKS="${VERIFY_NO_GITHUB_LINKS:-1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-}"
VERIFY_REPORT_JSON="${VERIFY_REPORT_JSON:-}"
VERIFY_REPORT_MD="${VERIFY_REPORT_MD:-}"
cleanup_extract_root=0
list_file=""
pkg_name=""
pkg_root=""
archive_type="unknown"

function die() {
  echo "[multitable-onprem-package-verify] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[multitable-onprem-package-verify] $*" >&2
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

function verify_windows_entrypoints() {
  local root="$1"
  local start_script="${root}/deploy.bat"
  local remote_script="${root}/deploy-remote.bat"
  local bootstrap_script="${root}/bootstrap-admin.bat"

  if ! search_fixed_string 'multitable-onprem-apply-package.ps1' "$start_script"; then
    die "deploy.bat must call the PowerShell-native multitable apply helper"
  fi

  if search_fixed_string 'multitable-onprem-apply-package.sh' "$start_script"; then
    die "deploy.bat must not require bash or the .sh apply helper"
  fi

  if ! search_fixed_string 'deploy-remote.log' "$remote_script"; then
    die "deploy-remote.bat must continue writing output\\logs\\deploy-remote.log"
  fi

  if [[ -n "$deploy_run_wrapper" ]] && ! search_fixed_string 'call "%~dp0deploy.bat" "%~1"' "$deploy_run_wrapper"; then
    die "$(basename "$deploy_run_wrapper") must delegate to deploy.bat"
  fi

  if ! search_fixed_string 'multitable-onprem-bootstrap-admin.ps1' "$bootstrap_script"; then
    die "bootstrap-admin.bat must call the PowerShell-native multitable bootstrap helper"
  fi

  if [[ -n "$bootstrap_run_wrapper" ]] && ! search_fixed_string 'call "%~dp0bootstrap-admin.bat" "%~1" "%~2" "%~3"' "$bootstrap_run_wrapper"; then
    die "$(basename "$bootstrap_run_wrapper") must delegate to bootstrap-admin.bat"
  fi
}

function verify_root_runtime_dependencies() {
  local root="$1"
  local package_json="${root}/package.json"

  search_fixed_string '"bcryptjs"' "$package_json" || die "root package.json must include bcryptjs for Windows bootstrap compatibility"
}

function verify_migration_bridge_contract() {
  local root="$1"
  local provider="${root}/packages/core-backend/dist/src/db/migration-provider.js"
  local legacy_must_change="${root}/packages/core-backend/migrations/056_add_users_must_change_password.sql"
  local timestamp_must_change="${root}/packages/core-backend/dist/src/db/migrations/zzzz20260512100000_add_users_must_change_password.js"

  search_fixed_string 'MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL' "$provider" || die "migration-provider.js must expose the superseded legacy SQL opt-in"
  search_fixed_string '032_create_approval_records' "$provider" || die "migration-provider.js must carry the superseded legacy SQL skip list"
  search_fixed_string '037_add_gallery_form_support' "$provider" || die "migration-provider.js must no-op superseded gallery/form SQL on upgraded on-prem DBs"
  search_fixed_string '038_config_and_secrets' "$provider" || die "migration-provider.js must no-op superseded config/secrets SQL on upgraded on-prem DBs"
  search_fixed_string "to_regclass('public.users') IS NOT NULL" "$legacy_must_change" || die "056_add_users_must_change_password.sql must no-op when users table is absent"
  search_fixed_string 'must_change_password' "$timestamp_must_change" || die "timestamp users must_change_password bridge migration must be packaged"
}

function verify_generic_integration_workbench_contract() {
  local root="$1"
  local web_dist="${root}/apps/web/dist"
  local easy_start="${root}/docs/deployment/multitable-windows-onprem-easy-start-20260319.md"
  local k3_runbook="${root}/docs/operations/integration-k3wise-internal-trial-runbook.md"
  local sql_executor_handoff="${root}/docs/operations/integration-k3wise-sql-executor-bridge-handoff.md"
  local bridge_codex_handoff="${root}/docs/development/k3wise-bridge-machine-codex-handoff-20260513.md"
  local postdeploy_smoke="${root}/scripts/ops/integration-k3wise-postdeploy-smoke.mjs"
  local issue1542_seed="${root}/scripts/ops/integration-issue1542-seed-workbench-systems.mjs"
  local postdeploy_summary="${root}/scripts/ops/integration-k3wise-postdeploy-summary.mjs"

  search_fixed_string '/integrations/workbench' "$web_dist" || die "web dist must include the Data Factory route"
  search_fixed_string '/integrations/k3-wise' "$web_dist" || die "web dist must include the K3 WISE setup route"
  search_fixed_string '数据工厂' "$web_dist" || die "web dist must include Data Factory navigation/page copy"
  search_fixed_string '打开多维表' "$web_dist" || die "web dist must include staging multitable open-link copy"
  search_fixed_string '导出清洗结果' "$web_dist" || die "web dist must include cleansed export copy"
  search_fixed_string '发布 API 数据服务暂不开放' "$web_dist" || die "web dist must include data-service placeholder copy"
  search_fixed_string 'dictMap' "$web_dist" || die "web dist must include the workbench dictionary mapping editor"
  search_fixed_string 'Save-only' "$web_dist" || die "web dist must keep Save-only execution copy"
  search_fixed_string '/integrations/workbench' "$easy_start" || die "Windows on-prem guide must document the Data Factory route"
  search_fixed_string '/integrations/k3-wise' "$easy_start" || die "Windows on-prem guide must document the K3 WISE setup route"
  search_fixed_string 'SQL Server is an advanced channel' "$k3_runbook" || die "K3 runbook must document SQL Server as an advanced channel"
  search_fixed_string 'SQLSERVER_EXECUTOR_MISSING' "$k3_runbook" || die "K3 runbook must document the SQL executor missing disposition"
  search_fixed_string 'integration-k3wise-sql-executor-bridge-handoff.md' "$k3_runbook" || die "K3 runbook must link the SQL executor bridge handoff"
  search_fixed_string 'createK3WiseSqlServerChannelFactory({ queryExecutor })' "$sql_executor_handoff" || die "SQL executor handoff must document the injection point"
  search_fixed_string 'testConnection' "$sql_executor_handoff" || die "SQL executor handoff must document testConnection"
  search_fixed_string 'select({' "$sql_executor_handoff" || die "SQL executor handoff must document select"
  search_fixed_string 'insertMany({' "$sql_executor_handoff" || die "SQL executor handoff must document insertMany"
  search_fixed_string 'SQLSERVER_EXECUTOR_MISSING' "$sql_executor_handoff" || die "SQL executor handoff must document missing-executor behavior"
  search_fixed_string 'SQL Server executor handoff' "$bridge_codex_handoff" || die "Bridge Codex handoff must document SQL executor handoff"
  search_fixed_string 'queryExecutor.testConnection' "$bridge_codex_handoff" || die "Bridge Codex handoff must document queryExecutor.testConnection"
  search_fixed_string 'queryExecutor.select' "$bridge_codex_handoff" || die "Bridge Codex handoff must document queryExecutor.select"
  search_fixed_string 'queryExecutor.insertMany' "$bridge_codex_handoff" || die "Bridge Codex handoff must document queryExecutor.insertMany"
  search_fixed_string 'data-factory-frontend-route' "$postdeploy_smoke" || die "postdeploy smoke must check the Data Factory frontend route"
  search_fixed_string 'data-factory-adapter-discovery' "$postdeploy_smoke" || die "postdeploy smoke must check Data Factory adapter discovery"
  search_fixed_string 'sqlserver-executor-availability' "$postdeploy_smoke" || die "postdeploy smoke must report SQL executor availability"
  search_fixed_string '--issue1542-workbench-smoke' "$postdeploy_smoke" || die "postdeploy smoke must include Data Factory issue #1542 workbench retest flag"
  search_fixed_string '--issue1542-install-staging' "$postdeploy_smoke" || die "postdeploy smoke must include Data Factory issue #1542 install-staging retest flag"
  search_fixed_string '--issue1542-workbench-smoke' "$k3_runbook" || die "K3 runbook must document the Data Factory issue #1542 workbench retest"
  search_fixed_string '--issue1542-install-staging' "$k3_runbook" || die "K3 runbook must document the Data Factory issue #1542 install-staging retest"
  search_fixed_string 'integration-issue1542-seed-workbench-systems.mjs' "$k3_runbook" || die "K3 runbook must document the issue #1542 metadata seed helper"
  search_fixed_string 'metasheet:staging' "$issue1542_seed" || die "issue #1542 seed helper must create the staging source system"
  search_fixed_string 'erp:k3-wise-webapi' "$issue1542_seed" || die "issue #1542 seed helper must create the K3 target system"
  search_fixed_string 'invalidAdapters' "$postdeploy_summary" || die "postdeploy summary must render Data Factory adapter drift details"
}

function write_optional_report() {
  local checksum_status="SKIPPED"
  local link_status="SKIPPED"
  local extract_mode="temporary"
  local extract_root_json="null"
  local report_json_tmp=""
  local report_md_tmp=""

  if [[ "$VERIFY_SHA" == "1" ]]; then
    checksum_status="PASS"
  fi
  if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
    link_status="PASS"
  fi
  if [[ "$cleanup_extract_root" == "0" ]]; then
    extract_mode="preserved"
    extract_root_json="\"${pkg_root}\""
  fi

  if [[ -n "$VERIFY_REPORT_JSON" ]]; then
    mkdir -p "$(dirname "$VERIFY_REPORT_JSON")"
    report_json_tmp="${VERIFY_REPORT_JSON}.tmp.$$"
    printf '%s\n' \
      '{' \
      '  "ok": true,' \
      "  \"packageFile\": \"${PACKAGE_FILE}\"," \
      "  \"packageName\": \"${pkg_name}\"," \
      "  \"archiveType\": \"${archive_type}\"," \
      "  \"packageRootInArchive\": \"${pkg_name}\"," \
      "  \"extractMode\": \"${extract_mode}\"," \
      "  \"extractRoot\": ${extract_root_json}," \
      '  "checks": [' \
      '    {' \
      '      "name": "checksum",' \
      "      \"status\": \"${checksum_status}\"" \
      '    },' \
      '    {' \
      '      "name": "required-content",' \
      '      "status": "PASS",' \
      "      \"requiredCount\": ${#required[@]}" \
      '    },' \
      '    {' \
      '      "name": "no-github-links",' \
      "      \"status\": \"${link_status}\"" \
      '    }' \
      '  ],' \
      "  \"generatedAt\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"" \
      '}' \
      > "$report_json_tmp"
    mv "$report_json_tmp" "$VERIFY_REPORT_JSON"
  fi

  if [[ -n "$VERIFY_REPORT_MD" ]]; then
    mkdir -p "$(dirname "$VERIFY_REPORT_MD")"
    report_md_tmp="${VERIFY_REPORT_MD}.tmp.$$"
    {
      echo "# Multitable On-Prem Package Verify"
      echo
      echo "- Overall: **PASS**"
      echo "- Package: \`${PACKAGE_FILE}\`"
      echo "- Package root in archive: \`${pkg_name}\`"
      echo "- Archive type: \`${archive_type}\`"
      echo "- Extract mode: \`${extract_mode}\`"
      if [[ "$cleanup_extract_root" == "0" ]]; then
        echo "- Extract root: \`${pkg_root}\`"
      fi
      echo
      echo "## Checks"
      echo
      echo "- Checksum: \`${checksum_status}\`"
      echo "- Required content: \`PASS\` (${#required[@]} paths)"
      echo "- No GitHub links in delivery docs: \`${link_status}\`"
    } > "$report_md_tmp"
    mv "$report_md_tmp" "$VERIFY_REPORT_MD"
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
    if rg -n --ignore-case "$patterns" "${targets[@]}" >/tmp/multitable_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/multitable_onprem_link_hits.txt >&2 || true
      rm -f /tmp/multitable_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/multitable_onprem_link_hits.txt || true
  else
    if grep -RInE "$patterns" "${targets[@]}" >/tmp/multitable_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/multitable_onprem_link_hits.txt >&2 || true
      rm -f /tmp/multitable_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/multitable_onprem_link_hits.txt || true
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

[[ -n "$PACKAGE_FILE" ]] || die "Usage: scripts/ops/multitable-onprem-package-verify.sh <package.tgz|package.zip>"
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
    archive_type="tgz"
    tar -xzf "$PACKAGE_FILE" -C "$EXTRACT_ROOT"
    tar -tzf "$PACKAGE_FILE" > "$list_file"
    ;;
  *.zip)
    archive_type="zip"
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

required=(
  "apps/web/dist/index.html"
  "apps/web/package.json"
  "packages/core-backend/dist/src/index.js"
  "packages/core-backend/dist/src/db/migrate.js"
  "packages/core-backend/dist/src/db/migration-provider.js"
  "packages/core-backend/dist/src/db/migrations/zzzz20260512100000_add_users_must_change_password.js"
  "packages/core-backend/package.json"
  "packages/core-backend/migrations/056_add_users_must_change_password.sql"
  "packages/core-backend/migrations/057_create_integration_core_tables.sql"
  "packages/core-backend/migrations/058_integration_runs_running_unique.sql"
  "packages/core-backend/migrations/059_integration_runs_history_index.sql"
  "bootstrap-admin.bat"
  "deploy.bat"
  "deploy-remote.bat"
  "plugins/plugin-attendance/plugin.json"
  "plugins/plugin-attendance/index.cjs"
  "plugins/plugin-integration-core/plugin.json"
  "plugins/plugin-integration-core/index.cjs"
  "plugins/plugin-integration-core/lib/http-routes.cjs"
  "plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs"
  "plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs"
  "plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs"
  "scripts/ops/integration-k3wise-onprem-preflight.mjs"
  "scripts/ops/integration-k3wise-live-poc-preflight.mjs"
  "scripts/ops/integration-k3wise-live-poc-evidence.mjs"
  "scripts/ops/integration-k3wise-postdeploy-smoke.mjs"
  "scripts/ops/integration-issue1542-seed-workbench-systems.mjs"
  "scripts/ops/integration-k3wise-postdeploy-summary.mjs"
  "scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs"
  "scripts/ops/multitable-onprem-bootstrap-admin.ps1"
  "scripts/ops/multitable-onprem-apply-package.sh"
  "scripts/ops/multitable-onprem-apply-package.ps1"
  "scripts/ops/multitable-onprem-package-install.sh"
  "scripts/ops/multitable-onprem-package-upgrade.sh"
  "scripts/ops/multitable-onprem-deploy-easy.sh"
  "scripts/ops/multitable-onprem-healthcheck.sh"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "docker/app.env.example"
  "docker/app.env.multitable-onprem.template"
  "ops/nginx/multitable-onprem.conf.example"
  "docs/operations/k3-poc-onprem-preflight-runbook.md"
  "docs/operations/integration-k3wise-internal-trial-runbook.md"
  "docs/operations/integration-k3wise-live-gate-execution-package.md"
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
  "docs/development/onprem-migration-gap-guard-development-20260514.md"
  "docs/development/onprem-migration-gap-guard-verification-20260514.md"
  "docs/deployment/multitable-platform-rc-notes-20260404.md"
  "docs/deployment/multitable-windows-onprem-easy-start-20260319.md"
  "docs/deployment/multitable-onprem-package-layout-20260319.md"
)

for rel in "${required[@]}"; do
  [[ -e "${pkg_root}/${rel}" ]] || die "Required package content missing: ${rel}"
done

deploy_run_wrapper="$(find "$pkg_root" -maxdepth 1 -type f -name 'deploy-*.bat' ! -name 'deploy.bat' ! -name 'deploy-remote.bat' | head -n 1)"
[[ -n "$deploy_run_wrapper" ]] || die "Required package content missing: deploy-<run>.bat"
bootstrap_run_wrapper="$(find "$pkg_root" -maxdepth 1 -type f -name 'bootstrap-admin-*.bat' | head -n 1)"
[[ -n "$bootstrap_run_wrapper" ]] || die "Required package content missing: bootstrap-admin-<run>.bat"
verify_windows_entrypoints "$pkg_root"
verify_root_runtime_dependencies "$pkg_root"
verify_migration_bridge_contract "$pkg_root"
verify_generic_integration_workbench_contract "$pkg_root"

if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
  verify_no_github_links "$pkg_root"
fi

write_optional_report

info "Package verify OK"
info "  package: ${PACKAGE_FILE}"
info "  root: ${pkg_root}"
if [[ -n "$VERIFY_REPORT_JSON" ]]; then
  info "  verify_report_json: ${VERIFY_REPORT_JSON}"
fi
if [[ -n "$VERIFY_REPORT_MD" ]]; then
  info "  verify_report_md: ${VERIFY_REPORT_MD}"
fi
