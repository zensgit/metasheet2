import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlmPersonalBomWriteError } from '../../src/services/plm-personal-bom-write-wire'
import { usePinnedServer } from '../utils/pinned-server'

const LOGIN = `Bearer ${jwt.sign({ userId: 'owner-1', email: 'o@x', role: 'user' }, 'synthetic-route-key')}`

// Controllable DataSourceManager mock (configured per test).
// `assertAccess` models the real manager's per-user ownership gate; the default no-op stands for
// "the authenticated fixture user owns this source", which is the premise of every test here.
// Ownership DENIAL itself is proven against the REAL DataSourceManager in
// plm-workbench-datasource-ownership.test.ts, not against this stub.
const dsMocks = vi.hoisted(() => ({
  getDataSource: vi.fn(),
  assertAccess: vi.fn(),
}))
const dispatchMocks = vi.hoisted(() => ({
  dispatchOperation: vi.fn(),
}))
const pgMocks = vi.hoisted(() => ({ query: vi.fn() }))

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
  getDataSourceManager: () => ({
    getDataSource: dsMocks.getDataSource,
    assertAccess: dsMocks.assertAccess,
  }),
}))

import plmWorkbenchRouter from '../../src/routes/plm-workbench'
import {
  beginDurableUnboundClassification,
  finishDurableUnboundClassification,
  type DurableUnboundCall,
} from '../utils/plm-managed-unbound-classification'

const classificationCalls: DurableUnboundCall[] = []

beforeEach(() => {
  beginDurableUnboundClassification(pgMocks.query, classificationCalls)
})

afterEach(() => {
  finishDurableUnboundClassification(classificationCalls, 'ds-1')
})

const CONTEXT = {
  part: { part_id: 'P1', item_number: 'P-001', name: 'Assembly', state: 'Released', generation: 3 },
  lines: [
    { bom_line_id: 'R1', part_id: 'C1', item_number: 'C-001', name: 'Bracket', state: 'Draft', generation: 1, quantity: 2, uom: 'EA', find_num: '10', refdes: 'R1,R2', level: 1, path: ['P1'], path_labels: ['P-001'], source_version: 1, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
  ],
  source_version: 3,
  source_updated_at: '2026-06-05T00:00:00',
  sync_status: 'snapshot',
  template_key: 'bom_review',
}

const manifest = (
  bom: Record<string, unknown> | undefined,
  extraFeatures: Record<string, Record<string, unknown>> = {},
) => ({
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: {
    approval_automation: { supported: true, api_version: 'v1', entitled: true },
    ...(bom ? { bom_multitable: bom } : {}),
    ...extraFeatures,
  },
})

const URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/context'
const WRITE_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/lines/R1'

const LINE_NATIVE = { ok: true, bom_line_id: 'R1' }
const ECO_NATIVE = { eco_id: 'ECO-1', state: 'progress', attached: false, source_version_id: 'v1', target_version_id: 'v2' }
const pinned = usePinnedServer()

function withLogin(app: express.Express): express.Express {
  app.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = LOGIN
    next()
  })
  return app
}

describe('plm-workbench BOM multi-table review route (PLM-COLLAB P3-C)', () => {
  const app = withLogin(express())
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    dispatchMocks.dispatchOperation.mockReset()
    dispatchMocks.dispatchOperation.mockResolvedValue({ native: LINE_NATIVE })
    pinned.setApp(app)
  })

  it('returns 404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => {
      throw new Error('Data source not found: nope')
    })
    const res = await request(pinned.url()).get('/api/plm-workbench/data-sources/nope/bom-multitable/P1/context')
    expect(res.status).toBe(404)
    expect(res.body.data_source_id).toBe('nope')
  })

  it('degrades to unsupported-mode for an adapter lacking the BOM method (no data call)', async () => {
    // has the capability handshake but NOT getBomMultitableContext -> guard requires both.
    const getIntegrationCapabilities = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported-mode' })
    expect(getIntegrationCapabilities).not.toHaveBeenCalled()
  })

  it('degrades to unavailable (not 500) if the capability call throws', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockRejectedValue(new Error('boom')),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unavailable' })
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('hides the surface (unsupported) when bom_multitable is not supported, WITHOUT querying', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(undefined) }),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported' })
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('supported-but-not-entitled -> entitled:false + null context WITHOUT querying the resource', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest({ supported: true, api_version: 'v1', entitled: false }),
      }),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: false, context: null })
    // the resource is NEVER queried when the advisory manifest says unentitled
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('supported + entitled -> queries and passes through the read-only context', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({
      feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT,
    })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest({ supported: true, api_version: 'v1', entitled: true, scenarios: ['bom_review'] }),
      }),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: CONTEXT })
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  // #4020: the route is re-keyed through isFeatureAvailable, which consumes the manifest's
  // `available` field DIRECTLY when the provider sends it, instead of the old raw `entitled`
  // check. A supported-but-unentitled feature the provider marks `available: true` (the
  // base-packaged shape, e.g. discussion_core) must proceed to query -- proving this branch no
  // longer hides on `entitled` alone.
  it('#4020: supported + entitled:false + available:true (base-packaged shape) -> queries the resource', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({
      feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT,
    })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest({ supported: true, api_version: 'v1', entitled: false, available: true }),
      }),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: CONTEXT })
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  // Symmetric edge-state check: `available` wins even in the direction old code would have
  // let through -- an `available: false` manifest entry blocks the query WITHOUT consulting
  // `entitled` at all, confirming the route never re-derives visibility from raw `entitled`
  // once the provider sends `available`.
  it('#4020: supported + entitled:true but available:false -> unentitled affordance WITHOUT querying', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest({ supported: true, api_version: 'v1', entitled: true, available: false }),
      }),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: false, context: null })
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('reflects the provider gate: entitled manifest but provider returns unentitled -> null context', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({
      feature_key: 'bom_multitable', entitled: false, upgrade: { available: true }, context: null,
    })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest({ supported: true, api_version: 'v1', entitled: true }),
      }),
      getBomMultitableContext,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: false, context: null })
  })

  it('degrades (not 500) if the entitled data call throws', async () => {
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest({ supported: true, api_version: 'v1', entitled: true }),
      }),
      getBomMultitableContext: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: null, reason: 'unavailable' })
  })

  it('write route requires a write-capable adapter', async () => {
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn(),
      getBomMultitableContext: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(404)
    expect(res.body.reason).toBeUndefined()
  })

  it('write route pre-checks bom_multitable_writeback entitlement and does not call the provider when unentitled', async () => {
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: false } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine,
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('not-entitled')
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).not.toHaveBeenCalled()
  })

  // #4020: the write gate is re-keyed through isFeatureAvailable too -- an entitled:false
  // entry that the provider marks available:true (base-packaged shape) must be let through,
  // proving this branch no longer reads raw `entitled` directly.
  it('#4020: write route lets an entitled:false + available:true bom_multitable_writeback entry through', async () => {
    const updateBomMultitableLine = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R1' }] })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: false, available: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine,
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(LINE_NATIVE)
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).toHaveBeenCalledTimes(1)
  })

  it('write route rejects a missing Idempotency-Key before calling the provider', async () => {
    const updateBomMultitableLine = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine,
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .send({ quantity: 5 })
    expect(res.status).toBe(400)
    expect(res.body.reason).toBe('missing-idempotency-key')
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).not.toHaveBeenCalled()
  })

  it('write route forwards whitelisted patch cells with the caller-owned Idempotency-Key', async () => {
    const updateBomMultitableLine = vi.fn().mockResolvedValue({
      data: [{ ok: true, bom_line_id: 'R1' }],
    })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine,
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5, refdes: null, applied: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(LINE_NATIVE)
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).toHaveBeenCalledWith(
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
      {
        operationKind: 'line',
        partId: 'P1',
        bomLineId: 'R1',
        clientKey: 'submit-1',
        patch: { quantity: 5, refdes: null },
      },
    )
  })

  it('write route reports an allowlist-miss native 409 as unknown and does not call the shared adapter', async () => {
    const updateBomMultitableLine = vi.fn()
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', undefined, true),
    )
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine,
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expect(res.body.code).toBe('PLM_BOM_WRITEBACK_FAILED')
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
  })

  // ECO Phase 0: the provider 409 is discriminated by detail.code (lifecycle_locked vs
  // idempotency_conflict); the relay surfaces the code as the reason instead of flattening.
  // A bodyless or unknown-code 409 still flattens to 'provider-rejected' (test above).
  it('write route surfaces a discriminated lifecycle_locked 409 reason', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'lifecycle_locked', message: "Item is locked in state 'Released'" }, true),
    )
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('lifecycle_locked')
  })

  it('write route surfaces a discriminated idempotency_conflict 409 reason', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'idempotency_conflict' }, true),
    )
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('idempotency_conflict')
  })

  it('write route reports an unknown native 409 code as unknown and does not leak the message', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'some_future_code', message: 'new provider semantics' }, true),
    )
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expect(res.body.code).toBe('PLM_BOM_WRITEBACK_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('some_future_code')
    expect(JSON.stringify(res.body)).not.toContain('new provider semantics')
  })

  it('write route forwards the client If-Match header to the provider (optimistic concurrency)', async () => {
    const updateBomMultitableLine = vi.fn().mockResolvedValue({ data: [{ ok: true, bom_line_id: 'R1' }] })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine,
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .set('If-Match', '"bom-line:etag-x"')
      .send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).toHaveBeenCalledWith(
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
      {
        operationKind: 'line',
        partId: 'P1',
        bomLineId: 'R1',
        clientKey: 'submit-1',
        patch: { quantity: 5 },
        ifMatch: '"bom-line:etag-x"',
      },
    )
  })

  it('write route relays a provider 412 as a distinct precondition-failed conflict', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(412, 'PLM_BOM_WRITE_PROVIDER', undefined, true),
    )
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn(),
    })
    const res = await request(pinned.url())
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .set('If-Match', '"bom-line:stale"')
      .send({ quantity: 5 })
    expect(res.status).toBe(412)
    expect(res.body.reason).toBe('precondition-failed')
  })
})

// ── ECO Phase 3: locked-BOM revision-intent relay ────────────────────────────────────────────
const INTENT_URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/eco-intent'

const BOM_ENTITLED = { supported: true, api_version: 'v1', entitled: true }
const ECO_INTENT_FEATURE = {
  supported: true,
  api_version: 'v1',
  entitled: true,
  actions: ['eco_revision_intent'],
  action_status: 'governed',
}

function intentAdapter(overrides: Record<string, unknown> = {}) {
  return {
    getIntegrationCapabilities: vi.fn().mockResolvedValue({
      available: true,
      manifest: manifest(BOM_ENTITLED, { bom_eco_revision: ECO_INTENT_FEATURE }),
    }),
    getBomMultitableContext: vi.fn(),
    requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({
      data: [{ eco_id: 'ECO-1', state: 'progress', attached: false, source_version_id: 'v1', target_version_id: 'v2' }],
    }),
    ...overrides,
  }
}

describe('plm-workbench BOM ECO revision-intent relay (ECO Phase 3)', () => {
  const app = withLogin(express())
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    dsMocks.assertAccess.mockReset()
    dispatchMocks.dispatchOperation.mockReset()
    dispatchMocks.dispatchOperation.mockResolvedValue({ native: ECO_NATIVE })
    pinned.setApp(app)
  })

  it('404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => { throw new Error('nope') })
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(404)
  })

  it('404 for an adapter lacking requestBomEcoRevisionIntent (duck-type, no capability call)', async () => {
    const getIntegrationCapabilities = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities, getBomMultitableContext: vi.fn() })
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(404)
    expect(getIntegrationCapabilities).not.toHaveBeenCalled()
  })

  it('503 unavailable (never 500) when the capability call throws; intent never called', async () => {
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      getIntegrationCapabilities: vi.fn().mockRejectedValue(new Error('boom')),
      requestBomEcoRevisionIntent,
    }))
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unavailable')
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  it('404 unsupported when bom_eco_revision is absent from the manifest; intent never called', async () => {
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(BOM_ENTITLED) }),
      requestBomEcoRevisionIntent,
    }))
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(404)
    expect(res.body.reason).toBe('unsupported')
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  it('403 not-entitled when supported but unentitled; intent never called', async () => {
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(BOM_ENTITLED, { bom_eco_revision: { ...ECO_INTENT_FEATURE, entitled: false } }),
      }),
      requestBomEcoRevisionIntent,
    }))
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('not-entitled')
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  // #4020: the intent gate is re-keyed through isFeatureAvailable too -- an entitled:false
  // entry the provider marks available:true (base-packaged shape) must be let through.
  it('#4020: intent route lets an entitled:false + available:true bom_eco_revision entry through', async () => {
    const requestBomEcoRevisionIntent = vi.fn().mockResolvedValue({
      data: [{ eco_id: 'ECO-2', state: 'progress', attached: false, source_version_id: 'v1', target_version_id: 'v2' }],
    })
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(BOM_ENTITLED, {
          bom_eco_revision: { ...ECO_INTENT_FEATURE, entitled: false, available: true },
        }),
      }),
      requestBomEcoRevisionIntent,
    }))
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(ECO_NATIVE)
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).toHaveBeenCalledWith(
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
      { operationKind: 'eco-intent', partId: 'P1', clientKey: 'eco-1' },
    )
  })

  it('404 unsupported when the descriptor omits the eco_revision_intent action; intent never called', async () => {
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(BOM_ENTITLED, { bom_eco_revision: { ...ECO_INTENT_FEATURE, actions: [] } }),
      }),
      requestBomEcoRevisionIntent,
    }))
    const res = await request(pinned.url()).post(INTENT_URL)
    expect(res.status).toBe(404)
    expect(res.body.reason).toBe('unsupported')
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  it('relays the personal success envelope and does not call the shared adapter', async () => {
    const adapter = intentAdapter()
    dsMocks.getDataSource.mockReturnValue(adapter)
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1').set('If-Match', '"etag"').send({ bomLineId: 'R1', patch: { quantity: 1 } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(ECO_NATIVE)
    expect(adapter.requestBomEcoRevisionIntent).not.toHaveBeenCalled()
    expect(dispatchMocks.dispatchOperation).toHaveBeenCalledWith(
      { userId: 'owner-1', metaTenantId: 'tenant-a' },
      'ds-1',
      { operationKind: 'eco-intent', partId: 'P1', clientKey: 'eco-1' },
    )
  })

  it('surfaces the discriminated not_locked 409 reason', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'not_locked' }, true),
    )
    dsMocks.getDataSource.mockReturnValue(intentAdapter())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('not_locked')
    expect(res.body.code).toBe('PLM_ECO_INTENT_FAILED')
  })

  it('surfaces the discriminated eco_intent_rejected 409 reason', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'eco_intent_rejected' }, true),
    )
    dsMocks.getDataSource.mockReturnValue(intentAdapter())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('eco_intent_rejected')
  })

  it('reports a wrong-namespace 409 as unknown and does not leak the message', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(409, 'PLM_BOM_WRITE_PROVIDER', { code: 'lifecycle_locked', message: 'wrong namespace' }, true),
    )
    dsMocks.getDataSource.mockReturnValue(intentAdapter())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expect(res.body.code).toBe('PLM_ECO_INTENT_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('wrong namespace')
    expect(JSON.stringify(res.body)).not.toContain('lifecycle_locked')
  })

  it('passes through a received provider 403 as provider-rejected', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(
      new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_PROVIDER', undefined, true),
    )
    dsMocks.getDataSource.mockReturnValue(intentAdapter())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('provider-rejected')
    expect(res.body.code).toBe('PLM_ECO_INTENT_FAILED')
    expect(res.body.attempt_outcome).toBe('refused')
    expect(res.body.operation_may_have_applied).toBe(true)
    expect(res.body.retry_policy).toBe('same-operation')
  })

  it('reports a transport error with no native receipt as unknown', async () => {
    dispatchMocks.dispatchOperation.mockRejectedValue(new Error('ECONNREFUSED'))
    dsMocks.getDataSource.mockReturnValue(intentAdapter())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expect(res.body.code).toBe('PLM_ECO_INTENT_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED')
  })

  it('reports an incomplete native success as unknown', async () => {
    dispatchMocks.dispatchOperation.mockResolvedValue({ native: { eco_id: 'ECO-1' } })
    dsMocks.getDataSource.mockReturnValue(intentAdapter())
    const res = await request(pinned.url()).post(INTENT_URL).set('Idempotency-Key', 'eco-1')
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('unknown')
    expect(res.body.code).toBe('PLM_ECO_INTENT_FAILED')
  })
})
