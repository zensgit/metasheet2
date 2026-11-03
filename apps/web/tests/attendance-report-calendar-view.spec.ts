import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) }) as Response
async function flushUi() {
  for (let i = 0; i < 25; i += 1) { await Promise.resolve(); await nextTick() }
}

describe('report calendar uses loaded record timezone', () => {
  let app: App<Element> | undefined
  let container: HTMLDivElement
  let zones: Array<string | null>
  let releaseRecords: (() => void) | undefined
  let heldRecords: Promise<void> | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T01:30:00Z'))
    localStorage.clear()
    localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance?tab=reports')
    zones = ['America/Los_Angeles']
    heldRecords = undefined
    releaseRecords = undefined
    vi.mocked(apiFetch).mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/records?')) {
        if (heldRecords) await heldRecords
        return response({ items: zones.map((zone, index) => ({
          id: `calendar-record-${index}`, work_date: '2026-02-28', status: 'normal',
          work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, meta: {},
          ...(zone === null ? {} : { workday_context: { timezone: zone } }),
        })), total: zones.length })
      }
      if (url.includes('/summary?')) return response({ total_days: 1, total_minutes: 480, normal_days: 1 })
      return response({ items: [], total: 0 })
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => { app?.unmount(); container.remove(); vi.useRealTimers(); app = undefined })
  const mount = async () => { app = createApp(AttendanceView, { mode: 'reports' }); app.mount(container); await flushUi() }
  const range = () => ({
    from: container.querySelector<HTMLInputElement>('#attendance-from-date')!.value,
    to: container.querySelector<HTMLInputElement>('#attendance-to-date')!.value,
  })
  const preset = (id: string) => container.querySelector<HTMLButtonElement>(`[data-report-filter-value="${id}"]`)!
  const urls = () => vi.mocked(apiFetch).mock.calls.map(call => String(call[0]))

  it('aligns the pristine default and reloads all aggregates on the IANA calendar', async () => {
    await mount()
    expect(range()).toEqual({ from: '2026-01-29', to: '2026-02-28' })
    for (const endpoint of ['summary', 'records', 'reports/requests']) {
      const url = urls().filter(url => url.includes(`/api/attendance/${endpoint}?`)).at(-1)!
      const params = new URL(url, 'https://test.invalid').searchParams
      expect([params.get('from'), params.get('to')]).toEqual(['2026-01-29', '2026-02-28'])
    }
    expect(container.querySelector('[data-report-calendar-basis]')?.textContent).toContain('America/Los_Angeles')
    expect(urls().some(url => url.includes('/rules/me'))).toBe(false)
  })

  it.each([
    ['this-week', '2026-02-23', '2026-03-01'],
    ['this-month', '2026-02-01', '2026-02-28'],
    ['last-month', '2026-01-01', '2026-01-31'],
    ['this-quarter', '2026-01-01', '2026-03-31'],
  ])('applies %s using the record zone before clearing records', async (id, from, to) => {
    await mount()
    vi.mocked(apiFetch).mockClear()
    expect(preset(id).disabled).toBe(false)
    preset(id).click()
    await flushUi()
    expect(range()).toEqual({ from, to })
    expect(urls().some(url => url.includes(`/summary?from=${from}&to=${to}`))).toBe(true)
    expect(container.querySelector('[data-report-calendar-basis]')?.textContent).toContain('America/Los_Angeles')
  })

  it.each([
    [[]], [[null]], [['Not/AZone']], [['Asia/Shanghai', 'America/Los_Angeles']], [['Asia/Shanghai', null]],
  ] as Array<[Array<string | null>]>)('disables presets for unresolved zones %j and names the browser default', async input => {
    zones = input
    await mount()
    const before = range()
    vi.mocked(apiFetch).mockClear()
    expect(preset('this-month').disabled).toBe(true)
    preset('this-month').click()
    await flushUi()
    expect(range()).toEqual(before)
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container.querySelector('[data-report-calendar-basis]')?.textContent).toContain('browser calendar')
    expect(container.querySelector('[data-report-calendar-unavailable]')?.textContent).toContain('Choose dates manually')
  })

  it('does not overwrite manually edited dates while record context is loading', async () => {
    heldRecords = new Promise<void>(resolve => { releaseRecords = resolve })
    await mount()
    for (const [id, value] of [['from', '2026-01-05'], ['to', '2026-01-07']]) {
      const input = container.querySelector<HTMLInputElement>(`#attendance-${id}-date`)!
      input.value = value; input.dispatchEvent(new Event('input'))
    }
    await flushUi()
    releaseRecords!()
    await flushUi()
    expect(range()).toEqual({ from: '2026-01-05', to: '2026-01-07' })
    expect(container.querySelector('[data-report-calendar-basis]')?.textContent).toContain('Manually selected dates')
    expect(urls().filter(url => url.includes('/summary?'))).toHaveLength(1)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="attendance-export-xlsx"]')!.disabled).toBe(true)
    expect(preset('this-month').disabled).toBe(false)
  })
  it('aligns a still-pristine browser default when a later reload resolves the record zone', async () => {
    zones = [null]
    await mount()
    expect(container.querySelector('[data-report-calendar-basis]')?.textContent).toContain('browser calendar')
    zones = ['America/Los_Angeles']
    container.querySelector<HTMLButtonElement>('.attendance__filters > button.attendance__btn')!.click()
    await flushUi()
    expect(range()).toEqual({ from: '2026-01-29', to: '2026-02-28' })
    expect(preset('this-month').disabled).toBe(false)
  })

  it('does not reuse the previous filter timezone for a newly typed target', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('#attendance-user-id')!
    input.value = 'another-report-target'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    vi.mocked(apiFetch).mockClear()
    expect(preset('this-month').disabled).toBe(true)
    preset('this-month').click()
    await flushUi()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('does not align a pending target using records from the previous filter', async () => {
    heldRecords = new Promise<void>(resolve => { releaseRecords = resolve })
    await mount()
    const before = range()
    const input = container.querySelector<HTMLInputElement>('#attendance-user-id')!
    input.value = 'changed-during-load'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    releaseRecords!()
    await flushUi()
    expect(range()).toEqual(before)
    expect(urls().filter(url => url.includes('/summary?'))).toHaveLength(1)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="attendance-export-xlsx"]')!.disabled).toBe(true)
    expect(preset('this-month').disabled).toBe(true)
  })

  it('allows a calendar shortcut to replace a manually edited range for the same target', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('#attendance-from-date')!
    input.value = '2026-01-05'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    expect(preset('this-month').disabled).toBe(false)
    preset('this-month').click()
    await flushUi()
    expect(range()).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="attendance-export-xlsx"]')!.disabled).toBe(false)
  })

})
