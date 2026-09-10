import { createApp, h, nextTick, reactive, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AttendanceEmployeeQuickActionIconsField from '../src/views/attendance/AttendanceEmployeeQuickActionIconsField.vue'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import AttendanceSettingsSection from '../src/views/attendance/AttendanceSettingsSection.vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import {
  DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS,
  type EmployeeQuickActionIcons,
} from '../src/views/attendance/attendanceEmployeeWorkspaceCommonIcons'
import { buildEmployeeWorkspaceProps } from '../verification/attendance-employee-overview-first-viewport-fixtures'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn(async () => 'employee-1'),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

const tr = (en: string, _zh: string) => en

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('employee quick-action icons (admin-only)', () => {
  it('workspace keeps accepted default glyphs and a compact 申请 footer without 关注 chip', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, buildEmployeeWorkspaceProps('empty'))
    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-attendance-overview-greeting]')?.textContent).not.toMatch(/关注|Focus /)
    expect(container.querySelector('[data-attendance-ew-customize]')).toBeNull()
    expect(container.querySelector('[data-selfservice-card="requests"]')?.closest('[data-attendance-overview-primary]')).toBeTruthy()
    expect(container.querySelector('[data-selfservice-card="actions"]')?.closest('[data-attendance-overview-primary]')).toBeNull()
    expect(container.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('暂无待审批')
    expect(container.querySelector('[data-selfservice-action="missing-punch"]')?.getAttribute('data-attendance-ew-icon')).toBe('clock-plus')
    expect(container.querySelector('[data-selfservice-action="leave"]')?.getAttribute('data-attendance-ew-icon')).toBe('calendar')
    expect(container.querySelector('[data-selfservice-action="overtime"]')?.getAttribute('data-attendance-ew-icon')).toBe('moon')
    expect(container.querySelector('[data-selfservice-action="shift-swap"]')?.getAttribute('data-attendance-ew-icon')).toBe('swap')
    expect(container.querySelector('[data-attendance-makeup-request-card]')).toBeNull()
    expect(container.querySelector('[data-selfservice-card="actions"]')?.querySelector('h3')?.textContent).toContain('常用')

    app.unmount()
    container.remove()
  })

  it('workspace uses parent-supplied keys and has no customize control', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('normal'),
      employeeQuickActionIcons: {
        makeup: 'plus',
        leave: 'briefcase',
        overtime: 'user',
        swap: 'pin',
      },
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-attendance-ew-customize]')).toBeNull()
    expect(container.querySelector('[data-attendance-employee-quick-icons]')).toBeNull()
    expect(container.querySelector('[data-selfservice-action="missing-punch"]')?.getAttribute('data-attendance-ew-icon')).toBe('plus')
    expect(container.querySelector('[data-selfservice-action="leave"]')?.getAttribute('data-attendance-ew-icon')).toBe('briefcase')
    expect(container.querySelector('[data-selfservice-action="overtime"]')?.getAttribute('data-attendance-ew-icon')).toBe('user')
    expect(container.querySelector('[data-selfservice-action="shift-swap"]')?.getAttribute('data-attendance-ew-icon')).toBe('pin')

    app.unmount()
    container.remove()
  })

  it('admin settings surface can change and keep icon keys', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const settingsForm = reactive({
      autoAbsenceEnabled: false,
      autoAbsenceRunAt: '00:15',
      autoAbsenceLookbackDays: 1,
      ipAllowlist: '',
      geoFenceLat: '',
      geoFenceLng: '',
      geoFenceRadius: '',
      minPunchIntervalMinutes: 1,
      employeeQuickActionIcons: { ...DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS } as EmployeeQuickActionIcons,
    })
    const app = createApp(AttendanceSettingsSection, {
      tr,
      settings: {
        settingsForm,
        settingsLoading: ref(false),
        saveSettings: () => undefined,
      },
    })
    app.mount(container)
    await nextTick()

    const block = container.querySelector('[data-attendance-employee-quick-icons]')
    expect(block).toBeTruthy()
    expect(block!.textContent).toContain('Employee common icons')

    const leaveRow = container.querySelector('[data-attendance-quick-icon-action="leave"]')
    expect(leaveRow).toBeTruthy()
    leaveRow!.querySelector<HTMLButtonElement>('[data-attendance-quick-icon-option="briefcase"]')!.click()
    await nextTick()
    expect(settingsForm.employeeQuickActionIcons.leave).toBe('briefcase')
    expect(settingsForm.employeeQuickActionIcons.makeup).toBe('clock-plus')

    app.unmount()
    container.remove()
  })

  it('admin picker emits only icon keys from the built-in set', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const model = reactive({ ...DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS })
    let app: App | null = createApp({
      setup() {
        return () => h(AttendanceEmployeeQuickActionIconsField, {
          modelValue: model,
          tr,
          'onUpdate:modelValue': (value: EmployeeQuickActionIcons) => {
            model.makeup = value.makeup
            model.leave = value.leave
            model.overtime = value.overtime
            model.swap = value.swap
          },
        })
      },
    })
    app.mount(container)
    await nextTick()

    container.querySelector<HTMLButtonElement>(
      '[data-attendance-quick-icon-action="overtime"] [data-attendance-quick-icon-option="user"]',
    )!.click()
    await nextTick()
    expect(model).toEqual({
      makeup: 'clock-plus',
      leave: 'calendar',
      overtime: 'user',
      swap: 'swap',
    })

    app.unmount()
    container.remove()
    app = null
  })
})

describe('employee-readable icon channel (admin save → new employee session)', () => {
  let container: HTMLElement | null = null
  let app: App | null = null
  const storedIcons: EmployeeQuickActionIcons = { ...DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS }

  afterEach(() => {
    app?.unmount()
    app = null
    container?.remove()
    container = null
    storedIcons.makeup = DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.makeup
    storedIcons.leave = DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.leave
    storedIcons.overtime = DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.overtime
    storedIcons.swap = DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.swap
    vi.mocked(apiFetch).mockReset()
  })

  function installSharedStoreMock() {
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/settings') && String(init?.method || 'GET').toUpperCase() === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as { employeeQuickActionIcons?: EmployeeQuickActionIcons }
        if (body.employeeQuickActionIcons) {
          storedIcons.makeup = body.employeeQuickActionIcons.makeup
          storedIcons.leave = body.employeeQuickActionIcons.leave
          storedIcons.overtime = body.employeeQuickActionIcons.overtime
          storedIcons.swap = body.employeeQuickActionIcons.swap
        }
        return jsonResponse(200, { ok: true, data: { employeeQuickActionIcons: { ...storedIcons } } })
      }
      if (url.includes('/api/attendance/settings')) {
        return jsonResponse(200, { ok: true, data: { employeeQuickActionIcons: { ...storedIcons } } })
      }
      if (url.includes('/api/attendance/employee-quick-action-icons')) {
        return jsonResponse(200, { ok: true, data: { ...storedIcons } })
      }
      return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    })
  }

  it('admin-saved icon keys render in a new employee overview session without settings GET', async () => {
    installSharedStoreMock()
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-settings' })
    app.mount(container)
    await flushUi(12)

    const leaveOption = container.querySelector<HTMLButtonElement>(
      '[data-attendance-quick-icon-action="leave"] [data-attendance-quick-icon-option="briefcase"]',
    )
    expect(leaveOption, 'admin icon picker is mounted').toBeTruthy()
    leaveOption!.click()
    await nextTick()
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save settings',
    )
    expect(saveButton, 'admin save settings').toBeTruthy()
    saveButton!.click()
    await flushUi(8)
    expect(storedIcons.leave).toBe('briefcase')

    app.unmount()
    app = null
    container.remove()
    vi.mocked(apiFetch).mockClear()

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container)
    await flushUi(12)

    expect(container.querySelector('[data-selfservice-action="leave"]')?.getAttribute('data-attendance-ew-icon')).toBe('briefcase')
    expect(container.querySelector('[data-selfservice-action="missing-punch"]')?.getAttribute('data-attendance-ew-icon')).toBe('clock-plus')
    expect(container.querySelector('[data-attendance-ew-customize]')).toBeNull()

    const settingsGets = vi.mocked(apiFetch).mock.calls.filter(([url, init]) => (
      typeof url === 'string'
      && url.includes('/api/attendance/settings')
      && String(init?.method || 'GET').toUpperCase() === 'GET'
    ))
    const iconGets = vi.mocked(apiFetch).mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/attendance/employee-quick-action-icons')
    ))
    expect(settingsGets, 'new employee session must not GET admin settings').toHaveLength(0)
    expect(iconGets.length).toBeGreaterThan(0)
  })
})
