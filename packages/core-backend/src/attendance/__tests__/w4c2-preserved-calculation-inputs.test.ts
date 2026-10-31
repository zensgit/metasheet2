/**
 * Synthetic reader-only unit regressions; no PG, native boundary or capability proof.
 * Proposed destination: attendance/__tests__/w4c2-preserved-calculation-inputs.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  computeAttendanceCommandFingerprintV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from '../w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../w4c1-fingerprints'
import { ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from '../w4c1-segment-calculator'
import {
  AttendanceApprovedOvertimeInputError,
  type AttendanceApprovedInputReadScopeV1,
  type Row,
} from '../w4c3b-approved-overtime-inputs'
import {
  readPreservedAuthoritativeCalculationInputsV1,
  type PreservedCalculationTargetV1,
  type PreservedInputs,
} from '../w4c2-preserved-calculation-inputs'
import type {
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
} from '../w4c0-write-boundary-types'

const ORG = '10000000-0000-4000-8000-000000000001'
const FOREIGN_ORG = '10000000-0000-4000-8000-000000000002'
const USER = 'synthetic-preserved-input-user'
const DATE = '2026-10-27'
const OTHER_DATE = '2026-10-28'
const PARENT = '20000000-0000-4000-8000-000000000001'
const C1 = '30000000-0000-4000-8000-000000000001'
const C2 = '30000000-0000-4000-8000-000000000002'
const INCOMPLETE = 'ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE'
const FINGERPRINT_MISMATCH = 'ATTENDANCE_OVERTIME_PRIOR_FINGERPRINT_MISMATCH'

type Material = {
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
}
type ReviewVariant = 'unsupported' | 'null_context' | 'unsupported_and_null'
type CalculationRow = Row & {
  id: string
  semantic_input_fingerprint: string
  provenance_fingerprint: string
}
type ReadStep = { table: string; params: unknown[]; rows: Row[] }

function resolved(orgId = ORG, workDate = DATE): Material & { context: FrozenAttendanceContextV1 } {
  const context: FrozenAttendanceContextV1 = {
    schemaVersion: 1, selector: 'legacy', orgId, userId: USER, workDate, timezone: 'UTC',
    shiftId: 'synthetic-preserved-input-shift', isWorkday: true, holidayKind: null,
    calculationGroupId: null, roundingMinutes: 1,
    severeLateThresholdMinutes: 45, absenceLateThresholdMinutes: 90,
    segments: [{
      index: 0, startTime: '09:00', endTime: '17:00', startDayOffset: 0, endDayOffset: 0,
      lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
    }],
  }
  const window = { startAt: workDate + 'T00:00:00.000Z', endAt: workDate + 'T23:59:59.999Z' }
  return {
    context,
    attribution: {
      posture: 'resolved_v2',
      value: {
        schemaVersion: 2, resolverVersion: 'synthetic-resolver@1', orgId, userId: USER,
        workDate, shiftId: context.shiftId, reasonCode: 'synthetic_assignment_match',
        resolvedAt: workDate + 'T00:00:00.000Z', absoluteWindow: window,
        attributionWindow: window, attributionTailMinutes: 0, extendedByApprovedOvertime: false,
        // Opaque synthetic field, computed rather than a literal fabricated hash.
        // This does not assert that a W2 resolver or provider was executed.
        windowEvidenceFingerprint: computeAttendanceCommandFingerprintV1({ syntheticWindow: window }),
        source: 'live_resolution',
      },
    },
  }
}

function reviewMaterial(variant: ReviewVariant): Material {
  const material: Material = resolved()
  return {
    attribution: variant === 'null_context' ? material.attribution : {
      posture: 'unsupported', sourceSchemaVersion: null, reason: 'missing', sourceFingerprint: null,
    },
    context: variant === 'unsupported' ? material.context : null,
  }
}

function punch(direction: 'check_in' | 'check_out'): AttendanceEvidenceV1 {
  return {
    kind: 'punch',
    ref: direction === 'check_in'
      ? '40000000-0000-4000-8000-000000000001'
      : '40000000-0000-4000-8000-000000000002',
    direction,
    occurredAt: DATE + (direction === 'check_in' ? 'T09:00:00.000Z' : 'T17:00:00.000Z'),
    source: 'attendance_event',
  }
}

function calculation(version: 1 | 2, material: Material, evidence: AttendanceEvidenceV1[]): CalculationRow {
  const provenance = {
    transport: 'live_event', sourceRef: version === 1 ? C1 : C2,
    artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null,
  }
  const input = {
    ...material, evidence, approvedFacts: [], manualOverride: null, mergePolicy: 'append',
    calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
  }
  return {
    id: version === 1 ? C1 : C2, version, calculation_kind: 'calculation',
    outcome: version === 1 ? 'completed' : 'review_required',
    projection_effect: version === 1 ? 'set_active' : 'none',
    expected_segment_count: version === 1 ? material.context?.segments.length : 0,
    segment_snapshot: version === 1 ? material.context?.segments : [],
    attribution_snapshot: material.attribution, context_snapshot: material.context,
    evidence_snapshot: evidence, approved_facts_snapshot: [], manual_override_snapshot: null,
    input_provenance: { provenance },
    semantic_input_fingerprint: computeAttendanceSemanticInputFingerprintV1(input),
    provenance_fingerprint: computeAttendanceProvenanceFingerprintV1(provenance),
    source_definition_fingerprint: computeAttendanceSourceDefinitionFingerprintV1(material),
    merge_policy: input.mergePolicy, calculation_tier: input.calculationTier,
    engine_version: input.engineVersion, snapshot_schema_version: input.snapshotSchemaVersion,
  }
}

function readerFixture(material?: Material, reviewChildren: Row[] = []) {
  const currentEvidence = [punch('check_in'), punch('check_out')]
  const evidence: AttendanceEvidenceV1[] = material ? [
    ...currentEvidence,
    {
      kind: 'punch', ref: '40000000-0000-4000-8000-000000000003', direction: 'check_out',
      occurredAt: DATE + 'T18:00:00.000Z', source: 'attendance_event',
    },
  ] : currentEvidence
  const rows = [calculation(1, resolved(), currentEvidence)]
  if (material) rows.push(calculation(2, material, evidence))
  const parent = { id: PARENT, current_calculation_id: C1, timezone: 'UTC' }
  const steps: ReadStep[] = [
    { table: 'attendance_record_calculations', params: [ORG, PARENT, C1], rows },
    { table: 'attendance_record_segments', params: [ORG, PARENT, C1], rows: [{ segment_index: 0 }] },
    ...(material ? [{
      table: 'attendance_record_segments', params: [ORG, PARENT, C2], rows: reviewChildren,
    }] : []),
    { table: 'attendance_requests', params: [ORG, USER, DATE, null], rows: [] },
    {
      table: 'attendance_events', params: [ORG, USER, DATE, evidence.map((item) => item.ref)],
      rows: evidence.map((item) => {
        if (item.kind !== 'punch') throw new Error('Synthetic fixture must use physical punches')
        return {
          id: item.ref, event_type: item.direction, occurred_at: item.occurredAt,
          source: item.source, work_date: DATE,
        }
      }),
    },
  ]
  let next = 0
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    expect(sql.trimStart()).toMatch(/^SELECT\b/)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CALL|BEGIN|COMMIT|ROLLBACK)\b/i)
    const step = steps[next++]
    if (!step) throw new Error('Unexpected reader query')
    expect(sql).toContain('FROM ' + step.table)
    expect(params).toEqual(step.params)
    return { rows: step.rows }
  })
  const scope: AttendanceApprovedInputReadScopeV1 = {
    trx: { query }, subjectUserId: USER,
    // Deliberate unit-only stand-in for an opaque org type. No admission,
    // transaction lock, witness minting or operation capability is exercised.
    org: { orgId: ORG, acceptedWritePosture: 'authoritative' } as AttendanceApprovedInputReadScopeV1['org'],
  }
  const read = (target: PreservedCalculationTargetV1 = {
    payload: { workDate: DATE }, ...resolved(),
  }) => readPreservedAuthoritativeCalculationInputsV1(scope, parent, target, null, null, true)
  return { rows, parent, query, read, evidence, scope }
}

function expected(rows: CalculationRow[], evidence: AttendanceEvidenceV1[], reviewReason: PreservedInputs['reviewReason']) {
  return {
    evidence, approvedFacts: [], manualOverride: null,
    priorCalculations: rows.map((row) => ({
      id: row.id, semanticFingerprint: row.semantic_input_fingerprint,
      provenanceFingerprint: row.provenance_fingerprint,
    })),
    reviewReason,
  }
}

async function expectRefusal(result: Promise<PreservedInputs>, code: string) {
  const error: unknown = await result.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AttendanceApprovedOvertimeInputError)
  if (!(error instanceof AttendanceApprovedOvertimeInputError)) throw new Error('Expected typed reader refusal')
  expect({ name: error.name, message: error.message, code: error.code, httpStatus: error.httpStatus }).toEqual({
    name: 'AttendanceApprovedOvertimeInputError', message: code, code, httpStatus: 409,
  })
}

describe('preserved calculation inputs (synthetic SELECT-only unit scope)', () => {
  it('retains a valid completed current C1 without review (positive control)', async () => {
    const f = readerFixture()
    const before = JSON.stringify({ rows: f.rows, parent: f.parent })
    expect(await f.read()).toEqual(expected(f.rows, f.evidence, null))
    expect(f.query).toHaveBeenCalledTimes(4)
    expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
  })

  it.each(['unsupported', 'null_context', 'unsupported_and_null'] as const)(
    'retains C1 and zero-child C2 %s for a still-unsupported live target',
    async (variant) => {
      const f = readerFixture(reviewMaterial(variant))
      const before = JSON.stringify({ rows: f.rows, parent: f.parent })
      expect(f.rows[1].source_definition_fingerprint).toBeNull()
      const result = await f.read({ payload: { workDate: DATE }, ...reviewMaterial('unsupported_and_null') })
      expect(result).toEqual(expected(f.rows, f.evidence, 'missing_frozen_context'))
      expect(result.priorCalculations).toHaveLength(2)
      expect(result.evidence).toHaveLength(3)
      expect(f.query).toHaveBeenCalledTimes(5)
      expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
    },
  )

  const foreignCases = [
    { variant: 'resolved', side: 'attribution', field: 'orgId' },
    { variant: 'resolved', side: 'attribution', field: 'workDate' },
    { variant: 'resolved', side: 'context', field: 'orgId' },
    { variant: 'resolved', side: 'context', field: 'workDate' },
    { variant: 'unsupported', side: 'context', field: 'orgId' },
    { variant: 'unsupported', side: 'context', field: 'workDate' },
    { variant: 'null_context', side: 'attribution', field: 'orgId' },
    { variant: 'null_context', side: 'attribution', field: 'workDate' },
  ] as const

  it.each(foreignCases)('refuses foreign C2 $variant $side.$field despite valid fingerprints', async ({ variant, side, field }) => {
    const material = variant === 'resolved' ? resolved() : reviewMaterial(variant)
    const foreign = field === 'orgId' ? FOREIGN_ORG : OTHER_DATE
    if (side === 'attribution') {
      if (material.attribution.posture !== 'resolved_v2') throw new Error('Expected resolved fixture attribution')
      material.attribution = { posture: 'resolved_v2', value: { ...material.attribution.value, [field]: foreign } }
    } else {
      if (material.context === null) throw new Error('Expected non-null fixture context')
      material.context = { ...material.context, [field]: foreign }
    }
    const f = readerFixture(material)
    const before = JSON.stringify({ rows: f.rows, parent: f.parent })
    await expectRefusal(f.read(), INCOMPLETE)
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
  })

  it.each(['current', 'unsupported_review'] as const)('refuses corrupted %s semantic hash with the fingerprint code', async (kind) => {
    const material = kind === 'current' ? resolved() : reviewMaterial('unsupported_and_null')
    const f = kind === 'current' ? readerFixture() : readerFixture(material)
    const version = kind === 'current' ? 1 : 2
    // A different genuine public-function hash, not a fabricated digest or mocked fingerprint.
    f.rows[version - 1].semantic_input_fingerprint = calculation(version, material, []).semantic_input_fingerprint
    const before = JSON.stringify({ rows: f.rows, parent: f.parent })
    await expectRefusal(f.read(), FINGERPRINT_MISMATCH)
    expect(f.query).toHaveBeenCalledTimes(kind === 'current' ? 1 : 2)
    expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
  })

  it.each(['resolved', 'unsupported_and_null'] as const)('refuses a %s review with a physical child', async (variant) => {
    const f = readerFixture(variant === 'resolved' ? resolved() : reviewMaterial(variant), [{ segment_index: 0 }])
    const before = JSON.stringify({ rows: f.rows, parent: f.parent })
    await expectRefusal(f.read(), INCOMPLETE)
    // Reaching C2's child read matters: an earlier generic unsupported refusal
    // cannot masquerade as proof of the zero-child guard.
    expect(f.query).toHaveBeenCalledTimes(3)
    expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
  })

  it.each(['unsupported', 'null_context'] as const)('still refuses incomplete current C1 %s', async (variant) => {
    const f = readerFixture()
    const material = reviewMaterial(variant)
    const c1 = calculation(1, material, [punch('check_in'), punch('check_out')])
    // Keep completed physical shape valid so only the current snapshot is unsupported.
    c1.expected_segment_count = 1
    c1.segment_snapshot = resolved().context.segments
    f.rows[0] = c1
    await expectRefusal(f.read(), INCOMPLETE)
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it('retains strict OT/default refusal for unsupported/null later C2', async () => {
    for (const mode of ['default', 'explicit_false'] as const) {
      const f = readerFixture(reviewMaterial('unsupported_and_null'))
      const before = JSON.stringify({ rows: f.rows, parent: f.parent })
      const target = { payload: { workDate: DATE }, ...resolved() }
      // Supported target isolates the later-history refusal; an unsupported
      // target would instead refuse at C1 before inspecting C2.
      const result = mode === 'default'
        ? readPreservedAuthoritativeCalculationInputsV1(f.scope, f.parent, target, null)
        : readPreservedAuthoritativeCalculationInputsV1(f.scope, f.parent, target, null, null, false)
      await expectRefusal(result, INCOMPLETE)
      expect(f.query).toHaveBeenCalledTimes(2)
      expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
    }
  })

  it('uses owner date D with re-resolved target snapshots D2 to preserve C1 and report context_mismatch', async () => {
    const f = readerFixture()
    const before = JSON.stringify({ rows: f.rows, parent: f.parent })
    const target = { payload: { workDate: DATE }, ...resolved(ORG, OTHER_DATE) }
    expect(target.context.workDate).toBe(OTHER_DATE)
    expect(await f.read(target)).toEqual(expected(f.rows, f.evidence, 'context_mismatch'))
    expect(f.query).toHaveBeenCalledTimes(4)
    expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
    // Helper coverage only: live boundary must itself pass input.workDate (D).
    // This test neither calls that boundary nor proves its current argument wiring.
  })

  it('retains a later live context_mismatch review without adopting its foreign date', async () => {
    const f = readerFixture(resolved(ORG, OTHER_DATE))
    Object.assign(f.rows[1], { entrypoint: 'live', outcome_reason_code: 'context_mismatch' })
    const before = JSON.stringify({ rows: f.rows, parent: f.parent })
    expect(await f.read()).toEqual(expected(f.rows, f.evidence, 'context_mismatch'))
    expect(f.query).toHaveBeenCalledTimes(5)
    expect(JSON.stringify({ rows: f.rows, parent: f.parent })).toBe(before)
  })

  it.each(['orgId', 'userId'] as const)('refuses foreign %s inside a later live context_mismatch review', async (field) => {
    const material = resolved(ORG, OTHER_DATE)
    const foreign = field === 'orgId' ? FOREIGN_ORG : 'synthetic-other-user'
    if (material.attribution.posture !== 'resolved_v2') throw new Error('Expected resolved attribution')
    material.attribution = { posture: 'resolved_v2', value: { ...material.attribution.value, [field]: foreign } }
    material.context = { ...material.context, [field]: foreign }
    const f = readerFixture(material)
    Object.assign(f.rows[1], { entrypoint: 'live', outcome_reason_code: 'context_mismatch' })
    await expectRefusal(f.read(), INCOMPLETE)
    expect(f.query).toHaveBeenCalledTimes(2)
  })

  it('keeps OT strict refusal for a later live context_mismatch review', async () => {
    const f = readerFixture(resolved(ORG, OTHER_DATE))
    Object.assign(f.rows[1], { entrypoint: 'live', outcome_reason_code: 'context_mismatch' })
    const target = { payload: { workDate: DATE }, ...resolved() }
    await expectRefusal(readPreservedAuthoritativeCalculationInputsV1(f.scope, f.parent, target, null), INCOMPLETE)
    expect(f.query).toHaveBeenCalledTimes(2)
  })
})
