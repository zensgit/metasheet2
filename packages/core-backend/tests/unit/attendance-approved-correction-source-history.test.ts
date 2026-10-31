import { beforeEach, describe, expect, it, vi } from 'vitest'
import { approvedCorrectionFixture } from '../utils/attendance-approved-correction-fixture'
import {
  freezeAttendanceCorrectionTargetsV1,
  loadAttendanceCorrectionSourceV1,
  readAttendanceCorrectionTargetsV1,
} from '../../src/attendance/approved-correction-target-source'
import { computeAttendanceSemanticInputFingerprintV1 } from '../../src/attendance/w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../../src/attendance/w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
  type AttendanceSegmentCalculationInputV1,
} from '../../src/attendance/w4c1-segment-calculator'
import { ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1 } from '../../src/attendance/w7-compare-window-status'

// Mock-backed source-reader regressions only: no approval execution, native SQL,
// transaction/locking proof, provider calls, or environment/flag changes.
const rollout = vi.hoisted(() => ({ writePosture: 'authoritative' as 'authoritative' | 'shadow' }))
vi.mock('../../src/attendance/w4c0-identity', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/attendance/w4c0-identity')>(),
  acquireAttendanceCalculationRolloutLock: vi.fn(async () => undefined),
  resolveSegmentCalculationPosture: vi.fn(async () => ({ writePosture: rollout.writePosture })),
}))

type Row = Record<string, unknown>
const id = (suffix: string) => '53000000-0000-4000-8000-' + suffix.padStart(12, '0')
function historyFixture(imported = false, corrected = false) {
  const f = approvedCorrectionFixture(id('1'))
  f.evidence = f.evidence.map((item, index) => {
    if (item.kind !== 'punch') throw new Error('FIXTURE_NOT_PUNCH')
    if (imported) return { ...item, source: 'import' as const }
    return index === 1 ? { ...item, source: 'outdoor_approval' as const } : item
  })
  const input: AttendanceSegmentCalculationInputV1 = {
    attribution: f.attribution, context: f.context, evidence: [...f.evidence], approvedFacts: [],
  }
  if (corrected) {
    const adjustmentEvidenceRef = 'correction:source-history-request:check_in'
    input.evidence = [...input.evidence, { kind: 'approved_adjustment', ref: adjustmentEvidenceRef,
      direction: 'check_in', occurredAt: f.instant('09:00'), source: 'correction' }]
    input.approvedFacts = [{ kind: 'correction', schemaVersion: 2, requestId: 'source-history-request',
      requestSnapshotVersion: 1, requestSnapshotFingerprint: 'b'.repeat(64), approvalVersion: 2,
      approvalRecordId: '53', changes: [{ target: { kind: 'replacement', segmentIndex: 0,
        direction: 'check_in', evidenceRef: f.evidence[0].ref }, occurredAt: f.instant('09:00'), adjustmentEvidenceRef }] }]
  }
  const record: Row = { id: id('10'), org_id: f.context.orgId, user_id: f.context.userId,
    work_date: f.context.workDate, current_calculation_id: id('11'), projection_owner: 'w4',
    visibility_state: 'active', visibility_reason: 'active' }
  function calculation(calculationId: string, version: number, mode = 'authoritative'): Row {
    const calculationTier = mode === 'shadow' ? 'legacy_shadow' : 'segment_authoritative'
    const result = calculateAttendanceSegmentsV1(input)
    return { id: calculationId, org_id: f.context.orgId, attendance_record_id: record.id, version,
      calculation_kind: 'calculation', mode, input_provenance: {}, outcome: result.outcome,
      expected_segment_count: result.segments.length, attribution_snapshot: input.attribution,
      context_snapshot: input.context, segment_snapshot: f.context.segments,
      evidence_snapshot: input.evidence, approved_facts_snapshot: input.approvedFacts,
      manual_override_snapshot: null, merge_policy: 'append', calculation_tier: calculationTier,
      engine_version: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshot_schema_version: 1,
      semantic_input_fingerprint: computeAttendanceSemanticInputFingerprintV1({ ...input,
        manualOverride: null, mergePolicy: 'append', calculationTier,
        engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1 }),
      source_definition_fingerprint: computeAttendanceSourceDefinitionFingerprintV1({
        attribution: input.attribution, context: input.context }) }
  }
  const calculations = [calculation(id('11'), 1)]
  const events: Row[] = imported ? [] : f.evidence.map(item => {
    if (item.kind !== 'punch') throw new Error('FIXTURE_NOT_PUNCH')
    return { id: item.ref, event_type: item.direction, occurred_at: item.occurredAt,
      source: item.source === 'outdoor_approval' ? 'outdoor_approval' : 'api' }
  })
  // Small relational stub: selection follows the query's actual predicates.
  // Returning C1 unconditionally would conceal A-SOURCE-05 before the repair.
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<Row[]> => {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('SOURCE_READER_MUST_BE_READ_ONLY')
    if (sql.includes('FROM attendance_records r')) return [record]
    if (sql.includes('FROM attendance_record_calculations c')) {
      let rows = calculations.filter(row => row.org_id === params[0] && row.attendance_record_id === params[1])
      if (/c\.calculation_kind\s*=\s*'calculation'/.test(sql)) rows = rows.filter(row => row.calculation_kind === 'calculation')
      if (sql.includes('NOT (c.input_provenance ?')) rows = rows.filter(row =>
        !Object.prototype.hasOwnProperty.call(row.input_provenance, ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1))
      const pointer = sql.match(/c\.id\s*=\s*\$(\d+)/)
      if (pointer) rows = rows.filter(row => row.id === params[Number(pointer[1]) - 1])
      if (/c\.id\s*=\s*r\.current_calculation_id/.test(sql)) rows = rows.filter(row => row.id === record.current_calculation_id)
      const mode = sql.match(/c\.mode\s*=\s*'(authoritative|shadow)'/)
      const boundMode = sql.match(/c\.mode\s*=\s*\$(\d+)/)
      if (mode || boundMode) rows = rows.filter(row => row.mode === (mode?.[1] ?? params[Number(boundMode![1]) - 1]))
      if (/ORDER BY c\.version DESC/.test(sql)) rows = [...rows].sort((a, b) => Number(b.version) - Number(a.version))
      return /LIMIT 1/.test(sql) ? rows.slice(0, 1) : rows
    }
    if (sql.includes('FROM attendance_record_segments')) {
      const row = calculations.find(item => item.id === params[0])
      return Array.from({ length: Number(row?.expected_segment_count ?? 0) }, (_, segment_index) => ({ segment_index }))
    }
    if (sql.includes('FROM attendance_events')) {
      return /event_type\s+IN\s*\(\s*'check_in'\s*,\s*'check_out'\s*\)/i.test(sql)
        ? events.filter(row => row.event_type === 'check_in' || row.event_type === 'check_out') : events
    }
    throw new Error('UNEXPECTED_SOURCE_QUERY')
  })
  const subject = { orgId: f.context.orgId, userId: f.context.userId, workDate: f.context.workDate }
  const source = (row: Row) => ({ recordId: record.id, calculationId: row.id,
    calculationVersion: row.version, semanticInputFingerprint: row.semantic_input_fingerprint })
  return { f, input, record, calculations, events, calculation, client: { query }, subject, source }
}

beforeEach(() => { rollout.writePosture = 'authoritative' })
describe('approved correction source history regressions (mock-backed)', () => {
  it('A-SOURCE-04: completed correction snapshot stays readable after its later generic adjustment audit', async () => {
    const f = historyFixture(false, true)
    expect(calculateAttendanceSegmentsV1(f.input).outcome).toBe('completed')
    const before = await loadAttendanceCorrectionSourceV1(f.client, f.subject)
    f.events.push({ id: id('90'), event_type: 'adjustment', source: 'request', occurred_at: f.f.instant('19:00') })
    expect((await loadAttendanceCorrectionSourceV1(f.client, f.subject)).source).toEqual(before.source)
    const targets = await readAttendanceCorrectionTargetsV1(f.client, f.subject)
    expect({ posture: targets.posture, source: targets.source }).toEqual({ posture: 'canonical', source: before.source })
    expect(targets.candidates.length).toBeGreaterThan(0)
  })

  it.each(['new', 'modified-time', 'modified-direction', 'modified-source', 'deleted'] as const)(
    'retains true punch drift refusal: %s', async drift => {
      const f = historyFixture(false, true)
      expect((await loadAttendanceCorrectionSourceV1(f.client, f.subject)).source).toEqual(f.source(f.calculations[0]))
      if (drift === 'new') f.events.push({ id: id('91'), event_type: 'check_out', source: 'outdoor_approval', occurred_at: f.f.instant('18:00') })
      if (drift === 'modified-time') f.events[0].occurred_at = f.f.instant('09:16')
      if (drift === 'modified-direction') f.events[0].event_type = 'check_out'
      if (drift === 'modified-source') f.events[1].source = 'api'
      if (drift === 'deleted') f.events.splice(0, 1)
      await expect(loadAttendanceCorrectionSourceV1(f.client, f.subject, true))
        .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_TARGET_STALE', httpStatus: 409 })
    },
  )

  it('A-SOURCE-05: import C2 then reversal C3 restoring C1 advertises and freezes active C1', async () => {
    const f = historyFixture(true)
    const c1 = f.calculations[0]
    const c2 = f.calculation(id('12'), 2)
    f.calculations.push(c2, { ...c2, id: id('13'), version: 3, calculation_kind: 'reversal',
      outcome: 'reversed', engine_version: 'w4c3a-import-rollback-v1', restores_calculation_id: c1.id })
    expect(f.events).toEqual([])
    expect((await loadAttendanceCorrectionSourceV1(f.client, f.subject, true)).source).toEqual(f.source(c1))
    const targets = await readAttendanceCorrectionTargetsV1(f.client, f.subject)
    expect({ posture: targets.posture, source: targets.source }).toEqual({ posture: 'canonical', source: f.source(c1) })
    const frozen = await freezeAttendanceCorrectionTargetsV1(f.client,
      { ...f.subject, requestedInAt: null, requestedOutAt: f.f.instant('18:00') },
      { schemaVersion: 1, source: f.source(c1), checkIn: null,
        checkOut: { kind: 'insertion', segmentIndex: 1, direction: 'check_out' } })
    expect(frozen.targets).toEqual({ schemaVersion: 1, source: f.source(c1), checkIn: null,
      checkOut: { kind: 'insertion', segmentIndex: 1, direction: 'check_out' } })
  })

  it('shadow selects newest ordinary shadow history independently of the active pointer and W7 comparison', async () => {
    rollout.writePosture = 'shadow'
    const f = historyFixture(true)
    const shadow = f.calculation(id('12'), 2, 'shadow')
    f.calculations.push(shadow, f.calculation(id('13'), 3),
      { ...shadow, id: id('14'), version: 4, calculation_kind: 'reversal', outcome: 'reversed' },
      { ...shadow, id: id('15'), version: 5,
        input_provenance: { [ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1]: {} } })
    const targets = await readAttendanceCorrectionTargetsV1(f.client, f.subject)
    expect({ posture: targets.posture, source: targets.source }).toEqual({ posture: 'canonical', source: f.source(shadow) })
  })

  it.each(['missing', 'w7-comparison', 'engine', 'schema'] as const)(
    'does not fall back from an unsupported authoritative current pointer: %s', async kind => {
      const f = historyFixture(true)
      const current = f.calculation(id('12'), 2)
      f.record.current_calculation_id = kind === 'missing' ? id('99') : current.id
      if (kind === 'w7-comparison') current.input_provenance = { [ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1]: {} }
      if (kind === 'engine') current.engine_version = 'future-engine'
      if (kind === 'schema') current.snapshot_schema_version = 99
      f.calculations.push(current)
      await expect(readAttendanceCorrectionTargetsV1(f.client, f.subject))
        .rejects.toMatchObject({ code: 'ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED' })
    },
  )

  it.each(['operator_retirement', 'import_rollback'] as const)('retains retired parent refusal: %s', async reason => {
    const f = historyFixture(true)
    f.record.visibility_state = 'retired'
    f.record.visibility_reason = reason
    await expect(loadAttendanceCorrectionSourceV1(f.client, f.subject))
      .rejects.toMatchObject({ code: reason === 'operator_retirement' ? 'ATTENDANCE_RECORD_OPERATOR_RETIRED' : 'ATTENDANCE_RECORD_RETIRED', httpStatus: 409 })
  })
})
