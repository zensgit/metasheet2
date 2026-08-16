'use strict'

// #4556 W4C-0 Stage D — curated debt entries for the §8.4 mechanical bypass guard.
//
// Each entry claims zero or more "tracked" census sites (business/schedule_fact/shared_hook
// bucket DML — see table-classification.cjs) by (relPath, enclosingSymbol) match. A tracked site
// that no entry claims is new/unclassified debt and fails CI (§8.4). An entry's own field values
// (routeOrWorker, owningSlice, sharedHook) are this session's classification judgment, hand-built
// against the pinned baseline `e0defbe26d7f2e1747e74aa908ca710422812bf7` — see the Stage D handoff
// note for the ones flagged `confidence: 'heuristic'` (nearest-preceding-symbol attribution is not
// AST-accurate; a handful of sites land on a generic local helper name rather than the true
// enclosing route, and are grouped here by best-effort proximity, not by proven call graph).
//
// P01-P28 ids/descriptions are transcribed from the design lock's section 1.1 table
// (docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md
// lines 96-121). Entries beyond P28 (id prefix "X") are additional debt this collector's
// generated scan found that section 1.1's illustrative table did not separately name — exactly
// the case §8.4 anticipates ("The generator also discovers additional attendance-owned
// source/effect tables from the call graph"). Their owningSlice is this session's best read of
// which later W4C slice should canonicalize them, not an authoritative assignment — flagged for
// owner confirmation in the Stage D handoff.
//
// Two ids are legitimately allowed to claim the very same site (P03/P04 both claim
// `generateAbsenceRecords`, P01/P10 both claim `upsertAttendanceRecord`): the lock says so
// explicitly ("A generated inventory... records... separate debt entries even when they later
// call the same function", section 1.1 line 92).

function bySymbol(relPath, symbolPattern) {
  return (site) => site.relPath === relPath && symbolPattern.test(site.enclosingSymbol)
}

function byPathPrefix(prefix) {
  return (site) => site.relPath.startsWith(prefix)
}

const PLUGIN = 'plugins/plugin-attendance/index.cjs'
const W4C3A_RECORD_EFFECT_ADAPTER =
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-record-effects.ts'
const W4C3A_ITEM_EFFECT_ADAPTER =
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-item-effects.ts'
const W4C3A_GROUP_EFFECT_ADAPTER =
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-group-effects.ts'
const W4C3A_BATCH_EFFECT_ADAPTER =
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-batch-effects.ts'
const W4C3A_CANONICAL_IMPORT_KERNEL =
  'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts'
const W4C3A_SYNC_IMPORT_HOST =
  'packages/core-backend/src/attendance/w4c3a-sync-import-host.ts'
const W4C3A_IMPORT_ROLLBACK =
  'packages/core-backend/src/attendance/w4c3a-import-rollback.ts'
const W4C3A_IMPORT_ROLLBACK_BOUNDARY =
  'packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts'

function byW4C3aFixedEffectAdapter(site) {
  return (
    byPathPrefix(W4C3A_RECORD_EFFECT_ADAPTER)(site) ||
    byPathPrefix(W4C3A_ITEM_EFFECT_ADAPTER)(site) ||
    byPathPrefix(W4C3A_GROUP_EFFECT_ADAPTER)(site) ||
    byPathPrefix(W4C3A_BATCH_EFFECT_ADAPTER)(site)
  )
}

function byW4C3aCanonicalImportKernel(site) {
  return byPathPrefix(W4C3A_CANONICAL_IMPORT_KERNEL)(site)
}

function byW4C3aImportRollback(site) {
  return (
    byPathPrefix(W4C3A_IMPORT_ROLLBACK)(site) ||
    byPathPrefix(W4C3A_IMPORT_ROLLBACK_BOUNDARY)(site)
  )
}

// Exact P16 allowlist: relPath::enclosingSymbol::table::verb (W4C-3c hard zero-bypass).
// Enumerated from the live HEAD census of intended staging tooling writers only.
const P16_EXACT_ALLOWLIST = new Set([
  // W4+W7 combined-soak seeder (#4556 soak, PR #4929): the ONE tracked DML site in the
  // window-runner's soak-seed heredoc SQL — an idempotent (NOT EXISTS-guarded) INSERT of a
  // published group-produced assignment, mirroring the trigger-legal shape of the W7-1b e2e
  // fixture. Staging-only synthetic seeding: runs only behind assert_staging_only against
  // metasheet-staging-postgres, only for orgs the seeder has just verified hold exclusively
  // synth-w4w7-* content (customerData preflight), and never touches a posture table (those
  // go through the Gate C / W7-3 CLIs). Same class as the a2-smoke assignments insert below.
  // enclosingSymbol is (module-scope): shell heredocs have no enclosing function.
  "scripts/ops/attendance-staging-window-runner-remote.sh::(module-scope)::attendance_shift_assignments::insert",
  "scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs::cleanup::attendance_import_batches::delete",
  "scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs::cleanup::attendance_import_items::delete",
  "scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs::cleanup::attendance_record_result_edits::delete",
  "scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs::seedUsersAndRecords::attendance_records::insert",
  "scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs::cleanup::attendance_auto_shift_auto_write_runs::delete",
  "scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs::cleanup::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs::insertPunch::attendance_events::insert",
  "scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs::main::attendance_shift_assignments::insert",
  "scripts/ops/staging-attendance-c5-delivery-smoke.ts::cleanup::attendance_leave_balance_events::delete",
  "scripts/ops/staging-attendance-c5-delivery-smoke.ts::cleanup::attendance_leave_balances::delete",
  "scripts/ops/staging-attendance-c5-delivery-smoke.ts::cleanup::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-c5-delivery-smoke.ts::seedCompTimeBalance::attendance_leave_balances::insert",
  "scripts/ops/staging-attendance-dispatch-d5-smoke.mjs::cleanupStep::approval_assignments::delete",
  "scripts/ops/staging-attendance-dispatch-d5-smoke.mjs::cleanupStep::approval_instances::delete",
  "scripts/ops/staging-attendance-dispatch-d5-smoke.mjs::cleanupStep::approval_records::delete",
  "scripts/ops/staging-attendance-dispatch-d5-smoke.mjs::cleanupStep::attendance_requests::delete",
  "scripts/ops/staging-attendance-dispatch-d5-smoke.mjs::cleanupStep::attendance_schedule_dispatch_requests::delete",
  "scripts/ops/staging-attendance-dispatch-d5-smoke.mjs::cleanupStep::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs::cleanup::approval_instances::delete",
  "scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs::cleanup::approval_assignments::delete",
  "scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs::cleanup::approval_instances::delete",
  "scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs::cleanup::approval_records::delete",
  "scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs::seedPartialRecord::attendance_records::insert",
  "scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs::assertStaleCandidate409::attendance_records::update",
  "scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs::seedCandidateRecords::attendance_requests::insert",
  "scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs::seedOwedPunchRecord::attendance_records::insert",
  "scripts/ops/staging-attendance-multi-shift-m5-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-multi-shift-m5-smoke.mjs::cleanup::attendance_rotation_assignments::delete",
  "scripts/ops/staging-attendance-multi-shift-m5-smoke.mjs::cleanup::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::assertStatutoryMustPaySetup::attendance_leave_balances::insert",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::cleanup::approval_assignments::delete",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::cleanup::approval_instances::delete",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::cleanup::approval_records::delete",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::cleanup::attendance_leave_balances::delete",
  "scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs::cleanup::attendance_leave_balance_events::delete",
  "scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs::cleanup::attendance_leave_balances::delete",
  "scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-report-sync-a2-smoke.mjs::seedAttendanceRecord::attendance_records::insert",
  "scripts/ops/staging-attendance-schedule-publish-p4-smoke.mjs::cleanup::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs::cleanupStep::approval_assignments::delete",
  "scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs::cleanupStep::approval_instances::delete",
  "scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs::cleanupStep::approval_records::delete",
  "scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs::cleanupStep::attendance_requests::delete",
  "scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs::cleanupStep::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs::cleanup::attendance_events::delete",
  "scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs::cleanup::attendance_requests::delete",
  "scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs::cleanup::attendance_shift_assignments::delete",
  "scripts/ops/staging-attendance-tooling-teardown.mjs::runStagingAttendanceRecordTeardown::attendance_records::delete",
])

const CURATED_DEBT_ENTRIES = [
  // ---------------------------------------------------------------------------------------
  // P01-P28: section 1.1's illustrative current execution-path inventory.
  // ---------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------
  // P01-P04 — REMOVED BY THE W4C-2 CANONICAL ADAPTER CUTOVER (lock §12.3: "P01 live, P02 merge
  // second-pass, P03 cron absence, and P04 administrator-run absence inventory entries are
  // removed independently"). Each entry stays in this list with `canonicalizedBy: 'W4C-2'` and
  // KEEPS its claim predicate over the (renamed) adapter-owned sites, so the §8.4 unclaimed=0
  // detection is not bypassed: the DML text still exists (as the closed legacy adapters the
  // boundary executes), and a new/renamed writer site still fails CI. The P02 second mutable
  // post-upsert pass no longer exists on the live path at all — the pure host-port
  // `applyMergePolicyPure` decision precedes the single record write.
  // ---------------------------------------------------------------------------------------
  {
    id: 'P01',
    title: 'Live POST /api/attendance/punch: event insert, then upsertAttendanceRecord.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    canonicalizedBy: 'W4C-2',
    // Gate D2 (#4844) SPLIT `applyLivePunchProjectionLegacyV1`: its `attendance_events` INSERT
    // moved verbatim into the new `insertLivePunchEventV1` seam (which the legacy adapter itself
    // now calls, so the two paths are one writer), and the authoritative boundary branch calls
    // that seam directly while skipping the `attendance_records` upsert. The DML is the SAME P01
    // live-punch event insert under a new enclosing symbol — claimed here per-writer rather than
    // registered as a new debt id, exactly as this entry's own header describes for renamed
    // adapter-owned sites. A genuinely NEW event/record writer added to the plugin still fails CI.
    claims: (site) =>
      bySymbol(PLUGIN, /^applyLivePunchProjectionLegacyV1$/)(site) ||
      bySymbol(PLUGIN, /^insertLivePunchEventV1$/)(site) ||
      bySymbol(PLUGIN, /^op$/)(site) ||
      bySymbol(PLUGIN, /^upsertAttendanceRecord$/)(site),
  },
  {
    id: 'P02',
    title: 'applyAttendanceInOutMergePolicy: second-pass record mutation after the first upsert.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-2',
    // Not independently visible as its own census group in this scan (its UPDATE statement's
    // nearest-preceding-symbol match lands on a different local closure) — see Stage D handoff
    // "未竟" note. Kept as a named zero-claim entry rather than omitted, so a future regeneration
    // that DOES resolve it correctly is a visible improvement, not a silent new debt id.
    claims: () => false,
  },
  {
    id: 'P03',
    title: "Scheduled cron callback: runAutoAbsenceForOrgDate -> generateAbsenceRecords direct record insert.",
    owningSlice: 'W4C-2',
    sharedHook: false,
    canonicalizedBy: 'W4C-2',
    claims: bySymbol(PLUGIN, /^generateAbsenceRecords$/),
  },
  {
    id: 'P04',
    title: 'Administrator POST /api/attendance/auto-absence/run: the same direct absence writer through a separate initiator.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    canonicalizedBy: 'W4C-2',
    // Intentionally claims the SAME site as P03 — one function, two initiators, two debt ids
    // (design lock section 1.1 line 92, verbatim).
    claims: bySymbol(PLUGIN, /^generateAbsenceRecords$/),
  },
  {
    id: 'P05',
    title: 'POST /api/attendance/anomaly-result-edits: upsert followed by attachManualResultEditMarkerToRecord UPDATE.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Post-write meta patch removed; marker is frozen in the same projection write.
    // Remaining sites are the audit-row insert and notification status update on the
    // operational audit table — claimed so unclaimed=0 detection stays live.
    // Current-tree claims only. The removed post-write attachManualResultEditMarkerToRecord
    // symbol is NOT retained here — pinned-baseline coverage of that historical site is a
    // separately named obligation (pinned-baseline-obligation.cjs), not a live claim crutch.
    // Per-writer evidence only (no broad path allowlist). Named adapters:
    // - legacy AE-1 single-write path (byte-compat)
    // - W4 calculation append (manual_edit)
    // - audit/notification operational writers
    claims: (site) =>
      bySymbol(PLUGIN, /^applyAttendanceResultEdit$/)(site) ||
      bySymbol(PLUGIN, /^markAttendanceResultEditNotificationStatus$/)(site) ||
      bySymbol(PLUGIN, /^insertW4c3cManualResultEditAuditRow$/)(site) ||
      bySymbol(
        'packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts',
        /^appendManualOverrideCalculationV1$/,
      )(site) ||
      bySymbol(
        'packages/core-backend/src/attendance/w4c3c-recompute.ts',
        /^appendRecomputeCalculationV1$/,
      )(site),
  },
  {
    id: 'P06',
    title: 'Modern synchronous /import/commit: values, unnest, or staging INSERT...SELECT bulk upsert.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    claims: (site) =>
      bySymbol(PLUGIN, /^batchUpsertAttendanceRecords(Staging|Unnest|Values)$/)(site) ||
      bySymbol(PLUGIN, /^batchInsertAttendanceImportItems(Staging|Unnest|Values)$/)(site) ||
      bySymbol(PLUGIN, /^appendSkipped$/)(site) ||
      (bySymbol(PLUGIN, /^approvedOvertimeWindows$/)(site) && site.table === 'attendance_import_batches') ||
      byW4C3aFixedEffectAdapter(site) ||
      byW4C3aCanonicalImportKernel(site) ||
      byPathPrefix(W4C3A_SYNC_IMPORT_HOST)(site),
  },
  {
    id: 'P07',
    title: 'Async import queue worker processAsyncImportCommitJob -> commitAttendanceImportPayload.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-3a',
    // The worker calls the same commit kernel as P06/P09 (dataTypeFor cluster below); no distinct
    // worker-only DML site was independently resolved by this scan.
    claims: (site) =>
      byW4C3aFixedEffectAdapter(site) ||
      byW4C3aCanonicalImportKernel(site) ||
      (bySymbol(PLUGIN, /^approvedOvertimeWindows$/)(site) && site.table === 'attendance_import_batches'),
  },
  {
    id: 'P08',
    title: 'Async import startup recovery that re-enqueues P07 after restart.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    claims: (site) =>
      byW4C3aFixedEffectAdapter(site) ||
      byW4C3aCanonicalImportKernel(site),
  },
  {
    id: 'P09',
    title: 'Legacy POST /api/attendance/import: private per-row mapping/calculation/upsert loop.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-3a',
    // `dataTypeFor` is a small `(key) => mapped[key]?.dataType` closure redeclared at five
    // unrelated locations in the plugin file; the nearest-preceding-symbol heuristic attributes
    // the surrounding legacy import mapping loop's DML to it at each location. Genuine call-graph
    // attribution is left to a future AST-based collector — see the module header note.
    claims: (site) =>
      bySymbol(PLUGIN, /^dataTypeFor$/)(site) ||
      (bySymbol(PLUGIN, /^approvedOvertimeWindows$/)(site) && site.table === 'attendance_import_batches') ||
      byW4C3aFixedEffectAdapter(site) ||
      byW4C3aCanonicalImportKernel(site),
  },
  {
    id: 'P10',
    title: '/api/attendance/integrations/:id/sync: separate per-row calculation/upsert loop.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // Integration sync shares the live-punch record upsert kernel (design lock section 1.1
    // line 92: same-function sharing gets separate debt ids).
    claims: (site) =>
      bySymbol(PLUGIN, /^upsertAttendanceRecord$/)(site) ||
      byW4C3aCanonicalImportKernel(site),
  },
  {
    id: 'P11',
    title: '/import/rollback/:id: hard delete of records carrying source_batch_id.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-3a',
    // Also claims the same closure's attendance_import_batches anomaly-count bookkeeping UPDATE
    // (same enclosing block as the records DELETE).
    claims: (site) =>
      bySymbol(PLUGIN, /^isAnomaly$/)(site) ||
      byW4C3aImportRollback(site),
  },
  {
    id: 'P12',
    title: 'Approval request creation/edit: pending edit overwrites mutable form_snapshot without a version.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
    claims: (site) =>
      bySymbol(
        PLUGIN,
        /^(?:executeGenericRequestCreate|executeOutdoorRequestCreate|executeScheduleDispatchRequestCreate|executeShiftSwapRequestCreate|executeRequestPendingEdit)$/,
      )(site) ||
      bySymbol(PLUGIN, /^resolveAttendanceRequestDraft$/)(site) ||
      (bySymbol(PLUGIN, /^include$/)(site) && site.table === 'attendance_requests') ||
      (bySymbol(PLUGIN, /^buildWhere$/)(site) && site.table === 'attendance_requests' && site.verb === 'insert') ||
      (bySymbol(PLUGIN, /^approvedOvertimeWindows$/)(site) && site.table === 'attendance_requests' && site.verb === 'insert'),
  },
  {
    id: 'P13',
    title: 'Attendance plugin terminal handling: correction/leave/overtime and outdoor can all upsert the row.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-3b',
    claims: (site) =>
      bySymbol(PLUGIN, /^(?:executeRequestCancel|executeShiftSwapConsent)$/)(site) ||
      bySymbol(PLUGIN, /^buildWhere$/)(site) ||
      bySymbol(PLUGIN, /^assertDispatchScopeAllowed$/)(site) ||
      bySymbol(PLUGIN, /^resolveLockedAttendanceApprovalFlowState$/)(site) ||
      bySymbol(PLUGIN, /^upsertAttendanceApprovalInstance$/)(site) ||
      bySymbol(PLUGIN, /^deactivateAttendanceApprovalAssignments$/)(site) ||
      bySymbol(PLUGIN, /^replaceAttendanceApprovalAssignments$/)(site),
  },
  {
    id: 'P14',
    title: 'Approved-request cancellation: balance/leave-ledger reversal only; no result reversal today.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
    claims: (site) =>
      byPathPrefix('packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts')(site) ||
      bySymbol(PLUGIN, /^lockLatestRequestSnapshotToken$/)(site) ||
      bySymbol(PLUGIN, /^cancelRequest$/)(site) ||
      bySymbol(PLUGIN, /^reverseLeaveBalanceDeduction$/)(site),
  },
  {
    id: 'P15',
    title: 'scripts/attendance/generate-cleanup-sql.cjs: privileged generated record/event deletes.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Generator no longer emits live DELETE on attendance_records. Canonical writer
    // is appendOperatorRetirementCalculationV1 (ops_retirement boundary body).
    claims: (site) =>
      bySymbol(
        'packages/core-backend/src/attendance/w4c3c-ops-retirement.ts',
        /^appendOperatorRetirementCalculationV1$/,
      )(site),
  },
  {
    id: 'P16',
    title: 'Test-user cleanup and staging helpers: dynamic/direct synthetic deletes and inserts.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Exact allowlist keyed by relPath + enclosingSymbol + table + verb.
    // A new DELETE/INSERT/UPDATE under an allowed file/symbol but different table/verb
    // remains unclaimed (hard zero-bypass). No broad startsWith/prefix claims.
    claims: (site) => P16_EXACT_ALLOWLIST.has(
      `${site.relPath}::${site.enclosingSymbol}::${site.table}::${site.verb}`,
    ),
  },
  {
    id: 'P17',
    title: 'Central legacy approve/reject, generic action/bridge, and any card action reaching an attendance instance.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
    claims: (site) =>
      site.relPath === 'packages/core-backend/src/routes/approvals.ts' ||
      bySymbol('packages/core-backend/src/services/ApprovalBridgeService.ts', /^queryFn$/)(site),
  },
  {
    id: 'P18',
    title: 'Terminal shift_swap and schedule_dispatch write schedule assignments/group membership outside the result transaction.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
    claims: (site) =>
      [
        'archiveScheduleDispatchSourceKey',
        'archiveShiftSwapSourceKey',
        'closeScheduleDispatchRequest',
        'finalizeScheduleDispatchRequest',
        'finalizeShiftSwapRequest',
        'insertShiftSwapReplacementAssignment',
        'respondShiftSwapConsent',
      ].includes(site.enclosingSymbol) && site.relPath === PLUGIN,
  },
  {
    id: 'P19',
    title: 'Decision/cancellation request lookup plus global permission bypass lacks an explicit org-bound authorization contract.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
    // Not a DML-shaped debt entry (it is an authorization-contract gap, not a write site);
    // recorded for completeness per §8.4's "naming every current command route... and planned
    // canonical adapter", not because this collector's DML scan can independently locate it.
    claims: () => false,
  },
  {
    id: 'P20',
    title: 'Anomaly, makeup-anomaly facts, open-record attribution, and DecisionTrace are direct ordinary readers.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Reader-side debt (no DML) — closed by canonical active-current helper on all four surfaces.
    claims: () => false,
  },
  {
    id: 'P21',
    title: 'Time conversion has multiple silent UTC/server-local fallback helpers without uniform IANA validation.',
    owningSlice: 'W4C-1/W4C-2',
    sharedHook: false,
    // Honest residual: W4 authority paths use w4c1-strict-time; legacy_projection_only
    // preserves current parsing; shadow records non-promotable review. Not a DML site.
    // Residual classification closed in W4C-1/W4C-2; W4C-3c records completion for zero-bypass.
    canonicalizedBy: 'W4C-1/W4C-2',
    residualClassification: 'strict_parse_authority_closed_legacy_byte_preserved',
    claims: () => false,
  },
  {
    id: 'P22',
    title: 'Current request terminalization has three reachable execution bodies and no reconciliation listener.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
    // Structural coverage: the three bodies are the plugin's own terminal routes (P13), the
    // central legacy routes (P17), and ApprovalProductService's generic node advancement (P26).
    // No independent DML site of its own.
    claims: () => false,
  },
  {
    id: 'P23',
    title: '/import/rollback/:id accepts a broader authorization posture than import commit.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // Authorization-posture debt over the same DML site P11 already claims — no separate site.
    claims: () => false,
  },
  {
    id: 'P24',
    title: 'Integration sync has a distinct semantic pipeline; dryRun still writes the run plus last_sync_at.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // attendance_integrations/attendance_integration_runs are bucket-allowlisted ("operational");
    // this entry documents the writer without requiring a tracked-bucket claim.
    claims: () => false,
  },
  {
    id: 'P25',
    title: 'Import token, preview/job, template-preference, upload-lifecycle, and temporary-staging writes are operational DML.',
    owningSlice: 'W4C-0',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // The tables this entry names (attendance_import_tokens/template_prefs/*_stage/jobs) are all
    // "operational"-bucket in table-classification.cjs, i.e. allowlisted at the bucket level —
    // exactly the classification this entry itself calls for. No tracked-bucket site to claim.
    claims: () => false,
  },
  {
    id: 'P26',
    title: 'Central approval assignment mutation is not one route (admin/reassign, generic approve/return/revoke/jump/...).',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
    claims: byPathPrefix('packages/core-backend/src/services/ApprovalProductService.ts'),
  },
  {
    id: 'P27',
    title: 'Schedule publication (draft->live) writes attendance_shift_assignments/attendance_rotation_assignments to published.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
    claims: bySymbol(PLUGIN, /^enforceAttendanceSchedulePublicationConflicts$/),
  },
  {
    id: 'P28',
    title: 'Core-backend onboarding default shift: POST /api/admin/users writes a default assignment.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
    claims: bySymbol('packages/core-backend/src/routes/admin-users.ts', /^body$/),
  },

  // ---------------------------------------------------------------------------------------
  // X01-X08: additional debt this scan found that section 1.1's illustrative table did not
  // separately name (§8.4: "the generator also discovers additional attendance-owned
  // source/effect tables from the call graph"). owningSlice is a best-effort read, flagged for
  // owner confirmation — see the Stage D handoff "未竟/两读" note.
  // ---------------------------------------------------------------------------------------
  {
    id: 'X01',
    title: 'Fixed-schedule group assignment writer (insertAttendanceGroupFixedScheduleAssignments / softDeactivateAttendanceGroupFixedScheduleManagedRows / skipReason).',
    // owningSlice string preserved for pinned-baseline artifact byte parity; residual closed by W4C-3c.
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    // Honest residual: schedule_fact writer (not daily result calculation). Same family as P27/P18.
    // Not a W4 result-operation bypass; remains claimed so unclaimed=0 stays live.
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_schedule_fact',
    // Evidence: table-classification bucket schedule_fact for attendance_shift_assignments;
    // these writers change which shift applies, not attendance_records calculation truth.
    residualEvidence: 'TABLE_BUCKETS.attendance_shift_assignments=schedule_fact; symbols are fixed-schedule assignment writers only',
    claims: (site) =>
      ['insertAttendanceGroupFixedScheduleAssignments', 'softDeactivateAttendanceGroupFixedScheduleManagedRows', 'skipReason'].includes(
        site.enclosingSymbol,
      ) && site.relPath === PLUGIN && site.table === 'attendance_shift_assignments',
  },
  {
    id: 'X02',
    title: 'Payroll cycle summary export writes attendance_shift_assignments as a side effect (handlePayrollCycleSummaryExport).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_schedule_fact',
    residualEvidence: 'TABLE_BUCKETS.attendance_shift_assignments=schedule_fact; export side-effect assignment DML only',
    claims: (site) =>
      bySymbol(PLUGIN, /^handlePayrollCycleSummaryExport$/)(site) && site.table === 'attendance_shift_assignments',
  },
  {
    id: 'X03',
    title: 'Auto-shift auto-write run/run-item ledger (insertAutoShiftAutoWriteRun / insertAutoShiftAutoWriteRunItem / finalizeAutoShiftAutoWriteRun).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_schedule_fact_ledger',
    residualEvidence: 'TABLE_BUCKETS.attendance_auto_shift_auto_write_runs*=schedule_fact; run ledger not daily projection',
    claims: (site) =>
      ['insertAutoShiftAutoWriteRun', 'insertAutoShiftAutoWriteRunItem', 'finalizeAutoShiftAutoWriteRun'].includes(site.enclosingSymbol) &&
      site.relPath === PLUGIN &&
      (site.table === 'attendance_auto_shift_auto_write_runs' || site.table === 'attendance_auto_shift_auto_write_run_items'),
  },
  {
    id: 'X04',
    title: 'Comp-time/leave ledger writers not covered by P14 (applyAnnualLeaveManualAdjustment / runAnnualLeaveAccrual / accrual-lot helpers).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: true,
    confidence: 'heuristic',
    // Honest residual: shared_hook leave/comp-time ledger, not attendance daily-result truth.
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_shared_hook_ledger',
    residualEvidence: 'TABLE_BUCKETS.attendance_leave_balances/events/accrual_*=shared_hook; no attendance_records DML',
    claims: (site) =>
      ['applyAnnualLeaveManualAdjustment', 'runAnnualLeaveAccrual', 'existing', 'lots', 'skip'].includes(site.enclosingSymbol) &&
      site.relPath === PLUGIN &&
      [
        'attendance_leave_balances',
        'attendance_leave_balance_events',
        'attendance_leave_accrual_runs',
        'attendance_leave_accrual_run_items',
        'attendance_leave_manual_adjustments',
      ].includes(site.table),
  },
  {
    id: 'X06',
    title: 'W4C-2 Gate D1 authoritative-result-write CORE: the parent-pointer/visibility move on attendance_records for a completed or reversed authoritative calculation (§7.5). INERT — no production caller; D2 wires live_punch, D3 wires scheduled.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    // NOT the 'W4C-2' removed-by-adapter marker (that exact set is pinned to the four legacy P01-P04
    // writers). This is the canonical authoritative WRITER Gate D1 adds, not a legacy site being
    // canonicalized away — its own Gate-D1 marker.
    canonicalizedBy: 'W4C-2-gate-d1',
    // The only tracked business DML in this INERT core is the attendance_records UPDATE that moves
    // the parent pointer/owner/visibility to the just-appended authoritative row (completed →
    // set_active; reversal → restore/retire). The calc/segment INSERTs target the append-only
    // immutable tables (not the business daily-row bucket). Claimed per-writer by symbol so a new
    // attendance_records writer added to this file cannot inherit the claim silently.
    claims: (site) =>
      bySymbol(
        'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts',
        /^writeCompletedRow$/,
      )(site) ||
      bySymbol(
        'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts',
        /^writeAuthoritativeReversalV1$/,
      )(site),
  },
  {
    id: 'X07',
    title: 'W4C-2 Gate D2/D3 authoritative branches: the create-if-absent review-path parent placeholder INSERT on attendance_records (§7.5 F6 parent-state install).',
    owningSlice: 'W4C-2',
    sharedHook: false,
    // Gate D3 (#4844) CLASSIFICATION NOTE — measured with the collectors, not reasoned:
    //   * the scheduled authoritative branch's placeholder creation is a CALL to the same
    //     `insertAuthoritativeReviewPlaceholderParentV1` helper this entry claims BY SYMBOL, so it
    //     adds no new DML statement text and no new census site. The `bySymbol` claim is exactly
    //     what makes a second call site inert here while still refusing a genuinely NEW
    //     attendance_records writer added to the boundary file;
    //   * the core call, the first production `recordAttendanceScheduledRunTargetOutcomeV1('failed')`
    //     call and the `cancelAttendanceResultOperationV1` call are CALLS into already-claimed
    //     writers (the D1 core / the run registry / the operation registry), not new DML;
    //   * D3 REMOVES `applyScheduledAbsenceLegacy` from the authoritative arm — a classification
    //     change rather than a new site: that adapter's own INSERT..SELECT stays claimed for the
    //     legacy/shadow/legacy_compat paths that still call it;
    //   * the branch's `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` statements carry
    //     no verb the DML scanner tracks.
    // Collector output on the D3 head: unclaimed = 0, with no census hand-edit.
    // Its own Gate-D2 marker, not the 'W4C-2' removed-by-adapter marker (pinned to the four
    // legacy P01-P04 writers) and not Gate D1's. This is the canonical authoritative-path parent
    // creator D2 adds, not a legacy site being canonicalized away.
    canonicalizedBy: 'W4C-2-gate-d2',
    // The ONLY business-bucket DML the D2 boundary branch adds: an `ON CONFLICT DO NOTHING`
    // INSERT that installs the retired/`review_placeholder` parent when the day has no record
    // yet, so the D1 core (whose `lockParent` fails RECORD_NOT_FOUND on an absent parent, and
    // whose `writeReviewRow` never touches `attendance_records`) has a parent to write against.
    // Every other write on that path belongs to an already-claimed owner: the punch event INSERT
    // is P01's (via `insertLivePunchEventV1`), and the parent pointer/visibility move is X06's
    // (the core's own `writeCompletedRow`). Claimed per-writer BY SYMBOL so a future
    // attendance_records writer added to this boundary file cannot inherit the claim silently.
    claims: bySymbol(
      'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts',
      /^insertAuthoritativeReviewPlaceholderParentV1$/,
    ),
  },
  {
    id: 'X05',
    title: 'AttendanceExpiryService scheduled comp-time/leave-balance expiry sweep.',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: true,
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_shared_hook_ledger',
    residualEvidence: 'AttendanceExpiryService only touches leave balance ledger tables (shared_hook), never attendance_records',
    claims: (site) =>
      site.relPath === 'packages/core-backend/src/services/AttendanceExpiryService.ts' &&
      (site.table === 'attendance_leave_balances' || site.table === 'attendance_leave_balance_events'),
  },
]

// Non-attendance generic-shared-function allowlist (§8.4: "Shared tables such as
// approval_instances... cannot be banned globally because non-attendance products legitimately
// use them"). These sites are demonstrably reached only from a different product's own code path
// (a distinct service name, seed/test tooling for the generic approval product, or a generic
// bridge migration backfill) with no attendance-specific discriminator anywhere in the call path
// this scan can see. They are allowlisted by name, not required to carry a P0x/X0x id — but they
// ARE still recorded here (not silently dropped) so a reviewer can see exactly what was excluded
// and why.
const GENERIC_SHARED_ALLOWLIST = [
  { relPath: 'packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts', reason: 'named generic bridge for a different product (after-sales), not attendance' },
  { relPath: 'packages/core-backend/scripts/test-approvals-contract.mjs', reason: 'generic approval-product contract test tooling' },
  { relPath: 'packages/core-backend/src/seeds/seed-approvals.ts', reason: 'generic approval-product seed script' },
  { relPath: 'packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts', reason: 'generic approval-bridge schema/backfill migration, not attendance-specific' },
]

function isGenericSharedAllowlisted(site) {
  return GENERIC_SHARED_ALLOWLIST.some((entry) => site.relPath === entry.relPath)
}

module.exports = { CURATED_DEBT_ENTRIES, GENERIC_SHARED_ALLOWLIST, isGenericSharedAllowlisted }
