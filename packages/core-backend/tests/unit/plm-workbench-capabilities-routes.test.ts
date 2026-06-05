import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable DataSourceManager.getDataSource mock (configured per test).
const dsMocks = vi.hoisted(() => ({
  getDataSource: vi.fn(),
}))

// plm-workbench.ts pulls in db/pg/auth/validation/validator at module load; stub them so
// the import succeeds. The C2 capabilities route itself only uses getDataSourceManager.
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

const MANIFEST = {
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: { approval_automation: { supported: true, api_version: 'v1', entitled: true } },
}

describe('plm-workbench capabilities route (PLM-COLLAB P2.5 C2)', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
  })

  it('passes through the adapter capability manifest (success)', async () => {
    const getIntegrationCapabilities = vi
      .fn()
      .mockResolvedValue({ available: true, manifest: MANIFEST })
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities })

    const res = await request(app).get('/api/plm-workbench/data-sources/ds-1/capabilities')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: true, manifest: MANIFEST })
    expect(getIntegrationCapabilities).toHaveBeenCalledTimes(1)
  })

  it('returns 404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => {
      throw new Error('Data source not found: nope')
    })

    const res = await request(app).get('/api/plm-workbench/data-sources/nope/capabilities')

    expect(res.status).toBe(404)
    expect(res.body.data_source_id).toBe('nope')
  })

  it('degrades to unsupported-mode for a non-PLM data source WITHOUT calling capabilities', async () => {
    // A real adapter that is not a PLM adapter: it has other methods but not the handshake.
    const getRuntimeStatus = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getRuntimeStatus })

    const res = await request(app).get('/api/plm-workbench/data-sources/pg-1/capabilities')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      data_source_id: 'pg-1',
      available: false,
      reason: 'unsupported-mode',
    })
    expect(getRuntimeStatus).not.toHaveBeenCalled()
  })

  it('passes through an adapter unavailable result', async () => {
    const getIntegrationCapabilities = vi
      .fn()
      .mockResolvedValue({ available: false, reason: 'unavailable' })
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities })

    const res = await request(app).get('/api/plm-workbench/data-sources/ds-2/capabilities')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-2', available: false, reason: 'unavailable' })
  })

  it('degrades to unavailable (not 500) if the adapter capability call throws', async () => {
    const getIntegrationCapabilities = vi.fn().mockRejectedValue(new Error('boom'))
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities })

    const res = await request(app).get('/api/plm-workbench/data-sources/ds-3/capabilities')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-3', available: false, reason: 'unavailable' })
  })
})
