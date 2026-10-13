import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AttendanceCalendarPolicyQuickAdd from '../src/views/attendance/AttendanceCalendarPolicyQuickAdd.vue'

function flushUi(cycles = 4): Promise<void> {
  return Promise.all(Array.from({ length: cycles }).map(() => Promise.resolve().then(() => nextTick()))).then(
    () => undefined,
  )
}

function setInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  expect(input, `expected input ${selector}`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
}

function fieldLabel(container: HTMLElement, selector: string): string {
  const input = container.querySelector(selector)
  const label = input?.closest('label')?.querySelector('span')?.textContent?.trim() ?? ''
  expect(label).not.toBe('')
  return label
}

function mountQuickAdd(tr: (en: string, zh: string) => string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(AttendanceCalendarPolicyQuickAdd, {
    attendanceGroupOptions: ['单休办公'],
    tr,
  })
  app.mount(container)
  return { app, container }
}

describe('AttendanceCalendarPolicyQuickAdd copy', () => {
  let app: App<Element> | null = null
  let container: HTMLElement | null = null

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('names base and target rest days when the form is incomplete', async () => {
    ;({ app, container } = mountQuickAdd((en) => en))
    await flushUi()

    const status = container!.querySelector('[data-calendar-policy-quick-status]')?.textContent ?? ''
    const baseLabel = fieldLabel(container!, '[data-calendar-policy-quick-base-days]')
    const targetLabel = fieldLabel(container!, '[data-calendar-policy-quick-target-days]')
    expect(baseLabel).toBe('Base rest days')
    expect(targetLabel).toBe('Target rest days')
    expect(status.toLowerCase()).toContain(baseLabel.toLowerCase())
    expect(status.toLowerCase()).toContain(targetLabel.toLowerCase())
    expect(status).not.toContain('valid day counts')
    expect(status).toContain('Fill a holiday name, attendance group, base rest days, and target rest days before adding a rule.')
  })

  it('uses the same rest-day names in Chinese, including the longer-rest start date', async () => {
    ;({ app, container } = mountQuickAdd((_en, zh) => zh))
    await flushUi()

    const baseLabel = fieldLabel(container!, '[data-calendar-policy-quick-base-days]')
    const targetLabel = fieldLabel(container!, '[data-calendar-policy-quick-target-days]')
    const startLabel = fieldLabel(container!, '[data-calendar-policy-quick-base-start-date]')
    expect(baseLabel).toBe('基础休息天数')
    expect(targetLabel).toBe('目标休息天数')
    expect(startLabel).toBe('基础休息起始日期')

    const shortStatus = container!.querySelector('[data-calendar-policy-quick-status]')?.textContent ?? ''
    expect(shortStatus).toContain(baseLabel)
    expect(shortStatus).toContain(targetLabel)
    expect(shortStatus).not.toContain('有效天数')
    expect(shortStatus).toBe('请先填写节假日名称、考勤组、基础休息天数和目标休息天数。')

    setInput(container!, '[data-calendar-policy-quick-holiday]', '')
    setInput(container!, '[data-calendar-policy-quick-target-days]', '8')
    await flushUi()

    const longStatus = container!.querySelector('[data-calendar-policy-quick-status]')?.textContent ?? ''
    expect(longStatus).toContain(baseLabel)
    expect(longStatus).toContain(targetLabel)
    expect(longStatus).toContain(startLabel)
    expect(longStatus).not.toContain('有效天数')
    expect(longStatus).toBe('请先填写节假日名称、考勤组、基础休息天数、目标休息天数和有效的基础休息起始日期。')
  })
})
