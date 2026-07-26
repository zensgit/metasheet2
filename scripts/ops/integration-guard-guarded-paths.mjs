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
  'plugins/plugin-integration-core/**',
  'apps/web/src/services/integration/readSourceConfigs.ts',
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
  // made the guard run itself. After extraction, a PR touching ONLY these three scripts would
  // otherwise classify as not-relevant and hit the no-op branch — never actually running the suite
  // whose own gating logic just changed. These three entries close that gap.
  'scripts/ops/integration-guard-guarded-paths.mjs',
  'scripts/ops/integration-guard-classify.mjs',
  'scripts/ops/integration-guard-assert-branch.mjs',
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
