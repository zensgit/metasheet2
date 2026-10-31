import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  extractAttendanceRequestPayloadMetadataFieldsV1,
  normalizeAttendanceRequestCalculationPayloadV1,
  W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY,
} from './w4c3b-request-snapshots'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { requireAttendanceCorrectionDecisionExecutionV1, requireAttendanceCorrectionSourcePostureV1 } from './w4c3b-request-operation-boundary'
import { calculateAttendanceSegmentsV1 } from './w4c1-segment-calculator'
import type { ShadowCalculationRowInput } from './w4c2-live-scheduled-boundary'
import type { AttendanceW4TransactionClientV1, VerifiedAttendanceOrgIdentityV1, VerifiedAttendanceOperationIdentityV1 } from './w4c0-identity'
import { writeAuthoritativeSegmentCalculationV1, type AttendanceAuthoritativeParentPreimageV1, type WriteAuthoritativeSegmentCalculationInputV1 } from './w4c2-authoritative-calculation-core'
import { loadAttendanceCorrectionSourceV1, validateRetainedAttendanceCorrectionWriteV1, correctionCoreClient, type AttendanceCorrectionQueryClient } from './approved-correction-target-source'
import { correctionTargetFail, verifyCorrectionTargetV1 } from './approved-correction-target-contract'
import type { ApprovedAttendanceFactV1, AttendanceEvidenceV1 } from './w4c0-write-boundary-types'

const correctionWriteAdmissions = new WeakMap<object, Readonly<{ client: AttendanceW4TransactionClientV1; bytes: string }>>()

/** Verifies only the internally computed input. Exporting this check cannot mint admission. */
export function requireApprovedCorrectionWriteAdmissionV1(
  client: AttendanceW4TransactionClientV1,
  input: WriteAuthoritativeSegmentCalculationInputV1,
): WriteAuthoritativeSegmentCalculationInputV1 {
  // Own every subsequently consumed value before the first writer await.
  // structuredClone preserves valid optional undefined fields on legacy inputs.
  const captured = structuredClone(input)
  freezeCorrectionWriteValueV1(captured)
  if (captured.entrypoint === 'correction'
    || captured.approvedFacts.some(fact => fact.kind === 'correction' && 'schemaVersion' in fact && fact.schemaVersion === 2)) {
    const admission = correctionWriteAdmissions.get(input)
    if (!admission || admission.client !== client || admission.bytes !== canonicalAttendanceJsonV1(captured)) {
      correctionTargetFail('ATTENDANCE_CORRECTION_WRITE_ADMISSION_REQUIRED', 422)
    }
  }
  return captured
}

function freezeCorrectionWriteValueV1(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeCorrectionWriteValueV1)
    Object.freeze(value)
  }
}

async function writeVerifiedApprovedCorrectionV1(
  client: AttendanceW4TransactionClientV1,
  input: WriteAuthoritativeSegmentCalculationInputV1,
) {
  const bytes = canonicalAttendanceJsonV1(input)
  const frozen: WriteAuthoritativeSegmentCalculationInputV1 = JSON.parse(bytes)
  freezeCorrectionWriteValueV1(frozen)
  correctionWriteAdmissions.set(frozen, Object.freeze({ client, bytes }))
  try {
    return await writeAuthoritativeSegmentCalculationV1(client, frozen)
  } finally {
    correctionWriteAdmissions.delete(frozen)
  }
}

/** Ordinary carry is admitted only from persisted approval facts and a recomputed result. */
export async function writeRetainedApprovedCorrectionCalculationV1(
  client: AttendanceW4TransactionClientV1, input: WriteAuthoritativeSegmentCalculationInputV1,
  org: VerifiedAttendanceOrgIdentityV1, operation: VerifiedAttendanceOperationIdentityV1,
  execution?: unknown,
) {
  const captured = structuredClone(input)
  freezeCorrectionWriteValueV1(captured)
  // Deferred to avoid initializing the boundary/core module cycle. This await
  // consumes no SQL; caller-owned input is already completely captured.
  const { requireAttendanceRetainedCorrectionExecutionV1 } = await import('./w4c2-live-scheduled-boundary')
  const admitted = requireAttendanceRetainedCorrectionExecutionV1(client, execution, captured, org, operation)
  await validateRetainedAttendanceCorrectionWriteV1(client, captured, admitted.org, admitted.operation)
  requireAttendanceRetainedCorrectionExecutionV1(client, execution, captured, org, operation)
  return writeVerifiedApprovedCorrectionV1(client, captured)
}

type Identity = Readonly<{ orgId: string; userId: string; requestId: string }>
const CORRECTION_TYPES = ['missed_check_in', 'missed_check_out', 'time_correction']
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) correctionTargetFail('ATTENDANCE_CORRECTION_SNAPSHOT_MISMATCH', 409)
  return value as Record<string, unknown>
}
function iso(value: unknown): string | null {
  return value == null ? null : new Date(value as string | Date).toISOString()
}
async function lockedCorrection(client: AttendanceCorrectionQueryClient, identity: Identity, status: 'pending' | 'approved', operation: unknown) {
  identity = Object.freeze({ orgId: identity.orgId, userId: identity.userId, requestId: identity.requestId })
  requireAttendanceCorrectionSourcePostureV1(client, operation, identity)
  const trx = correctionCoreClient(client)
  const rows = await trx.query(
    `SELECT r.*, r.work_date::text AS work_date FROM attendance_requests r
      WHERE r.id = $1::uuid AND r.org_id = $2 AND r.user_id = $3 FOR UPDATE`,
    [identity.requestId, identity.orgId, identity.userId])
  if (rows.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_SNAPSHOT_MISMATCH', 409)
  const request = rows.rows[0]
  if (request.status !== status || !CORRECTION_TYPES.includes(String(request.request_type))) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SNAPSHOT_MISMATCH', 409)
  }
  const snapshots = await trx.query(
    `SELECT * FROM attendance_request_calculation_snapshots
      WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version DESC LIMIT 1 FOR KEY SHARE`,
    [identity.orgId, identity.requestId])
  if (snapshots.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const snapshot = snapshots.rows[0]
  const payload = normalizeAttendanceRequestCalculationPayloadV1(snapshot.payload)
  if (payload.schemaVersion !== 2 || snapshot.request_type !== request.request_type
    || snapshot.subject_user_id !== identity.userId
    || snapshot.payload_fingerprint !== computeAttendanceRequestPayloadFingerprintV1(payload)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SNAPSHOT_MISMATCH', 409)
  }
  const metadata = object(request.metadata)
  const livePayload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
    workDate: request.work_date, requestedInAt: iso(request.requested_in_at), requestedOutAt: iso(request.requested_out_at),
    reason: request.reason, ...extractAttendanceRequestPayloadMetadataFieldsV1(metadata),
  })
  if (computeAttendanceRequestPayloadFingerprintV1(livePayload) !== snapshot.payload_fingerprint) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SNAPSHOT_MISMATCH', 409)
  }
  const source = await loadAttendanceCorrectionSourceV1(client, {
    orgId: identity.orgId, userId: identity.userId, workDate: payload.workDate,
  }, true, operation)
  if (canonicalAttendanceJsonV1(payload.correctionTargets.source) !== canonicalAttendanceJsonV1(source.source)
    || canonicalAttendanceJsonV1(snapshot.context_snapshot) !== canonicalAttendanceJsonV1(source.input.context)
    || canonicalAttendanceJsonV1(snapshot.attribution_snapshot) !== canonicalAttendanceJsonV1(source.input.attribution)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_STALE', 409)
  }
  for (const [key, time] of [['checkIn', payload.requestedInAt], ['checkOut', payload.requestedOutAt]] as const) {
    const selected = payload.correctionTargets[key]
    if (selected && time) verifyCorrectionTargetV1(selected, source.cells, time, source.input.evidence)
  }
  return { trx, request, metadata, snapshot, payload, source }
}

/** Called inside the existing request-operation transaction before terminal DML. */
export async function validatePendingApprovedCorrectionV1(client: AttendanceCorrectionQueryClient, identity: Identity, operation: unknown) {
  await lockedCorrection(client, identity, 'pending', operation)
}

/** Re-read persisted approval binding; no route-supplied fact, issuer or prepared context. */
export async function appendApprovedCorrectionCalculationV1(
  client: AttendanceCorrectionQueryClient,
  identity: Identity & Readonly<{ operationId: string; actorId: string; correlationId: string; mode: 'shadow' | 'authoritative' }>,
  insertShadowCalculation: (client: AttendanceW4TransactionClientV1, input: ShadowCalculationRowInput) => Promise<{ calculationId: string }>,
  operation: unknown,
) {
  identity = Object.freeze({
    orgId: identity.orgId, userId: identity.userId, requestId: identity.requestId,
    operationId: identity.operationId, actorId: identity.actorId,
    correlationId: identity.correlationId, mode: identity.mode,
  })
  requireAttendanceCorrectionDecisionExecutionV1(client, operation, identity)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.operationId)
    || (identity.mode !== 'shadow' && identity.mode !== 'authoritative')) {
    correctionTargetFail('ATTENDANCE_CORRECTION_OPERATION_REQUIRED', 400)
  }
  const { trx, request, metadata, snapshot, payload, source } = await lockedCorrection(client, identity, 'approved', operation)
  const binding = object(metadata[W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY])
  if (binding.schemaVersion !== 1 || binding.kind !== 'w4c3b_request_snapshot_terminal_binding'
    || binding.bindingPosture !== 'bound' || binding.action !== 'approve'
    || binding.orgId !== identity.orgId || binding.requestId !== identity.requestId
    || binding.subjectUserId !== identity.userId || binding.requestType !== request.request_type
    || binding.requestSnapshotVersion !== Number(snapshot.version)
    || binding.requestSnapshotFingerprint !== snapshot.payload_fingerprint) {
    correctionTargetFail('ATTENDANCE_CORRECTION_APPROVAL_MISMATCH', 409)
  }
  const approvals = await trx.query(
    `SELECT a.id FROM approval_instances a JOIN approval_records ar ON ar.instance_id = a.id
      WHERE a.id = $1 AND a.status = 'approved' AND a.version = $2
        AND ar.id = $3::bigint AND ar.action = 'approve' AND ar.to_status = 'approved' AND ar.to_version = $2
      FOR KEY SHARE OF a, ar`, [request.approval_instance_id, binding.approvalVersion, binding.approvalRecordId])
  if (approvals.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_APPROVAL_MISMATCH', 409)
  const changes = []
  const evidence: AttendanceEvidenceV1[] = [...source.input.evidence]
  for (const [key, time] of [['checkIn', payload.requestedInAt], ['checkOut', payload.requestedOutAt]] as const) {
    const target = payload.correctionTargets[key]
    if (!target || time === null) continue
    const adjustmentEvidenceRef = `correction:${identity.requestId}:${target.direction}`
    changes.push({ target, occurredAt: time, adjustmentEvidenceRef })
    evidence.push({ kind: 'approved_adjustment', ref: adjustmentEvidenceRef,
      direction: target.direction, occurredAt: time, source: 'correction' })
  }
  const fact: ApprovedAttendanceFactV1 = {
    kind: 'correction', schemaVersion: 2, requestId: identity.requestId,
    requestSnapshotVersion: Number(snapshot.version), requestSnapshotFingerprint: String(snapshot.payload_fingerprint),
    approvalVersion: Number(binding.approvalVersion), approvalRecordId: String(binding.approvalRecordId), changes,
  }
  const approvedFacts = [...source.input.approvedFacts, fact]
  const calculation = calculateAttendanceSegmentsV1({ ...source.input, evidence, approvedFacts })
  if (calculation.outcome !== 'completed') correctionTargetFail('ATTENDANCE_CORRECTION_CALCULATION_REVIEW_REQUIRED', 409)
  const provenanceRef = { transport: 'approved_request' as const, sourceRef: identity.requestId,
    artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null }
  const inputProvenance = {
    ...provenanceRef, payloadFingerprint: String(snapshot.payload_fingerprint),
    requestSnapshot: { requestId: identity.requestId, version: Number(snapshot.version),
      fingerprint: String(snapshot.payload_fingerprint) },
    approvalInstanceId: request.approval_instance_id, approvalRecordId: binding.approvalRecordId,
    approvalVersion: binding.approvalVersion, correctionSource: source.source,
  }
  let result
  if (identity.mode === 'authoritative') {
    // Existing W4 parent, required by exact-source selection. No fabricated
    // legacy preimage or baseline is needed; the writer validates the pointer.
    if (source.record.current_calculation_id !== source.source.calculationId
      || source.record.visibility_state !== 'active') correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_STALE', 409)
    const preimage: AttendanceAuthoritativeParentPreimageV1 = {
      posture: 'present', projectionOwner: source.record.projection_owner as 'w4' | 'w4_group',
      currentCalculationId: source.source.calculationId, visibilityState: 'active',
      visibilityReason: 'active', projection: {
        status: String(source.record.status), firstInAt: iso(source.record.first_in_at), lastOutAt: iso(source.record.last_out_at),
        workMinutes: Number(source.record.work_minutes), lateMinutes: Number(source.record.late_minutes),
        earlyLeaveMinutes: Number(source.record.early_leave_minutes),
      }, compatibilityFingerprint: null,
    }
    result = await writeVerifiedApprovedCorrectionV1(trx, {
      orgId: identity.orgId, recordId: source.source.recordId, entrypoint: 'correction', operationId: identity.operationId,
      calculation, attribution: source.input.attribution, context: source.input.context,
      evidence, approvedFacts, provenanceRef, inputProvenance,
      payloadFingerprint: String(snapshot.payload_fingerprint), preimage,
      expectedCurrentCalculationId: source.source.calculationId, actorId: identity.actorId, correlationId: identity.correlationId,
    })
  } else {
    const version = await trx.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid',
      [source.source.recordId])
    result = await insertShadowCalculation(trx, {
      orgId: identity.orgId, recordId: source.source.recordId, version: Number(version.rows[0].next),
      entrypoint: 'correction', operationId: identity.operationId, attribution: source.input.attribution,
      context: source.input.context, segmentSnapshot: [...source.input.context!.segments], evidence, approvedFacts,
      inputProvenance, provenanceRef, mergePolicy: 'append', outcome: calculation.outcome,
      outcomeReasonCode: calculation.outcomeReasonCode, segments: calculation.segments, dailyProjection: calculation.dailyProjection,
      actorId: identity.actorId, correlationId: identity.correlationId,
      legacyProjection: { workDate: payload.workDate, status: String(source.record.status),
        firstInAt: iso(source.record.first_in_at), lastOutAt: iso(source.record.last_out_at),
        workMinutes: Number(source.record.work_minutes), lateMinutes: Number(source.record.late_minutes),
        earlyLeaveMinutes: Number(source.record.early_leave_minutes) },
    })
  }
  const record = await trx.query('SELECT * FROM attendance_records WHERE id = $1::uuid AND org_id = $2',
    [source.source.recordId, identity.orgId])
  return { calculationId: result.calculationId, record: record.rows[0] }
}
