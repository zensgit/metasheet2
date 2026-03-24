import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

const ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY = 'metasheet_attendance_admin_nav_collapsed_groups'
const ADMIN_NAV_RECENTS_STORAGE_KEY = 'metasheet_attendance_admin_nav_recent_sections'
const ADMIN_NAV_LAST_SECTION_STORAGE_KEY = 'metasheet_attendance_admin_nav_last_section'
const ADMIN_NAV_DEFAULT_STORAGE_SCOPE = 'default'

function scopedAdminNavStorageKey(baseKey: string, scope = ADMIN_NAV_DEFAULT_STORAGE_SCOPE): string {
  return `${baseKey}:${scope}`
}

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

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}

describe('Attendance admin anchor navigation', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>
  let clipboardWriteTextSpy: ReturnType<typeof vi.fn>
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)
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
    clipboardWriteTextSpy = vi.fn().mockResolvedValue(undefined)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteTextSpy,
      },
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
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY))).toContain('policies')

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()
  })

  it('scrolls to the selected anchor target, keeps the rail item visible, and marks it active', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const button = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(button).toBeTruthy()
    expect(button?.getAttribute('aria-current')).toBeNull()

    button!.click()
    await flushUi(2)

    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-import-batches')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-import-batches')).toBe(true)
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

    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-approval-flows')).toBe(true)
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

  it('copies the current admin section deep link', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const target = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    target!.click()
    await flushUi(2)

    const copyButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-actions .attendance__btn'))
      .find(button => button.textContent?.includes('Copy current link'))
    expect(copyButton).toBeTruthy()
    copyButton!.click()
    await flushUi(2)

    expect(clipboardWriteTextSpy).toHaveBeenCalledTimes(1)
    expect(clipboardWriteTextSpy.mock.calls[0]?.[0]).toContain('#attendance-admin-import-batches')
    expect(container!.textContent).toContain('Current admin section link copied.')
  })

  it('tracks recent admin sections as operators move across the console', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    const approvalFlows = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    expect(importBatches).toBeTruthy()
    expect(approvalFlows).toBeTruthy()

    importBatches!.click()
    await flushUi(2)
    approvalFlows!.click()
    await flushUi(2)

    const labels = Array.from(container!.querySelectorAll('[data-admin-anchor-recent]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Approval Flows', 'Import batches'])
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY))).toContain('attendance-admin-approval-flows')
  })

  it('restores recent admin sections across remounts', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    const approvalFlows = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    importBatches!.click()
    await flushUi(2)
    approvalFlows!.click()
    await flushUi(2)

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const labels = Array.from(container!.querySelectorAll('[data-admin-anchor-recent]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Approval Flows', 'Import batches'])
  })

  it('restores the last active admin section when no hash is present', async () => {
    window.localStorage.setItem(scopedAdminNavStorageKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY), 'attendance-admin-approval-flows')
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-approval-flows')).toBe(true)

    const button = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    expect(button?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(button?.getAttribute('aria-current')).toBe('true')
    expect(window.location.hash).toBe('#attendance-admin-approval-flows')
  })

  it('isolates admin rail persistence by org id', async () => {
    window.localStorage.setItem(scopedAdminNavStorageKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY, 'org-b'), 'attendance-admin-payroll-cycles')
    window.localStorage.setItem(
      scopedAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY, 'org-b'),
      JSON.stringify(['attendance-admin-payroll-cycles', 'attendance-admin-import-batches']),
    )
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!) as any
    await flushUi()
    if (vm?.$?.ctx && 'orgId' in vm.$.ctx) {
      const rawCtxOrgId = vm.$.ctx.orgId
      vm.$.ctx.orgId = 'org-b'
      if (rawCtxOrgId && typeof rawCtxOrgId === 'object' && 'value' in rawCtxOrgId) {
        rawCtxOrgId.value = 'org-b'
      }
    }
    const rawSetupOrgId = vm?.$?.devtoolsRawSetupState?.orgId
    if (rawSetupOrgId && typeof rawSetupOrgId === 'object' && 'value' in rawSetupOrgId) {
      rawSetupOrgId.value = 'org-b'
    }
    vm.orgId = 'org-b'
    await flushUi(3)

    const labels = Array.from(container!.querySelectorAll('[data-admin-anchor-recent]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Payroll Cycles', 'Import batches'])
    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-payroll-cycles')).toBe(true)
  })

  it('collapses the grouped rail behind a toggle on narrow screens', async () => {
    setViewportWidth(640)
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('.attendance__admin-nav-toggle')
    expect(toggle).toBeTruthy()
    expect(container!.querySelector('.attendance__admin-nav')).toBeNull()

    toggle!.click()
    await flushUi(2)
    expect(container!.querySelector('.attendance__admin-nav')).toBeTruthy()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(importBatches).toBeTruthy()
    importBatches!.click()
    await flushUi(2)
    expect(container!.querySelector('.attendance__admin-nav')).toBeNull()
    expect(window.location.hash).toBe('#attendance-admin-import-batches')
  })

  it('surfaces the active group first in compact mode', async () => {
    setViewportWidth(640)
    window.history.replaceState({}, '', '/attendance#attendance-admin-approval-flows')
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('.attendance__admin-nav-toggle')
    expect(toggle?.textContent).toContain('Policies')

    toggle!.click()
    await flushUi(2)

    const groupLabels = Array.from(container!.querySelectorAll('.attendance__admin-nav-group-title')).map(
      item => item.textContent?.trim() || '',
    )
    expect(groupLabels[0]).toBe('Policies')
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()
  })
})
