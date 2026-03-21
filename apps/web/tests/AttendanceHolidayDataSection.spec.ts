import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, reactive, type App, type Ref, ref, nextTick } from 'vue'
import AttendanceHolidayDataSection from '../src/views/attendance/AttendanceHolidayDataSection.vue'
import type { AttendanceHoliday } from '../src/views/attendance/useAttendanceAdminScheduling'

type HolidayFormState = {
  date: string
  name: string
  isWorkingDay: boolean
}

type HolidayBindings = {
  holidays: Ref<AttendanceHoliday[]>
  holidayTotal: Ref<number>
  holidayLoading: Ref<boolean>
  holidaySaving: Ref<boolean>
  holidayEditingId: Ref<string | null>
  holidayRange: {
    from: string
    to: string
  }
  holidayForm: HolidayFormState
  resetHolidayForm: () => Promise<void> | void
  editHoliday: () => Promise<void> | void
  loadHolidays: () => Promise<void> | void
  saveHoliday: () => Promise<void> | void
  deleteHoliday: () => Promise<void> | void
}

function toDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick()).then(() => nextTick())
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function findCalendarDayButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('.attendance__holiday-cell')
  expect(button, 'expected at least one calendar day button').toBeTruthy()
  return button as HTMLButtonElement
}

describe('AttendanceHolidayDataSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en
  const formatDate = (value: string | null | undefined) => (value ? `formatted:${value}` : '--')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps the selected date inside the visible month when navigating prev, next, and current month', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'))

    const loadHolidays = vi.fn(async () => undefined)
    const holidayBindings: HolidayBindings = {
      holidays: ref([]),
      holidayTotal: ref(0),
      holidayLoading: ref(false),
      holidaySaving: ref(false),
      holidayEditingId: ref(null),
      holidayRange: reactive({
        from: '2026-03-01',
        to: '2026-03-31',
      }),
      holidayForm: reactive({
        date: '2026-03-15',
        name: '',
        isWorkingDay: false,
      }),
      resetHolidayForm: vi.fn(),
      editHoliday: vi.fn(),
      loadHolidays,
      saveHoliday: vi.fn(),
      deleteHoliday: vi.fn(),
    }

    app = createApp(AttendanceHolidayDataSection, {
      holiday: holidayBindings,
      formatDate,
      tr,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Selected date')
    expect(container!.textContent).toContain('formatted:2026-03-15')

    findButton(container!, 'Previous month').click()
    await flushUi()
    expect(holidayBindings.holidayRange.from).toBe('2026-02-01')
    expect(holidayBindings.holidayRange.to).toBe('2026-02-28')
    expect(holidayBindings.holidayForm.date).toBe('2026-02-01')
    expect(container!.textContent).toContain('formatted:2026-02-01')
    expect(container!.textContent).toContain('2026-02')

    findButton(container!, 'Next month').click()
    await flushUi()
    expect(holidayBindings.holidayRange.from).toBe('2026-03-01')
    expect(holidayBindings.holidayRange.to).toBe('2026-03-31')
    expect(holidayBindings.holidayForm.date).toBe('2026-03-01')
    expect(container!.textContent).toContain('formatted:2026-03-01')
    expect(container!.textContent).toContain('2026-03')

    findButton(container!, 'Current month').click()
    await flushUi()
    const today = toDateInput(new Date())
    expect(holidayBindings.holidayRange.from).toBe('2026-04-01')
    expect(holidayBindings.holidayRange.to).toBe('2026-04-30')
    expect(holidayBindings.holidayForm.date).toBe(today)
    expect(container!.textContent).toContain(`formatted:${today}`)
    expect(container!.textContent).toContain('2026-04')
    expect(loadHolidays).toHaveBeenCalled()
  })

  it('shows loading feedback for the visible month and disables calendar day buttons while loading', async () => {
    const holidayBindings: HolidayBindings = {
      holidays: ref([]),
      holidayTotal: ref(0),
      holidayLoading: ref(true),
      holidaySaving: ref(false),
      holidayEditingId: ref(null),
      holidayRange: reactive({
        from: '2026-03-01',
        to: '2026-03-31',
      }),
      holidayForm: reactive({
        date: '2026-03-15',
        name: '',
        isWorkingDay: false,
      }),
      resetHolidayForm: vi.fn(),
      editHoliday: vi.fn(),
      loadHolidays: vi.fn(),
      saveHoliday: vi.fn(),
      deleteHoliday: vi.fn(),
    }

    app = createApp(AttendanceHolidayDataSection, {
      holiday: holidayBindings,
      formatDate,
      tr,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Loading month...')
    expect(container!.querySelector('.attendance__holiday-layout')?.getAttribute('aria-busy')).toBe('true')
    expect(findButton(container!, 'Previous month').disabled).toBe(true)
    expect(findButton(container!, 'Current month').disabled).toBe(true)
    expect(findButton(container!, 'Next month').disabled).toBe(true)
    expect(findButton(container!, 'Loading...').disabled).toBe(true)
    expect(findCalendarDayButton(container!).disabled).toBe(true)

    holidayBindings.holidayLoading.value = false
    await flushUi()

    expect(container!.textContent).not.toContain('Loading month...')
    expect(container!.querySelector('.attendance__holiday-layout')?.getAttribute('aria-busy')).toBe('false')
    expect(findButton(container!, 'Previous month').disabled).toBe(false)
    expect(findButton(container!, 'Current month').disabled).toBe(false)
    expect(findButton(container!, 'Next month').disabled).toBe(false)
    expect(findButton(container!, 'Reload holidays').disabled).toBe(false)
    expect(findCalendarDayButton(container!).disabled).toBe(false)
  })
})
