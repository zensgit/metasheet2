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
#
# 工作台里选源 note: StockPreparationSourceBinding is in THIS list on exactly the same footing, and for
# exactly the same reason. Its .spec.ts would need a roster entry, and the roster is pinned
# byte-for-byte against `on.push.paths` in integration-guard.yml — a workflow file that change could
# not touch. The guard still runs it, and not by luck: the panel lives under
# apps/web/src/components/integration/stockPreparation/** and its service under
# apps/web/src/services/integration/stockPreparation/**, BOTH of which are `/**` roster entries, and
# the change also touches plugins/plugin-integration-core/**. Any edit to this feature therefore
# fires the lane, and this line is what makes the lane actually execute the spec. Adding the
# apps/web/tests/StockPreparationSourceBinding.spec.ts roster entry alongside its `on.push.paths`
# twin is the same follow-up as the one above, for the same person.
#
# 项目查询 note: StockPreparationProjectQuery (P2-1) is in THIS list on exactly the same footing as the
# two above, and for the same reason: its .spec.ts would need a roster entry, and the roster is pinned
# byte-for-byte against `on.push.paths` in integration-guard.yml — a workflow file that change could
# not touch. The guard still fires on any edit to this feature: the panel lives under
# apps/web/src/components/integration/stockPreparation/** and its pure module under
# apps/web/src/services/integration/stockPreparation/**, both `/**` roster entries. The filter token
# is `StockPreparationProjectQuery`, which is neither a substring nor a superstring of any other token
# in this list (`StockPreparationProjectWorkspaceView` is the nearest, and neither contains the other),
# so it resolves to exactly one file. Adding the roster entry alongside its `on.push.paths` twin is the
# same follow-up as the two above, for the same person.
#
# 收尾小修波 D4 共享常量 note: StockPreparationHomeQueryLabels (hardening wave, 2026-09-08) is in THIS
# list on the same footing as the three notes above. It is a pure-module spec for
# `stockPrepHomeStatusLabel` / `resolveStockPrepPullBanner` — both under
# apps/web/src/services/integration/stockPreparation/** — plus a source-level guard reading the two
# `.vue` callers under apps/web/src/components/integration/stockPreparation/**, so the SAME two `/**`
# roster entries that already fire this lane for every stock-prep change cover it too; a roster entry
# for the .spec.ts itself is the same follow-up as the three notes above, for the same person. The
# filter token is `StockPreparationHomeQueryLabels`, neither a substring nor a superstring of any other
# token in this list — the nearest neighbours, `StockPreparationWorkspace` and
# `StockPreparationProjectWorkspaceView`, diverge right after `StockPreparation` — so it resolves to
# exactly one file.
#
# W7-A3 场景 B 页面验收 note: StockPreparationScenarioBAcceptance (2026-09-20) is in THIS list on the
# same footing as the notes above — it mounts StockPreparationDashboardView and
# StockPreparationSnapshotDiffView, both under apps/web/src/components/integration/stockPreparation/**,
# a `/**` roster entry that already fires this lane. A roster entry for the .spec.ts itself is the same
# follow-up as the notes above, for the same person. The filter token is
# `StockPreparationScenarioBAcceptance`, neither a substring nor a superstring of any other token in
# this list (nearest neighbours `StockPreparationSnapshotDiffView` / `StockPreparationDashboardView`
# diverge right after `StockPreparation`), so it resolves to exactly one file.
#
# SC-04 运行详情前端 note: IntegrationRunDetail (2026-09-20) is in THIS list on the same footing
# as the notes above — it mounts IntegrationWorkbenchView and exercises
# apps/web/src/components/integration/IntegrationMonitoringSection.vue,
# apps/web/src/services/integration/workbench.ts and apps/web/src/views/IntegrationWorkbenchView.vue,
# all three of which are EXACT roster entries in scripts/ops/integration-guard-guarded-paths.mjs, so
# this lane already fires on every change to the surface it covers. A roster entry for the .spec.ts
# itself is the same follow-up as the notes above, for the same person. The filter token is
# `IntegrationRunDetail`, neither a substring nor a superstring of any other token in this list
# (nearest neighbours `IntegrationMonitoringSection` / `IntegrationWorkbenchView` diverge right after
# `Integration`), so it resolves to exactly one file.
#
# Q3c 导出对账摘要 note: StockPreparationDiffSummaryExport (2026-09-20) is in THIS list on the same
# footing as the notes above — it covers StockPreparationSnapshotDiffView.vue (client-side CSV
# export of the diff summary) and services/integration/stockPreparation/bomSnapshotDiff.ts, both
# under the `/**` roster entries (apps/web/src/components/integration/stockPreparation/** and
# apps/web/src/services/integration/stockPreparation/**) that already fire this lane for stock-prep
# changes generally. A roster entry for the .spec.ts itself is the same deferred follow-up as the
# notes above, for the same person. The filter token is `StockPreparationDiffSummaryExport`, neither
# a substring nor a superstring of any other token in this list (nearest neighbours
# `StockPreparationSnapshotDiffView` / `StockPreparationScenarioBAcceptance` diverge right after
# `StockPreparation`), so it resolves to exactly one file.
set -euo pipefail

#
# REGISTRATION SHAPE (H-7, 2026-09-22): one token per physical line, backslash-continued,
# sorted case-insensitively — the SAME prescription applied to
# apps/web/scripts/run-required-web-tests.sh (see that file's own header) and for the identical
# reason: this used to be ONE single physical line carrying all 54 filter tokens, so any two
# branches adding unrelated specs here collided on that one line. Splitting it means two lanes
# adding different tokens touch different physical lines and merge cleanly.
#
# This is a SHAPE change only — the token SET is unchanged (verified: NUL-delimited argv captured
# from a PATH-injected `pnpm` shim, before vs after, is byte-identical up to order — see the
# design doc for the exact method). Read this file the way
# packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts documents in its
# own PARSING CONTRACT section: strip whole-line `#` comments, JOIN backslash continuations into
# one logical line, and only then read the invocation — a physical-line
# `line.startsWith('pnpm --filter @metasheet/web exec vitest run ')` parse now sees a header
# whose only "argument" is the continuation backslash.
#
# A `#`-prefixed line ANYWHERE inside this block is not a harmless comment: backslash-newline
# splicing joins the whole block into ONE line before bash ever looks for a `#`, so such a line
# silently truncates every token after it — including the trailing `--reporter=dot` — out of the
# real invocation while this file's text looks unremarkable. That exact shape is what the
# structural guard below and the second-registration-point block in
# required-web-lane-registration-shape.test.ts both check for directly.
#
pnpm --filter @metasheet/web exec vitest run \
  bomSnapshotDiff \
  bridgeAgentConfigCheck \
  composition-vocab-mirror \
  fieldHints \
  IntegrationBridgeAgentSection \
  IntegrationCleaningDatasetSection \
  IntegrationCompositionWizard \
  IntegrationConnectionSection \
  integrationErrorCodeLabels \
  IntegrationExternalWritePanel \
  IntegrationFieldOptionSyncPanel \
  IntegrationHelpView \
  IntegrationHubOverviewSection \
  IntegrationK3WiseSetupView \
  IntegrationMappingRulesSection \
  IntegrationMonitoringSection \
  IntegrationObjectTemplateSection \
  IntegrationOptionSetsStructuredEditor \
  IntegrationPayloadPreviewSection \
  IntegrationPipelineRunSection \
  IntegrationReadSourceCompositionAuthoringPanel \
  IntegrationReadSourceCompositionPanel \
  IntegrationReadSourceConfigPanel \
  IntegrationReadSourceWizard \
  IntegrationRunDetail \
  IntegrationStockPrepPanel \
  IntegrationTableActionsPanel \
  IntegrationTemplateCatalogPicker \
  integrationWorkbench \
  IntegrationWorkbenchRail \
  IntegrationWorkbenchView \
  JsonAssist \
  k3-endpoint-vocab-mirror \
  MetaIntegrationFieldRuleAuthoring \
  multitable-resolver-vocab-mirror \
  optionSetsStructured \
  readSourceCompositions.service \
  readSourceModePresets \
  readSourceTemplateCatalog \
  StockPreparationDashboardView \
  StockPreparationDiffSummaryExport \
  StockPreparationExceptionQueueView \
  StockPreparationHomeQueryLabels \
  StockPreparationMappingConfirmView \
  StockPreparationPrepLineView \
  StockPreparationProjectQuery \
  StockPreparationProjectWorkspaceView \
  StockPreparationScenarioBAcceptance \
  StockPreparationSnapshotDiffView \
  StockPreparationSourceBinding \
  StockPreparationStageOverview \
  StockPreparationStageStepper \
  StockPreparationUnitConfirmView \
  StockPreparationWorkspace \
  --reporter=dot
