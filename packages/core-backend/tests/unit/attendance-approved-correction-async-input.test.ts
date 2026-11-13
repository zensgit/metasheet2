import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendApprovedCorrectionCalculationV1,
  requireApprovedCorrectionWriteAdmissionV1,
} from '../../src/attendance/approved-correction-apply'
import { loadAttendanceCorrectionSourceV1 } from '../../src/attendance/approved-correction-target-source'
import { requireAttendanceCorrectionDecisionExecutionV1, requireAttendanceCorrectionSourcePostureV1 } from '../../src/attendance/w4c3b-request-operation-boundary'
import { writeAuthoritativeSegmentCalculationV1, type WriteAuthoritativeSegmentCalculationInputV1 } from '../../src/attendance/w4c2-authoritative-calculation-core'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
  inspectAttendanceCorrectionCellsV1,
} from '../../src/attendance/w4c1-segment-calculator'
import { computeAttendanceSemanticInputFingerprintV1 } from '../../src/attendance/w4c0-fingerprints'
import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY,
} from '../../src/attendance/w4c3b-request-snapshots'
import type { ApprovedAttendanceFactV1 } from '../../src/attendance/w4c0-write-boundary-types'
import { approvedCorrectionFixture } from '../utils/attendance-approved-correction-fixture'

// Unit seams only: this does not mint a native operation or prove permissions.
// Keep the real client adapter, payload/target validators, hashes, calculator,
// private computed-write proof and authoritative SQL writer.
vi.mock('../../src/attendance/approved-correction-target-source', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/attendance/approved-correction-target-source')>(),
  loadAttendanceCorrectionSourceV1: vi.fn(),
}))
vi.mock('../../src/attendance/w4c3b-request-operation-boundary', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/attendance/w4c3b-request-operation-boundary')>(),
  requireAttendanceCorrectionDecisionExecutionV1: vi.fn(),
  requireAttendanceCorrectionSourcePostureV1: vi.fn(),
}))

type Rows = { rows: Record<string, unknown>[] }
type Query = { sql: string; params: unknown[] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const f = approvedCorrectionFixture('async-input-org', 'async-input-user')
  f.evidence.push({ kind: 'punch', ref: '00000000-0000-4000-8000-000000000004',
    direction: 'check_out', occurredAt: f.instant('18:00'), source: 'attendance_event' })
  const input = { context: f.context, attribution: f.attribution, evidence: f.evidence,
    approvedFacts: [] as ApprovedAttendanceFactV1[] }
  const baseline = calculateAttendanceSegmentsV1(input)
  if (baseline.outcome !== 'completed' || !baseline.dailyProjection) throw new Error('INVALID_ASYNC_FIXTURE')
  const recordId = '00000000-0000-4000-8000-000000000010'
  const calculationId = '00000000-0000-4000-8000-000000000011'
  const identity = { orgId: f.context.orgId, userId: f.context.userId,
    requestId: '00000000-0000-4000-8000-000000000012',
    operationId: '00000000-0000-4000-8000-000000000013',
    actorId: 'admitted-actor', correlationId: 'admitted-correlation',
    mode: 'authoritative' as 'authoritative' | 'shadow' }
  const source = { recordId, calculationId, calculationVersion: 1,
    semanticInputFingerprint: semanticFingerprint(input) }
  const checkIn = { kind: 'replacement' as const, segmentIndex: 0, direction: 'check_in' as const,
    evidenceRef: f.evidence[0].ref }
  const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
    workDate: f.context.workDate, requestedInAt: f.instant('09:00'), requestedOutAt: null,
    correctionTargets: { schemaVersion: 1, source, checkIn, checkOut: null },
  })
  const fingerprint = computeAttendanceRequestPayloadFingerprintV1(payload)
  const fact = {
    kind: 'correction', schemaVersion: 2, requestId: identity.requestId,
    requestSnapshotVersion: 1, requestSnapshotFingerprint: fingerprint,
    approvalVersion: 2, approvalRecordId: '53',
    changes: [{ target: checkIn, occurredAt: f.instant('09:00'),
      adjustmentEvidenceRef: `correction:${identity.requestId}:check_in` }],
  } satisfies ApprovedAttendanceFactV1
  const projection = baseline.dailyProjection
  const record = { id: recordId, org_id: identity.orgId, user_id: identity.userId,
    work_date: f.context.workDate, current_calculation_id: calculationId,
    projection_owner: 'w4', visibility_state: 'active', visibility_reason: 'active',
    timezone: 'UTC', status: projection.status, first_in_at: projection.firstInAt,
    last_out_at: projection.lastOutAt, work_minutes: projection.workedMinutes,
    late_minutes: projection.lateMinutes, early_leave_minutes: projection.earlyLeaveMinutes }
  const binding = {
    schemaVersion: 1, kind: 'w4c3b_request_snapshot_terminal_binding', bindingPosture: 'bound',
    action: 'approve', orgId: identity.orgId, requestId: identity.requestId,
    subjectUserId: identity.userId, requestType: 'time_correction',
    requestSnapshotVersion: 1, requestSnapshotFingerprint: fingerprint,
    approvalVersion: 2, approvalRecordId: '53',
  }
  const request = { id: identity.requestId, org_id: identity.orgId, user_id: identity.userId,
    status: 'approved', request_type: 'time_correction', work_date: f.context.workDate,
    requested_in_at: payload.requestedInAt, requested_out_at: payload.requestedOutAt, reason: payload.reason,
    approval_instance_id: 'async-approval',
    metadata: { correctionTargets: payload.schemaVersion === 2 ? payload.correctionTargets : null,
      [W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY]: binding } }
  const snapshot = { version: 1, request_type: 'time_correction', subject_user_id: identity.userId,
    payload, payload_fingerprint: fingerprint, context_snapshot: f.context, attribution_snapshot: f.attribution }
  const cells = inspectAttendanceCorrectionCellsV1(input)
  if (!cells) throw new Error('INVALID_ASYNC_CELLS')
  return { f, input, baseline, identity, source, fact, record, request, snapshot, cells, fingerprint }
}

function semanticFingerprint(input: Parameters<typeof calculateAttendanceSegmentsV1>[0]) {
  return computeAttendanceSemanticInputFingerprintV1({
    ...input, manualOverride: null, mergePolicy: 'append', calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
  })
}

function database(f: ReturnType<typeof fixture>, hold: 'replay' | 'request') {
  const pending = deferred<Rows>()
  const queries: Query[] = []
  const calculations: unknown[][] = []
  const segments: unknown[][] = []
  const updates: unknown[][] = []
  const client = { query: async (sql: string, params: unknown[] = []): Promise<Rows> => {
    queries.push({ sql, params: structuredClone(params) })
    if (sql.includes('FROM attendance_requests r')) {
      if (hold === 'request') return pending.promise
      throw new Error('UNEXPECTED_REQUEST_QUERY')
    }
    if (sql.includes('FROM attendance_request_calculation_snapshots')) return { rows: [f.snapshot] }
    if (sql.includes('FROM approval_instances a JOIN approval_records')) return { rows: [{ id: f.request.approval_instance_id }] }
    if (sql.includes('SELECT id::text AS id, attendance_record_id::text AS record_id')) {
      return hold === 'replay' ? pending.promise : { rows: [] }
    }
    if (sql.includes('SELECT current_calculation_id::text')) return { rows: [f.record] }
    if (sql.includes('SELECT COALESCE(MAX(version)')) return { rows: [{ next: 2 }] }
    if (sql.includes('SELECT version FROM attendance_record_calculations')) return { rows: [{ version: 1 }] }
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) return { rows: [] }
    if (sql.includes('INSERT INTO attendance_record_calculations')) {
      calculations.push(structuredClone(params))
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO attendance_record_segments')) {
      segments.push(structuredClone(params))
      return { rows: [] }
    }
    if (sql.includes('UPDATE attendance_records')) {
      updates.push(structuredClone(params))
      return { rows: [{ id: f.source.recordId }] }
    }
    if (sql.includes('SELECT * FROM attendance_records WHERE id')) return { rows: [f.record] }
    throw new Error('UNEXPECTED_ASYNC_INPUT_QUERY')
  } }
  return { client, pending, queries, calculations, segments, updates }
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  Object.values(value).forEach(assertDeepFrozen)
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('approved correction async input capture (unit seams, no native authority credit)', () => {
  it('A-SOURCE-03 captures a deeply immutable ordinary input before replay await and excludes later forged v2 facts', async () => {
    const f = fixture()
    const db = database(f, 'replay')
    const input: WriteAuthoritativeSegmentCalculationInputV1 = structuredClone({
      orgId: f.identity.orgId, recordId: f.source.recordId, entrypoint: 'live',
      operationId: f.identity.operationId, calculation: f.baseline,
      ...f.input,
      provenanceRef: { transport: 'live_event', sourceRef: 'async-live-punch',
        artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null },
      inputProvenance: { payloadFingerprint: f.fingerprint, capture: { label: 'original' } },
      payloadFingerprint: f.fingerprint,
      preimage: { posture: 'present', projectionOwner: 'w4',
        currentCalculationId: f.source.calculationId, visibilityState: 'active', visibilityReason: 'active',
        projection: { status: f.record.status, firstInAt: f.record.first_in_at, lastOutAt: f.record.last_out_at,
          workMinutes: f.record.work_minutes, lateMinutes: f.record.late_minutes,
          earlyLeaveMinutes: f.record.early_leave_minutes }, compatibilityFingerprint: null },
      expectedCurrentCalculationId: f.source.calculationId,
      actorId: f.identity.actorId, correlationId: f.identity.correlationId,
    })
    const original = structuredClone(input)
    const captured = requireApprovedCorrectionWriteAdmissionV1(db.client, input)
    expect(captured).toEqual(original)
    expect(captured).not.toBe(input)
    expect(captured.context).not.toBe(input.context)
    assertDeepFrozen(captured)
    expect(Reflect.set(captured.context!.segments[0], 'lateGraceMinutes', 7)).toBe(false)
    expect(() => (captured.approvedFacts as ApprovedAttendanceFactV1[]).push(f.fact)).toThrow(TypeError)

    const writing = writeAuthoritativeSegmentCalculationV1(db.client, input)
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0].sql).toContain('operation_id = $3::uuid')
    expect(db.calculations).toEqual([])
    // Mutate only after the real public writer is suspended in its first SELECT.
    const callerFacts = input.approvedFacts as ApprovedAttendanceFactV1[]
    const callerEvidence = input.evidence as typeof f.f.evidence
    const callerProvenance = input.inputProvenance.capture as { label: string }
    callerFacts.push(f.fact)
    input.context!.segments[0].lateGraceMinutes = 7
    callerEvidence[0] = { kind: 'punch', ref: f.f.evidence[0].ref, direction: 'check_in',
      occurredAt: f.f.instant('09:30'), source: 'attendance_event' }
    callerProvenance.label = 'caller-mutated'
    expect(input.approvedFacts).toEqual([f.fact])
    expect(captured).toEqual(original)
    db.pending.resolve({ rows: [] })

    const result = await writing
    expect(db.calculations).toHaveLength(1)
    const row = db.calculations[0]
    expect(result).toEqual({ kind: 'completed', calculationId: row[0], version: 2,
      supersedesCalculationId: f.source.calculationId, baselineCalculationId: null })
    // Parameter positions in the real insertResolvedAuthoritativeCalculationRowV1 SQL.
    expect(JSON.parse(row[18] as string)).toEqual([])
    expect(JSON.parse(row[15] as string)).toEqual(original.context)
    expect(JSON.parse(row[17] as string)).toEqual(original.evidence)
    expect(JSON.parse(row[20] as string)).toEqual(original.inputProvenance)
    expect(row[11]).toBe(semanticFingerprint(f.input))
    expect(db.segments.map(params => params.slice(3))).toEqual(original.calculation.segments.map(segment => [
      segment.segmentIndex, segment.expectedStartAt, segment.expectedEndAt, segment.actualInAt, segment.actualOutAt,
      segment.workedMinutes, segment.lateMinutes, segment.earlyLeaveMinutes, segment.status,
      JSON.stringify(segment.reasons), JSON.stringify(segment.matchedEvidenceRefs), JSON.stringify(segment.unmatchedEvidenceRefs),
    ]))
    expect(db.updates).toHaveLength(1)
  })

  it('A-SOURCE-06 persists the original admitted actor operation and mode after the first request SELECT awaits', async () => {
    const f = fixture()
    const db = database(f, 'request')
    const identity = { ...f.identity }
    const admitted = { ...identity }
    const operation = Object.freeze({ unitOnly: 'mocked-execute-admission' })
    // Explicitly mocked current-context verification: no native boundary or permission credit.
    vi.mocked(requireAttendanceCorrectionDecisionExecutionV1).mockImplementation((client, token, candidate) => {
      expect(client).toBe(db.client)
      expect(token).toBe(operation)
      expect(candidate).toEqual(admitted)
    })
    vi.mocked(requireAttendanceCorrectionSourcePostureV1).mockReturnValue('authoritative')
    vi.mocked(loadAttendanceCorrectionSourceV1).mockResolvedValue({
      record: f.record, prior: {}, input: f.input, cells: f.cells, source: f.source, candidates: [],
    })
    const shadowWriter = vi.fn(async () => { throw new Error('MUTATED_MODE_SELECTED_SHADOW') })
    const writing = appendApprovedCorrectionCalculationV1(db.client, identity, shadowWriter, operation)
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0].sql).toContain('FROM attendance_requests r')
    expect(db.queries[0].params).toEqual([admitted.requestId, admitted.orgId, admitted.userId])
    expect(db.calculations).toEqual([])

    identity.actorId = 'substituted-actor'
    identity.operationId = '00000000-0000-4000-8000-000000000099'
    identity.correlationId = 'substituted-correlation'
    identity.mode = 'shadow'
    db.pending.resolve({ rows: [f.request] })
    const result = await writing

    expect(shadowWriter).not.toHaveBeenCalled()
    expect(requireAttendanceCorrectionDecisionExecutionV1).toHaveBeenCalledTimes(1)
    const checkedIdentity = vi.mocked(requireAttendanceCorrectionDecisionExecutionV1).mock.calls[0][2]
    expect(checkedIdentity).toEqual(admitted)
    expect(checkedIdentity).not.toBe(identity)
    expect(Object.isFrozen(checkedIdentity)).toBe(true)
    expect(loadAttendanceCorrectionSourceV1).toHaveBeenCalledWith(db.client,
      { orgId: admitted.orgId, userId: admitted.userId, workDate: f.f.context.workDate }, true, operation)
    expect(db.calculations).toHaveLength(1)
    const row = db.calculations[0]
    expect({ entrypoint: row[5], operationId: row[10], actorId: row[35], correlationId: row[36] })
      .toEqual({ entrypoint: 'correction', operationId: admitted.operationId,
        actorId: admitted.actorId, correlationId: admitted.correlationId })
    expect(db.queries.find(query => query.sql.includes('INSERT INTO attendance_record_calculations'))!.sql)
      .toContain("'authoritative'")
    expect(JSON.parse(row[18] as string)).toEqual([f.fact])
    const evidence = [...f.input.evidence, { kind: 'approved_adjustment' as const,
      ref: f.fact.changes[0].adjustmentEvidenceRef, direction: 'check_in' as const,
      occurredAt: f.f.instant('09:00'), source: 'correction' as const }]
    const calculation = calculateAttendanceSegmentsV1({ ...f.input, evidence, approvedFacts: [f.fact] })
    expect(calculation.outcome).toBe('completed')
    expect(row[11]).toBe(semanticFingerprint({ ...f.input, evidence, approvedFacts: [f.fact] }))
    expect(JSON.parse(row[17] as string)).toEqual(evidence)
    expect(db.segments.map(params => params[8])).toEqual(calculation.segments.map(segment => segment.workedMinutes))
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].slice(3, 9)).toEqual([
      calculation.dailyProjection!.status, calculation.dailyProjection!.firstInAt, calculation.dailyProjection!.lastOutAt,
      calculation.dailyProjection!.workedMinutes, calculation.dailyProjection!.lateMinutes, calculation.dailyProjection!.earlyLeaveMinutes,
    ])
    expect(result).toEqual({ calculationId: row[0], record: f.record })
  })
})
