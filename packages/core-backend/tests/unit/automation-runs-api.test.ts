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
import { requireAdminRole } from '../../src/guards/audit-integration'

// In prod the runs routes are gated by requireAdminRole() (platform-admin only).
// Pass it through so the handler logic is testable — and separately assert the guard
// IS applied to BOTH routes. Mocking the whole module also avoids pulling its heavy
// audit/metrics deps into a unit test.
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

function buildApp(service: unknown) {
  const app = express()
  app.use(express.json())
  // requireAdminRole is mocked pass-through (doesn't set req.user); inject a stable admin id
  // so the retry route can resolve initiatedBy and tests can assert it lands in provenance.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, _res, next) => { req.user = { id: 'admin1' }; next() })
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

function makeMockService(logsOverrides: Record<string, unknown> = {}, svcOverrides: Record<string, unknown> = {}) {
  return {
    logs: {
      listExecutions: vi.fn().mockResolvedValue([sampleExec]),
      getById: vi.fn().mockResolvedValue(sampleExec),
      ...logsOverrides,
    },
    // A6-1: detail route re-fetches jobs; default [] → falls back to legacy steps.
    jobs: {
      listByExecution: vi.fn().mockResolvedValue([]),
      ...(svcOverrides.jobs as Record<string, unknown> ?? {}),
    },
    retryExecution: vi.fn().mockResolvedValue({
      execution: { ...sampleExec, id: 'axe_new', status: 'success', rerunOfExecutionId: 'axe_1', initiatedBy: 'admin1' },
    }),
    ...svcOverrides,
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

  it('all runs routes (list + detail + retry + resume) are gated by requireAdminRole()', () => {
    vi.mocked(requireAdminRole).mockClear()
    buildApp(makeMockService())
    // exactly four guarded routes: list + detail + retry + A6-2 resume (POST /automation/resume)
    expect(vi.mocked(requireAdminRole)).toHaveBeenCalledTimes(4)
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

  it('A6-2: renders a SUSPENDED execution (out-of-band) — 200, status running, suspended step + C1 descriptor visible', async () => {
    // D2: the execution stays `running` while parked; the C1 job plane carries the `suspended` state.
    // B1: listByExecution returns a VALID C1 suspended job (with the suspend descriptor); the detail
    // route surfaces it as-is. The runs detail an admin opens mid-wait must render without throwing.
    const suspendedExec = {
      ...sampleExec, id: 'axe_susp', status: 'running', finishedAt: null,
      steps: [{ actionType: 'update_record', status: 'success', output: {}, durationMs: 1 }],
    }
    const suspendedJobs = [
      { id: 'axe_susp:job:0', executionId: 'axe_susp', stepKey: '0', status: 'resolved', upstreamJobId: null, result: null },
      { id: 'axe_susp:job:1', executionId: 'axe_susp', stepKey: '1', status: 'suspended', upstreamJobId: 'axe_susp:job:0', result: null, suspend: { reason: 'external_event', resumeToken: 'rt_mock' } },
    ]
    const svc = makeMockService(
      { getById: vi.fn().mockResolvedValue(suspendedExec) },
      { jobs: { listByExecution: vi.fn().mockResolvedValue(suspendedJobs) } },
    )
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions/axe_susp').expect(200)
    expect(res.body.statusLegacy).toBe('running') // execution stays running (D2)
    expect(res.body.status).toBe('running')        // legacy bridge: running → running
    // prefer-jobs: the valid C1 `suspended` job (with descriptor) is surfaced as-is, no throw.
    expect(res.body.steps).toHaveLength(2)
    expect(res.body.steps[1]).toMatchObject({ id: 'axe_susp:job:1', status: 'suspended', suspend: { reason: 'external_event' } })
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

  it('detail view surfaces retry provenance fields (null for a normal run)', async () => {
    const svc = makeMockService()
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions/axe_1').expect(200)
    expect(res.body).toHaveProperty('rerunOfExecutionId', null)
    expect(res.body).toHaveProperty('initiatedBy', null)
  })

  it('A6-1: detail PREFERS persisted jobs when present (job ids `:job:`), else falls back to legacy steps (`:step:`)', async () => {
    // jobs present → steps come from jobs
    const withJobs = makeMockService({}, {
      jobs: {
        listByExecution: vi.fn().mockResolvedValue([
          { id: 'axe_1:job:0', executionId: 'axe_1', stepKey: '0', status: 'resolved', upstreamJobId: null, result: { ok: true } },
          { id: 'axe_1:job:1', executionId: 'axe_1', stepKey: '1', status: 'failed', upstreamJobId: 'axe_1:job:0', error: 'boom' },
        ]),
      },
    })
    const r1 = await request(buildApp(withJobs)).get('/api/multitable/automation-executions/axe_1').expect(200)
    expect(r1.body.steps[0].id).toBe('axe_1:job:0') // from persisted jobs
    expect(withJobs.jobs.listByExecution).toHaveBeenCalledWith('axe_1')

    // no jobs → legacy steps fallback (synthesized `:step:` ids)
    const noJobs = makeMockService() // default jobs.listByExecution → []
    const r2 = await request(buildApp(noJobs)).get('/api/multitable/automation-executions/axe_1').expect(200)
    expect(r2.body.steps[0].id).toBe('axe_1:step:0') // legacy synth
  })

  it('A6-1: terminal execution falls back to legacy steps when persisted jobs are stale/non-terminal', async () => {
    const failedExec = {
      ...sampleExec,
      status: 'failed',
      error: 'job update failed',
      steps: [
        { actionType: 'send_webhook', status: 'success', output: { sideEffectRan: true }, durationMs: 4 },
      ],
    }
    const svc = makeMockService(
      { getById: vi.fn().mockResolvedValue(failedExec) },
      {
        jobs: {
          listByExecution: vi.fn().mockResolvedValue([
            { id: 'axe_1:job:0', executionId: 'axe_1', stepKey: '0', status: 'running', upstreamJobId: null, result: null },
          ]),
        },
      },
    )
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions/axe_1').expect(200)
    expect(res.body.status).toBe('failed')
    expect(res.body.steps[0].id).toBe('axe_1:step:0')
    expect(res.body.steps[0].status).toBe('resolved')
    expect(res.body.steps[0].result).toEqual({ sideEffectRan: true })
  })

  it('A6-1: detail falls back to legacy steps when persisted job rows are unreadable', async () => {
    const svc = makeMockService(
      {},
      {
        jobs: {
          listByExecution: vi.fn().mockRejectedValue(new Error('jobs table temporarily unavailable')),
        },
      },
    )
    const res = await request(buildApp(svc)).get('/api/multitable/automation-executions/axe_1').expect(200)
    expect(res.body.steps[0].id).toBe('axe_1:step:0')
    expect(res.body.steps[0].status).toBe('resolved')
  })
})

describe('A5 runs API — POST /automation-executions/:id/retry', () => {
  it('400 CONFIRM_SIDE_EFFECTS_REQUIRED when confirmSideEffects is not true (no run)', async () => {
    const svc = makeMockService()
    const res = await request(buildApp(svc)).post('/api/multitable/automation-executions/axe_1/retry').send({}).expect(400)
    expect(res.body.error.code).toBe('CONFIRM_SIDE_EFFECTS_REQUIRED')
    expect(svc.retryExecution).not.toHaveBeenCalled()
  })

  it('maps the service discriminated error to its status + code (e.g. 409 NOT_RETRYABLE)', async () => {
    const svc = makeMockService({}, {
      retryExecution: vi.fn().mockResolvedValue({ status: 409, code: 'NOT_RETRYABLE', message: 'only failed/skipped' }),
    })
    const res = await request(buildApp(svc))
      .post('/api/multitable/automation-executions/axe_1/retry')
      .send({ confirmSideEffects: true })
      .expect(409)
    expect(res.body.error.code).toBe('NOT_RETRYABLE')
  })

  it('success serializes the PERSISTED (redacted) row, never the raw in-memory execution (no secret leak)', async () => {
    // retryExecution returns the RAW in-memory execution: ruleSnapshot = current rule
    // (LIVE credentials) + steps with raw action output. record() only scrubs the DB row.
    const rawNew = {
      id: 'axe_new', ruleId: 'rule-1', status: 'success', triggeredBy: 'retry', triggeredAt: '2026-05-29T00:00:00.000Z',
      rerunOfExecutionId: 'axe_1', initiatedBy: 'admin1',
      ruleSnapshot: { id: 'rule-1', actions: [{ type: 'send_webhook', config: { token: 'LIVE-SECRET-TOKEN' } }] },
      steps: [{ actionType: 'send_webhook', status: 'failed', error: 'connect postgres://u:SECRETPW@h/db failed' }],
    }
    // getById returns what record() persisted — the REDACTED row.
    const redactedNew = {
      id: 'axe_new', ruleId: 'rule-1', status: 'success', triggeredBy: 'retry', triggeredAt: '2026-05-29T00:00:00.000Z',
      rerunOfExecutionId: 'axe_1', initiatedBy: 'admin1',
      ruleSnapshot: { id: 'rule-1', actions: [{ type: 'send_webhook', config: { token: '<redacted>' } }] },
      steps: [{ actionType: 'send_webhook', status: 'failed', error: 'connect postgres://<redacted>@h/db failed' }],
    }
    const svc = makeMockService(
      { getById: vi.fn().mockResolvedValue(redactedNew) },
      { retryExecution: vi.fn().mockResolvedValue({ execution: rawNew }) },
    )
    const res = await request(buildApp(svc))
      .post('/api/multitable/automation-executions/axe_1/retry')
      .send({ confirmSideEffects: true })
      .expect(200)
    expect(svc.retryExecution).toHaveBeenCalledWith('axe_1', 'admin1') // admin id from req.user → provenance
    // response is built from the re-fetched persisted (redacted) row, not the raw execution
    expect(svc.logs.getById).toHaveBeenCalledWith('axe_new')
    expect(res.body.id).toBe('axe_new')
    expect(res.body.rerunOfExecutionId).toBe('axe_1')
    expect(res.body.initiatedBy).toBe('admin1')
    expect(res.body.status).toBe('resolved') // C1 mapping
    // the raw live credentials / raw action error MUST NOT appear in the response
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('LIVE-SECRET-TOKEN')
    expect(serialized).not.toContain('SECRETPW')
  })

  it('falls back to a minimal SAFE body (no steps/snapshot) when the persisted row is unreadable', async () => {
    const rawNew = {
      id: 'axe_new', ruleId: 'rule-1', status: 'success', triggeredBy: 'retry', triggeredAt: '2026-05-29T00:00:00.000Z',
      rerunOfExecutionId: 'axe_1', initiatedBy: 'admin1',
      ruleSnapshot: { actions: [{ config: { token: 'LIVE-SECRET-TOKEN' } }] },
      steps: [{ actionType: 'send_webhook', status: 'failed', error: 'SECRETPW' }],
    }
    const svc = makeMockService(
      { getById: vi.fn().mockResolvedValue(undefined) }, // record() swallowed → not found
      { retryExecution: vi.fn().mockResolvedValue({ execution: rawNew }) },
    )
    const res = await request(buildApp(svc))
      .post('/api/multitable/automation-executions/axe_1/retry')
      .send({ confirmSideEffects: true })
      .expect(200)
    expect(res.body.id).toBe('axe_new')
    expect(res.body.status).toBe('resolved')
    expect(res.body.rerunOfExecutionId).toBe('axe_1')
    expect(res.body.initiatedBy).toBe('admin1')
    expect(res.body.steps).toBeUndefined() // never emit raw steps from the in-memory object
    expect(res.body.ruleSnapshot).toBeUndefined()
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('LIVE-SECRET-TOKEN')
    expect(serialized).not.toContain('SECRETPW')
  })

  it('retry stays 200 (minimal safe body) when the persisted-row re-fetch THROWS — a log read must not 500 a retry whose side effects already ran', async () => {
    const rawNew = {
      id: 'axe_new', ruleId: 'rule-1', status: 'success', triggeredBy: 'retry', triggeredAt: '2026-05-29T00:00:00.000Z',
      rerunOfExecutionId: 'axe_1', initiatedBy: 'admin1',
      ruleSnapshot: { actions: [{ config: { token: 'LIVE-SECRET-TOKEN' } }] },
      steps: [{ actionType: 'send_webhook', status: 'failed', error: 'SECRETPW' }],
    }
    const svc = makeMockService(
      { getById: vi.fn().mockRejectedValue(new Error('db down')) }, // log READ throws
      { retryExecution: vi.fn().mockResolvedValue({ execution: rawNew }) },
    )
    const res = await request(buildApp(svc))
      .post('/api/multitable/automation-executions/axe_1/retry')
      .send({ confirmSideEffects: true })
      .expect(200) // NOT 500 — the retry ran; only the log read failed
    expect(res.body.id).toBe('axe_new')
    expect(res.body.status).toBe('resolved')
    expect(res.body.steps).toBeUndefined()
    expect(res.body.ruleSnapshot).toBeUndefined()
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('LIVE-SECRET-TOKEN')
    expect(serialized).not.toContain('SECRETPW')
  })
})

describe('A6-2 — POST /automation/resume (admin-gated)', () => {
  it('400 when confirmSideEffects is not true (resume runs the tail\'s real side effects)', async () => {
    await request(buildApp(makeMockService())).post('/api/multitable/automation/resume')
      .send({ resumeToken: 'tok' }).expect(400)
  })

  it('400 when resumeToken is missing', async () => {
    await request(buildApp(makeMockService())).post('/api/multitable/automation/resume')
      .send({ confirmSideEffects: true }).expect(400)
  })

  it('maps the discriminated 404 (unknown token) to HTTP 404', async () => {
    const svc = makeMockService({}, {
      resumeExecution: vi.fn().mockResolvedValue({ status: 404, code: 'NOT_FOUND', message: 'Unknown resume token' }),
    })
    const res = await request(buildApp(svc)).post('/api/multitable/automation/resume')
      .send({ resumeToken: 'nope', confirmSideEffects: true }).expect(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('200 + run view (persisted-redacted) when resumeExecution returns an execution', async () => {
    const resumed = { ...sampleExec, status: 'success', initiatedBy: 'admin1' }
    const svc = makeMockService(
      { getById: vi.fn().mockResolvedValue(resumed) },
      { resumeExecution: vi.fn().mockResolvedValue({ execution: resumed }) },
    )
    const res = await request(buildApp(svc)).post('/api/multitable/automation/resume')
      .send({ resumeToken: 'tok', confirmSideEffects: true }).expect(200)
    expect(res.body.statusLegacy).toBe('success')
    expect(res.body.initiatedBy).toBe('admin1')
  })
})
