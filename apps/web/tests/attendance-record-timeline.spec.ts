import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

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

function toLocalDateTimeValue(value: string): string {
  const date = new Date(value)
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
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
}

function installAttendanceMock(options?: { timelineStatus?: number; timelineItems?: Array<Record<string, unknown>> }): string[] {
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
          items: [baseRecord],
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
      if (timelineStatus === 404) {
        return jsonResponse(404, {
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

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
    app = null
    container = null
  })

  it('loads and renders the raw punch timeline from the record details row', async () => {
    const timelineCalls = installAttendanceMock()
    app = createApp(AttendanceView)
    app.mount(container!)
    await flushUi()

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
    expect(rows[1]).toContain('Check out')

    findButton(container!, 'Hide').click()
    await flushUi()
    findButton(container!, 'Details').click()
    await flushUi()
    expect(timelineCalls).toHaveLength(1)
  })

  it('falls back inline when the timeline endpoint is unavailable and does not retry after support is known absent', async () => {
    const timelineCalls = installAttendanceMock({ timelineStatus: 404 })
    app = createApp(AttendanceView)
    app.mount(container!)
    await flushUi()

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
    app = createApp(AttendanceView)
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use in request form').click()
    await flushUi()

    const workDateInput = container!.querySelector<HTMLInputElement>('#attendance-request-work-date')
    const requestTypeSelect = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    const requestedInInput = container!.querySelector<HTMLInputElement>('#attendance-request-in')
    const requestedOutInput = container!.querySelector<HTMLInputElement>('#attendance-request-out')

    expect(workDateInput?.value).toBe('2026-03-28')
    expect(requestTypeSelect?.value).toBe('time_correction')
    expect(requestedInInput?.value).toBe(toLocalDateTimeValue('2026-03-28T09:01:00+08:00'))
    expect(requestedOutInput?.value).toBe(toLocalDateTimeValue('2026-03-28T18:05:00+08:00'))
    expect(container?.textContent).toContain('Request form updated from record timeline.')
    expect(scrollIntoView).toHaveBeenCalled()
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
    app = createApp(AttendanceView)
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Details').click()
    await flushUi()
    findButton(container!, 'Use in request form').click()
    await flushUi()

    const requestTypeSelect = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    const requestedInInput = container!.querySelector<HTMLInputElement>('#attendance-request-in')
    const requestedOutInput = container!.querySelector<HTMLInputElement>('#attendance-request-out')

    expect(requestTypeSelect?.value).toBe('missed_check_out')
    expect(requestedInInput?.value).toBe(toLocalDateTimeValue('2026-03-28T09:01:00+08:00'))
    expect(requestedOutInput?.value).toBe('')
  })
})
