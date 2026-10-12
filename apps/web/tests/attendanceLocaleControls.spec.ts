import { describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import AttendanceAnnualPolicyHelp from '../src/views/attendance/AttendanceAnnualPolicyHelp.vue'
import AttendanceLocaleDateInput from '../src/views/attendance/AttendanceLocaleDateInput.vue'
import AttendanceWeekdayChipField from '../src/views/attendance/AttendanceWeekdayChipField.vue'
import { formatAnnualBalanceSubject } from '../src/views/attendance/annualBalanceSubject'
import { useLocale } from '../src/composables/useLocale'

const tr = (en: string, zh: string) => zh

async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('annual balance subject', () => {
  it('puts the picker display name beside the short id', () => {
    expect(formatAnnualBalanceSubject('test-operator-stockprep', '备料一线测试账号')).toBe('备料一线测试账号（test-operator-stockprep）')
    expect(formatAnnualBalanceSubject('userA', '')).toBe('userA')
    expect(formatAnnualBalanceSubject('userA', 'userA')).toBe('userA')
  })
})

describe('annual policy help', () => {
  it('explains enable, tenure, timezone, carry-over, scheduler flags, and the ladder', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceAnnualPolicyHelp, { tr })
    app.mount(container)
    await flush()
    const help = container.querySelector('[data-attendance-help="annual-policy"]')
    expect(help?.textContent).toContain('考勤帮助')
    expect(help?.textContent).toContain('累计工龄')
    expect(help?.textContent).toContain('Asia/Shanghai')
    expect(help?.textContent).toContain('ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED')
    expect(help?.textContent).toContain('ATTENDANCE_SCHEDULER_ENABLED')
    expect(help?.querySelectorAll('.annual-policy-help__ladder li')).toHaveLength(3)
    expect(help?.textContent).toContain('2027-01-01')
    expect(help?.textContent).toContain('2028-01-01')
    app.unmount()
    container.remove()
  })
})

describe('weekday chips', () => {
  it('shows 周一 through 周日 and keeps the 0-6 csv', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)
    let value = '1,2,3,4,5'
    const app = createApp(AttendanceWeekdayChipField, {
      id: 'attendance-shift-working-days',
      modelValue: value,
      'onUpdate:modelValue': (next: string) => {
        value = next
      },
    })
    app.mount(container)
    await flush()
    expect(container.textContent).toContain('周一')
    expect(container.textContent).toContain('周日')
    expect(container.querySelector<HTMLInputElement>('#attendance-shift-working-days')?.value).toBe('1,2,3,4,5')
    container.querySelector<HTMLButtonElement>('[data-attendance-weekday="0"]')!.click()
    await flush()
    expect(value).toBe('0,1,2,3,4,5')
    useLocale().setLocale('en')
    app.unmount()
    container.remove()
  })
})

describe('locale date input', () => {
  it('keeps yyyy-mm-dd and shows Chinese calendar words', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)
    let value = '2026-10-12'
    const app = createApp(AttendanceLocaleDateInput, {
      id: 'attendance-from-date',
      modelValue: value,
      'onUpdate:modelValue': (next: string) => {
        value = next
      },
    })
    app.mount(container)
    await flush()
    const input = container.querySelector<HTMLInputElement>('#attendance-from-date')
    expect(input?.value).toBe('2026-10-12')
    expect(input?.placeholder).toBe('年-月-日')
    expect(input?.type).toBe('text')
    container.querySelector<HTMLButtonElement>('.attendance-locale-date__button')!.click()
    await flush()
    const popup = container.querySelector('[data-attendance-locale-date-popup]')
    expect(popup?.textContent).toContain('2026年10月')
    expect(popup?.textContent).toContain('清除')
    expect(popup?.textContent).toContain('今天')
    expect(popup?.textContent).toContain('一')
    container.querySelector<HTMLButtonElement>('[data-attendance-locale-date-clear]')!.click()
    await flush()
    expect(value).toBe('')
    useLocale().setLocale('en')
    app.unmount()
    container.remove()
  })

  it('stays a text field when a caller passes type=date', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceLocaleDateInput, {
      id: 'payroll-anchor',
      modelValue: '',
      type: 'date',
    })
    app.mount(container)
    await flush()
    const input = container.querySelector<HTMLInputElement>('#payroll-anchor')
    expect(input?.type).toBe('text')
    expect(input?.placeholder).toBe('年-月-日')
    expect(input?.placeholder).not.toContain('dd/mm')
    useLocale().setLocale('en')
    app.unmount()
    container.remove()
  })
})
