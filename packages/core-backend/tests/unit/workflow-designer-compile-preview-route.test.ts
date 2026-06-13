import { readFileSync } from 'node:fs'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeState = vi.hoisted(() => ({
  user: { id: 'owner-1' } as Record<string, unknown> | null,
  loadWorkflowDraft: vi.fn(),
  saveBpmnDraft: vi.fn(),
  initializeWorkflowEngine: vi.fn(),
  deployProcess: vi.fn(),
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

vi.mock('../../src/db/db', () => ({
  db: {
    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([]),
      }),
    }),
    selectFrom: vi.fn(),
    updateTable: vi.fn(),
    deleteFrom: vi.fn(),
  },
}))

vi.mock('../../src/workflow/WorkflowDesigner', () => ({
  WorkflowDesigner: vi.fn().mockImplementation(() => ({
    loadWorkflowDraft: routeState.loadWorkflowDraft,
    loadWorkflow: vi.fn(),
    saveWorkflow: vi.fn(),
    saveBpmnDraft: routeState.saveBpmnDraft,
    validateWorkflow: vi.fn(),
    deployWorkflow: vi.fn(),
  })),
}))

vi.mock('../../src/workflow/BPMNWorkflowEngine', () => ({
  BPMNWorkflowEngine: vi.fn().mockImplementation(() => ({
    initialize: routeState.initializeWorkflowEngine,
    deployProcess: routeState.deployProcess,
  })),
}))

function visualWorkflow() {
  return {
    id: 'wf_1',
    name: 'Preview workflow',
    version: 4,
    nodes: [
      {
        id: 'start',
        type: 'startEvent',
        name: 'Start',
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: 'task_update',
        type: 'serviceTask',
        name: 'Update record',
        position: { x: 120, y: 0 },
        data: {
          properties: {
            actionType: 'update_record',
            config: { fields: { status: 'done' } },
          },
        },
      },
      {
        id: 'end',
        type: 'endEvent',
        name: 'End',
        position: { x: 240, y: 0 },
        data: {},
      },
    ],
    edges: [
      { id: 'flow_start_task', source: 'start', target: 'task_update' },
      { id: 'flow_task_end', source: 'task_update', target: 'end' },
    ],
  }
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf_1',
    name: 'Preview workflow',
    description: '',
    version: 4,
    status: 'draft',
    createdBy: 'owner-1',
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
    updatedAt: new Date('2026-06-13T00:00:00.000Z'),
    category: 'automation',
    tags: [],
    bpmnXml: undefined,
    sourceMode: 'visual',
    visual: visualWorkflow(),
    shares: [],
    executions: [],
    ...overrides,
  }
}

async function buildApp() {
  vi.resetModules()
  const router = (await import('../../src/routes/workflow-designer')).default
  const app = express()
  app.use(express.json())
  app.use('/api/workflow-designer', router)
  return app
}

describe('workflow-designer compile-preview route - A6-4b', () => {
  beforeEach(() => {
    routeState.user = { id: 'owner-1' }
    routeState.loadWorkflowDraft.mockReset()
    routeState.saveBpmnDraft.mockReset()
    routeState.initializeWorkflowEngine.mockReset()
    routeState.deployProcess.mockReset()
  })

  it('compiles an accessible visual draft without touching the live BPMN engine', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft())
    const app = await buildApp()

    const res = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/compile-preview')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.source).toEqual({
      mode: 'visual',
      workflowId: 'wf_1',
      sourceVersion: 4,
    })
    expect(res.body.data.automationPreview.actions).toEqual([
      { type: 'update_record', config: { fields: { status: 'done' } } },
    ])
    expect(routeState.initializeWorkflowEngine).not.toHaveBeenCalled()
    expect(routeState.deployProcess).not.toHaveBeenCalled()
  })

  it('compiles a BPMN-only draft when no visual definition is stored', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft({
      visual: null,
      bpmnXml: [
        '<definitions>',
        '<process id="p1">',
        '<startEvent id="start" />',
        '<sequenceFlow id="flow_start_end" sourceRef="start" targetRef="end" />',
        '<endEvent id="end" />',
        '</process>',
        '</definitions>',
      ].join(''),
    }))
    const app = await buildApp()

    const res = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/compile-preview')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.source).toEqual({
      mode: 'bpmn_xml',
      workflowId: 'wf_1',
      sourceVersion: 4,
    })
    expect(res.body.data.automationPreview.actions).toEqual([])
    expect(routeState.initializeWorkflowEngine).not.toHaveBeenCalled()
    expect(routeState.deployProcess).not.toHaveBeenCalled()
  })

  it('prefers explicitly saved BPMN XML over a preserved stale visual definition', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft({
      sourceMode: 'bpmn_xml',
      bpmnXml: [
        '<definitions>',
        '<process id="p1">',
        '<startEvent id="start" />',
        '<sequenceFlow id="flow_start_end" sourceRef="start" targetRef="end" />',
        '<endEvent id="end" />',
        '</process>',
        '</definitions>',
      ].join(''),
    }))
    const app = await buildApp()

    const res = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/compile-preview')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.source).toEqual({
      mode: 'bpmn_xml',
      workflowId: 'wf_1',
      sourceVersion: 4,
    })
    expect(res.body.data.automationPreview.actions).toEqual([])
  })

  it('preserves sourceMode when duplicating a mixed visual and BPMN draft', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft({
      sourceMode: 'bpmn_xml',
      bpmnXml: '<definitions><process id="p1" /></definitions>',
    }))
    routeState.saveBpmnDraft.mockResolvedValue('wf_copy')
    const app = await buildApp()

    const res = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/duplicate')
      .send({ name: 'Copy' })

    expect(res.status).toBe(201)
    expect(routeState.saveBpmnDraft).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Copy',
      bpmnXml: '<definitions><process id="p1" /></definitions>',
      visual: visualWorkflow(),
      sourceMode: 'bpmn_xml',
    }))
  })

  it('uses ordinary draft access and rejects users who cannot view the draft', async () => {
    routeState.user = { id: 'other-user' }
    routeState.loadWorkflowDraft.mockResolvedValue(draft())
    const app = await buildApp()

    const res = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/compile-preview')
      .send({})

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, error: 'Access denied' })
  })

  it('returns 400 for drafts without visual or BPMN source', async () => {
    routeState.loadWorkflowDraft.mockResolvedValue(draft({ visual: null, bpmnXml: undefined }))
    const app = await buildApp()

    const res = await request(app)
      .post('/api/workflow-designer/workflows/wf_1/compile-preview')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      success: false,
      error: 'Workflow draft has no visual definition or BPMN XML to preview',
    })
    expect(routeState.initializeWorkflowEngine).not.toHaveBeenCalled()
    expect(routeState.deployProcess).not.toHaveBeenCalled()
  })

  it('does not wire deploy, test-run, or persistence calls into the compile-preview route block', () => {
    const source = readFileSync(new URL('../../src/routes/workflow-designer.ts', import.meta.url), 'utf8')
    const start = source.indexOf("'/workflows/:id/compile-preview'")
    const end = source.indexOf("'/workflows/:id/deploy'", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const routeSource = source.slice(start, end)
    expect(routeSource).toContain('compileBpmnPreview')
    expect(routeSource).toContain('hasWorkflowDraftAccess')
    expect(routeSource).not.toMatch(/ensureWorkflowEngineReady|workflowEngine|deployProcess|startProcess/)
    expect(routeSource).not.toMatch(/appendWorkflowDraftExecution|recordWorkflowAnalytics/)
    expect(routeSource).not.toMatch(/saveBpmnDraft|saveWorkflow|deployWorkflow/)
    expect(routeSource).not.toMatch(/insertInto|updateTable|deleteFrom/)
  })
})
