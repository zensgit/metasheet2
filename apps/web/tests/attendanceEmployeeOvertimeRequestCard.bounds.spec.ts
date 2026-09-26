import { createApp, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AttendanceEmployeeOvertimeRequestCard from '../src/views/attendance/AttendanceEmployeeOvertimeRequestCard.vue'

describe('dedicated overtime card rule bounds', () => {
  let app: App<Element> | undefined
  let root: HTMLDivElement | undefined
  afterEach(() => { app?.unmount(); root?.remove() })

  it('shows the selected rule min/max as a hard limit', () => {
    const form = {
      overtimeRuleId: 'weekday',
      workDate: '2026-09-23',
      requestedInAt: '',
      requestedOutAt: '',
      minutes: '10',
      reason: '',
    }
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AttendanceEmployeeOvertimeRequestCard, {
      tr: (en: string) => en,
      requestForm: form,
      overtimeRules: [{
        id: 'weekday',
        name: 'Weekday OT',
        minMinutes: 30,
        roundingMinutes: 15,
        maxMinutesPerDay: 600,
      }],
      submitting: false,
    })
    app.mount(root)
    const hint = root.querySelector('[data-overtime-card-bounds]')
    expect(hint?.textContent).toContain('30–600')
    expect(hint?.textContent).toContain('rejected')
  })
})
