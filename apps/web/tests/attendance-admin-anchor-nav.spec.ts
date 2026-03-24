import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

const ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY = 'metasheet_attendance_admin_nav_collapsed_groups'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('Attendance admin anchor navigation', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.localStorage.removeItem(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY)
    window.history.replaceState({}, '', '/attendance')
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    scrollIntoViewSpy = vi.fn()
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  it('renders grouped top-level admin anchors and excludes nested subsections', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const groupLabels = Array.from(container!.querySelectorAll('.attendance__admin-nav-group-title')).map(
      item => item.textContent?.trim() || '',
    )
    const labels = Array.from(container!.querySelectorAll('.attendance__admin-nav-link')).map(
      item => item.textContent?.trim() || '',
    )

    expect(groupLabels).toEqual(['Workspace', 'Policies', 'Organization', 'Data & Payroll', 'Scheduling'])
    expect(labels).toHaveLength(22)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Settings',
        'User Access',
        'Import',
        'Import batches',
        'Payroll Cycles',
        'Approval Flows',
        'Holidays',
      ]),
    )
    expect(labels).not.toContain('Holiday overrides')
    expect(labels).not.toContain('Template Versions')
  })

  it('collapses and expands admin anchor groups', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const policiesHeader = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
      .find(button => button.textContent?.includes('Policies'))
    expect(policiesHeader).toBeTruthy()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()

    policiesHeader!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()

    policiesHeader!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()
  })

  it('persists collapsed groups across remounts', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const policiesHeader = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
      .find(button => button.textContent?.includes('Policies'))
    expect(policiesHeader).toBeTruthy()

    policiesHeader!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()
    expect(window.localStorage.getItem(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY)).toContain('policies')

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()
  })

  it('scrolls to the selected anchor target and marks it active', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const button = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(button).toBeTruthy()
    expect(button?.getAttribute('aria-current')).toBeNull()

    button!.click()
    await flushUi(2)

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1)
    const target = scrollIntoViewSpy.mock.instances[0] as HTMLElement
    expect(target.id).toBe('attendance-admin-import-batches')
    expect(window.location.hash).toBe('#attendance-admin-import-batches')
    expect(button?.getAttribute('aria-current')).toBe('true')
    expect(button?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
  })

  it('filters anchor items with the quick-find input', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const input = container!.querySelector<HTMLInputElement>('#attendance-admin-nav-filter')
    expect(input).toBeTruthy()
    input!.value = 'payroll'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const labels = Array.from(container!.querySelectorAll('.attendance__admin-nav-link')).map(
      item => item.textContent?.trim() || '',
    )
    const groupLabels = Array.from(container!.querySelectorAll('.attendance__admin-nav-group-title')).map(
      item => item.textContent?.trim() || '',
    )
    expect(groupLabels).toEqual(['Data & Payroll'])
    expect(labels).toEqual(['Payroll Templates', 'Payroll Cycles'])
    expect(container!.textContent).toContain('2/22 items')
  })

  it('restores the hashed admin anchor on first load', async () => {
    window.localStorage.setItem(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY, JSON.stringify(['policies']))
    window.history.replaceState({}, '', '/attendance#attendance-admin-approval-flows')
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1)
    const target = scrollIntoViewSpy.mock.instances[0] as HTMLElement
    expect(target.id).toBe('attendance-admin-approval-flows')
    const button = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    expect(button?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(button?.getAttribute('aria-current')).toBe('true')
    expect(window.location.hash).toBe('#attendance-admin-approval-flows')
  })

  it('supports expand all and collapse all controls', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const controls = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-actions .attendance__btn'))
    const expandAll = controls.find(button => button.textContent?.includes('Expand all'))
    const collapseAll = controls.find(button => button.textContent?.includes('Collapse all'))
    expect(expandAll).toBeTruthy()
    expect(collapseAll).toBeTruthy()

    collapseAll!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()
    expect(container!.querySelector('[data-admin-anchor-group="policies"] [aria-expanded="false"]')).toBeTruthy()

    expandAll!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()
    expect(container!.querySelector('[data-admin-anchor-group="policies"] [aria-expanded="true"]')).toBeTruthy()
  })
})
