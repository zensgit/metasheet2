import { describe, expect, it, vi } from 'vitest'
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

    draft!.value = ''
    draft!.dispatchEvent(new Event('input'))
    await flush()
    expect(container.querySelector('[data-attendance-search-empty]')).toBeNull()

    draft!.value = '没有这个'
    draft!.dispatchEvent(new Event('input'))
    await flush()
    expect(container.querySelector('[data-attendance-search-empty]')?.textContent).toContain('搜索不到')

    app.unmount()
    container.remove()
  })

  it('waits for a live search before showing 搜索不到', async () => {
    vi.useFakeTimers()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let resolveSearch: (hits: string[]) => void = () => {}
    const app = createApp(AttendanceAudienceChipField, {
      modelValue: '',
      options: [],
      tr,
      search: () => new Promise<string[]>((resolve) => { resolveSearch = resolve }),
    })
    try {
      app.mount(container)
      await flush()
      const draft = container.querySelector<HTMLInputElement>('input[type="text"]')!
      draft.focus()
      await flush()
      expect(container.querySelector('[data-attendance-search-empty]')).toBeNull()

      draft.value = '张'
      draft.dispatchEvent(new Event('input'))
      await flush()
      expect(container.querySelector('[data-attendance-search-empty]')).toBeNull()

      await vi.advanceTimersByTimeAsync(250)
      await flush()
      expect(container.querySelector('[data-attendance-search-empty]')).toBeNull()

      resolveSearch([])
      for (let i = 0; i < 4; i += 1) await flush()
      expect(container.querySelector('[data-attendance-search-empty]')?.textContent).toContain('搜索不到')
    } finally {
      app.unmount()
      container.remove()
      vi.useRealTimers()
    }
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
  it('shows one 24-hour field and a read-only 上午/下午 hint', async () => {
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

    const typed = container.querySelector<HTMLInputElement>('[data-attendance-locale-time-typed]')
    expect(typed?.value).toBe('01:30')
    expect(typed?.getAttribute('aria-label')).toContain('24 小时')
    expect(container.querySelector('[data-attendance-locale-time-hint]')?.textContent).toBe('上午')
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('[data-attendance-locale-time-period]')).toBeNull()
    expect(container.querySelector('input[type="time"]')).toBeNull()

    typed!.value = '18:00'
    typed!.dispatchEvent(new Event('change'))
    await flush()
    expect(value).toBe('18:00')
    expect(typed!.value).toBe('18:00')
    expect(container.querySelector('[data-attendance-locale-time-hint]')?.textContent).toBe('下午')

    typed!.value = '9:05'
    typed!.dispatchEvent(new Event('change'))
    await flush()
    expect(value).toBe('09:05')
    expect(typed!.value).toBe('09:05')
    expect(container.querySelector('[data-attendance-locale-time-hint]')?.textContent).toBe('上午')

    useLocale().setLocale('en')
    app.unmount()
    container.remove()
  })
})
