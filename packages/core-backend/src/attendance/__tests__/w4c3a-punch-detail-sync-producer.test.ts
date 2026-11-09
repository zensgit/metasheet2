import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { parseAttendancePunchDetailInputV1 } from '../w4c3a-punch-detail-input'
import { fingerprintAttendancePunchDetailCommandV1 } from '../w4c3a-punch-detail-command'
import { buildAttendancePunchDetailPreparedPlanV1, type AttendancePunchDetailPreparationInputV1 } from '../w4c3a-punch-detail-prepare'
import { punchDetailPreparationFixture, type PunchDetailFixtureKind } from './helpers/punch-detail-plan-fixture'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const require = createRequire(import.meta.url)
type Scope = AttendancePunchDetailPreparationInputV1['scope']
type Envelope = AttendancePunchDetailPreparationInputV1['envelope']
type Request = { body: unknown }
type Response = { status: (code: number) => Response; json: (value: unknown) => void }
const { createAttendancePunchDetailProducerV1: create } = require('../../../../../plugins/plugin-attendance/lib/attendance-punch-detail-producer.cjs') as {
  createAttendancePunchDetailProducerV1(deps: Record<string, unknown>): {
    tryHandleSync(operation: string, req: Request, res: Response): Promise<boolean>
    rejectDailyReplay(existing: unknown, res: Response): boolean
  }
}
function harness(kind: PunchDetailFixtureKind = 'fold_start') {
  const fixture = punchDetailPreparationFixture(kind)
  const access = { orgId: fixture.scope.orgId, userId: fixture.scope.actorId, fullImport: true }
  const committed = { batchId: fixture.batchId, imported: 4, processedRows: 4, failedRows: 0, elapsedMs: 1,
    engine: 'standard', recordUpsertStrategy: 'values', items: [], itemsTruncated: false,
    skipped: [], csvWarnings: [], groupWarnings: [], meta: {} }
  const port = {
    parsePunchDetailInput: parseAttendancePunchDetailInputV1,
    fingerprintPunchDetailCommand: fingerprintAttendancePunchDetailCommandV1,
    preparePunchDetailImport: vi.fn(async (input: Pick<AttendancePunchDetailPreparationInputV1, 'scope' | 'envelope' | 'batchId' | 'chunkConfig'>) =>
      buildAttendancePunchDetailPreparedPlanV1({ ...fixture, ...input })),
    readPunchDetailImportReplay: vi.fn(async () => null as null | Record<string, unknown>),
    commitSyncImportPlan: vi.fn(async () => committed),
  }
  const deps = {
    HttpError, port, db: {}, randomUUID: () => fixture.batchId,
    requireImportCommitToken: false,
    assertAttendanceImportPrepareAllowed: vi.fn(async () => access as typeof access | null),
    assertAttendanceImportPreviewAllowed: vi.fn(async () => access as typeof access | null),
    assertAttendanceImportCommitAllowed: vi.fn(async () => access as typeof access | null),
    resolveImportEngineByRowCount: () => 'standard',
    resolveImportRecordUpsertStrategy: () => 'values',
    resolveImportItemsInsertStrategy: () => 'values',
    resolveImportChunkConfig: () => ({ size: 100 }),
    loadIdempotentImportBatch: vi.fn(async () => null as null | Record<string, unknown>),
    consumeImportCommitToken: vi.fn(async () => true),
  }
  const res = { status: vi.fn((_code: number) => res), json: vi.fn((_value: unknown) => undefined) }
  const req = { body: { ...fixture.envelope.__punchDetailInput, idempotencyKey: 'public-request' } }
  const producer = () => create(deps)
  const reply = () => res.json.mock.calls.at(-1)?.[0]
  const fingerprint = () => {
    const scope: Scope = { ...fixture.scope, actorPosture: 'attendance_admin' }
    const envelope: Envelope = { ...fixture.envelope, idempotencyKey: 'public-request' }
    return fingerprintAttendancePunchDetailCommandV1(scope, envelope)
  }
  return { fixture, access, committed, port, deps, res, req, producer, reply, fingerprint }
}
describe('named punch-detail synchronous producer', () => {
  it('leaves daily input completely untouched with zero authority or database calls', async () => {
    const h = harness()
    expect(await h.producer().tryHandleSync('commit', { body: { rows: [] } }, h.res)).toBe(false)
    expect(h.res.json).not.toHaveBeenCalled()
    expect(h.deps.assertAttendanceImportPrepareAllowed).not.toHaveBeenCalled()
    expect(h.deps.loadIdempotentImportBatch).not.toHaveBeenCalled()
    expect(h.port.readPunchDetailImportReplay).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it('rejects unknown explicit input without invoking legacy or authority dependencies', async () => {
    const h = harness()
    await h.producer().tryHandleSync('commit', { body: { inputKind: 'unknown', rows: [] } }, h.res)
    expect(h.reply()).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID', message: 'ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID' } })
    expect(h.res.status).toHaveBeenCalledWith(400)
    expect(h.deps.assertAttendanceImportPrepareAllowed).not.toHaveBeenCalled()
  })
  it('refuses a foreign org selector before target authorization and preparation', async () => {
    const h = harness()
    await h.producer().tryHandleSync('commit', { body: { ...h.req.body, orgId: 'other-org' } }, h.res)
    expect(h.res.status).toHaveBeenCalledWith(403)
    expect(h.deps.assertAttendanceImportCommitAllowed).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it.each(['actor', 'target'])('does not consume a token, replay or freeze when %s authorization refuses', async (layer) => {
    const h = harness()
    if (layer === 'actor') h.deps.assertAttendanceImportPrepareAllowed.mockResolvedValue(null)
    else h.deps.assertAttendanceImportCommitAllowed.mockResolvedValue(null)
    await h.producer().tryHandleSync('commit', { body: { ...h.req.body, commitToken: 'fixture-token' } }, h.res)
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.deps.loadIdempotentImportBatch).not.toHaveBeenCalled()
    expect(h.port.readPunchDetailImportReplay).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
    expect(h.res.json).not.toHaveBeenCalled()
  })
  it.each(['fold_start', 'fold_end', 'gap', 'shared_fold'] as const)('returns actual %s preview with four events and one target, without commit', async (kind) => {
    const h = harness(kind)
    expect(await h.producer().tryHandleSync('preview', h.req, h.res)).toBe(true)
    const prepared = buildAttendancePunchDetailPreparedPlanV1(h.fixture)
    expect(h.reply()).toEqual({ ok: true, data: {
      inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1,
      total: 4, rowCount: 4, processedRows: 4, failedRows: 0,
      items: h.fixture.envelope.__punchDetailInput.punches.map((punch, sourceOrdinal) => ({ sourceOrdinal, ...punch })),
      previewLimit: 4, truncated: false,
      targets: [{ userId: h.req.body.userId, workDate: h.req.body.workDate,
        outcome: prepared.calculation.outcome, reasonCode: prepared.calculation.outcomeReasonCode,
        dailyProjection: prepared.calculation.dailyProjection, segments: prepared.calculation.segments }],
      engine: 'standard', recordUpsertStrategy: 'values', csvWarnings: [], groupWarnings: [],
    } })
    expect(h.port.commitSyncImportPlan).not.toHaveBeenCalled()
  })
  it('passes all four events through the sync effect port with trusted actor scope and separate return policy', async () => {
    const h = harness()
    await h.producer().tryHandleSync('commit', { body: { ...h.req.body, returnItems: false, itemsLimit: 1 } }, h.res)
    expect(h.port.preparePunchDetailImport).toHaveBeenCalledWith(expect.objectContaining({
      scope: { ...h.fixture.scope, actorPosture: 'attendance_admin' },
    }), expect.any(Function))
    expect(h.port.commitSyncImportPlan).toHaveBeenCalledWith(expect.objectContaining({
      actorPosture: 'attendance_admin', actorId: h.access.userId, tokenSubjectUserId: h.access.userId,
      items: expect.arrayContaining(h.fixture.envelope.__punchDetailInput.punches.map((punch, ordinal) => expect.objectContaining({
        ordinal, rawEvidence: expect.objectContaining({ punches: [punch] }),
      }))), itemReturnPolicy: { returnItems: false, itemsLimit: null }, groupEffects: [],
    }))
    expect(h.reply()).toEqual({ ok: true, success: true, data: { ...h.committed, inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1 } })
  })
  it('requires a configured token before any frozen source reads', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true
    await h.producer().tryHandleSync('commit', h.req, h.res)
    expect(h.res.status).toHaveBeenCalledWith(400)
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it('binds token validation to the requester and rejects an invalid required token', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true; h.deps.consumeImportCommitToken.mockResolvedValue(false)
    await h.producer().tryHandleSync('commit', { body: { ...h.req.body, commitToken: 'fixture-token' } }, h.res)
    expect(h.deps.consumeImportCommitToken).toHaveBeenCalledWith('fixture-token', { db: h.deps.db, orgId: h.access.orgId, userId: h.access.userId })
    expect(h.res.status).toHaveBeenCalledWith(403)
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it('preserves unenforced preview token behavior without consumption', async () => {
    const h = harness()
    await h.producer().tryHandleSync('preview', { body: { ...h.req.body, commitToken: 'fixture-token' } }, h.res)
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).toHaveBeenCalledTimes(1)
  })
  it('returns congruent retry after target authorization without a new token or freeze', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true
    h.port.readPunchDetailImportReplay.mockResolvedValue({ batchId: h.fixture.batchId, imported: 4, skipped: 0, meta: { punchDetailRequestFingerprint: h.fingerprint() } })
    await h.producer().tryHandleSync('commit', h.req, h.res)
    expect(h.deps.assertAttendanceImportCommitAllowed).toHaveBeenCalledTimes(1)
    expect(h.port.readPunchDetailImportReplay).toHaveBeenCalledWith({ scope: { ...h.fixture.scope, actorPosture: 'attendance_admin' }, envelope: { ...h.fixture.envelope, idempotencyKey: 'public-request' } })
    expect(h.deps.loadIdempotentImportBatch).not.toHaveBeenCalled()
    expect(h.reply()).toMatchObject({ ok: true, data: { idempotent: true, imported: 4, eventCount: 4, targetCount: 1 } })
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it.each([{}, { punchDetailRequestFingerprint: 'changed-input' }])('rejects incongruent or daily existing batch %j before token use', async (meta) => {
    const h = harness()
    h.port.readPunchDetailImportReplay.mockResolvedValue({ batchId: h.fixture.batchId, imported: 4, skipped: 0, meta })
    await h.producer().tryHandleSync('commit', h.req, h.res)
    expect(h.res.status).toHaveBeenCalledWith(409)
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
  })
  it.each([
    ['ATTENDANCE_WRITE_NOT_AUTHORIZED', 403],
    ['ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED', 409],
  ] as const)('rechecks replay admission and refuses %s before returning an existing batch', async (code, status) => {
    const h = harness()
    h.deps.loadIdempotentImportBatch.mockResolvedValue({ batchId: h.fixture.batchId, imported: 4, skipped: 0,
      meta: { punchDetailRequestFingerprint: h.fingerprint() } })
    h.port.readPunchDetailImportReplay.mockRejectedValue(new Error(code))
    await h.producer().tryHandleSync('commit', h.req, h.res)
    expect(h.reply()).toEqual({ ok: false, error: { code, message: code } })
    expect(h.res.status).toHaveBeenCalledWith(status)
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.port.preparePunchDetailImport).not.toHaveBeenCalled()
    expect(h.port.commitSyncImportPlan).not.toHaveBeenCalled()
  })

  it('prevents a daily request adopting a named batch while leaving existing daily replay intact', () => {
    const h = harness()
    expect(h.producer().rejectDailyReplay({ meta: {} }, h.res)).toBe(false)
    expect(h.res.json).not.toHaveBeenCalled()
    expect(h.producer().rejectDailyReplay({ meta: { punchDetailRequestFingerprint: 'named' } }, h.res)).toBe(true)
    expect(h.res.status).toHaveBeenCalledWith(409)
  })
})
