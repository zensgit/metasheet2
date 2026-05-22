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

  if ! search_fixed_string 'multitable-onprem-deploy-launcher.ps1' "$start_script"; then
    die "deploy.bat must call the self-bootstrapping PowerShell launcher (multitable-onprem-deploy-launcher.ps1) so first apply on an upgrade uses the freshest apply helper from the supplied package"
  fi

  if search_fixed_string 'multitable-onprem-apply-package.sh' "$start_script"; then
    die "deploy.bat must not require bash or the .sh apply helper"
  fi

  if search_fixed_string 'multitable-onprem-apply-package.ps1' "$start_script"; then
    die "deploy.bat must not call the apply helper directly; it must go through the launcher so a stale installed apply helper cannot win on first apply"
  fi

  # #1526 follow-up (2026-05-20): deploy.bat must capture the launcher's
  # ERRORLEVEL into APPLY_EXIT, emit a parseable `apply exit=N` marker,
  # and propagate the captured code as its own exit. Otherwise a stale
  # %ERRORLEVEL% leak elsewhere in the call chain could leave the outer
  # scheduled-task Last Result as 1 when apply itself returned 0.
  search_fixed_string 'set "APPLY_EXIT=%ERRORLEVEL%"' "$start_script" || die "deploy.bat must capture the launcher exit code into APPLY_EXIT"
  search_fixed_string '[multitable-onprem-deploy] apply exit=%APPLY_EXIT%' "$start_script" || die "deploy.bat must echo a parseable apply exit marker"
  search_fixed_string 'exit /b %APPLY_EXIT%' "$start_script" || die "deploy.bat must propagate the captured APPLY_EXIT as its own exit code"

  local launcher_helper="${root}/scripts/ops/multitable-onprem-deploy-launcher.ps1"
  if [[ ! -f "$launcher_helper" ]]; then
    die "PowerShell launcher script must be packaged for deploy.bat self-bootstrap"
  fi
  search_fixed_string '[multitable-onprem-deploy-launcher]' "$launcher_helper" || die "launcher must self-identify in its logs"
  search_fixed_string 'Expand-StagingArchive' "$launcher_helper" || die "launcher must extract the supplied package into a staging directory before invoking the apply helper"
  search_fixed_string 'Resolve-StagedPackageRoot' "$launcher_helper" || die "launcher must resolve the staged package root before invoking the apply helper"
  search_fixed_string 'multitable-onprem-apply-package.ps1' "$launcher_helper" || die "launcher must invoke the staged apply helper from inside the extracted package"
  search_fixed_string 'Remove-Item -LiteralPath $stage' "$launcher_helper" || die "launcher must clean up staging extraction on exit"
  # #1526 follow-up (2026-05-20): launcher must use the apply.ps1
  # throw/no-throw contract (not $LASTEXITCODE, which leaks from external
  # subprograms apply invoked) and must emit a parseable `apply exit=N`
  # marker so deploy-remote.log / scheduled-task stdout carry an
  # unambiguous inner-most exit signal.
  search_fixed_string 'apply exit=' "$launcher_helper" || die "launcher must emit a parseable apply exit marker before exiting"
  if search_fixed_string 'if ($null -ne $LASTEXITCODE) {' "$launcher_helper"; then
    die "launcher must not derive its exit from \$LASTEXITCODE (it leaks from apply's external sub-programs); use the try/catch throw/no-throw contract instead"
  fi

  local apply_helper="${root}/scripts/ops/multitable-onprem-apply-package.ps1"
  search_fixed_string 'Refresh dependencies (cmd.exe /c pnpm install --frozen-lockfile)' "$apply_helper" || die "PowerShell apply helper must refresh dependencies on package apply through cmd.exe"
  search_fixed_string 'DependencyRefreshTimeoutSec' "$apply_helper" || die "PowerShell apply helper must expose dependency refresh timeout"
  search_fixed_string 'DependencyRefreshHeartbeatSec' "$apply_helper" || die "PowerShell apply helper must expose dependency refresh heartbeat"
  search_fixed_string 'dependency-refresh-' "$apply_helper" || die "PowerShell apply helper must write dependency refresh stdout/stderr logs"
  search_fixed_string 'pnpm path:' "$apply_helper" || die "PowerShell apply helper must log pnpm path before dependency refresh"
  search_fixed_string 'pnpm version:' "$apply_helper" || die "PowerShell apply helper must log pnpm version before dependency refresh"
  search_fixed_string 'Resolve-PnpmInstallCommand' "$apply_helper" || die "PowerShell apply helper must resolve a dedicated pnpm install command"
  search_fixed_string 'pnpm.cmd' "$apply_helper" || die "PowerShell apply helper must prefer pnpm.cmd for Windows scheduled-task install"
  search_fixed_string 'cmd.exe' "$apply_helper" || die "PowerShell apply helper must run dependency refresh through cmd.exe"
  search_fixed_string 'dependency-refresh-wrapper' "$apply_helper" || die "PowerShell apply helper must generate a dependency refresh command wrapper"
  search_fixed_string 'CI=true' "$apply_helper" || die "PowerShell apply helper must force dependency refresh into non-interactive CI mode"
  search_fixed_string 'PNPM_CONFIG_CONFIRM_MODULES_PURGE=false' "$apply_helper" || die "PowerShell apply helper must disable pnpm module purge confirmation"
  search_fixed_string '--reporter=append-only' "$apply_helper" || die "PowerShell apply helper must use append-only pnpm reporter for deploy logs"
  search_fixed_string '--store-dir' "$apply_helper" || die "PowerShell apply helper must pin a deploy-local pnpm store"
  search_fixed_string '.pnpm-store' "$apply_helper" || die "PowerShell apply helper must create a deploy-local pnpm store"
  search_fixed_string 'config get registry' "$apply_helper" || die "PowerShell apply helper must log pnpm registry diagnostics"
  search_fixed_string 'config get store-dir' "$apply_helper" || die "PowerShell apply helper must log pnpm store diagnostics"
  search_fixed_string 'taskkill.exe' "$apply_helper" || die "PowerShell apply helper must kill the dependency refresh process tree on timeout"
  search_fixed_string 'still running after' "$apply_helper" || die "PowerShell apply helper must emit dependency refresh heartbeat progress"
  search_fixed_string 'timed out after' "$apply_helper" || die "PowerShell apply helper must fail dependency refresh with a timeout"
  search_fixed_string 'Get-DependencyRefreshExitCodeFromLog' "$apply_helper" || die "PowerShell apply helper must recover the wrapper exit marker when Start-Process exit code is blank"
  search_fixed_string 'WaitForExit()' "$apply_helper" || die "PowerShell apply helper must wait for process exit before reading ExitCode"
  if search_fixed_string "-not (Test-Path -LiteralPath (Join-Path \$resolvedRoot 'node_modules'))" "$apply_helper"; then
    die "PowerShell apply helper must not skip dependency refresh just because root node_modules already exists"
  fi
  # #1526 follow-up (2026-05-20): apply.ps1 must load the env file before
  # migration/restart so node migrate.js inherits DATABASE_URL / JWT_SECRET.
  # Without these markers an older apply.ps1 would silently regress to the
  # pre-fix state where official Windows apply died with "DATABASE_URL not set".
  search_fixed_string 'Import-AppEnvFile' "$apply_helper" || die "PowerShell apply helper must define Import-AppEnvFile to load the deploy env file before migration (#1526 migration env loading)"
  search_fixed_string 'Loaded env from' "$apply_helper" || die "PowerShell apply helper must invoke env loading and log the source path before migration (#1526 migration env loading)"

  if ! search_fixed_string 'deploy-remote.log' "$remote_script"; then
    die "deploy-remote.bat must continue writing output\\logs\\deploy-remote.log"
  fi

  # #1526 follow-up (2026-05-20): deploy-remote.bat is what Windows
  # scheduled tasks call. Previously it fired deploy.bat in the
  # background via `start ""` and exited 0 - so the scheduled-task
  # Last Result was always 0, regardless of whether apply succeeded
  # or failed (and the apply log never carried a final exit marker).
  # The wrapper must now be SYNCHRONOUS, capture ERRORLEVEL, append
  # `apply exit=N` to deploy-remote.log AND to stdout, and propagate.
  if search_fixed_string 'start "" /min cmd /c' "$remote_script"; then
    die "deploy-remote.bat must not fire deploy.bat as a background `start \"\"` process; it must invoke deploy.bat synchronously so the captured apply exit can become the wrapper's exit code"
  fi
  search_fixed_string 'call "%~dp0deploy.bat" "%~1" >> "%~dp0output\logs\deploy-remote.log" 2>&1' "$remote_script" || die "deploy-remote.bat must invoke deploy.bat synchronously and redirect stdout/stderr into deploy-remote.log"
  search_fixed_string 'set "APPLY_EXIT=%ERRORLEVEL%"' "$remote_script" || die "deploy-remote.bat must capture deploy.bat's ERRORLEVEL into APPLY_EXIT"
  search_fixed_string '[multitable-onprem-deploy-remote] apply exit=%APPLY_EXIT%' "$remote_script" || die "deploy-remote.bat must emit a parseable apply exit marker to deploy-remote.log and stdout"
  search_fixed_string 'exit /b %APPLY_EXIT%' "$remote_script" || die "deploy-remote.bat must propagate the captured APPLY_EXIT as its own exit code so the outer scheduled-task Last Result matches the apply outcome"

  if [[ -n "$deploy_run_wrapper" ]] && ! search_fixed_string 'call "%~dp0deploy.bat" "%~1"' "$deploy_run_wrapper"; then
    die "$(basename "$deploy_run_wrapper") must delegate to deploy.bat"
  fi
  if [[ -n "$deploy_run_wrapper" ]]; then
    search_fixed_string 'set "APPLY_EXIT=%ERRORLEVEL%"' "$deploy_run_wrapper" || die "$(basename "$deploy_run_wrapper") must capture deploy.bat's ERRORLEVEL into APPLY_EXIT"
    search_fixed_string '[multitable-onprem-deploy-label] apply exit=%APPLY_EXIT%' "$deploy_run_wrapper" || die "$(basename "$deploy_run_wrapper") must echo a parseable apply exit marker"
    search_fixed_string 'exit /b %APPLY_EXIT%' "$deploy_run_wrapper" || die "$(basename "$deploy_run_wrapper") must propagate APPLY_EXIT"
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

function verify_integration_plugin_runtime_dependencies() {
  local root="$1"
  local plugin_package_json="${root}/plugins/plugin-integration-core/package.json"
  local sql_executor="${root}/plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs"
  local plugin_entry="${root}/plugins/plugin-integration-core/index.cjs"

  search_fixed_string '"mssql"' "$plugin_package_json" || die "plugin-integration-core package.json must include mssql for the built-in SQL Server read executor"
  search_fixed_string 'createK3WiseSqlServerReadOnlyExecutor' "$sql_executor" || die "SQL Server read-only executor must be packaged"
  search_fixed_string 'SELECT TOP' "$sql_executor" || die "SQL Server executor must build bounded read-only SELECT statements"
  search_fixed_string 'SQLSERVER_WRITE_EXECUTOR_DISABLED' "$sql_executor" || die "SQL Server executor must keep built-in writes disabled"
  search_fixed_string 'createK3WiseSqlServerChannelFactory({ queryExecutor: sqlServerQueryExecutor })' "$plugin_entry" || die "plugin runtime must inject the built-in SQL Server query executor"
}

function verify_deployable_artifact_contract() {
  local root="$1"
  local deployment_txt="${root}/DEPLOYMENT.txt"
  local install_txt="${root}/INSTALL.txt"
  local metadata_json="${root}/PACKAGE-METADATA.json"

  search_fixed_string 'deployable on-prem application package' "$deployment_txt" || die "DEPLOYMENT.txt must say the archive is deployable"
  search_fixed_string 'source-only archive' "$deployment_txt" || die "DEPLOYMENT.txt must explain that the workspace layout is not source-only"
  search_fixed_string 'not direct-replace-safe' "$deployment_txt" || die "DEPLOYMENT.txt must warn against direct replacement of a running install"
  search_fixed_string 'deploy.bat <downloaded-package.zip>' "$deployment_txt" || die "DEPLOYMENT.txt must show the Windows upgrade entrypoint"
  search_fixed_string 'node_modules are intentionally not bundled' "$deployment_txt" || die "DEPLOYMENT.txt must document node_modules policy"

  search_fixed_string 'DEPLOYMENT.txt' "$install_txt" || die "INSTALL.txt must point operators at DEPLOYMENT.txt"
  search_fixed_string 'deployable-onprem-app-package' "$install_txt" || die "INSTALL.txt must identify the artifact type"
  search_fixed_string 'not a source-only archive' "$install_txt" || die "INSTALL.txt must distinguish deployable package from source-only archive"

  search_fixed_string '"artifactKind": "deployable-onprem-app-package"' "$metadata_json" || die "PACKAGE-METADATA.json must identify deployable artifact kind"
  search_fixed_string '"deployMode": "fresh-extract-or-existing-root-apply"' "$metadata_json" || die "PACKAGE-METADATA.json must document deploy mode"
  search_fixed_string '"directReplaceSafe": false' "$metadata_json" || die "PACKAGE-METADATA.json must mark direct replacement unsafe"
  search_fixed_string '"nodeModulesBundled": false' "$metadata_json" || die "PACKAGE-METADATA.json must document node_modules policy"
  search_fixed_string '"dependencyInstallMode": "refresh-on-apply"' "$metadata_json" || die "PACKAGE-METADATA.json must document dependency refresh policy"
  search_fixed_string '"windowsEntryPoint": "deploy.bat <package.zip|package.tgz>"' "$metadata_json" || die "PACKAGE-METADATA.json must document the Windows entrypoint"
}

function verify_migration_bridge_contract() {
  local root="$1"
  local provider="${root}/packages/core-backend/dist/src/db/migration-provider.js"
  local legacy_must_change="${root}/packages/core-backend/migrations/056_add_users_must_change_password.sql"
  local timestamp_must_change="${root}/packages/core-backend/dist/src/db/migrations/zzzz20260512100000_add_users_must_change_password.js"
  local onprem_record_create_repair="${root}/packages/core-backend/dist/src/db/migrations/zzzz20260516113000_repair_onprem_multitable_record_create.js"

  search_fixed_string 'MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL' "$provider" || die "migration-provider.js must expose the superseded legacy SQL opt-in"
  search_fixed_string '032_create_approval_records' "$provider" || die "migration-provider.js must carry the superseded legacy SQL skip list"
  search_fixed_string '037_add_gallery_form_support' "$provider" || die "migration-provider.js must no-op superseded gallery/form SQL on upgraded on-prem DBs"
  search_fixed_string '038_config_and_secrets' "$provider" || die "migration-provider.js must no-op superseded config/secrets SQL on upgraded on-prem DBs"
  search_fixed_string "to_regclass('public.users') IS NOT NULL" "$legacy_must_change" || die "056_add_users_must_change_password.sql must no-op when users table is absent"
  search_fixed_string 'must_change_password' "$timestamp_must_change" || die "timestamp users must_change_password bridge migration must be packaged"
  search_fixed_string 'meta_record_revisions' "$onprem_record_create_repair" || die "on-prem record-create repair migration must create meta_record_revisions"
  search_fixed_string 'plugin_multitable_object_registry' "$onprem_record_create_repair" || die "on-prem record-create repair migration must repair integration staging field validation"
}

function verify_generic_integration_workbench_contract() {
  local root="$1"
  local web_dist="${root}/apps/web/dist"
  local install_txt="${root}/INSTALL.txt"
  local easy_start="${root}/docs/deployment/multitable-windows-onprem-easy-start-20260319.md"
  local k3_runbook="${root}/docs/operations/integration-k3wise-internal-trial-runbook.md"
  local sql_executor_handoff="${root}/docs/operations/integration-k3wise-sql-executor-bridge-handoff.md"
  local bridge_codex_handoff="${root}/docs/development/k3wise-bridge-machine-codex-handoff-20260513.md"
  local postdeploy_smoke="${root}/scripts/ops/integration-k3wise-postdeploy-smoke.mjs"
  local delivery_readiness="${root}/scripts/ops/integration-k3wise-delivery-readiness.mjs"
  local issue1542_seed="${root}/scripts/ops/integration-issue1542-seed-workbench-systems.mjs"
  local postdeploy_summary="${root}/scripts/ops/integration-k3wise-postdeploy-summary.mjs"
  local gate_contract_checker="${root}/scripts/ops/integration-k3wise-gate-contract-check.mjs"
  local live_gate_package="${root}/docs/operations/integration-k3wise-live-gate-execution-package.md"
  local operator_handoff="${root}/docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md"
  local webapi_read_manifest="${root}/docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md"
  local relationship_mapping_manifest="${root}/docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md"
  local gate_contract_design="${root}/docs/development/data-factory-issue1526-gate-contract-check-design-20260518.md"
  local gate_contract_verification="${root}/docs/development/data-factory-issue1526-gate-contract-check-verification-20260518.md"
  local gate_template_design="${root}/docs/development/data-factory-issue1526-gate-contract-template-init-design-20260518.md"
  local gate_template_verification="${root}/docs/development/data-factory-issue1526-gate-contract-template-init-verification-20260518.md"
  local bridge_refresh_design="${root}/docs/development/bridge-agent-source-refresh-staging-design-20260522.md"
  local bridge_refresh_verification="${root}/docs/development/bridge-agent-source-refresh-staging-verification-20260522.md"
  local multitable_target_adapter="${root}/plugins/plugin-integration-core/lib/adapters/metasheet-multitable-target-adapter.cjs"
  local multitable_target_fieldid_design="${root}/docs/development/metasheet-multitable-target-fieldid-map-design-20260522.md"
  local multitable_target_fieldid_verification="${root}/docs/development/metasheet-multitable-target-fieldid-map-verification-20260522.md"
  local gate_intake_template="${root}/scripts/ops/fixtures/integration-k3wise/gate-intake-template.json"
  local onsite_evidence_template="${root}/scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json"

  search_fixed_string '/integrations/workbench' "$web_dist" || die "web dist must include the Data Factory route"
  search_fixed_string '/integrations/k3-wise' "$web_dist" || die "web dist must include the K3 WISE setup route"
  search_fixed_string '数据工厂' "$web_dist" || die "web dist must include Data Factory navigation/page copy"
  search_fixed_string '打开多维表' "$web_dist" || die "web dist must include staging multitable open-link copy"
  search_fixed_string '新建记录入口' "$web_dist" || die "web dist must clarify the staging multitable record-create entry (#651 C1)"
  search_fixed_string '导出清洗结果' "$web_dist" || die "web dist must include cleansed export copy"
  search_fixed_string '发布 API 数据服务暂不开放' "$web_dist" || die "web dist must include data-service placeholder copy"
  search_fixed_string 'dictMap' "$web_dist" || die "web dist must include the workbench dictionary mapping editor"
  search_fixed_string 'Save-only' "$web_dist" || die "web dist must keep Save-only execution copy"
  # issue #1526 P2 (#1595): staging project ID scope UX must ship in the bundle.
  search_fixed_string '规范化为 integration 作用域' "$web_dist" || die "web dist must include the staging project ID one-click normalize action (#1526 P2)"
  search_fixed_string 'normalize-k3-setup-project-id' "$web_dist" || die "web dist must include the K3 setup project ID normalize action (#651 C3)"
  search_fixed_string '否则会触发 plugin-scope 警告' "$web_dist" || die "web dist must include the K3 setup project ID scope hint (#1526 P2)"
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
  search_fixed_string '--package-verify' "$delivery_readiness" || die "delivery readiness must consume package verify evidence"
  search_fixed_string '--gate-contract-check' "$delivery_readiness" || die "delivery readiness must consume GATE contract checker evidence"
  search_fixed_string 'CUSTOMER_TRIAL_READY' "$delivery_readiness" || die "delivery readiness must still emit customer-trial ready decision"
  search_fixed_string '--issue1542-workbench-smoke' "$postdeploy_smoke" || die "postdeploy smoke must include Data Factory issue #1542 workbench retest flag"
  search_fixed_string '--issue1542-install-staging' "$postdeploy_smoke" || die "postdeploy smoke must include Data Factory issue #1542 install-staging retest flag"
  search_fixed_string '--issue1542-workbench-smoke' "$k3_runbook" || die "K3 runbook must document the Data Factory issue #1542 workbench retest"
  search_fixed_string '--issue1542-install-staging' "$k3_runbook" || die "K3 runbook must document the Data Factory issue #1542 install-staging retest"
  search_fixed_string 'integration-issue1542-seed-workbench-systems.mjs' "$k3_runbook" || die "K3 runbook must document the issue #1542 metadata seed helper"
  search_fixed_string '--bridge-source-refresh-smoke' "$postdeploy_smoke" || die "postdeploy smoke must include the Bridge Agent source refresh flag"
  search_fixed_string '--bridge-refresh-install-staging' "$postdeploy_smoke" || die "postdeploy smoke must include the Bridge Agent staging install flag"
  search_fixed_string 'bridge:legacy-sql-readonly' "$postdeploy_smoke" || die "postdeploy smoke must know the readonly Bridge Agent source adapter"
  search_fixed_string 'bridge-refresh-target-install' "$postdeploy_smoke" || die "postdeploy smoke must emit the Bridge refresh staging target install check"
  search_fixed_string 'bridge-refresh-${sourceObject}-run' "$postdeploy_smoke" || die "postdeploy smoke must emit Bridge refresh object run checks"
  search_fixed_string '--bridge-source-refresh-smoke' "$k3_runbook" || die "K3 runbook must document the Bridge Agent source refresh smoke"
  search_fixed_string '--bridge-refresh-install-staging' "$k3_runbook" || die "K3 runbook must document the Bridge Agent staging install flag"
  search_fixed_string 'bridge-refresh-bom_child-run' "$k3_runbook" || die "K3 runbook must document the Bridge Agent BOM child refresh check"
  search_fixed_string 'plm_raw_items' "$bridge_refresh_design" || die "Bridge source refresh design must document the raw staging target"
  search_fixed_string 'BA-M3' "$bridge_refresh_design" || die "Bridge source refresh design must identify the BA-M3 scope"
  search_fixed_string 'node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs' "$bridge_refresh_verification" || die "Bridge source refresh verification must document the focused postdeploy smoke test"
  search_fixed_string '--bridge-source-refresh-smoke' "$bridge_refresh_verification" || die "Bridge source refresh verification must document the entity-machine flag"
  search_fixed_string 'resolveProvisionedFieldIdMap' "$multitable_target_adapter" || die "MetaSheet multitable target adapter must resolve provisioned physical field IDs"
  search_fixed_string 'mapRecordFieldsForWrite' "$multitable_target_adapter" || die "MetaSheet multitable target adapter must map logical write fields to physical field IDs"
  search_fixed_string 'Unknown fieldId: sourceSystemId' "$multitable_target_fieldid_design" || die "MetaSheet multitable target field-id design must document the BA-M3 failure"
  search_fixed_string 'metasheet-multitable-target-adapter.test.cjs' "$multitable_target_fieldid_verification" || die "MetaSheet multitable target field-id verification must document the adapter regression test"
  search_fixed_string 'metasheet:staging' "$issue1542_seed" || die "issue #1542 seed helper must create the staging source system"
  search_fixed_string 'erp:k3-wise-webapi' "$issue1542_seed" || die "issue #1542 seed helper must create the K3 target system"
  search_fixed_string 'invalidAdapters' "$postdeploy_summary" || die "postdeploy summary must render Data Factory adapter drift details"
  search_fixed_string 'READ_ANSWER_IDS' "$gate_contract_checker" || die "GATE contract checker must validate WebAPI read/list answer IDs"
  search_fixed_string 'RELATIONSHIP_ANSWER_IDS' "$gate_contract_checker" || die "GATE contract checker must validate relationship answer IDs"
  search_fixed_string 'GATE_BLOCKED' "$gate_contract_checker" || die "GATE contract checker must distinguish incomplete customer evidence"
  search_fixed_string 'SECRET_QUERY_PATTERN' "$gate_contract_checker" || die "GATE contract checker must reject secret-looking query parameters"
  search_fixed_string '--init-template' "$gate_contract_checker" || die "GATE contract checker must initialize a fillable packet template"
  search_fixed_string 'k3wise-gate-contract-packet.template.json' "$gate_contract_checker" || die "GATE contract checker must write the canonical packet template file"
  search_fixed_string 'README-CUSTOMER-HANDOFF.zh.md' "$gate_contract_checker" || die "GATE contract checker must write the customer handoff README"
  search_fixed_string '--init-template' "$install_txt" || die "INSTALL.txt must document the GATE contract template initializer"
  search_fixed_string '8 redacted' "$install_txt" || die "INSTALL.txt must explain the generated sample skeleton count"
  search_fixed_string 'integration-k3wise-gate-contract-check.mjs' "$webapi_read_manifest" || die "WebAPI read/list manifest must point operators at the packaged GATE checker"
  search_fixed_string '--init-template' "$webapi_read_manifest" || die "WebAPI read/list manifest must document template initialization"
  search_fixed_string 'O1-MAT' "$webapi_read_manifest" || die "WebAPI read/list manifest must document O1-O6 customer answers"
  search_fixed_string 'integration-k3wise-gate-contract-check.mjs' "$relationship_mapping_manifest" || die "relationship mapping manifest must point operators at the packaged GATE checker"
  search_fixed_string '--init-template' "$relationship_mapping_manifest" || die "relationship mapping manifest must document template initialization"
  search_fixed_string 'R1' "$relationship_mapping_manifest" || die "relationship mapping manifest must document R1-R7 customer answers"
  search_fixed_string 'Stage 1 Lock' "$gate_contract_design" || die "GATE contract checker design must document the Stage 1 Lock boundary"
  search_fixed_string 'pnpm verify:integration-k3wise:gate-contract' "$gate_contract_verification" || die "GATE contract checker verification must document the local verification command"
  search_fixed_string '--init-template' "$gate_template_design" || die "GATE template design must document template initialization"
  search_fixed_string 'GATE_BLOCKED' "$gate_template_verification" || die "GATE template verification must prove the generated template cannot pass as-is"
  search_fixed_string 'integration-k3wise-delivery-readiness.mjs' "$live_gate_package" || die "live GATE package must document delivery readiness compiler"
  search_fixed_string 'VERIFY_REPORT_JSON' "$live_gate_package" || die "live GATE package must document package verifier report capture"
  search_fixed_string '--package-verify' "$live_gate_package" || die "live GATE package must document the package verify readiness gate"
  search_fixed_string '--gate-contract-check' "$live_gate_package" || die "live GATE package must document the GATE contract readiness gate"
  search_fixed_string 'gate-intake-template.json' "$live_gate_package" || die "live GATE package must document the customer-facing GATE intake template"
  search_fixed_string '"_sections"' "$gate_intake_template" || die "GATE intake template must carry A.1-A.6 customer-facing sections"
  search_fixed_string '"A.6"' "$gate_intake_template" || die "GATE intake template must document rollback contract section A.6"
  search_fixed_string '<fill-outside-git>' "$gate_intake_template" || die "GATE intake template must keep credential placeholders out of Git"
  search_fixed_string '"autoSubmit": false' "$gate_intake_template" || die "GATE intake template must default autoSubmit=false"
  search_fixed_string '"autoAudit": false' "$gate_intake_template" || die "GATE intake template must default autoAudit=false"
  search_fixed_string 'evidence-onsite-c4-c9-template.json' "$live_gate_package" || die "live GATE package must document the on-site C4-C9 evidence template"
  search_fixed_string 'integration-k3wise-onprem-operator-handoff-checklist.md' "$easy_start" || die "Windows on-prem guide must list the K3 on-prem operator handoff checklist"
  search_fixed_string 'Package Download And Verify' "$operator_handoff" || die "operator handoff checklist must include package verification phase"
  search_fixed_string 'gate-intake-template.json' "$operator_handoff" || die "operator handoff checklist must reference customer GATE intake template"
  search_fixed_string 'evidence-onsite-c4-c9-template.json' "$operator_handoff" || die "operator handoff checklist must reference C4-C9 evidence worksheet"
  search_fixed_string 'Claude Code Boundary' "$operator_handoff" || die "operator handoff checklist must document Claude Code boundary"
  search_fixed_string '"C4"' "$onsite_evidence_template" || die "on-site evidence template must document C4"
  search_fixed_string '"C9"' "$onsite_evidence_template" || die "on-site evidence template must document C9"
  search_fixed_string '"initialDecision": "The checked-in template intentionally compiles to PARTIAL before it is filled."' "$onsite_evidence_template" || die "on-site evidence template must document initial PARTIAL behavior"
  search_fixed_string '"autoSubmit": false' "$onsite_evidence_template" || die "on-site evidence template must default autoSubmit=false"
  search_fixed_string '"autoAudit": false' "$onsite_evidence_template" || die "on-site evidence template must default autoAudit=false"
}

function verify_bridge_agent_tooling_contract() {
  local root="$1"
  local smoke_script="${root}/scripts/ops/bridge-agent-driver-smoke.ps1"
  local smoke_template_json="${root}/scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.json"
  local smoke_template_md="${root}/scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.md"
  local smoke_runbook="${root}/docs/operations/bridge-agent-driver-smoke-runbook-20260520.md"
  local readonly_script="${root}/scripts/ops/bridge-agent-readonly.ps1"
  local readonly_task_script="${root}/scripts/ops/bridge-agent-readonly-scheduled-task.ps1"
  local readonly_config="${root}/scripts/ops/fixtures/bridge-agent-readonly/config.example.json"
  local readonly_runbook="${root}/docs/operations/bridge-agent-readonly-runbook-20260521.md"
  local install_txt="${root}/INSTALL.txt"

  if LC_ALL=C grep -n '[^ -~]' "$smoke_script" >/dev/null 2>&1; then
    die "Bridge Agent driver smoke must remain ASCII-safe for Windows PowerShell 5.1"
  fi
  search_fixed_string 'SELECT @@VERSION' "$smoke_script" || die "Bridge Agent driver smoke must run SELECT @@VERSION only"
  search_fixed_string "[ValidateSet('SqlClient', 'Odbc', 'OleDb')]" "$smoke_script" || die "Bridge Agent driver smoke must support SqlClient/Odbc/OleDb provider modes"
  search_fixed_string 'OdbcDriverName' "$smoke_script" || die "Bridge Agent driver smoke must allow BA-M0 approved ODBC driver names"
  search_fixed_string 'OleDbProviderName' "$smoke_script" || die "Bridge Agent driver smoke must allow BA-M0 approved OLE DB provider names"
  search_fixed_string 'data[$kStr]=<redacted>' "$smoke_script" || die "Bridge Agent driver smoke must redact sensitive Exception.Data values"
  search_fixed_string '"spec": "ba-m0.5-driver-smoke"' "$smoke_template_json" || die "Bridge Agent driver smoke JSON evidence template must identify the BA-M0.5 smoke spec"
  search_fixed_string '"decision": "<PASS | FAIL>"' "$smoke_template_json" || die "Bridge Agent driver smoke JSON evidence template must document PASS/FAIL decision shape"
  search_fixed_string '"sqlServerVersionRedacted"' "$smoke_template_json" || die "Bridge Agent driver smoke JSON evidence template must document redacted @@VERSION evidence"
  search_fixed_string 'does not start' "$smoke_runbook" || die "Bridge Agent driver smoke runbook must preserve the BA-M1 gate"
  search_fixed_string 'Secret hygiene' "$smoke_runbook" || die "Bridge Agent driver smoke runbook must document evidence hygiene"
  search_fixed_string 'BA-M0.5 Driver Smoke Evidence' "$smoke_template_md" || die "Bridge Agent driver smoke Markdown evidence template must be packaged"

  search_fixed_string 'System.Data.SqlClient.SqlConnection' "$readonly_script" || die "readonly Bridge Agent must use the approved SqlClient provider"
  search_fixed_string 'BA-M1 MVP only supports localhost binding' "$readonly_script" || die "readonly Bridge Agent must reject non-localhost bindings"
  search_fixed_string 'RAW_SQL_REJECTED' "$readonly_script" || die "readonly Bridge Agent must reject raw SQL requests"
  search_fixed_string 'UNSUPPORTED_FILTERS' "$readonly_script" || die "readonly Bridge Agent must reject filters until BA-M2 designs the query contract"
  search_fixed_string 'SELECT TOP $Limit' "$readonly_script" || die "readonly Bridge Agent must build bounded SELECT TOP queries"
  search_fixed_string 'ConvertTo-QuotedIdentifier' "$readonly_script" || die "readonly Bridge Agent must quote allowlisted SQL identifiers"
  search_fixed_string 'sharedSecretEnvVar' "$readonly_script" || die "readonly Bridge Agent must read its shared secret from a local environment variable"
  search_fixed_string 'ConvertTo-BridgeError' "$readonly_script" || die "readonly Bridge Agent must redact returned errors"

  if LC_ALL=C grep -n '[^ -~]' "$readonly_task_script" >/dev/null 2>&1; then
    die "readonly Bridge Agent scheduled task helper must remain ASCII-safe for Windows PowerShell 5.1"
  fi
  search_fixed_string "ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')" "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must expose install/start/stop/status/uninstall actions"
  search_fixed_string 'MetaSheetReadonlyBridgeAgent' "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must use a stable task name"
  search_fixed_string 'Register-ScheduledTask' "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must register a Windows Scheduled Task"
  search_fixed_string "New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest" "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must run as SYSTEM"
  search_fixed_string 'bridge-agent-readonly.ps1' "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must launch the readonly agent script"
  search_fixed_string 'Get-ScheduledTaskInfo' "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must report LastTaskResult"
  search_fixed_string 'System.Net.Sockets.TcpClient' "$readonly_task_script" || die "readonly Bridge Agent scheduled task helper must include a secret-free local listener check"

  search_fixed_string '"host": "127.0.0.1"' "$readonly_config" || die "readonly Bridge Agent example config must bind to localhost"
  search_fixed_string 'METASHEET_BRIDGE_SQL_USERNAME' "$readonly_config" || die "readonly Bridge Agent config must keep SQL username in an env var"
  search_fixed_string 'METASHEET_BRIDGE_SQL_PASSWORD' "$readonly_config" || die "readonly Bridge Agent config must keep SQL password in an env var"
  search_fixed_string 'METASHEET_BRIDGE_SHARED_SECRET' "$readonly_config" || die "readonly Bridge Agent config must keep the shared secret in an env var"
  search_fixed_string 'v_MetaSheet_MaterialRead' "$readonly_config" || die "readonly Bridge Agent config must prefer material readonly views"
  search_fixed_string 'v_MetaSheet_BomRead' "$readonly_config" || die "readonly Bridge Agent config must prefer BOM readonly views"
  search_fixed_string 'v_MetaSheet_BomChildRead' "$readonly_config" || die "readonly Bridge Agent config must prefer BOM child readonly views"

  search_fixed_string 'ValidateConfigOnly' "$readonly_runbook" || die "readonly Bridge Agent runbook must document config validation"
  search_fixed_string 'http://127.0.0.1:19091/' "$readonly_runbook" || die "readonly Bridge Agent runbook must document localhost endpoint"
  search_fixed_string 'Raw SQL must fail' "$readonly_runbook" || die "readonly Bridge Agent runbook must document negative raw-SQL check"
  search_fixed_string 'netsh http add urlacl' "$readonly_runbook" || die "readonly Bridge Agent runbook must document HttpListener URL ACL setup"
  search_fixed_string 'Persistent Scheduled Task Start' "$readonly_runbook" || die "readonly Bridge Agent runbook must document persistent scheduled task startup"
  search_fixed_string 'bridge-agent-readonly-scheduled-task.ps1' "$readonly_runbook" || die "readonly Bridge Agent runbook must point operators at the scheduled task helper"
  search_fixed_string 'Machine-level environment variables' "$readonly_runbook" || die "readonly Bridge Agent runbook must document SYSTEM environment variable handling"

  search_fixed_string 'bridge-agent-driver-smoke.ps1' "$install_txt" || die "INSTALL.txt must mention the BA-M0.5 Bridge Agent driver smoke"
  search_fixed_string 'bridge-agent-readonly.ps1' "$install_txt" || die "INSTALL.txt must mention the BA-M1 readonly Bridge Agent"
  search_fixed_string 'bridge-agent-readonly-scheduled-task.ps1' "$install_txt" || die "INSTALL.txt must mention the readonly Bridge Agent scheduled task helper"
  search_fixed_string 'bridge-agent-readonly-runbook-20260521.md' "$install_txt" || die "INSTALL.txt must point operators at the readonly Bridge Agent runbook"
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
      '      "name": "deployability-contract",' \
      '      "status": "PASS",' \
      '      "artifactKind": "deployable-onprem-app-package",' \
      '      "deployMode": "fresh-extract-or-existing-root-apply",' \
      '      "directReplaceSafe": false,' \
      '      "nodeModulesBundled": false' \
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
      echo "- Deployability contract: \`PASS\` (deployable-onprem-app-package, directReplaceSafe=false, nodeModulesBundled=false)"
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
  [[ -f "${root}/DEPLOYMENT.txt" ]] && targets+=("${root}/DEPLOYMENT.txt")
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
  "DEPLOYMENT.txt"
  "PACKAGE-METADATA.json"
  "apps/web/dist/index.html"
  "apps/web/package.json"
  "packages/core-backend/dist/src/index.js"
  "packages/core-backend/dist/src/db/migrate.js"
  "packages/core-backend/dist/src/db/migration-provider.js"
  "packages/core-backend/dist/src/db/migrations/zzzz20260512100000_add_users_must_change_password.js"
  "packages/core-backend/dist/src/db/migrations/zzzz20260516113000_repair_onprem_multitable_record_create.js"
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
  "plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs"
  "scripts/ops/integration-k3wise-onprem-preflight.mjs"
  "scripts/ops/integration-k3wise-live-poc-preflight.mjs"
  "scripts/ops/integration-k3wise-live-poc-evidence.mjs"
  "scripts/ops/integration-k3wise-delivery-readiness.mjs"
  "scripts/ops/integration-k3wise-postdeploy-smoke.mjs"
  "scripts/ops/integration-issue1542-seed-workbench-systems.mjs"
  "scripts/ops/integration-k3wise-postdeploy-summary.mjs"
  "scripts/ops/integration-k3wise-gate-contract-check.mjs"
  "scripts/ops/bridge-agent-driver-smoke.ps1"
  "scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.json"
  "scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.md"
  "scripts/ops/bridge-agent-readonly.ps1"
  "scripts/ops/bridge-agent-readonly-scheduled-task.ps1"
  "scripts/ops/fixtures/bridge-agent-readonly/config.example.json"
  "scripts/ops/fixtures/integration-k3wise/gate-intake-template.json"
  "scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json"
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
  "docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md"
  "docs/operations/integration-k3wise-internal-trial-runbook.md"
  "docs/operations/integration-k3wise-live-gate-execution-package.md"
  "docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md"
  "docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md"
  "docs/operations/bridge-agent-driver-smoke-runbook-20260520.md"
  "docs/operations/bridge-agent-readonly-runbook-20260521.md"
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
verify_integration_plugin_runtime_dependencies "$pkg_root"
verify_deployable_artifact_contract "$pkg_root"
verify_migration_bridge_contract "$pkg_root"
verify_generic_integration_workbench_contract "$pkg_root"
verify_bridge_agent_tooling_contract "$pkg_root"

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
