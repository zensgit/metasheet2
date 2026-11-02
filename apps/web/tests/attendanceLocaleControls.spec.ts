import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
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
  it('accepts only a trusted name bound to the queried ID, including a real name=id', () => {
    expect(formatAnnualBalanceSubject('test-operator-stockprep', { id: 'test-operator-stockprep', name: '备料一线测试账号' }, tr)).toBe('备料一线测试账号（ID: test-operator-stockprep）')
    expect(formatAnnualBalanceSubject('userA', null, tr)).toBe('未命名员工（ID: userA）')
    expect(formatAnnualBalanceSubject('userA', { id: 'userB', name: 'Bob' }, tr)).toBe('未命名员工（ID: userA）')
    expect(formatAnnualBalanceSubject('userA', { id: 'userA', name: 'userA' }, tr)).toBe('userA（ID: userA）')
    expect(formatAnnualBalanceSubject('userA', { id: 'userA', name: '  ' })).toBe('Unnamed employee（ID: userA）')
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


describe('locale date input native constraints', () => {
  async function mountDate(attrs: Record<string, unknown> = {}) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const changes: string[] = []
    const inputs: Event[] = []
    const state = reactive<Record<string, unknown> & { modelValue: string }>({ modelValue: '2026-10-12', ...attrs })
    const app = createApp({
      render: () => h(AttendanceLocaleDateInput, {
        ...state,
        'onUpdate:modelValue': (value: string) => { changes.push(value); state.modelValue = value },
        onInput: (event: Event) => inputs.push(event),
      }),
    })
    app.mount(container)
    await flush()
    return { container, state, changes, inputs, dispose: () => { app.unmount(); container.remove() } }
  }


  it('closes the calendar when focus leaves but keeps internal calendar navigation usable', async () => {
    const mounted = await mountDate()
    const nextField = document.createElement('input')
    document.body.appendChild(nextField)
    try {
      const input = mounted.container.querySelector('input')!
      input.focus()
      await flush()
      expect(mounted.container.querySelector('[data-attendance-locale-date-popup]')).not.toBeNull()
      mounted.container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.focus()
      await flush()
      expect(mounted.container.querySelector('[data-attendance-locale-date-popup]')).not.toBeNull()
      nextField.focus()
      await flush()
      expect(mounted.container.querySelector('[data-attendance-locale-date-popup]')).toBeNull()
      expect(mounted.changes).toEqual([])
      expect(mounted.inputs).toEqual([])
    } finally { nextField.remove(); mounted.dispose() }
  })

  it.each(['disabled', 'readonly'])('blocks text, focus and calendar actions when %s', async (constraint) => {
    const mounted = await mountDate({ [constraint]: true })
    try {
      const input = mounted.container.querySelector('input')!
      const calendar = mounted.container.querySelector<HTMLButtonElement>('.attendance-locale-date__button')!
      expect(constraint === 'disabled' ? input.disabled : input.readOnly).toBe(true)
      expect(calendar.disabled).toBe(true)
      calendar.click()
      input.dispatchEvent(new Event('focus'))
      input.value = '2026-10-13'
      input.dispatchEvent(new Event('input'))
      await flush()
      expect(mounted.container.querySelector('[data-attendance-locale-date-popup]')).toBeNull()
      expect(mounted.changes).toEqual([])
      expect(mounted.inputs).toEqual([])
    } finally { mounted.dispose() }
  })

  it.each(['disabled', 'readonly'])('closes an open calendar and blocks a queued selection when %s changes', async (constraint) => {
    const mounted = await mountDate({ [constraint]: false })
    try {
      mounted.container.querySelector<HTMLButtonElement>('.attendance-locale-date__button')!.click()
      await flush()
      const date = mounted.container.querySelector<HTMLButtonElement>('[data-date="2026-10-13"]')!
      expect(date).toBeTruthy()
      mounted.state[constraint] = true
      await flush()
      const input = mounted.container.querySelector('input')!
      expect(constraint === 'disabled' ? input.disabled : input.readOnly).toBe(true)
      expect(mounted.container.querySelector('[data-attendance-locale-date-popup]')).toBeNull()
      date.click()
      await flush()
      expect(mounted.container.querySelector('[data-attendance-locale-date-popup]')).toBeNull()
      expect(mounted.changes).toEqual([])
      expect(mounted.inputs).toEqual([])
    } finally { mounted.dispose() }
  })

  it('keeps enabled text and calendar changes emitting the ISO date and input event', async () => {
    const mounted = await mountDate({ disabled: false, readonly: false })
    try {
      const input = mounted.container.querySelector('input')!
      input.value = '2026-10-14'
      input.dispatchEvent(new Event('input'))
      await flush()
      input.dispatchEvent(new Event('focus'))
      await flush()
      mounted.container.querySelector<HTMLButtonElement>('[data-date="2026-10-13"]')!.click()
      await flush()
      expect(mounted.changes).toEqual(['2026-10-14', '2026-10-13'])
      expect(mounted.inputs).toHaveLength(2)
      expect(mounted.inputs.every(event => event.type === 'input')).toBe(true)
    } finally { mounted.dispose() }
  })

  it('disables calendar dates outside min/max and preserves text range validity including both boundaries', async () => {
    const mounted = await mountDate({ min: '2026-10-12', max: '2026-10-14' })
    try {
      const input = mounted.container.querySelector('input')!
      mounted.container.querySelector<HTMLButtonElement>('.attendance-locale-date__button')!.click()
      await flush()
      for (const date of ['2026-10-11', '2026-10-15']) {
        const button = mounted.container.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!
        expect(button.disabled).toBe(true)
        button.click()
      }
      expect(mounted.changes).toEqual([])
      mounted.container.querySelector<HTMLButtonElement>('[data-date="2026-10-14"]')!.click()
      await flush()
      expect(mounted.changes).toEqual(['2026-10-14'])
      const native = document.createElement('input')
      native.type = 'date'
      native.min = '2026-10-12'
      native.max = '2026-10-14'
      for (const [value, valid] of [['2026-10-11', false], ['2026-10-15', false], ['2026-10-12', true], ['2026-10-14', true], ['', true]] as const) {
        input.value = value
        input.dispatchEvent(new Event('input'))
        await flush()
        native.value = value
        expect(native.checkValidity(), value).toBe(valid)
        expect(input.checkValidity(), value).toBe(native.checkValidity())
      }
      mounted.state.min = '2026-10-15'
      mounted.state.modelValue = '2026-10-14'
      await flush()
      expect(input.checkValidity()).toBe(false)
    } finally { mounted.dispose() }
  })
})
