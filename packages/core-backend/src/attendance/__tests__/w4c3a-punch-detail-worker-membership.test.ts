import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceLegacyPlanWorkerCallbacksV1, VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import { buildAttendancePunchDetailPreparedPlanV1 } from '../w4c3a-punch-detail-prepare'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const state = vi.hoisted(() => ({
  plan: null as unknown,
  query: vi.fn(),
  release: vi.fn(),
  oldPreconditions: vi.fn(),
}))
vi.mock('../w4c3a-legacy-plan-preconditions', () => ({
  lockAndRecheckAttendanceLegacyPlanPreconditionsV1: state.oldPreconditions,
}))
vi.mock('../w4c3a-legacy-plan-worker', () => ({
  createAttendanceLegacyPlanWorkerV1: (callbacks: AttendanceLegacyPlanWorkerCallbacksV1<AttendanceW4TransactionClientV1>) => ({
    process: async () => callbacks.recheckPreconditions({ query: state.query }, state.plan as VerifiedAttendanceLegacyPlanV1),
  }),
}))
import { createAttendanceLegacyPlanProcessorV1 } from '../w4c3a-legacy-plan-processor'

const scope = { orgId: '2ec9914b-5352-4f9a-a4ef-4c344c045ef1', actorId: 'punch-detail-admin',
  actorPosture: 'attendance_admin', tokenSubjectUserId: 'punch-detail-admin' }
const subject = 'punch-detail-employee'
let refused: string | null
function run() {
  return createAttendanceLegacyPlanProcessorV1({
    acquireConnection: async () => ({ client: { query: state.query }, release: state.release }),
  }).processLegacyImportPlanV1('punch-detail-worker-fixture')
}
beforeEach(() => {
  refused = null
  vi.clearAllMocks()
  state.oldPreconditions.mockResolvedValue(true)
  const fixture = punchDetailPreparationFixture()
  const prepared = buildAttendancePunchDetailPreparedPlanV1({ ...fixture, scope })
  state.plan = { manifest: { ...scope, sourceRef: 'attendance-import:punch-detail-worker', batch: prepared.plan.batch } }
  state.query.mockImplementation(async (sql: string, args: unknown[]) => {
    const user = String(args[0])
    if (sql.includes('FROM users')) {
      expect(sql).toContain("COALESCE(activation_status, 'activated') = 'activated'")
      return { rows: refused === 'inactive_' + (user === scope.actorId ? 'actor' : 'subject') ? [] : [{ exists: 1 }] }
    }
    if (sql.includes('FROM user_orgs')) {
      expect(args[1]).toBe(scope.orgId)
      return { rows: refused === (user === scope.actorId ? 'actor' : 'subject') + '_membership' ? [] : [{ exists: 1 }] }
    }
    throw new Error('UNEXPECTED_WORKER_MEMBERSHIP_QUERY')
  })
})

describe('punch detail durable worker current subject admission', () => {
  it('checks both live identities and memberships before the unchanged plan preconditions', async () => {
    await expect(run()).resolves.toBe(true)
    expect(state.query.mock.calls.map(([sql, args]) => [String(sql).includes('FROM users') ? 'user' : 'membership', args]))
      .toEqual([['user', [scope.actorId]], ['membership', [scope.actorId, scope.orgId]],
        ['user', [subject]], ['membership', [subject, scope.orgId]]])
    expect(state.oldPreconditions).toHaveBeenCalledTimes(1)
    expect(state.oldPreconditions.mock.invocationCallOrder[0]).toBeGreaterThan(state.query.mock.invocationCallOrder.at(-1)!)
    expect(state.release).toHaveBeenCalledTimes(1)
  })

  it.each(['inactive_actor', 'actor_membership', 'inactive_subject', 'subject_membership'])(
    'rejects current %s before plan preconditions', async (reason) => {
      refused = reason
      await expect(run()).resolves.toBe(false)
      expect(state.oldPreconditions).not.toHaveBeenCalled()
      expect(state.release).toHaveBeenCalledTimes(1)
    },
  )

  it('requires membership even when the imported subject is the platform actor', async () => {
    const fixture = punchDetailPreparationFixture()
    const self = { ...fixture, envelope: { ...fixture.envelope,
      __punchDetailInput: { ...fixture.envelope.__punchDetailInput, userId: scope.actorId } } }
    state.plan = { manifest: { ...scope, actorPosture: 'platform_admin',
      sourceRef: 'attendance-import:punch-detail-worker', batch: { kind: 'normal',
        mappingSnapshot: { kind: 'punch_events_v1', envelope: self.envelope } } } }
    refused = 'actor_membership'
    await expect(run()).resolves.toBe(false)
    expect(state.query.mock.calls.map(([sql]) => String(sql).includes('FROM users') ? 'user' : 'membership'))
      .toEqual(['user', 'membership'])
    expect(state.oldPreconditions).not.toHaveBeenCalled()
  })

  it('preserves daily preconditions with no added subject SQL', async () => {
    state.plan = { manifest: { batch: { kind: 'normal', mappingSnapshot: {} } } }
    await expect(run()).resolves.toBe(true)
    expect(state.query).not.toHaveBeenCalled()
    expect(state.oldPreconditions).toHaveBeenCalledTimes(1)
  })

  it('retains a failed original plan precondition for an active subject', async () => {
    state.oldPreconditions.mockResolvedValue(false)
    await expect(run()).resolves.toBe(false)
    expect(state.oldPreconditions).toHaveBeenCalledTimes(1)
  })

  it('propagates SQL failure instead of disguising it as a membership rejection', async () => {
    const failure = new Error('SYNTHETIC_SQL_FAILURE')
    state.query.mockRejectedValue(failure)
    await expect(run()).rejects.toBe(failure)
    expect(state.oldPreconditions).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledTimes(1)
  })

  it('rejects a marked invalid command before liveness or plan SQL', async () => {
    state.plan = { manifest: { batch: { kind: 'normal', mappingSnapshot: {
      kind: 'punch_events_v1', envelope: {},
    } } } }
    await expect(run()).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    expect(state.query).not.toHaveBeenCalled()
    expect(state.oldPreconditions).not.toHaveBeenCalled()
  })
})
