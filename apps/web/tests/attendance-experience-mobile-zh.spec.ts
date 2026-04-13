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

async function waitForRouteTab(router: Router, expected: string | undefined, maxCycles = 30): Promise<void> {
  for (let i = 0; i < maxCycles; i += 1) {
    await flushUi(1)
    const current = router.currentRoute.value.query.tab
    const normalized = typeof current === 'string' ? current : undefined
    if (normalized === expected) return
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

describe('AttendanceExperienceView mobile zh fallback', () => {
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
        matches: query.includes('max-width: 899px') || query.includes('pointer: coarse'),
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
    await router.push('/attendance?tab=admin')
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

  it('shows zh desktop recommendation for admin/workflow tabs and allows returning to overview', async () => {
    expect(container?.textContent).toContain('建议使用桌面端')
    expect(container?.textContent).toContain('管理中心以桌面端为主')
    expect(container?.querySelector('[data-testid="attendance-admin-center"]')).toBeNull()
    expect(router?.currentRoute.value.query.tab).toBe('admin')

    findButton(container!, '返回总览').click()
    await waitForRouteTab(router!, undefined)
    expect(router?.currentRoute.value.query.tab).toBeUndefined()
    expect(container?.querySelector('[data-testid="attendance-overview"]')).not.toBeNull()

    await router?.replace('/attendance?tab=workflow')
    await waitForRouteTab(router!, 'workflow')
    expect(router?.currentRoute.value.query.tab).toBe('workflow')
    expect(container?.textContent).toContain('建议使用桌面端')
    expect(container?.textContent).toContain('流程设计仅支持桌面端')
    expect(container?.querySelector('[data-testid="attendance-workflow-designer"]')).toBeNull()
  })
})
