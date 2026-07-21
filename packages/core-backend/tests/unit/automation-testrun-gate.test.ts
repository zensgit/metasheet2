/**
 * G8 (retry/test-run governance lock §6, §11-G8): the test-run route
 * `POST /api/multitable/sheets/:sheetId/automations/:ruleId/test` REALLY executes the rule
 * (fires writes/notifications/webhooks). It previously had NO backend capability gate — only the
 * FE hid the button behind `canManageAutomation`. These tests pin the backend gate: a caller
 * lacking `canManageAutomation` on the sheet gets 403 and `testRun` is NEVER invoked (no real
 * action fires); a privileged caller reaches `testRun` exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { usePinnedServer } from '../utils/pinned-server'

// The gate resolves per-sheet capabilities; drive that resolution from the test.
const resolveSheetCapabilities = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/permission-service', () => ({ resolveSheetCapabilities }))
// The gate touches the pool only to hand a query fn to resolveSheetCapabilities (which is mocked),
// so a stub pool with a no-op query is enough.
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), getInternalPool: () => null }
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
      // safeGetPersistedExecution re-fetch after a run — return the redacted persisted row.
      getById: vi.fn().mockResolvedValue({ id: 'axe_test', ruleId: 'rule-1', sheetId: 'sheet-a', status: 'success', steps: [] }),
    },
  }
}

const pinned = usePinnedServer()

describe('G8 — test-run route capability gate', () => {
  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
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
    // THE point of the gate: the real execution never ran.
    expect(svc.testRun).not.toHaveBeenCalled()
    // …and the gate was actually scoped to THIS sheet.
    expect(resolveSheetCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'sheet-a')
  })

  it('reaches testRun for a caller WITH canManageAutomation (privileged path unchanged)', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true } })
    const svc = makeService()

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .send({})

    expect(res.status).toBe(200)
    expect(svc.testRun).toHaveBeenCalledWith('rule-1', 'sheet-a')
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
