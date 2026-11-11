import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { parseAttendancePunchDetailInputV1 } from '../w4c3a-punch-detail-input'
import { buildAttendancePunchDetailPreviewRecordV1 } from '../w4c3a-punch-detail-preview-record'
import type { createAttendancePunchDetailPreviewHostV1 } from '../w4c3a-punch-detail-preview-host'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const require = createRequire(import.meta.url)
type Response = { status: (n: number) => Response; json: (body: unknown) => void }
const { createAttendancePunchDetailProducerV1: create } = require('../../../../../plugins/plugin-attendance/lib/attendance-punch-detail-producer.cjs') as {
  createAttendancePunchDetailProducerV1(deps: Record<string, unknown>): {
    tryHandleAsyncPreview(req: { body: unknown }, res: Response): Promise<boolean>
    handlePreviewJobRead(req: { attendanceImportAccess?: unknown }, res: Response, jobId: string): Promise<void>
  }
}
type Reserve = ReturnType<typeof createAttendancePunchDetailPreviewHostV1>['reservePunchDetailPreview']
function harness(existing = false) {
  const fixture = punchDetailPreparationFixture()
  const access = { orgId: fixture.scope.orgId, userId: fixture.scope.actorId, fullImport: false }
  const client = { __w4CanonicalTrx: true as const, query: vi.fn(async () => []) }
  const jobId = '22000000-0000-4000-8000-000000000001'
  const initial = buildAttendancePunchDetailPreviewRecordV1({ jobId, preparation: fixture, previewLimit: 2 })
  const job = { id: jobId, status: existing ? 'completed' : 'queued', idempotency_key: 'punch-preview:internal', punch_preview_version: 1 }
  const result = { created: !existing, job, record: initial.record }
  const port = {
    parsePunchDetailInput: parseAttendancePunchDetailInputV1,
    reservePunchDetailPreview: vi.fn(async (input: Parameters<Reserve>[0], callbacks: Parameters<Reserve>[1]) => {
      if (!await callbacks.authorizeTarget(client, input)) throw new Error('ATTENDANCE_WRITE_NOT_AUTHORIZED')
      if (!existing) await callbacks.beforeCreate(client)
      return { ...result, record: buildAttendancePunchDetailPreviewRecordV1({ jobId,
        preparation: { ...fixture, scope: input.scope, envelope: input.envelope, batchId: input.batchId }, previewLimit: input.previewLimit }).record }
    }),
    readPunchDetailPreviewJob: vi.fn(async () => result as typeof result | null),
  }
  const deps = { HttpError, port, db: { unowned: true }, randomUUID: () => fixture.batchId,
    requireImportCommitToken: false, consumeImportCommitToken: vi.fn(async () => true),
    authorizePunchDetailPreview: vi.fn(async () => true),
    assertAttendanceImportPrepareAllowed: vi.fn(async () => access as typeof access | null),
    assertAttendanceImportPreviewAllowed: vi.fn(async () => access as typeof access | null),
    resolveImportEngineByRowCount: () => 'standard', resolveImportRecordUpsertStrategy: () => 'values',
    resolveImportItemsInsertStrategy: () => 'values', mapImportJobRow: vi.fn((row: unknown) => row),
    enqueueImportJob: vi.fn(async () => {}),
  }
  const res = { status: vi.fn((_code: number) => res), json: vi.fn((_body: unknown) => undefined) }
  const body = { ...fixture.envelope.__punchDetailInput, idempotencyKey: 'preview-original', previewLimit: 2, commitToken: 'test-token' }
  const run = (request: unknown = body) => create(deps).tryHandleAsyncPreview({ body: request }, res)
  return { fixture, access, client, job, result, port, deps, res, body, run, producer: () => create(deps) }
}
describe('named punch-detail async preview producer', () => {
  it('keeps daily dispatch untouched with zero dependency calls', async () => {
    const h = harness()
    expect(await h.run({ rows: [] })).toBe(false)
    expect(h.deps.assertAttendanceImportPrepareAllowed).not.toHaveBeenCalled()
    expect(h.res.json).not.toHaveBeenCalled()
  })
  it('refuses unknown named format without daily fallback or reservation', async () => {
    const h = harness(); expect(await h.run({ inputKind: 'unknown' })).toBe(true)
    expect(h.res.status).toHaveBeenCalledWith(400)
    expect(h.port.reservePunchDetailPreview).not.toHaveBeenCalled()
  })
  it.each(['actor', 'target', 'foreignOrg'])('refuses %s before reservation', async kind => {
    const h = harness()
    if (kind === 'actor') h.deps.assertAttendanceImportPrepareAllowed.mockResolvedValue(null)
    if (kind === 'target') h.deps.assertAttendanceImportPreviewAllowed.mockResolvedValue(null)
    await h.run(kind === 'foreignOrg' ? { ...h.body, orgId: 'foreign-org' } : h.body)
    expect(h.port.reservePunchDetailPreview).not.toHaveBeenCalled()
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
  })
  it('preserves scoped target decision and reserves full events before enqueueing only job ID', async () => {
    const h = harness(); await h.run()
    expect(h.port.reservePunchDetailPreview).toHaveBeenCalledWith(expect.objectContaining({
      scope: { ...h.fixture.scope, actorPosture: 'attendance_admin' }, previewLimit: 2,
      envelope: expect.objectContaining({ __punchDetailInput: h.fixture.envelope.__punchDetailInput }),
    }), expect.objectContaining({ authorizeTarget: h.deps.authorizePunchDetailPreview,
      beforeCreate: expect.any(Function), resolveFrozenTarget: expect.any(Function) }))
    expect(h.deps.enqueueImportJob).toHaveBeenCalledTimes(1)
    expect(h.deps.enqueueImportJob).toHaveBeenCalledWith(h.job.id)
    expect(h.deps.mapImportJobRow).toHaveBeenCalledWith(expect.objectContaining({
      punch_preview_version: null, idempotency_key: 'preview-original', payload: expect.objectContaining({ previewResult: null, __jobType: 'preview' }),
    }))
  })
  it('replay returns the original key and verified result without token or enqueue', async () => {
    const h = harness(true); h.deps.requireImportCommitToken = true
    const { commitToken: _token, ...body } = h.body; await h.run(body)
    expect(h.deps.consumeImportCommitToken).not.toHaveBeenCalled()
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
    expect(h.deps.mapImportJobRow).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: 'preview-original', payload: expect.objectContaining({ previewResult: expect.objectContaining({ eventCount: 4, previewLimit: 2 }) }),
    }))
    expect(h.res.json).toHaveBeenCalledWith({ ok: true, data: { job: expect.anything(), idempotent: true } })
  })
  it('passes the owned transaction to required-token consumption', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true; await h.run()
    expect(h.deps.consumeImportCommitToken).toHaveBeenCalledWith('test-token', { db: h.client, orgId: h.access.orgId, userId: h.access.userId })
  })
  it('refuses required token before acknowledging or enqueueing', async () => {
    const h = harness(); h.deps.requireImportCommitToken = true; h.deps.consumeImportCommitToken.mockResolvedValue(false)
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(403)
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
    expect(h.deps.mapImportJobRow).not.toHaveBeenCalled()
  })
  it('propagates current target refusal without enqueueing', async () => {
    const h = harness(); h.deps.authorizePunchDetailPreview.mockResolvedValue(false); await h.run()
    expect(h.res.json).toHaveBeenCalledWith({ ok: false, error: { code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED', message: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' } })
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
  })
  it('reads as the current viewer while exposing the original verified frozen result', async () => {
    const h = harness(true)
    await h.producer().handlePreviewJobRead({ attendanceImportAccess: { ...h.access, userId: 'other-viewer' } }, h.res, h.job.id)
    expect(h.port.readPunchDetailPreviewJob).toHaveBeenCalledWith({ jobId: h.job.id, scope: { orgId: h.access.orgId,
      actorId: 'other-viewer', tokenSubjectUserId: 'other-viewer', actorPosture: 'attendance_admin' } }, h.deps.authorizePunchDetailPreview)
    expect(h.deps.enqueueImportJob).not.toHaveBeenCalled()
    expect(h.deps.mapImportJobRow).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ previewResult: h.result.record.preview }) }))
  })
  it('does not expose a missing or unauthorized job', async () => {
    const h = harness(); h.port.readPunchDetailPreviewJob.mockResolvedValue(null)
    await h.producer().handlePreviewJobRead({ attendanceImportAccess: h.access }, h.res, h.job.id)
    expect(h.res.status).toHaveBeenCalledWith(404)
    expect(h.deps.mapImportJobRow).not.toHaveBeenCalled()
  })
})

const { createAttendancePunchDetailPreviewAuthorizerV1: authorizer } = require('../../../../../plugins/plugin-attendance/lib/attendance-punch-detail-preview-authorizer.cjs') as {
  createAttendancePunchDetailPreviewAuthorizerV1(deps: Record<string, unknown>): (client: unknown, input: unknown) => Promise<boolean>
}
describe('preview current scoped-policy adapter', () => {
  function policy(full = false) {
    const fixture = punchDetailPreparationFixture()
    const client = { transaction: 'owned' }
    const actor = { userId: fixture.scope.actorId }; const scopes = [{ id: 'current-scope' }]; const facts = { userId: fixture.envelope.__punchDetailInput.userId }
    const deps = { logger: {}, createRbacHelpers: vi.fn(() => ({ hasAttendanceAdminAccess: vi.fn(async () => full), hasAttendanceImportAccess: vi.fn(async () => false) })),
      loadAttendanceScopeContextForUser: vi.fn(async () => actor), loadActiveAttendanceSchedulerScopesForActor: vi.fn(async () => scopes),
      resolveAttendanceUserSchedulerScopeFacts: vi.fn(async () => facts), attendanceSchedulerScopeAllowsActorActionFacts: vi.fn(() => true) }
    return { fixture, client, actor, scopes, facts, deps, run: () => authorizer(deps)(client, fixture) }
  }
  it('rechecks full permission on the supplied transaction', async () => {
    const h = policy(true); expect(await h.run()).toBe(true)
    expect(h.deps.createRbacHelpers).toHaveBeenCalledWith(h.client, h.deps.logger)
    expect(h.deps.loadAttendanceScopeContextForUser).not.toHaveBeenCalled()
  })
  it('passes original actor, scope, action and dated target facts through existing predicates', async () => {
    const h = policy(); expect(await h.run()).toBe(true)
    expect(h.deps.loadAttendanceScopeContextForUser).toHaveBeenCalledWith(h.client, h.fixture.scope.orgId, h.fixture.scope.actorId, { strictSources: true })
    expect(h.deps.loadActiveAttendanceSchedulerScopesForActor).toHaveBeenCalledWith(h.fixture.scope.orgId, h.actor, h.client)
    expect(h.deps.resolveAttendanceUserSchedulerScopeFacts).toHaveBeenCalledWith(h.client, h.fixture.scope.orgId, h.facts.userId, { workDate: h.fixture.envelope.__punchDetailInput.workDate })
    expect(h.deps.attendanceSchedulerScopeAllowsActorActionFacts).toHaveBeenCalledWith(h.scopes[0], h.actor, 'import', h.facts)
  })
  it('refuses a revoked target match', async () => {
    const h = policy(); h.deps.attendanceSchedulerScopeAllowsActorActionFacts.mockReturnValue(false)
    expect(await h.run()).toBe(false)
  })
  it('propagates current facts read errors rather than treating them as permission', async () => {
    const h = policy(); const error = new Error('FACTS_UNAVAILABLE'); h.deps.resolveAttendanceUserSchedulerScopeFacts.mockRejectedValue(error)
    await expect(h.run()).rejects.toBe(error)
  })
})
