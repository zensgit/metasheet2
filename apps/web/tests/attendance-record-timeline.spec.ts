import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, useRoute, type Router } from 'vue-router'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { ATTENDANCE_RECORD_REQUEST_PREFILL_KEY } from '../src/views/attendance/attendanceRecordRequestPrefill'

const authMockState = vi.hoisted(() => ({ sessionOrgId: '' }))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: async () => 'user-1',
    buildAuthHeaders: () => authMockState.sessionOrgId ? { 'x-tenant-id': authMockState.sessionOrgId } : {},
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label,
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

const baseRecord = {
  id: 'record-1',
  work_date: '2026-03-28',
  first_in_at: '2026-03-28T09:01:00+08:00',
  last_out_at: '2026-03-28T18:05:00+08:00',
  work_minutes: 484,
  late_minutes: 1,
  early_leave_minutes: 0,
  status: 'normal',
  meta: {},
  workday_context: { timezone: 'Asia/Shanghai' },
}

function installAttendanceMock(options?: {
  timelineStatus?: number
  timelineItems?: Array<Record<string, unknown>>
  recordTimezone?: string | null
  recordUserId?: string
}): string[] {
  const timelineCalls: string[] = []
  const timelineStatus = options?.timelineStatus ?? 200
  const timelineItems = options?.timelineItems ?? [
    {
      id: 'evt-2',
      userId: 'user-1',
      workDate: '2026-03-28',
      eventType: 'check_out',
      occurredAt: '2026-03-28T18:05:00+08:00',
      source: 'terminal',
      timezone: 'Asia/Shanghai',
    },
    {
      id: 'evt-1',
      userId: 'user-1',
      workDate: '2026-03-28',
      eventType: 'check_in',
      occurredAt: '2026-03-28T09:01:00+08:00',
      source: 'terminal',
      timezone: 'Asia/Shanghai',
    },
  ]
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/api/attendance/summary?')) {
      return jsonResponse(200, { ok: true, data: null })
    }
    if (url.includes('/api/attendance/records?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [{ ...baseRecord, user_id: options?.recordUserId, workday_context: { timezone: options?.recordTimezone === undefined ? 'Asia/Shanghai' : options.recordTimezone } }],
          total: 1,
        },
      })
    }
    if (url.includes('/api/attendance/requests?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }
    if (url.includes('/api/attendance/anomalies?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }
    if (url.includes('/api/attendance/reports/requests?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }
    if (url.includes('/api/attendance/holidays?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }
    if (url.includes('/api/attendance/punch/events?')) {
      timelineCalls.push(url)
      if (timelineStatus !== 200) {
        return jsonResponse(timelineStatus, {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: 'route missing',
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: timelineItems,
          total: timelineItems.length,
        },
      })
    }
    return jsonResponse(200, { ok: true, data: { items: [] } })
  })
  return timelineCalls
}

describe('Attendance record timeline', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined
  let router: Router

  async function mountReports(): Promise<void> {
    const entrypoint = defineComponent({
      setup() {
        const route = useRoute()
        return () => {
          const mode = route.query.tab === 'reports' ? 'reports' : 'overview'
          return h(AttendanceView, {
            key: mode,
            mode,
            initialSectionId: String(route.query.section ?? ''),
          })
        }
      },
    })
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/attendance', component: entrypoint }] })
    await router.push('/attendance?tab=reports')
    await router.isReady()
    app = createApp({ render: () => h(RouterView) })
    app.use(router)
    app.mount(container!)
    await flushUi(16)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    authMockState.sessionOrgId = ''
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.localStorage.setItem('auth_token', `header.${btoa(JSON.stringify({ sub: 'user-1' }))}.signature`)
    window.history.replaceState({}, '', '/attendance')
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView!
    app = null
    container = null
  })

  it('loads and renders the raw punch timeline from the record details row', async () => {
    const timelineCalls = installAttendanceMock()
    await mountReports()

    findButton(container!, 'Details').click()
    await flushUi()

    expect(timelineCalls).toEqual([
      '/api/attendance/punch/events?from=2026-03-28&to=2026-03-28',
    ])

    const rows = Array.from(container!.querySelectorAll('.attendance__timeline-item')).map(
      item => item.textContent?.replace(/\s+/g, ' ').trim() || '',
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('Check in')
    expect(rows[0]).toContain('terminal')
    expect(rows[0]).toContain('Asia/Shanghai')
    expect(rows[0]).toContain('9:01:00 AM')
    expect(rows[1]).toContain('6:05:00 PM')
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/rules/me'))).toBe(false)
    expect(rows[1]).toContain('Check out')

    findButton(container!, 'Hide').click()
    await flushUi()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(timelineCalls).toHaveLength(1)
  })

  it.each([404, 405])('falls back inline for %s and does not retry after support is known absent', async timelineStatus => {
    const timelineCalls = installAttendanceMock({ timelineStatus })
    await mountReports()

    findButton(container!, 'Details').click()
    await flushUi()

    expect(container?.textContent).toContain('Raw punch timeline is unavailable on this server.')

    findButton(container!, 'Hide').click()
    await flushUi()
    findButton(container!, 'Details').click()
    await flushUi()

    expect(timelineCalls).toHaveLength(1)
  })

  it('prefills the request form from the loaded record timeline', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    installAttendanceMock()
    await mountReports()

    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use as Time correction').click()
    await flushUi(24)
    expect(router.currentRoute.value.query).toEqual({ section: 'attendance-overview-anomalies' })

    const workDateInput = container!.querySelector<HTMLInputElement>('#attendance-request-work-date')
    const requestTypeSelect = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    const requestedInInput = container!.querySelector<HTMLInputElement>('#attendance-request-in')
    const requestedOutInput = container!.querySelector<HTMLInputElement>('#attendance-request-out')

    expect(workDateInput?.value).toBe('2026-03-28')
    expect(requestTypeSelect?.value).toBe('time_correction')
    expect(requestedInInput?.value).toBe('2026-03-28T09:01')
    expect(requestedOutInput?.value).toBe('2026-03-28T18:05')
    expect(container?.textContent).toContain('Request form updated from record timeline.')
    expect(scrollIntoView).toHaveBeenCalled()
    expect(router.options.history.state[ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]).toBeNull()
    expect(router.currentRoute.value.fullPath).not.toContain('2026-03-28')
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    await router.push('/attendance?tab=reports')
    await flushUi(16)
    router.back()
    await flushUi(24)
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-in')?.value).toBe('')
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-out')?.value).toBe('')
  })

  it('infers missed check-out when the loaded timeline only has a check-in event', async () => {
    installAttendanceMock({
      timelineItems: [
        {
          id: 'evt-1',
          userId: 'user-1',
          workDate: '2026-03-28',
          eventType: 'check_in',
          occurredAt: '2026-03-28T09:01:00+08:00',
          source: 'terminal',
          timezone: 'Asia/Shanghai',
        },
      ],
    })
    await mountReports()

    findButton(container!, 'Details').click()
    await flushUi()
    expect(container?.textContent).toContain('Suggested request: Missed check-out')
    findButton(container!, 'Use as Missed check-out').click()
    await flushUi(24)
    expect(router.currentRoute.value.query).toEqual({ section: 'attendance-overview-anomalies' })

    const requestTypeSelect = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    const requestedInInput = container!.querySelector<HTMLInputElement>('#attendance-request-in')
    const requestedOutInput = container!.querySelector<HTMLInputElement>('#attendance-request-out')

    expect(requestTypeSelect?.value).toBe('missed_check_out')
    expect(requestedInInput?.value).toBe('2026-03-28T09:01')
    expect(requestedOutInput?.value).toBe('')
  })
  it('keeps an empty raw timeline distinct from a populated attendance summary', async () => {
    installAttendanceMock({ timelineItems: [] })
    await mountReports()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(container!.textContent).toContain('No raw punch events for this day.')
    expect(container!.querySelectorAll('.attendance__timeline-item')).toHaveLength(0)
    expect(Array.from(container!.querySelectorAll('button')).some(button => button.textContent?.includes('Use as'))).toBe(false)
  })

  it('does not guess a missing historical timezone or prefill browser-local punch times', async () => {
    installAttendanceMock({
      recordTimezone: null,
      timelineItems: [{
        id: 'evt-1', userId: 'user-1', workDate: '2026-03-28', eventType: 'check_in',
        occurredAt: '2026-03-28T09:01:00+08:00', source: 'terminal', timezone: null,
      }],
    })
    await mountReports()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(container!.querySelector('.attendance__timeline-primary')?.textContent).toContain('--')
    findButton(container!, 'Use as Missed check-out').click()
    await flushUi(16)
    expect(router.currentRoute.value.query).toEqual({ tab: 'reports' })
    expect(container!.textContent).toContain('Historical punch timezone or timestamp is unavailable.')
    expect(router.options.history.state[ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]).toBeUndefined()
  })

  it.each([
    { principalKey: 'sub:another-user', orgId: '' },
    { principalKey: 'sub:user-1', orgId: 'another-org' },
    { principalKey: 'sub:user-1', orgId: '', requestType: 'invalid' },
  ])('clears and rejects a mismatched or malformed route draft %#', async overrides => {
    installAttendanceMock()
    await mountReports()
    await router.push({
      path: '/attendance',
      query: { section: 'attendance-overview-anomalies' },
      state: { [ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]: {
        principalKey: 'sub:user-1', orgId: '', workDate: '2026-03-28', requestType: 'time_correction',
        requestedInAt: '2026-03-28T09:01:00+08:00', requestedOutAt: '2026-03-28T18:05:00+08:00',
        inTimeZone: 'Asia/Shanghai', outTimeZone: 'Asia/Shanghai', ...overrides,
      } },
    })
    await flushUi(24)
    expect(router.options.history.state[ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]).toBeNull()
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-in')?.value).toBe('')
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-out')?.value).toBe('')
  })

  it.each(['other-org', 'other-target', 'other-record-user'])('rejects historical request handoff from %s', async source => {
    authMockState.sessionOrgId = 'session-org-a'
    installAttendanceMock({ recordUserId: source === 'other-record-user' ? 'other-user' : 'user-1' })
    await mountReports()
    if (source !== 'other-record-user') {
      const selector = source === 'other-org' ? '#attendance-org-id' : 'input[name="targetUserId"]'
      const input = container!.querySelector<HTMLInputElement>(selector)!
      input.value = source === 'other-org' ? 'selected-org-b' : 'other-user'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi(16)
      findButton(container!, 'Reload report').click()
      await flushUi(16)
      if (source === 'other-target') {
        // Editing the filter back to self does not change the already loaded row's provenance.
        input.value = 'user-1'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await flushUi()
      }
    }
    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use as Time correction').click()
    await flushUi(24)
    expect(router.currentRoute.value.query).toEqual({ tab: 'reports' })
    expect(container!.textContent).toContain('Only your records in the current session organization can prefill a request.')
    expect(router.options.history.state[ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]).toBeUndefined()
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('binds raw timeline reads to the loaded self scope after editing the target filter', async () => {
    authMockState.sessionOrgId = 'session-org-a'
    const timelineCalls = installAttendanceMock({ recordUserId: 'user-1' })
    await mountReports()
    const user = container!.querySelector<HTMLInputElement>('input[name="targetUserId"]')!
    user.value = 'other-user'
    user.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(timelineCalls).toEqual(['/api/attendance/punch/events?from=2026-03-28&to=2026-03-28&orgId=session-org-a'])
    findButton(container!, 'Use as Time correction').click()
    await flushUi(24)
    expect(router.currentRoute.value.query).toEqual({ section: 'attendance-overview-anomalies' })
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-in')?.value).toBe('2026-03-28T09:01')
  })

  it('rejects another user raw event even when the loaded record and query scope are self', async () => {
    authMockState.sessionOrgId = 'session-org-a'
    installAttendanceMock({ recordUserId: 'user-1', timelineItems: [{
      id: 'other-event', userId: 'other-user', workDate: '2026-03-28',
      eventType: 'check_in', occurredAt: '2026-03-28T11:00:00+08:00', timezone: 'Asia/Shanghai',
    }] })
    await mountReports()
    const user = container!.querySelector<HTMLInputElement>('input[name="targetUserId"]')!
    user.value = 'other-user'
    user.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use as Missed check-out').click()
    await flushUi(24)
    expect(router.currentRoute.value.query).toEqual({ tab: 'reports' })
    expect(container!.textContent).toContain('Only your records in the current session organization can prefill a request.')
    expect(router.options.history.state[ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]).toBeUndefined()
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('discards a timeline response after its loaded record scope has been refreshed', async () => {
    installAttendanceMock()
    const baseMock = vi.mocked(apiFetch).getMockImplementation()!
    let resolveTimeline!: (response: Response) => void
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/api/attendance/punch/events?')) {
        return new Promise<Response>(resolve => { resolveTimeline = resolve })
      }
      return baseMock(input, init)
    })
    await mountReports()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(resolveTimeline).toBeTypeOf('function')
    findButton(container!, 'Reload report').click()
    await flushUi(16)
    resolveTimeline(jsonResponse(200, { ok: true, data: { items: [{
      id: 'old-event', userId: 'user-1', workDate: '2026-03-28',
      eventType: 'check_in', occurredAt: '2026-03-28T11:00:00+08:00', timezone: 'Asia/Shanghai',
    }], total: 1 } }))
    await flushUi()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(container!.querySelectorAll('.attendance__timeline-item')).toHaveLength(0)
    expect(vi.mocked(apiFetch).mock.calls.filter(([input]) => String(input).includes('/api/attendance/punch/events?'))).toHaveLength(2)
    resolveTimeline(jsonResponse(200, { ok: true, data: { items: [], total: 0 } }))
    await flushUi()
  })

  it('allows exact self record handoff in a non-default session organization', async () => {
    authMockState.sessionOrgId = 'session-org-a'
    installAttendanceMock({ recordUserId: 'user-1' })
    await mountReports()
    const user = container!.querySelector<HTMLInputElement>('input[name="targetUserId"]')!
    user.value = 'user-1'
    user.dispatchEvent(new Event('input', { bubbles: true }))
    findButton(container!, 'Reload report').click()
    await flushUi(16)
    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use as Time correction').click()
    await flushUi(24)
    expect(router.currentRoute.value.query).toEqual({ section: 'attendance-overview-anomalies' })
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-in')?.value).toBe('2026-03-28T09:01')
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-out')?.value).toBe('2026-03-28T18:05')
    expect(router.options.history.state[ATTENDANCE_RECORD_REQUEST_PREFILL_KEY]).toBeNull()
  })

  it('preserves exact source instants on submit and converts edits in the historical timezone', async () => {
    const firstIn = '2026-03-28T09:00:37.123+08:00'
    const lastOut = '2026-03-28T18:05:38.456+08:00'
    installAttendanceMock({ timelineItems: [
      { id: 'evt-in', userId: 'user-1', workDate: '2026-03-28', eventType: 'check_in', occurredAt: firstIn, timezone: 'Asia/Shanghai' },
      { id: 'evt-out', userId: 'user-1', workDate: '2026-03-28', eventType: 'check_out', occurredAt: lastOut, timezone: 'Asia/Shanghai' },
    ] })
    await mountReports()
    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use as Time correction').click()
    await flushUi(24)
    const input = container!.querySelector<HTMLInputElement>('#attendance-request-in')!
    expect(input.value).toBe('2026-03-28T09:00:37.123')
    expect(Array.from(container!.querySelectorAll('[data-record-request-timezone]')).map(item => item.textContent?.trim())).toEqual(['Asia/Shanghai', 'Asia/Shanghai'])
    expect(container!.querySelector('[data-record-request-time-policy]')?.textContent).toContain('Edited repeated times use the earlier occurrence')
    const bodies = () => vi.mocked(apiFetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/attendance/requests' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))

    findButton(container!, 'Submit request').click()
    await flushUi(16)
    expect(bodies()).toEqual([{ workDate: '2026-03-28', requestType: 'time_correction', requestedInAt: firstIn, requestedOutAt: lastOut }])

    input.value = '2026-03-28T09:02:39.789'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    findButton(container!, 'Submit request').click()
    await flushUi(16)
    expect(bodies()[1]).toEqual({ workDate: '2026-03-28', requestType: 'time_correction', requestedInAt: '2026-03-28T01:02:39.789Z', requestedOutAt: lastOut })

    const date = container!.querySelector<HTMLInputElement>('#attendance-request-work-date')!
    date.value = '2026-03-29'
    date.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(input.value).toBe('')
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-out')?.value).toBe('')
    expect(container!.querySelector('[data-record-request-time-policy]')).toBeNull()
  })

  it('rejects a spring-forward gap before any request write', async () => {
    installAttendanceMock({ recordTimezone: 'America/New_York', timelineItems: [
      { id: 'evt-in', userId: 'user-1', workDate: '2026-03-08', eventType: 'check_in', occurredAt: '2026-03-08T06:30:00Z', timezone: 'America/New_York' },
      { id: 'evt-out', userId: 'user-1', workDate: '2026-03-08', eventType: 'check_out', occurredAt: '2026-03-08T08:30:00Z', timezone: 'America/New_York' },
    ] })
    await mountReports()
    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use as Time correction').click()
    await flushUi(24)
    const input = container!.querySelector<HTMLInputElement>('#attendance-request-in')!
    input.value = '2026-03-08T02:30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    findButton(container!, 'Submit request').click()
    await flushUi(16)
    expect(container!.textContent).toContain('skipped daylight-saving times are unavailable')
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

})
