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

const manifest = (bom: Record<string, unknown> | undefined) => ({
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: {
    approval_automation: { supported: true, api_version: 'v1', entitled: true },
    ...(bom ? { bom_multitable: bom } : {}),
  },
})

const URL = '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/context'

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
})
