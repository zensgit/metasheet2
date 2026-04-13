import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, nextTick, reactive, ref, type App } from 'vue'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'

const routeState = reactive<{ query: Record<string, unknown> }>({
  query: {},
})

const replaceSpy = vi.fn(async ({ query }: { query?: Record<string, unknown> }) => {
  routeState.query = query ?? {}
})

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    replace: replaceSpy,
  }),
}))

const adminFeatureEnabled = ref(true)
const workflowFeatureEnabled = ref(true)

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => {
      if (feature === 'attendanceAdmin') return adminFeatureEnabled.value
      if (feature === 'workflow') return workflowFeatureEnabled.value
      return false
    },
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    isZh: ref(false),
  }),
}))

vi.mock('../src/views/attendance/AttendanceOverview.vue', () => ({
  default: defineComponent({
    props: {
      initialSectionId: {
        type: String,
        default: '',
      },
    },
    template: '<div data-view="overview" :data-section="initialSectionId"></div>',
  }),
}))

vi.mock('../src/views/attendance/AttendanceReportsView.vue', () => ({
  default: defineComponent({
    template: '<div data-view="reports"></div>',
  }),
}))

vi.mock('../src/views/attendance/AttendanceAdminCenter.vue', () => ({
  default: defineComponent({
    props: {
      initialSectionId: {
        type: String,
        default: '',
      },
    },
    template: '<div data-view="admin" :data-section="initialSectionId"></div>',
  }),
}))

vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: defineComponent({
    props: {
      canDesign: {
        type: Boolean,
        default: false,
      },
    },
    template: '<div data-view="workflow" :data-can-design="String(canDesign)"></div>',
  }),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('Attendance experience entrypoints', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    replaceSpy.mockClear()
    routeState.query = {}
    adminFeatureEnabled.value = true
    workflowFeatureEnabled.value = true
    container = document.createElement('div')
    document.body.appendChild(container)
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
    container = null
  })

  it('renders explicit reports and import entry tabs when features are available', async () => {
    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const labels = Array.from(container!.querySelectorAll('.attendance-shell__tab')).map(node => node.textContent?.trim())
    expect(labels).toEqual(['Overview', 'Reports', 'Admin Center', 'Import', 'Workflow Designer'])
  })

  it('routes the import entrypoint into the admin import section', async () => {
    routeState.query = { tab: 'import' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const adminView = container!.querySelector<HTMLElement>('[data-view="admin"]')
    expect(adminView).toBeTruthy()
    expect(adminView?.dataset.section).toBe('attendance-admin-import')
  })

  it('routes the reports entrypoint into a dedicated reports view', async () => {
    routeState.query = { tab: 'reports' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const reportsView = container!.querySelector<HTMLElement>('[data-view="reports"]')
    expect(reportsView).toBeTruthy()
    expect(container!.querySelector('[data-view="overview"]')).toBeNull()
  })

  it('updates the route query when selecting the explicit reports tab', async () => {
    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const reportsTab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab'))
      .find(button => button.textContent?.trim() === 'Reports')
    expect(reportsTab).toBeTruthy()

    reportsTab!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'reports' } })
  })

  it('does not block admin entrypoints for narrow desktop-like viewports without mobile signals', async () => {
    routeState.query = { tab: 'admin' }

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 899px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-view="admin"]')).toBeTruthy()
    expect(container!.textContent).not.toContain('Desktop recommended')
  })
})
