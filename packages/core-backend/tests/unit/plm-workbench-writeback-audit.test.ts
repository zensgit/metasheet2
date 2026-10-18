import { createHash } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlmPersonalBomWriteError } from '../../src/services/plm-personal-bom-write-wire'
import { usePinnedServer } from '../utils/pinned-server'

const LOGIN = `Bearer ${jwt.sign({ userId: 'owner-1', email: 'o@x', role: 'user' }, 'synthetic-route-key')}`
const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn(), assertAccess: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ query: vi.fn() }))
const dispatchMocks = vi.hoisted(() => ({ dispatchOperation: vi.fn() }))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: pgMocks.query }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'owner-1', tenantId: 'header-tenant-not-authority', role: 'admin' } as never
    req.authenticatedTenantId = 'tenant-a'
    req.verifiedTenantClaim = { kind: 'present', value: 'tenant-a' }
    next()
  },
}))
vi.mock('../../src/services/plm-personal-bom-write-http', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/plm-personal-bom-write-http')>(
    '../../src/services/plm-personal-bom-write-http',
  )
  return {
    ...actual,
    plmPersonalBomWriteService: () => ({ dispatchOperation: dispatchMocks.dispatchOperation }),
  }
})
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
import {
  beginDurableUnboundClassification,
  finishDurableUnboundClassification,
  rejectOther,
  succeedOnceThenReject,
  type DurableUnboundCall,
} from '../utils/plm-managed-unbound-classification'

const classificationCalls: DurableUnboundCall[] = []

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

const LINE_NATIVE = { ok: true, bom_line_id: 'R1' }
const ECO_NATIVE = { eco_id: 'ECO-1', state: 'progress', attached: true, source_version_id: 'v1', target_version_id: 'v2' }

describe('controlled BOM write-back is audited in MetaSheet', () => {
  const app = express()
  app.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = LOGIN
    next()
  })
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    beginDurableUnboundClassification(pgMocks.query, classificationCalls)
    dispatchMocks.dispatchOperation.mockReset()
    dispatchMocks.dispatchOperation.mockResolvedValue({ native: LINE_NATIVE })
    pinned.setApp(app)
  })

  afterEach(() => {
    finishDurableUnboundClassification(classificationCalls, 'ds-1')
  })

  it('line write-back commits an attempt row before dispatch and an accepted outcome after it', async () => {
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .set('If-Match', '"bom-line:abc"')
      .send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(LINE_NATIVE)
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
    expect(attempt.order).toBeLessThan(dispatchMocks.dispatchOperation.mock.invocationCallOrder[0])
    expect(outcome).toMatchObject({ actorId: 'owner-1', action: 'line_writeback_outcome', resourceId: attempt.resourceId, statusCode: 200 })
    expect(outcome.meta).toMatchObject({ attemptId: attempt.resourceId, outcome: 'accepted', statusCode: 200 })
    expect(outcome.order).toBeGreaterThan(dispatchMocks.dispatchOperation.mock.invocationCallOrder[0])
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(JSON.stringify(pgMocks.query.mock.calls)).not.toContain('submit-1')
  })

  it('fails closed when the attempt cannot be audited: 503 and dispatch is never called', async () => {
    rejectOther(pgMocks.query, classificationCalls, new Error('audit store unavailable'))
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-1').send({ quantity: 5 })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'PLM_WRITEBACK_AUDIT_UNAVAILABLE', reason: 'audit-unavailable', data_source_id: 'ds-1' })
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).not.toHaveBeenCalled()
  })

  it('records a received 412 as refused without turning it into an unknown outcome', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(new PlmPersonalBomWriteError(412, 'PLM_BOM_WRITE_PROVIDER', undefined, true))
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-2').send({ uom: 'PCS' })
    expect(res.status).toBe(412)
    expect(res.body.reason).toBe('precondition-failed')
    expect(res.body.code).toBe('PLM_BOM_WRITEBACK_FAILED')
    const [attempt, outcome] = auditRows()
    expect(attempt.meta).toMatchObject({ fields: ['uom'], patch: { uom: 'PCS' }, ifMatchPresent: false })
    expect(outcome).toMatchObject({ action: 'line_writeback_outcome', statusCode: 412 })
    expect(outcome.meta).toMatchObject({ outcome: 'refused', statusCode: 412, reason: 'precondition-failed' })
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
  })

  it('an incomplete native success is recorded as unknown, not accepted', async () => {
    dispatchMocks.dispatchOperation.mockResolvedValue({ native: { ok: true } })
    dsMocks.getDataSource.mockReturnValue(writeAdapter(vi.fn()))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-3').send({ quantity: 1 })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expect(auditRows()[1].meta).toMatchObject({ outcome: 'unknown', statusCode: 503, reason: 'unknown' })
  })

  it('an outcome audit failure never masks a committed native success', async () => {
    succeedOnceThenReject(pgMocks.query, classificationCalls, new Error('audit store lost'))
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    const res = await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'submit-4').send({ quantity: 2 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(LINE_NATIVE)
    expect(dispatchMocks.dispatchOperation).toHaveBeenCalledTimes(1)
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
  })

  it('requests refused before dispatch (missing key, unentitled, invalid patch) write no audit row', async () => {
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine))
    expect((await request(pinned.url()).patch(WRITE_URL).send({ quantity: 5 })).status).toBe(400)
    expect((await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'k').send({ applied: true })).status).toBe(400)
    dsMocks.getDataSource.mockReturnValue(writeAdapter(updateBomMultitableLine, { ...ENTITLED, entitled: false }))
    expect((await request(pinned.url()).patch(WRITE_URL).set('Idempotency-Key', 'k').send({ quantity: 5 })).status).toBe(403)
    expect(auditRows()).toEqual([])
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).not.toHaveBeenCalled()
  })

  it('ECO revision intent commits an attempt before dispatch and records the accepted ECO after it', async () => {
    dispatchMocks.dispatchOperation.mockResolvedValue({ native: ECO_NATIVE })
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter(requestBomEcoRevisionIntent))
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-submit-1')
    expect(res.status).toBe(200)
    const [attempt, outcome] = auditRows()
    expect(attempt).toMatchObject({ actorId: 'owner-1', action: 'eco_intent_attempt', resourceType: 'plm-bom-writeback', statusCode: 0 })
    expect(attempt.meta).toEqual({
      attemptId: attempt.resourceId,
      dataSourceId: 'ds-1',
      partId: 'P1',
      idempotencyKeySha256: sha256('eco-submit-1'),
    })
    expect(attempt.order).toBeLessThan(dispatchMocks.dispatchOperation.mock.invocationCallOrder[0])
    expect(outcome).toMatchObject({ action: 'eco_intent_outcome', resourceId: attempt.resourceId, statusCode: 200 })
    expect(outcome.meta).toMatchObject({ outcome: 'accepted', ecoId: 'ECO-1', ecoState: 'progress', attached: true })
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
    expect(JSON.stringify(pgMocks.query.mock.calls)).not.toContain('eco-submit-1')
  })

  it('ECO revision intent fails closed when the attempt cannot be audited', async () => {
    rejectOther(pgMocks.query, classificationCalls, new Error('audit store unavailable'))
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter(requestBomEcoRevisionIntent))
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-submit-1')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'PLM_WRITEBACK_AUDIT_UNAVAILABLE', reason: 'audit-unavailable' })
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).not.toHaveBeenCalled()
  })
})
