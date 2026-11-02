import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { parseAttendancePunchDetailInputV1 } from '../w4c3a-punch-detail-input'
import { buildAttendancePunchDetailPreparedPlanV1, type AttendancePunchDetailPreparationInputV1 } from '../w4c3a-punch-detail-prepare'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const require = createRequire(import.meta.url)
type Response = { status: (n: number) => Response; json: (body: unknown) => void }
const { createAttendancePunchDetailProducerV1: create } = require('../../../../../plugins/plugin-attendance/lib/attendance-punch-detail-producer.cjs') as {
  createAttendancePunchDetailProducerV1(deps: Record<string, unknown>): {
    tryHandleAsyncCommit(req: { body: unknown }, res: Response): Promise<boolean>
  }
}
function harness() {
  const fixture = punchDetailPreparationFixture()
  const access = { orgId: fixture.scope.orgId, userId: fixture.scope.actorId, fullImport: true }
  const job = { id: '10000000-0000-4000-8000-000000000001', status: 'queued', total: 4 }
  const calls: string[] = []
  const port = {
    parsePunchDetailInput: parseAttendancePunchDetailInputV1,
    readPunchDetailImportJobReplay: vi.fn(async (input: { jobId?: string }) => {
      calls.push(input.jobId ? 'reserved-read' : 'retry-read')
      return input.jobId ? job : null as null | typeof job
    }),
    preparePunchDetailImport: vi.fn(async (input: Pick<AttendancePunchDetailPreparationInputV1, 'scope' | 'envelope' | 'batchId' | 'chunkConfig'>) => {
      calls.push('prepare'); return buildAttendancePunchDetailPreparedPlanV1({ ...fixture, ...input })
    }),
    reserveLegacyImportPlan: vi.fn(async () => { calls.push('reserve'); return { kind: 'created', jobId: job.id } }),
  }
  const deps = { HttpError, port, db: {}, randomUUID: () => fixture.batchId,
    requireImportCommitToken: false,
    consumeImportCommitToken: vi.fn(async () => { calls.push('token'); return true }),
    assertAttendanceImportPrepareAllowed: vi.fn(async () => access as typeof access | null),
    assertAttendanceImportCommitAllowed: vi.fn(async () => access as typeof access | null),
    resolveImportEngineByRowCount: () => 'standard', resolveImportRecordUpsertStrategy: () => 'values',
    resolveImportItemsInsertStrategy: () => 'values', resolveImportChunkConfig: () => ({ size: 100 }),
    mapImportJobRow: vi.fn((row: unknown) => row),
    enqueueImportJob: vi.fn(async () => { calls.push('enqueue') }),
  }
  const res = { status: vi.fn((_code: number) => res), json: vi.fn((_body: unknown) => undefined) }
  const body = { ...fixture.envelope.__punchDetailInput, idempotencyKey: 'async-command', commitToken: 'synthetic-token' }
  const run = (request: unknown = body) => create(deps).tryHandleAsyncCommit({ body: request }, res)
  return { fixture, access, job, calls, port, deps, res, body, run }
}
describe('named punch-detail async commit producer', () => {
  it('preserves daily dispatch with no dependency calls', async () => {
    const h = harness()
    expect(await h.run({ rows: [] })).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.deps.assertAttendanceImportPrepareAllowed).not.toHaveBeenCalled()
    expect(h.res.json).not.toHaveBeenCalled()
  })
  it('refuses an unknown explicit format instead of daily fallback', async () => {
    const h = harness()
    expect(await h.run({ inputKind: 'unknown', rows: [] })).toBe(true)
    expect(h.res.status).toHaveBeenCalledWith(400)
    expect(h.calls).toEqual([])
  })
  it.each(['actor', 'target', 'fullImport', 'foreignOrg'])('rejects %s before replay/token/freeze', async kind => {
    const h = harness()
    if (kind === 'actor') h.deps.assertAttendanceImportPrepareAllowed.mockResolvedValue(null)
    if (kind === 'target') h.deps.assertAttendanceImportCommitAllowed.mockResolvedValue(null)
    if (kind === 'fullImport') h.access.fullImport = false
    await h.run(kind === 'foreignOrg' ? { ...h.body, orgId: 'foreign-org' } : h.body)
    expect(h.calls).toEqual([])
    if (['fullImport', 'foreignOrg'].includes(kind)) expect(h.res.status).toHaveBeenCalledWith(403)
  })
  it('reserves all events and enqueues only server jobId after verified job read', async () => {
    const h = harness()
    expect(await h.run()).toBe(true)
    expect(h.calls).toEqual(['retry-read', 'token', 'prepare', 'reserve', 'reserved-read', 'enqueue'])
    expect(h.port.reserveLegacyImportPlan).toHaveBeenCalledWith(expect.objectContaining({
      actorPosture: 'attendance_admin', actorId: h.access.userId, tokenSubjectUserId: h.access.userId,
      legacyRowSourceKind: 'direct_rows', groupEffects: [],
      items: expect.arrayContaining(h.fixture.envelope.__punchDetailInput.punches.map((p, ordinal) => expect.objectContaining({
        ordinal, rawEvidence: expect.objectContaining({ punches: [p] }),
      }))),
    }))
    expect(h.deps.enqueueImportJob).toHaveBeenCalledTimes(1)
    expect(h.deps.enqueueImportJob).toHaveBeenCalledWith(h.job.id)
    expect(h.res.json).toHaveBeenCalledWith({ ok: true, data: { job: h.job } })
  })
  it('returns an admitted retry without token consumption, freeze or enqueue', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true
    h.port.readPunchDetailImportJobReplay.mockResolvedValue(h.job)
    const { commitToken: _token, ...body } = h.body
    await h.run(body)
    expect(h.calls).toEqual([])
    expect(h.port.readPunchDetailImportJobReplay).toHaveBeenCalledTimes(1)
    expect(h.res.json).toHaveBeenCalledWith({ ok: true, data: { job: h.job, idempotent: true } })
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it.each([
    ['ATTENDANCE_WRITE_NOT_AUTHORIZED', 403], ['ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED', 409],
    ['ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT', 409],
  ] as const)('propagates current replay rejection %s before effects', async (code, status) => {
    const h = harness(); h.port.readPunchDetailImportJobReplay.mockRejectedValue(new Error(code))
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(status)
    expect(h.res.json).toHaveBeenCalledWith({ ok: false, error: { code, message: code } })
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
  })
  it('retains required-token refusal on a replay miss', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true
    h.deps.consumeImportCommitToken.mockResolvedValue(false)
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(403)
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it('does not enqueue an existing reservation won by a concurrent request', async () => {
    const h = harness(); h.port.reserveLegacyImportPlan.mockResolvedValue({ kind: 'existing', jobId: h.job.id })
    await h.run()
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
    expect(h.res.json).toHaveBeenCalledWith({ ok: true, data: { job: h.job, idempotent: true } })
  })
  it('does not acknowledge or enqueue a missing reserved job', async () => {
    const h = harness(); h.port.readPunchDetailImportJobReplay.mockResolvedValue(null)
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(500)
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
  })
  it('maps reservation permission denial to the public authorization code', async () => {
    const h = harness()
    h.port.reserveLegacyImportPlan.mockRejectedValue(Object.assign(new Error('W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED'), {
      code: 'W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED',
    }))
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(403)
    expect(h.res.json).toHaveBeenCalledWith({ ok: false, error: {
      code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED',
    } })
    expect(h.port.readPunchDetailImportJobReplay).toHaveBeenCalledTimes(1)
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
  })
  it('preserves infrastructure failure as generic failure without authorization downgrade', async () => {
    const h = harness()
    h.port.reserveLegacyImportPlan.mockRejectedValue(Object.assign(new Error('synthetic SQL failure'), { code: '40001' }))
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(500)
    expect(h.res.json).toHaveBeenCalledWith({ ok: false, error: {
      code: 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED', message: 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED',
    } })
    expect(h.port.readPunchDetailImportJobReplay).toHaveBeenCalledTimes(1)
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
  })
})
