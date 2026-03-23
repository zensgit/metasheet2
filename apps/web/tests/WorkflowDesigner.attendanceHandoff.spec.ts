import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import WorkflowDesigner from '../src/views/WorkflowDesigner.vue'

vi.mock('element-plus/es/components/alert/style/css', () => ({}))
vi.mock('element-plus/es/components/button/style/css', () => ({}))
vi.mock('element-plus/es/components/button-group/style/css', () => ({}))
vi.mock('element-plus/es/components/dialog/style/css', () => ({}))
vi.mock('element-plus/es/components/divider/style/css', () => ({}))
vi.mock('element-plus/es/components/form/style/css', () => ({}))
vi.mock('element-plus/es/components/form-item/style/css', () => ({}))
vi.mock('element-plus/es/components/icon/style/css', () => ({}))
vi.mock('element-plus/es/components/input/style/css', () => ({}))
vi.mock('element-plus/es/components/message/style/css', () => ({}))
vi.mock('element-plus/es/components/message-box/style/css', () => ({}))
vi.mock('element-plus/es/components/option/style/css', () => ({}))
vi.mock('element-plus/es/components/select/style/css', () => ({}))
vi.mock('element-plus/es/components/tag/style/css', () => ({}))

const mocks = vi.hoisted(() => {
  const routeState: { params: Record<string, unknown>; query: Record<string, unknown> } = {
    params: {},
    query: {},
  }

  return {
    replaceSpy: vi.fn(),
    messageSuccessSpy: vi.fn(),
    messageErrorSpy: vi.fn(),
    instantiateWorkflowTemplateSpy: vi.fn(),
    loadWorkflowDraftSpy: vi.fn(),
    loadWorkflowTemplateCachedSpy: vi.fn(),
    routeState,
    fakeModeler: {
      on: vi.fn(),
      destroy: vi.fn(),
      importXML: vi.fn().mockResolvedValue(undefined),
      saveXML: vi.fn().mockResolvedValue({ xml: '<xml />' }),
      saveSVG: vi.fn().mockResolvedValue({ svg: '<svg />' }),
      get: vi.fn((service: string) => {
        switch (service) {
          case 'canvas':
            return {
              zoom: vi.fn((level?: number | string) => (typeof level === 'number' ? level : 1)),
              viewbox: vi.fn(() => ({ x: 0, y: 0, scale: 1 })),
              getRootElement: vi.fn(() => ({ id: 'root', type: 'bpmn:Process' })),
            }
          case 'elementRegistry':
            return {
              getAll: vi.fn(() => []),
            }
          case 'modeling':
            return {
              updateProperties: vi.fn(),
              createShape: vi.fn(),
            }
          case 'elementFactory':
            return {
              createShape: vi.fn(() => ({ id: 'shape-1', type: 'bpmn:Task' })),
            }
          default:
            return {}
        }
      }),
    },
  }
})

vi.mock('vue-router', () => ({
  useRoute: () => mocks.routeState,
  useRouter: () => ({
    replace: mocks.replaceSpy,
    push: vi.fn(),
  }),
}))

vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  return {
    ...actual,
    ElMessage: {
      success: mocks.messageSuccessSpy,
      error: mocks.messageErrorSpy,
    },
    ElMessageBox: {
      confirm: vi.fn(),
    },
  }
})

vi.mock('../src/views/workflowDesignerRuntime', () => ({
  createWorkflowModeler: vi.fn(() => mocks.fakeModeler),
}))

vi.mock('../src/views/workflowDesignerPersistence', async () => {
  const actual = await vi.importActual<typeof import('../src/views/workflowDesignerPersistence')>('../src/views/workflowDesignerPersistence')
  return {
    ...actual,
    instantiateWorkflowTemplate: mocks.instantiateWorkflowTemplateSpy,
    loadWorkflowDraft: mocks.loadWorkflowDraftSpy,
    saveWorkflowDraft: vi.fn(),
    deploySavedWorkflowDraft: vi.fn(),
    deployWorkflowXml: vi.fn(),
  }
})

vi.mock('../src/views/workflowDesignerCatalogCache', async () => {
  const actual = await vi.importActual<typeof import('../src/views/workflowDesignerCatalogCache')>('../src/views/workflowDesignerCatalogCache')
  return {
    ...actual,
    loadWorkflowTemplateCached: mocks.loadWorkflowTemplateCachedSpy,
    listWorkflowTemplatesCached: vi.fn(),
    invalidateWorkflowDraftCatalogCache: vi.fn(),
    invalidateWorkflowTemplateCatalogCache: vi.fn(),
    invalidateWorkflowTemplateDetailCache: vi.fn(),
  }
})

vi.mock('../src/views/workflowDesignerRecentTemplates', () => ({
  buildRecentWorkflowTemplateItem: vi.fn((template) => template),
  readRecentWorkflowTemplates: vi.fn(() => []),
  rememberRecentWorkflowTemplate: vi.fn((template) => [template]),
}))

vi.mock('../src/views/workflowDesignerValidation', () => ({
  validateWorkflowElements: vi.fn(() => []),
}))

vi.mock('../src/components/workflow/WorkflowDesignerToolbar.vue', () => ({
  default: defineComponent({
    name: 'WorkflowDesignerToolbarStub',
    setup() {
      return () => h('div', { 'data-testid': 'workflow-toolbar-stub' })
    },
  }),
}))

vi.mock('../src/components/workflow/WorkflowPalette.vue', () => ({
  default: defineComponent({
    name: 'WorkflowPaletteStub',
    setup() {
      return () => h('div', { 'data-testid': 'workflow-palette-stub' })
    },
  }),
}))

vi.mock('../src/components/workflow/WorkflowTemplateDialog.vue', () => ({
  default: defineComponent({
    name: 'WorkflowTemplateDialogStub',
    setup() {
      return () => h('div', { 'data-testid': 'workflow-template-dialog-stub' })
    },
  }),
}))

vi.mock('../src/components/workflow/WorkflowPropertyPanel.vue', () => ({
  default: defineComponent({
    name: 'WorkflowPropertyPanelStub',
    setup() {
      return () => h('div', { 'data-testid': 'workflow-property-panel-stub' })
    },
  }),
}))

vi.mock('../src/components/workflow/WorkflowCanvasShell.vue', () => ({
  default: defineComponent({
    name: 'WorkflowCanvasShellStub',
    setup(_, { expose }) {
      const containerEl = ref(document.createElement('div'))
      const canvasEl = ref(document.createElement('div'))
      expose({ containerEl, canvasEl })
      return () => h('div', { 'data-testid': 'workflow-canvas-shell-stub' })
    },
  }),
}))

async function flushUi(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('WorkflowDesigner attendance handoff', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.routeState.params = {}
    mocks.routeState.query = {
      wfSource: 'attendance',
      wfHandoff: 'approval-flow',
      attendanceRequestType: 'leave',
      approvalFlowId: 'flow-1',
      approvalFlowName: 'Leave manager to HR',
      approvalStepCount: '2',
      approvalStepSummary: 'Manager review -> HR review',
      workflowName: 'Leave manager to HR',
      workflowDescription: 'Attendance leave starter from approval builder',
      workflowStarterId: 'attendance-leave-manager-hr',
      templateId: 'attendance-leave-manager-hr',
    }

    mocks.instantiateWorkflowTemplateSpy.mockResolvedValue({
      workflowId: 'wf-123',
      message: '模板已应用',
    })
    mocks.loadWorkflowTemplateCachedSpy.mockResolvedValue({
      id: 'attendance-leave-manager-hr',
      name: 'Attendance Leave Manager -> HR Starter',
      description: 'Reusable template',
      category: 'approval',
    })
    mocks.loadWorkflowDraftSpy.mockResolvedValue({
      name: 'Leave manager to HR',
      description: 'Attendance leave starter from approval builder',
      version: '1.0.0',
      bpmnXml: '<definitions />',
    })

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('auto-instantiates the attendance starter and lands on the standalone designer route', async () => {
    app = createApp(WorkflowDesigner)
    app.mount(container!)
    await flushUi()

    expect(mocks.instantiateWorkflowTemplateSpy).toHaveBeenCalledWith({
      templateId: 'attendance-leave-manager-hr',
      name: 'Leave manager to HR',
      description: 'Attendance leave starter from approval builder',
      category: 'approval',
    })
    expect(mocks.loadWorkflowDraftSpy).toHaveBeenCalledWith('wf-123')
    expect(mocks.replaceSpy).toHaveBeenCalledWith({
      name: 'workflow-designer',
      params: { id: 'wf-123' },
      query: {},
    })
    expect(mocks.messageSuccessSpy).toHaveBeenCalled()
    expect(mocks.messageErrorSpy).not.toHaveBeenCalled()
  })
})
