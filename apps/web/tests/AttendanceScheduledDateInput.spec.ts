import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AttendanceScheduledDateInput from '../src/views/attendance/AttendanceScheduledDateInput.vue'

const tr = (en: string, _zh: string) => en

const calendarDays = [
  {
    key: '2026-03-16',
    day: 16,
    isToday: false,
    isCurrentMonth: true,
    status: 'normal',
    statusLabel: 'Normal',
    tooltip: '2026-03-16 · Normal',
    holidayName: 'Rest day',
    lunarLabel: '二月初八',
  },
  {
    key: '2026-03-17',
    day: 17,
    isToday: true,
    isCurrentMonth: true,
    status: 'off',
    statusLabel: 'Off',
    tooltip: '2026-03-17 · Off',
    holidayName: 'Holiday',
    lunarLabel: '二月初九',
  },
] as const

describe('AttendanceScheduledDateInput', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('opens the schedule picker on double click and lets the user pick a date', async () => {
    const focusCalendarMonth = vi.fn().mockResolvedValue(undefined)
    const shiftMonth = vi.fn().mockResolvedValue(undefined)
    const modelValue = ref('2026-03-15')

    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp({
      setup() {
        return () => h(AttendanceScheduledDateInput as Component, {
          modelValue: modelValue.value,
          inputType: 'date',
          fieldId: 'attendance-request-work-date',
          fieldName: 'requestWorkDate',
          calendarDays,
          calendarLabel: 'March 2026',
          weekDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          shiftMonth,
          focusCalendarMonth,
          tr,
          'onUpdate:modelValue': (value: string) => {
            modelValue.value = value
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const input = container.querySelector('input') as HTMLInputElement | null
    expect(input?.type).toBe('date')
    input?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await nextTick()

    expect(focusCalendarMonth).toHaveBeenCalledWith('2026-03-15')
    expect(container.textContent).toContain('March 2026')
    expect(container.textContent).toContain('二月初八')
    expect(container.textContent).toContain('Rest day')

    const target = container.querySelector('button[title="2026-03-16 · Normal"]') as HTMLButtonElement | null
    expect(target).not.toBeNull()
    target?.click()
    await nextTick()

    expect(modelValue.value).toBe('2026-03-16')
    expect(container.querySelector('.attendance-date-input__overlay')).toBeNull()
    expect(shiftMonth).not.toHaveBeenCalled()
  })

  it('preserves the time portion when picking a datetime-local value', async () => {
    const focusCalendarMonth = vi.fn().mockResolvedValue(undefined)
    const shiftMonth = vi.fn().mockResolvedValue(undefined)
    const modelValue = ref('2026-03-15T08:30')

    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp({
      setup() {
        return () => h(AttendanceScheduledDateInput as Component, {
          modelValue: modelValue.value,
          inputType: 'datetime-local',
          fieldId: 'attendance-request-in',
          fieldName: 'requestedInAt',
          defaultTime: '09:00',
          calendarDays,
          calendarLabel: 'March 2026',
          weekDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          shiftMonth,
          focusCalendarMonth,
          tr,
          'onUpdate:modelValue': (value: string) => {
            modelValue.value = value
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const input = container.querySelector('input') as HTMLInputElement | null
    expect(input?.type).toBe('datetime-local')
    input?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await nextTick()

    const target = container.querySelector('button[title="2026-03-17 · Off"]') as HTMLButtonElement | null
    expect(target).not.toBeNull()
    target?.click()
    await nextTick()

    expect(modelValue.value).toBe('2026-03-17T08:30')
  })
})
