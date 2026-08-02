/**
 * W4C-3c P15/P16 — canonical operator retirement (lock §7.8 / §7.10 / §12.6).
 *
 * Writes ops_retirement / outcome=reversed / operator_retirement /
 * projection_effect=set_retired. NEVER deletes attendance_records or
 * W4 calculation children. Ordinary punch/import/approval/recompute cannot
 * reactivate an operator-retired parent (DB pointer guard + application
 * ATTENDANCE_RECORD_OPERATOR_RETIRED fail-closed with zero writes).
 *
 * legacy_untracked first retirement:
 * - appends a legacy_baseline carrying exact daily projection, visibility,
 *   allowlisted meta, and an explicit provenance-quality marker;
 * - never treats first/last as punch evidence;
 * - reversal provenance is truthful and command-stable (caller operationId).
 *
 * Tooling-only fixture teardown for pure non-W4 rows must call
 * assertToolingOnlyNonW4FixtureTeardownAllowedV1 before any DELETE.
 */
import crypto from 'node:crypto'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from './w4c0-fingerprints'
import { ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from './w4c1-segment-calculator'

export const ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'W4C3C_OPS_RETIREMENT_INPUT_INVALID',
  RECORD_NOT_FOUND: 'ATTENDANCE_RECORD_NOT_FOUND',
  ALREADY_RETIRED: 'ATTENDANCE_RECORD_ALREADY_OPERATOR_RETIRED',
  VERSION_CONFLICT: 'ATTENDANCE_RECORD_VERSION_CONFLICT',
  OPERATOR_RETIRED: 'ATTENDANCE_RECORD_OPERATOR_RETIRED',
  TOOLING_TEARDOWN_FORBIDDEN: 'ATTENDANCE_TOOLING_W4_BACKED_DELETE_FORBIDDEN',
  DATABASE_RESULT_INVALID: 'W4C3C_OPS_RETIREMENT_DATABASE_RESULT_INVALID',
  REPLAY_CONFLICT: 'W4C3C_OPS_RETIREMENT_REPLAY_CONFLICT',
  OPERATION_ID_REQUIRED: 'W4C3C_OPS_RETIREMENT_OPERATION_ID_REQUIRED',
} as const)

export class AttendanceW4OpsRetirementError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceW4OpsRetirementError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function fail(code: string, httpStatus = 422): never {
  throw new AttendanceW4OpsRetirementError(code, httpStatus)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64_RE = /^[0-9a-f]{64}$/

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.INPUT_INVALID)
  }
  return value
}

function requireUuid(
  value: unknown,
  code: string = ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.INPUT_INVALID,
): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.toLowerCase())) {
    fail(code)
  }
  return value.toLowerCase()
}

async function rows(
  client: AttendanceW4TransactionClientV1,
  sqlText: string,
  params: readonly unknown[],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sqlText, [...params])
  return result.rows as Array<Record<string, unknown>>
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

/** Allowlisted meta keys preserved on legacy baseline (never full opaque dump). */
const LEGACY_BASELINE_META_ALLOWLIST = Object.freeze([
  'manual_result_edit',
  'source',
  'importBatchId',
  'source_batch_id',
  'smokeStamp',
  'w4',
] as const)

function allowlistedMeta(meta: unknown): Record<string, unknown> | null {
  if (meta === null || meta === undefined) return null
  if (typeof meta !== 'object' || Array.isArray(meta)) return null
  const source = meta as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of LEGACY_BASELINE_META_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key]
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function unsupportedAttribution() {
  return Object.freeze({
    posture: 'unsupported' as const,
    sourceSchemaVersion: null,
    reason: 'missing' as const,
    sourceFingerprint: null,
  })
}

/**
 * Explicit provenance-quality marker for legacy_baseline restore evidence.
 * first/last timestamps are projection fields only — never punch evidence.
 */
export function buildLegacyRetirementBaselineProvenanceV1(input: {
  readonly ticket: string
  readonly reason: string
  readonly operationId: string
  readonly recordId: string
}): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'legacy_baseline_for_operator_retirement',
    provenanceQuality: 'legacy_projection_only_no_punch_evidence',
    treatsFirstLastAsPunchEvidence: false,
    ticket: input.ticket,
    reason: input.reason,
    operationId: input.operationId,
    recordId: input.recordId,
  })
}

export function computeOpsRetirementPayloadFingerprintV1(input: {
  readonly recordId: string
  readonly expectedCalculationId: string | null
  readonly expectedCalculationVersion: number | null
  readonly reason: string
  readonly ticket: string
}): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalAttendanceJsonV1({
        recordId: input.recordId,
        expectedCalculationId: input.expectedCalculationId,
        expectedCalculationVersion: input.expectedCalculationVersion,
        reason: input.reason,
        ticket: input.ticket,
      }),
      'utf8',
    )
    .digest('hex')
}

export interface AppendOperatorRetirementCalculationInputV1 {
  readonly client: AttendanceW4TransactionClientV1
  readonly orgId: string
  readonly recordId: string
  readonly expectedCalculationId: string | null
  readonly expectedCalculationVersion: number | null
  /** Stable operator command UUID — required; never server-generated. */
  readonly operationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly reason: string
  readonly ticket: string
  readonly mode: 'authoritative'
}

export type AppendOperatorRetirementCalculationResultV1 =
  | { readonly kind: 'replay'; readonly calculationId: string }
  | {
      readonly kind: 'appended'
      readonly calculationId: string
      readonly priorCalculationId: string | null
      readonly baselineCalculationId: string | null
      readonly visibilityReason: 'operator_retirement'
    }

/**
 * Append one operator-retirement reversal calculation and, in authoritative
 * mode, set the parent to retired/operator_retirement pointing at the reversal.
 */
export async function appendOperatorRetirementCalculationV1(
  input: AppendOperatorRetirementCalculationInputV1,
): Promise<AppendOperatorRetirementCalculationResultV1> {
  const orgId = requireText(input.orgId, 128)
  const recordId = requireUuid(input.recordId)
  if (input.operationId === null || input.operationId === undefined || input.operationId === '') {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATION_ID_REQUIRED)
  }
  const operationId = requireUuid(
    input.operationId,
    ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATION_ID_REQUIRED,
  )
  const actorId = requireText(input.actorId, 128)
  const correlationId = requireText(input.correlationId, 128)
  const reason = requireText(input.reason, 2000)
  const ticket = requireText(input.ticket, 128)
  if (input.mode !== 'authoritative') {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.INPUT_INVALID)
  }
  const expectedCalculationId =
    input.expectedCalculationId === null || input.expectedCalculationId === undefined
      ? null
      : requireUuid(input.expectedCalculationId)
  if (
    input.expectedCalculationVersion !== null
    && input.expectedCalculationVersion !== undefined
    && (!Number.isSafeInteger(input.expectedCalculationVersion) || input.expectedCalculationVersion < 1)
  ) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.INPUT_INVALID)
  }
  const payloadFingerprint = computeOpsRetirementPayloadFingerprintV1({
    recordId,
    expectedCalculationId,
    expectedCalculationVersion: input.expectedCalculationVersion ?? null,
    reason,
    ticket,
  })

  const recordRows = await rows(
    input.client,
    `SELECT id::text AS id, org_id::text AS org_id, user_id::text AS user_id,
            work_date::text AS work_date,
            current_calculation_id::text AS current_calculation_id,
            projection_owner, visibility_state, visibility_reason,
            status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
            timezone, is_workday, meta
       FROM attendance_records
      WHERE id = $1::uuid AND org_id = $2
      FOR UPDATE`,
    [recordId, orgId],
  )
  if (recordRows.length === 0) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.RECORD_NOT_FOUND, 404)
  }
  if (recordRows.length !== 1) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  }
  const record = recordRows[0]

  // Response-loss replay must win over terminal already-retired rejection so a
  // successful authoritative command can be safely retried with the same
  // operationId + payload.
  const replayRows = await rows(
    input.client,
    `SELECT id::text AS id,
            attendance_record_id::text AS attendance_record_id,
            input_provenance
       FROM attendance_record_calculations
      WHERE org_id = $1 AND entrypoint = 'ops_retirement' AND operation_id = $2::uuid
        AND calculation_kind = 'reversal'
      FOR UPDATE`,
    [orgId, operationId],
  )
  if (replayRows.length > 1) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  }
  if (replayRows.length === 1) {
    const existing = replayRows[0]
    if (String(existing.attendance_record_id) !== recordId) {
      fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.REPLAY_CONFLICT, 409)
    }
    const provenance =
      existing.input_provenance && typeof existing.input_provenance === 'object'
        ? (existing.input_provenance as Record<string, unknown>)
        : null
    const existingFp =
      provenance && typeof provenance.payloadFingerprint === 'string'
        ? provenance.payloadFingerprint
        : null
    if (existingFp !== payloadFingerprint) {
      fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.REPLAY_CONFLICT, 409)
    }
    return Object.freeze({ kind: 'replay', calculationId: String(existing.id) })
  }

  if (
    record.visibility_state === 'retired'
    && record.visibility_reason === 'operator_retirement'
  ) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.ALREADY_RETIRED, 409)
  }

  const priorCalculationId =
    typeof record.current_calculation_id === 'string' ? record.current_calculation_id : null
  if (expectedCalculationId !== null && priorCalculationId !== expectedCalculationId) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.VERSION_CONFLICT, 409)
  }

  const workDate = String(record.work_date).slice(0, 10)
  const userId = String(record.user_id)
  const status = typeof record.status === 'string' ? record.status : 'absent'
  // Projection fields only — not punch evidence.
  const firstInAt = nullableIso(record.first_in_at)
  const lastOutAt = nullableIso(record.last_out_at)
  const workMinutes = nullableNonNegativeInteger(record.work_minutes) ?? 0
  const lateMinutes = nullableNonNegativeInteger(record.late_minutes) ?? 0
  const earlyLeaveMinutes = nullableNonNegativeInteger(record.early_leave_minutes) ?? 0
  const visibilityState = String(record.visibility_state ?? 'active')
  const visibilityReason = String(record.visibility_reason ?? 'active')
  const projectionOwner = String(record.projection_owner ?? 'legacy_untracked')
  const metaAllowlist = allowlistedMeta(record.meta)

  const dailyFingerprint = crypto
    .createHash('sha256')
    .update(
      canonicalAttendanceJsonV1({
        status,
        firstInAt,
        lastOutAt,
        workMinutes,
        lateMinutes,
        earlyLeaveMinutes,
      }),
      'utf8',
    )
    .digest('hex')

  const zeroFp = '0'.repeat(64)
  let nextVersion = 1
  let priorAttribution: unknown = unsupportedAttribution()
  let priorContext: unknown = Object.freeze({
    schemaVersion: 1,
    kind: 'legacy_projection_baseline',
  })
  let priorEvidence: unknown = []
  let priorApproved: unknown = []
  let priorManual: unknown = null
  let priorSourceDef: string = zeroFp

  if (priorCalculationId) {
    const calcRows = await rows(
      input.client,
      `SELECT id::text AS id, version, outcome, outcome_reason_code,
              attribution_snapshot, context_snapshot, evidence_snapshot,
              approved_facts_snapshot, manual_override_snapshot,
              semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint
         FROM attendance_record_calculations
        WHERE id = $1::uuid AND attendance_record_id = $2::uuid AND org_id = $3
        FOR UPDATE`,
      [priorCalculationId, recordId, orgId],
    )
    if (calcRows.length !== 1) {
      fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.VERSION_CONFLICT, 409)
    }
    const prior = calcRows[0]
    nextVersion = Number(prior.version) + 1
    if (
      input.expectedCalculationVersion !== null
      && input.expectedCalculationVersion !== undefined
      && Number(prior.version) !== input.expectedCalculationVersion
    ) {
      fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.VERSION_CONFLICT, 409)
    }
    priorAttribution = prior.attribution_snapshot ?? unsupportedAttribution()
    priorContext = prior.context_snapshot
      ?? Object.freeze({ schemaVersion: 1, kind: 'legacy_projection_baseline' })
    priorEvidence = prior.evidence_snapshot ?? []
    priorApproved = prior.approved_facts_snapshot ?? []
    priorManual = prior.manual_override_snapshot
    const priorSemantic = String(prior.semantic_input_fingerprint || zeroFp)
    const priorProvenance = String(prior.provenance_fingerprint || zeroFp)
    priorSourceDef =
      prior.source_definition_fingerprint === null || prior.source_definition_fingerprint === undefined
        ? zeroFp
        : String(prior.source_definition_fingerprint)
    if (!HEX64_RE.test(priorSemantic) || !HEX64_RE.test(priorProvenance) || !HEX64_RE.test(priorSourceDef)) {
      fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
    }
  } else if (
    input.expectedCalculationVersion !== null
    && input.expectedCalculationVersion !== undefined
  ) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.VERSION_CONFLICT, 409)
  }

  const calculationId = crypto.randomUUID()
  const provenanceRef = Object.freeze({
    transport: 'operator_retirement' as const,
    sourceRef: ticket,
    artifactSha256: null,
    normalizedCsvSha256: null,
    convertedSheetName: null,
  })
  const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(provenanceRef)
  let semanticFingerprint: string
  try {
    semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
      attribution: priorAttribution,
      context: priorContext,
      evidence: priorEvidence,
      approvedFacts: priorApproved,
      manualOverride: priorManual,
      mergePolicy: 'retire',
      calculationTier: 'segment_authoritative',
      engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      snapshotSchemaVersion: 1,
    })
  } catch {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  }

  // chk_arc_reversal_supersedes: reversals must supersede a prior calculation.
  // legacy_untracked first retirement: mint truthful legacy_baseline restore witness.
  let supersedesId = priorCalculationId
  let reversalVersion = nextVersion
  let baselineCalculationId: string | null = null
  if (!supersedesId) {
    const baselineId = crypto.randomUUID()
    const baselineProvenance = buildLegacyRetirementBaselineProvenanceV1({
      ticket,
      reason,
      operationId,
      recordId,
    })
    // Closed present preimage (7 keys) + exact daily projection/visibility.
    // first/last are projection fields only — never punch evidence.
    const parentPreimage = Object.freeze({
      posture: 'present' as const,
      projection: Object.freeze({
        status,
        firstInAt,
        lastOutAt,
        workMinutes,
        lateMinutes,
        earlyLeaveMinutes,
      }),
      projectionOwner,
      currentCalculationId: null,
      visibilityState,
      visibilityReason,
      compatibilityFingerprint: dailyFingerprint,
    })
    await rows(
      input.client,
      `INSERT INTO attendance_record_calculations (
          id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
          engine_version, snapshot_schema_version, supersedes_calculation_id, operation_id,
          semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
          attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
          approved_facts_snapshot, manual_override_snapshot, input_provenance,
          merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
          expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
          projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          projected_daily_fingerprint, parent_preimage_snapshot, actor_id, correlation_id
        ) VALUES (
          $1::uuid, $2, $3::uuid, 1, 'legacy_baseline', $4, 'ops_retirement',
          $5, 1, NULL, NULL,
          $6, $6, $6,
          $7::jsonb, $8::jsonb, '[]'::jsonb, '[]'::jsonb,
          '[]'::jsonb, NULL, $9::jsonb,
          'append', 'legacy_shadow', 'baseline', 'legacy_projection_baseline', 'none',
          0, $10, $11, $12, $13, $14, $15, $16,
          $17::jsonb, $18, $19
        )`,
      [
        baselineId,
        orgId,
        recordId,
        input.mode,
        ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
        dailyFingerprint,
        canonicalAttendanceJsonV1(unsupportedAttribution()),
        canonicalAttendanceJsonV1({ schemaVersion: 1, kind: 'legacy_projection_baseline' }),
        // Provenance-quality marker + allowlisted meta; never invent punch evidence.
        canonicalAttendanceJsonV1({
          ...baselineProvenance,
          allowlistedMeta: metaAllowlist,
          workDate,
          userId,
        }),
        status,
        firstInAt,
        lastOutAt,
        workMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        dailyFingerprint,
        canonicalAttendanceJsonV1(parentPreimage),
        actorId,
        correlationId,
      ],
    )
    supersedesId = baselineId
    baselineCalculationId = baselineId
    reversalVersion = 2
  }

  await rows(
    input.client,
    `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version, supersedes_calculation_id, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, manual_override_snapshot, input_provenance,
        merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
        expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        projected_daily_fingerprint, actor_id, correlation_id
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, 'reversal', $5, 'ops_retirement',
        $6, 1, $7::uuid, $8::uuid,
        $9, $10, $11,
        $12::jsonb, $13::jsonb, '[]'::jsonb, $14::jsonb,
        $15::jsonb, $16::jsonb, $17::jsonb,
        'retire', 'segment_authoritative', 'reversed', 'operator_retirement', 'set_retired',
        0, $18, $19, $20, $21, $22, $23, $24,
        $25, $26
      )`,
    [
      calculationId,
      orgId,
      recordId,
      reversalVersion,
      input.mode,
      ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      supersedesId,
      operationId,
      semanticFingerprint,
      provenanceFingerprint,
      priorSourceDef,
      canonicalAttendanceJsonV1(priorAttribution),
      canonicalAttendanceJsonV1(priorContext),
      // Evidence is prior evidence only — never fabricated from first/last.
      canonicalAttendanceJsonV1(priorEvidence),
      canonicalAttendanceJsonV1(priorApproved),
      priorManual === null ? null : canonicalAttendanceJsonV1(priorManual),
      canonicalAttendanceJsonV1({
        provenance: provenanceRef,
        reason,
        ticket,
        operationId,
        payloadFingerprint,
        baselineCalculationId,
        treatsFirstLastAsPunchEvidence: false,
      }),
      status,
      firstInAt,
      lastOutAt,
      workMinutes,
      lateMinutes,
      earlyLeaveMinutes,
      dailyFingerprint,
      actorId,
      correlationId,
    ],
  )

  if (input.mode === 'authoritative') {
    const updated = await rows(
      input.client,
      `UPDATE attendance_records
          SET current_calculation_id = $3::uuid,
              projection_owner = 'w4',
              visibility_state = 'retired',
              visibility_reason = 'operator_retirement',
              updated_at = now()
        WHERE id = $1::uuid AND org_id = $2
          AND (
            ($4::uuid IS NULL AND current_calculation_id IS NULL)
            OR current_calculation_id = $4::uuid
          )
        RETURNING id`,
      [recordId, orgId, calculationId, priorCalculationId],
    )
    if (updated.length !== 1) {
      fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.VERSION_CONFLICT, 409)
    }
  }

  return Object.freeze({
    kind: 'appended',
    calculationId,
    priorCalculationId,
    baselineCalculationId,
    visibilityReason: 'operator_retirement',
  })
}

/**
 * Ordinary writers must call this after locking a parent. Operator-retired
 * parents fail closed with zero further writes
 * (`ATTENDANCE_RECORD_OPERATOR_RETIRED`).
 */
export function assertParentNotOperatorRetiredV1(row: {
  visibility_state?: unknown
  visibility_reason?: unknown
  visibilityState?: unknown
  visibilityReason?: unknown
}): void {
  const state = String(row.visibility_state ?? row.visibilityState ?? '')
  const reason = String(row.visibility_reason ?? row.visibilityReason ?? '')
  if (state === 'retired' && reason === 'operator_retirement') {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATOR_RETIRED, 409)
  }
}

/**
 * Ordinary result writers (manual_edit / recompute / punch / import / approval)
 * must never reactivate any retired parent. Fail before result DML:
 * - operator_retirement → ATTENDANCE_RECORD_OPERATOR_RETIRED (required code)
 * - any other retired reason (e.g. import_rollback) → ATTENDANCE_RECORD_RETIRED
 */
export function assertParentNotRetiredForOrdinaryWriterV1(row: {
  visibility_state?: unknown
  visibility_reason?: unknown
  visibilityState?: unknown
  visibilityReason?: unknown
}): void {
  const state = String(row.visibility_state ?? row.visibilityState ?? '')
  const reason = String(row.visibility_reason ?? row.visibilityReason ?? '')
  if (state !== 'retired') return
  if (reason === 'operator_retirement') {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATOR_RETIRED, 409)
  }
  const error = new AttendanceW4OpsRetirementError('ATTENDANCE_RECORD_RETIRED', 409)
  throw error
}

export interface ToolingOnlyNonW4FixtureTeardownGuardInputV1 {
  readonly purpose: 'tooling_only_non_w4_fixture_teardown'
  readonly orgId: string
  readonly recordIds: readonly string[]
  /** Caller-supplied proof that every target has zero W4 immutable rows. */
  readonly w4ImmutableRowCount: number
  readonly explicitGuardToken: 'ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN'
}

/**
 * Direct DELETE of attendance_records is allowed only for non-W4 test fixtures
 * after a guard proves zero immutable W4 rows (lock §7.10 last bullet).
 */
export function assertToolingOnlyNonW4FixtureTeardownAllowedV1(
  input: ToolingOnlyNonW4FixtureTeardownGuardInputV1,
): void {
  if (input.purpose !== 'tooling_only_non_w4_fixture_teardown') {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.TOOLING_TEARDOWN_FORBIDDEN, 403)
  }
  if (input.explicitGuardToken !== 'ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN') {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.TOOLING_TEARDOWN_FORBIDDEN, 403)
  }
  if (typeof input.orgId !== 'string' || input.orgId.length === 0) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.INPUT_INVALID)
  }
  if (!Array.isArray(input.recordIds)) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.INPUT_INVALID)
  }
  if (!Number.isSafeInteger(input.w4ImmutableRowCount) || input.w4ImmutableRowCount !== 0) {
    fail(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.TOOLING_TEARDOWN_FORBIDDEN, 403)
  }
}

/**
 * SQL generator fragment for P15: never emits DELETE against attendance_records.
 * Emits a comment + instruction to call the ops_retirement boundary instead.
 */
export function buildOperatorRetirementCleanupPlanSqlV1(options: {
  orgId: string
  sourceTag: string
  from?: string
  to?: string
}): string {
  const orgId = String(options.orgId).replace(/'/g, "''")
  const source = String(options.sourceTag).replace(/'/g, "''")
  const where = [`e.org_id = '${orgId}'`, `e.source = '${source}'`]
  if (options.from) where.push(`e.occurred_at >= '${String(options.from).replace(/'/g, "''")}'`)
  if (options.to) where.push(`e.occurred_at < '${String(options.to).replace(/'/g, "''")}'`)
  return `-- W4C-3c P15: privileged cleanup uses ops_retirement, NEVER DELETE on attendance_records.
-- Generate target record ids, then invoke the canonical ops_retirement boundary per id
-- with a caller-supplied stable operator command UUID (no server random identity).
-- Executable authenticated path:
--   node scripts/attendance/execute-ops-retirement-cleanup.cjs \\
--     --source ${source} --org ${orgId} --base-url <url> --token <token>
-- Tooling-only non-W4 fixture teardown must call assertToolingOnlyNonW4FixtureTeardownAllowedV1.
BEGIN;

SELECT DISTINCT r.id AS record_id, r.org_id, r.user_id, r.work_date,
       r.current_calculation_id, r.visibility_state, r.visibility_reason
  FROM attendance_events e
  JOIN attendance_records r
    ON r.org_id = e.org_id AND r.user_id = e.user_id AND r.work_date = e.work_date
 WHERE ${where.join(' AND ')};

-- DO NOT: DELETE FROM attendance_records ...
-- DO: POST /api/attendance/records/:id/ops-retirement with operationId, reason, ticket
--     through the record-operation boundary (kind=ops_retirement).

COMMIT;
`
}
