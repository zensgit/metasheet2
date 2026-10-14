import { describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import AttendanceAudienceChipField from '../src/views/attendance/AttendanceAudienceChipField.vue'
import AttendanceHolidayIndexHelp from '../src/views/attendance/AttendanceHolidayIndexHelp.vue'
import AttendanceLocaleTimeInput from '../src/views/attendance/AttendanceLocaleTimeInput.vue'
import { useLocale } from '../src/composables/useLocale'

const tr = (en: string, zh: string) => zh

async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('attendance audience chip field', () => {
  it('keeps a comma-separated string and shows chosen chips', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let value = '单休办公'
    const app = createApp(AttendanceAudienceChipField, {
      modelValue: value,
      options: ['单休办公', '白班'],
      placeholder: '选择或输入考勤组',
      tr,
      inputAttrs: { 'data-calendar-policy-override-attendance-groups': 'true' },
      'onUpdate:modelValue': (next: string) => {
        value = next
      },
    })
    app.mount(container)
    await flush()

    expect(container.textContent).toContain('单休办公')
    expect(container.querySelector<HTMLInputElement>('[data-calendar-policy-override-attendance-groups]')?.value).toBe('单休办公')
    const draft = container.querySelector<HTMLInputElement>('input[placeholder="选择或输入考勤组"]')
    expect(draft).toBeTruthy()
    draft!.value = '白班'
    draft!.dispatchEvent(new Event('input'))
    draft!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(value).toBe('单休办公,白班')

    app.unmount()
    container.remove()
  })
})

describe('holiday index help', () => {
  it('explains start, end, and list with the day strip', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceHolidayIndexHelp, { tr })
    app.mount(container)
    await flush()
    const help = container.querySelector('details')
    expect(help?.textContent).toContain('考勤帮助')
    expect(help?.textContent).toContain('起始填 4、结束填 5')
    expect(help?.textContent).toContain('1,2')
    expect(help?.querySelectorAll('.holiday-index-help__day')).toHaveLength(5)
    app.unmount()
    container.remove()
  })
})

describe('locale time input', () => {
  it('shows 上午/下午 in Chinese and keeps a 24-hour value', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)
    let value = '01:30'
    const app = createApp(AttendanceLocaleTimeInput, {
      id: 'attendance-auto-absence-run-at',
      modelValue: value,
      'onUpdate:modelValue': (next: string) => {
        value = next
      },
    })
    app.mount(container)
    await flush()

    expect(container.textContent).toContain('上午')
    expect(container.textContent).toContain('下午')
    expect(container.querySelector('input[type="time"]')).toBeNull()
    const period = container.querySelector<HTMLSelectElement>('[data-attendance-locale-time-period]')
    expect(period?.value).toBe('am')
    period!.value = 'pm'
    period!.dispatchEvent(new Event('change'))
    await flush()
    expect(value).toBe('13:30')

    useLocale().setLocale('en')
    app.unmount()
    container.remove()
  })
})
