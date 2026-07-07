import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable DataSourceManager.getDataSource mock (configured per test).
const dsMocks = vi.hoisted(() => ({
  getDataSource: vi.fn(),
}))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: vi.fn() }))
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
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource }),
}))

import plmWorkbenchRouter from '../../src/routes/plm-workbench'

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

describe('plm-workbench BOM multi-table review route (PLM-COLLAB P3-C)', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
  })

  it('returns 404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => {
      throw new Error('Data source not found: nope')
    })
    const res = await request(app).get('/api/plm-workbench/data-sources/nope/bom-multitable/P1/context')
    expect(res.status).toBe(404)
    expect(res.body.data_source_id).toBe('nope')
  })

  it('degrades to unsupported-mode for an adapter lacking the BOM method (no data call)', async () => {
    // has the capability handshake but NOT getBomMultitableContext -> guard requires both.
    const getIntegrationCapabilities = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities })
    const res = await request(app).get(URL)
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
    const res = await request(app).get(URL)
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
    const res = await request(app).get(URL)
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
    const res = await request(app).get(URL)
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
    const res = await request(app).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: CONTEXT })
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
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
    const res = await request(app).get(URL)
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
    const res = await request(app).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: null, reason: 'unavailable' })
  })

  it('write route requires a write-capable adapter', async () => {
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn(),
      getBomMultitableContext: vi.fn(),
    })
    const res = await request(app)
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
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('not-entitled')
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
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
    const res = await request(app)
      .patch(WRITE_URL)
      .send({ quantity: 5 })
    expect(res.status).toBe(400)
    expect(res.body.reason).toBe('missing-idempotency-key')
    expect(updateBomMultitableLine).not.toHaveBeenCalled()
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
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5, refdes: null, applied: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, bom_line_id: 'R1' })
    expect(updateBomMultitableLine).toHaveBeenCalledWith(
      'P1',
      'R1',
      { quantity: 5, refdes: null },
      { idempotencyKey: 'submit-1' },
    )
  })

  it('write route relays provider 409 conflicts as actionable failures', async () => {
    const conflict = Object.assign(new Error('locked'), { response: { status: 409 } })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: conflict }),
    })
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('provider-rejected')
  })

  // ECO Phase 0: the provider 409 is discriminated by detail.code (lifecycle_locked vs
  // idempotency_conflict); the relay surfaces the code as the reason instead of flattening.
  // A bodyless or unknown-code 409 still flattens to 'provider-rejected' (test above).
  it('write route surfaces a discriminated lifecycle_locked 409 reason', async () => {
    const locked = Object.assign(new Error('Request failed with status code 409'), {
      response: {
        status: 409,
        data: {
          detail: {
            code: 'lifecycle_locked',
            message: "Item is locked in state 'Released'",
            state: 'Released',
            eco_required: true,
          },
        },
      },
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
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: locked }),
    })
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('lifecycle_locked')
  })

  it('write route surfaces a discriminated idempotency_conflict 409 reason', async () => {
    const burned = Object.assign(new Error('Request failed with status code 409'), {
      response: {
        status: 409,
        data: {
          detail: {
            code: 'idempotency_conflict',
            message: 'Idempotency-Key reused for a different write',
          },
        },
      },
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
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: burned }),
    })
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('idempotency_conflict')
  })

  it('write route flattens an unknown discriminated 409 code to provider-rejected (forward-compat)', async () => {
    const future = Object.assign(new Error('Request failed with status code 409'), {
      response: {
        status: 409,
        data: { detail: { code: 'some_future_code', message: 'new provider semantics' } },
      },
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
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: future }),
    })
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .send({ quantity: 5 })
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('provider-rejected')
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
    const res = await request(app)
      .patch(WRITE_URL)
      .set('Idempotency-Key', 'submit-1')
      .set('If-Match', '"bom-line:etag-x"')
      .send({ quantity: 5 })
    expect(res.status).toBe(200)
    expect(updateBomMultitableLine).toHaveBeenCalledWith(
      'P1',
      'R1',
      { quantity: 5 },
      { idempotencyKey: 'submit-1', ifMatch: '"bom-line:etag-x"' },
    )
  })

  it('write route relays a provider 412 as a distinct precondition-failed conflict', async () => {
    const stale = Object.assign(new Error('If-Match precondition failed'), { response: { status: 412 } })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({
        available: true,
        manifest: manifest(
          { supported: true, api_version: 'v1', entitled: true },
          { bom_multitable_writeback: { supported: true, api_version: 'v1', entitled: true } },
        ),
      }),
      getBomMultitableContext: vi.fn(),
      updateBomMultitableLine: vi.fn().mockResolvedValue({ data: [], error: stale }),
    })
    const res = await request(app)
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
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
  })

  it('404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => { throw new Error('nope') })
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(404)
  })

  it('404 for an adapter lacking requestBomEcoRevisionIntent (duck-type, no capability call)', async () => {
    const getIntegrationCapabilities = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities, getBomMultitableContext: vi.fn() })
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(404)
    expect(getIntegrationCapabilities).not.toHaveBeenCalled()
  })

  it('503 unavailable (never 500) when the capability call throws; intent never called', async () => {
    const requestBomEcoRevisionIntent = vi.fn()
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      getIntegrationCapabilities: vi.fn().mockRejectedValue(new Error('boom')),
      requestBomEcoRevisionIntent,
    }))
    const res = await request(app).post(INTENT_URL)
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
    const res = await request(app).post(INTENT_URL)
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
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('not-entitled')
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
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
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(404)
    expect(res.body.reason).toBe('unsupported')
    expect(requestBomEcoRevisionIntent).not.toHaveBeenCalled()
  })

  it('relays the provider success envelope (eco_id/state/attached) verbatim', async () => {
    const adapter = intentAdapter()
    dsMocks.getDataSource.mockReturnValue(adapter)
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      eco_id: 'ECO-1', state: 'progress', attached: false, source_version_id: 'v1', target_version_id: 'v2',
    })
    expect(adapter.requestBomEcoRevisionIntent).toHaveBeenCalledWith('P1')
  })

  it('surfaces the discriminated not_locked 409 reason', async () => {
    const notLocked = Object.assign(new Error('409'), {
      response: { status: 409, data: { detail: { code: 'not_locked', message: 'editable' } } },
    })
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [], error: notLocked }),
    }))
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('not_locked')
  })

  it('surfaces the discriminated eco_intent_rejected 409 reason', async () => {
    const rejected = Object.assign(new Error('409'), {
      response: { status: 409, data: { detail: { code: 'eco_intent_rejected', message: 'race' } } },
    })
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [], error: rejected }),
    }))
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('eco_intent_rejected')
  })

  it('degrades an UNKNOWN 409 code to provider-rejected (fail-closed, never leaks raw)', async () => {
    const weird = Object.assign(new Error('409'), {
      response: { status: 409, data: { detail: { code: 'lifecycle_locked', message: 'wrong namespace' } } },
    })
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [], error: weird }),
    }))
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('provider-rejected')
  })

  it('passes through a provider 403 as provider-rejected (entitlement drift at the provider)', async () => {
    const forbidden = Object.assign(new Error('403'), { response: { status: 403, data: { detail: 'nope' } } })
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [], error: forbidden }),
    }))
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('provider-rejected')
  })

  it('502 provider-unavailable for a transport error with no response', async () => {
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [], error: new Error('ECONNREFUSED') }),
    }))
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(502)
    expect(res.body.reason).toBe('provider-unavailable')
  })

  it('502 malformed-response when the provider payload lacks the contract keys', async () => {
    dsMocks.getDataSource.mockReturnValue(intentAdapter({
      requestBomEcoRevisionIntent: vi.fn().mockResolvedValue({ data: [{ eco_id: 'ECO-1' }] }),
    }))
    const res = await request(app).post(INTENT_URL)
    expect(res.status).toBe(502)
    expect(res.body.reason).toBe('malformed-response')
  })
})
