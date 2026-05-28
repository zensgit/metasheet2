/**
 * A2 read-only runs API — GET /api/multitable/automation-executions (+ /:id).
 * Surfaces the A1 execution snapshot through the C1 WorkflowJob vocabulary at the
 * READ boundary (toWorkflowJobView / toRunView); no storage change.
 */
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { normalizeWorkflowJob } from '../../src/multitable/workflow-job-contract'
import { rbacGuard } from '../../src/rbac/rbac'

// In prod the runs routes are gated by rbacGuard('multitable', 'write') (+ platform
// admins via isAdmin/*:*). Here we pass it through so the handler logic is testable —
// and separately assert the guard IS applied with the right permission.
vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

function buildApp(service: unknown) {
  const app = express()
  app.use(express.json())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/multitable', createAutomationRoutes(service as any))
  return app
}

const sampleExec = {
  id: 'axe_1',
  ruleId: 'rule-1',
  sheetId: 'sheet-a',
  triggeredBy: 'event',
  triggeredAt: '2026-05-28T00:00:00.000Z',
  status: 'success',
  duration: 12,
  finishedAt: '2026-05-28T00:00:01.000Z',
  schemaVersion: 1,
  triggerEvent: { recordId: 'rec1' },
  ruleSnapshot: { id: 'rule-1', name: 'Notify' },
  steps: [
    { actionType: 'send_email', status: 'success', output: { ok: true }, durationMs: 5 },
    { actionType: 'send_webhook', status: 'failed', error: 'boom', durationMs: 3 },
  ],
}

function makeMockService(logsOverrides: Record<string, unknown> = {}) {
  return {
    logs: {
      listExecutions: vi.fn().mockResolvedValue([sampleExec]),
      getById: vi.fn().mockResolvedValue(sampleExec),
      ...logsOverrides,
    },
  }
}

describe('A2 runs API — GET /automation-executions (list)', () => {
  it('returns { executions }; status emitted as C1 (success → resolved); snapshot omitted in list', async () => {
    const svc = makeMockService()
    const res = await request(buildApp(svc))
      .get('/api/multitable/automation-executions?sheetId=sheet-a')
      .expect(200)

    expect(res.body).toHaveProperty('executions')
    const run = res.body.executions[0]
    expect(run.status).toBe('resolved') // C1 vocabulary
    expect(run.statusLegacy).toBe('success') // legacy preserved for diagnosis
    expect(run.sheetId).toBe('sheet-a')
    // list view omits the heavy redacted blobs (detail-only)
    expect(run.triggerEvent).toBeUndefined()
    expect(run.ruleSnapshot).toBeUndefined()
    // steps mapped to the C1 WorkflowJob view
    expect(run.steps[0].id).toBe('axe_1:step:0')
    expect(run.steps[0].stepKey).toBe('0')
    expect(run.steps[0].status).toBe('resolved')
    expect(run.steps[0].upstreamJobId).toBeNull()
    expect(run.steps[1].status).toBe('failed')
    expect(run.steps[1].upstreamJobId).toBe('axe_1:step:0')
    expect(svc.logs.listExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ sheetId: 'sheet-a', limit: 50 }),
    )
  })

  it('every step view passes the C1 normalizeWorkflowJob contract (error string-or-absent, never null)', async () => {
    const svc = makeMockService()
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions').expect(200)
    for (const step of res.body.executions[0].steps) {
      expect(() => normalizeWorkflowJob(step)).not.toThrow()
    }
    const [ok, failed] = res.body.executions[0].steps
    expect(ok.error).toBeUndefined() // success step → no error key (not null)
    expect(failed.error).toBe('boom')
  })

  it('status filter accepts BOTH C1 and legacy (resolved & success → stored legacy "success")', async () => {
    const svc = makeMockService()
    await request(buildApp(svc)).get('/api/multitable/automation-executions?status=resolved').expect(200)
    expect(svc.logs.listExecutions).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }))
    await request(buildApp(svc)).get('/api/multitable/automation-executions?status=success').expect(200)
    expect(svc.logs.listExecutions).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }))
  })

  it('future-state C1 filter (suspended) is legal but returns empty WITHOUT querying', async () => {
    const svc = makeMockService()
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions?status=suspended').expect(200)
    expect(res.body.executions).toEqual([])
    expect(svc.logs.listExecutions).not.toHaveBeenCalled()
  })

  it('invalid status filter → 400 (no silent fallback)', async () => {
    const svc = makeMockService()
    await request(buildApp(svc)).get('/api/multitable/automation-executions?status=bogus').expect(400)
    expect(svc.logs.listExecutions).not.toHaveBeenCalled()
  })

  it('limit clamps to [1,200] — including the limit=0 corner (→ 1, not the 50 default)', async () => {
    const svc = makeMockService()
    await request(buildApp(svc)).get('/api/multitable/automation-executions?limit=5000').expect(200)
    expect(svc.logs.listExecutions).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 }))
    await request(buildApp(svc)).get('/api/multitable/automation-executions?limit=0').expect(200)
    expect(svc.logs.listExecutions).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }))
    await request(buildApp(svc)).get('/api/multitable/automation-executions?limit=-5').expect(200)
    expect(svc.logs.listExecutions).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }))
  })

  it('both runs routes are gated by rbacGuard("multitable", "write")', () => {
    buildApp(makeMockService())
    expect(vi.mocked(rbacGuard)).toHaveBeenCalledWith('multitable', 'write')
  })
})

describe('A2 runs API — GET /automation-executions/:id (detail)', () => {
  it('returns the run WITH snapshot blobs (detail view)', async () => {
    const svc = makeMockService()
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions/axe_1').expect(200)
    expect(res.body.id).toBe('axe_1')
    expect(res.body.status).toBe('resolved')
    expect(res.body.triggerEvent).toEqual({ recordId: 'rec1' }) // detail includes snapshot
    expect(res.body.ruleSnapshot).toEqual({ id: 'rule-1', name: 'Notify' })
    expect(svc.logs.getById).toHaveBeenCalledWith('axe_1')
  })

  it('404 when the execution is missing', async () => {
    const svc = makeMockService({ getById: vi.fn().mockResolvedValue(undefined) })
    await request(buildApp(svc)).get('/api/multitable/automation-executions/nope').expect(404)
  })

  it('503 when the service is not initialized', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/multitable', createAutomationRoutes(() => undefined))
    await request(app).get('/api/multitable/automation-executions').expect(503)
  })
})
