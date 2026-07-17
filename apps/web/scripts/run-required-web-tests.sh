#!/usr/bin/env bash
# G-CI (2026-07-08): the ALWAYS-ON, required-eligible web test gate.
#
# Why this exists: the required `test (20.x)` job only *builds* apps/web — it never runs its vitest
# specs. Web specs otherwise run only in the NON-required, path-filtered approval-web-guard /
# multitable-web-guard, so a green PR did not mean any frontend test passed. This script runs the
# curated, verified-stable union of those two guards' filters UNCONDITIONALLY, so a single job can
# be added to branch-protection required contexts without the path-filtered-required footgun
# (a required check that never triggers leaves PRs hanging forever).
#
# Maintenance: when you add a web spec to approval-web-guard or multitable-web-guard, add it here
# too (same two-point discipline). The 19 pre-existing red files (approvalStaticPicker,
# approvalMobileDetailActions, several multitable-workbench/*, attendance/*, featureFlags,
# k3WiseSetup, platform-app-launcher, …) are deliberately OUT of this set until fixed; broaden
# toward full-suite-minus-quarantine once they are triaged.
#
# T3/T4/T5 post-hoc gate (2026-07-12): `mount-behind-flow` added — the harness self-test
# (tests/helpers/mount-behind-flow.spec.ts) that proves the shared UI-P2-1c T4 mock-client mount
# helper actually does what its own doc comments claim (real DOM mount/teardown, router dispatch +
# default-fallback, singleton monkey-patch/restore). The token only matches the `.spec.ts` file —
# vitest's default `include` glob is `**/*.spec.ts`, so the co-located `.ts` helper module itself is
# never collected as a test file (confirmed: only 1 file matched in local + guard runs).
#
# W0 CI-coverage lane (2026-07-13): added 136 multitable-scope specs that were previously green
# but ran in NO workflow at all (an independent inventory found them; each was re-verified green
# here before wiring, in isolation and batched with this script). Two tokens
# (`multitable-comment-inbox.spec.ts`, `multitable-workbench.spec.ts`) intentionally use the full
# filename instead of the bare basename — the bare form is a substring of sibling files that were
# red at the time of this change (`multitable-comment-inbox-view.spec.ts`,
# `multitable-workbench-*-wiring/flow.spec.ts` etc.); the `.spec.ts` suffix keeps the match exact.
#
# T5-safe (2026-07-13, docs/development/multitable-ui-p2-1c-t5-recorddrawer-decision-brief-20260712.md,
# owner-ratified subset): `multitable-record-drawer-t5-migration.spec.ts` — MetaRecordDrawer's watch/
# workflow/permissions/duplicate/delete/unlock buttons migrated to MtButton (comment button
# deliberately excluded, OD-T5b, separate governance). Full filename used (not the bare basename)
# to avoid ambiguity with the sibling `multitable-record-drawer*` tokens already in this list.
#
# CA lock (2026-07-13, docs/development/multitable-comment-affordance-token-design-lock-20260713.md,
# RATIFIED): `comment-affordance-color-consistency` — the §3.3 source-scanning guard proving the
# 10 comment-affordance consumers are token-only (--ms-color-comment-active-*) and that
# resolveCommentAffordanceStateClass stays the sole state-derivation entry.
#
# G-10 NIT-1 follow-up (docket #63, 2026-07-15): four specs ran in NO CI workflow at all —
# `conditional-formatting-dialog-i18n`, `dingtalk-internal-view-link-warnings`,
# `dingtalk-recipient-field-warnings`, `dingtalk-public-form-link-warnings` — added here after each
# was re-verified green in isolation and batched with this script. A fifth named in the same audit,
# `meta-grid-table-i18n.spec.ts`, turned out to already execute today as an unintentional side effect
# of the bare `meta-grid-table` token above (vitest's default filter is a path substring match, and
# `meta-grid-table-i18n.spec.ts` / `meta-grid-table-record-lock.spec.ts` both contain that substring
# — confirmed by isolating the token). It is listed explicitly here too, full filename, so its
# coverage is intentional and survives any future narrowing of the `meta-grid-table` token (does not
# change the passing file count on its own).
#
# W0 docket #39 (2026-07-15): `multitable-comment-inbox-view.spec.ts` — full filename (not the bare
# `multitable-comment-inbox-view` basename, which is also a substring of the untouched sibling
# `multitable-comment-inbox-view-migration.spec.ts`). This spec was pulled from this gate in
# #4217/65e0a8c25 as a suspected "batch co-execution" flake (CI failed a run this script's local
# batch and isolation runs both passed). Root-caused here instead: the spec's `flushUi(N)` helper
# waited a FIXED number of microtask ticks, and that fixed N — tuned against whichever Node happened
# to be on hand locally — does not settle the view's 5-call sequential apiFetch chain within budget
# on Node 20.x, the version this job's CI runner and `actions/setup-node` (`node-version: 20.x`)
# actually use: reproduced as a DETERMINISTIC 5/5 failure in ISOLATION under Node 20.20.2 (not a
# batch-only symptom — batching was never the real variable). Fixed by replacing the fixed-tick
# `flushUi` with a `flushUntil(predicate)` poll that waits for the actual DOM condition instead of
# guessing a tick count; verified green 5/5 in isolation under both Node 20.20.2 and the newer local
# Node, and green in this full required batch under Node 20.20.2 (twice, plus with `--sequence.seed`
# variation and reversed file order — see the PR for the run logs).
# W2 S1 (2026-07-15, docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
# §7 S1): `multitable-record-fields-panel` — the new MetaRecordFieldsPanel.vue standalone spec (the
# panel extracted from MetaRecordDrawer.vue's `details` tab body). Bare basename token; no existing
# token is a substring of it and it is not a substring of any existing token (verified) so no
# disambiguation suffix is needed, unlike the `.spec.ts`-suffixed tokens elsewhere in this file.
# W2 S2 (2026-07-15, same lock, §7 S2): `multitable-record-history-panel` — the new
# MetaRecordHistoryPanel.vue standalone spec (the panel extracted from MetaRecordDrawer.vue's
# `history` tab body). Bare basename token; verified no existing token is a substring of it and it
# is not a substring of any existing token, so no disambiguation suffix is needed.
# W2 S3 (2026-07-15, same lock, §7 S3): `multitable-record-inspector` — the new
# MetaRecordInspector.vue shell spec (tab switching, roving-tabindex invariant, aria-controls<->
# tabpanel pairing, panel-count conservation, Left/Right/Home/End + Escape keyboard cases, the
# MetaRecordDrawer delegation proof). Bare basename token; verified no existing token is a substring
# of it (closest neighbors are `multitable-record-drawer*`/`multitable-record-fields-panel`/
# `multitable-record-history-panel`/`multitable-record-permission*`/`multitable-record-restore-
# client`, none of which are substrings of `multitable-record-inspector` or vice versa) so no
# disambiguation suffix is needed.
# W2 S4 (2026-07-15, same lock, §7 S4): `multitable-comments-panel` — the new
# MetaCommentsPanel.vue standalone spec (thread render, composer emit parity, reactions, presence,
# G-8-scope pass-through, HI-1 fetch-monkeypatch). Bare basename token; NOTE the pre-existing bare
# `multitable-comments` token above already incidentally matches this file too (a substring), so
# this token is not strictly load-bearing for coverage today — added anyway, explicit and named,
# per this file's established discipline of never relying on incidental substring luck for a new
# spec's coverage (a future rename/narrowing of `multitable-comments` must not silently drop this
# file). `multitable-record-inspector.spec.ts`'s existing token already covers this slice's
# extension to that file (3rd tab + commentId/openComments default); no new token needed there.
# W2 S5 (2026-07-15, same lock, §2 附件面板 row, §7 S5, §8): `multitable-record-attachments-panel` —
# the new MetaRecordAttachmentsPanel.vue standalone spec (aggregation render, the owner Medium-3 mask
# contract's two MANDATORY negative goldens — N1 property-hidden field / N2 RBAC-denied field — plus
# a positive control, upload/delete emit parity through the reused uploadFn/deleteAttachmentFn +
# MetaAttachmentList, HI-1 source-scan + fetch-monkeypatch). Bare basename token; verified no existing
# token is a substring of it and it is not a substring of any existing token (closest neighbor is
# `multitable-record-fields-panel`/`multitable-record-history-panel`/`multitable-record-inspector`,
# none of which are substrings of `multitable-record-attachments-panel` or vice versa), so no
# disambiguation suffix is needed. `multitable-record-inspector.spec.ts`'s existing token already
# covers this slice's extension to that file (4th tab, wrap-around boundary now comments<->attachments,
# arrow-scoping guard extended to the attachments tab's file input); no new token needed there.
#
# OD-W2-5a (2026-07-16, docket #74, owner ruling OD-W2-5=(a) a-read-through):
# `multitable-record-history-client-restored-from` — the client-tier golden proving BOTH history read
# fetchers (listRecordHistory→normalizeRecordHistoryEntry, getHistoryBatch→normalizeHistoryChange) pass
# `restoredFromVersion` through the real normalizers. WHY it must be listed explicitly: the
# `normalizeHistoryChange` half of the fix (base History Center badge) has NO other gated coverage —
# the already-gated `multitable-history-center-inline-diff` stays GREEN when that pass-through is
# blanked (it injects shaped objects), and `multitable-client` only exercises the listRecordHistory
# half. Adversarial gate (#4365) mutation-proved this exact hole, so without this token a future
# refactor re-blanking the History Center badge — the very bug this PR fixes — would pass CI. Bare
# basename is unique: no existing token substring-matches `multitable-record-history-client-restored-from`
# (`multitable-client` does not match `history-client`) and it substring-matches only its own file.
#
# B4 (2026-07-14, docs/development/multitable-remaining-development-inventory-and-sequencing-20260712.md
# §5): `multitable-b4-field-always-readonly` — the FE `isFieldAlwaysReadOnly` case-by-case intent guard
# (grid/drawer/form both-directions parity with the server predicate; the LIVE cross-package drift guard
# lives in packages/core-backend/tests/unit/field-always-readonly-web-parity.test.ts, wired by default —
# no filter needed there).
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx vitest run amountAutoSum approval-amount-in-words approval-assignee-source approval-center approval-common-template-presets approval-condition-summary approval-detail-field approval-e2e-lifecycle approval-e2e-permissions approval-field-visibility approval-form-draft approval-graph-layout approval-graph-summary approval-graph-topology-edit approval-number-field-props approval-prefill-from-snapshot approval-route-preview-controller approval-route-preview-summary approval-template-authoring-approval-node-edit approval-template-authoring-cc-edit approval-template-authoring-complex-node-config-allowlist approval-template-authoring-condition-edit approval-template-authoring-detail approval-template-authoring-graph-preserve approval-template-authoring-linear-step-spine approval-template-authoring-parallel-edit approval-template-route-preview-api approval-upcoming-nodes approval-urge-button-state approvalCardDecisionView approvalCenterRemindBadge approvalCenterSourceFilter approvalCenterTable approvalCenterUnreadBadge approvalDelegationStatus approvalDelegationView approvalDetailPolish approvalMetricsTopnReport approvalMetricsView approvalMobileI18n approvalMobileResponsive approvalTemplateAuthoring approvalTemplateCenterCategory approvalTemplateGovernance approvalTemplateVersionHistory asyncStateBlock automation-action-summary automation-recipes automation-save-block-reasons automation-target-sheet-options AutomationExecutionsView comment-affordance-color-consistency directoryManagementView lineDerivation meta-automation-labels meta-filter-group meta-grid-table meta-person-delivery-viewer-migration meta-record-drawer-history-diff meta-record-drawer-i18n meta-record-drawer-restore meta-toolbar-filter-builder migration mount-behind-flow multitable-automation-manager multitable-automation-rule-editor multitable-cell-renderer-person-inactive multitable-client multitable-comment-affordance multitable-comment-inbox-realtime multitable-conditional-formatting multitable-conditional-rule multitable-config-history-modal multitable-config-revert-refresh multitable-crossbase-workbench-wiring multitable-field-manager multitable-field-visibility multitable-grid multitable-history-center-ai-shortcut-label multitable-history-center-inline-diff multitable-history-center-pinned-batch-deeplink multitable-history-fe multitable-kanban-view multitable-person-picker multitable-phase11 multitable-record-permission-manager multitable-record-restore-client multitable-reorder-view-fields multitable-required-if multitable-reset-confirm-dialog multitable-reset-tsource-picker multitable-restore-batch-dialog multitable-restore-preview-dialog multitable-rollup-aggregation-fe multitable-sheet-cursor-state multitable-sheet-permission-manager multitable-trash-fe multitable-view-manager multitable-ui multitable-workbench-1672-1673 multitable-workbench-drawer-button-wiring multitable-workbench-history-field-scope-wiring multitable-workbench-import-flow multitable-workbench-manager-flow multitable-workbench-permission-wiring multitable-workbench-restore-wiring multitable-workbench-view multitable-yjs-cell-editor multitable-yjs-scalar-cell myDelegationView newTodoPill pageShell parallelBranchRunsView requesterPreviewFields routePreviewErrors statusTag templateArchiveConfirm templateGalleryFilter ui-foundation-style-guard uiFoundationTexture useAutoSumTotal workflowHubView automation-log-redact automation-log-support-packet automation-rule-concurrent-merge meta-ai-bulk-labels meta-api-error-labels meta-api-token-labels meta-automation-delivery-viewers-i18n meta-base-picker meta-bulk-edit-labels meta-cell-editor-i18n meta-comment-composer-i18n meta-comment-labels meta-comments-drawer-i18n meta-form-share-labels meta-form-view-i18n meta-link-picker-i18n meta-link-picker-labels meta-notification-bell meta-permission-labels meta-record-labels meta-toolbar-group-picker meta-view-render-labels meta-sheet-view-rail multitable-agg-footer-grid multitable-ai-bulk-fill-composable multitable-ai-bulk-fill-dialog multitable-ai-bulk-fill-job-composable multitable-ai-bulk-fill-job-dialog multitable-ai-shortcut-cell-editor multitable-ai-shortcut-client multitable-ai-shortcut-composable multitable-ai-shortcut-drawer multitable-ai-shortcut-field-manager multitable-alt-view-comment-chip-i18n multitable-api-token-manager multitable-attachment-editor multitable-attachment-list multitable-barcode-field multitable-base-local-state multitable-build-chart-option multitable-bulk-edit-dialog multitable-button-field-config multitable-button-run-client multitable-calendar-drag-reschedule multitable-calendar-view multitable-capabilities multitable-cell-button multitable-cell-visual-display multitable-cf-scale multitable-chart-load-error multitable-chart-renderer multitable-comment-composer multitable-comment-inbox.spec.ts multitable-comment-presence multitable-comment-reactions multitable-comment-realtime multitable-comments multitable-comments-drawer multitable-conflict-ux multitable-core-i18n multitable-crossbase-link-normalizer multitable-crossbase-link-picker multitable-dashboard-view multitable-datetime-field multitable-duration-field multitable-embed-host multitable-embed-route multitable-export-dialog multitable-field-config-i18n multitable-field-display-i18n multitable-field-validation-panel multitable-form-layout multitable-form-share-manager multitable-form-view multitable-formula-dryrun-panel multitable-formula-suggest-field-manager multitable-frozen-columns-grid multitable-frozen-columns-util multitable-gallery-view multitable-gantt-view multitable-hierarchy-view multitable-home-view multitable-import multitable-import-modal multitable-link-picker multitable-linked-record-chip multitable-linked-record-popover multitable-location-field multitable-longtext-cell multitable-manager-panels-i18n multitable-mention-inbox multitable-mention-popover multitable-mention-realtime multitable-multiselect-field multitable-nongrid-summary-rendering multitable-number-format multitable-people-import multitable-person-field multitable-personal-view-toggle multitable-phase10 multitable-phase12 multitable-phase13 multitable-phase14 multitable-phase15 multitable-phase3 multitable-phase4 multitable-phase5 multitable-phase6 multitable-phase7 multitable-phase8 multitable-phase9 multitable-qrcode-field multitable-record-drawer multitable-record-drawer-button multitable-record-drawer-duplicate multitable-record-drawer-t5-migration.spec.ts multitable-record-fields-panel multitable-record-history-panel multitable-record-history-client-restored-from multitable-record-inspector multitable-comments-panel multitable-record-attachments-panel multitable-record-permissions-composable multitable-richtext-editor-mention multitable-richtext-longtext multitable-richtext-mention multitable-richtext-wiring multitable-scoped-permissions multitable-sheet-presence multitable-sheet-realtime multitable-system-fields multitable-template-center-view multitable-template-detail-view multitable-timeline-view multitable-view-display-prefs-util multitable-workbench-i18n multitable-workbench.spec.ts multitable-yjs-cell-binding personal-view-client public-multitable-form view-manager-multitable-contract xlsx-mapping StockPreparationDashboardView StockPreparationStageOverview StockPreparationStageStepper conditional-formatting-dialog-i18n dingtalk-internal-view-link-warnings dingtalk-recipient-field-warnings dingtalk-public-form-link-warnings meta-grid-table-i18n.spec.ts multitable-comment-inbox-view.spec.ts multitable-b4-field-always-readonly --reporter=dot
