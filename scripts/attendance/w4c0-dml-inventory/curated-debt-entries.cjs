'use strict'

// #4556 W4C-0 Stage D — curated debt entries for the §8.4 mechanical bypass guard.
//
// THIS FILE IS METADATA ONLY. It carries each debt entry's id, title, owning slice, shared-hook
// flag, canonicalizedBy marker and residual classification. It does NOT carry claim logic.
//
// An entry's `claims` predicate is DERIVED, uniformly, from the frozen approved-site-identity
// table (approved-site-identities.cjs): an entry claims exactly those census sites whose
// (relPath, enclosingSymbol, table, verb) identity is listed in that table with this entry's id.
// The derivation happens in one place, at the bottom of this file, over the whole array — an
// entry cannot declare a predicate of its own, so `relPath === <file>`, `relPath.startsWith(...)`
// and bare `bySymbol(file, /regex/)` claims are not merely discouraged here, they are
// unexpressible.
//
// This replaces the previous model, in which each entry hand-wrote a predicate. That model was
// mechanically bypassable: a whole-file or path-prefix claim admitted every present and FUTURE
// write site in that file, so adding `INSERT INTO attendance_records` to an already-approved
// file left the exact-head HEAD scan green. Approval now attaches to a specific site occurring
// an exact pinned number of times, never to a file or a prefix. See the approved-site-identities
// module header for the full property statement and the stated residue.
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
// call the same function", section 1.1 line 92). In the identity table this shows up as one row
// carrying two entry ids — which is exactly one approved site, counted once, owned twice.

const {
  APPROVED_SITE_IDENTITIES,
  APPROVED_SITE_IDENTITY_BY_KEY,
  GENERIC_SHARED_IDENTITY_KEYS,
  approvedIdentityKeysForEntry,
  siteIdentityKey,
} = require('./approved-site-identities.cjs')

const CURATED_DEBT_ENTRY_METADATA = [
  // ---------------------------------------------------------------------------------------
  // P01-P28: section 1.1's illustrative current execution-path inventory.
  // ---------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------
  // P01-P04 — REMOVED BY THE W4C-2 CANONICAL ADAPTER CUTOVER (lock §12.3: "P01 live, P02 merge
  // second-pass, P03 cron absence, and P04 administrator-run absence inventory entries are
  // removed independently"). Each entry stays in this list with `canonicalizedBy: 'W4C-2'` and
  // KEEPS its approved identities over the (renamed) adapter-owned sites, so the §8.4
  // unclaimed=0 detection is not bypassed: the DML text still exists (as the closed legacy
  // adapters the boundary executes), and a new/renamed writer site still fails CI. The P02
  // second mutable post-upsert pass no longer exists on the live path at all — the pure
  // host-port `applyMergePolicyPure` decision precedes the single record write.
  // ---------------------------------------------------------------------------------------
  {
    id: 'P01',
    title: 'Live POST /api/attendance/punch: event insert, then upsertAttendanceRecord.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    canonicalizedBy: 'W4C-2',
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
    // "未竟" note. Kept as a named zero-identity entry rather than omitted, so a future
    // regeneration that DOES resolve it correctly is a visible improvement, not a silent new
    // debt id.
  },
  {
    id: 'P03',
    title: "Scheduled cron callback: runAutoAbsenceForOrgDate -> generateAbsenceRecords direct record insert.",
    owningSlice: 'W4C-2',
    sharedHook: false,
    canonicalizedBy: 'W4C-2',
  },
  {
    id: 'P04',
    title: 'Administrator POST /api/attendance/auto-absence/run: the same direct absence writer through a separate initiator.',
    owningSlice: 'W4C-2',
    sharedHook: false,
    canonicalizedBy: 'W4C-2',
    // Intentionally shares the SAME identity row as P03 — one function, two initiators, two debt
    // ids (design lock section 1.1 line 92, verbatim). One approved site, counted once.
  },
  {
    id: 'P05',
    title: 'POST /api/attendance/anomaly-result-edits: upsert followed by attachManualResultEditMarkerToRecord UPDATE.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Post-write meta patch removed; marker is frozen in the same projection write.
    // Remaining sites are the audit-row insert and notification status update on the
    // operational audit table — approved so unclaimed=0 detection stays live.
    // Current-tree identities only. The removed post-write attachManualResultEditMarkerToRecord
    // symbol is NOT retained here — pinned-baseline coverage of that historical site is a
    // separately named obligation (pinned-baseline-obligation.cjs), not a live claim crutch.
  },
  {
    id: 'P06',
    title: 'Modern synchronous /import/commit: values, unnest, or staging INSERT...SELECT bulk upsert.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
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
  },
  {
    id: 'P08',
    title: 'Async import startup recovery that re-enqueues P07 after restart.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
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
    // attribution is left to a future AST-based collector — see the module header note. Those
    // repeats are now pinned by multiplicity rather than admitted by a symbol regex.
  },
  {
    id: 'P10',
    title: '/api/attendance/integrations/:id/sync: separate per-row calculation/upsert loop.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // Integration sync shares the live-punch record upsert kernel (design lock section 1.1
    // line 92: same-function sharing gets separate debt ids).
  },
  {
    id: 'P11',
    title: '/import/rollback/:id: hard delete of records carrying source_batch_id.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-3a',
    // Also owns the same closure's attendance_import_batches anomaly-count bookkeeping UPDATE
    // (same enclosing block as the records DELETE).
  },
  {
    id: 'P12',
    title: 'Approval request creation/edit: pending edit overwrites mutable form_snapshot without a version.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
  },
  {
    id: 'P13',
    title: 'Attendance plugin terminal handling: correction/leave/overtime and outdoor can all upsert the row.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    confidence: 'heuristic',
    canonicalizedBy: 'W4C-3b',
  },
  {
    id: 'P14',
    title: 'Approved-request cancellation: balance/leave-ledger reversal only; no result reversal today.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
  },
  {
    id: 'P15',
    title: 'scripts/attendance/generate-cleanup-sql.cjs: privileged generated record/event deletes.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Generator no longer emits live DELETE on attendance_records. Canonical writer
    // is appendOperatorRetirementCalculationV1 (ops_retirement boundary body).
  },
  {
    id: 'P16',
    title: 'Test-user cleanup and staging helpers: dynamic/direct synthetic deletes and inserts.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Was already an exact relPath+symbol+table+verb allowlist before this conversion; it is now
    // the same shape as every other entry, and additionally carries pinned multiplicity, so a
    // SECOND DELETE under an allowed file/symbol/table/verb is no longer admitted either.
  },
  {
    id: 'P17',
    title: 'Central legacy approve/reject, generic action/bridge, and any card action reaching an attendance instance.',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
    // Was `site.relPath === 'packages/core-backend/src/routes/approvals.ts'` (whole file) plus a
    // bare bySymbol over the bridge service. Both are now exact counted identities.
  },
  {
    id: 'P18',
    title: 'Terminal shift_swap and schedule_dispatch write schedule assignments/group membership outside the result transaction.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
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
  },
  {
    id: 'P20',
    title: 'Anomaly, makeup-anomaly facts, open-record attribution, and DecisionTrace are direct ordinary readers.',
    owningSlice: 'W4C-3c',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c',
    // Reader-side debt (no DML) — closed by canonical active-current helper on all four surfaces.
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
  },
  {
    id: 'P23',
    title: '/import/rollback/:id accepts a broader authorization posture than import commit.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // Authorization-posture debt over the same DML site P11 already owns — no separate site.
  },
  {
    id: 'P24',
    title: 'Integration sync has a distinct semantic pipeline; dryRun still writes the run plus last_sync_at.',
    owningSlice: 'W4C-3a',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // attendance_integrations/attendance_integration_runs are bucket-allowlisted ("operational");
    // this entry documents the writer without requiring a tracked-bucket identity.
  },
  {
    id: 'P25',
    title: 'Import token, preview/job, template-preference, upload-lifecycle, and temporary-staging writes are operational DML.',
    owningSlice: 'W4C-0',
    sharedHook: false,
    canonicalizedBy: 'W4C-3a',
    // The tables this entry names (attendance_import_tokens/template_prefs/*_stage/jobs) are all
    // "operational"-bucket in table-classification.cjs, i.e. allowlisted at the bucket level —
    // exactly the classification this entry itself calls for. No tracked-bucket site to own.
  },
  {
    id: 'P26',
    title: 'Central approval assignment mutation is not one route (admin/reassign, generic approve/return/revoke/jump/...).',
    owningSlice: 'W4C-3b',
    sharedHook: true,
    canonicalizedBy: 'W4C-3b',
    // Was a whole-file `startsWith('packages/core-backend/src/services/ApprovalProductService.ts')`
    // claim — the single widest bypass in the old model. Now 5 exact identities with pinned
    // multiplicities (including two 5x/10x repeated-symbol sites), so a new writer symbol, a new
    // table, a new verb, or an extra write in an existing symbol all red.
  },
  {
    id: 'P27',
    title: 'Schedule publication (draft->live) writes attendance_shift_assignments/attendance_rotation_assignments to published.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
  },
  {
    id: 'P28',
    title: 'Core-backend onboarding default shift: POST /api/admin/users writes a default assignment.',
    owningSlice: 'W4C-3b',
    sharedHook: false,
    canonicalizedBy: 'W4C-3b',
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
    // Not a W4 result-operation bypass; remains owned so unclaimed=0 stays live.
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_schedule_fact',
    // Evidence: table-classification bucket schedule_fact for attendance_shift_assignments;
    // these writers change which shift applies, not attendance_records calculation truth.
    residualEvidence: 'TABLE_BUCKETS.attendance_shift_assignments=schedule_fact; symbols are fixed-schedule assignment writers only',
  },
  {
    id: 'X02',
    title: 'Payroll cycle summary export writes attendance_shift_assignments as a side effect (handlePayrollCycleSummaryExport).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_schedule_fact',
    residualEvidence: 'TABLE_BUCKETS.attendance_shift_assignments=schedule_fact; export side-effect assignment DML only',
  },
  {
    id: 'X03',
    title: 'Auto-shift auto-write run/run-item ledger (insertAutoShiftAutoWriteRun / insertAutoShiftAutoWriteRunItem / finalizeAutoShiftAutoWriteRun).',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: false,
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_schedule_fact_ledger',
    residualEvidence: 'TABLE_BUCKETS.attendance_auto_shift_auto_write_runs*=schedule_fact; run ledger not daily projection',
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
  },
  {
    id: 'X05',
    title: 'AttendanceExpiryService scheduled comp-time/leave-balance expiry sweep.',
    owningSlice: 'W4C-3b (unconfirmed)',
    sharedHook: true,
    canonicalizedBy: 'W4C-3c-residual-classification',
    residualClassification: 'non_result_shared_hook_ledger',
    residualEvidence: 'AttendanceExpiryService only touches leave balance ledger tables (shared_hook), never attendance_records',
    // Was a whole-file `relPath === '.../AttendanceExpiryService.ts'` claim narrowed only by an
    // OR over two table names; now exact counted identities per writer symbol.
  },
]

// One uniform derivation for every entry — the only place a `claims` predicate is created.
// Membership in the frozen identity table is the whole rule: no path prefix, no symbol regex,
// no whole-file disjunct can be introduced per-entry, because entries carry no logic.
const CURATED_DEBT_ENTRIES = CURATED_DEBT_ENTRY_METADATA.map((entry) => {
  const approvedKeys = approvedIdentityKeysForEntry(entry.id)
  return {
    ...entry,
    claims: (site) => approvedKeys.has(siteIdentityKey(site)),
  }
})

// Fail closed at require time: every entry id named by the identity table must exist here, or an
// approved site would be owned by a debt id that no longer appears in the inventory (the exact
// "silently dropped owner" shape §8.4 forbids).
const KNOWN_ENTRY_IDS = new Set(CURATED_DEBT_ENTRIES.map((entry) => entry.id))
for (const row of APPROVED_SITE_IDENTITIES) {
  for (const entryId of row.entryIds || []) {
    if (!KNOWN_ENTRY_IDS.has(entryId)) {
      throw new Error(`ATTENDANCE_W4C0_APPROVED_SITE_IDENTITY_UNKNOWN_ENTRY_ID: ${entryId}`)
    }
  }
}

// Non-attendance generic-shared-function approvals (§8.4: "Shared tables such as
// approval_instances... cannot be banned globally because non-attendance products legitimately
// use them"). These sites are demonstrably reached only from a different product's own code path
// (a distinct service name, seed/test tooling for the generic approval product, or a generic
// bridge migration backfill) with no attendance-specific discriminator anywhere in the call path
// this scan can see. They do not carry a P0x/X0x id — but they ARE recorded (not silently
// dropped) so a reviewer can see exactly what was excluded and why.
//
// These were the whole-file entries the owner's probe defeated: approving
// AfterSalesApprovalBridgeService.ts by path admitted a NEW `INSERT INTO attendance_records`
// added to it. They are now the same exact counted identities as everything else — the file name
// grants nothing.
const GENERIC_SHARED_ALLOWLIST = APPROVED_SITE_IDENTITIES.filter((row) => row.genericSharedReason).map(
  (row) => ({
    relPath: row.relPath,
    enclosingSymbol: row.enclosingSymbol,
    table: row.table,
    verb: row.verb,
    occurrences: row.occurrences,
    reason: row.genericSharedReason,
  }),
)

function isGenericSharedAllowlisted(site) {
  return GENERIC_SHARED_IDENTITY_KEYS.has(siteIdentityKey(site))
}

module.exports = {
  CURATED_DEBT_ENTRIES,
  GENERIC_SHARED_ALLOWLIST,
  isGenericSharedAllowlisted,
  APPROVED_SITE_IDENTITY_BY_KEY,
}
