/**
 * Integration Guard guarded-path roster — SINGLE SOURCE OF TRUTH (governance slice, 2026-07-25).
 *
 * WHY THIS FILE EXISTS. Before this slice, the guarded-path roster was hand-duplicated in
 * .github/workflows/integration-guard.yml in TWO places (the trigger-level `on.push.paths:` list and
 * an in-job bash `case` statement) and had silently drifted: two entries (JsonAssist.vue,
 * utils/jsonAssist.ts) were listed twice in the trigger list, and one owner-mandated mutation class —
 * "rename a roster entry to a path that no longer exists" — had NOTHING checking that every entry
 * still resolves to something on disk. This module is now the ONLY place the roster is authored:
 *   - scripts/ops/integration-guard-classify.mjs (the extracted classifier, invoked from the workflow)
 *     imports this array to decide `relevant`;
 *   - scripts/ops/integration-guard-required-wiring-contract.test.mjs asserts `on.push.paths` in the
 *     workflow is set-equal to this array (dedup-checked both directions) AND that every non-glob
 *     entry resolves to a real file/directory on disk, closing the "renamed to a nonexistent path"
 *     false-green class at the roster level (not just for the one path the owner's mutation named).
 *
 * GLOB CONVENTION. An entry ending in `/**` means "this directory and everything under it, at any
 * depth" (prefix match: the changed path equals the prefix or starts with `prefix/`). Every other
 * entry is matched by exact string equality. This mirrors the bash `case` pattern semantics the
 * in-job classifier used to have (a bare `*` in a `case` pattern matches across `/` because `case` is
 * string pattern matching, not filesystem pathname globbing — it is NOT the same as shell glob
 * expansion) — so a nested file under a `/**` entry (e.g.
 * `plugins/plugin-integration-core/src/read/foo/bar.ts`) must classify identically to a top-level one.
 *
 * Expand this list as more integration read-source-config/composition/mapping-rule/error-code/
 * field-hint/help-center/JSON-assist/stock-preparation surfaces are added — see
 * .github/workflows/integration-guard.yml's own header for the feature-area narrative.
 */

export const GUARDED_PATH_ENTRIES = Object.freeze([
  // Owner-only YiDa: exact real files, paired with workflow push paths. No unsupported mid-globs.
  'apps/web/scripts/run-required-web-tests.tokens',
  'apps/web/src/services/integration/yidaInitialization.ts',
  'apps/web/src/services/integration/yidaOwner.ts',
  'apps/web/tests/StockPreparationProjectBoard.spec.ts',
  'apps/web/tests/StockPreparationYidaInitialization.spec.ts',
  'apps/web/tests/StockPreparationYidaOwnerSend.spec.ts',
  'apps/web/tests/StockPreparationYidaPreview.spec.ts',
  'packages/core-backend/migrations/090_create_integration_yida_delivery_ledger.sql',
  'packages/core-backend/migrations/091_create_integration_yida_create_fence.sql',
  'packages/core-backend/migrations/092_create_integration_yida_credential_materials.sql',
  'packages/core-backend/migrations/093_create_integration_yida_draft_plans.sql',
  'packages/core-backend/migrations/094_create_integration_yida_approved_target.sql',
  'packages/core-backend/migrations/095_create_integration_yida_send_approvals.sql',
  'packages/core-backend/migrations/096_create_integration_yida_initialization.sql',
  'packages/core-backend/scripts/bootstrap-yida-initialization-owner.ts',
  'packages/core-backend/src/context/request-context.ts',
  'packages/core-backend/src/core/logger.ts',
  'packages/core-backend/src/index.ts',
  'packages/core-backend/src/integration/automation-live-authority.ts',
  'packages/core-backend/src/integration/yida-initialization-bootstrap.ts',
  'packages/core-backend/src/integration/yida-initialization-runtime.ts',
  'packages/core-backend/src/integration/yida-owner-http-observation.ts',
  'packages/core-backend/src/integration/yida-owner-runtime.ts',
  'packages/core-backend/src/integration/yida-send-approval-service.ts',
  'packages/core-backend/src/middleware/correlation.ts',
  'packages/core-backend/src/routes/integration-yida-owner.ts',
  'packages/core-backend/tests/integration/automation-live-authority-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-approved-target-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-create-fence-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-credential-materials-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-delivery-runner-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-draft-plans-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-initialization-browser-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-initialization-http-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-owner-browser-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-owner-http-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-owner-send-port-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-send-approvals-realdb.test.ts',
  'packages/core-backend/tests/integration/stock-preparation-yida-write-ledger-realdb.test.ts',
  'packages/core-backend/tests/integration/yida-initialization-runtime-realdb.test.ts',
  'packages/core-backend/tests/unit/integration/automation-live-authority.test.ts',
  'packages/core-backend/tests/unit/yida-initialization-bootstrap-cli.test.ts',
  'packages/core-backend/tests/unit/yida-initialization-http-boundary.test.ts',
  'packages/core-backend/tests/unit/yida-initialization-runtime.test.ts',
  'packages/core-backend/tests/unit/yida-owner-request-logging.test.ts',
  'packages/core-backend/tests/unit/yida-owner-runtime.test.ts',
  'packages/core-backend/tests/utils/stock-preparation-yida-owner-browser-fixture.ts',
  'packages/core-backend/tests/utils/stock-preparation-yida-owner-http-fixture.ts',
  'packages/core-backend/tests/utils/yida-native-module-import.cjs',
  'packages/core-backend/vitest.config.ts',
  'packages/core-backend/vitest.yida-owner-realdb.config.ts',
  'scripts/ops/global-history-flag-manifest.mjs',
  'scripts/ops/global-history-flag-manifest.test.mjs',
  'plugins/plugin-integration-core/**',
  'apps/web/src/services/integration/readSourceConfigs.ts',
  'apps/web/src/services/integration/k3B4Runs.ts',
  'apps/web/src/services/integration/k3Bl2Runs.ts',
  'apps/web/src/components/integration/IntegrationK3B4RunPanel.vue',
  'apps/web/src/components/integration/IntegrationK3Bl2RunPanel.vue',
  'apps/web/tests/IntegrationK3B4RunPanel.spec.ts',
  'apps/web/tests/IntegrationK3B4WorkbenchAccess.spec.ts',
  'apps/web/tests/IntegrationK3Bl2RunPanel.spec.ts',
  'apps/web/tests/IntegrationK3Bl2Services.spec.ts',
  'apps/web/tests/IntegrationK3WorkbenchStartup.spec.ts',
  'apps/web/src/services/integration/readSourceCompositions.ts',
  'apps/web/src/services/integration/errorCodeLabels.ts',
  'apps/web/src/services/integration/fieldHints.ts',
  'apps/web/src/services/integration/bridgeAgentConfigCheck.ts',
  'apps/web/src/components/integration/IntegrationReadSourceConfigPanel.vue',
  'apps/web/src/components/integration/IntegrationReadSourceWizard.vue',
  'apps/web/src/services/integration/readSourceModePresets.ts',
  'apps/web/src/components/integration/IntegrationReadSourceCompositionPanel.vue',
  'apps/web/src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue',
  'apps/web/src/components/integration/IntegrationCompositionWizard.vue',
  'apps/web/src/services/integration/readSourceTemplateCatalog.ts',
  'apps/web/src/components/integration/IntegrationTemplateCatalogPicker.vue',
  'apps/web/src/components/integration/IntegrationWorkbenchRail.vue',
  'apps/web/src/components/integration/IntegrationMonitoringSection.vue',
  'apps/web/src/components/integration/IntegrationCleaningDatasetSection.vue',
  'apps/web/src/components/integration/IntegrationMappingRulesSection.vue',
  'apps/web/src/components/integration/IntegrationObjectTemplateSection.vue',
  'apps/web/src/components/integration/IntegrationPayloadPreviewSection.vue',
  'apps/web/src/components/integration/IntegrationConnectionSection.vue',
  'apps/web/src/components/integration/IntegrationBridgeAgentSection.vue',
  'apps/web/src/components/integration/IntegrationPipelineRunSection.vue',
  'apps/web/src/components/integration/IntegrationStockPrepPanel.vue',
  'apps/web/src/components/integration/IntegrationExternalWritePanel.vue',
  'apps/web/src/components/integration/IntegrationTableActionsPanel.vue',
  'apps/web/src/components/integration/IntegrationFieldOptionSyncPanel.vue',
  'apps/web/src/components/integration/IntegrationOptionSetsStructuredEditor.vue',
  'apps/web/src/components/integration/JsonAssist.vue',
  'apps/web/src/utils/jsonAssist.ts',
  'apps/web/src/utils/optionSetsStructured.ts',
  'apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts',
  'apps/web/src/components/integration/MetaIntegrationFieldRuleAuthoring.vue',
  'apps/web/src/services/integration/workbench.ts',
  'apps/web/src/views/IntegrationWorkbenchView.vue',
  'apps/web/src/views/IntegrationK3WiseSetupView.vue',
  'apps/web/src/views/IntegrationHelpView.vue',
  'apps/web/tests/composition-vocab-mirror.spec.ts',
  'apps/web/tests/k3-endpoint-vocab-mirror.spec.ts',
  'apps/web/src/services/integration/k3WiseSetup.ts',
  'plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs',
  'apps/web/tests/multitable-resolver-vocab-mirror.spec.ts',
  'apps/web/tests/integrationErrorCodeLabels.spec.ts',
  'apps/web/tests/fieldHints.spec.ts',
  'apps/web/tests/integrationWorkbench.spec.ts',
  'apps/web/tests/MetaIntegrationFieldRuleAuthoring.spec.ts',
  'apps/web/tests/bridgeAgentConfigCheck.spec.ts',
  'apps/web/tests/IntegrationReadSourceConfigPanel.spec.ts',
  'apps/web/tests/IntegrationReadSourceWizard.spec.ts',
  'apps/web/tests/readSourceModePresets.spec.ts',
  'apps/web/tests/IntegrationReadSourceCompositionPanel.spec.ts',
  'apps/web/tests/IntegrationReadSourceCompositionAuthoringPanel.spec.ts',
  'apps/web/tests/IntegrationCompositionWizard.spec.ts',
  'apps/web/tests/readSourceTemplateCatalog.spec.ts',
  'apps/web/tests/IntegrationTemplateCatalogPicker.spec.ts',
  'apps/web/tests/readSourceCompositions.service.spec.ts',
  'apps/web/tests/IntegrationWorkbenchView.spec.ts',
  'apps/web/tests/IntegrationWorkbenchRail.spec.ts',
  'apps/web/tests/IntegrationMonitoringSection.spec.ts',
  'apps/web/tests/IntegrationCleaningDatasetSection.spec.ts',
  'apps/web/tests/IntegrationMappingRulesSection.spec.ts',
  'apps/web/tests/IntegrationObjectTemplateSection.spec.ts',
  'apps/web/tests/IntegrationPayloadPreviewSection.spec.ts',
  'apps/web/tests/IntegrationConnectionSection.spec.ts',
  'apps/web/tests/IntegrationBridgeAgentSection.spec.ts',
  'apps/web/tests/IntegrationPipelineRunSection.spec.ts',
  'apps/web/tests/IntegrationStockPrepPanel.spec.ts',
  'apps/web/tests/IntegrationExternalWritePanel.spec.ts',
  'apps/web/tests/IntegrationTableActionsPanel.spec.ts',
  'apps/web/tests/IntegrationFieldOptionSyncPanel.spec.ts',
  'apps/web/tests/IntegrationOptionSetsStructuredEditor.spec.ts',
  'apps/web/tests/utils/optionSetsStructured.spec.ts',
  'apps/web/tests/IntegrationK3WiseSetupView.spec.ts',
  'apps/web/tests/IntegrationHelpView.spec.ts',
  'apps/web/tests/JsonAssist.spec.ts',
  'apps/web/tests/utils/jsonAssist.spec.ts',
  'apps/web/src/components/integration/stockPreparation/**',
  'apps/web/src/services/integration/stockPreparation/**',
  'apps/web/tests/StockPreparationWorkspace.spec.ts',
  'apps/web/tests/StockPreparationProjectWorkspaceView.spec.ts',
  'apps/web/tests/StockPreparationSnapshotDiffView.spec.ts',
  'apps/web/tests/bomSnapshotDiff.spec.ts',
  'apps/web/tests/StockPreparationMappingConfirmView.spec.ts',
  'apps/web/tests/StockPreparationUnitConfirmView.spec.ts',
  'apps/web/tests/StockPreparationPrepLineView.spec.ts',
  'apps/web/tests/StockPreparationExceptionQueueView.spec.ts',
  'apps/web/tests/StockPreparationDashboardView.spec.ts',
  'apps/web/tests/StockPreparationStageOverview.spec.ts',
  'apps/web/tests/StockPreparationStageStepper.spec.ts',
  '.github/workflows/integration-guard.yml',
  // Governance-slice self-coverage (2026-07-25): before extraction, ALL classification logic lived
  // inside integration-guard.yml itself, which was already in this roster, so editing the classifier
  // made the guard run itself. After extraction, a PR touching ONLY these scripts would otherwise
  // classify as not-relevant and hit the no-op branch — never actually running the suite whose own
  // gating logic just changed. These entries close that gap.
  'scripts/ops/integration-guard-guarded-paths.mjs',
  'scripts/ops/integration-guard-classify.mjs',
  'scripts/ops/integration-guard-assert-branch.mjs',
  // Extended self-coverage (2026-07-26, #4614 two-point-wiring fix): BASE_SHA resolution and the
  // two long-form commands the workflow used to inline are now their own files, and the contract
  // that pins ALL of this — including the two-point call-site wiring into plugin-tests.yml — is
  // itself now a guarded path (it, too, is part of "the guard's own gating logic").
  'scripts/ops/integration-guard-resolve-diff.mjs',
  'scripts/ops/integration-guard-noop.sh',
  'scripts/ops/integration-guard-run-web-specs.sh',
  'scripts/ops/integration-guard-required-wiring-contract.test.mjs',
  // #4614 P1 two-point wiring: plugin-tests.yml is the contract's OTHER executable caller
  // (test (20.x) runs it via `node --test scripts/ops/integration-guard-required-wiring-
  // contract.test.mjs`). Before this entry, a PR that deleted ONLY that one invocation line
  // classified as out-of-scope here (no guarded path touched) AND silently stopped running the
  // contract in test (20.x) — both gates green, contract fully disconnected. Now such an edit is
  // itself a guarded-path change, and integration-guard.yml's own unconditional self-check step
  // (see the workflow) runs the contract regardless, whose Pin re-asserts plugin-tests.yml still
  // carries the invocation — see the contract test file for the full two-point account.
  '.github/workflows/plugin-tests.yml',
  // S6-A PowerShell 5.1 executor (2026-09-30): the `stock-prep-powershell51` job moved byte-for-byte
  // out of plugin-tests.yml (guarded, above) into its own workflow file, which is pinned whole as
  // sealed-export provenance evidence `s6aPowershell51Workflow`. Listed here so a change to it keeps
  // the trigger it had while it lived in plugin-tests.yml: this guard runs the plugin-integration-core
  // chain, including the provenance live compare. sealed-export-package-provenance.test.cjs asserts
  // this entry stays in place (derived from the pinned roster, not a copy of the path).
  '.github/workflows/stock-prep-powershell51.yml',
])

/**
 * @param {string} entry
 * @returns {boolean}
 */
export function isPrefixEntry(entry) {
  return entry.endsWith('/**')
}

/**
 * @param {string} entry a `/**`-suffixed prefix entry
 * @returns {string} the directory prefix with the `/**` suffix stripped
 */
export function prefixOf(entry) {
  if (!isPrefixEntry(entry)) {
    throw new Error(`prefixOf() called on a non-prefix entry: ${entry}`)
  }
  return entry.slice(0, -3)
}
