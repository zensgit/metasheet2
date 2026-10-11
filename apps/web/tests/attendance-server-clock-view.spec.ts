import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { ATTENDANCE_RULES_ME_OMIT_HEADERS } from '../src/views/attendance/rulesMeContract'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null), fetchPlugins: async () => {} }),
}))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: async () => 'clock-user', buildAuthHeaders: () => ({}) }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

function response(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 24; i += 1) { await Promise.resolve(); await nextTick() }
}

describe('AttendanceView server clock and aligned rules', () => {
  let app: App | null
  let container: HTMLDivElement
  let mono: number
  let serverEpoch: number
  let principal: string
  let hidden: boolean
  let zone: string
  let rulesReply: (url: URL) => Promise<Response>
  const requests: URL[] = []
  function rules(url: URL, extra: Record<string, unknown> = {}) {
    return { resolvedAt: new Date(serverEpoch + mono).toISOString(),
      resolvedForDate: url.searchParams.get('asOf') ?? new Date(serverEpoch + mono).toISOString().slice(0, 10),
      runtimeRule: { timezone: zone, workStartTime: '09:00', workEndTime: '18:00' },
      assignment: { attendanceGroups: [{ name: 'aligned-group', timezone: 'America/New_York' }], scheduleGroups: [] },
      ...extra }
  }
  function time() { return container.querySelector('[data-testid="attendance-hero-time"]')?.textContent }
  function timezone() { return container.querySelector('[data-attendance-hero-timezone]')?.textContent }
  function button(label: string) {
    const found = [...container.querySelectorAll('button')].find(el => el.textContent?.trim() === label)
    expect(found, label).toBeTruthy()
    return found as HTMLButtonElement
  }
  async function mount(mode = 'overview') {
    app = createApp(AttendanceView, { mode })
    app.provide(attendanceSessionGuardKey, createAttendanceSessionGuard('', () => principal))
    app.mount(container)
    await flush()
  }
  async function tick(ms: number) {
    mono += ms
    await vi.advanceTimersByTimeAsync(ms)
    await flush()
  }
  function visibility(value: boolean) {
    hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  }
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-04-20T20:00:00Z'))
    mono = 100
    serverEpoch = Date.parse('2026-04-15T02:00:00.000Z') - mono
    principal = 'first-session'
    hidden = false
    zone = 'Asia/Shanghai'
    requests.length = 0
    app = null
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    HTMLElement.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
    localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    container = document.createElement('div')
    document.body.append(container)
    rulesReply = async url => response({ ok: true, data: rules(url) })
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, 'http://fixture.invalid')
      requests.push(url)
      if (url.pathname === '/api/attendance/rules/me') return rulesReply(url)
      if (url.pathname === '/api/attendance/records') return response({ ok: true, data: { items: [], total: 2 } })
      if (url.pathname === '/api/attendance/summary') return response({ ok: true, data: null })
      return response({ ok: true, data: { items: [], total: 0 } })
    })
  })
  afterEach(() => {
    app?.unmount()
    container.remove()
    useLocale().setLocale('en')
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each(['2026-04-20T20:00:00Z', '2026-04-10T01:00:00Z'])('ignores browser hours/days and in-page wall-time changes: %s', async device => {
    vi.setSystemTime(new Date(device))
    await mount()
    expect(time()).toBe('10:00:00')
    expect(timezone()).toBe('Attendance timezone: Asia/Shanghai')
    expect(container.textContent).toContain('2026-04-15')
    const today = requests.filter(url => url.pathname === '/api/attendance/records' && url.searchParams.get('pageSize') === '1')
    expect(today.map(url => [url.searchParams.get('from'), url.searchParams.get('to')])).toEqual([['2026-04-15', '2026-04-15']])
    vi.setSystemTime(new Date('2026-05-20T00:00:00Z'))
    await tick(1_000)
    expect(time()).toBe('10:00:01')
    expect(requests.filter(url => url.pathname === '/api/attendance/records' && url.searchParams.get('pageSize') === '1')).toHaveLength(1)
  })
  it.each([undefined, 'invalid'])('missing/malformed server sample %s stays unavailable, ordinary punch still submits without timezone/time', async sample => {
    rulesReply = async url => response({ ok: true, data: rules(url, { resolvedAt: sample }) })
    await mount()
    expect(time()).toBe('Server time unavailable')
    expect(timezone()).toBe('Attendance timezone unavailable')
    const punch = container.querySelector('[data-testid="attendance-hero-punch"] button') as HTMLButtonElement
    expect(punch.disabled).toBe(false)
    punch.click()
    await flush()
    const call = vi.mocked(apiFetch).mock.calls.find(([input]) => String(input).endsWith('/api/attendance/punch'))
    expect(call).toBeTruthy()
    const body = JSON.parse(String(call![1]?.body))
    expect(body).not.toHaveProperty('timezone')
    expect(body).not.toHaveProperty('occurredAt')
    expect(body).not.toHaveProperty('occurred_at')
  })
  it.each(['Asia/Tokyo', 'Asia/Singapore'])('aligns UTC previous-day rules once in %s with complete header omissions', async timezone => {
    zone = timezone
    serverEpoch = Date.parse('2026-04-14T16:30:00Z') - mono
    await mount()
    const calls = vi.mocked(apiFetch).mock.calls.filter(([input]) => String(input).includes('/api/attendance/rules/me'))
    expect(calls.map(([url]) => url)).toEqual(['/api/attendance/rules/me', '/api/attendance/rules/me?asOf=2026-04-15'])
    for (const [, options] of calls) expect(options?.omitHeaders).toEqual(ATTENDANCE_RULES_ME_OMIT_HEADERS)
    expect(time()).toBe(timezone === 'Asia/Tokyo' ? '01:30:00' : '00:30:00')
    expect(container.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('aligned-group')
    expect(container.textContent).not.toContain('Attendance timezone: America/New_York')
  })
  it('bounds timezone oscillation to two legs and never publishes an unaligned explicit punch timezone', async () => {
    serverEpoch = Date.parse('2026-04-14T16:30:00Z') - mono
    let count = 0
    rulesReply = async url => response({ ok: true, data: rules(url, {
      runtimeRule: { timezone: ++count === 1 ? 'Asia/Tokyo' : 'America/Los_Angeles' },
    }) })
    await mount()
    expect(count).toBe(2)
    expect(timezone()).toBe('Attendance timezone unavailable')
    expect(container.querySelector('[data-selfservice-card="rules"]')?.textContent).not.toContain('aligned-group')
    await tick(1_000)
    expect(count).toBe(2)
  })
  it('checks processing-time midnight before publishing a delayed body', async () => {
    serverEpoch = Date.parse('2026-04-15T15:59:59Z') - mono
    const body = deferred<unknown>()
    let count = 0
    rulesReply = async url => ++count === 1
      ? { ok: true, status: 200, json: () => body.promise } as Response
      : response({ ok: true, data: rules(url) })
    await mount()
    mono += 2_000
    body.resolve({ ok: true, data: { resolvedAt: '2026-04-15T15:59:59.000Z', resolvedForDate: '2026-04-15', runtimeRule: { timezone: zone } } })
    await flush()
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me').map(url => url.searchParams.get('asOf'))).toEqual([null, '2026-04-16'])
    expect(time()).toBe('00:00:01')
  })
  it.each([[5_000, true], [5_001, false]])('applies the actual mounted RTT bound %s', async (delay, accepted) => {
    rulesReply = async url => {
      mono += Number(delay)
      return response({ ok: true, data: rules(url) })
    }
    await mount()
    expect(time()).toBe(accepted ? '10:00:05' : 'Server time unavailable')
    expect(timezone()).toBe(accepted ? 'Attendance timezone: Asia/Shanghai' : 'Attendance timezone unavailable')
  })
  it('a corrective response arriving after BFCache recovery cannot publish its old timezone', async () => {
    serverEpoch = Date.parse('2026-04-14T16:30:00Z') - mono
    const corrective = deferred<Response>()
    rulesReply = async url => url.searchParams.has('asOf') ? corrective.promise : response({ ok: true, data: rules(url) })
    await mount()
    expect(timezone()).toBe('Attendance timezone unavailable')
    serverEpoch = Date.parse('2026-04-15T02:00:00Z') - mono
    rulesReply = async url => response({ ok: true, data: rules(url) })
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await flush()
    expect(time()).toBe('10:00:00')
    corrective.resolve(response({ ok: true, data: { resolvedAt: '2026-04-14T16:30:00.000Z', resolvedForDate: '2026-04-15', runtimeRule: { timezone: 'Asia/Tokyo' } } }))
    await flush()
    expect(timezone()).toBe('Attendance timezone: Asia/Shanghai')
    expect(time()).toBe('10:00:00')
  })
  it('refreshes new-day rules and today query at calibrated midnight', async () => {
    serverEpoch = Date.parse('2026-04-15T15:59:59Z') - mono
    rulesReply = async url => response({ ok: true, data: rules(url, {
      runtimeRule: { timezone: zone, workStartTime: url.searchParams.get('asOf') === '2026-04-16' ? '10:00' : '09:00', workEndTime: '18:00' },
    }) })
    await mount()
    await tick(1_000)
    expect(time()).toBe('00:00:00')
    expect(container.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('10:00')
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me').map(url => url.searchParams.get('asOf'))).toEqual([null, '2026-04-16'])
    expect(requests.filter(url => url.pathname === '/api/attendance/records' && url.searchParams.get('pageSize') === '1').map(url => url.searchParams.get('from'))).toEqual(['2026-04-15', '2026-04-16'])
  })
  it('resamples at 60s, retains fresh background context only while pending, and expires without fallback', async () => {
    await mount()
    const pending = deferred<Response>()
    rulesReply = () => pending.promise
    await tick(59_000)
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me')).toHaveLength(1)
    await tick(1_000)
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me')).toHaveLength(2)
    expect(time()).toBe('10:01:00')
    expect(timezone()).toBe('Attendance timezone: Asia/Shanghai')
    await tick(240_000)
    expect(time()).toBe('Server time unavailable')
    expect(timezone()).toBe('Attendance timezone unavailable')
  })
  it('manual refresh clears availability and older response cannot overwrite a later background round', async () => {
    await mount()
    const old = deferred<Response>()
    rulesReply = () => old.promise
    button('Refresh').click()
    await flush()
    expect(time()).toBe('Server time unavailable')
    rulesReply = async url => response({ ok: true, data: rules(url) })
    await tick(60_000)
    expect(time()).toBe('10:01:00')
    old.resolve(response({ ok: true, data: { resolvedAt: '2026-04-01T00:00:00.000Z', resolvedForDate: '2026-04-01', runtimeRule: { timezone: 'UTC' } } }))
    await flush()
    expect(time()).toBe('10:01:00')
    expect(timezone()).toBe('Attendance timezone: Asia/Shanghai')
  })
  it('a punch between display ticks never sends an already expired explicit timezone', async () => {
    await mount()
    mono += 300_000
    ;(container.querySelector('[data-testid="attendance-hero-punch"] button') as HTMLButtonElement).click()
    await flush()
    const call = vi.mocked(apiFetch).mock.calls.find(([input]) => String(input).endsWith('/api/attendance/punch'))
    expect(call).toBeTruthy()
    expect(JSON.parse(String(call![1]?.body))).not.toHaveProperty('timezone')
  })
  it('hidden state refuses late pending responses; frozen-monotonic visible recovery fails unavailable with punch enabled', async () => {
    await mount()
    const old = deferred<Response>()
    rulesReply = () => old.promise
    await tick(60_000)
    visibility(true)
    await flush()
    expect(time()).toBe('Server time unavailable')
    old.resolve(response({ ok: true, data: rules(new URL('http://fixture.invalid')) }))
    await flush()
    expect(time()).toBe('Server time unavailable')
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
    rulesReply = async () => { throw new Error('synthetic-failure') }
    visibility(false)
    await flush()
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me').at(-1)?.search).toBe('')
    expect(time()).toBe('Server time unavailable')
    expect((container.querySelector('[data-testid="attendance-hero-punch"] button') as HTMLButtonElement).disabled).toBe(false)
  })
  it('BFCache restores with a fresh bare request and cleanup removes timers/listeners', async () => {
    await mount()
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me')).toHaveLength(1)
    const pending = deferred<Response>()
    rulesReply = () => pending.promise
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await flush()
    expect(time()).toBe('Server time unavailable')
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me').at(-1)?.search).toBe('')
    app?.unmount(); app = null
    const count = requests.length
    visibility(false)
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await tick(60_000)
    expect(requests).toHaveLength(count)
    pending.resolve(response({ ok: true, data: rules(new URL('http://fixture.invalid')) }))
    await flush()
    expect(container.textContent).toBe('')
  })
  it('changed page principal refuses a delayed body and clears its prior clock', async () => {
    await mount()
    const pending = deferred<Response>()
    rulesReply = () => pending.promise
    await tick(60_000)
    principal = 'second-session'
    pending.resolve(response({ ok: true, data: rules(new URL('http://fixture.invalid')) }))
    await flush()
    expect(time()).toBe('Server time unavailable')
    expect(timezone()).toBe('Attendance timezone unavailable')
  })
  it.each(['admin', 'reports'])('does not add employee self-rules sampling to %s', async mode => {
    await mount(mode)
    await tick(60_000)
    expect(requests.filter(url => url.pathname === '/api/attendance/rules/me')).toEqual([])
  })
})
