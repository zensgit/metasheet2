import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn(), assertAccess: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: pgMocks.query }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'owner-1', tenantId: 'tenant-a' } as never
    next()
  },
}))
vi.mock('../../src/middleware/validation', () => ({
  validate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))
vi.mock('../../src/types/validator', () => ({
  loadValidators: () => {
    const makeChain = () => {
      const chain = ((
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) => next()) as express.RequestHandler & Record<string, () => express.RequestHandler>
      chain.optional = () => chain
      chain.isString = () => chain
      chain.notEmpty = () => chain
      chain.exists = () => chain
      chain.isObject = () => chain
      return chain
    }
    return { body: () => makeChain(), param: () => makeChain(), query: () => makeChain() }
  },
}))
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource, assertAccess: dsMocks.assertAccess }),
}))

import plmWorkbenchRouter from '../../src/routes/plm-workbench'

const WRITE_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/lines/R1'
const INTENT_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/eco-intent'
const ENTITLED = { supported: true, api_version: 'v1', entitled: true }

function capabilities(features: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    available: true,
    manifest: { schema_version: 'v1', provider: 'yuantus-plm', advisory: true, features: { bom_multitable: ENTITLED, ...features } },
  })
}

function writeAdapter(updateBomMultitableLine: ReturnType<typeof vi.fn>, writeback: Record<string, unknown> = ENTITLED) {
  return {
    getIntegrationCapabilities: capabilities({ bom_multitable_writeback: writeback }),
    getBomMultitableContext: vi.fn(),
    updateBomMultitableLine,
  }
}

function intentAdapter(requestBomEcoRevisionIntent: ReturnType<typeof vi.fn>) {
  return {
    getIntegrationCapabilities: capabilities({
      bom_eco_revision: { ...ENTITLED, actions: ['eco_revision_intent'], action_status: 'governed' },
    }),
    getBomMultitableContext: vi.fn(),
    requestBomEcoRevisionIntent,
  }
}

type AuditRow = { actorId: unknown; action: unknown; resourceType: unknown; resourceId: unknown; route: unknown; statusCode: unknown; meta: Record<string, unknown>; order: number }

function auditRows(): AuditRow[] {
  return pgMocks.query.mock.calls.flatMap((call, index) => {
    const [sql, params] = call as [string, unknown[]]
    if (!String(sql).includes('INSERT INTO operation_audit_logs')) return []
    return [{
      actorId: params[0], action: params[1], resourceType: params[2], resourceId: params[3],
      route: params[5], statusCode: params[6], meta: JSON.parse(String(params[7])),
      order: pgMocks.query.mock.invocationCallOrder[index],
    }]
  })
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const pinned = usePinnedServer()

describe('controlled BOM write-back is audited in MetaSheet', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    pgMocks.query.mockReset()
    pgMocks.query.mockResolvedValue({ rows: [], rowCount: 1 })
    pinned.setApp(app)
  })

  it('line write-back commits an attempt row before the provider call and an accepted outcome after it', async () => {
    const updateBomMultitableLine = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R1' }] })
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .set('If-Match', '"bom-line:abc"')
      .send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, bom_line_id: 'R1' })
    const [attempt, outcome] = auditRows()
    expect(auditRows()).toHaveLength(2)
    expect(attempt).toMatchObject({
      actorId: 'owner-1', action: 'line_writeback_attempt', resourceType: 'plm-bom-writeback',
      route: '/api/plm-workbench/data-sources/:id/bom-multitable/:partId/lines/:bomLineId', statusCode: 0,
    })
    expect(attempt.meta).toEqual({
      attemptId: attempt.resourceId, dataSourceId: 'ds-1', partId: 'P1', bomLineId: 'R1',
      fields: ['quantity'], patch: { quantity: 5 }, idempotencyKeySha256: sha256('submit-1'), ifMatchPresent: true,
    })
    expect(attempt.order).toBeLessThan(updateBomMultitableLine.mock.invocationCallOrder[0])
    expect(outcome).toMatchObject({ actorId: 'owner-1', action: 'line_writeback_outcome', resourceId: attempt.resourceId, statusCode: 200 })
    expect(outcome.meta).toMatchObject({ attemptId: attempt.resourceId, outcome: 'accepted', statusCode: 200 })
    expect(outcome.order).toBeGreaterThan(updateBomMultitableLine.mock.invocationCallOrder[0])
    expect(JSON.stringify(pgMocks.query.mock.calls)).not.toContain('submit-1')
  })

  it('fails closed when the attempt cannot be audited: 503 and the provider is never called', async () => {
    pgMocks.query.mockRejectedValue(new Error('audit store unavailable'))
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'PLM_WRITEBACK_AUDIT_UNAVAILABLE', reason: 'audit-unavailable', data_source_id: 'ds-1' })
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
  })

  it('records a provider refusal with the relayed status and reason, leaving the response unchanged', async () => {
    const stale = Object.assign(new Error('If-Match precondition failed'), { response: { status: 412 } })
    dsMocks.getDataSource.mockReturnValue(writeAdapter(vi.fn().mockResolvedValue({ data: [], error: stale })))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-2').send({ uom: 'PCS' })
    expect(res.status).toBe(412)
    expect(res.body.reason).toBe('precondition-failed')
    const [attempt, outcome] = auditRows()
    expect(attempt.meta).toMatchObject({ fields: ['uom'], patch: { uom: 'PCS' }, ifMatchPresent: false })
    expect(outcome).toMatchObject({ action: 'line_writeback_outcome', statusCode: 412 })
    expect(outcome.meta).toMatchObject({ outcome: 'refused', statusCode: 412, reason: 'precondition-failed' })
  })

  it('a malformed provider success is recorded as malformed, not accepted', async () => {
    dsMocks.getDataSource.mockReturnValue(writeAdapter(vi.fn().mockResolvedValue({ data: [{ ok: true }] })))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-3').send({ quantity: 1 })
    expect(res.status).toBe(502)
    expect(auditRows()[1].meta).toMatchObject({ outcome: 'malformed', statusCode: 502, reason: 'malformed-response' })
  })

  it('an outcome audit failure never masks the provider result', async () => {
    pgMocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockRejectedValueOnce(new Error('audit store lost'))
    const updateBomMultitableLine = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R1' }] })
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-4').send({ quantity: 2 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, bom_line_id: 'R1' })
    expect(updateBomMultitableLine).toHaveBeenCalledTimes(1)
  })

  it('requests refused before the provider (missing key, unentitled, invalid patch) write no audit row', async () => {
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    expect((await request(pinned.url()).patch(WRITE_URL).send({ quantity: 5 })).status).toBe(400)
    expect((await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'k').send({ applied: true })).status).toBe(400)
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine, { ...ENTITLED, entitled: false }))
    expect((await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'k').send({ quantity: 5 })).status).toBe(403)
    expect(auditRows()).toEqual([])
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
  })

  it('ECO revision intent commits an attempt before the provider call and records the accepted ECO after it', async () => {
    const requestBomEcoRevisionIntent = vi.fn().mockResolvedValue({
      data: [{ eco_id: 'ECO-1', state: 'progress', attached: true, source_version_id: 'v1', target_version_id: 'v2' }],
    })
    dsMocks.getDataSource.mockReturnValue(intentAdapter(requestBomEcoRevisionIntent))
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(200)
    const [attempt, outcome] = auditRows()
    expect(attempt).toMatchObject({ actorId: 'owner-1', action: 'eco_intent_attempt', resourceType: 'plm-bom-writeback', statusCode: 0 })
    expect(attempt.meta).toEqual({ attemptId: attempt.resourceId, dataSourceId: 'ds-1', partId: 'P1' })
    expect(attempt.order).toBeLessThan(requestBomEcoRevisionIntent.mock.invocationCallOrder[0])
    expect(outcome).toMatchObject({ action: 'eco_intent_outcome', resourceId: attempt.resourceId, statusCode: 200 })
    expect(outcome.meta).toMatchObject({ outcome: 'accepted', ecoId: 'ECO-1', ecoState: 'progress', attached: true })
  })

  it('ECO revision intent fails closed when the attempt cannot be audited', async () => {
    pgMocks.query.mockRejectedValue(new Error('audit store unavailable'))
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter(requestBomEcoRevisionIntent))
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'PLM_WRITEBACK_AUDIT_UNAVAILABLE', reason: 'audit-unavailable' })
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })
})
