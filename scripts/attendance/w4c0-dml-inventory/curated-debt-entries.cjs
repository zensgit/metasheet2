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

const CURATED_DEBT_ENTRIES = [
  // ---------------------------------------------------------------------------------------
  // P01-P28: section 1.1's illustrative current execution-path inventory.
  // ---------------------------------------------------------------------------------------
  {
    id: 'P01',
    title: 'Live POST /api/attendance/punch: event insert, then upsertAttendanceRecord.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    claims: (site) =>
      bySymbol(PLUGIN, /^op$/)(site) || bySymbol(PLUGIN, /^upsertAttendanceRecord$/)(site),
  },
  {
    id: 'P02',
    title: 'applyAttendanceInOutMergePolicy: second-pass record mutation after the first upsert.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    confidence: 'heuristic',
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
    claims: bySymbol(PLUGIN, /^generateAbsenceRecords$/),
  },
  {
    id: 'P04',
    title: 'Administrator POST /api/attendance/auto-absence/run: the same direct absence writer through a separate initiator.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    // Intentionally claims the SAME site as P03 — one function, two initiators, two debt ids
    // (design lock section 1.1 line 92, verbatim).
    claims: bySymbol(PLUGIN, /^generateAbsenceRecords$/),
  },
  {
    id: 'P05',
    title: 'POST /api/attendance/anomaly-result-edits: upsert followed by attachManualResultEditMarkerToRecord UPDATE.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    claims: (site) =>
      bySymbol(PLUGIN, /^applyAttendanceResultEdit$/)(site) ||
      bySymbol(PLUGIN, /^attachManualResultEditMarkerToRecord$/)(site) ||
      bySymbol(PLUGIN, /^markAttendanceResultEditNotificationStatus$/)(site),
  },
  {
    id: 'P06',
    title: 'Modern synchronous /import/commit: values, unnest, or staging INSERT...SELECT bulk upsert.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    claims: (site) =>
      bySymbol(PLUGIN, /^batchUpsertAttendanceRecords(Staging|Unnest|Values)$/)(site) ||
      bySymbol(PLUGIN, /^batchInsertAttendanceImportItems(Staging|Unnest|Values)$/)(site) ||
      bySymbol(PLUGIN, /^appendSkipped$/)(site),
  },
  {
    id: 'P07',
    title: 'Async import queue worker processAsyncImportCommitJob -> commitAttendanceImportPayload.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    // The worker calls the same commit kernel as P06/P09 (dataTypeFor cluster below); no distinct
    // worker-only DML site was independently resolved by this scan.
    claims: () => false,
  },
  {
    id: 'P08',
    title: 'Async import startup recovery that re-enqueues P07 after restart.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    claims: () => false,
  },
  {
    id: 'P09',
    title: 'Legacy POST /api/attendance/import: private per-row mapping/calculation/upsert loop.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    // `dataTypeFor` is a small `(key) => mapped[key]?.dataType` closure redeclared at five
    // unrelated locations in the plugin file; the nearest-preceding-symbol heuristic attributes
    // the surrounding legacy import mapping loop's DML to it at each location. Genuine call-graph
    // attribution is left to a future AST-based collector — see the module header note.
    claims: bySymbol(PLUGIN, /^dataTypeFor$/),
  },
  {
    id: 'P10',
    title: '/api/attendance/integrations/:id/sync: separate per-row calculation/upsert loop.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    // Integration sync shares the live-punch record upsert kernel (design lock section 1.1
    // line 92: same-function sharing gets separate debt ids).
    claims: bySymbol(PLUGIN, /^upsertAttendanceRecord$/),
  },
  {
    id: 'P11',
    title: '/import/rollback/:id: hard delete of records carrying source_batch_id.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    // Also claims the same closure's attendance_import_batches anomaly-count bookkeeping UPDATE
    // (same enclosing block as the records DELETE).
    claims: bySymbol(PLUGIN, /^isAnomaly$/),
  },
  {
    id: 'P12',
    title: 'Approval request creation/edit: pending edit overwrites mutable form_snapshot without a version.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    claims: (site) =>
      bySymbol(PLUGIN, /^resolveAttendanceRequestDraft$/)(site) ||
      (bySymbol(PLUGIN, /^buildWhere$/)(site) && site.table === 'attendance_requests' && site.verb === 'insert'),
  },
  {
    id: 'P13',
    title: 'Attendance plugin terminal handling: correction/leave/overtime and outdoor can all upsert the row.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    confidence: 'heuristic',
    claims: (site) =>
      bySymbol(PLUGIN, /^buildWhere$/)(site) ||
      bySymbol(PLUGIN, /^assertDispatchScopeAllowed$/)(site) ||
      bySymbol(PLUGIN, /^upsertAttendanceApprovalInstance$/)(site) ||
      bySymbol(PLUGIN, /^deactivateAttendanceApprovalAssignments$/)(site) ||
      bySymbol(PLUGIN, /^replaceAttendanceApprovalAssignments$/)(site),
  },
  {
    id: 'P14',
    title: 'Approved-request cancellation: balance/leave-ledger reversal only; no result reversal today.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    claims: (site) => bySymbol(PLUGIN, /^cancelRequest$/)(site) || bySymbol(PLUGIN, /^reverseLeaveBalanceDeduction$/)(site),
  },
  {
    id: 'P15',
    title: 'scripts/attendance/generate-cleanup-sql.cjs: privileged generated record/event deletes.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    claims: byPathPrefix('scripts/attendance/generate-cleanup-sql.cjs'),
  },
  {
    id: 'P16',
    title: 'Test-user cleanup and staging helpers: dynamic/direct synthetic deletes and inserts.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    claims: byPathPrefix('scripts/ops/staging-attendance-'),
  },
  {
    id: 'P17',
    title: 'Central legacy approve/reject, generic action/bridge, and any card action reaching an attendance instance.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    claims: (site) =>
      site.relPath === 'packages/core-backend/src/routes/approvals.ts' ||
      bySymbol('packages/core-backend/src/services/ApprovalBridgeService.ts', /^queryFn$/)(site),
  },
  {
    id: 'P18',
    title: 'Terminal shift_swap and schedule_dispatch write schedule assignments/group membership outside the result transaction.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
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
    // Reader-side debt (no DML) — out of this collector's write-scan scope by construction.
    claims: () => false,
  },
  {
    id: 'P21',
    title: 'Time conversion has multiple silent UTC/server-local fallback helpers without uniform IANA validation.',
    owningSlice: 'W4C-1/W4C-2',
    sharedHook: false,
    // Parsing/conversion debt, not a DML site.
    claims: () => false,
  },
  {
    id: 'P22',
    title: 'Current request terminalization has three reachable execution bodies and no reconciliation listener.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
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
    // Authorization-posture debt over the same DML site P11 already claims — no separate site.
    claims: () => false,
  },
  {
    id: 'P24',
    title: 'Integration sync has a distinct semantic pipeline; dryRun still writes the run plus last_sync_at.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    // attendance_integrations/attendance_integration_runs are bucket-allowlisted ("operational");
    // this entry documents the writer without requiring a tracked-bucket claim.
    claims: () => false,
  },
  {
    id: 'P25',
    title: 'Import token, preview/job, template-preference, upload-lifecycle, and temporary-staging writes are operational DML.',
    owningSlice: 'W4C-0',
    sharedHook: false,
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
    claims: byPathPrefix('packages/core-backend/src/services/ApprovalProductService.ts'),
  },
  {
    id: 'P27',
    title: 'Schedule publication (draft->live) writes attendance_shift_assignments/attendance_rotation_assignments to published.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    claims: bySymbol(PLUGIN, /^enforceAttendanceSchedulePublicationConflicts$/),
  },
  {
    id: 'P28',
    title: 'Core-backend onboarding default shift: POST /api/admin/users writes a default assignment.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
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
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    claims: (site) =>
      ['insertAttendanceGroupFixedScheduleAssignments', 'softDeactivateAttendanceGroupFixedScheduleManagedRows', 'skipReason'].includes(
        site.enclosingSymbol,
      ) && site.relPath === PLUGIN,
  },
  {
    id: 'X02',
    title: 'Payroll cycle summary export writes attendance_shift_assignments as a side effect (handlePayrollCycleSummaryExport).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    claims: bySymbol(PLUGIN, /^handlePayrollCycleSummaryExport$/),
  },
  {
    id: 'X03',
    title: 'Auto-shift auto-write run/run-item ledger (insertAutoShiftAutoWriteRun / insertAutoShiftAutoWriteRunItem / finalizeAutoShiftAutoWriteRun).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    claims: (site) =>
      ['insertAutoShiftAutoWriteRun', 'insertAutoShiftAutoWriteRunItem', 'finalizeAutoShiftAutoWriteRun'].includes(site.enclosingSymbol) &&
      site.relPath === PLUGIN,
  },
  {
    id: 'X04',
    title: 'Comp-time/leave ledger writers not covered by P14 (applyAnnualLeaveManualAdjustment / runAnnualLeaveAccrual / accrual-lot helpers).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: true,
    confidence: 'heuristic',
    claims: (site) =>
      ['applyAnnualLeaveManualAdjustment', 'runAnnualLeaveAccrual', 'existing', 'lots', 'skip'].includes(site.enclosingSymbol) &&
      site.relPath === PLUGIN,
  },
  {
    id: 'X05',
    title: 'AttendanceExpiryService scheduled comp-time/leave-balance expiry sweep.',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: true,
    claims: byPathPrefix('packages/core-backend/src/services/AttendanceExpiryService.ts'),
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
