#!/usr/bin/env bash
# Integration Guard targeted web-spec runner (governance slice, #4614 maintenance-cost ruling,
# 2026-07-26). Extracted out of .github/workflows/integration-guard.yml's `id: web-guard-specs`
# step so the workflow only pins a single-line invocation of this script, not the huge spec-list
# command itself (owner ruling: "They do not accept long-term exact-copying of the huge web
# command ... Move those commands into named scripts / the roster, and have the workflow pin only
# the single-line invocation."). Expand the spec list here as more integration web specs are
# added — see .github/workflows/integration-guard.yml's own header for the feature-area
# narrative, and scripts/ops/integration-guard-guarded-paths.mjs for the matching guarded-path
# roster (the two lists are related but distinct: the roster decides WHEN this runs, this list
# decides WHAT it runs).
#
# 对接总览 note: IntegrationHubOverviewSection is in THIS list but deliberately NOT in the roster.
# The roster is pinned byte-for-byte against `on.push.paths` in integration-guard.yml (see the
# required-wiring contract's "on.push.paths is exactly the guarded-path roster" test), and that
# workflow file was out of scope for the change that added this spec. The guard still runs it:
# the same change touches apps/web/src/services/integration/workbench.ts and
# plugins/plugin-integration-core/**, both of which ARE roster entries, so the lane fires.
# Adding the two roster entries (the .vue and the .spec.ts) alongside the matching `on.push.paths`
# entries is a follow-up for whoever may edit the workflow.
set -euo pipefail

pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror k3-endpoint-vocab-mirror multitable-resolver-vocab-mirror integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel readSourceCompositions.service IntegrationWorkbenchView IntegrationWorkbenchRail IntegrationMonitoringSection IntegrationCleaningDatasetSection IntegrationMappingRulesSection IntegrationObjectTemplateSection IntegrationPayloadPreviewSection IntegrationConnectionSection IntegrationHubOverviewSection IntegrationBridgeAgentSection IntegrationK3WiseSetupView IntegrationHelpView IntegrationPipelineRunSection IntegrationStockPrepPanel IntegrationExternalWritePanel IntegrationTableActionsPanel IntegrationFieldOptionSyncPanel readSourceModePresets IntegrationReadSourceWizard JsonAssist IntegrationCompositionWizard bridgeAgentConfigCheck IntegrationOptionSetsStructuredEditor optionSetsStructured integrationWorkbench MetaIntegrationFieldRuleAuthoring readSourceTemplateCatalog IntegrationTemplateCatalogPicker StockPreparationWorkspace StockPreparationProjectWorkspaceView bomSnapshotDiff StockPreparationSnapshotDiffView StockPreparationMappingConfirmView StockPreparationUnitConfirmView StockPreparationPrepLineView StockPreparationExceptionQueueView StockPreparationDashboardView StockPreparationStageOverview StockPreparationStageStepper --reporter=dot
