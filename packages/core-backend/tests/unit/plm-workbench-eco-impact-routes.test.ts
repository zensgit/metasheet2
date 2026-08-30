import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// PLM-COLLAB lane ③ (ECO impact working set) relay route tests. CI wiring note: same as the lane ②
// route test — runs under local `test:unit` but is NOT globbed by yuantus-pact-consumer.yml. The
// adapter pins live in plm-adapter-yuantus.test.ts (CI-run) and the pact wiring in tests/contract/**.

const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn() }))

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
      chain.isBoolean = () => chain
      chain.isInt = () => chain
      return chain
    }
    return { body: () => makeChain(), param: () => makeChain(), query: () => makeChain() }
  },
}))
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource }),
}))

import plmWorkbenchRouter from '../../src/routes/plm-workbench'

const IMPACT_URL = '/api/plm-workbench/data-sources/ds-1/eco/E1/impact'
const EXPORT_URL = '/api/plm-workbench/data-sources/ds-1/eco/E1/impact/export'

const manifest = (feature: Record<string, unknown> | undefined) => ({
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: {
    approval_automation: { supported: true, api_version: 'v1', entitled: true },
    ...(feature ? { eco_impact_review: feature } : {}),
  },
})
const LIVE = { supported: true, api_version: 'v1', entitled: true, available: true }

const providerError = (status: number) =>
  Object.assign(new Error('provider'), { response: { status } })

const pinned = usePinnedServer()

describe('plm-workbench ECO impact working-set relay (PLM-COLLAB lane ③)', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    pinned.setApp(app)
  })

  it('returns 404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => { throw new Error('nope') })
    const res = await request(pinned.url()).get('/api/plm-workbench/data-sources/nope/eco/E1/impact')
    expect(res.status).toBe(404)
    expect(res.body.data_source_id).toBe('nope')
  })

  it('degrades to unsupported-mode for an adapter lacking the impact methods', async () => {
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities: vi.fn() })
    const res = await request(pinned.url()).get(IMPACT_URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported-mode' })
  })

  it('hides the surface (unsupported) when eco_impact_review is not available, WITHOUT reading', async () => {
    const getEcoImpact = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(undefined) }),
      getEcoImpact,
      getEcoImpactExport: vi.fn(),
    })
    const res = await request(pinned.url()).get(IMPACT_URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported' })
    expect(getEcoImpact).not.toHaveBeenCalled()
  })

  it('degrades to no-plm-credential WITHOUT a service read when the per-caller header is absent', async () => {
    const getEcoImpact = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
      getEcoImpact,
      getEcoImpactExport: vi.fn(),
    })
    const res = await request(pinned.url()).get(IMPACT_URL)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ data_source_id: 'ds-1', available: true, reason: 'no-plm-credential', impact: null })
    expect(getEcoImpact).not.toHaveBeenCalled()
  })

  it('reads the impact with the per-caller header token', async () => {
    const getEcoImpact = vi.fn().mockResolvedValue({ data: [{ eco_id: 'E1', impacted_assemblies: [] }] })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
      getEcoImpact,
      getEcoImpactExport: vi.fn(),
    })
    const res = await request(pinned.url()).get(IMPACT_URL).set('X-PLM-User-Token', 'caller-token-1')
    expect(res.status).toBe(200)
    expect(getEcoImpact.mock.calls[0][0]).toBe('caller-token-1')
    expect(getEcoImpact.mock.calls[0][1]).toBe('E1')
    expect(res.body).toMatchObject({ data_source_id: 'ds-1', available: true, entitled: true })
    expect(res.body.impact.eco_id).toBe('E1')
  })

  it('collapses a provider 403 AND 404 to one non-oracle reason (§3.1)', async () => {
    for (const status of [403, 404]) {
      const getEcoImpact = vi.fn().mockResolvedValue({ data: [], error: providerError(status) })
      dsMocks.getDataSource.mockReturnValue({
        getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
        getEcoImpact,
        getEcoImpactExport: vi.fn(),
      })
      const res = await request(pinned.url()).get(IMPACT_URL).set('X-PLM-User-Token', 'caller-token-1')
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ available: true, reason: 'not-found-or-forbidden', impact: null })
    }
  })

  it('maps a provider 400 to invalid-request', async () => {
    const getEcoImpact = vi.fn().mockResolvedValue({ data: [], error: providerError(400) })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
      getEcoImpact,
      getEcoImpactExport: vi.fn(),
    })
    const res = await request(pinned.url()).get(IMPACT_URL).set('X-PLM-User-Token', 'caller-token-1')
    expect(res.body).toMatchObject({ available: true, reason: 'invalid-request', impact: null })
  })

  it('streams the export bytes with the file content-type and an attachment disposition', async () => {
    const getEcoImpactExport = vi.fn().mockResolvedValue({ ok: true, status: 200, contentType: 'text/csv', body: Buffer.from('# Overview\nE1,1\n', 'utf8') })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
      getEcoImpact: vi.fn(),
      getEcoImpactExport,
    })
    const res = await request(pinned.url()).get(`${EXPORT_URL}?format=csv&include_bom_diff=true`).set('X-PLM-User-Token', 'caller-token-1')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.text).toContain('# Overview')
    // export inherits the caller token and the grid's flags
    expect(getEcoImpactExport.mock.calls[0][0]).toBe('caller-token-1')
    expect(getEcoImpactExport.mock.calls[0][2]).toBe('csv')
    expect(getEcoImpactExport.mock.calls[0][3]).toMatchObject({ includeBomDiff: true })
  })

  it('rejects an ecoId with unsafe characters as invalid-request (no 500, no reshaped URL)', async () => {
    const getEcoImpact = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
      getEcoImpact,
      getEcoImpactExport: vi.fn(),
    })
    // a query-injection / traversal attempt in the path segment
    const res = await request(pinned.url())
      .get('/api/plm-workbench/data-sources/ds-1/eco/E1%2F..%3Fx=1/impact')
      .set('X-PLM-User-Token', 'caller-token-1')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ available: true, reason: 'invalid-request', impact: null })
    expect(getEcoImpact).not.toHaveBeenCalled()
  })

  it('rejects an unknown export format with 400', async () => {
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(LIVE) }),
      getEcoImpact: vi.fn(),
      getEcoImpactExport: vi.fn(),
    })
    const res = await request(pinned.url()).get(`${EXPORT_URL}?format=exe`).set('X-PLM-User-Token', 'caller-token-1')
    expect(res.status).toBe(400)
    expect(res.body.reason).toBe('invalid-format')
  })
})
