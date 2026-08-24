import { createApp, h, nextTick, reactive, ref, type App } from 'vue'
import { describe, expect, it } from 'vitest'
import AttendanceEmployeeQuickActionIconsField from '../src/views/attendance/AttendanceEmployeeQuickActionIconsField.vue'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import AttendanceSettingsSection from '../src/views/attendance/AttendanceSettingsSection.vue'
import {
  DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS,
  type EmployeeQuickActionIcons,
} from '../src/views/attendance/attendanceEmployeeWorkspaceCommonIcons'
import { buildEmployeeWorkspaceProps } from '../verification/attendance-employee-overview-first-viewport-fixtures'

const tr = (en: string, _zh: string) => en

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
