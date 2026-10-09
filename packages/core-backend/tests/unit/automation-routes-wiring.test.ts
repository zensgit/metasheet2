/**
 * Automation router HTTP-level wiring test.
 *
 * Gap #2 from the 2026-04-20 monthly delivery audit: the router returned
 * by `createAutomationRoutes()` was never imported anywhere. Clicking
 * "View Logs" on an automation rule 404'd silently even though
 * MetaAutomationLogViewer was properly wired on the frontend.
 *
 * These tests mount the router on a fresh Express app, confirm the URL
 * paths align with what apps/web/src/multitable/api/client.ts calls,
 * and assert the response shapes match the frontend's parseJson<T>
 * contracts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { usePinnedServer } from '../utils/pinned-server'

// G8 + #5779: /test, /logs and /stats all enforce canManageAutomation on the PATH sheet. These wiring
// tests exercise the AUTHORIZED path (they assert response shape/redaction, not the gate itself —
// the gates have their own suites in automation-testrun-gate.test.ts and
// automation-rule-log-read-authz.test.ts, the latter running the REAL permission service).
//
// The capability resolution is therefore DRIVEN per test, not mocked to a blanket true: `beforeEach`
// installs the authorized+live answer, and the denial test below flips it. A blanket true would make
// every "200 + shape" assertion here vacuous — it could not tell an authorized read from an ungated one.
const resolveSheetCapabilities = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/permission-service', () => ({ resolveSheetCapabilities }))
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})

function buildApp(service: unknown) {
  const app = express()
  app.use(express.json())
  app.use('/api/multitable', createAutomationRoutes(service as any))
  return app
}

function makeMockService() {
  return {
    testRun: vi.fn(),
    // #5779: the rule-scoped reads bind the rule to the PATH sheet before reading anything.
    getRule: vi.fn().mockResolvedValue({ id: 'rule-1', sheet_id: 'sheet-a' }),
    logs: {
      getByRule: vi.fn(),
      getStats: vi.fn(),
      getById: vi.fn(), // /test re-fetches the persisted (redacted) row; undefined → response-level redaction fallback
    },
  }
}

const pinned = usePinnedServer()

describe('createAutomationRoutes HTTP mounting', () => {
  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    // Authorized on THIS sheet, and the sheet is live — the state every shape assertion below assumes.
    resolveSheetCapabilities.mockResolvedValue({
      capabilities: { canManageAutomation: true },
      sheetLiveness: 'live',
    })
  })

  it('POST /test returns flat AutomationExecution (not envelope)', async () => {
    const svc = makeMockService()
    svc.testRun.mockResolvedValue({
      id: 'exec-1',
      ruleId: 'rule-1',
      triggeredBy: 'test',
      triggeredAt: '2026-04-20T00:00:00Z',
      status: 'success',
      steps: [],
    })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .expect(200)

    // Client does parseJson<AutomationExecution> — expects flat object
    expect(res.body.id).toBe('exec-1')
    expect(res.body.ruleId).toBe('rule-1')
    expect(res.body.dryRun).toBe(true)
    expect(svc.testRun).toHaveBeenCalledWith('rule-1', 'sheet-a', { mode: 'simulate' })
    // Old envelope shape must NOT appear
    expect(res.body.data).toBeUndefined()
    expect(res.body.ok).toBeUndefined()
  })

  it('POST /test never serializes the raw in-memory execution (live creds / raw secrets redacted)', async () => {
    const svc = makeMockService()
    // testRun returns a fresh in-memory execution: ruleSnapshot = live rule, raw step error.
    svc.testRun.mockResolvedValue({
      id: 'exec-2', ruleId: 'rule-1', triggeredBy: 'manual_test', triggeredAt: '2026-05-29T00:00:00Z', status: 'failed',
      ruleSnapshot: { id: 'rule-1', actions: [{ type: 'send_webhook', config: { token: 'LIVE-SECRET-TOKEN' } }] },
      steps: [{ actionType: 'send_webhook', status: 'failed', error: 'connect postgres://u:SECRETPW@h/db failed' }],
    })
    svc.logs.getById.mockResolvedValue(undefined) // not persisted → response-level redaction fallback

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .expect(200)

    expect(res.body.id).toBe('exec-2') // flat shape preserved
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('LIVE-SECRET-TOKEN')
    expect(serialized).not.toContain('SECRETPW')
  })

  it('POST /test returns the authorized redacted plan without re-reading the values-free audit row', async () => {
    const svc = makeMockService()
    svc.testRun.mockResolvedValue({
      id: 'exec-3', ruleId: 'rule-1', triggeredBy: 'manual_test', triggeredAt: '2026-05-29T00:00:00Z', status: 'success',
      ruleSnapshot: { actions: [{ config: { token: 'LIVE-SECRET-TOKEN', message: 'planned_summary' } }] },
      steps: [],
    })
    svc.logs.getById.mockResolvedValue({
      id: 'exec-3', ruleId: 'rule-1', triggeredBy: 'manual_test', triggeredAt: '2026-05-29T00:00:00Z', status: 'success',
      steps: [],
    })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .expect(200)

    expect(svc.logs.getById).not.toHaveBeenCalled()
    expect(res.body.id).toBe('exec-3')
    expect(JSON.stringify(res.body)).toContain('planned_summary')
    expect(JSON.stringify(res.body)).not.toContain('LIVE-SECRET-TOKEN')
  })

  it('POST /test stays 200 when audit-log reads are unavailable because the response does not depend on them', async () => {
    const svc = makeMockService()
    svc.testRun.mockResolvedValue({
      id: 'exec-4', ruleId: 'rule-1', triggeredBy: 'manual_test', triggeredAt: '2026-05-29T00:00:00Z', status: 'success',
      ruleSnapshot: { actions: [{ config: { token: 'LIVE-SECRET-TOKEN' } }] },
      // secret-SHAPED error (conn-string) — the redactor scrubs by shape, not bare strings.
      steps: [{ actionType: 'send_webhook', status: 'failed', error: 'connect postgres://u:SECRETPW@h/db failed' }],
    })
    svc.logs.getById.mockRejectedValue(new Error('db down'))

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .post('/api/multitable/sheets/sheet-a/automations/rule-1/test')
      .expect(200)
    expect(svc.logs.getById).not.toHaveBeenCalled()
    expect(res.body.id).toBe('exec-4')
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('LIVE-SECRET-TOKEN')
    expect(serialized).not.toContain('SECRETPW')
  })

  it('GET /logs returns shape { executions: [...] } — NOT { logs } — for an AUTHORIZED caller', async () => {
    const svc = makeMockService()
    svc.logs.getByRule.mockResolvedValue([
      { id: 'exec-a', ruleId: 'rule-1', status: 'success' },
      { id: 'exec-b', ruleId: 'rule-1', status: 'failed' },
    ])

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')
      .expect(200)

    // Client does parseJson<{ executions: AutomationExecution[] }>
    expect(res.body).toHaveProperty('executions')
    expect(Array.isArray(res.body.executions)).toBe(true)
    expect(res.body.executions).toHaveLength(2)

    // The OLD key 'logs' would silently cause the frontend to see an
    // empty array — explicitly guard against it.
    expect(res.body.logs).toBeUndefined()
    expect(res.body.data).toBeUndefined()
    // #5779: the 200 above is an AUTHORIZED 200 — the gate ran, and it ran on the PATH sheet.
    expect(resolveSheetCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'sheet-a')
    expect(svc.getRule).toHaveBeenCalledWith('rule-1')
  })

  it('GET /logs respects limit query param, clamped to [1,200]', async () => {
    const svc = makeMockService()
    svc.logs.getByRule.mockResolvedValue([])

    pinned.setApp(buildApp(svc))
    await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs?limit=5000')
      .expect(200)

    expect(svc.logs.getByRule).toHaveBeenCalledWith('rule-1', 200)
  })

  it('GET /stats returns flat AutomationStats (not envelope) — for an AUTHORIZED caller', async () => {
    const svc = makeMockService()
    svc.logs.getStats.mockResolvedValue({
      total: 10,
      success: 8,
      failed: 2,
    })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')
      .expect(200)

    expect(res.body.total).toBe(10)
    expect(res.body.success).toBe(8)
    expect(res.body.data).toBeUndefined()
    expect(resolveSheetCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'sheet-a')
    expect(svc.getRule).toHaveBeenCalledWith('rule-1')
  })

  // #5779 — discriminator for the shape tests above: the capability answer they rely on is a per-test
  // setting, not a blanket true. Flip it and BOTH reads refuse without touching the log service.
  it('GET /logs and /stats refuse a caller WITHOUT canManageAutomation (the shape tests are not vacuous)', async () => {
    resolveSheetCapabilities.mockResolvedValue({
      capabilities: { canManageAutomation: false },
      sheetLiveness: 'live',
    })
    const svc = makeMockService()

    pinned.setApp(buildApp(svc))
    const logs = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')
      .expect(403)
    const stats = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')
      .expect(403)

    expect(logs.body?.error?.code).toBe('FORBIDDEN')
    expect(stats.body?.error?.code).toBe('FORBIDDEN')
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
    expect(svc.logs.getStats).not.toHaveBeenCalled()
  })

  it('returns 503 when automation service has not yet initialized', async () => {
    // Resolver returns undefined → service not ready
    const app = express()
    app.use(express.json())
    app.use('/api/multitable', createAutomationRoutes(() => undefined))

    pinned.setApp(app)
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')
      .expect(503)

    expect(res.body.error).toContain('not initialized')
  })

  it('lazy resolver picks up a service that initializes after route mount', async () => {
    let late: any = undefined
    const app = express()
    app.use(express.json())
    app.use('/api/multitable', createAutomationRoutes(() => late))

    // Pre-init: 503
    pinned.setApp(app)
    await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')
      .expect(503)

    // Simulate post-init (the real AutomationService exposes getRule — the #5779 gate binds the
    // rule to the path sheet before reading its history).
    late = {
      testRun: vi.fn(),
      getRule: vi.fn().mockResolvedValue({ id: 'rule-1', sheet_id: 'sheet-a' }),
      logs: { getByRule: vi.fn(), getStats: vi.fn().mockResolvedValue({ total: 0 }) },
    }

    await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')
      .expect(200)
  })

  /**
   * The handler-level parameter guard, exercised at the ROUTER level on purpose.
   *
   * Express 4 `:param` never matches an EMPTY segment, so no HTTP request can reach this branch —
   * which is exactly why it used to carry a test that asserted nothing (`expect(svc).toBeTruthy()`)
   * under a name promising coverage. The branch is still worth holding: it is the guard that makes
   * `sheetId` non-empty before the capability resolution runs, so it is invoked directly with the
   * params a future re-mount (a different framework, a programmatic call) could produce.
   *
   * Whitespace-only segments, which the HTTP path CAN produce (`/sheets/%20/…`), are covered over in
   * automation-rule-log-read-authz.test.ts.
   */
  it('empty :sheetId/:ruleId → 400 with the exact message, before any capability resolution', async () => {
    const svc = makeMockService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router: any = createAutomationRoutes(svc as any)
    const layer = router.stack.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l: any) => l.route?.path === '/sheets/:sheetId/automations/:ruleId/logs',
    )
    expect(layer).toBeTruthy()

    const seen: { status?: number; body?: unknown } = {}
    const res = {
      status(code: number) { seen.status = code; return res },
      json(body: unknown) { seen.body = body; return res },
    }
    resolveSheetCapabilities.mockReset()

    await layer.route.stack[0].handle(
      { params: { sheetId: '', ruleId: '' }, query: {} },
      res,
      () => undefined,
    )

    expect(seen.status).toBe(400)
    expect(seen.body).toEqual({ error: 'sheetId and ruleId are required' })
    // The guard runs FIRST: no permission resolution, no service call.
    expect(resolveSheetCapabilities).not.toHaveBeenCalled()
    expect(svc.getRule).not.toHaveBeenCalled()
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
  })
})
