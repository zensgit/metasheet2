import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import AttendanceWorkflowDesigner from '../src/views/attendance/AttendanceWorkflowDesigner.vue'

vi.mock('../src/views/WorkflowDesigner.vue', () => ({
  default: {
    name: 'WorkflowDesignerStub',
    template: '<div data-testid="workflow-designer-runtime">workflow-runtime</div>',
  },
}))

async function flushUi(cycles = 3): Promise<void> {
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
    expect(text).toContain('审批流程设计器')
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
})
