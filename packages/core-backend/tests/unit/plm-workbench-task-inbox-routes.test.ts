import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// PLM-COLLAB lane ② (task-inbox board) relay route tests. NOTE (CI wiring): no workflow globs
// tests/unit/**; this file runs under the local `test:unit` command but is NOT exercised by
// yuantus-pact-consumer.yml (which runs plm-adapter-yuantus.test.ts by name + tests/contract/**).
// The adapter-level pins live in plm-adapter-yuantus.test.ts, and the pact wiring in the contract
// dir, both CI-covered. This file documents the RELAY security contract for a local runner.

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

const URL = '/api/plm-workbench/data-sources/ds-1/task-inbox'

const manifest = (feature: Record<string, unknown> | undefined) => ({
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: {
    approval_automation: { supported: true, api_version: 'v1', entitled: true },
    ...(feature ? { task_inbox_board: feature } : {}),
  },
})

const inboxBody = () => ({
  items: [
    { source: 'approval_request', title: 'A', state: 'pending', is_overdue: false, due_at: null, action_url: '/api/v1/approvals/requests/A1' },
  ],
  sources: [
    { source: 'approval_request', status: 'ok', count: 1, reason: null },
    // an error source carrying str(exc)-shaped text that MUST be stripped at the relay
    { source: 'workflow_task', status: 'error', count: 0, reason: 'psycopg.OperationalError: could not connect to server at 10.0.0.9:5432' },
    { source: 'eco_activity', status: 'unsupported', count: 0, reason: 'deferred until tenant-safe identity resolution' },
  ],
  total: 1, limit: 50, offset: 0,
})

const pinned = usePinnedServer()

describe('plm-workbench task-inbox board relay (PLM-COLLAB lane ②)', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    pinned.setApp(app)
  })

  it('returns 404 when the data source does not exist', async () => {
    dsMocks.getDataSource.mockImplementation(() => { throw new Error('Data source not found: nope') })
    const res = await request(pinned.url()).get('/api/plm-workbench/data-sources/nope/task-inbox')
    expect(res.status).toBe(404)
    expect(res.body.data_source_id).toBe('nope')
  })

  it('degrades to unsupported-mode for an adapter lacking getTaskInbox (no capability call)', async () => {
    const getIntegrationCapabilities = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported-mode' })
    expect(getIntegrationCapabilities).not.toHaveBeenCalled()
  })

  it('degrades to unavailable (not 500) if the capability call throws', async () => {
    const getTaskInbox = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockRejectedValue(new Error('boom')),
      getTaskInbox,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unavailable' })
    expect(getTaskInbox).not.toHaveBeenCalled()
  })

  it('hides the board (unsupported) when task_inbox_board is not supported, WITHOUT reading', async () => {
    const getTaskInbox = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest(undefined) }),
      getTaskInbox,
    })
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported' })
    expect(getTaskInbox).not.toHaveBeenCalled()
  })

  it('degrades to no-plm-credential WITHOUT a service-token read when the per-caller header is absent', async () => {
    const getTaskInbox = vi.fn()
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest({ supported: true, api_version: 'v1', entitled: true, available: true }) }),
      getTaskInbox,
    })
    const res = await request(pinned.url()).get(URL) // no X-PLM-User-Token
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ data_source_id: 'ds-1', available: true, reason: 'no-plm-credential', items: [], sources: [] })
    expect(getTaskInbox).not.toHaveBeenCalled()
  })

  it('reads with the per-caller header token and STRIPS an error-source reason (allowlist ok/unsupported)', async () => {
    const getTaskInbox = vi.fn().mockResolvedValue({ data: [inboxBody()] })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest({ supported: true, api_version: 'v1', entitled: true, available: true }) }),
      getTaskInbox,
    })
    const res = await request(pinned.url()).get(URL).set('X-PLM-User-Token', 'caller-token-1')
    expect(res.status).toBe(200)
    expect(getTaskInbox).toHaveBeenCalledTimes(1)
    expect(getTaskInbox.mock.calls[0][0]).toBe('caller-token-1')
    expect(res.body.available).toBe(true)
    expect(res.body.items).toHaveLength(1)
    const errSource = res.body.sources.find((s: { source: string }) => s.source === 'workflow_task')
    expect(errSource.status).toBe('error')
    expect(errSource.reason).toBeNull() // str(exc) text NEVER reaches the board
    const okSource = res.body.sources.find((s: { source: string }) => s.source === 'eco_activity')
    expect(okSource.reason).toBe('deferred until tenant-safe identity resolution') // unsupported reason preserved
  })

  it('degrades to unavailable (not 500) when the read errors', async () => {
    const getTaskInbox = vi.fn().mockResolvedValue({ data: [], error: new Error('nope') })
    dsMocks.getDataSource.mockReturnValue({
      getIntegrationCapabilities: vi.fn().mockResolvedValue({ available: true, manifest: manifest({ supported: true, api_version: 'v1', entitled: true, available: true }) }),
      getTaskInbox,
    })
    const res = await request(pinned.url()).get(URL).set('X-PLM-User-Token', 'caller-token-1')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ data_source_id: 'ds-1', available: true, reason: 'unavailable', items: [], sources: [] })
  })
})
