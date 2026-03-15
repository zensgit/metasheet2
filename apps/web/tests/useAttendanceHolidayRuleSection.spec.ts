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

interface HolidaySettingsState {
  holidayFirstDayEnabled: boolean
  holidayFirstDayBaseHours: number
  holidayOvertimeAdds: boolean
  holidayOvertimeSource: 'approval' | 'clock' | 'both'
  holidayOverrides: HolidayOverrideState[]
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
  addHolidayOverride: () => void
  holidaySyncLastRun: { value: null }
  holidaySyncLoading: { value: boolean }
  removeHolidayOverride: (index: number) => void
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
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
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
      addHolidayOverride: vi.fn(),
      holidaySyncLastRun: { value: null },
      holidaySyncLoading: { value: false },
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
})
