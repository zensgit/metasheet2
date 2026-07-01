import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const routeState = vi.hoisted(() => ({
  user: { id: 'owner-1', tenantId: 'tenant-1' } as Record<string, unknown> | null,
  engineOptions: [] as unknown[],
  initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  deployProcess: vi.fn().mockResolvedValue('definition-1'),
  startProcess: vi.fn().mockResolvedValue('instance-1'),
  loadWorkflowDraft: vi.fn(),
  deployWorkflow: vi.fn().mockResolvedValue('visual-deployment-1'),
  dbExecute: vi.fn().mockResolvedValue([]),
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

vi.mock('../../src/db/db', () => {
  const execute = () => routeState.dbExecute()
  return {
    db: {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ execute }),
      }),
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ execute }),
        }),
      }),
      selectFrom: vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute,
      }),
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
  BPMNWorkflowEngine: vi.fn().mockImplementation((options?: unknown) => {
    routeState.engineOptions.push(options)
    return {
      initialize: routeState.initialize,
      shutdown: routeState.shutdown,
      deployProcess: routeState.deployProcess,
      startProcess: routeState.startProcess,
    }
  }),
}))

const POLICY_LIKE_PAYLOAD = {
  allowedHosts: ['metadata.google.internal'],
  nat64Prefixes: ['2a00:1098:2c::/96'],
  httpTaskEgress: { policy: { allowedHosts: ['metadata.google.internal'] } },
  egressPolicy: { allowedHosts: ['metadata.google.internal'] },
}

function suspiciousBpmnXml() {
  return [
    '<definitions>',
    '<process id="policy_smuggle">',
    '<serviceTask id="http_task" name="HTTP">',
    '<extensionElements>',
    '<allowedHosts>metadata.google.internal</allowedHosts>',
    '<nat64Prefixes>2a00:1098:2c::/96</nat64Prefixes>',
    '<httpTaskEgress>{"allowedHosts":["metadata.google.internal"]}</httpTaskEgress>',
    '</extensionElements>',
    '</serviceTask>',
    '</process>',
    '</definitions>',
  ].join('')
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf_1',
    name: 'Policy smuggle draft',
    description: '',
    version: 1,
    status: 'draft',
    createdBy: 'owner-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    category: 'automation',
    tags: [],
    bpmnXml: suspiciousBpmnXml(),
    sourceMode: 'bpmn_xml',
    visual: null,
    shares: [],
    executions: [],
    ...overrides,
  }
}

async function buildWorkflowApp() {
  delete process.env.DISABLE_WORKFLOW
  const router = (await import('../../src/routes/workflow')).default
  const app = express()
  app.use(express.json())
  app.use('/api/workflow', router)
  return app
}

async function buildWorkflowDesignerApp() {
  delete process.env.DISABLE_WORKFLOW
  const router = (await import('../../src/routes/workflow-designer')).default
  const app = express()
  app.use(express.json())
  app.use('/api/workflow-designer', router)
  return app
}

function expectNoInjectedEgressPolicy(value: unknown) {
  expect(value).not.toHaveProperty('allowedHosts')
  expect(value).not.toHaveProperty('nat64Prefixes')
  expect(value).not.toHaveProperty('httpTaskEgress')
  expect(value).not.toHaveProperty('egressPolicy')
  expect(value).not.toHaveProperty('policy')
}

function expectNoPolicyLeak(responseBody: unknown) {
  const serialized = JSON.stringify(responseBody)
  expect(serialized).not.toContain('metadata.google.internal')
  expect(serialized).not.toContain('2a00:1098:2c::/96')
  expect(serialized).not.toContain('httpTaskEgress')
  expect(serialized).not.toContain('allowedHosts')
  expect(serialized).not.toContain('nat64Prefixes')
}

function expectServerPolicyOnly(expectedPolicy: Record<string, unknown>) {
  expect(routeState.engineOptions.length).toBeGreaterThan(0)
  for (const options of routeState.engineOptions) {
    expect(options).toEqual({
      httpTaskEgress: {
        policy: expectedPolicy,
      },
    })
  }
}

describe('R1-A3-b BPMN HTTP-task route provenance', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.BPMN_HTTP_TASK_EGRESS_POLICY
    routeState.user = { id: 'owner-1', tenantId: 'tenant-1' }
    routeState.engineOptions.length = 0
    routeState.initialize.mockClear()
    routeState.shutdown.mockClear()
    routeState.deployProcess.mockClear()
    routeState.startProcess.mockClear()
    routeState.loadWorkflowDraft.mockReset()
    routeState.deployWorkflow.mockClear()
    routeState.dbExecute.mockClear()
  })

  afterEach(() => {
    delete process.env.BPMN_HTTP_TASK_EGRESS_POLICY
  })

  test('workflow deploy/start and designer deploy remain authenticated route surfaces', async () => {
    routeState.user = null

    const workflowApp = await buildWorkflowApp()
    expect((await request(workflowApp).post('/api/workflow/deploy').send({
      name: 'Blocked deploy',
      bpmnXml: suspiciousBpmnXml(),
    })).status).toBe(401)
    expect((await request(workflowApp).post('/api/workflow/start/policy_smuggle').send({
      variables: { allowedHosts: ['metadata.google.internal'] },
    })).status).toBe(401)

    const designerApp = await buildWorkflowDesignerApp()
    expect((await request(designerApp).post('/api/workflow-designer/workflows/wf_1/deploy').send({})).status).toBe(401)
    expect(routeState.deployProcess).not.toHaveBeenCalled()
    expect(routeState.startProcess).not.toHaveBeenCalled()
  })

  test('workflow deploy ignores policy-like request fields and constructs the engine without injected policy', async () => {
    const app = await buildWorkflowApp()

    const response = await request(app).post('/api/workflow/deploy').send({
      name: 'Suspicious deploy',
      bpmnXml: suspiciousBpmnXml(),
      ...POLICY_LIKE_PAYLOAD,
    })

    expect(response.status).toBe(201)
    expectNoPolicyLeak(response.body)
    expectServerPolicyOnly({ allowedHosts: [], nat64Prefixes: [] })
    expect(routeState.deployProcess).toHaveBeenCalledTimes(1)
    const [definition] = routeState.deployProcess.mock.calls[0]
    expect(definition).toMatchObject({
      name: 'Suspicious deploy',
      bpmnXml: suspiciousBpmnXml(),
      tenantId: 'tenant-1',
    })
    expectNoInjectedEgressPolicy(definition)
  })

  test('workflow start treats policy-like variables as variables, not egress policy', async () => {
    const app = await buildWorkflowApp()

    const response = await request(app).post('/api/workflow/start/policy_smuggle').send({
      businessKey: 'bk-1',
      variables: {
        ...POLICY_LIKE_PAYLOAD,
      },
      allowedHosts: ['ignored.example.com'],
    })

    expect(response.status).toBe(201)
    expectNoPolicyLeak(response.body)
    expectServerPolicyOnly({ allowedHosts: [], nat64Prefixes: [] })
    expect(routeState.startProcess).toHaveBeenCalledTimes(1)
    expect(routeState.startProcess).toHaveBeenCalledWith(
      'policy_smuggle',
      {
        ...POLICY_LIKE_PAYLOAD,
        _startUserId: 'owner-1',
      },
      'bk-1',
      'tenant-1',
    )
  })

  test('workflow-designer deploy forwards stored BPMN XML only and never request-supplied policy', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft())
    const app = await buildWorkflowDesignerApp()

    const response = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/deploy')
      .send(POLICY_LIKE_PAYLOAD)

    expect(response.status).toBe(200)
    expectNoPolicyLeak(response.body)
    expectServerPolicyOnly({ allowedHosts: [], nat64Prefixes: [] })
    expect(routeState.deployProcess).toHaveBeenCalledTimes(1)
    const [definition] = routeState.deployProcess.mock.calls[0]
    expect(definition).toMatchObject({
      key: '',
      name: 'Policy smuggle draft',
      bpmnXml: suspiciousBpmnXml(),
      tenantId: 'tenant-1',
    })
    expectNoInjectedEgressPolicy(definition)
    expect(routeState.deployWorkflow).not.toHaveBeenCalled()
  })

  test('workflow and designer routes share the same server-owned egress policy source', async () => {
    process.env.BPMN_HTTP_TASK_EGRESS_POLICY = JSON.stringify({
      allowedHosts: ['API.Example.com.'],
      nat64Prefixes: ['2A00:1098:2C::/96'],
    })
    routeState.loadWorkflowDraft.mockResolvedValue(draft())

    const workflowApp = await buildWorkflowApp()
    const workflowDeploy = await request(workflowApp).post('/api/workflow/deploy').send({
      name: 'Server policy deploy',
      bpmnXml: suspiciousBpmnXml(),
    })
    expect(workflowDeploy.status).toBe(201)

    const designerApp = await buildWorkflowDesignerApp()
    const designerDeploy = await request(designerApp)
      .post('/api/workflow-designer/workflows/wf_1/deploy')
      .send(POLICY_LIKE_PAYLOAD)
    expect(designerDeploy.status).toBe(200)

    expectServerPolicyOnly({
      allowedHosts: ['api.example.com'],
      nat64Prefixes: ['2a00:1098:2c:0:0:0:0:0/96'],
    })
    expectNoPolicyLeak(workflowDeploy.body)
    expectNoPolicyLeak(designerDeploy.body)
  })
})
