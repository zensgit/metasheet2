import { describe, expect, it } from 'vitest'
import { buildAttendancePunchDetailPreparedPlanV1 } from '../w4c3a-punch-detail-prepare'
import { requireAttendancePunchDetailPlanBindingV1 } from '../w4c3a-punch-detail-command'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

describe('explicit punch-detail all-event preparation', () => {
  it.each([['fold_start', 165], ['fold_end', 195]] as const)(
    'retains four physical events and literal total for %s', (kind, minutes) => {
      const input = punchDetailPreparationFixture(kind)
      const { plan, calculation } = buildAttendancePunchDetailPreparedPlanV1(input)
      expect(calculation.outcome).toBe('completed')
      expect(calculation.dailyProjection?.workedMinutes).toBe(minutes)
      expect(plan.items.map((item) => item.rawEvidence.punches[0])).toEqual(input.envelope.__punchDetailInput.punches)
      expect(plan.items.map((item) => [item.ordinal, item.semanticOrdinal])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]])
      expect(plan.items.flatMap((item) => item.rawEvidence.punches)).toHaveLength(4)
      expect(plan.items.map((item) => item.rawEvidence.metrics.workMinutes)).toEqual(
        Array.from({ length: 4 }, () => ({ present: false, value: null })))
      const write = plan.recordWrites[0]
      expect(write.sourceOrdinals).toEqual([0, 1, 2, 3])
      expect(write.workMinutes).toBe(minutes)
      expect(write.firstInAt).toBe(input.envelope.__punchDetailInput.punches[0].occurredAt)
      expect(write.lastOutAt).toBe(input.envelope.__punchDetailInput.punches[3].occurredAt)
      expect(write.policySnapshot.sources.map((s) => s.output)).toEqual(Array.from({ length: 4 }, () => ({
        status: 'normal', workMinutes: minutes, lateMinutes: 0, earlyLeaveMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0,
      })))
      expect(write.attributionSnapshot.sources.map((s) => [s.attribution, s.context, s.importAttributionReconstruction]))
        .toEqual(Array.from({ length: 4 }, () => [input.attribution.attribution, input.context, input.attribution.reconstruction]))
      expect(requireAttendancePunchDetailPlanBindingV1({ ...plan, envelope: plan.payload })?.requestFingerprint)
        .toBe(plan.legacyInputFingerprint)
      expect(plan.groupEffects).toEqual([])
    })

  it.each([['gap', 'dst_gap_local_time'], ['shared_fold', 'dst_fold_shared_boundary_ambiguous']] as const)(
    'preserves %s review with all-null output, never outer-pair metrics', (kind, reason) => {
      const { plan, calculation } = buildAttendancePunchDetailPreparedPlanV1(punchDetailPreparationFixture(kind))
      expect(calculation).toMatchObject({ outcome: 'review_required', outcomeReasonCode: reason, dailyProjection: null })
      const write = plan.recordWrites[0]
      expect([write.status, write.firstInAt, write.lastOutAt, write.workMinutes, write.lateMinutes, write.earlyLeaveMinutes])
        .toEqual([null, null, null, null, null, null])
      expect(write.policySnapshot.sources.map((s) => s.output)).toEqual(Array.from({ length: 4 }, () => ({
        status: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null, leaveMinutes: null, overtimeMinutes: null,
      })))
      expect(plan.items.map((item) => item.previewSnapshot.reasonCode)).toEqual([reason, reason, reason, reason])
    })

  it.each(['orgId', 'userId', 'workDate', 'timezone', 'shiftId'] as const)(
    'refuses a different frozen context %s', (key) => {
      const input = punchDetailPreparationFixture()
      const context = { ...input.context, [key]: key === 'workDate' ? '2025-11-03' : key === 'timezone' ? 'UTC' : 'other' }
      expect(() => buildAttendancePunchDetailPreparedPlanV1({ ...input, context }))
        .toThrow('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
    })

  it('reconstructs attribution before accepting a changed target window', () => {
    const input = punchDetailPreparationFixture()
    const attribution = { ...input.attribution, attribution: { ...input.attribution.attribution,
      value: { ...input.attribution.attribution.value, absoluteWindow: {
        ...input.attribution.attribution.value.absoluteWindow, endAt: '2025-11-02T09:00:00.000Z',
      } } } }
    expect(() => buildAttendancePunchDetailPreparedPlanV1({ ...input, attribution })).toThrow()
  })

  it('rejects a modified policy definition without its original fingerprint', () => {
    const input = punchDetailPreparationFixture()
    const policySourceProof = { ...input.policySourceProof, sourceDefinition: {
      ...input.policySourceProof.sourceDefinition, rule: { ...input.policySourceProof.sourceDefinition.rule, roundingMinutes: 30 },
    } }
    expect(() => buildAttendancePunchDetailPreparedPlanV1({ ...input, policySourceProof })).toThrow()
  })

  it('keeps prepared context, policy, events and chunk settings detached and immutable', () => {
    const input = punchDetailPreparationFixture()
    const { plan } = buildAttendancePunchDetailPreparedPlanV1(input)
    const before = JSON.stringify(plan)
    Object.assign(input.context.segments[0], { endTime: '00:40' })
    Object.assign(input.chunkConfig as object, { size: 2 })
    expect(JSON.stringify(plan)).toBe(before)
    expect(Object.isFrozen(plan.recordWrites[0].attributionSnapshot.sources[0].context.segments[0])).toBe(true)
    expect(() => Object.assign(plan.items[0].rawEvidence.punches[0], { direction: 'check_out' })).toThrow()
  })
})
