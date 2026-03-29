import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

const ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY = 'metasheet_attendance_admin_nav_collapsed_groups'
const ADMIN_NAV_RECENTS_STORAGE_KEY = 'metasheet_attendance_admin_nav_recent_sections'
const ADMIN_NAV_LAST_SECTION_STORAGE_KEY = 'metasheet_attendance_admin_nav_last_section'
const ADMIN_NAV_FOCUS_MODE_STORAGE_KEY = 'metasheet_attendance_admin_nav_focused_mode'
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

    expect(groupLabels).toEqual(['Workspace', 'Scheduling', 'Organization', 'Policies', 'Data & Payroll'])
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
    expect(container!.querySelector('.attendance__admin-nav-current')).toBeNull()
    expect(container!.querySelector('#attendance-admin-nav-filter')).toBeNull()
    expect(container!.querySelector('.attendance__admin-nav-actions')).toBeNull()
    expect(container!.querySelector('[data-admin-anchor-recent]')).toBeNull()
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

  it('scrolls the focused right content back to the top region, keeps the rail item visible, and marks it active', async () => {
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
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-import-batches')).toBe(false)
    expect(scrolledTargets.some(target => target.dataset.adminContent === 'true')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-import-batches')).toBe(true)
    expect(window.location.hash).toBe('#attendance-admin-import-batches')
    expect(button?.getAttribute('aria-current')).toBe('true')
    expect(button?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(container!.querySelector('[data-admin-shortcut="attendance-admin-import-batches"]')?.textContent).toContain('Data & Payroll · Import batches')
  })

  it('focuses the right pane on the active admin section by default and can reveal all sections on demand', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const settingsSection = container!.querySelector<HTMLElement>('#attendance-admin-settings')
    const holidaysSection = container!.querySelector<HTMLElement>('#attendance-admin-holidays')
    expect(settingsSection).toBeTruthy()
    expect(holidaysSection).toBeTruthy()
    expect(settingsSection?.style.display).not.toBe('none')
    expect(holidaysSection?.style.display).toBe('none')

    const holidaysAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-holidays"]')
    expect(holidaysAnchor).toBeTruthy()
    holidaysAnchor!.click()
    await flushUi(2)

    expect(settingsSection?.style.display).toBe('none')
    expect(holidaysSection?.style.display).not.toBe('none')

    const revealAllButton = container!.querySelector<HTMLButtonElement>('[data-admin-focus-toggle="true"]')
    expect(revealAllButton).toBeTruthy()
    revealAllButton!.click()
    await flushUi(2)

    expect(settingsSection?.style.display).not.toBe('none')
    expect(holidaysSection?.style.display).not.toBe('none')
  })

  it('renders a sticky current-section bar in the right pane', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const currentSectionBar = container!.querySelector<HTMLElement>('[data-admin-current-section="true"]')
    expect(currentSectionBar).toBeTruthy()
    expect(currentSectionBar?.textContent).toContain('Current section')
    expect(currentSectionBar?.textContent).toContain('Workspace · Settings')
    expect(currentSectionBar?.textContent).toContain('Quick switch: Alt+↑ previous')
    expect(currentSectionBar?.querySelector('[data-admin-focus-toggle="true"]')?.textContent).toContain('Show all sections')
    expect(currentSectionBar?.querySelector('[data-admin-prev-section]')?.getAttribute('data-admin-prev-section-id')).toBe('')
    expect(currentSectionBar?.querySelector('[data-admin-next-section]')?.getAttribute('data-admin-next-section-id')).toBe('attendance-admin-user-access')
  })

  it('lets operators move to the previous and next section from the current-section bar', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const nextButton = container!.querySelector<HTMLButtonElement>('[data-admin-next-section]')
    expect(nextButton?.getAttribute('data-admin-next-section-id')).toBe('attendance-admin-user-access')
    nextButton!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-user-access')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Workspace · User Access')
    expect(container!.querySelector('[data-admin-prev-section]')?.getAttribute('data-admin-prev-section-id')).toBe('attendance-admin-settings')

    const previousButton = container!.querySelector<HTMLButtonElement>('[data-admin-prev-section]')
    previousButton!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-settings')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Workspace · Settings')
  })

  it('remembers focus-vs-show-all mode across remounts', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('[data-admin-focus-toggle="true"]')
    expect(toggle).toBeTruthy()
    toggle!.click()
    await flushUi(2)

    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY))).toBe('false')
    expect(toggle?.textContent).toContain('Focus current section')

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const nextToggle = container!.querySelector<HTMLButtonElement>('[data-admin-focus-toggle="true"]')
    expect(nextToggle?.textContent).toContain('Focus current section')
    expect(container!.querySelector<HTMLElement>('#attendance-admin-settings')?.style.display).not.toBe('none')
    expect(container!.querySelector<HTMLElement>('#attendance-admin-holidays')?.style.display).not.toBe('none')
  })

  it('restores the live user picker, structured rule builder, and holiday month calendar interactions', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const groupMembersAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-group-members"]')
    expect(groupMembersAnchor).toBeTruthy()
    groupMembersAnchor!.click()
    await flushUi(2)

    expect(container!.querySelector('#attendance-group-member-user-picker')).toBeTruthy()
    expect(container!.textContent).toContain('Append selected user')

    const ruleSetsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-sets"]')
    expect(ruleSetsAnchor).toBeTruthy()
    ruleSetsAnchor!.click()
    await flushUi(2)

    const builderSource = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-source')
    const applyBuilderButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-actions .attendance__btn'))
      .find(button => button.textContent?.includes('Apply builder to JSON'))
    const configTextarea = container!.querySelector<HTMLTextAreaElement>('#attendance-rule-set-config')
    expect(builderSource).toBeTruthy()
    expect(applyBuilderButton).toBeTruthy()
    expect(configTextarea).toBeTruthy()

    builderSource!.value = 'dingtalk'
    builderSource!.dispatchEvent(new Event('input', { bubbles: true }))
    applyBuilderButton!.click()
    await flushUi(2)

    expect(container!.textContent).toContain('Structured rule builder')
    expect(configTextarea!.value).toContain('"source": "dingtalk"')
    expect(configTextarea!.value).toContain('"workingDays"')

    const holidaysAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-holidays"]')
    expect(holidaysAnchor).toBeTruthy()
    holidaysAnchor!.click()
    await flushUi(2)

    expect(container!.textContent).toContain('Holiday management now follows a month calendar.')
    const holidayDateInput = container!.querySelector<HTMLInputElement>('#attendance-holiday-date')
    const before = holidayDateInput?.value
    const otherDate = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__holiday-cell'))
      .find(button => !button.classList.contains('attendance__holiday-cell--selected') && !button.disabled)
    expect(holidayDateInput).toBeTruthy()
    expect(otherDate).toBeTruthy()
    otherDate!.click()
    await flushUi(2)
    expect(holidayDateInput?.value).not.toBe(before)
  })

  it('restores import field meanings after loading the live template guide', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/attendance/import/template') {
        return jsonResponse(200, {
          ok: true,
            data: {
              payloadExample: {
                source: 'attendance',
                mode: 'override',
                timezone: 'Asia/Shanghai',
                columns: ['userId', 'workDate', 'firstInAt'],
                requiredFields: ['userId', 'workDate'],
                userId: '<userId>',
              },
              mappingProfiles: [],
            },
          })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import"]')
    expect(importAnchor).toBeTruthy()
    importAnchor!.click()
    await flushUi(2)

    const importSection = container!.querySelector<HTMLElement>('#attendance-admin-import')
    expect(importSection).toBeTruthy()
    const loadTemplateButton = Array.from(importSection!.querySelectorAll<HTMLButtonElement>('.attendance__admin-actions .attendance__btn'))
      .find(button => button.textContent?.includes('Load template'))
    expect(loadTemplateButton).toBeTruthy()
    loadTemplateButton!.click()
    await flushUi(3)

    expect(importSection!.textContent).toContain('Field meanings')
    expect(importSection!.textContent).toContain('Original attendance data source.')
    expect(importSection!.textContent).toContain('Import conflict strategy.')
    expect(importSection!.textContent).toContain('Template columns')
    expect(importSection!.querySelector('.attendance__template-guide')).toBeTruthy()
  })

  it('surfaces recent shortcuts at the top of the admin content instead of inside the left rail', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const payrollTemplates = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-payroll-templates"]')
    const payrollCycles = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-payroll-cycles"]')
    expect(payrollTemplates).toBeTruthy()
    expect(payrollCycles).toBeTruthy()

    payrollTemplates!.click()
    await flushUi(2)
    payrollCycles!.click()
    await flushUi(2)

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Data & Payroll · Payroll Cycles', 'Data & Payroll · Payroll Templates'])
    expect(container!.querySelector('[data-admin-anchor-recent]')).toBeNull()
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

  it('does not render the removed left-rail clutter controls', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('#attendance-admin-nav-filter')).toBeNull()
    expect(container!.querySelector('.attendance__admin-nav-actions')).toBeNull()
    expect(container!.textContent).not.toContain('Quick find')
    expect(container!.textContent).not.toContain('Expand all')
    expect(container!.textContent).not.toContain('Collapse all')
    expect(container!.textContent).not.toContain('Copy current link')
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

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Policies · Approval Flows', 'Data & Payroll · Import batches'])
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

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Policies · Approval Flows', 'Data & Payroll · Import batches'])
  })

  it('clears recent admin sections on demand', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    const approvalFlows = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    importBatches!.click()
    await flushUi(2)
    approvalFlows!.click()
    await flushUi(2)

    const clearButton = container!.querySelector<HTMLButtonElement>('[data-admin-shortcuts-clear="true"]')
    expect(clearButton).toBeTruthy()
    clearButton!.click()
    await flushUi(2)

    expect(container!.querySelector('[data-admin-shortcut]')).toBeNull()
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY))).toBe('[]')
    expect(container!.textContent).toContain('Recent admin shortcuts cleared.')
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

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Data & Payroll · Payroll Cycles', 'Data & Payroll · Import batches'])
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
