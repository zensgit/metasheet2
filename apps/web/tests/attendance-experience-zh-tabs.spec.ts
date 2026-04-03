import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useLocale } from '../src/composables/useLocale'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => feature === 'attendanceAdmin' || feature === 'workflow',
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/views/attendance/AttendanceOverview.vue', () => ({
  default: {
    name: 'AttendanceOverviewStub',
    template: '<div data-testid="attendance-overview">overview</div>',
  },
}))

vi.mock('../src/views/attendance/AttendanceReportsView.vue', () => ({
  default: {
    name: 'AttendanceReportsStub',
    template: '<div data-testid="attendance-reports">reports</div>',
  },
}))

vi.mock('../src/views/attendance/AttendanceAdminCenter.vue', () => ({
  default: {
    name: 'AttendanceAdminCenterStub',
    template: '<div data-testid="attendance-admin-center">admin-center</div>',
  },
}))

vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: {
    name: 'AttendanceWorkflowDesignerStub',
    template: '<div data-testid="attendance-workflow-designer">workflow-designer</div>',
  },
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('AttendanceExperienceView zh desktop tabs', () => {
  let app: App<Element> | null = null
  let router: Router | null = null
  let container: HTMLDivElement | null = null
  const originalMatchMedia = window.matchMedia

  beforeEach(async () => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    useLocale().setLocale('zh-CN')

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/attendance', component: AttendanceExperienceView },
      ],
    })
    await router.push('/attendance')
    await router.isReady()

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ template: '<router-view />' })
    app.use(router)
    app.mount(container)
    await flushUi(6)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    })
    app = null
    router = null
    container = null
  })

  it('renders zh tab labels without english fallback text', async () => {
    const tabText = Array.from(container?.querySelectorAll('.attendance-shell__tab') ?? [])
      .map(node => node.textContent?.trim() || '')
      .filter(Boolean)

    expect(tabText).toContain('总览')
    expect(tabText).toContain('管理中心')
    expect(tabText).toContain('流程设计')

    expect(tabText).not.toContain('Overview')
    expect(tabText).not.toContain('Admin Center')
    expect(tabText).not.toContain('Workflow Designer')
  })
})
