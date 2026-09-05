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
# 2026-08-07: `data-sources-ui` / `data-sources-api-preview` added. A control-gated sweep of
# every test file in the repo found them executed by NOTHING — not this gate, not
# approval-web-guard, not multitable-web-guard, no workflow at all (42 tests, all passing,
# guarding the data-source UI + API-preview surface of the DB-integration line). Both tokens
# were checked for the substring-collision hazard documented below: each matches exactly one
# file and nothing else in apps/web.
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
# Record inspector resizable panel (2026-09-05): `multitable-record-inspector-resize` — the new
# MetaRecordInspector.vue resize/persistence/height-contract spec (splitter ARIA + keyboard resize,
# pointer drag, localStorage width persistence + malformed-value fallback, expand toggle, sticky
# header/tabs + scrolling body structure). NOTE the pre-existing bare `multitable-record-inspector`
# token above already incidentally matches this file too (it is a plain string prefix of this token's
# basename), so this token is not strictly load-bearing for coverage today -- added anyway, explicit
# and named, per this file's established discipline of never relying on incidental substring luck for
# a new spec's coverage (see the S4 `multitable-comments-panel` precedent above for the same
# reasoning) -- a future rename/narrowing of `multitable-record-inspector` must not silently drop this
# file.
#
# Record inspector v3 (2026-09-05, PR-A §1.2/§1.5, docs/development/
# multitable-record-inspector-v3-design-20260905.md): `multitable-record-inspector-header` — the new
# MetaRecordInspector.vue header spec (Row A toolbar structure, kebab a11y wiring + roving + Escape-
# refocus, Row B title editing, prev/next chord, §3.3 tab-switch focus, opener focus capture/
# restore). Same incidental-substring caveat as `-resize` above (the bare `multitable-record-inspector`
# token already matches it too) — added anyway, explicit and named, same discipline.
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
# B3-07 attachment slice ⑦ (2026-07-17, approval-attachment-pipeline-design-lock): `approval-attachment-upload`
# — the client pre-validation mirror + upload client spec (apps/web/tests/approval-attachment-upload.test.ts).
#
# B3-07 §8 closeout (2026-07-20): `approval-attachment-refs` + `approval-attachment-download` —
# frozen-reference resolution plus the authenticated Blob download path. Goldens cover tombstones,
# G7 redaction inheritance (a
# server-omitted ref renders as NOTHING, not a tombstone), the no-fabricated-metadata rule, and the
# G13 stale-draft detection. Pure module, so desktop and mobile provably resolve through one helper.
# Previously ran in NO CI lane, so the client↔server rules-version parity pin and the prototype-pollution
# guard could never go red. Bare basename token; unique (no existing token is a substring of it, nor it of
# any existing token).
#
# F0 (2026-08-17, PR #4939): `approval-form-inline-editor-extract` — behavior-equivalence spec for the
# ApprovalFormInlineEditor.vue extraction (the form section pulled out of TemplateAuthoringView.vue,
# 14 emitted events, parent handlers unchanged). Added to the always-on Canvas V2 residual block below
# alongside the other approval-form-* canaries. Bare basename token; verified unique — no existing
# `approval-form-*` token (approval-form-commands / approval-form-authoring-history /
# approval-form-palette-focus / approval-form-draft) is a substring of it or vice versa.
#
# F1 (2026-08-17, delta §5 F1): `approval-form-identity` (opaque collision-resistant allocator,
# FB-D5 OPAQUE_COLLISION_RESISTANT) + `approval-form-authoring-adapter` (the single production
# command adapter over approvalFormCommands + form history: FB-D3 anchor re-resolution, FB-D4
# one-history-entry semantics, FB-D5 collision retry, FB-D6 current-draft reference provider,
# legacy-helper freeze pins). Both bare basename tokens; each verified to match exactly one file
# in isolation, and no existing token (approval-form-authoring-history is the closest neighbor)
# is a substring of either or vice versa.
#
# F2 (2026-08-17, delta §5 F2): `approval-form-drag-payload` (typed drag codec: single app MIME,
# strict decode, transient-session store), `approval-form-palette-chips` (mounted Designer 2.0
# palette: shipped-shell grouping pin, click/drag/keyboard, read-only), and
# `approval-form-builder-slots` (mounted builder: N+1 semantic slots, exact FB-D3 anchors,
# codec negatives with positive controls, stale-anchor no-op, five-trigger transient clearing,
# FB-D4 click/drag/keyboard equivalence, FB-D8 no-production-mount pin). All bare basename
# tokens; each verified to match exactly one file. Deliberate non-collisions: `approval-form-draft`
# is NOT a substring of `approval-form-drag-payload` (draft vs drag-), `approval-form-palette-focus`
# does not match `approval-form-palette-chips`, and the playwright-only
# `verification/approval-form-builder-parity.spec.ts` matches none of these tokens.
#
# UI-6 (2026-08-17, master §4 UI-6 / approval-parity-master-design-lock-20260817.md): `approval-detail-record-table`
# — ApprovalDetailView.vue's new tab anchors (审批详情/审批记录/全文评论) + audit-derived 审批记录
# table projection. Chrome only; the table derives from the SAME already-fetched store.history the
# existing parallel-aware timeline renders (no new endpoint, no second fetch), and the synthetic
# 提交/结束 bookend rows are presentation-only (never written into store.history). Bare basename
# token; verified unique against every existing `approval-detail-*` / `*-record-table*` token
# (only `approval-detail-field` exists, and neither string is a substring of the other).
#
# UI-7 (2026-08-17, approval-parity-master-design-lock-20260817.md §4 UI-7): desktop master-detail
# pane. Two new tokens: `approval-center-detail-pane-controller` (the pure generation-counter
# race-guard module, race semantics only — mirrors `approval-route-preview-controller`'s own
# dedicated unit spec) and `approval-center-master-detail` (the component-level spec: wide-vs-narrow
# gating, single-fetch-on-selection + reselect-replace, quick-action shared-handler identity via the
# `inlineApprovingId` cross-row gate, Esc/keyboard, URL restore). Both explicitly listed per this
# file's own discipline even though the pre-existing bare `approval-center` token already
# incidentally substring-matches both filenames — never rely on that incidental match alone.
#
# F3 (2026-08-17, delta §5 F3): `approval-form-field-update` (typed retype/property-update
# commands: 12 named dependency-kind refusals, identity preservation, detail-column
# update/retype/remove, adapter one-entry-per-edit) + `approval-form-field-inspector` (mounted
# Designer 2.0 selected-field inspector: committed-edit-only history, per-keystroke forbidden,
# dirty-buffer settle/block arms, values-free named refusal copy). Both bare basename tokens;
# each verified to match exactly one file in isolation; no existing token (`approval-form-draft`
# / `approval-form-drag-payload` are the closest neighbors) is a substring of either or vice
# versa, and the two new tokens do not substring-match each other.
#
# L6-P1 (2026-08-17, docs/development/approval-lock6-requester-global-policy-20260817.md §1):
# `approval-template-authoring-policy-carrier` — the RuntimePolicy authoring carrier fix (hydrate
# reflects the persisted `allowRevoke` instead of a hardcoded `true`; `buildPublishPolicy` MERGES
# onto the persisted policy instead of replacing it, so an API-set sibling field like
# `autoApproval` survives an editor republish). Bare basename token; verified to match exactly one
# file — no existing token is a substring of it (`approval-template-authoring-parallel-edit` is
# the closest neighbor, diverging at `-p`) and it is not a substring of any existing token.
#
# L8-B (2026-08-17, docs/development/approval-lock8-field-vocabulary-20260817.md §1.2): date_range
# (日期区间) — three new tokens. `approval-date-range-field` (draft carrier/buildFormSchema/
# hydration/registration-completeness/OD-L8-4 exclusion/OD-L8-8 derived-duration pure-fn specs),
# `approval-date-range-visibility` (OD-L8-5(a) per-type predicate: FE resolver, MS-9 selectable-
# dependency predicate + endpoint options, dependency-tracking dotted safety on delete/retype),
# `approval-date-range-inline-editor` (ApprovalFormInlineEditor.vue mounted spec: retype option,
# property-block render, M7 wired-not-inert controls, type-selected non-rendering negative). All
# three bare basename tokens; verified no existing token (checked the full `approval-date*` /
# `*date-range*` namespace) is a substring of any of them or vice versa — the namespace was
# entirely empty before this slice.
#
# L8-A (2026-08-17, docs/development/approval-lock8-field-vocabulary-20260817.md §1.1): explanation
# (说明) — three new tokens. `approval-explanation-field` (draft carrier/buildFormSchema A-1
# valuelessness stripping/hydration/registration-completeness/MS-9 predicate+retype-clearing/FE
# resolveVisibilityFieldReference/prefill exclusion/buildDisplayFields visibility-gated render/
# summaryFields exclusion/condition-branch exclusion pure-fn specs), `approval-explanation-inline-
# editor` (ApprovalFormInlineEditor.vue mounted spec: retype option, props.text property block, M7
# wired-not-inert control, 必填/占位文本 HIDDEN-for-explanation, type-selected non-rendering
# negative), `approval-lock8-field-type-census` (§2.1 N-1: the MS-5/MS-9 mechanical census —
# exhaustive per-type loops over `AUTHORABLE_FIELD_TYPES` with a completeness meta-check; the
# backend half lives in packages/core-backend/tests/unit/approval-lock8-field-type-census.test.ts).
# All three bare basename tokens; verified no existing token (checked the full `approval-explan*` /
# `*explanation*` / `*lock8*` / `*census*` namespace) is a substring of any of them or vice versa —
# the namespace was entirely empty before this slice (one pre-existing `lock8` hit is a doc-comment
# citation, not a test token).
#
# F4 (2026-08-18, delta §5 F4): `approval-form-builder-route-leak` — the F2-gate handoff condition 3
# real-router spec (constructs a CANCELLED navigation mid-drag; the guard clears the shared drag
# session as its first statement, before the dirty-draft confirm). The flag-gate mount/hydration/
# single-seed tests ride the ALREADY-listed `approvalTemplateAuthoring` token below (extended in the
# same PR, not a new file). Bare basename token; verified unique — no existing `approval-form-*`
# token is a substring of it or vice versa (closest neighbor `approval-form-builder-slots` diverges
# at `-r`).
#
# P1-C (2026-08-18, approval-parity-master-design-lock-20260817.md §P1-C): shipped timeout +
# threshold frontend compatibility — two new tokens. `approval-template-authoring-threshold-
# timeout-compat` (pure-logic: both allowlists' no-flatten status, linear + complex round-trip,
# mode-switch-away orphan-key cleanup, M6 dynamic-M honesty preview, linear-only fail-closed +
# positive control against the SAME `collectParallelRegionNodeKeys` the canvas nested-parallel
# guard already uses) and `approval-node-threshold-timeout-config` (mounted ApprovalGraphNode-
# ConfigEditor.vue spec: M7 every new control wired, not inert; the timeout-effect option set
# asserted against the DOM equals `NODE_TIMEOUT_SUPPORTED_EFFECTS` exactly — never invents
# auto_approve/auto_reject). Both bare basename tokens; verified no existing token in the
# `approval-template-authoring-*` / `approval-node-*` namespaces is a substring of either or vice
# versa (closest neighbors: `approval-template-authoring-approval-node-edit` and
# `approval-node-source-*`-shaped data-testids, neither collides).
# L5 (2026-08-18, docs/development/approval-lock5-node-operation-policy-20260817.md §1.1/§2.2):
# per-node operation policy (`操作权限`) — ONE new token, `approval-node-operation-policy`
# (apps/web/tests/approval-node-operation-policy.test.ts: the OD-L5-2(a)/OD-L5-3(a) pure projection,
# gate A-6 emptiness, gate A-7 mixed-state read-only + sibling preservation, gate A-3's
# four-allowlist "stays EDITABLE in BOTH editors" with the `signaturePolicy`-still-read-only positive
# control, and the linear/canvas round-trip). Bare basename token; verified unique — the
# `approval-node-` prefix is now SHARED with P1-C's `approval-node-threshold-timeout-config` (landed
# on main after this comment was first written), and neither of those two is a substring of the
# other; nor is any other neighbour (`approval-handler-node-config`, `approval-handler-node-
# authoring`, `approval-template-authoring-approval-node-edit`) a substring of it or vice versa.
# The MOUNTED Lock-5 assertions (E-1/E-2, the handler F-1 FE half) extend the already-collected
# `approval-template-authoring-canvas-inspector` and `approval-handler-node-config` specs, so they
# need no new token.
#
# P7-R1 (FAIL-0/FAIL-7, 2026-08-18): `useApprovalBatchActions` — the 批量驳回 (batch reject)
# superiority claim's core module (bounded-concurrency fan-out, per-row isolation, the
# {succeeded, failed} failure manifest). Its spec (tests/useApprovalBatchActions.spec.ts) ran
# green locally but in NO required workflow and NO guard — verified green in isolation before
# wiring. Bare basename token; verified to match exactly one file (the co-located
# src/approvals/useApprovalBatchActions.ts source module is not collected — it does not end in
# .spec.ts/.test.ts) and is not a substring of, nor contains, any existing token.
#
# P7-R1 (FAIL-0 §5 mechanical sweep, 2026-08-18): a token-coverage sweep of every approval*
# test file against the vitest-token universe of run-required-web-tests.sh +
# approval-web-guard.yml + multitable-web-guard.yml + attendance-web-guard.yml +
# plm-embed-web-guard.yml (vitest CLI filters are PATH-SUBSTRING matches, so the sweep checks
# substring containment, not just exact tokens) found 24 approval*-named files matched by NO
# lane. Two are false positives for this vitest-token method — they run via Playwright, not
# vitest (`approval-form-builder-parity.spec.ts` via playwright.approval-verification.config.ts
# / approval-browser-verify.yml; `approval-inspector-keyboard.spec.ts` via
# playwright.verification.config.ts / multitable-browser-verify.yml, FAIL-1 above). Four belong
# to the PLM line, not this one (`plmApprovalActionability`, `plmApprovalHistoryDisplay`,
# `plmApprovalInboxActionPayload`, `plmApprovalInboxFeedback` — all import from
# `src/views/plm/plmPanelModels`, not `src/approvals/**`); left for that line's owner, not
# touched here. Of the remaining 18 (all import from `src/approvals/**` /
# `src/views/approval/**`), 3 are RED today and are deliberately NOT wired (wiring a red file
# would break this gate's own green-on-arrival guarantee):
# `approvalStaticPicker` and `approvalMobileDetailActions` were ALREADY known-red (see this
# file's own "19 pre-existing red files" note above); `approval-ui-workspace` is a newly-found
# third red file (1 failing assertion: "presents template authoring as a four-step workspace").
# All three are left for triage, same as the pre-existing quarantine list. The other 15 verified
# green in isolation (`npx vitest run <token> --reporter=verbose`, zero unhandled errors) and are
# wired below; each bare-basename token verified to match exactly one file and to collide with no
# existing token in either direction.
#
# member-display-identity (2026-08-19): `approval-member-identity-coverage-enumeration` — the
# mechanical enumeration guard over every scout-table viewer-facing site (raw-id-render class),
# mirroring the backend FAIL-0 guard's wiring/presence discipline. Bare basename token; verified
# to match exactly one file and not to collide with the pre-existing `approval-member-bar-
# operation-policy` token (diverges at "bar" vs "identity", neither is a substring of the other).
#
# P5-C-1 (2026-08-20, member-action dialog grammar unification): `approval-member-action-dialog-
# grammar` — mounted coverage for the NEW chrome this slice added (six dialog-root testids, the
# transfer/return/comment confirm-disabled predicates, the stale-error-on-reopen guard now that
# `actionDialogError` backs all six dialogs instead of two) plus a pure byte-identical-strings check
# on `memberActionDialogGrammar.ts` itself. Bare basename token; verified to match exactly one
# file and not to collide with `approval-member-bar-operation-policy` or `approval-member-
# identity-coverage-enumeration` (diverges at "action-dialog-grammar", a substring of neither).
#
# Self-service tail UX (2026-08-21, staging trial fixes): three specs added.
# `tests/App.spec.ts` uses the full path, NOT the bare `App` basename — `App` is a
# substring of many other test files (e.g. `AttendanceApprovalFlowStepsEditor.spec.ts`,
# `usePlatformApps.spec.ts`, anything starting with `Approval*`, since 'Approval' itself
# starts with 'App'), so the bare token would multi-match. `attendance-date-only-format`
# and `attendance-records-route-redirect` are bare basenames, each verified to match
# exactly one file (`npx vitest run <token> --reporter=verbose` → "1 passed (1)"). New
# top-bar identity-truncation helper spec `middleEllipsis` (bare basename, same
# one-file verification) is wired alongside them.
#
# GATE-5047 rework (2026-08-21): P1 replaced the top-bar identity fix with
# accountIdentityDisplay.ts (truncateAccountIdentity) — middleEllipsis is no longer used
# directly for the email account identity; both specs are wired (`accountIdentityDisplay`
# bare basename, verified 1-file match, does not collide with `approval-member-identity-
# coverage-enumeration` or any other existing token). P2-1 added
# `attendance-date-only-format-tz-probe.spec.ts` — NOT added as a separate token: the
# EXISTING bare `attendance-date-only-format` token already substring-matches it too
# (`attendance-date-only-format` is a literal prefix of
# `attendance-date-only-format-tz-probe.spec.ts`), verified via
# `npx vitest run attendance-date-only-format --reporter=verbose` → "2 passed (2)". Its
# sibling fixture `tests/helpers/dateOnlyTzProbe.ts` is not itself collected as a test file
# (no `.spec.ts` suffix; vitest's `include` glob is `**/*.spec.ts`).
#
# S3a (2026-08-21, comments shared FE kit extraction): `shared-comments-stub-client` — the new
# tests/shared-comments-stub-client.spec.ts, proving shared/comments/composables/
# useMultitableComments works against a minimal CommentsApiClient stub with no multitable
# dependency (the seam a future approval-native storage backend implements). Bare basename token;
# verified to match exactly one file (`npx vitest run shared-comments-stub-client --reporter=verbose`
# → "7 passed (7)") and does not collide with any existing token in either direction (checked
# against the full token list in this script and multitable-web-guard.yml).
#
# Navigability audit (2026-08-22, attendance UX/navigation fixes, no business-logic change):
# three new pure-module specs. `attendanceCapabilityUnavailable` (the tab -> gating-flag ->
# display-name lookup AttendanceExperienceView.vue's enriched "Capability not available" empty
# state renders from — fix 1), `attendanceRequestReviewEntitlement` (the row-level approve/reject
# entitlement predicate AttendanceView.vue's "Recent requests" list now reads instead of gating
# solely on the deep-link-focused row — fix 2), and `attendanceFeatureOverride`
# (mergeFeatureOverrideJson/isFeatureOverrideAllowed/setLocalFeatureOverride in
# src/stores/featureFlags.ts — fix 1's local-override surfacing; deliberately NOT added via the
# pre-existing `featureFlags` token family, since tests/featureFlags.spec.ts itself is one of this
# file's own "19 pre-existing red files" quarantined above and wiring the whole suite would make
# this gate red on arrival for unrelated reasons). All three bare basename tokens; each verified to
# match exactly one file (`npx vitest run <token> --reporter=verbose`) and checked against every
# existing token in this file and attendance-web-guard.yml for substring collision in either
# direction — none found.
# S3b (2026-08-22, approval comments tab): `approval-comments-client` (tests/approval-comments-
# client.spec.ts, 20 tests — the CommentsApiClient adapter mapping S2's /api/approvals/:id/
# comments* onto the shared kit's interface, incl. pagination/truncation/ordering and the three
# unsupported-capability throws) and `approval-comments-panel` (tests/approval-comments-panel.
# spec.ts, 12 tests — the mounted 全文评论 tab wrapper: reactions/resolve absence, tombstone
# rendering, one-level threading, the member-display-identity guard, mention-candidate fetch,
# delete re-hydration). Both bare basename tokens; each verified to match exactly one file
# (`npx vitest run approval-comments-client --reporter=verbose` → "Test Files 1 passed", same for
# approval-comments-panel) and checked for collision against the full token list in this script
# and both approval-web-guard.yml / multitable-web-guard.yml.
# Fix round (gate P2-1/P2-2/P3-1/P3-2/NIT-1/NIT-2/NIT-3, 2026-08-22): client's 17 became 19 (one
# test pinning the truncation-direction fix P2-1, one a page-size-coupling drift guard NIT-1);
# panel's 10 (the comment here originally said 9 — that was wrong, NIT-3) became 12 (one
# mechanism-documentation test for P2-2, one for the previously-untested truncation notice).
# `approval-detail-record-table.spec.ts` (already wired, unaffected by this comment) also gained 1
# test — the REAL P2-2 regression guard, mounting ApprovalDetailView.vue itself and reddening if
# its `:key="route.params.id"` is removed. File-level token wiring (this script + approval-web-
# guard.yml) is unchanged — no new spec files.
# Fix round 2 (requal N-1/N-2/N-3/N-4, 2026-08-22): client's 19 became 20 — one test pinning the
# `<= capacity` branch's own `truncated` flag fix (N-2/PROBE-P1c); the truncation-window test
# rewritten in place (offset-keyed mock, id assertions moved above the call-count assertion — N-1)
# did not add a test. Panel's count is unchanged at 12 — N-3's fix (a bystander-comment assertion
# discriminating a merge-vs-replace regression on its own) extended an EXISTING test body, adding
# no new `it(...)`. File-level token wiring is unchanged — still no new spec files.
# Owner-reported live authoring bug fix (2026-08-24, ApprovalFormInlineEditor.vue detail sub-field
# `<el-table>` missing `row-key` + TemplateAuthoringView.vue's `addDetailColumn` collision-prone
# `length + 1` id scheme): NEW token `approval-detail-column-row-key` (tests/approval-detail-
# column-row-key.spec.ts, 3 tests — mounts the real TemplateAuthoringView.vue, reproduces both
# defects red-before-fix, mutation-proven). Bare basename token; verified to match exactly one
# file and checked for collision against every existing token in this script and both
# approval-web-guard.yml paths blocks (neither `approval-detail-field` nor
# `approval-detail-record-table` is a substring of it or vice versa) — none found.
# grid-commit-reliability round 3 (2026-09-05): `multitable-grid-cell-edit-commit.spec.ts` and
# `multitable-grid-cell-edit-commit-round2.spec.ts` were never wired into ANY token here (a
# control-gated grep of this script found no `grid-cell-edit-commit` substring anywhere) — added now,
# full filenames (not bare `multitable-grid-cell-edit-commit`, which is itself a substring of the
# round2 file's name and so would already match both; full names keep each token's match exact and
# independent of the other file's continued existence). `multitable-yjs-cell-editor-seed-forward.
# spec.ts` — previously executed only as an unintentional side effect of the pre-existing
# `multitable-yjs-cell-editor` bare-basename token below being a substring of its name (the exact
# footgun this script's header warns about) — was DELETED as part of this same fix (P3-1 replaced the
# mechanism it tested), so no token removal is needed: `multitable-yjs-cell-editor` still matches
# exactly `multitable-yjs-cell-editor.spec.ts` now. No other token in this file or in
# approval-web-guard.yml / multitable-web-guard.yml collides with either new filename.
set -euo pipefail
cd "$(dirname "$0")/.."
# Always-on Canvas V2 + residual PLAN 6fa2fbf6 / wave-3 canaries (files landed on main via #4815–#4826).
# #5012 (2026-08-19, human-tail finding): tests/api.spec.ts carries the omitHeaders
# MECHANIC leg (SR-1 rules/me self-service contract) — it ran in NO workflow before, so
# reverting the apiFetch delete-loop was green across every required check.
# tests/attendance-rules-me-contract-sync.spec.ts pins the FE omit set against the
# server's forbidden set BY READING THE PLUGIN SOURCE; it must live in THIS always-on
# lane because attendance-web-guard skips vitest for plugins/**-only diffs.
# These two are the first path-prefixed tokens in this bare-basename list — full paths
# chosen for exactness (a future `*-api.spec.ts` would substring-collide with a bare
# `api.spec.ts` token; today the bare token still selects exactly one file).
npx vitest run \
  tests/api.spec.ts \
  tests/attendance-rules-me-contract-sync.spec.ts \
  approval-canvas-commands \
  approval-form-commands \
  approval-authoring-history \
  approval-g5c-authoring-scenarios \
  approval-version-read-summary \
  approval-form-authoring-history \
  approval-version-dual-canvas \
  approval-flow-canvas-a11y \
  approval-flow-canvas-summary-tooltip \
  approval-canvas-inspector-a11y \
  approval-form-palette-focus \
  approval-form-inline-editor-extract \
  approval-detail-column-row-key \
  approval-form-identity \
  approval-form-authoring-adapter \
  approval-form-drag-payload \
  approval-form-palette-chips \
  approval-form-builder-slots \
  approval-form-field-update \
  approval-form-field-inspector \
  approval-form-builder-route-leak \
  approval-date-range-field \
  approval-date-range-visibility \
  approval-date-range-inline-editor \
  approval-explanation-field \
  approval-explanation-inline-editor \
  approval-lock8-field-type-census \
  approval-department-field \
  approvalDepartmentPicker \
  searchApprovalDirectoryDepartments \
  approval-node-operation-policy \
  approval-member-bar-operation-policy --reporter=dot
npx vitest run featureFlagsApprovalAttachments --reporter=dot
# Lock-9 OD-L9-10(a) (2026-08-22, FE process-attachment slice): `approval-process-attachment-dialog`
# — NEW token for the mounted comment-dialog/timeline-render spec
# (apps/web/tests/approval-process-attachment-dialog.spec.ts): affordance gating
# (attachmentPipelineEnabled && isMyTurn, proven NOT canAct in both directions), staged
# upload/remove through the process-attachment client, submitComment's attachmentIds
# key-presence discipline, cancel-close DELETE cleanup, timeline render reusing
# handleAttachmentDownload, and the loadAttachmentMetadata-watch/store.history regression (proven
# to fail RED without the dependency — see the PR body). The sibling client-logic spec
# (approval-attachment-upload-process.test.ts) is substring-covered by the pre-existing
# `approval-attachment-upload` token, but ALSO gets its own explicit `approval-attachment-upload-process`
# basename token below — `packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts`
# (a required test(18.x)/test(20.x) FAIL-0 guard) rejects incidental-substring-only coverage as
# UNCOVERED ("a future rename/narrowing of that token would silently drop this spec"), so an exact
# basename token is required for every new apps/web/tests/approval*.{test,spec}.ts file, not just a
# passing substring.
npx vitest run approval-fwb-mapping-config approval-fwb-mapping-editor --reporter=dot
npx vitest run fwb-rule-authoring-helpers fwb-rule-authoring --reporter=dot
npx vitest run tests/App.spec.ts attendance-date-only-format accountIdentityDisplay middleEllipsis attendance-records-route-redirect --reporter=dot
# E-learning V0.1 (2026-08-25) + L3 manual-grading UI (2026-08-27) + L4
# credit rules/wallet UI + content courses + titles/certificates/profile/analytics/portal
# (2026-08-30): twenty-seven
# whole-file tokens as a distinct targeted invocation so a name filter matching
# zero tests cannot skip-green. Full paths avoid substring collisions with
# future sibling specs. The L3 pair (elearning-manual-grading-client.spec.ts,
# elearning-manual-grading-view.spec.ts) covers the standalone elearning:grade
# queue/detail/submit UI added over the pre-existing manual-grading endpoints.
npx vitest run \
  tests/elearning-client.spec.ts \
  tests/elearning-analytics-admin.spec.ts \
  tests/elearning-analytics-client.spec.ts \
  tests/elearning-analytics-period.spec.ts \
  tests/elearning-content-admin.spec.ts \
  tests/elearning-content-client.spec.ts \
  tests/elearning-content-learner.spec.ts \
  tests/elearning-certificate-admin.spec.ts \
  tests/elearning-certificate-client.spec.ts \
  tests/elearning-certificate-wallet.spec.ts \
  tests/elearning-credit-admin.spec.ts \
  tests/elearning-credit-client.spec.ts \
  tests/elearning-credit-wallet.spec.ts \
  tests/elearning-learner-view.spec.ts \
  tests/elearning-admin-view.spec.ts \
  tests/elearning-routes.spec.ts \
  tests/elearning-manual-grading-client.spec.ts \
  tests/elearning-manual-grading-view.spec.ts \
  tests/elearning-learning-profile-client.spec.ts \
  tests/elearning-learning-profile-section.spec.ts \
  tests/elearning-portal-admin.spec.ts \
  tests/elearning-portal-client.spec.ts \
  tests/elearning-portal-learner.spec.ts \
  tests/elearning-practice-admin.spec.ts \
  tests/elearning-practice-client.spec.ts \
  tests/elearning-practice-learner.spec.ts \
  tests/elearning-title-admin.spec.ts \
  --reporter=dot
# Attendance group list-detail closeout (#4354): these existing specs carry the
# four-stage interaction and focused admin-rail behavior. Run them in an isolated
# single fork because attendance-admin-regressions is intentionally a large mounted suite.
NODE_OPTIONS=--max-old-space-size=8192 npx vitest run attendance-admin-regressions useAttendanceAdminRailNavigation attendance-experience-entrypoints --pool=forks --poolOptions.forks.singleFork=true --reporter=dot
# Employee overview 常用 icons (PR #5146 P1-3): these four specs must run in the required
# web-tests lane, not only locally. Tokens are exact basenames; none is a substring of
# another token already in this script (verified against useAttendanceAdmin*).
# B0 (owner-approved approval-authoring draft-save + inspector UX slice, 2026-08-24):
# `approval-template-authoring-save-minimum` — the NEW pure-function spec
# (apps/web/tests/approval-template-authoring-save-minimum.test.ts) pinning the
# save-vs-publish validation split (`validateTemplateFormFields`/`validateTemplateApprovalFlow`'s
# `{ minimal: true }` mode, `validateDetailColumnsDraft`'s same flag, `validateTemplateSaveMinimum`,
# `seedDraftIdentityForSave`). Bare basename token; verified unique — no existing
# `approval-template-authoring-*` token is a substring of it or vice versa (closest neighbor
# `approval-template-authoring-detail` diverges at the 4th word).
npx vitest run multitable-recovery-archive-client multitable-recovery-archive-modal --reporter=dot

# BOM备料 install page (§14 of multitable-application-model-20260830.md), 2026-08-31: four tokens
# added. Two are NEW specs — `StockPreparationInstallRun` (the OK/SKIP/FAIL decision and the step
# order, extracted from scripts/ops/stock-prep-acceptance-bootstrap.mjs so a reorder there reddens
# here) and `StockPreparationInstallView` (the §14 defaults panel, the verbatim preflight fixes, the
# SKIP rendering, and the R-11 gate on the run control). The other two are PRE-EXISTING specs that
# this change touches and that ran in NO workflow at all: `StockPreparationWorkspace` (the tab strip,
# which now carries the install tab) and `stockPrepPermissionMatrix` (which pins the browser mirror
# of the plugin's permission vocabulary byte-equal, and which workbenchAccess.ts was extended in).
# Substring collisions checked, since vitest's filter is a path substring match: `StockPreparation# InstallRun` / `StockPreparationInstallView` are each a substring of exactly one file and neither is
# 通知下一步 (#5442) added two more that ran in NO workflow: `StockPreparationHandoff` (the only
# witness for the handoff controls' visibility — both workbench-access mirrors say so in writing, and
# it is also the only place the partial/failed notification copy is proven to render) and
# `stockPreparationConfirmationQueue` (the sibling spec for the +150-line queue view the same PR
# changed). Substring-collision checked: `StockPreparationHandoff` matches exactly one file and is not
# a prefix of any other spec path; `stockPreparationConfirmationQueue` likewise.
#
# a substring of the other; `StockPreparationWorkspace` does NOT match the sibling
# `StockPreparationProjectWorkspaceView`; `stockPrepPermissionMatrix` matches one file. Each was
# verified green in isolation and in this batch before being wired.
# 「我的应用」landing page (#5392, 2026-08-31): the post-login/unknown-deep-link default lands here
# now instead of attendance (featureFlags.ts#resolveHomePath). `my-apps-landing-view` is the NEW
# spec (apps/web/tests/my-apps-landing-view.spec.ts — catalog-driven app cards incl. the
# empty-catalog non-crash state and the reuse of the existing route-guard decision to hide an
# unreachable card, plus the 最近打开的 Base cards reusing MultitableHomeView's own base-local-state
# store). `featureFlags.plm.spec.ts` is a PRE-EXISTING spec this change touches (resolveHomePath's
# platform-mode default moved from '/attendance' to '/home') that ran in NO workflow at all — full
# filename, not the bare `featureFlags` token, since that bare token is also a substring of the
# already-quarantined `featureFlags.spec.ts` (this file's own "19 pre-existing red files" list
# above) and wiring it in would make this gate red on arrival for an unrelated file. Both verified
# green in isolation and in this batch before being wired; neither collides with any existing token
# in either direction (checked the full token list in this file).
npx vitest run my-apps-landing-view featureFlags.plm.spec.ts --reporter=dot

# 源就绪预检 + 拓扑自测 (source readiness + topology self-test), 2026-09-01: ONE token added to the
# batch below, StockPreparationSourcePreflight — a NEW spec
# (apps/web/tests/StockPreparationSourcePreflight.spec.ts) over the same StockPreparationInstallView
# component, because the source panel lives in the 安装/体检 page beside the deployment preflight. It
# pins the four measured lines, the topology-mismatch sentence (the one that names the zero-row
# outcome the old behaviour produced silently), the gate on the run control, and the values-free
# rendering. Substring collisions checked in BOTH directions, as this file requires: the token
# matches exactly one file, is not a substring of StockPreparationInstallView /
# StockPreparationInstallRun / StockPreparationWorkspace / StockPreparationProjectWorkspaceView, and
# none of those is a substring of it. Verified green in isolation and in this batch before wiring.
# 项目备料页 + 一线拉取 (#5460), 2026-09-03: SEVEN tokens added to the batch below, and an
# executable enrolment pin added beside them so this can never silently happen again —
# packages/core-backend/tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts sweeps
# apps/web/tests/StockPreparation*.spec.ts on every run of the required test (18.x)/(20.x) contexts
# and fails on any file that is not tokenized here. An adversarial pass found that THREE new board
# specs (StockPreparationProjectBoard / ProjectSync / ProjectSyncPanel) ran in no workflow at all,
# and that FOUR older stock-prep specs (LargeBomPull, LargeBomPullPanel, OperatorProjectDirectory,
# SourceBinding) had been dark since they landed. All seven verified green in isolation and in this
# batch before being wired.
#
# SUBSTRING COLLISIONS, checked in BOTH directions as this file requires:
#   * StockPreparationProjectSync    IS a substring of StockPreparationProjectSyncPanel.spec.ts, and
#     StockPreparationLargeBomPull   IS a substring of StockPreparationLargeBomPullPanel.spec.ts —
#     so all four of those use the .spec.ts-SUFFIXED form, which each match exactly one file
#     ("...ProjectSync.spec.ts" is not a substring of "...ProjectSyncPanel.spec.ts").
#   * StockPreparationProjectBoard / StockPreparationOperatorProjectDirectory /
#     StockPreparationSourceBinding are unique: none is a substring of any existing token, and no
#     existing token is a substring of them (in particular StockPreparationProjectWorkspaceView and
#     StockPreparationSourcePreflight neither contain nor are contained by any of them).
exec npx vitest run StockPreparationProjectBoard StockPreparationProjectSync.spec.ts StockPreparationProjectSyncPanel.spec.ts StockPreparationLargeBomPull.spec.ts StockPreparationLargeBomPullPanel.spec.ts StockPreparationOperatorProjectDirectory StockPreparationSourceBinding amountAutoSum approval-amount-in-words approval-assignee-source approval-attachment-download approval-attachment-refs approval-attachment-upload approval-attachment-upload-process approval-process-attachment-dialog approvalNewView approval-center approval-center-master-detail approval-center-detail-pane-controller approval-common-template-presets approval-condition-summary approval-detail-field approval-detail-record-table approval-record-link approval-record-link-picker approval-e2e-lifecycle approval-e2e-permissions approval-member-identity-coverage-enumeration approval-member-action-dialog-grammar approval-field-visibility approval-form-draft approval-graph-layout approval-canvas-viewport approval-version-graph-overlay approval-graph-summary approval-graph-topology-edit approval-handler-node-authoring approval-handler-node-config approval-number-field-props approval-prefill-from-snapshot approval-route-preview-controller approval-route-preview-summary approval-template-authoring-approval-node-edit approval-template-authoring-canvas-inspector approval-template-authoring-save-minimum approval-template-authoring-cc-edit approval-template-authoring-complex-node-config-allowlist approval-template-authoring-threshold-timeout-compat approval-node-threshold-timeout-config approval-template-authoring-condition-edit approval-template-authoring-detail approval-template-authoring-graph-preserve approval-template-authoring-linear-step-spine approval-template-authoring-parallel-edit approval-template-route-preview-api approval-upcoming-nodes approval-urge-button-state approvalCardDecisionView approvalCenterRemindBadge approvalCenterSourceFilter approvalCenterTable approvalCenterUnreadBadge approvalDelegationStatus approvalDelegationView approvalDetailPolish approvalMetricsTopnReport approvalMetricsView approvalMobileI18n approvalMobileResponsive approvalTemplateAuthoring approvalTemplateCenterCategory approvalTemplateGovernance approvalTemplateVersionHistory approval-template-version-diff asyncStateBlock automation-action-summary automation-recipes automation-save-block-reasons automation-target-sheet-options AutomationExecutionsView comment-affordance-color-consistency DirectoryDeprovisionEvidencePanel.spec.ts directoryManagementView lineDerivation meta-automation-labels meta-filter-group meta-grid-table meta-person-delivery-viewer-migration meta-record-drawer-history-diff meta-record-drawer-i18n meta-record-drawer-restore meta-toolbar-filter-builder migration mount-behind-flow multitable-automation-manager multitable-automation-rule-editor multitable-cell-renderer-person-inactive multitable-client multitable-comment-affordance multitable-comment-inbox-realtime multitable-conditional-formatting multitable-conditional-rule multitable-config-history-modal multitable-config-revert-refresh multitable-crossbase-workbench-wiring multitable-field-manager multitable-field-visibility multitable-grid multitable-history-center-ai-shortcut-label multitable-history-center-inline-diff multitable-history-center-pinned-batch-deeplink multitable-history-fe multitable-kanban-view multitable-person-picker multitable-phase11 multitable-record-permission-manager multitable-record-restore-client multitable-reorder-view-fields multitable-required-if multitable-reset-confirm-dialog multitable-reset-tsource-picker multitable-restore-batch-dialog multitable-restore-preview-dialog multitable-rollup-aggregation-fe multitable-sheet-cursor-state multitable-sheet-permission-manager multitable-trash-fe multitable-view-manager multitable-ui multitable-workbench-1672-1673 multitable-workbench-drawer-button-wiring multitable-workbench-history-field-scope-wiring multitable-workbench-import-flow multitable-workbench-manager-flow multitable-workbench-permission-wiring multitable-workbench-restore-wiring multitable-workbench-view multitable-yjs-cell-editor multitable-yjs-scalar-cell myDelegationView newTodoPill pageShell parallelBranchRunsView requesterPreviewFields routePreviewErrors statusTag templateArchiveConfirm templateGalleryFilter ui-foundation-style-guard uiFoundationTexture useAutoSumTotal workflowHubView automation-log-redact automation-log-support-packet automation-rule-concurrent-merge meta-ai-bulk-labels meta-api-error-labels meta-api-token-labels meta-automation-delivery-viewers-i18n meta-base-picker meta-bulk-edit-labels meta-cell-editor-i18n meta-comment-composer-i18n meta-comment-labels meta-comments-drawer-i18n meta-form-share-labels meta-form-view-i18n meta-link-picker-i18n meta-link-picker-labels meta-notification-bell meta-permission-labels meta-record-labels meta-toolbar-group-picker meta-view-render-labels meta-sheet-view-rail multitable-agg-footer-grid multitable-ai-bulk-fill-composable multitable-ai-bulk-fill-dialog multitable-ai-bulk-fill-job-composable multitable-ai-bulk-fill-job-dialog multitable-ai-shortcut-cell-editor multitable-ai-shortcut-client multitable-ai-shortcut-composable multitable-ai-shortcut-drawer multitable-ai-shortcut-field-manager multitable-alt-view-comment-chip-i18n multitable-api-token-manager multitable-attachment-editor multitable-attachment-list multitable-barcode-field multitable-base-local-state multitable-build-chart-option multitable-bulk-edit-dialog multitable-button-field-config multitable-button-run-client multitable-calendar-drag-reschedule multitable-calendar-view multitable-capabilities multitable-cell-button multitable-cell-visual-display multitable-cf-scale multitable-chart-load-error multitable-chart-renderer multitable-comment-composer multitable-comment-inbox.spec.ts multitable-comment-presence multitable-comment-reactions multitable-comment-realtime multitable-comments multitable-comments-drawer multitable-conflict-ux multitable-core-i18n multitable-crossbase-link-normalizer multitable-crossbase-link-picker multitable-dashboard-view multitable-datetime-field multitable-duration-field multitable-embed-host multitable-embed-route multitable-export-dialog multitable-field-config-i18n multitable-field-display-i18n multitable-field-validation-panel multitable-form-layout multitable-form-share-manager multitable-form-view multitable-formula-dryrun-panel multitable-formula-suggest-field-manager multitable-frozen-columns-grid multitable-frozen-columns-util multitable-gallery-view multitable-gantt-view multitable-hierarchy-view multitable-home-view multitable-import multitable-import-modal multitable-link-picker multitable-linked-record-chip multitable-linked-record-popover multitable-location-field multitable-longtext-cell multitable-manager-panels-i18n multitable-mention-inbox multitable-mention-popover multitable-mention-realtime multitable-multiselect-field multitable-nongrid-summary-rendering multitable-number-format multitable-people-import multitable-person-field multitable-personal-view-toggle multitable-phase10 multitable-phase12 multitable-phase13 multitable-phase14 multitable-phase15 multitable-phase3 multitable-phase4 multitable-phase5 multitable-phase6 multitable-phase7 multitable-phase8 multitable-phase9 multitable-qrcode-field multitable-record-drawer multitable-record-drawer-button multitable-record-drawer-duplicate multitable-record-drawer-t5-migration.spec.ts multitable-record-fields-panel multitable-record-history-panel multitable-record-history-client-restored-from multitable-record-inspector multitable-record-inspector-resize multitable-record-inspector-header multitable-comments-panel multitable-record-attachments-panel multitable-record-permissions-composable multitable-richtext-editor-mention multitable-richtext-longtext multitable-richtext-mention multitable-richtext-wiring multitable-scoped-permissions multitable-sheet-presence multitable-sheet-realtime multitable-system-fields multitable-template-center-view multitable-template-detail-view multitable-timeline-view multitable-view-display-prefs-util multitable-workbench-i18n multitable-workbench.spec.ts multitable-yjs-cell-binding personal-view-client public-multitable-form view-manager-multitable-contract xlsx-mapping StockPreparationDashboardView StockPreparationStageOverview StockPreparationStageStepper StockPreparationProjectWorkspaceView StockPreparationSnapshotDiffView StockPreparationMappingConfirmView StockPreparationUnitConfirmView StockPreparationPrepLineView StockPreparationExceptionQueueView StockPreparationWorkspace StockPreparationInstallRun StockPreparationInstallView StockPreparationSourcePreflight StockPreparationPosturePlainLanguage stockPrepPermissionMatrix StockPreparationHandoff stockPreparationConfirmationQueue IntegrationStockPrepPanel conditional-formatting-dialog-i18n dingtalk-internal-view-link-warnings dingtalk-recipient-field-warnings dingtalk-public-form-link-warnings meta-grid-table-i18n.spec.ts multitable-comment-inbox-view.spec.ts multitable-b4-field-always-readonly data-sources-ui data-sources-api-preview approval-template-authoring-policy-carrier useApprovalBatchActions approval-template-authoring-errors approval-template-authoring-field-permissions approvalApiErrorSurfacing approvalCountsRealtime approvalDelegationForm approvalDelegationRoute approvalQuickPhrases approvalRecentTemplates approvalRelativeWait approvalResubmitButton approvalTemplateRouteGuard approvalUserPicker featureFlagsApprovalMobile searchApprovalDirectoryUsers useApprovalDirectory shared-comments-stub-client attendanceCapabilityUnavailable attendanceRequestReviewEntitlement attendanceFeatureOverride attendanceUserPickerEndpoint attendanceAdminEndpointCompatibility useAttendanceAdminProvisioning useAttendanceAdminUsers attendanceEmployeeQuickActionIcons attendanceEmployeeWorkspaceCommonIcons attendanceEmployeeWorkspacePresentation attendanceOverviewRequestReveal useAttendanceAdminConfig approval-comments-client approval-comments-panel multitable-grid-cell-edit-commit.spec.ts multitable-grid-cell-edit-commit-round2.spec.ts --reporter=dot
