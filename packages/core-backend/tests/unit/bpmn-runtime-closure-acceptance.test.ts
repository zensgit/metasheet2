/**
 * O1-D — BPMN runtime write-path closure acceptance (owner ruling 2026-08-29: "BPMN 应该要
 * 关闭", not developed further).
 *
 * Spec executed against: `packages/core-backend/src/workflow/bpmnRuntimeConfig.ts`'s own
 * header (rebaselined @ c5a4a94f7, P0-S S1) — the fail-closed env-gate for the whole BPMN
 * workflow RUNTIME surface:
 *   - `isBpmnRuntimeEnabled` (bpmnRuntimeConfig.ts:45-48): DEFAULT OFF; enabled only when
 *     `ENABLE_BPMN_RUNTIME==='true'` (exact string) AND `DISABLE_WORKFLOW!=='true'`.
 *   - `requireBpmnRuntimeEnabled` (bpmnRuntimeConfig.ts:74-88): Express middleware, 503
 *     `{success:false, code:'BPMN_RUNTIME_DISABLED'}` when disabled, `next()` otherwise. Its
 *     handler signature is `(_req: unknown, res, next)` — it never reads `req` at all, so no
 *     request field can influence the decision; only `process.env` is consulted.
 *   - Applied at `routes/workflow.ts:35` as `router.use(requireBpmnRuntimeEnabled)` — BEFORE
 *     any route is registered, so it gates the ENTIRE `/api/workflow` surface (deploy, start,
 *     definitions/instances/tasks/incidents/audit reads, claim, complete, message, signal,
 *     incident-resolve) and runs before each route's own `authenticate` middleware.
 *   - Applied at `routes/workflow-designer.ts:1238` on ONLY `/workflows/:id/deploy` (the one
 *     designer route that reaches the engine, per that file's `ensureWorkflowEngineReady` /
 *     `workflowEngine.deployProcess` call at :1257-1258 — no other designer route touches the
 *     engine). On that route `authenticate` runs BEFORE the gate (opposite order from
 *     `routes/workflow.ts`'s router-wide placement) — pinned explicitly below.
 *   - `routes/workflow.ts:41-47`: `workflowEngine.initialize()` (which starts the timer
 *     poller / `resumeActiveInstances` / metrics / health-check) is called at MODULE IMPORT
 *     TIME only when `isBpmnRuntimeEnabled()` — so "closed" also means the engine never
 *     starts, not merely that routes 503.
 *   - Gate docstring: "fully reversible by setting the flag" — this is a temporary,
 *     server-config-only closure (pending the task-authorization + tenant-isolation rebuild),
 *     NOT a permanent no-enable-path fence like the K3 external-write fence. Both the OFF and
 *     ON legs are pinned below because the gate's own contract promises both.
 *
 * This file adds ACCEPTANCE tests pinning that closure at the HTTP-route level (supertest
 * against the real `routes/workflow.ts` / `routes/workflow-designer.ts` routers, engine and DB
 * calls mocked so a would-be write is directly observable as a mock invocation). The unit-level
 * gate logic itself is already covered by `src/workflow/__tests__/bpmnRuntimeConfig.test.ts`
 * (not duplicated here) and the ENABLED-runtime egress-provenance behavior is covered by
 * `tests/unit/workflow-egress-route-provenance.test.ts` (not duplicated here either — this
 * file's ON-leg tests are the minimum needed to pin that an enable path legitimately exists).
 *
 * KNOWN_GAP: none found in the gate's own logic or its two call sites during this audit. One
 * honest, non-assumed finding is pinned below instead of assumed away: at the `/api/workflow`
 * surface the closure is ROUTER-WIDE, not write-path-only — GET /definitions, /instances,
 * /instances/:id, /tasks, /incidents and /audit (read paths) are ALSO 503'd while disabled,
 * because `router.use(requireBpmnRuntimeEnabled)` runs before every route on that router with
 * no read/write distinction. The narrower "closure is write-path, not data destruction"
 * behavior DOES hold, but only for the `workflow-designer` DRAFT-authoring surface (list/load
 * of `workflow_definitions` draft rows), which is a distinct inventory from the deployed-engine
 * `bpmn_process_definitions` rows gated above. Both are pinned by name so nobody has to assume.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const routeState = vi.hoisted(() => ({
  user: { id: 'owner-1', tenantId: 'tenant-1' } as Record<string, unknown> | null,
  initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  deployProcess: vi.fn().mockResolvedValue('definition-1'),
  startProcess: vi.fn().mockResolvedValue('instance-1'),
  completeUserTask: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  broadcastSignal: vi.fn().mockResolvedValue(undefined),
  loadWorkflowDraft: vi.fn(),
  deployWorkflow: vi.fn().mockResolvedValue('visual-deployment-1'),
  insertInto: vi.fn(),
  updateTable: vi.fn(),
  selectFrom: vi.fn(),
  dbExecute: vi.fn().mockResolvedValue([]),
  dbExecuteTakeFirst: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!routeState.user) {
      res.status(401).json({ success: false, error: 'Unauthorized' })
      return
    }
    req.user = routeState.user as never
    next()
  },
}))

// `routes/workflow-designer.ts` imports `db` at module top (ESM `import { db } from '../db/db'`),
// so this mock reliably intercepts every designer DB call. `routes/workflow.ts` instead does
// `const { db } = require('../db/db')` INSIDE each handler — those handlers are never entered in
// the default-closed legs below (the middleware short-circuits before the handler function is
// even called), so the "zero writes" assertions for that router rely on the handler body never
// running at all, not on this mock correctly intercepting an inline `require`.
vi.mock('../../src/db/db', () => {
  const execute = () => routeState.dbExecute()
  const executeTakeFirst = () => routeState.dbExecuteTakeFirst()
  const selectBuilder: Record<string, unknown> = {}
  selectBuilder.selectAll = () => selectBuilder
  selectBuilder.select = () => selectBuilder
  selectBuilder.where = () => selectBuilder
  selectBuilder.distinctOn = () => selectBuilder
  selectBuilder.orderBy = () => selectBuilder
  selectBuilder.limit = () => selectBuilder
  selectBuilder.execute = execute
  selectBuilder.executeTakeFirst = executeTakeFirst
  return {
    db: {
      insertInto: (...args: unknown[]) => {
        routeState.insertInto(...args)
        return { values: () => ({ execute }) }
      },
      updateTable: (...args: unknown[]) => {
        routeState.updateTable(...args)
        return { set: () => ({ where: () => ({ execute }) }) }
      },
      selectFrom: (...args: unknown[]) => {
        routeState.selectFrom(...args)
        return selectBuilder
      },
      deleteFrom: vi.fn(),
    },
  }
})

vi.mock('../../src/workflow/WorkflowDesigner', () => ({
  WorkflowDesigner: vi.fn().mockImplementation(() => ({
    getTemplates: vi.fn().mockReturnValue([]),
    loadWorkflow: vi.fn(),
    loadWorkflowDraft: routeState.loadWorkflowDraft,
    saveWorkflow: vi.fn(),
    saveBpmnDraft: vi.fn(),
    validateWorkflow: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    deployWorkflow: routeState.deployWorkflow,
  })),
}))

vi.mock('../../src/workflow/BPMNWorkflowEngine', () => ({
  BPMNWorkflowEngine: vi.fn().mockImplementation(() => ({
    initialize: routeState.initialize,
    shutdown: routeState.shutdown,
    deployProcess: routeState.deployProcess,
    startProcess: routeState.startProcess,
    completeUserTask: routeState.completeUserTask,
    sendMessage: routeState.sendMessage,
    broadcastSignal: routeState.broadcastSignal,
  })),
}))

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf_1',
    name: 'Closure acceptance draft',
    description: '',
    version: 1,
    status: 'draft',
    createdBy: 'owner-1',
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    category: 'automation',
    tags: [],
    bpmnXml: '<definitions><process id="p"/></definitions>',
    sourceMode: 'bpmn_xml',
    visual: null,
    shares: [],
    executions: [],
    ...overrides,
  }
}

async function buildWorkflowApp() {
  const router = (await import('../../src/routes/workflow')).default
  const app = express()
  app.use(express.json())
  app.use('/api/workflow', router)
  return app
}

async function buildWorkflowDesignerApp() {
  const router = (await import('../../src/routes/workflow-designer')).default
  const app = express()
  app.use(express.json())
  app.use('/api/workflow-designer', router)
  return app
}

function expectAllEngineCallsZero() {
  expect(routeState.deployProcess).not.toHaveBeenCalled()
  expect(routeState.startProcess).not.toHaveBeenCalled()
  expect(routeState.completeUserTask).not.toHaveBeenCalled()
  expect(routeState.sendMessage).not.toHaveBeenCalled()
  expect(routeState.broadcastSignal).not.toHaveBeenCalled()
}

function expectAllDbWriteCallsZero() {
  expect(routeState.insertInto).not.toHaveBeenCalled()
  expect(routeState.updateTable).not.toHaveBeenCalled()
}

const pinned = usePinnedServer()

beforeEach(() => {
  vi.resetModules()
  delete process.env.ENABLE_BPMN_RUNTIME
  delete process.env.DISABLE_WORKFLOW
  routeState.user = { id: 'owner-1', tenantId: 'tenant-1' }
  routeState.initialize.mockClear()
  routeState.shutdown.mockClear()
  routeState.deployProcess.mockClear()
  routeState.startProcess.mockClear()
  routeState.completeUserTask.mockClear()
  routeState.sendMessage.mockClear()
  routeState.broadcastSignal.mockClear()
  routeState.loadWorkflowDraft.mockReset()
  routeState.deployWorkflow.mockClear()
  routeState.insertInto.mockClear()
  routeState.updateTable.mockClear()
  routeState.selectFrom.mockClear()
  routeState.dbExecute.mockClear()
  routeState.dbExecuteTakeFirst.mockClear()
})

afterEach(() => {
  delete process.env.ENABLE_BPMN_RUNTIME
  delete process.env.DISABLE_WORKFLOW
})

describe('O1-D §1 default-closed: engine never starts at import time', () => {
  test('no env set → BPMNWorkflowEngine.initialize() is never called (poller/resumeActiveInstances/metrics stay off)', async () => {
    await buildWorkflowApp()
    expect(routeState.initialize).not.toHaveBeenCalled()
  })

  test('documented ON leg: ENABLE_BPMN_RUNTIME=true DOES start the engine at import time (reversibility is real, not aspirational)', async () => {
    process.env.ENABLE_BPMN_RUNTIME = 'true'
    await buildWorkflowApp()
    expect(routeState.initialize).toHaveBeenCalledTimes(1)
  })

  test('DISABLE_WORKFLOW=true forces the engine off even if ENABLE_BPMN_RUNTIME=true (documented override)', async () => {
    process.env.ENABLE_BPMN_RUNTIME = 'true'
    process.env.DISABLE_WORKFLOW = 'true'
    await buildWorkflowApp()
    expect(routeState.initialize).not.toHaveBeenCalled()
  })
})

type WriteRoute = {
  name: string
  path: string
  body?: Record<string, unknown>
}

const WORKFLOW_WRITE_ROUTES: WriteRoute[] = [
  { name: 'deploy', path: '/api/workflow/deploy', body: { name: 'x', bpmnXml: '<a/>' } },
  { name: 'start instance', path: '/api/workflow/start/some_key', body: { businessKey: 'bk' } },
  { name: 'claim task', path: '/api/workflow/tasks/00000000-0000-0000-0000-000000000000/claim' },
  {
    name: 'complete task',
    path: '/api/workflow/tasks/00000000-0000-0000-0000-000000000000/complete',
    body: { variables: {} },
  },
  { name: 'send message', path: '/api/workflow/message', body: { messageName: 'm' } },
  { name: 'broadcast signal', path: '/api/workflow/signal', body: { signalName: 's' } },
  {
    name: 'resolve incident',
    path: '/api/workflow/incidents/00000000-0000-0000-0000-000000000000/resolve',
  },
]

describe('O1-D §2 default-closed: every /api/workflow write-path entry refuses before any side effect', () => {
  for (const route of WORKFLOW_WRITE_ROUTES) {
    test(`${route.name}: authenticated caller gets 503 BPMN_RUNTIME_DISABLED, zero engine/db writes`, async () => {
      const app = await buildWorkflowApp()
      pinned.setApp(app)

      const res = await request(pinned.url()).post(route.path).send(route.body ?? {})

      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ success: false, code: 'BPMN_RUNTIME_DISABLED' })
      expectAllEngineCallsZero()
      expectAllDbWriteCallsZero()
    })

    test(`${route.name}: UNAUTHENTICATED caller ALSO gets 503, not 401 — the gate (router.use) runs before this route's own authenticate middleware`, async () => {
      routeState.user = null
      const app = await buildWorkflowApp()
      pinned.setApp(app)

      const res = await request(pinned.url()).post(route.path).send(route.body ?? {})

      expect(res.status).toBe(503)
      expectAllEngineCallsZero()
      expectAllDbWriteCallsZero()
    })
  }
})

describe('O1-D §2b default-closed: the designer\'s one engine-reaching route (deploy) refuses before touching the engine', () => {
  test('authenticated deploy → 503, ensureWorkflowEngineReady/deployProcess never reached, no workflow_definitions publish write', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft())
    const app = await buildWorkflowDesignerApp()
    pinned.setApp(app)

    const res = await request(pinned.url())
      .post('/api/workflow-designer/workflows/wf_1/deploy')
      .send({})

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ success: false, code: 'BPMN_RUNTIME_DISABLED' })
    expect(routeState.deployProcess).not.toHaveBeenCalled()
    // the handler's post-deploy `updateTable('workflow_definitions').set({status:'published'})`
    // write never runs either, since the gate short-circuits before the handler body
    expect(routeState.updateTable).not.toHaveBeenCalled()
  })

  test('unauthenticated deploy gets 401, not 503 — on THIS route authenticate is listed BEFORE requireBpmnRuntimeEnabled (opposite ordering from routes/workflow.ts); documented, not assumed', async () => {
    routeState.user = null
    const app = await buildWorkflowDesignerApp()
    pinned.setApp(app)

    const res = await request(pinned.url())
      .post('/api/workflow-designer/workflows/wf_1/deploy')
      .send({})

    expect(res.status).toBe(401)
    expect(routeState.deployProcess).not.toHaveBeenCalled()
  })
})

describe('O1-D §3 no request-side unlock: only process.env is consulted', () => {
  test('body/header/query fields claiming to enable the runtime are ignored — still 503', async () => {
    const app = await buildWorkflowApp()
    pinned.setApp(app)

    const res = await request(pinned.url())
      .post('/api/workflow/deploy')
      .set('X-Enable-Bpmn-Runtime', 'true')
      .set('X-Disable-Workflow', 'false')
      .query({ ENABLE_BPMN_RUNTIME: 'true', enableBpmnRuntime: 'true' })
      .send({
        name: 'sneaky deploy',
        bpmnXml: '<a/>',
        ENABLE_BPMN_RUNTIME: 'true',
        enableBpmnRuntime: true,
        DISABLE_WORKFLOW: 'false',
        env: { ENABLE_BPMN_RUNTIME: 'true' },
      })

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'BPMN_RUNTIME_DISABLED' })
    expectAllEngineCallsZero()
  })

  test('structural pin: requireBpmnRuntimeEnabled 503s even given a req object carrying spoofed enable fields, proving the middleware never reads req', async () => {
    const { requireBpmnRuntimeEnabled } = await import('../../src/workflow/bpmnRuntimeConfig')
    const spoofedReq = {
      body: { ENABLE_BPMN_RUNTIME: 'true', enableBpmnRuntime: true },
      query: { ENABLE_BPMN_RUNTIME: 'true' },
      headers: { 'x-enable-bpmn-runtime': 'true' },
      env: { ENABLE_BPMN_RUNTIME: 'true' },
    }
    let statusCode = 0
    let body: unknown
    const res = {
      status(code: number) {
        statusCode = code
        return this
      },
      json(payload: unknown) {
        body = payload
        return payload
      },
    }
    const next = vi.fn()

    requireBpmnRuntimeEnabled(spoofedReq, res, next)

    expect(statusCode).toBe(503)
    expect(body).toMatchObject({ code: 'BPMN_RUNTIME_DISABLED' })
    expect(next).not.toHaveBeenCalled()
  })
})

describe('O1-D §4 existing-definition inventory: honestly documents what stays open vs what is also closed', () => {
  test('workflow-designer DRAFT inventory (list + load) stays open while the runtime is disabled — closure is write-path here', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft())
    const app = await buildWorkflowDesignerApp()
    pinned.setApp(app)

    const list = await request(pinned.url()).get('/api/workflow-designer/workflows')
    expect(list.status).not.toBe(503)
    expect(list.status).toBe(200)

    const one = await request(pinned.url()).get('/api/workflow-designer/workflows/wf_1')
    expect(one.status).not.toBe(503)
    expect(one.status).toBe(200)
  })

  test('KNOWN (not a gap — by design): the deployed-engine inventory under /api/workflow (definitions/instances/instance-detail/tasks/incidents/audit) is ALSO 503\'d while disabled — router.use(requireBpmnRuntimeEnabled) is router-wide with no read/write distinction on this surface', async () => {
    const app = await buildWorkflowApp()
    pinned.setApp(app)

    const readPaths = [
      '/api/workflow/definitions',
      '/api/workflow/instances',
      '/api/workflow/instances/00000000-0000-0000-0000-000000000000',
      '/api/workflow/tasks',
      '/api/workflow/incidents',
      '/api/workflow/audit',
    ]

    for (const path of readPaths) {
      const res = await request(pinned.url()).get(path)
      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ code: 'BPMN_RUNTIME_DISABLED' })
    }
  })
})

describe('O1-D §5 documented ON leg: server-side env (only) legitimately re-opens the write path', () => {
  test('ENABLE_BPMN_RUNTIME=true: deploy and start reach the (mocked) engine — proves the enable path is real, server-config-only, and this closure is deliberately reversible, not a permanent fence', async () => {
    process.env.ENABLE_BPMN_RUNTIME = 'true'
    const app = await buildWorkflowApp()
    pinned.setApp(app)

    const deployRes = await request(pinned.url())
      .post('/api/workflow/deploy')
      .send({ name: 'enabled deploy', bpmnXml: '<a/>' })
    expect(deployRes.status).toBe(201)
    expect(routeState.deployProcess).toHaveBeenCalledTimes(1)

    const startRes = await request(pinned.url())
      .post('/api/workflow/start/some_key')
      .send({ businessKey: 'bk' })
    expect(startRes.status).toBe(201)
    expect(routeState.startProcess).toHaveBeenCalledTimes(1)
  })

  test('ENABLE_BPMN_RUNTIME=true + DISABLE_WORKFLOW=true: DISABLE_WORKFLOW still wins — deploy stays 503 (documented override, not a hole)', async () => {
    process.env.ENABLE_BPMN_RUNTIME = 'true'
    process.env.DISABLE_WORKFLOW = 'true'
    const app = await buildWorkflowApp()
    pinned.setApp(app)

    const res = await request(pinned.url())
      .post('/api/workflow/deploy')
      .send({ name: 'should stay blocked', bpmnXml: '<a/>' })

    expect(res.status).toBe(503)
    expect(routeState.deployProcess).not.toHaveBeenCalled()
  })
})
