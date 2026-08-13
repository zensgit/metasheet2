/**
 * W7 (#4556) OD-W7-5(a) — read-side provenance amendment: the exact NEW
 * string values for the W7-owned provenance family on the existing W4
 * detail/trace enums (design-lock §4.4, §7 OD-W7-5).
 *
 * Status: PROPOSED / runtime HOLD. `OD-W7-0..10` are OPEN owner decisions —
 * see
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §9. These strings are RECORDED here only; neither live enum named below is
 * edited by this file. Widening either live closed set now would force
 * every exhaustive consumer listed under it to handle the new value — that
 * is exactly the "modifying a live enum consumed by an exhaustive check"
 * case W7-R9 rules out of W7-0. Wiring these values into the live closed
 * arrays/unions (and into every listed consumer) is W7-1's job.
 *
 * Basis: built on the design-lock's recommended OD-W7-5 option (a) shape.
 * OD-W7-5 is OPEN — ratification pending, not assumed by this file.
 *
 * Two distinct enum families are in play (design-lock §4.4, stated to avoid
 * a spelling-ownership ambiguity): (i) the W6-owned source-label union
 * (OD-W6-3(a), `ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1`, defined
 * in the W6-1 contract module the W6 design lock's §1.2 file inventory
 * names — deliberately not spelled here as a literal filename: this file
 * lives under a root scanned by the existing
 * `tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts`
 * text-marker guard, which reds on ANY file under
 * `packages/core-backend/src/attendance/` containing a `w6-*.ts` module-name
 * substring, comment or not) — W7 ADOPTS those spellings verbatim and mints
 * none of its own for that family, so this file does not touch it; (ii)
 * THIS file's family — the W7-owned provenance values on the existing W4
 * detail/trace enums.
 *
 * The two `import type` lines below are compile-time-only anchors (fully
 * erased by `tsc`; zero runtime `require`, zero byte-inertness impact) that
 * make the `currentMembers` snapshots below self-checking: if either live
 * union drifts without this file being updated, `pnpm type-check` fails on
 * the `_assert*SyncV1` constants near the bottom of this file, rather than
 * this record silently going stale.
 */
import type { AttendanceDecisionTraceSourceKind } from '../services/AttendanceDecisionTrace'
import type { AttendanceImportRollbackPresentPreimageFingerprintInputV1 } from './w4c3a-import-rollback'

// ---------------------------------------------------------------------------
// Target 1: `projectionOwner` — the W4C detail/import-rollback provenance
// field.
//
// Current closed two-value set, independently validated at THREE separate
// sites (each an exhaustive gate on its own — none of them is edited here):
//   - `PROJECTION_OWNERS = ['legacy_untracked', 'w4'] as const`
//     (`packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:94`),
//     checked via `isClosedValue(PROJECTION_OWNERS, row.projection_owner)`
//     at `:428`;
//   - `packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts:368-370`
//     (`projectionOwner !== 'legacy_untracked' && projectionOwner !== 'w4'`);
//   - `packages/core-backend/src/attendance/w4c3a-import-rollback.ts:438-441,515-518`
//     (same two-value exhaustive check, twice);
//   - a DB CHECK-shaped predicate,
//     `packages/core-backend/src/db/migrations/zzzz20260731120000_w4c3a_import_rollback_foundation.ts:328`
//     (`... NOT IN ('legacy_untracked', 'w4') ...`).
// The exported, non-widened type anchor is
// `AttendanceImportRollbackPresentPreimageFingerprintInputV1['projectionOwner']`
// (`w4c3a-import-rollback.ts:371`) — `AttendanceW4CalculationDetail.ts`'s own
// public field is widened to `string` (`:420`) and cannot anchor a
// compile-time equality check, though it shares the same runtime-validated
// closed set via `PROJECTION_OWNERS`.
// ---------------------------------------------------------------------------

export const ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1 = 'w4_group' as const

// ---------------------------------------------------------------------------
// Target 2: trace `source.kind` — `AttendanceDecisionTraceSourceKind`
// (`packages/core-backend/src/services/AttendanceDecisionTrace.ts:102-108`,
// current closed union: `'record' | 'snapshot' | 'rule_live' | 'ledger' |
// 'audit' | 'policy_gate'`), the `kind` field of `AttendanceDecisionTraceSource`
// (`:110-113`) embedded in every `AttendanceDecisionTraceBasisEnv.source`
// (`:115-119`). Verified at W7-0 time (grep across `packages apps scripts`):
// no exhaustive switch/Record currently keys off this type anywhere in the
// tree — it is still recorded as a value amendment rather than a live edit,
// both because W7-R9 requires it for W7-0 and because an exhaustive consumer
// could land before W7-1 wires this value in.
// ---------------------------------------------------------------------------

export const ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1 = 'group_policy_snapshot' as const

/**
 * Bundled record for W7-1 to consume directly — still not imported by
 * anything today (see file header). `currentMembers` is a point-in-time
 * literal snapshot of each live closed set at the W7-0 baseline
 * (`f364c7f9b3`); the paired test file re-derives target 2's set from the
 * live exported TYPE at compile time (so a live union change fails `tsc`),
 * and target 1's set from a live exported type anchor the same way — see
 * `../__tests__/w7-read-side-provenance-amendment.test.ts`.
 */
export const ATTENDANCE_W7_READ_SIDE_PROVENANCE_AMENDMENT_V1 = Object.freeze({
  projectionOwner: Object.freeze({
    targetFile: 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts',
    targetConst: 'PROJECTION_OWNERS',
    currentMembers: Object.freeze(['legacy_untracked', 'w4'] as const),
    newValue: ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,
  }),
  traceSourceKind: Object.freeze({
    targetFile: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts',
    targetType: 'AttendanceDecisionTraceSourceKind',
    currentMembers: Object.freeze(['record', 'snapshot', 'rule_live', 'ledger', 'audit', 'policy_gate'] as const),
    newValue: ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,
  }),
} as const)

// ---------------------------------------------------------------------------
// Compile-time sync guards. Non-distributive mutual-extends equality: for
// literal-string unions A and B, `[A] extends [B]` (tuple-wrapped to block
// distribution) is true iff every member of A is a member of B; checking
// both directions proves the two unions are exactly equal, not merely
// overlapping.
// ---------------------------------------------------------------------------

type AssertUnionEqualV1<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false

type ProjectionOwnerLiveUnionV1 = AttendanceImportRollbackPresentPreimageFingerprintInputV1['projectionOwner']
type ProjectionOwnerRecordedUnionV1 =
  (typeof ATTENDANCE_W7_READ_SIDE_PROVENANCE_AMENDMENT_V1)['projectionOwner']['currentMembers'][number]
type AssertProjectionOwnerSyncV1 = AssertUnionEqualV1<ProjectionOwnerLiveUnionV1, ProjectionOwnerRecordedUnionV1>
// If this fails to compile, `w4c3a-import-rollback.ts`'s `projectionOwner`
// union moved without this file's `currentMembers` snapshot being updated.
const _assertProjectionOwnerSyncV1: AssertProjectionOwnerSyncV1 = true

type TraceSourceKindRecordedUnionV1 =
  (typeof ATTENDANCE_W7_READ_SIDE_PROVENANCE_AMENDMENT_V1)['traceSourceKind']['currentMembers'][number]
type AssertTraceSourceKindSyncV1 = AssertUnionEqualV1<
  AttendanceDecisionTraceSourceKind,
  TraceSourceKindRecordedUnionV1
>
// If this fails to compile, `AttendanceDecisionTrace.ts`'s
// `AttendanceDecisionTraceSourceKind` union moved without this file's
// `currentMembers` snapshot being updated.
const _assertTraceSourceKindSyncV1: AssertTraceSourceKindSyncV1 = true

// Referenced only to keep the compile-time guards above from being reported
// as "declared but never used" under a future stricter tsconfig; both are
// otherwise inert (never imported).
export const __w7ReadSideProvenanceSyncGuardsV1 = Object.freeze({
  projectionOwnerSync: _assertProjectionOwnerSyncV1,
  traceSourceKindSync: _assertTraceSourceKindSyncV1,
} as const)
