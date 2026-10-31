import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAttendanceImportAttributionFreezeV1,
  buildAttendanceImportPolicySourceProofV1,
  verifyAttendanceImportPolicySourceFingerprintV1,
} from '../w4c3a-import-proof'
import { buildAttendancePunchDetailPreparedPlanV1, type AttendancePunchDetailPreparationInputV1 } from '../w4c3a-punch-detail-prepare'
import { punchDetailPreparationFixture, type PunchDetailFixtureKind } from './helpers/punch-detail-plan-fixture'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const require = createRequire(import.meta.url)
const { createAttendancePunchDetailFrozenTargetResolverV1: create } = require('../../../../../plugins/plugin-attendance/lib/attendance-punch-detail-prepare.cjs') as {
  createAttendancePunchDetailFrozenTargetResolverV1(deps: Record<string, unknown>): (
    trx: object, args: { orgId: string; input: AttendancePunchDetailPreparationInputV1['envelope']['__punchDetailInput']; referenceSegments: boolean },
  ) => Promise<Pick<AttendancePunchDetailPreparationInputV1, 'attribution' | 'context' | 'policySourceProof'>>
}

function harness(kind: PunchDetailFixtureKind = 'fold_start') {
  const fixture = punchDetailPreparationFixture(kind)
  const input = fixture.envelope.__punchDetailInput
  const rule = { ...verifyAttendanceImportPolicySourceFingerprintV1(fixture.policySourceProof).rule,
    id: fixture.context.shiftId, orgId: fixture.scope.orgId }
  const window = { startAt: new Date(input.punches[0].occurredAt), endAt: new Date(input.punches[3].occurredAt) }
  const winner = {
    orgId: fixture.scope.orgId, userId: input.userId, workDate: input.workDate,
    shiftId: fixture.context.shiftId, timezone: input.timezone, source: 'shift',
    assignmentId: 'published-assignment', workStartTime: rule.workStartTime, workEndTime: rule.workEndTime,
    isOvernight: false, absoluteWindow: window, attributionWindow: window,
  }
  const result = { kind: 'resolved', workDate: input.workDate, shiftId: fixture.context.shiftId,
    fullWinner: winner, attributionTailMinutes: 0, reasonCode: 'SINGLE_MATCHING_CANDIDATE', approvedOvertimeWindows: [] }
  const resolve = vi.fn(async () => result)
  const createWorkDateResolver = vi.fn(() => ({ adapters: { import: { resolveImportWorkDate: resolve } } }))
  const loadShiftById = vi.fn(async () => rule as typeof rule | null)
  const resolveWorkContext = vi.fn(async () => ({ rule, isWorkingDay: true, holiday: null }))
  const issueFrozenContext = vi.fn(async () => ({ arm: 'legacy', context: fixture.context }))
  const policy = vi.fn(buildAttendanceImportPolicySourceProofV1)
  const trx = Object.freeze({ preparationFixture: true })
  const resolver = create({ HttpError, port: { buildImportAttributionFreeze: buildAttendanceImportAttributionFreezeV1,
    buildImportPolicySourceProof: policy },
  loadDefaultRule: vi.fn(async () => ({ ...rule, timezone: 'UTC' })), createWorkDateResolver,
  loadShiftById, resolveWorkContext, issueFrozenContext, parseOvertimeAttribution: () => null })
  const args = { orgId: fixture.scope.orgId, input, referenceSegments: true }
  return { fixture, input, rule, winner, result, resolve, createWorkDateResolver, loadShiftById,
    resolveWorkContext, issueFrozenContext, policy, trx, resolver, args }
}

describe('punch-detail published frozen-target preparation', () => {
  it.each(['fold_start', 'fold_end', 'gap', 'shared_fold'] as const)('preserves all physical events and the actual %s outcome', async (kind) => {
    const h = harness(kind)
    const frozen = await h.resolver(h.trx, h.args)
    const prepared = buildAttendancePunchDetailPreparedPlanV1({ ...h.fixture, ...frozen })
    expect(h.createWorkDateResolver).toHaveBeenCalledWith(h.trx, { lockScheduleFacts: true, strictSources: true, strictWallInstants: true })
    expect(h.resolve).toHaveBeenCalledWith({ orgId: h.args.orgId, userId: h.input.userId,
      occurredAt: new Date(h.input.punches[0].occurredAt), timezone: 'UTC',
      calendarWorkDate: h.input.workDate, explicitWorkDate: h.input.workDate, explicitShiftId: null, includeFullWinner: true })
    expect(h.loadShiftById).toHaveBeenCalledWith(h.trx, h.args.orgId, h.winner.shiftId, true)
    expect(h.resolveWorkContext).toHaveBeenCalledWith(expect.objectContaining({
      db: h.trx, referenceSegments: true, strictSources: true, publishedProfile: {
        rule: h.rule, source: 'shift', assignmentId: 'published-assignment', rotationRuleId: undefined },
    }))
    expect(h.issueFrozenContext).toHaveBeenCalledTimes(1)
    expect(h.issueFrozenContext).toHaveBeenCalledWith(h.trx, expect.objectContaining({
      timezone: h.input.timezone, workDate: h.input.workDate, userId: h.input.userId, shiftId: h.winner.shiftId,
    }))
    expect(prepared.plan.items.flatMap((item) => item.rawEvidence.punches)).toEqual(h.input.punches)
    expect(prepared.plan.recordWrites).toHaveLength(1)
    if (kind === 'fold_start' || kind === 'fold_end') {
      expect(prepared.calculation.outcome).toBe('completed')
      expect(prepared.calculation.dailyProjection?.workedMinutes).toBe(kind === 'fold_start' ? 165 : 195)
    } else {
      expect(prepared.calculation.dailyProjection).toBeNull()
      expect(prepared.calculation.outcomeReasonCode).toBe(kind === 'gap' ? 'dst_gap_local_time' : 'dst_fold_shared_boundary_ambiguous')
    }
    expect(h.policy).toHaveBeenCalledWith(expect.objectContaining({
      engineVersion: null, policy: { appliedRules: [], userGroups: [] }, engine: null,
    }))
  })

  it('uses the first available check-in only for target selection after an initial checkout', async () => {
    const h = harness()
    const input = { ...h.input, punches: h.input.punches.slice(1) }
    await h.resolver(h.trx, { ...h.args, input })
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: new Date(input.punches[1].occurredAt) }))
    expect(input.punches).toHaveLength(3)
  })
  it('rejects an unverified segment posture before source resolution', async () => {
    const h = harness()
    await expect(h.resolver(h.trx, { ...h.args, referenceSegments: false })).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it.each(['ambiguous', 'unresolved'])('does not invent an attribution for %s', async (kind) => {
    const h = harness(); h.result.kind = kind
    await expect(h.resolver(h.trx, h.args)).rejects.toThrow(kind === 'ambiguous' ? 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' : 'WORK_DATE_ATTRIBUTION_UNRESOLVED')
    expect(h.issueFrozenContext).not.toHaveBeenCalled()
  })
  it.each(['workDate', 'timezone', 'orgId', 'userId', 'shiftId'] as const)('rejects mismatched published winner %s', async (key) => {
    const h = harness(); h.winner[key] = 'mismatch'
    await expect(h.resolver(h.trx, h.args)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
    expect(h.issueFrozenContext).not.toHaveBeenCalled()
  })
  it('refuses a missing selected shift without another source fallback', async () => {
    const h = harness(); h.loadShiftById.mockResolvedValue(null)
    await expect(h.resolver(h.trx, h.args)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
    expect(h.issueFrozenContext).not.toHaveBeenCalled()
  })
  it('rejects an invalid candidate instant rather than constructing a window', async () => {
    const h = harness(); h.winner.absoluteWindow = { ...h.winner.absoluteWindow, startAt: new Date('invalid') }
    await expect(h.resolver(h.trx, h.args)).rejects.toThrow('ATTENDANCE_IMPORT_ATTRIBUTION_PROOF_INVALID')
    expect(h.issueFrozenContext).not.toHaveBeenCalled()
  })
  it('preserves the existing W7 suspension refusal', async () => {
    const h = harness(); const failure = new HttpError(409, 'W7_CONTEXT_SOURCE_SUSPENDED', 'W7_CONTEXT_SOURCE_SUSPENDED')
    h.issueFrozenContext.mockRejectedValue(failure)
    await expect(h.resolver(h.trx, h.args)).rejects.toBe(failure)
    expect(h.policy).not.toHaveBeenCalled()
  })
})
