import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import AttendanceWorkflowDesigner from '../src/views/attendance/AttendanceWorkflowDesigner.vue'

const replaceSpy = vi.fn()
const routeState: { query: Record<string, unknown> } = {
  query: {},
}

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    replace: replaceSpy,
  }),
}))

vi.mock('../src/views/WorkflowDesigner.vue', () => ({
  default: {
    name: 'WorkflowDesignerStub',
    template: '<div data-testid="workflow-designer-runtime">workflow-runtime</div>',
  },
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('AttendanceWorkflowDesigner zh', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  async function mount(canDesign: boolean): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(AttendanceWorkflowDesigner, { canDesign })
    app.mount(container)
    await flushUi()
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    replaceSpy.mockReset()
    routeState.query = {}
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    useLocale().setLocale('zh-CN')
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('shows zh empty-state copy without english fallback when capability is disabled', async () => {
    await mount(false)
    const text = container?.textContent || ''
    expect(text).toContain('审批流程设计')
    expect(text).toContain('当前租户未启用流程能力。')
    expect(text).not.toContain('Approval Workflow Designer')
    expect(text).not.toContain('Workflow capability is not enabled for this tenant.')
    expect(container?.querySelector('[data-testid="workflow-designer-runtime"]')).toBeNull()
  })

  it('renders workflow designer runtime when capability is enabled', async () => {
    await mount(true)
    expect(container?.querySelector('[data-testid="workflow-designer-runtime"]')).not.toBeNull()
    expect(container?.textContent || '').not.toContain('当前租户未启用流程能力。')
  })

  it('renders attendance handoff context and exposes admin/navigation actions', async () => {
    routeState.query = {
      wfSource: 'attendance',
      wfHandoff: 'approval-flow',
      attendanceRequestType: 'leave',
      approvalFlowName: '请假审批流',
      approvalStepCount: '2',
      approvalStepSummary: '直属主管审批 -> HR 审批',
      workflowStarterId: 'parallel-review',
      templateId: 'parallel-review',
      workflowDescription: 'Attendance leave starter from approval builder',
    }

    await mount(true)

    const text = container?.textContent || ''
    expect(text).toContain('考勤审批流程接力')
    expect(text).toContain('请假')
    expect(text).toContain('请假审批流')
    expect(text).toContain('2')
    expect(text).toContain('自动套用推荐起步模板')
    expect(text).toContain('并行评审起步模板')
    expect(text).toContain('直属主管审批 -> HR 审批')

    const buttons = Array.from(container?.querySelectorAll('button') ?? [])
    const backButton = buttons.find((button) => button.textContent?.includes('返回管理中心'))
    const clearButton = buttons.find((button) => button.textContent?.includes('清除接力信息'))

    expect(backButton).toBeTruthy()
    expect(clearButton).toBeTruthy()

    backButton!.click()
    clearButton!.click()
    await flushUi()

    expect(replaceSpy).toHaveBeenNthCalledWith(1, { query: { tab: 'admin' } })
    expect(replaceSpy).toHaveBeenNthCalledWith(2, { query: { tab: 'workflow' } })
  })
})
