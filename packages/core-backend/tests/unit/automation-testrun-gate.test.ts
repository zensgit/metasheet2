/**
 * G8 (retry/test-run governance lock §6, §11-G8): the test-run route
 * `POST /api/multitable/sheets/:sheetId/automations/:ruleId/test` defaults to a side-effect-free
 * simulation. The capability gate remains mandatory, and real_fire stays fail-closed until its
 * separately-gated contract is implemented.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { usePinnedServer } from '../utils/pinned-server'

// The gate resolves per-sheet capabilities; drive that resolution from the test.
const resolveSheetCapabilities = vi.hoisted(() => vi.fn())
const requireRecordReadable = vi.hoisted(() => vi.fn())
const poolQuery = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/permission-service', () => ({ resolveSheetCapabilities }))
vi.mock('../../src/routes/univer-meta', () => ({ requireRecordReadable }))
// The gate touches the pool only to hand a query fn to resolveSheetCapabilities (which is mocked),
// so a stub pool with a no-op query is enough.
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: poolQuery, getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})
// Keep the runs routes' admin guard a pass-through so mounting the router is cheap.
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

function buildApp(service: unknown) {
  const app = express()
  app.use(express.json())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, _res, next) => { req.user = { id: 'u1' }; next() })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/multitable', createAutomationRoutes(service as any))
  return app
}

function makeService() {
  return {
    testRun: vi.fn().mockResolvedValue({ id: 'axe_test', ruleId: 'rule-1', sheetId: 'sheet-a', status: 'success', steps: [] }),
    logs: {
      getById: vi.fn().mockResolvedValue({ id: 'axe_test', ruleId: 'rule-1', sheetId: 'sheet-a', status: 'success', steps: [] }),
    },
  }
}

const pinned = usePinnedServer()

describe('G8 — test-run route capability gate', () => {
  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    requireRecordReadable.mockReset()
    poolQuery.mockReset()
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('403s a caller WITHOUT canManageAutomation and NEVER invokes testRun (no real action fires)', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: false } })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({})

    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    // THE point of the gate: even the simulation never ran.
    expect(svc.testRun).not.toHaveBeenCalled()
    // …and the gate was actually scoped to THIS sheet.
    expect(resolveSheetCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'sheet-a')
  })

  it('defaults an authorized caller to simulate and marks the response dryRun', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.dryRun).toBe(true)
    expect(svc.testRun).toHaveBeenCalledWith('rule-1', 'sheet-a', { mode: 'simulate' })
  })

  it('loads a readable sample record and derives the simulation actor server-side', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    requireRecordReadable.mockResolvedValue({
      access: { userId: 'server_actor' },
      capabilities: { canRead: true },
      capabilityOrigin: 'role',
    })
    poolQuery.mockResolvedValue({ rows: [{ data: { tier: 'gold', amount: 12 } }], rowCount: 1 })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({ recordId: ' rec-sample ', actorId: 'spoofed_actor' })

    expect(res.status).toBe(200)
    expect(requireRecordReadable).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      'sheet-a',
      'rec-sample',
    )
    expect(poolQuery).toHaveBeenCalledWith(
      'SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2',
      ['rec-sample', 'sheet-a'],
    )
    expect(svc.testRun).toHaveBeenCalledWith('rule-1', 'sheet-a', {
      mode: 'simulate',
      sampleRecord: {
        recordId: 'rec-sample',
        data: { tier: 'gold', amount: 12 },
        actorId: 'server_actor',
      },
    })
  })

  it('returns the record-read denial unchanged and never invokes testRun', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    requireRecordReadable.mockResolvedValue({
      status: 403,
      body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
    })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({ recordId: 'rec-denied' })

    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    expect(poolQuery).not.toHaveBeenCalled()
    expect(svc.testRun).not.toHaveBeenCalled()
  })

  it('rejects malformed sample record ids before any record lookup or simulation', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({ recordId: ['rec-1'] })

    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('INVALID_TEST_RUN_RECORD_ID')
    expect(requireRecordReadable).not.toHaveBeenCalled()
    expect(svc.testRun).not.toHaveBeenCalled()
  })

  it('fails closed when the sample row disappears after its read gate', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    requireRecordReadable.mockResolvedValue({
      access: { userId: 'server_actor' },
      capabilities: { canRead: true },
      capabilityOrigin: 'role',
    })
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({ recordId: 'rec-gone' })

    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('NOT_FOUND')
    expect(svc.testRun).not.toHaveBeenCalled()
  })

  it('rejects an unknown mode before testRun is invoked', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({ mode: 'preview' })

    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('INVALID_TEST_RUN_MODE')
    expect(svc.testRun).not.toHaveBeenCalled()
  })

  it('fails closed on explicit real_fire while no production enablement gate exists', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({ mode: 'real_fire' })

    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('TEST_RUN_REAL_FIRE_DISABLED')
    expect(svc.testRun).not.toHaveBeenCalled()
  })

  it('fails CLOSED (503, values-free) when capability resolution throws a transient error — never an ungated testRun', async () => {
    resolveSheetCapabilities.mockRejectedValue(new Error('Connection terminated to db.internal.host:5432 as user pg_app'))
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({})

    expect(res.status).toBe(503)
    expect(res.body?.error?.code).toBe('DB_NOT_READY')
    // Review P3: the raw error (host/port/user) must NOT leak into the response body.
    expect(JSON.stringify(res.body)).not.toMatch(/db\.internal\.host|5432|pg_app/)
    expect(svc.testRun).not.toHaveBeenCalled()
  })

  it('fails CLOSED (500, values-free) on a non-transient resolution error', async () => {
    resolveSheetCapabilities.mockRejectedValue(new Error('unexpected TypeError: cannot read x of undefined at /srv/app/secret-path'))
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({})

    expect(res.status).toBe(500)
    expect(res.body?.error?.code).toBe('PERMISSION_CHECK_FAILED')
    expect(JSON.stringify(res.body)).not.toMatch(/secret-path|TypeError/)
    expect(svc.testRun).not.toHaveBeenCalled()
  })
})
