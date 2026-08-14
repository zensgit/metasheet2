/**
 * W4C-2 Gate D1 (#4556 / #4844) — INERT authoritative-mode result-write CORE for
 * `attendance_record_calculations`.
 *
 * WHAT THIS IS: the shared, contract-enforcing writer for the `mode='authoritative'` rows that
 * section 7.3 of the RATIFIED W4 lock
 * (`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`, §7.3 lines 1383-1457,
 * §7.4/7.5/7.7/7.8) specifies. It produces the SAME calc-row shape the shadow builder in
 * `w4c2-live-scheduled-boundary.ts` writes, but with `mode='authoritative'` and the §7.3
 * authoritative deltas: `legacy_baseline` snapshotting, `supersedes`/`restores` lineage, the
 * parent-pointer/visibility move, preimage freezing, and reversal restore/retire.
 *
 * WHAT THIS IS NOT (INERT / byte-neutral, Gate D1): this module is NOT called by any production
 * path. The live/scheduled boundary still fails closed — it still refuses the authoritative write
 * with the boundary code `` `W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED` `` (backtick-quoted here on
 * purpose; this file must never spell that code as a `boundaryFail(...)` call, see the
 * correspondence guard `w4c3a-rollout-control-inventory.test.ts`). No `boundaryFail` site is
 * removed by this slice, `DECLARED_DELIVERED` stays `{live_punch:false, scheduled:false}`, and the
 * shadow path is untouched (byte-identical by absence from this diff). D2 wires `live_punch`, D3
 * wires `scheduled`; each removes a refusal site and flips its declaration in its own reviewed
 * change. Until then this core is exercised ONLY by its real-DB test suite
 * (`attendance-w4c2-authoritative-calculation-core.db.test.ts`).
 *
 * DESIGN — two enforcement layers per invariant (repo doctrine: gate the MECHANISM, and a mutation
 * must be able to redden it — feedback_gate_the_mechanism_not_the_claim.md):
 *   (a) this module pre-validates every §7.3 authoritative invariant it can on the normal
 *       (live/scheduled completed+review) write path and refuses with a PRODUCT CODE rather than a raw
 *       SQLSTATE — the mutatable layer. Two documented exceptions where a raw 23505 is still reachable
 *       are named in "Concurrency notes" below (concurrent DIRECT `appendAuthoritativeLegacyBaselineV1`;
 *       concurrent same-op reversal) — neither is on a production path (INERT) and neither corrupts;
 *   (b) the DB CHECK constraints / triggers installed by the W4C-0 durable-storage migration are
 *       the backstop, each proven separately by a raw-insert leg that bypasses (a).
 *
 * REUSE: fingerprints via the existing `computeAttendance*FingerprintV1`; the single column list is
 * spelled ONCE here (`insertResolvedAuthoritativeCalculationRowV1`) and all three kinds funnel
 * through it — deliberately NOT three parallel hand-rolled INSERTs. `projectedDailyFingerprint`
 * mirrors the four existing private copies byte-for-byte (same domain-separated hash); the four are
 * intentionally left un-rewired (that is a separate, non-inert refactor).
 *
 * OPEN SEAMS / D2 obligations (named, not resolved here):
 *  1. legacy_baseline fingerprint is caller-supplied (`preimage.compatibilityFingerprint`) on purpose
 *     — self-computing it here is the import-kernel trap (kernel :907-909 binds the frozen preimage
 *     fingerprint, not a recomputed one). Today ONLY the import/rollback/ops paths freeze a
 *     `compatibilityFingerprint`; the live/scheduled boundary has no producer. D2 (live_punch) must
 *     supply one — deterministically, over the parent's legacy daily projection — before it can call
 *     the completed path on an active legacy parent, or `PREIMAGE_INVALID` fails closed. Cross-path
 *     fingerprint values are inconsequential for uniqueness (see the existence-read note below), but
 *     the live path still needs SOME frozen source.
 *  2. PARENT-STATE ASYMMETRY (F6): the completed path moves the parent pointer/visibility and the
 *     reversal path restores/retires it, but `writeReviewRow` writes ONLY the calc row and NEVER
 *     touches `attendance_records`. §7.5 requires a FRESH authoritative review to leave the parent
 *     `legacy_untracked`/pointer-null/retired/`review_placeholder` so ordinary readers see no
 *     fabricated zero-minute row. Deciding fresh-vs-existing review is a BOUNDARY concern, so the
 *     core deliberately does not touch the parent here — but D2/D3 MUST install that retired/
 *     `review_placeholder` state in the SAME transaction for a fresh authoritative review, unlike the
 *     completed/reversal paths which self-manage the parent. This asymmetry is the footgun; it is a
 *     named D2 obligation, not an ambient concern. (The invariant-5 test installs that precondition by
 *     fixture; it proves the "later completed needs no baseline" branch, not the boundary's install.)
 *
 * Concurrency notes:
 *  - The completed/review path is idempotent under CONCURRENT same-(org,entrypoint,operation_id)
 *    retries: a SAVEPOINT catches `uq_arc_operation` (23505) and re-runs the replay lookup, returning
 *    replay/`REPLAY_CONFLICT` (never a raw SQLSTATE) — see `writeAuthoritativeSegmentCalculationV1`.
 *  - The exported `appendAuthoritativeLegacyBaselineV1` existence read is a plain `SELECT … LIMIT 1`
 *    (no `FOR UPDATE`); at-most-one-baseline-per-record is only guaranteed when it runs UNDER the
 *    parent `FOR UPDATE` lock (as it does inside `writeCompletedRow`). Two concurrent DIRECT appends
 *    could each compute version=1 and the loser trips `uq_arc_record_version` — no corruption (the
 *    index holds; exactly one baseline), but a raw 23505 on that direct-use path. No production path
 *    calls the helper directly (INERT).
 *  - `writeAuthoritativeReversalV1` carries an operation_id too; a concurrent same-op reversal would
 *    trip `uq_arc_operation` raw. Reversal is NOT an idempotent-replay contract in §7.3 (its callers —
 *    import-rollback/ops-retirement — serialize via their own upstream operation registries), so it is
 *    intentionally not savepoint-wrapped here.
 *
 * Defensive guards: `LINEAGE_SELF_REFERENCE` and `LINEAGE_NOT_STRICTLY_LOWER` are unreachable via the
 * public API with valid inputs (fresh id; supersedes/restores are always a strictly-lower baseline or
 * the current pointer) — they are pre-validation backed by `trg_arc_lineage_guard`, and their negative
 * legs live on the DB backstop, not a product-code path.
 *
 * There is no `updated_at` — the calc table is append-only (§7.7).
 */
import crypto from 'node:crypto'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
  type AttendanceInputProvenanceRefV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  type AttendanceCalculatedSegmentV1,
  type AttendanceSegmentCalculationResultV1,
} from './w4c1-segment-calculator'
import type {
  AttendanceAttributionSnapshotV1,
  ApprovedAttendanceFactV1,
  FrozenAttendanceContextV1,
  PreparedDailyProjectionV1,
} from './w4c0-write-boundary-types'

// ---------------------------------------------------------------------------
// Product-coded errors (never a raw SQLSTATE — repo doctrine).
// ---------------------------------------------------------------------------

export const ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1 = Object.freeze({
  RECORD_NOT_FOUND: 'ATTENDANCE_W4_AUTH_CALC_RECORD_NOT_FOUND',
  VERSION_CONFLICT: 'ATTENDANCE_W4_AUTH_CALC_VERSION_CONFLICT',
  REPLAY_CONFLICT: 'ATTENDANCE_W4_AUTH_CALC_REPLAY_CONFLICT',
  LINEAGE_TARGET_MISSING: 'ATTENDANCE_W4_AUTH_CALC_LINEAGE_TARGET_MISSING',
  LINEAGE_NOT_STRICTLY_LOWER: 'ATTENDANCE_W4_AUTH_CALC_LINEAGE_NOT_STRICTLY_LOWER',
  LINEAGE_SELF_REFERENCE: 'ATTENDANCE_W4_AUTH_CALC_LINEAGE_SELF_REFERENCE',
  BASELINE_FINGERPRINT_INVALID: 'ATTENDANCE_W4_AUTH_CALC_BASELINE_FINGERPRINT_INVALID',
  BASELINE_PROJECTION_INVALID: 'ATTENDANCE_W4_AUTH_CALC_BASELINE_PROJECTION_INVALID',
  COMPLETED_SHAPE_INVALID: 'ATTENDANCE_W4_AUTH_CALC_COMPLETED_SHAPE_INVALID',
  EXPECTED_COUNT_INVALID: 'ATTENDANCE_W4_AUTH_CALC_EXPECTED_COUNT_INVALID',
  REVIEW_SHAPE_INVALID: 'ATTENDANCE_W4_AUTH_CALC_REVIEW_SHAPE_INVALID',
  REVERSAL_SUPERSEDES_REQUIRED: 'ATTENDANCE_W4_AUTH_CALC_REVERSAL_SUPERSEDES_REQUIRED',
  REVERSAL_RESTORES_MISMATCH: 'ATTENDANCE_W4_AUTH_CALC_REVERSAL_RESTORES_MISMATCH',
  REVERSAL_EFFECT_INVALID: 'ATTENDANCE_W4_AUTH_CALC_REVERSAL_EFFECT_INVALID',
  PREIMAGE_INVALID: 'ATTENDANCE_W4_AUTH_CALC_PREIMAGE_INVALID',
} as const)

export type AttendanceW4AuthoritativeCalculationErrorCodeV1 =
  (typeof ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1)[keyof typeof ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1]

export class AttendanceW4AuthoritativeCalculationError extends Error {
  readonly code: AttendanceW4AuthoritativeCalculationErrorCodeV1
  readonly httpStatus: number
  constructor(code: AttendanceW4AuthoritativeCalculationErrorCodeV1, httpStatus: number) {
    super(code)
    this.name = 'AttendanceW4AuthoritativeCalculationError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function fail(
  code: AttendanceW4AuthoritativeCalculationErrorCodeV1,
  httpStatus: number,
): never {
  throw new AttendanceW4AuthoritativeCalculationError(code, httpStatus)
}

const HEX64 = /^[0-9a-f]{64}$/

/** True iff `error` is a Postgres unique_violation (23505) on the named constraint. */
function isUniqueViolationOnConstraintV1(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505' &&
    (error as { constraint?: unknown }).constraint === constraint
  )
}

// ---------------------------------------------------------------------------
// Shared column helpers.
// ---------------------------------------------------------------------------

/**
 * Domain-separated projected-daily fingerprint. Byte-identical to the four existing private copies
 * (`w4c3a-canonical-import-kernel.ts`, `w4c3b-approved-leave-cancellation.ts`, `w4c3c-recompute.ts`,
 * `w4c3c-manual-edit-apply.ts`): same domain tag + `canonicalAttendanceJsonV1(projection)`. A
 * baseline row's `projected_daily_fingerprint` is NEVER computed here — it is the caller's frozen
 * compatibility fingerprint (see `appendAuthoritativeLegacyBaselineV1`).
 */
export function projectedDailyFingerprintV1(projection: Readonly<{
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
}>): string {
  return crypto
    .createHash('sha256')
    .update('metasheet2:attendance:w4:projected-daily:v1\0', 'utf8')
    .update(canonicalAttendanceJsonV1(projection), 'utf8')
    .digest('hex')
}

async function nextCalculationVersion(
  trx: AttendanceW4TransactionClientV1,
  recordId: string,
): Promise<number> {
  const result = await trx.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid',
    [recordId],
  )
  const version = Number(result.rows[0]?.next)
  if (!Number.isSafeInteger(version) || version < 1) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.VERSION_CONFLICT, 500)
  }
  return version
}

/**
 * §7.3 immediate-lineage precondition, pre-validated with product codes so a negative leg does not
 * depend on the DB `trg_arc_lineage_guard` SQLSTATE. The trigger remains the backstop.
 */
async function assertLineageStrictlyLower(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{ orgId: string; recordId: string; newRowId: string; newVersion: number; targetId: string }>,
): Promise<void> {
  if (input.targetId === input.newRowId) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.LINEAGE_SELF_REFERENCE, 422)
  }
  const result = await trx.query(
    `SELECT version FROM attendance_record_calculations
      WHERE id = $1::uuid AND attendance_record_id = $2::uuid AND org_id = $3`,
    [input.targetId, input.recordId, input.orgId],
  )
  if (result.rows.length !== 1) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.LINEAGE_TARGET_MISSING, 422)
  }
  const targetVersion = Number(result.rows[0].version)
  if (!Number.isSafeInteger(targetVersion) || targetVersion >= input.newVersion) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.LINEAGE_NOT_STRICTLY_LOWER, 422)
  }
}

// ---------------------------------------------------------------------------
// The ONE parameterized INSERT — every kind (legacy_baseline / calculation / reversal) funnels
// through this. mode is always 'authoritative'; engine/schema version fixed; shadow_diff is a
// shadow-only concept and stays NULL for every authoritative row.
// ---------------------------------------------------------------------------

interface ResolvedAuthoritativeCalculationRowV1 {
  readonly id: string
  readonly orgId: string
  readonly recordId: string
  readonly version: number
  readonly calculationKind: 'legacy_baseline' | 'calculation' | 'reversal'
  readonly entrypoint: string
  readonly supersedesCalculationId: string | null
  readonly restoresCalculationId: string | null
  readonly sourceBatchId: string | null
  readonly operationId: string | null
  readonly semanticInputFingerprint: string
  readonly provenanceFingerprint: string
  readonly sourceDefinitionFingerprint: string | null
  readonly attributionSnapshot: unknown
  readonly contextSnapshot: unknown | null
  readonly segmentSnapshot: unknown[]
  readonly evidenceSnapshot: unknown[]
  readonly approvedFactsSnapshot: unknown[]
  readonly manualOverrideSnapshot: unknown | null
  readonly inputProvenance: Record<string, unknown>
  readonly mergePolicy: 'append' | 'merge' | 'override' | 'reversal' | 'retire'
  readonly calculationTier: 'legacy_shadow' | 'segment_authoritative'
  readonly outcome: 'baseline' | 'completed' | 'review_required' | 'reversed'
  readonly outcomeReasonCode: string
  readonly projectionEffect: 'none' | 'set_active' | 'set_retired'
  readonly expectedSegmentCount: number
  readonly projectedStatus: string | null
  readonly projectedFirstInAt: string | null
  readonly projectedLastOutAt: string | null
  readonly projectedWorkMinutes: number | null
  readonly projectedLateMinutes: number | null
  readonly projectedEarlyLeaveMinutes: number | null
  readonly projectedDailyFingerprint: string | null
  readonly parentPreimageSnapshot: unknown | null
  readonly actorId: string
  readonly correlationId: string
}

async function insertResolvedAuthoritativeCalculationRowV1(
  trx: AttendanceW4TransactionClientV1,
  row: ResolvedAuthoritativeCalculationRowV1,
): Promise<void> {
  await trx.query(
    `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version,
        supersedes_calculation_id, restores_calculation_id, source_batch_id, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, manual_override_snapshot, input_provenance,
        merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
        expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        projected_daily_fingerprint, parent_preimage_snapshot, shadow_diff_code, shadow_diff,
        actor_id, correlation_id
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, $5, 'authoritative', $6,
        $7, 1,
        $8::uuid, $9::uuid, $10::uuid, $11::uuid,
        $12, $13, $14,
        $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb,
        $19::jsonb, $20::jsonb, $21::jsonb,
        $22, $23, $24, $25, $26,
        $27, $28, $29, $30,
        $31, $32, $33,
        $34, $35::jsonb, NULL, NULL,
        $36, $37
      )`,
    [
      row.id,
      row.orgId,
      row.recordId,
      row.version,
      row.calculationKind,
      row.entrypoint,
      ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      row.supersedesCalculationId,
      row.restoresCalculationId,
      row.sourceBatchId,
      row.operationId,
      row.semanticInputFingerprint,
      row.provenanceFingerprint,
      row.sourceDefinitionFingerprint,
      canonicalAttendanceJsonV1(row.attributionSnapshot),
      row.contextSnapshot === null ? null : canonicalAttendanceJsonV1(row.contextSnapshot),
      canonicalAttendanceJsonV1(row.segmentSnapshot),
      canonicalAttendanceJsonV1(row.evidenceSnapshot),
      canonicalAttendanceJsonV1(row.approvedFactsSnapshot),
      row.manualOverrideSnapshot === null ? null : canonicalAttendanceJsonV1(row.manualOverrideSnapshot),
      canonicalAttendanceJsonV1(row.inputProvenance),
      row.mergePolicy,
      row.calculationTier,
      row.outcome,
      row.outcomeReasonCode,
      row.projectionEffect,
      row.expectedSegmentCount,
      row.projectedStatus,
      row.projectedFirstInAt,
      row.projectedLastOutAt,
      row.projectedWorkMinutes,
      row.projectedLateMinutes,
      row.projectedEarlyLeaveMinutes,
      row.projectedDailyFingerprint,
      row.parentPreimageSnapshot === null ? null : canonicalAttendanceJsonV1(row.parentPreimageSnapshot),
      row.actorId,
      row.correlationId,
    ],
  )
}

async function insertCalculationSegmentsV1(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    orgId: string
    recordId: string
    calculationId: string
    segments: readonly AttendanceCalculatedSegmentV1[]
  }>,
): Promise<void> {
  for (const segment of input.segments) {
    await trx.query(
      `INSERT INTO attendance_record_segments (
          org_id, record_id, calculation_id, segment_index,
          expected_start_at, expected_end_at, actual_in_at, actual_out_at,
          work_minutes, late_minutes, early_leave_minutes,
          status, status_reasons, matched_evidence_refs, unmatched_evidence_refs
        ) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)`,
      [
        input.orgId,
        input.recordId,
        input.calculationId,
        segment.segmentIndex,
        segment.expectedStartAt,
        segment.expectedEndAt,
        segment.actualInAt,
        segment.actualOutAt,
        segment.workedMinutes,
        segment.lateMinutes,
        segment.earlyLeaveMinutes,
        segment.status,
        JSON.stringify(segment.reasons),
        JSON.stringify(segment.matchedEvidenceRefs),
        JSON.stringify(segment.unmatchedEvidenceRefs),
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// Preimage witness (§7.8) — the frozen write-before parent state the caller supplies. The core does
// not derive it; it validates against it.
// ---------------------------------------------------------------------------

export interface AttendanceAuthoritativePreimageProjectionV1 {
  readonly status: string
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  readonly workMinutes: number
  readonly lateMinutes: number
  readonly earlyLeaveMinutes: number
}

export type AttendanceAuthoritativeParentPreimageV1 =
  | { readonly posture: 'absent' }
  | {
      readonly posture: 'present'
      readonly projectionOwner: 'legacy_untracked' | 'w4'
      readonly currentCalculationId: string | null
      readonly visibilityState: 'active' | 'retired'
      readonly visibilityReason: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'
      readonly projection: AttendanceAuthoritativePreimageProjectionV1 | null
      readonly compatibilityFingerprint: string | null
    }

// ---------------------------------------------------------------------------
// (1) legacy_baseline (§7.3/§7.8) — snapshots an active legacy parent immediately before its FIRST
// authoritative replacement. Restore evidence only: projection_effect='none', no children,
// operation_id NULL, never a pointer target. Idempotent per record via the existence read (NOT the
// unique index) so it can never consume the external operation_id the following normal calc needs.
// ---------------------------------------------------------------------------

export interface AppendAuthoritativeLegacyBaselineInputV1 {
  readonly orgId: string
  readonly recordId: string
  readonly entrypoint: string
  readonly projection: AttendanceAuthoritativePreimageProjectionV1
  /** The frozen compatibility fingerprint — becomes projected_daily_fingerprint AND all three FPs. */
  readonly compatibilityFingerprint: string
  readonly parentPreimageSnapshot: unknown
  readonly actorId: string
  readonly correlationId: string
}

export type AppendAuthoritativeLegacyBaselineResultV1 =
  | { readonly kind: 'appended'; readonly baselineCalculationId: string; readonly version: number }
  | { readonly kind: 'exists'; readonly baselineCalculationId: string }

export async function appendAuthoritativeLegacyBaselineV1(
  trx: AttendanceW4TransactionClientV1,
  input: AppendAuthoritativeLegacyBaselineInputV1,
): Promise<AppendAuthoritativeLegacyBaselineResultV1> {
  if (!HEX64.test(input.compatibilityFingerprint)) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.BASELINE_FINGERPRINT_INVALID, 422)
  }
  assertPreimageProjection(input.projection)

  const existing = await trx.query(
    `SELECT id::text AS id FROM attendance_record_calculations
      WHERE org_id = $1 AND attendance_record_id = $2::uuid AND calculation_kind = 'legacy_baseline'
      LIMIT 1`,
    [input.orgId, input.recordId],
  )
  if (existing.rows.length !== 0) {
    return Object.freeze({ kind: 'exists', baselineCalculationId: String(existing.rows[0].id) })
  }

  const id = crypto.randomUUID()
  const version = await nextCalculationVersion(trx, input.recordId)
  await insertResolvedAuthoritativeCalculationRowV1(trx, {
    id,
    orgId: input.orgId,
    recordId: input.recordId,
    version,
    calculationKind: 'legacy_baseline',
    entrypoint: input.entrypoint,
    supersedesCalculationId: null,
    restoresCalculationId: null,
    sourceBatchId: null,
    operationId: null,
    semanticInputFingerprint: input.compatibilityFingerprint,
    provenanceFingerprint: input.compatibilityFingerprint,
    sourceDefinitionFingerprint: input.compatibilityFingerprint,
    attributionSnapshot: baselineAttributionV1(),
    contextSnapshot: { schemaVersion: 1, kind: 'legacy_projection_baseline' },
    segmentSnapshot: [],
    evidenceSnapshot: [],
    approvedFactsSnapshot: [],
    manualOverrideSnapshot: null,
    inputProvenance: { schemaVersion: 1, kind: 'legacy_projection_baseline' },
    mergePolicy: 'append',
    calculationTier: 'legacy_shadow',
    outcome: 'baseline',
    outcomeReasonCode: 'legacy_projection_baseline',
    projectionEffect: 'none',
    expectedSegmentCount: 0,
    projectedStatus: input.projection.status,
    projectedFirstInAt: input.projection.firstInAt,
    projectedLastOutAt: input.projection.lastOutAt,
    projectedWorkMinutes: input.projection.workMinutes,
    projectedLateMinutes: input.projection.lateMinutes,
    projectedEarlyLeaveMinutes: input.projection.earlyLeaveMinutes,
    projectedDailyFingerprint: input.compatibilityFingerprint,
    parentPreimageSnapshot: input.parentPreimageSnapshot,
    actorId: input.actorId,
    correlationId: input.correlationId,
  })
  return Object.freeze({ kind: 'appended', baselineCalculationId: id, version })
}

function baselineAttributionV1(): AttendanceAttributionSnapshotV1 {
  return { posture: 'unsupported', sourceSchemaVersion: 1, reason: 'legacy_v1', sourceFingerprint: null }
}

function assertPreimageProjection(projection: AttendanceAuthoritativePreimageProjectionV1): void {
  if (
    typeof projection.status !== 'string' ||
    !Number.isSafeInteger(projection.workMinutes) || projection.workMinutes < 0 ||
    !Number.isSafeInteger(projection.lateMinutes) || projection.lateMinutes < 0 ||
    !Number.isSafeInteger(projection.earlyLeaveMinutes) || projection.earlyLeaveMinutes < 0
  ) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.BASELINE_PROJECTION_INVALID, 422)
  }
}

function preimageProjectionsEqualV1(
  a: AttendanceAuthoritativePreimageProjectionV1,
  b: AttendanceAuthoritativePreimageProjectionV1,
): boolean {
  return (
    a.status === b.status &&
    a.firstInAt === b.firstInAt &&
    a.lastOutAt === b.lastOutAt &&
    a.workMinutes === b.workMinutes &&
    a.lateMinutes === b.lateMinutes &&
    a.earlyLeaveMinutes === b.earlyLeaveMinutes
  )
}

// ---------------------------------------------------------------------------
// (2) normal `calculation` (§7.3/§7.5/§7.8) — the live/scheduled authoritative write. Completed →
// set_active + pointer move + segments; review_required → hidden all-NULL placeholder (no
// pointer/predecessor/effect). Retry-idempotent on (org, entrypoint, operation_id).
// ---------------------------------------------------------------------------

export interface WriteAuthoritativeSegmentCalculationInputV1 {
  readonly orgId: string
  readonly recordId: string
  readonly entrypoint: string
  readonly operationId: string
  readonly calculation: AttendanceSegmentCalculationResultV1
  readonly attribution: AttendanceAttributionSnapshotV1
  readonly context: FrozenAttendanceContextV1 | null
  readonly evidence: readonly unknown[]
  readonly approvedFacts: readonly ApprovedAttendanceFactV1[]
  readonly provenanceRef: AttendanceInputProvenanceRefV1
  readonly inputProvenance: Record<string, unknown>
  /** Deterministic payload identity for the retry-idempotency conflict check (precedent: recompute). */
  readonly payloadFingerprint: string
  /** Frozen write-before parent state (§7.8). */
  readonly preimage: AttendanceAuthoritativeParentPreimageV1
  /** What the caller believes the current pointer is; a stale value fails VERSION_CONFLICT (§7.3). */
  readonly expectedCurrentCalculationId: string | null
  readonly sourceBatchId?: string | null
  readonly actorId: string
  readonly correlationId: string
}

export type WriteAuthoritativeSegmentCalculationResultV1 =
  | {
      readonly kind: 'completed'
      readonly calculationId: string
      readonly version: number
      readonly supersedesCalculationId: string | null
      readonly baselineCalculationId: string | null
    }
  | { readonly kind: 'review'; readonly calculationId: string; readonly version: number }
  | { readonly kind: 'replay'; readonly calculationId: string }

interface LockedParentV1 {
  readonly currentCalculationId: string | null
  readonly projectionOwner: 'legacy_untracked' | 'w4'
  readonly visibilityState: 'active' | 'retired'
  readonly timezone: string | null
}

async function retryReplayLookup(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{ orgId: string; entrypoint: string; operationId: string; recordId: string; payloadFingerprint: string }>,
): Promise<{ calculationId: string } | null> {
  const existing = await trx.query(
    `SELECT id::text AS id, attendance_record_id::text AS record_id, input_provenance
       FROM attendance_record_calculations
      WHERE org_id = $1 AND entrypoint = $2 AND operation_id = $3::uuid
      FOR UPDATE`,
    [input.orgId, input.entrypoint, input.operationId],
  )
  if (existing.rows.length === 0) return null
  const existingRow = existing.rows[0]
  if (String(existingRow.record_id) !== input.recordId) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REPLAY_CONFLICT, 409)
  }
  const provenance =
    existingRow.input_provenance && typeof existingRow.input_provenance === 'object'
      ? (existingRow.input_provenance as Record<string, unknown>)
      : null
  const existingFingerprint =
    provenance && typeof provenance.payloadFingerprint === 'string' ? provenance.payloadFingerprint : null
  if (existingFingerprint !== input.payloadFingerprint) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REPLAY_CONFLICT, 409)
  }
  return { calculationId: String(existingRow.id) }
}

async function lockParent(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  recordId: string,
): Promise<LockedParentV1> {
  const result = await trx.query(
    `SELECT current_calculation_id::text AS current_calculation_id, projection_owner,
            visibility_state, timezone
       FROM attendance_records
      WHERE id = $1::uuid AND org_id = $2
      FOR UPDATE`,
    [recordId, orgId],
  )
  if (result.rows.length !== 1) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.RECORD_NOT_FOUND, 404)
  }
  const row = result.rows[0]
  return {
    currentCalculationId:
      typeof row.current_calculation_id === 'string' ? row.current_calculation_id : null,
    projectionOwner: row.projection_owner === 'w4' ? 'w4' : 'legacy_untracked',
    visibilityState: row.visibility_state === 'retired' ? 'retired' : 'active',
    timezone: typeof row.timezone === 'string' ? row.timezone : null,
  }
}

export async function writeAuthoritativeSegmentCalculationV1(
  trx: AttendanceW4TransactionClientV1,
  input: WriteAuthoritativeSegmentCalculationInputV1,
): Promise<WriteAuthoritativeSegmentCalculationResultV1> {
  const replay = await retryReplayLookup(trx, {
    orgId: input.orgId,
    entrypoint: input.entrypoint,
    operationId: input.operationId,
    recordId: input.recordId,
    payloadFingerprint: input.payloadFingerprint,
  })
  if (replay !== null) {
    return Object.freeze({ kind: 'replay' as const, calculationId: replay.calculationId })
  }

  const parent = await lockParent(trx, input.orgId, input.recordId)
  if (parent.currentCalculationId !== input.expectedCurrentCalculationId) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.VERSION_CONFLICT, 409)
  }

  const semanticInputFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution: input.attribution,
    context: input.context,
    evidence: input.evidence,
    approvedFacts: input.approvedFacts,
    manualOverride: null,
    mergePolicy: 'append',
    calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(input.provenanceRef)
  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({
    attribution: input.attribution,
    context: input.context,
  })

  const fp: FingerprintTripleV1 = { semanticInputFingerprint, provenanceFingerprint, sourceDefinitionFingerprint }

  // §7.3 concurrent-retry idempotency. `retryReplayLookup` above only catches a retry whose winner
  // already COMMITTED before this call. Two concurrent same-(org,entrypoint,operation_id) writers
  // that do not contend on one parent row (different records, or the review path which never moves
  // the pointer) both pass that lookup and both insert — the loser then trips `uq_arc_operation`.
  // `lockParent`'s FOR UPDATE only serializes writers on the SAME parent row, so it does not cover
  // this. A SAVEPOINT lets the loser roll back its partial writes (a bare constraint failure poisons
  // the whole txn) and re-run the lookup so §7.3's "retries return the existing calculation" holds
  // instead of a raw SQLSTATE reaching the caller.
  const savepoint = 'attendance_w4_auth_calc_op'
  await trx.query(`SAVEPOINT ${savepoint}`)
  try {
    const written =
      input.calculation.outcome === 'review_required'
        ? await writeReviewRow(trx, input, fp)
        : await writeCompletedRow(trx, input, parent, fp)
    await trx.query(`RELEASE SAVEPOINT ${savepoint}`)
    return written
  } catch (error) {
    if (!isUniqueViolationOnConstraintV1(error, 'uq_arc_operation')) throw error
    await trx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    const afterConflict = await retryReplayLookup(trx, {
      orgId: input.orgId,
      entrypoint: input.entrypoint,
      operationId: input.operationId,
      recordId: input.recordId,
      payloadFingerprint: input.payloadFingerprint,
    })
    if (afterConflict !== null) {
      return Object.freeze({ kind: 'replay' as const, calculationId: afterConflict.calculationId })
    }
    // The unique index proved a row exists, but this txn's snapshot cannot see it (e.g. a
    // SERIALIZABLE caller whose snapshot predates the winner's commit). Surface §7.3's idempotency
    // outcome as a product code, never the raw 23505.
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REPLAY_CONFLICT, 409)
  }
}

interface FingerprintTripleV1 {
  readonly semanticInputFingerprint: string
  readonly provenanceFingerprint: string
  readonly sourceDefinitionFingerprint: string | null
}

async function writeReviewRow(
  trx: AttendanceW4TransactionClientV1,
  input: WriteAuthoritativeSegmentCalculationInputV1,
  fp: FingerprintTripleV1,
): Promise<WriteAuthoritativeSegmentCalculationResultV1> {
  // Hidden review placeholder: every projected daily field NULL (not a DB default), effect none,
  // zero children, no predecessor/pointer/baseline. §7.3/§7.5.
  if (input.calculation.dailyProjection !== null || input.calculation.segments.length !== 0) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REVIEW_SHAPE_INVALID, 422)
  }
  const id = crypto.randomUUID()
  const version = await nextCalculationVersion(trx, input.recordId)
  await insertResolvedAuthoritativeCalculationRowV1(trx, {
    id,
    orgId: input.orgId,
    recordId: input.recordId,
    version,
    calculationKind: 'calculation',
    entrypoint: input.entrypoint,
    supersedesCalculationId: null,
    restoresCalculationId: null,
    sourceBatchId: input.sourceBatchId ?? null,
    operationId: input.operationId,
    semanticInputFingerprint: fp.semanticInputFingerprint,
    provenanceFingerprint: fp.provenanceFingerprint,
    sourceDefinitionFingerprint: fp.sourceDefinitionFingerprint,
    attributionSnapshot: input.attribution,
    contextSnapshot: input.context,
    segmentSnapshot: [],
    evidenceSnapshot: [...input.evidence],
    approvedFactsSnapshot: [...input.approvedFacts],
    manualOverrideSnapshot: null,
    inputProvenance: input.inputProvenance,
    mergePolicy: 'append',
    calculationTier: 'segment_authoritative',
    outcome: 'review_required',
    outcomeReasonCode: input.calculation.outcomeReasonCode,
    projectionEffect: 'none',
    expectedSegmentCount: 0,
    projectedStatus: null,
    projectedFirstInAt: null,
    projectedLastOutAt: null,
    projectedWorkMinutes: null,
    projectedLateMinutes: null,
    projectedEarlyLeaveMinutes: null,
    projectedDailyFingerprint: null,
    parentPreimageSnapshot: input.preimage,
    actorId: input.actorId,
    correlationId: input.correlationId,
  })
  return Object.freeze({ kind: 'review' as const, calculationId: id, version })
}

async function writeCompletedRow(
  trx: AttendanceW4TransactionClientV1,
  input: WriteAuthoritativeSegmentCalculationInputV1,
  parent: LockedParentV1,
  fp: FingerprintTripleV1,
): Promise<WriteAuthoritativeSegmentCalculationResultV1> {
  const projection = input.calculation.dailyProjection
  // §7.3 completed shape: resolved_v2 attribution, frozen context, 1..3 segments, dense projection.
  if (
    projection === null ||
    input.attribution.posture !== 'resolved_v2' ||
    input.context === null ||
    fp.sourceDefinitionFingerprint === null
  ) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.COMPLETED_SHAPE_INVALID, 422)
  }
  const segmentCount = input.calculation.segments.length
  if (segmentCount < 1 || segmentCount > 3) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.EXPECTED_COUNT_INVALID, 422)
  }
  // §7.3 line 1414 "non-negative minutes": pre-validate with a product code, symmetric with the
  // baseline (`assertPreimageProjection`) and reversal paths, so a negative-minute projection cannot
  // leak the raw `chk_arc_projected_minutes` SQLSTATE (23514) to the caller.
  if (
    !Number.isSafeInteger(projection.workedMinutes) || projection.workedMinutes < 0 ||
    !Number.isSafeInteger(projection.lateMinutes) || projection.lateMinutes < 0 ||
    !Number.isSafeInteger(projection.earlyLeaveMinutes) || projection.earlyLeaveMinutes < 0
  ) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.COMPLETED_SHAPE_INVALID, 422)
  }

  const id = crypto.randomUUID()

  // §7.3/§7.8 predecessor: an active legacy_untracked parent gets a baseline first, and the normal
  // calc supersedes it; a W4-owned parent supersedes the exact locked current; a review-placeholder
  // parent (no active compat projection) needs neither. The baseline is appended BEFORE the calc's
  // version is allocated so the two never collide on `(record, version)`.
  let supersedesCalculationId: string | null = null
  let baselineCalculationId: string | null = null
  if (parent.projectionOwner === 'w4' && parent.currentCalculationId !== null) {
    supersedesCalculationId = parent.currentCalculationId
  } else if (parent.projectionOwner === 'legacy_untracked' && parent.visibilityState === 'active') {
    if (input.preimage.posture !== 'present' || input.preimage.projection === null) {
      fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.PREIMAGE_INVALID, 422)
    }
    if (input.preimage.compatibilityFingerprint === null) {
      fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.PREIMAGE_INVALID, 422)
    }
    const baseline = await appendAuthoritativeLegacyBaselineV1(trx, {
      orgId: input.orgId,
      recordId: input.recordId,
      entrypoint: input.entrypoint,
      projection: input.preimage.projection,
      compatibilityFingerprint: input.preimage.compatibilityFingerprint,
      parentPreimageSnapshot: input.preimage,
      actorId: input.actorId,
      correlationId: input.correlationId,
    })
    baselineCalculationId = baseline.baselineCalculationId
    supersedesCalculationId = baseline.baselineCalculationId
  }

  const version = await nextCalculationVersion(trx, input.recordId)

  if (supersedesCalculationId !== null) {
    await assertLineageStrictlyLower(trx, {
      orgId: input.orgId,
      recordId: input.recordId,
      newRowId: id,
      newVersion: version,
      targetId: supersedesCalculationId,
    })
  }

  const projectedDailyFingerprint = projectedDailyFingerprintV1({
    status: projection.status,
    firstInAt: projection.firstInAt,
    lastOutAt: projection.lastOutAt,
    workedMinutes: projection.workedMinutes,
    lateMinutes: projection.lateMinutes,
    earlyLeaveMinutes: projection.earlyLeaveMinutes,
  })

  await insertResolvedAuthoritativeCalculationRowV1(trx, {
    id,
    orgId: input.orgId,
    recordId: input.recordId,
    version,
    calculationKind: 'calculation',
    entrypoint: input.entrypoint,
    supersedesCalculationId,
    restoresCalculationId: null,
    sourceBatchId: input.sourceBatchId ?? null,
    operationId: input.operationId,
    semanticInputFingerprint: fp.semanticInputFingerprint,
    provenanceFingerprint: fp.provenanceFingerprint,
    sourceDefinitionFingerprint: fp.sourceDefinitionFingerprint,
    attributionSnapshot: input.attribution,
    contextSnapshot: input.context,
    segmentSnapshot: (input.context as unknown as { segments?: unknown[] }).segments ?? [],
    evidenceSnapshot: [...input.evidence],
    approvedFactsSnapshot: [...input.approvedFacts],
    manualOverrideSnapshot: null,
    inputProvenance: input.inputProvenance,
    mergePolicy: 'append',
    calculationTier: 'segment_authoritative',
    outcome: 'completed',
    outcomeReasonCode: 'calculated',
    projectionEffect: 'set_active',
    expectedSegmentCount: segmentCount,
    projectedStatus: projection.status,
    projectedFirstInAt: projection.firstInAt,
    projectedLastOutAt: projection.lastOutAt,
    projectedWorkMinutes: projection.workedMinutes,
    projectedLateMinutes: projection.lateMinutes,
    projectedEarlyLeaveMinutes: projection.earlyLeaveMinutes,
    projectedDailyFingerprint,
    parentPreimageSnapshot: input.preimage,
    actorId: input.actorId,
    correlationId: input.correlationId,
  })

  await insertCalculationSegmentsV1(trx, {
    orgId: input.orgId,
    recordId: input.recordId,
    calculationId: id,
    segments: input.calculation.segments,
  })

  // Pointer move (§7.5). The stale-expectation guard is the pre-check above (`parent.currentCalculationId
  // !== input.expectedCurrentCalculationId`), evaluated under the parent's FOR UPDATE lock; this WHERE
  // keys off the LOCKED ACTUAL current (never `expectedCurrentCalculationId`) so it does not silently
  // re-implement — and thereby cover for — that guard. The lock guarantees the actual cannot move
  // between the read and this write.
  const updated = await trx.query(
    `UPDATE attendance_records
        SET current_calculation_id = $3::uuid, projection_owner = 'w4',
            visibility_state = 'active', visibility_reason = 'active',
            status = $4, first_in_at = $5, last_out_at = $6,
            work_minutes = $7, late_minutes = $8, early_leave_minutes = $9,
            updated_at = now()
      WHERE id = $1::uuid AND org_id = $2
        AND current_calculation_id IS NOT DISTINCT FROM $10::uuid
      RETURNING id`,
    [
      input.recordId,
      input.orgId,
      id,
      projection.status,
      projection.firstInAt,
      projection.lastOutAt,
      projection.workedMinutes,
      projection.lateMinutes,
      projection.earlyLeaveMinutes,
      parent.currentCalculationId,
    ],
  )
  if (updated.rows.length !== 1) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.VERSION_CONFLICT, 409)
  }

  return Object.freeze({
    kind: 'completed' as const,
    calculationId: id,
    version,
    supersedesCalculationId,
    baselineCalculationId,
  })
}

// ---------------------------------------------------------------------------
// (3) reversal (§7.3/§7.8) — restore a present preimage pointer or retire an absent-pointer
// preimage. Contract-enforcing: the CALLER supplies the row to supersede, the frozen preimage
// witness, and the frozen visibility target; the core enforces the §7.3 reversal shape rules
// (supersedes required; restores == preimage.currentCalculationId when present, NULL when absent;
// projection_effect matches the frozen target). The reversed row's own snapshots are carried
// forward (never fabricated).
// ---------------------------------------------------------------------------

export interface WriteAuthoritativeReversalInputV1 {
  readonly orgId: string
  readonly recordId: string
  readonly entrypoint: string
  readonly operationId: string
  readonly sourceBatchId?: string | null
  /** The exact current calc being reversed (§7.8: a wrong/null predecessor is a failure). */
  readonly supersedesCalculationId: string | null
  /** Carried forward from the reversed row (never fabricated). */
  readonly reversedSnapshots: Readonly<{
    semanticInputFingerprint: string
    provenanceFingerprint: string
    sourceDefinitionFingerprint: string | null
    attributionSnapshot: unknown
    contextSnapshot: unknown | null
    evidenceSnapshot: unknown[]
    approvedFactsSnapshot: unknown[]
    manualOverrideSnapshot: unknown | null
  }>
  readonly inputProvenance: Record<string, unknown>
  readonly preimage: AttendanceAuthoritativeParentPreimageV1
  /** The frozen target daily state the reversal projects (present=restored, absent=retired). */
  readonly frozenTarget: Readonly<{
    visibilityState: 'active' | 'retired'
    visibilityReason: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'
    projection: AttendanceAuthoritativePreimageProjectionV1
    dailyFingerprint: string
  }>
  readonly restoresCalculationId: string | null
  readonly outcomeReasonCode: 'import_rollback_reversal' | 'operator_retirement'
  readonly mergePolicy: 'reversal' | 'retire'
  readonly actorId: string
  readonly correlationId: string
}

export interface WriteAuthoritativeReversalResultV1 {
  readonly kind: 'reversed'
  readonly calculationId: string
  readonly version: number
  readonly projectionEffect: 'set_active' | 'set_retired'
  readonly restoresCalculationId: string | null
}

export async function writeAuthoritativeReversalV1(
  trx: AttendanceW4TransactionClientV1,
  input: WriteAuthoritativeReversalInputV1,
): Promise<WriteAuthoritativeReversalResultV1> {
  if (input.supersedesCalculationId === null) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REVERSAL_SUPERSEDES_REQUIRED, 422)
  }
  // §7.8 restores correspondence: restores must equal the preimage's pointer when present, NULL when
  // absent. Enforced HERE — the DB has no CHECK for this cross-column business identity.
  const preimagePointer =
    input.preimage.posture === 'present' ? input.preimage.currentCalculationId : null
  if ((input.restoresCalculationId ?? null) !== (preimagePointer ?? null)) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REVERSAL_RESTORES_MISMATCH, 422)
  }
  // §7.3 projection_effect matches the frozen target state.
  const projectionEffect = input.frozenTarget.visibilityState === 'active' ? 'set_active' : 'set_retired'
  const reasonVisibilityConsistent =
    (input.outcomeReasonCode === 'import_rollback_reversal' &&
      (input.frozenTarget.visibilityReason === 'import_rollback' ||
        input.frozenTarget.visibilityReason === 'active')) ||
    (input.outcomeReasonCode === 'operator_retirement' &&
      input.frozenTarget.visibilityReason === 'operator_retirement')
  if (!reasonVisibilityConsistent) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REVERSAL_EFFECT_INVALID, 422)
  }
  if (!HEX64.test(input.frozenTarget.dailyFingerprint)) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REVERSAL_EFFECT_INVALID, 422)
  }
  assertPreimageProjection(input.frozenTarget.projection)
  // F5 (defensive): for a present preimage the reversal RESTORES that exact frozen parent state, and
  // the pointer is moved to `preimage` (owner/visibility/projection) — while the immutable row's
  // projection_effect + projected fields come from `frozenTarget`. §7.3 lines 1449-1451 permit the
  // row's effect to diverge from the *pointed-to earlier calc*, but NOT from the reversal's own
  // preimage: a caller supplying a frozenTarget inconsistent with its own preimage would write a
  // mislabeled immutable row (e.g. effect=set_active while the parent is restored to a retired
  // preimage) that no DB CHECK covers — the §7.5 pointer trigger validates only the pointed-to
  // earlier calc. The real callers derive both from one source, so this only rejects inconsistency.
  if (input.preimage.posture === 'present') {
    const consistent =
      input.frozenTarget.visibilityState === input.preimage.visibilityState &&
      input.frozenTarget.visibilityReason === input.preimage.visibilityReason &&
      (input.preimage.projection === null ||
        preimageProjectionsEqualV1(input.frozenTarget.projection, input.preimage.projection))
    if (!consistent) {
      fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.REVERSAL_EFFECT_INVALID, 422)
    }
  }

  const parent = await lockParent(trx, input.orgId, input.recordId)
  if (parent.currentCalculationId !== input.supersedesCalculationId) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.VERSION_CONFLICT, 409)
  }

  const id = crypto.randomUUID()
  const version = await nextCalculationVersion(trx, input.recordId)
  await assertLineageStrictlyLower(trx, {
    orgId: input.orgId,
    recordId: input.recordId,
    newRowId: id,
    newVersion: version,
    targetId: input.supersedesCalculationId,
  })
  if (input.restoresCalculationId !== null) {
    await assertLineageStrictlyLower(trx, {
      orgId: input.orgId,
      recordId: input.recordId,
      newRowId: id,
      newVersion: version,
      targetId: input.restoresCalculationId,
    })
  }

  await insertResolvedAuthoritativeCalculationRowV1(trx, {
    id,
    orgId: input.orgId,
    recordId: input.recordId,
    version,
    calculationKind: 'reversal',
    entrypoint: input.entrypoint,
    supersedesCalculationId: input.supersedesCalculationId,
    restoresCalculationId: input.restoresCalculationId,
    sourceBatchId: input.sourceBatchId ?? null,
    operationId: input.operationId,
    semanticInputFingerprint: input.reversedSnapshots.semanticInputFingerprint,
    provenanceFingerprint: input.reversedSnapshots.provenanceFingerprint,
    sourceDefinitionFingerprint: input.reversedSnapshots.sourceDefinitionFingerprint,
    attributionSnapshot: input.reversedSnapshots.attributionSnapshot,
    contextSnapshot: input.reversedSnapshots.contextSnapshot,
    segmentSnapshot: [],
    evidenceSnapshot: input.reversedSnapshots.evidenceSnapshot,
    approvedFactsSnapshot: input.reversedSnapshots.approvedFactsSnapshot,
    manualOverrideSnapshot: input.reversedSnapshots.manualOverrideSnapshot,
    inputProvenance: input.inputProvenance,
    mergePolicy: input.mergePolicy,
    calculationTier: 'segment_authoritative',
    outcome: 'reversed',
    outcomeReasonCode: input.outcomeReasonCode,
    projectionEffect,
    expectedSegmentCount: 0,
    projectedStatus: input.frozenTarget.projection.status,
    projectedFirstInAt: input.frozenTarget.projection.firstInAt,
    projectedLastOutAt: input.frozenTarget.projection.lastOutAt,
    projectedWorkMinutes: input.frozenTarget.projection.workMinutes,
    projectedLateMinutes: input.frozenTarget.projection.lateMinutes,
    projectedEarlyLeaveMinutes: input.frozenTarget.projection.earlyLeaveMinutes,
    projectedDailyFingerprint: input.frozenTarget.dailyFingerprint,
    parentPreimageSnapshot: input.preimage,
    actorId: input.actorId,
    correlationId: input.correlationId,
  })

  // Pointer (§7.5): present → restore the earlier calc/owner/visibility; absent → point at THIS
  // reversal row, set_retired. Optimistic on the exact reversed pointer.
  let pointerTarget: string | null
  let owner: 'legacy_untracked' | 'w4'
  let visibilityState: 'active' | 'retired'
  let visibilityReason: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'
  let daily: AttendanceAuthoritativePreimageProjectionV1
  if (input.preimage.posture === 'present') {
    pointerTarget = input.preimage.currentCalculationId
    owner = input.preimage.projectionOwner
    visibilityState = input.preimage.visibilityState
    visibilityReason = input.preimage.visibilityReason
    daily = input.preimage.projection ?? input.frozenTarget.projection
  } else {
    pointerTarget = id
    owner = 'w4'
    visibilityState = 'retired'
    visibilityReason = input.frozenTarget.visibilityReason
    daily = input.frozenTarget.projection
  }

  const updated = await trx.query(
    `UPDATE attendance_records
        SET current_calculation_id = $3::uuid, projection_owner = $4,
            visibility_state = $5, visibility_reason = $6,
            status = $7, first_in_at = $8, last_out_at = $9,
            work_minutes = $10, late_minutes = $11, early_leave_minutes = $12,
            updated_at = now()
      WHERE id = $1::uuid AND org_id = $2
        AND current_calculation_id = $13::uuid
      RETURNING id`,
    [
      input.recordId,
      input.orgId,
      pointerTarget,
      owner,
      visibilityState,
      visibilityReason,
      daily.status,
      daily.firstInAt,
      daily.lastOutAt,
      daily.workMinutes,
      daily.lateMinutes,
      daily.earlyLeaveMinutes,
      // Locked actual current (== supersedesCalculationId after the pre-check), never the caller's
      // claim directly, so the pre-check stays the sole load-bearing stale-predecessor guard.
      parent.currentCalculationId,
    ],
  )
  if (updated.rows.length !== 1) {
    fail(ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1.VERSION_CONFLICT, 409)
  }

  return Object.freeze({
    kind: 'reversed' as const,
    calculationId: id,
    version,
    projectionEffect,
    restoresCalculationId: input.restoresCalculationId,
  })
}
