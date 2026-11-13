import { requireAttendanceCorrectionSourcePostureV1 } from './w4c3b-request-operation-boundary'
import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  extractAttendanceRequestPayloadMetadataFieldsV1,
  normalizeAttendanceRequestCalculationPayloadV1,
  W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY,
} from './w4c3b-request-snapshots'
import type { WriteAuthoritativeSegmentCalculationInputV1 } from './w4c2-authoritative-calculation-core'
import type { ApprovedAttendanceFactV1, AttendanceEvidenceV1 } from './w4c0-write-boundary-types'
import { ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1 } from './w7-compare-window-status'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceSemanticInputFingerprintV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
  inspectAttendanceCorrectionCellsV1,
  type AttendanceSegmentCalculationInputV1,
} from './w4c1-segment-calculator'
import { assertParentNotRetiredForOrdinaryWriterV1 } from './w4c3c-ops-retirement'
import {
  correctionCandidatesForCellsV1, correctionTargetFail, normalizeAttendanceCorrectionTargetsV1,
  verifyCorrectionTargetV1,
  type AttendanceCorrectionSourceV1, type AttendanceCorrectionTargetsV1,
} from './approved-correction-target-contract'
import {
  AttendanceW4IdentityError, acquireAttendanceCalculationRolloutLock,
  parseCanonicalAttendanceRolloutOrgKeyV1, resolveSegmentCalculationPosture,
  requireVerifiedAttendanceOrgIdentityV1, requireVerifiedAttendanceOperationIdentityV1,
  type VerifiedAttendanceOrgIdentityV1, type VerifiedAttendanceOperationIdentityV1,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'

type Subject = Readonly<{ orgId: string; userId: string; workDate: string }>
export type AttendanceCorrectionQueryClient = Readonly<{
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[] | { rows: Record<string, unknown>[] }>
}>
export function correctionCoreClient(client: AttendanceCorrectionQueryClient): AttendanceW4TransactionClientV1 {
  return { query: async (sql, params) => {
    const result = await client.query(sql, params)
    return { rows: Array.isArray(result) ? result : result.rows }
  } }
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED') }
}
export async function loadAttendanceCorrectionSourceV1(
  client: AttendanceCorrectionQueryClient, subject: Subject, lock = false, operation?: unknown,
) {
  if (!subject.orgId || !subject.userId || !/^\d{4}-\d{2}-\d{2}$/.test(subject.workDate)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_INVALID', 400)
  }
  if (operation !== undefined) {
    const posture = requireAttendanceCorrectionSourcePostureV1(client, operation, subject)
    return loadResolvedAttendanceCorrectionSourceV1(client, subject, lock, posture)
  }
  // Standalone source projection takes its prefix before its own source reads.
  // Transactional host ports always supply their existing admitted operation.
  const trx = correctionCoreClient(client)
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(subject.orgId)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const { writePosture } = await resolveSegmentCalculationPosture(trx, orgKey)
  if (writePosture === 'blocked') correctionTargetFail('ATTENDANCE_CORRECTION_POSTURE_BLOCKED', 503)
  if (writePosture !== 'authoritative' && writePosture !== 'shadow') {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  return loadResolvedAttendanceCorrectionSourceV1(client, subject, lock, writePosture)
}
async function loadResolvedAttendanceCorrectionSourceV1(
  client: AttendanceCorrectionQueryClient, subject: Subject, lock: boolean,
  writePosture: 'shadow' | 'authoritative',
  compareLive = true,
) {
  const trx = correctionCoreClient(client)
  const authoritative = writePosture === 'authoritative'
  const parents = await trx.query(
    `SELECT r.*, r.id::text AS id, r.work_date::text AS work_date,
            r.current_calculation_id::text AS current_calculation_id
       FROM attendance_records r
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date
      ${lock ? 'FOR UPDATE' : ''}`, [subject.orgId, subject.userId, subject.workDate])
  if (parents.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const record = parents.rows[0]
  assertParentNotRetiredForOrdinaryWriterV1(record)
  if (authoritative && (record.visibility_state !== 'active' || typeof record.current_calculation_id !== 'string')) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  // Authoritative rollback can restore an older active calculation. Shadow
  // history has no active projection pointer and is selected independently.
  const calculations = await trx.query(
    `SELECT c.*, c.id::text AS id
       FROM attendance_record_calculations c
      WHERE c.org_id = $1 AND c.attendance_record_id = $2::uuid
        AND c.calculation_kind = 'calculation'
        AND NOT (c.input_provenance ? $3)
        AND c.mode = $4
        ${authoritative ? 'AND c.id = $5::uuid' : ''}
      ORDER BY c.version DESC LIMIT 1 ${lock ? 'FOR KEY SHARE' : ''}`,
    [subject.orgId, record.id, ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1, writePosture,
      ...(authoritative ? [record.current_calculation_id] : [])])
  if (calculations.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const prior = calculations.rows[0]
  const { input, cells, fingerprint } = await verifyFrozenCorrectionSourceV1(trx, subject, record, prior, lock)
  // Compare original punches, including approved outdoor punches, against the
  // frozen punch universe. Generic adjustment audits are not punch evidence.
  if (compareLive) {
    const live = await trx.query(
      `SELECT id::text AS id, event_type, occurred_at, source FROM attendance_events
        WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
          AND event_type IN ('check_in', 'check_out')
        ORDER BY id ${lock ? 'FOR KEY SHARE' : ''}`, [subject.orgId, subject.userId, subject.workDate])
    const frozenEvents = input.evidence.filter(item => item.kind === 'punch' && item.source !== 'import')
    if (live.rows.length !== frozenEvents.length || live.rows.some(row => !frozenEvents.some(item =>
      item.kind === 'punch' && item.ref === row.id && item.direction === row.event_type
      && item.occurredAt === new Date(row.occurred_at as string | Date).toISOString()
      && item.source === (row.source === 'outdoor_approval' ? 'outdoor_approval' : 'attendance_event')))) {
      correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_STALE', 409)
    }
  }
  const source: AttendanceCorrectionSourceV1 = Object.freeze({
    recordId: String(record.id), calculationId: String(prior.id), calculationVersion: Number(prior.version),
    semanticInputFingerprint: fingerprint,
  })
  const candidates = correctionCandidatesForCellsV1(cells)
  return { record, prior, input, cells, source, candidates }
}

async function verifyFrozenCorrectionSourceV1(
  trx: AttendanceW4TransactionClientV1, subject: Subject, record: Record<string, unknown>,
  prior: Record<string, unknown>, lock = false,
) {
  if (prior.engine_version !== ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 || prior.snapshot_schema_version !== 1) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  if (prior.outcome !== 'completed' && prior.outcome !== 'review_required') {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  const children = await trx.query(
    `SELECT segment_index FROM attendance_record_segments
      WHERE calculation_id = $1::uuid AND record_id = $2::uuid AND org_id = $3
      ORDER BY segment_index ${lock ? 'FOR KEY SHARE' : ''}`, [prior.id, record.id, subject.orgId])
  const expected = Number(prior.expected_segment_count)
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 3
    || children.rows.length !== expected || children.rows.some((row, index) => Number(row.segment_index) !== index)
    || (prior.outcome === 'completed' && expected === 0)
    || (prior.outcome === 'review_required' && expected !== 0)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  if (prior.manual_override_snapshot !== null) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const input = {
    attribution: json(prior.attribution_snapshot), context: json(prior.context_snapshot),
    evidence: json(prior.evidence_snapshot), approvedFacts: json(prior.approved_facts_snapshot),
  } as AttendanceSegmentCalculationInputV1
  const context = input.context
  if (!context || context.orgId !== subject.orgId || context.userId !== subject.userId
    || context.workDate !== subject.workDate
    || (prior.outcome === 'completed' && context.segments.length !== expected)
    || canonicalAttendanceJsonV1(json(prior.segment_snapshot)) !== canonicalAttendanceJsonV1(context.segments)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
  }
  const cells = inspectAttendanceCorrectionCellsV1(input)
  if (!cells) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const fingerprint = computeAttendanceSemanticInputFingerprintV1({
    ...input, manualOverride: null, mergePolicy: prior.merge_policy, calculationTier: prior.calculation_tier,
    engineVersion: prior.engine_version, snapshotSchemaVersion: prior.snapshot_schema_version,
  })
  if (fingerprint !== prior.semantic_input_fingerprint
    || computeAttendanceSourceDefinitionFingerprintV1({ attribution: input.attribution, context: input.context }) !== prior.source_definition_fingerprint) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
  }
  return { input, cells, fingerprint }
}
export async function readAttendanceCorrectionTargetsV1(client: AttendanceCorrectionQueryClient, subject: Subject) {
  const legacy = () => Object.freeze({ schemaVersion: 1 as const, posture: 'legacy_projection_only' as const,
    source: null, candidates: [] })
  let orgKey: ReturnType<typeof parseCanonicalAttendanceRolloutOrgKeyV1>
  try { orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(subject.orgId) }
  catch (error) {
    if (error instanceof AttendanceW4IdentityError && error.code === 'W4C0_ROLLOUT_ORG_KEY_INVALID') return legacy()
    throw error
  }
  const trx = correctionCoreClient(client)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, orgKey)
  if (posture.writePosture === 'legacy_projection_only') return legacy()
  if (posture.writePosture === 'blocked') correctionTargetFail('ATTENDANCE_CORRECTION_POSTURE_BLOCKED', 503)
  const verified = await loadResolvedAttendanceCorrectionSourceV1(client, subject, false, posture.writePosture)
  const baseline = calculateAttendanceSegmentsV1({ ...verified.input, evidence: [], approvedFacts: [] })
  if (baseline.outcome !== 'completed' || !verified.input.context) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const candidates = verified.candidates.map(target => {
    const segment = baseline.segments.find(item => item.segmentIndex === target.segmentIndex)!
    const evidence = target.kind === 'replacement' ? verified.input.evidence.find(item => item.ref === target.evidenceRef) : null
    return Object.freeze({ target, display: Object.freeze({
      timezone: verified.input.context!.timezone, expectedStartAt: segment.expectedStartAt, expectedEndAt: segment.expectedEndAt,
      originalOccurredAt: evidence && evidence.kind !== 'scheduled_absence' ? evidence.occurredAt : null,
      source: evidence && evidence.kind !== 'scheduled_absence' ? evidence.source : 'empty_boundary',
    }) })
  })
  return Object.freeze({ schemaVersion: 1 as const, posture: 'canonical' as const, source: verified.source, candidates })
}
export async function freezeAttendanceCorrectionTargetsV1(
  client: AttendanceCorrectionQueryClient,
  subject: Subject & { requestedInAt: string | Date | null; requestedOutAt: string | Date | null },
  value: unknown,
  operation?: unknown,
) {
  const selected = normalizeAttendanceCorrectionTargetsV1(value)
  const verified = await loadAttendanceCorrectionSourceV1(client, subject, false, operation)
  if (canonicalAttendanceJsonV1(selected.source) !== canonicalAttendanceJsonV1(verified.source)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_STALE', 409)
  }
  const sides: { checkIn: AttendanceCorrectionTargetsV1['checkIn']; checkOut: AttendanceCorrectionTargetsV1['checkOut'] } = { checkIn: null, checkOut: null }
  for (const [key, direction, time] of [
    ['checkIn', 'check_in', subject.requestedInAt], ['checkOut', 'check_out', subject.requestedOutAt],
  ] as const) {
    if (time === null) {
      if (selected[key] !== null) correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_MISMATCH')
      sides[key] = null
      continue
    }
    const candidates = verified.candidates.filter(item => item.direction === direction)
    const target = selected[key] ?? (candidates.length === 1 ? candidates[0] : null)
    if (target === null) correctionTargetFail('ATTENDANCE_CORRECTION_TARGET_SELECTION_REQUIRED')
    const instant = time instanceof Date ? time.toISOString() : time
    verifyCorrectionTargetV1(target, verified.cells, instant, verified.input.evidence)
    sides[key] = target
  }
  return Object.freeze({
    targets: Object.freeze({ schemaVersion: 1 as const, source: verified.source, ...sides }),
    attributionSnapshot: verified.input.attribution, contextSnapshot: verified.input.context,
  })
}

function correctionObjectV1(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
  return value as Record<string, unknown>
}

function requireCarryOperationV1(subject: Subject, org: unknown, operation: unknown) {
  const verifiedOrg = requireVerifiedAttendanceOrgIdentityV1(org)
  const identity = requireVerifiedAttendanceOperationIdentityV1(operation)
  if (identity.org !== verifiedOrg || verifiedOrg.orgId !== subject.orgId
    || (identity.entrypoint !== 'live_punch' && identity.entrypoint !== 'scheduled')
    || (verifiedOrg.acceptedWritePosture !== 'shadow' && verifiedOrg.acceptedWritePosture !== 'authoritative')) {
    correctionTargetFail('ATTENDANCE_CORRECTION_OPERATION_REQUIRED', 400)
  }
  return verifiedOrg.acceptedWritePosture
}

/** Capture before a live event/legacy projection changes the genuine punch universe. */
export async function loadRetainedAttendanceCorrectionsV1(
  client: AttendanceCorrectionQueryClient, subject: Subject,
  org: VerifiedAttendanceOrgIdentityV1, operation: VerifiedAttendanceOperationIdentityV1,
) {
  return readRetainedAttendanceCorrectionsV1(client, subject, org, operation, true)
}

async function readRetainedAttendanceCorrectionsV1(
  client: AttendanceCorrectionQueryClient, subject: Subject, org: unknown, operation: unknown, compareLive: boolean,
) {
  subject = Object.freeze({ orgId: subject.orgId, userId: subject.userId, workDate: subject.workDate })
  const mode = requireCarryOperationV1(subject, org, operation)
  const trx = correctionCoreClient(client)
  const selected = await trx.query(
    `SELECT c.approved_facts_snapshot FROM attendance_records r
      JOIN attendance_record_calculations c ON c.org_id = r.org_id AND c.attendance_record_id = r.id
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date
        AND c.mode = $4 AND c.calculation_kind = 'calculation'
        AND NOT (c.input_provenance ? $5)
        ${mode === 'authoritative' ? 'AND c.id = r.current_calculation_id' : ''}
      ORDER BY c.version DESC LIMIT 1`,
    [subject.orgId, subject.userId, subject.workDate, mode, ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1])
  const stored = selected.rows.length ? json(selected.rows[0].approved_facts_snapshot) : []
  if (!Array.isArray(stored)) correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  const empty = { approvedFacts: [] as ApprovedAttendanceFactV1[], evidence: [] as AttendanceEvidenceV1[], source: null, sourceDefinitionFingerprint: null }
  if (!stored.some(fact => fact?.kind === 'correction' && fact.schemaVersion === 2)) return empty
  // Mixed financial facts, old correction shapes and manual overrides need their
  // own composition policy. Carrying an exact correction never invents one.
  if (stored.some(fact => fact?.kind !== 'correction' || fact.schemaVersion !== 2)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  const source = await loadResolvedAttendanceCorrectionSourceV1(client, subject, false, mode, compareLive)
  if (source.input.evidence.some(item => item.kind === 'punch' && item.source === 'import')) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
  }
  const facts: ApprovedAttendanceFactV1[] = []
  const evidence: AttendanceEvidenceV1[] = []
  for (const fact of source.input.approvedFacts) {
    if (fact.kind !== 'correction' || !('schemaVersion' in fact) || fact.schemaVersion !== 2) {
      correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
    }
    // No request/snapshot/approval row locks here: read the frozen snapshot
    // and exact terminal approval tuple in the existing SERIALIZABLE snapshot.
    // This avoids taking request -> parent in reverse after the parent lock.
    const requests = await trx.query(
      `SELECT r.*, r.work_date::text AS work_date FROM attendance_requests r
        WHERE r.id = $1::uuid AND r.org_id = $2 AND r.user_id = $3`,
      [fact.requestId, subject.orgId, subject.userId])
    if (requests.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_APPROVAL_MISMATCH', 409)
    const request = requests.rows[0]
    const snapshots = await trx.query(
      `SELECT * FROM attendance_request_calculation_snapshots
        WHERE org_id = $1 AND request_id = $2::uuid AND version = $3`,
      [subject.orgId, fact.requestId, fact.requestSnapshotVersion])
    if (snapshots.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_SNAPSHOT_MISMATCH', 409)
    const snapshot = snapshots.rows[0]
    const payload = normalizeAttendanceRequestCalculationPayloadV1(snapshot.payload)
    const metadata = correctionObjectV1(request.metadata)
    const binding = correctionObjectV1(metadata[W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY])
    const instant = (value: unknown) => value == null ? null : new Date(value as string | Date).toISOString()
    const currentPayload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
      workDate: request.work_date, requestedInAt: instant(request.requested_in_at), requestedOutAt: instant(request.requested_out_at),
      reason: request.reason, ...extractAttendanceRequestPayloadMetadataFieldsV1(metadata),
    })
    if (payload.schemaVersion !== 2 || payload.workDate !== subject.workDate || request.status !== 'approved'
      || !['missed_check_in', 'missed_check_out', 'time_correction'].includes(String(request.request_type))
      || snapshot.request_type !== request.request_type || snapshot.subject_user_id !== subject.userId
      || Number(snapshot.version) !== fact.requestSnapshotVersion
      || snapshot.payload_fingerprint !== fact.requestSnapshotFingerprint
      || computeAttendanceRequestPayloadFingerprintV1(payload) !== fact.requestSnapshotFingerprint
      || computeAttendanceRequestPayloadFingerprintV1(currentPayload) !== fact.requestSnapshotFingerprint
      || binding.schemaVersion !== 1 || binding.kind !== 'w4c3b_request_snapshot_terminal_binding'
      || binding.bindingPosture !== 'bound' || binding.action !== 'approve'
      || binding.orgId !== subject.orgId || binding.requestId !== fact.requestId
      || binding.subjectUserId !== subject.userId || binding.requestType !== request.request_type
      || binding.requestSnapshotVersion !== fact.requestSnapshotVersion
      || binding.requestSnapshotFingerprint !== fact.requestSnapshotFingerprint
      || binding.approvalVersion !== fact.approvalVersion || binding.approvalRecordId !== fact.approvalRecordId) {
      correctionTargetFail('ATTENDANCE_CORRECTION_APPROVAL_MISMATCH', 409)
    }
    const approvals = await trx.query(
      `SELECT a.id FROM approval_instances a JOIN approval_records ar ON ar.instance_id = a.id
        WHERE a.id = $1 AND a.status = 'approved' AND a.version = $2
          AND ar.id = $3::bigint AND ar.action = 'approve' AND ar.to_status = 'approved' AND ar.to_version = $2`,
      [request.approval_instance_id, fact.approvalVersion, fact.approvalRecordId])
    if (approvals.rows.length !== 1) correctionTargetFail('ATTENDANCE_CORRECTION_APPROVAL_MISMATCH', 409)
    const originalRef = payload.correctionTargets.source
    const originals = await trx.query(
      `SELECT c.*, c.id::text AS id FROM attendance_record_calculations c
        WHERE c.id = $1::uuid AND c.org_id = $2 AND c.attendance_record_id = $3::uuid
          AND c.version = $4 AND c.semantic_input_fingerprint = $5 AND c.mode = $6
          AND c.calculation_kind = 'calculation' AND NOT (c.input_provenance ? $7)`,
      [originalRef.calculationId, subject.orgId, source.record.id, originalRef.calculationVersion,
        originalRef.semanticInputFingerprint, mode, ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1])
    if (originalRef.recordId !== source.record.id || originals.rows.length !== 1) {
      correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
    }
    const original = await verifyFrozenCorrectionSourceV1(trx, subject, source.record, originals.rows[0])
    if (canonicalAttendanceJsonV1(original.input.approvedFacts) !== canonicalAttendanceJsonV1(facts)
      || canonicalAttendanceJsonV1(original.input.context) !== canonicalAttendanceJsonV1(snapshot.context_snapshot)
      || canonicalAttendanceJsonV1(original.input.attribution) !== canonicalAttendanceJsonV1(snapshot.attribution_snapshot)
      || original.input.evidence.some(item => item.kind === 'punch'
        && !source.input.evidence.some(current => canonicalAttendanceJsonV1(current) === canonicalAttendanceJsonV1(item)))) {
      correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
    }
    const changes = []
    for (const [key, time] of [['checkIn', payload.requestedInAt], ['checkOut', payload.requestedOutAt]] as const) {
      const target = payload.correctionTargets[key]
      if (!target || time === null) continue
      verifyCorrectionTargetV1(target, original.cells, time, original.input.evidence)
      const adjustmentEvidenceRef = `correction:${fact.requestId}:${target.direction}`
      changes.push({ target, occurredAt: time, adjustmentEvidenceRef })
      evidence.push({ kind: 'approved_adjustment', ref: adjustmentEvidenceRef, direction: target.direction, occurredAt: time, source: 'correction' })
    }
    if (canonicalAttendanceJsonV1(fact.changes) !== canonicalAttendanceJsonV1(changes)) {
      correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
    }
    facts.push(fact)
  }
  if (canonicalAttendanceJsonV1(source.input.evidence.filter(item => item.kind === 'approved_adjustment')) !== canonicalAttendanceJsonV1(evidence)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_SOURCE_MISMATCH', 409)
  }
  return { approvedFacts: facts, evidence, source: source.source, sourceDefinitionFingerprint: source.prior.source_definition_fingerprint }
}

/** Read-only writer check; does not issue admission or accept a caller assertion. */
export async function validateRetainedAttendanceCorrectionWriteV1(
  client: AttendanceW4TransactionClientV1, input: WriteAuthoritativeSegmentCalculationInputV1,
  org: VerifiedAttendanceOrgIdentityV1, operation: VerifiedAttendanceOperationIdentityV1,
): Promise<void> {
  if (!input.context || input.orgId !== input.context.orgId || operation.id !== input.operationId
    || (input.entrypoint === 'live' ? operation.entrypoint !== 'live_punch' : input.entrypoint !== 'scheduled' || operation.entrypoint !== 'scheduled')
    || requireCarryOperationV1(input.context, org, operation) !== 'authoritative') {
    correctionTargetFail('ATTENDANCE_CORRECTION_WRITE_ADMISSION_REQUIRED', 422)
  }
  const retained = await readRetainedAttendanceCorrectionsV1(client, input.context, org, operation, false)
  if (!retained.source || retained.source.recordId !== input.recordId
    || retained.source.calculationId !== input.expectedCurrentCalculationId
    || retained.sourceDefinitionFingerprint !== computeAttendanceSourceDefinitionFingerprintV1({ attribution: input.attribution, context: input.context })
    || canonicalAttendanceJsonV1(retained.approvedFacts) !== canonicalAttendanceJsonV1(input.approvedFacts)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_WRITE_ADMISSION_REQUIRED', 422)
  }
  const live = await client.query(
    `SELECT id::text AS id, event_type, occurred_at, source FROM attendance_events
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
        AND event_type IN ('check_in', 'check_out') ORDER BY occurred_at, id`,
    [input.orgId, input.context.userId, input.context.workDate])
  const genuine = live.rows.map(row => ({ kind: 'punch', ref: String(row.id), direction: row.event_type,
    occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
    source: row.source === 'outdoor_approval' ? 'outdoor_approval' : 'attendance_event' }))
  const expectedEvidence = [...genuine, ...retained.evidence]
  const recomputed = calculateAttendanceSegmentsV1({ attribution: input.attribution, context: input.context,
    evidence: expectedEvidence as AttendanceEvidenceV1[], approvedFacts: retained.approvedFacts })
  if (canonicalAttendanceJsonV1(input.evidence) !== canonicalAttendanceJsonV1(expectedEvidence)
    || canonicalAttendanceJsonV1(input.calculation) !== canonicalAttendanceJsonV1(recomputed)) {
    correctionTargetFail('ATTENDANCE_CORRECTION_WRITE_ADMISSION_REQUIRED', 422)
  }
}
