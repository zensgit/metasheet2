import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvedCorrectionGroupV2Fixture } from '../utils/attendance-approved-correction-group-v2-fixture'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, calculateAttendanceSegmentsV1,
  routeFrozenAttendanceContextV1, isSupportedFrozenAttendanceContextV1,
} from '../../src/attendance/w4c1-segment-calculator'
import { computeAttendanceSemanticInputFingerprintV1 } from '../../src/attendance/w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../../src/attendance/w4c1-fingerprints'
import {
  loadAttendanceCorrectionSourceV1, freezeAttendanceCorrectionTargetsV1,
} from '../../src/attendance/approved-correction-target-source'

// Storage rows are stubbed; all support routing, identity, hash, evidence and
// capture-cell guards are real. This unit test grants no native/DB credit.
describe('approved correction A group_effective frozenV2 source control', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('loads and freezes both exact directions from a supported group V2 source without rebuilding it', async () => {
    const orgId = '00000000-0000-4000-8000-000000000030'
    vi.stubEnv('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', orgId)
    const f = approvedCorrectionGroupV2Fixture(orgId, '00000000-0000-4000-8000-000000000031')
    expect(routeFrozenAttendanceContextV1(f.context)).toEqual({ kind: 'v2', context: f.context })
    expect(isSupportedFrozenAttendanceContextV1(f.context)).toBe(true)
    // The calculation API retains its historical v1 TS annotation; the public
    // support router above validates the actual unchanged group V2 bytes.
    const input = { attribution: f.attribution,
      context: f.context as unknown as Parameters<typeof calculateAttendanceSegmentsV1>[0]['context'],
      evidence: f.evidence, approvedFacts: [] }
    const calculation = calculateAttendanceSegmentsV1(input)
    expect(calculation.outcome).toBe('completed')
    const recordId = '00000000-0000-4000-8000-000000000010'
    const calculationId = '00000000-0000-4000-8000-000000000011'
    const semanticInputFingerprint = computeAttendanceSemanticInputFingerprintV1({
      ...input, manualOverride: null, mergePolicy: 'append', calculationTier: 'segment_authoritative',
      engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
    })
    const prior = { id: calculationId, mode: 'authoritative', version: 1, outcome: calculation.outcome,
      expected_segment_count: calculation.segments.length, engine_version: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      snapshot_schema_version: 1, attribution_snapshot: f.attribution, context_snapshot: f.context,
      segment_snapshot: f.context.segments, evidence_snapshot: f.evidence, approved_facts_snapshot: [],
      manual_override_snapshot: null, merge_policy: 'append', calculation_tier: 'segment_authoritative',
      semantic_input_fingerprint: semanticInputFingerprint,
      source_definition_fingerprint: computeAttendanceSourceDefinitionFingerprintV1({
        attribution: f.attribution, context: f.context,
      }) }
    const events = f.evidence.map(item => {
      if (item.kind !== 'punch') throw new Error('GROUP_V2_FIXTURE_INVALID')
      return { id: item.ref, event_type: item.direction, occurred_at: item.occurredAt, source: 'api' }
    })
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const client = { query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql === 'SELECT state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1') {
        expect(params).toEqual([orgId])
        return [{ state: 'authoritative', scope: 'synthetic_staging' }]
      }
      if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }]
      if (sql.includes("set_config('lock_timeout'")) return []
      if (sql.includes('pg_advisory_xact_lock_shared(')) return []
      if (sql.includes('FROM attendance_records r')) {
        expect(params).toEqual([f.context.orgId, f.context.userId, f.context.workDate])
        return [{ id: recordId, org_id: f.context.orgId, user_id: f.context.userId, work_date: f.context.workDate,
          current_calculation_id: calculationId, projection_owner: 'w4_group', visibility_state: 'active', visibility_reason: 'active' }]
      }
      if (sql.includes('FROM attendance_record_calculations c')) return [prior]
      if (sql.includes('FROM attendance_record_segments')) return calculation.segments.map(row => ({ segment_index: row.segmentIndex }))
      if (sql.includes('FROM attendance_events')) return events
      throw new Error('GROUP_V2_SOURCE_QUERY_UNEXPECTED')
    } }
    const subject = { orgId: f.context.orgId, userId: f.context.userId, workDate: f.context.workDate }
    const loaded = await loadAttendanceCorrectionSourceV1(client, subject)
    const source = { recordId, calculationId, calculationVersion: 1, semanticInputFingerprint }
    const checkIn = { kind: 'replacement' as const, segmentIndex: 0, direction: 'check_in' as const,
      evidenceRef: f.evidence[0].ref }
    const checkOut = { kind: 'insertion' as const, segmentIndex: 1, direction: 'check_out' as const }
    expect(loaded.source).toEqual(source)
    expect(loaded.candidates).toEqual([
      checkIn,
      { kind: 'replacement', segmentIndex: 1, direction: 'check_in', evidenceRef: f.evidence[2].ref },
      { kind: 'replacement', segmentIndex: 0, direction: 'check_out', evidenceRef: f.evidence[1].ref },
      checkOut,
    ])
    expect(loaded.input.context).toEqual(f.context)
    const frozen = await freezeAttendanceCorrectionTargetsV1(client,
      { ...subject, requestedInAt: f.instant('09:00'), requestedOutAt: f.instant('18:00') },
      { schemaVersion: 1, source, checkIn, checkOut })
    expect(frozen).toEqual({
      targets: { schemaVersion: 1, source, checkIn, checkOut },
      attributionSnapshot: f.attribution, contextSnapshot: f.context,
    })
    expect(Object.keys(frozen.targets.checkOut!)).toEqual(['kind', 'segmentIndex', 'direction'])
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every(({ sql }) => /^\s*SELECT\b/.test(sql))).toBe(true)
  })
})
