import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import AttendanceHolidayRuleSection from '../src/views/attendance/AttendanceHolidayRuleSection.vue'

interface HolidayOverrideState {
  name: string
  match: 'contains' | 'regex' | 'equals'
  attendanceGroups: string
  roles: string
  roleTags: string
  userIds: string
  userNames: string
  excludeUserIds: string
  excludeUserNames: string
  dayIndexStart: number | null
  dayIndexEnd: number | null
  dayIndexList: string
  firstDayEnabled: boolean
  firstDayBaseHours: number
  overtimeAdds: boolean
  overtimeSource: 'approval' | 'clock' | 'both'
}

interface CalendarPolicyOverrideState {
  id?: string
  name: string
  match: 'contains' | 'regex' | 'equals'
  date: string
  from: string
  to: string
  dayIndexStart: number | null
  dayIndexEnd: number | null
  dayIndexList: string
  source: 'org' | 'group' | 'role' | 'user'
  isWorkingDay: boolean
  label: string
  attendanceGroups: string
  roles: string
  roleTags: string
  userIds: string
  userNames: string
  excludeUserIds: string
  excludeUserNames: string
}

interface HolidaySettingsState {
  holidayFirstDayEnabled: boolean
  holidayFirstDayBaseHours: number
  holidayOvertimeAdds: boolean
  holidayOvertimeSource: 'approval' | 'clock' | 'both'
  holidayOverrides: HolidayOverrideState[]
  calendarPolicyOverrides: CalendarPolicyOverrideState[]
  holidaySyncBaseUrl: string
  holidaySyncYears: string
  holidaySyncAddDayIndex: boolean
  holidaySyncDayIndexHolidays: string
  holidaySyncDayIndexMaxDays: number
  holidaySyncDayIndexFormat: 'name-1' | 'name第1天' | 'name DAY1'
  holidaySyncOverwrite: boolean
  holidaySyncAutoEnabled: boolean
  holidaySyncAutoRunAt: string
  holidaySyncAutoTimezone: string
}

type HolidayConfig = {
  addCalendarPolicyOverride: () => void
  addHolidayOverride: () => void
  holidaySyncLastRun: { value: null }
  holidaySyncLoading: { value: boolean }
  removeHolidayOverride: (index: number) => void
  removeCalendarPolicyOverride: (index: number) => void
  saveSettings: () => void
  settingsForm: HolidaySettingsState
  settingsLoading: { value: boolean }
  syncHolidays: () => void
  syncHolidaysForYears: (years: number[]) => void
}

function flushUi(cycles = 4): Promise<void> {
  return Promise.all(Array.from({ length: cycles }).map(() => Promise.resolve().then(() => nextTick()))).then(
    () => undefined
  )
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function createDefaultSettings(): HolidaySettingsState {
  return {
    holidayFirstDayEnabled: true,
    holidayFirstDayBaseHours: 8,
    holidayOvertimeAdds: false,
    holidayOvertimeSource: 'approval',
    holidayOverrides: [],
    calendarPolicyOverrides: [],
    holidaySyncBaseUrl: '',
    holidaySyncYears: '',
    holidaySyncAddDayIndex: false,
    holidaySyncDayIndexHolidays: '',
    holidaySyncDayIndexMaxDays: 7,
    holidaySyncDayIndexFormat: 'name-1',
    holidaySyncOverwrite: false,
    holidaySyncAutoEnabled: false,
    holidaySyncAutoRunAt: '02:00',
    holidaySyncAutoTimezone: 'Asia/Shanghai',
  }
}

describe('AttendanceHolidayRuleSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const tr = (_en: string, zh: string) => zh
  const formatDateTime = (value: string | null | undefined) => (value ? `formatted:${value}` : '--')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('keeps holiday overrides collapsed when none exist by default', async () => {
    const settingsForm = reactive<HolidaySettingsState>(createDefaultSettings())

    const config = {
      addCalendarPolicyOverride: vi.fn(),
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
      removeCalendarPolicyOverride: vi.fn(),
      removeHolidayOverride: vi.fn(),
      saveSettings: vi.fn(),
      settingsForm,
      settingsLoading: { value: false },
      syncHolidays: vi.fn(),
      syncHolidaysForYears: vi.fn(),
    } as HolidayConfig

    app = createApp(AttendanceHolidayRuleSection, {
      attendanceGroupOptions: [],
      config,
      formatDateTime,
      tr,
    })
    app.mount(container!)
    await flushUi()

    const accordion = container!.querySelector('.attendance__accordion') as HTMLButtonElement
    expect(accordion).toBeTruthy()
    expect(accordion.getAttribute('aria-expanded')).toBe('false')
    expect(container!.querySelector('.attendance__table')).toBeNull()
    expect(container!.querySelector('.attendance__table-cell--holiday-name')).toBeNull()
  })

  it('toggles collapse state with explicit click', async () => {
    const settingsForm = reactive<HolidaySettingsState>(createDefaultSettings())

    const config = {
      addCalendarPolicyOverride: vi.fn(),
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
      removeCalendarPolicyOverride: vi.fn(),
      removeHolidayOverride: vi.fn(),
      saveSettings: vi.fn(),
      settingsForm,
      settingsLoading: { value: false },
      syncHolidays: vi.fn(),
      syncHolidaysForYears: vi.fn(),
    } as HolidayConfig

    app = createApp(AttendanceHolidayRuleSection, {
      attendanceGroupOptions: [],
      config,
      formatDateTime,
      tr,
    })
    app.mount(container!)
    await flushUi()

    const accordion = container!.querySelector('.attendance__accordion') as HTMLButtonElement
    expect(accordion.getAttribute('aria-expanded')).toBe('false')

    accordion.click()
    await flushUi(2)
    expect(accordion.getAttribute('aria-expanded')).toBe('true')
    expect(container!.textContent).toContain('暂无覆盖规则。')

    accordion.click()
    await flushUi(2)
    expect(accordion.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands and shows the override row after adding one override', async () => {
    const settingsForm = reactive<HolidaySettingsState>(createDefaultSettings())

    const config = {
      addCalendarPolicyOverride: vi.fn(),
      addHolidayOverride: vi.fn(() => {
        settingsForm.holidayOverrides.push({
          name: '',
          match: 'contains',
          attendanceGroups: '',
          roles: '',
          roleTags: '',
          userIds: '',
          userNames: '',
          excludeUserIds: '',
          excludeUserNames: '',
          dayIndexStart: 1,
          dayIndexEnd: 1,
          dayIndexList: '1',
          firstDayEnabled: true,
          firstDayBaseHours: 8,
          overtimeAdds: false,
          overtimeSource: 'approval',
        })
      }),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
      removeCalendarPolicyOverride: vi.fn(),
      removeHolidayOverride: vi.fn(),
      saveSettings: vi.fn(),
      settingsForm,
      settingsLoading: { value: false },
      syncHolidays: vi.fn(),
      syncHolidaysForYears: vi.fn(),
    } as HolidayConfig

    app = createApp(AttendanceHolidayRuleSection, {
      attendanceGroupOptions: ['day-shift'],
      config,
      formatDateTime,
      tr,
    })
    app.mount(container!)
    await flushUi()

    const addButton = findButton(container!, '新增覆盖')
    addButton.click()
    await flushUi(6)

    expect(config.addHolidayOverride).toHaveBeenCalledTimes(1)
    const accordion = container!.querySelector('.attendance__accordion') as HTMLButtonElement
    expect(accordion.getAttribute('aria-expanded')).toBe('true')
    expect(container!.querySelector('.attendance__table')).toBeTruthy()
    expect(container!.querySelector('.attendance__table-cell--holiday-name input')).toBeTruthy()
    expect(container!.querySelector('.attendance__override-field input[placeholder="单休办公,白班"]')).toBeTruthy()
  })

  it('expands and shows effective calendar override controls after adding one rule', async () => {
    const settingsForm = reactive<HolidaySettingsState>(createDefaultSettings())

    const config = {
      addCalendarPolicyOverride: vi.fn(() => {
        settingsForm.calendarPolicyOverrides.push({
          name: '',
          match: 'contains',
          date: '',
          from: '2026-10-01',
          to: '2026-10-07',
          dayIndexStart: null,
          dayIndexEnd: null,
          dayIndexList: '',
          source: 'group',
          isWorkingDay: false,
          label: '国庆调休',
          attendanceGroups: 'day-shift',
          roles: '',
          roleTags: '',
          userIds: '',
          userNames: '',
          excludeUserIds: '',
          excludeUserNames: '',
        })
      }),
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
      removeCalendarPolicyOverride: vi.fn(),
      removeHolidayOverride: vi.fn(),
      saveSettings: vi.fn(),
      settingsForm,
      settingsLoading: { value: false },
      syncHolidays: vi.fn(),
      syncHolidaysForYears: vi.fn(),
    } as HolidayConfig

    app = createApp(AttendanceHolidayRuleSection, {
      attendanceGroupOptions: ['day-shift'],
      config,
      formatDateTime,
      tr,
    })
    app.mount(container!)
    await flushUi()

    findButton(container!, '新增日历覆盖').click()
    await flushUi(6)

    expect(config.addCalendarPolicyOverride).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('有效日历覆盖规则')
    expect(container!.textContent).toContain('自动缺勤任务运行时可能生成缺勤记录')
    expect(container!.textContent).toContain('角色匹配使用用户平台角色')
    const roleOption = Array.from(container!.querySelectorAll('option')).find((option) => option.value === 'role')
    expect(roleOption).toBeTruthy()
    expect(roleOption?.disabled).toBe(false)
    expect(container!.querySelector('input[placeholder="规则标签"]')).toBeTruthy()
    expect(container!.querySelector('.attendance__override-field input[placeholder="单休办公,白班"]')).toBeTruthy()
    const roleInputs = container!.querySelectorAll('.attendance__override-field input[placeholder="attendance_admin,班组长"]')
    expect(roleInputs.length).toBeGreaterThanOrEqual(2)
  })

  it('shows effective calendar override diagnostics for unsaved and shadowed rules', async () => {
    const settingsForm = reactive<HolidaySettingsState>(createDefaultSettings())
    settingsForm.calendarPolicyOverrides.push(
      {
        name: '',
        match: 'contains',
        date: '',
        from: '2026-10-01',
        to: '2026-10-07',
        dayIndexStart: null,
        dayIndexEnd: null,
        dayIndexList: '',
        source: 'role',
        isWorkingDay: false,
        label: '角色休息日',
        attendanceGroups: '',
        roles: '',
        roleTags: '',
        userIds: '',
        userNames: '',
        excludeUserIds: '',
        excludeUserNames: '',
      },
      {
        name: '',
        match: 'contains',
        date: '',
        from: '2026-10-01',
        to: '2026-10-07',
        dayIndexStart: null,
        dayIndexEnd: null,
        dayIndexList: '',
        source: 'group',
        isWorkingDay: false,
        label: '休息日',
        attendanceGroups: 'day-shift',
        roles: '',
        roleTags: '',
        userIds: '',
        userNames: '',
        excludeUserIds: '',
        excludeUserNames: '',
      },
      {
        name: '',
        match: 'contains',
        date: '',
        from: '2026-10-03',
        to: '2026-10-04',
        dayIndexStart: null,
        dayIndexEnd: null,
        dayIndexList: '',
        source: 'group',
        isWorkingDay: true,
        label: '调休工作日',
        attendanceGroups: 'day-shift',
        roles: '',
        roleTags: '',
        userIds: '',
        userNames: '',
        excludeUserIds: '',
        excludeUserNames: '',
      },
    )

    const config = {
      addCalendarPolicyOverride: vi.fn(),
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
      removeCalendarPolicyOverride: vi.fn(),
      removeHolidayOverride: vi.fn(),
      saveSettings: vi.fn(),
      settingsForm,
      settingsLoading: { value: false },
      syncHolidays: vi.fn(),
      syncHolidaysForYears: vi.fn(),
    } as HolidayConfig

    app = createApp(AttendanceHolidayRuleSection, {
      attendanceGroupOptions: ['day-shift'],
      config,
      formatDateTime,
      tr,
    })
    app.mount(container!)
    await flushUi()

    const diagnostics = container!.querySelector('[data-attendance-calendar-policy-diagnostics]')
    expect(diagnostics).toBeTruthy()
    expect(diagnostics?.textContent).toContain('日历规则检查')
    expect(diagnostics?.textContent).toContain('第 1 条规则不会被保存')
    expect(diagnostics?.textContent).toContain('第 2 条规则与第 3 条规则')
    expect(container!.querySelector('[data-calendar-policy-diagnostic="missing_scope"]')).toBeTruthy()
    expect(container!.querySelector('[data-calendar-policy-diagnostic="shadowed_same_source"]')).toBeTruthy()
  })

  it('shows the auto-sync timezone as a select with UTC offset labels', async () => {
    const settingsForm = reactive<HolidaySettingsState>(createDefaultSettings())

    const config = {
      addCalendarPolicyOverride: vi.fn(),
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
      removeCalendarPolicyOverride: vi.fn(),
      removeHolidayOverride: vi.fn(),
      saveSettings: vi.fn(),
      settingsForm,
      settingsLoading: { value: false },
      syncHolidays: vi.fn(),
      syncHolidaysForYears: vi.fn(),
    } as HolidayConfig

    app = createApp(AttendanceHolidayRuleSection, {
      attendanceGroupOptions: [],
      config,
      formatDateTime,
      tr,
    })
    app.mount(container!)
    await flushUi()

    const timezoneSelect = container!.querySelector<HTMLSelectElement>('#attendance-holiday-sync-auto-tz')
    expect(timezoneSelect).toBeTruthy()
    expect(timezoneSelect!.selectedOptions[0]?.textContent).toContain('Asia/Shanghai (UTC+08:00)')
    expect(Array.from(timezoneSelect!.querySelectorAll('optgroup')).map((group) => group.label)).toContain('常用时区')
  })
})
