import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvedCorrectionFixture } from '../utils/attendance-approved-correction-fixture'
import { freezeAttendanceCorrectionTargetsV1, loadAttendanceCorrectionSourceV1 } from '../../src/attendance/approved-correction-target-source'
import { calculateAttendanceSegmentsV1, ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from '../../src/attendance/w4c1-segment-calculator'
import { computeAttendanceSemanticInputFingerprintV1 } from '../../src/attendance/w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../../src/attendance/w4c1-fingerprints'

const ORG = '00000000-0000-4000-8000-000000000030'
const USER = '00000000-0000-4000-8000-000000000031'
const FOREIGN = '00000000-0000-4000-8000-000000000032'
afterEach(() => vi.unstubAllEnvs())

// Query stub unit tests: actual closed validators, cell/window logic, calculator,
// and fingerprints run unchanged. These are not native DB/route acceptance evidence.
function sourceFixture(oneSegment = false) {
  vi.stubEnv('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', ORG + ',' + FOREIGN)
  const f = approvedCorrectionFixture(ORG, USER)
  if (oneSegment) {
    f.context.segments = [f.context.segments[0]]
    f.evidence = f.evidence.filter(item => item.direction === 'check_out')
  }
  const input = { attribution: f.attribution, context: f.context, evidence: f.evidence, approvedFacts: [] }
  const calculated = calculateAttendanceSegmentsV1(input)
  const recordId = '00000000-0000-4000-8000-000000000010'
  const calculationId = '00000000-0000-4000-8000-000000000011'
  const prior = {
    id: calculationId, mode: 'authoritative', version: 1, outcome: calculated.outcome, expected_segment_count: calculated.segments.length,
    attribution_snapshot: f.attribution, context_snapshot: f.context, segment_snapshot: f.context.segments,
    evidence_snapshot: f.evidence, approved_facts_snapshot: [], manual_override_snapshot: null,
    merge_policy: 'append', calculation_tier: 'segment_authoritative',
    engine_version: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshot_schema_version: 1,
    semantic_input_fingerprint: computeAttendanceSemanticInputFingerprintV1({
      ...input, manualOverride: null, mergePolicy: 'append', calculationTier: 'segment_authoritative',
      engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
    }),
    source_definition_fingerprint: computeAttendanceSourceDefinitionFingerprintV1({ attribution: f.attribution, context: f.context }),
  }
  const events = f.evidence.map(item => {
    if (item.kind !== 'punch') throw new Error('FIXTURE_INVALID')
    return { id: item.ref, event_type: item.direction, occurred_at: item.occurredAt, source: 'api' }
  })
  const children = calculated.segments.map(item => ({ segment_index: item.segmentIndex }))
  const client = { query: async (sql: string) => {
    if (sql === 'SELECT state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1') {
      return [{ state: 'authoritative', scope: 'synthetic_staging' }]
    }
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }]
    if (sql.includes("set_config('lock_timeout'")) return []
    if (sql.includes('pg_advisory_xact_lock_shared(')) return []
    if (sql.includes('FROM attendance_records r')) return [{
      id: recordId, org_id: f.context.orgId, user_id: f.context.userId, work_date: f.context.workDate,
      current_calculation_id: calculationId, visibility_state: 'active', visibility_reason: 'active',
    }]
    if (sql.includes('FROM attendance_record_calculations c')) return [prior]
    if (sql.includes('FROM attendance_record_segments')) return children
    if (sql.includes('FROM attendance_events')) return events
    throw new Error('UNEXPECTED_SOURCE_QUERY')
  } }
  const subject = { orgId: f.context.orgId, userId: f.context.userId, workDate: f.context.workDate }
  const source = { recordId, calculationId, calculationVersion: 1, semanticInputFingerprint: prior.semantic_input_fingerprint }
  return { f, prior, events, children, client, subject, source }
}
describe('approved correction A verified source', () => {
  it('fills only a genuinely unique empty direction and stores no superseded reference', async () => {
    const f = sourceFixture(true)
    const frozen = await freezeAttendanceCorrectionTargetsV1(f.client,
      { ...f.subject, requestedInAt: f.f.instant('09:00'), requestedOutAt: null },
      { schemaVersion: 1, source: f.source, checkIn: null, checkOut: null })
    expect(frozen).toEqual({
      targets: { schemaVersion: 1, source: f.source,
        checkIn: { kind: 'insertion', segmentIndex: 0, direction: 'check_in' }, checkOut: null },
      attributionSnapshot: f.f.attribution, contextSnapshot: f.f.context,
    })
  })
  it('refuses ambiguous auto-fill and a forged source token', async () => {
    const f = sourceFixture()
    const subject = { ...f.subject, requestedInAt: f.f.instant('09:00'), requestedOutAt: null }
    await expect(freezeAttendanceCorrectionTargetsV1(f.client, subject,
      { schemaVersion: 1, source: f.source, checkIn: null, checkOut: null }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_TARGET_SELECTION_REQUIRED', httpStatus: 422 })
    await expect(freezeAttendanceCorrectionTargetsV1(f.client, subject,
      { schemaVersion: 1, source: { ...f.source, calculationVersion: 2 }, checkIn: null, checkOut: null }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_TARGET_STALE', httpStatus: 409 })
  })
  it.each(['orgId', 'userId', 'workDate'] as const)('refuses source identity mismatch %s', async key => {
    const f = sourceFixture()
    await expect(loadAttendanceCorrectionSourceV1(f.client,
      { ...f.subject, [key]: key === 'workDate' ? '2049-08-22' : FOREIGN }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_SOURCE_MISMATCH', httpStatus: 409 })
  })
  it('detects event-set drift, fingerprint drift, and missing children with no writes', async () => {
    const f = sourceFixture()
    f.events.push({ id: 'new-event', event_type: 'check_out', occurred_at: f.f.instant('18:00'), source: 'api' })
    await expect(loadAttendanceCorrectionSourceV1(f.client, f.subject))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_TARGET_STALE' })
    f.events.pop()
    f.prior.semantic_input_fingerprint = 'b'.repeat(64)
    await expect(loadAttendanceCorrectionSourceV1(f.client, f.subject))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_SOURCE_MISMATCH' })
    f.children.pop()
    await expect(loadAttendanceCorrectionSourceV1(f.client, f.subject))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED' })
  })
})

describe('approved correction A supported source versions', () => {
  it.each([
    { engineVersion: 'future-unsupported-engine', snapshotSchemaVersion: 1 },
    { engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 99 },
  ])('rejects unsupported source engine or snapshot schema %# even when its hash is self-consistent', async version => {
    const f = sourceFixture()
    f.prior.engine_version = version.engineVersion
    f.prior.snapshot_schema_version = version.snapshotSchemaVersion
    f.prior.semantic_input_fingerprint = computeAttendanceSemanticInputFingerprintV1({
      attribution: f.f.attribution, context: f.f.context, evidence: f.f.evidence, approvedFacts: [],
      manualOverride: null, mergePolicy: 'append', calculationTier: 'segment_authoritative',
      engineVersion: version.engineVersion, snapshotSchemaVersion: version.snapshotSchemaVersion,
    })
    await expect(loadAttendanceCorrectionSourceV1(f.client, f.subject))
      .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED' })
  })
})
