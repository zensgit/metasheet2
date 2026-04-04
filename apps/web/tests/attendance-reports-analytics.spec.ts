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

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function installReportsMock(): void {
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url

    if (url.includes('/api/attendance/summary?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          total_days: 13,
          total_minutes: 5820,
          total_late_minutes: 24,
          total_early_leave_minutes: 12,
          normal_days: 6,
          late_days: 2,
          early_leave_days: 1,
          late_early_days: 3,
          partial_days: 1,
          absent_days: 0,
          adjusted_days: 1,
          off_days: 4,
          leave_minutes: 960,
          overtime_minutes: 180,
        },
      })
    }
    if (url.includes('/api/attendance/records?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'record-normal',
              work_date: '2026-04-01',
              first_in_at: '2026-04-01T09:00:00+08:00',
              last_out_at: '2026-04-01T18:00:00+08:00',
              work_minutes: 480,
              late_minutes: 0,
              early_leave_minutes: 0,
              status: 'normal',
              meta: {},
            },
            {
              id: 'record-late',
              work_date: '2026-04-02',
              first_in_at: '2026-04-02T09:16:00+08:00',
              last_out_at: '2026-04-02T18:05:00+08:00',
              work_minutes: 469,
              late_minutes: 16,
              early_leave_minutes: 0,
              status: 'late',
              meta: {},
            },
            {
              id: 'record-adjusted',
              work_date: '2026-04-03',
              first_in_at: '2026-04-03T09:00:00+08:00',
              last_out_at: '2026-04-03T18:10:00+08:00',
              work_minutes: 490,
              late_minutes: 0,
              early_leave_minutes: 0,
              status: 'adjusted',
              meta: {},
            },
          ],
          total: 3,
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
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              requestType: 'leave',
              status: 'pending',
              total: 2,
              minutes: 960,
            },
            {
              requestType: 'overtime',
              status: 'approved',
              total: 1,
              minutes: 180,
            },
            {
              requestType: 'missed_check_in',
              status: 'rejected',
              total: 1,
              minutes: 0,
            },
          ],
        },
      })
    }
    if (url.includes('/api/attendance/holidays?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }
    if (url.includes('/api/attendance/settings')) {
      return jsonResponse(200, { ok: true, data: {} })
    }
    if (url.includes('/api/attendance/rules/default')) {
      return jsonResponse(200, { ok: true, data: {} })
    }
    if (url.includes('/api/attendance/rule-templates')) {
      return jsonResponse(200, { ok: true, data: { system: [], library: [], versions: [] } })
    }

    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })
}

function findFilterButton(container: HTMLElement, group: string, value: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-report-filter-group="${group}"] [data-report-filter-value="${value}"]`,
  )
  expect(button, `expected ${group} filter ${value}`).toBeTruthy()
  return button as HTMLButtonElement
}

describe('Attendance reports analytics', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T08:00:00Z'))
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance?tab=reports')
    installReportsMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    vi.useRealTimers()
    app = null
    container = null
  })

  it('renders report snapshot cards and filter breakdowns in reports mode', async () => {
    app = createApp(AttendanceView, { mode: 'reports' })
    app.mount(container!)
    await flushUi()

    expect(container?.querySelector('[data-reports-insight="snapshot"]')?.textContent).toContain('Visible requests')
    expect(container?.querySelector('[data-reports-insight="snapshot"]')?.textContent).toContain('4')
    expect(container?.querySelector('[data-reports-insight="trend"]')?.textContent).toContain('Normal')
    expect(container?.querySelector('[data-reports-insight="trend"]')?.textContent).toContain('Late + Early')
    expect(container?.querySelector('[data-reports-insight="metrics"]')?.textContent).toContain('Overtime minutes')
    expect(findFilterButton(container!, 'request-status', 'pending').textContent).toContain('2')
    expect(findFilterButton(container!, 'request-type', 'overtime').textContent).toContain('1')
    expect(findFilterButton(container!, 'record-status', 'adjusted').textContent).toContain('1')
  })

  it('filters request and record tables locally without extra API calls', async () => {
    app = createApp(AttendanceView, { mode: 'reports' })
    app.mount(container!)
    await flushUi()

    const initialCallCount = vi.mocked(apiFetch).mock.calls.length

    findFilterButton(container!, 'request-status', 'pending').click()
    await flushUi(3)

    let requestRows = Array.from(
      container!.querySelectorAll<HTMLElement>('[data-report-card="request-report"] tbody tr'),
    ).map(row => row.textContent?.replace(/\s+/g, ' ').trim() || '')
    expect(requestRows).toHaveLength(1)
    expect(requestRows[0]).toContain('Leave')
    expect(requestRows[0]).toContain('Pending')

    findFilterButton(container!, 'record-status', 'adjusted').click()
    await flushUi(3)

    const recordRows = Array.from(
      container!.querySelectorAll<HTMLElement>('[data-report-card="records"] tbody > tr'),
    )
      .filter(row => !row.classList.contains('attendance__table-row--meta'))
      .map(row => row.textContent?.replace(/\s+/g, ' ').trim() || '')

    expect(recordRows).toHaveLength(1)
    expect(recordRows[0]).toContain('2026-04-03')
    expect(recordRows[0]).toContain('Adjusted')
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(initialCallCount)
  })

  it('applies report period presets and refreshes the reports with the new range', async () => {
    app = createApp(AttendanceView, { mode: 'reports' })
    app.mount(container!)
    await flushUi()

    const initialCallCount = vi.mocked(apiFetch).mock.calls.length

    findFilterButton(container!, 'range-preset', 'this-week').click()
    await flushUi(4)

    const fromInput = container!.querySelector<HTMLInputElement>('#attendance-from-date')
    const toInput = container!.querySelector<HTMLInputElement>('#attendance-to-date')
    const periodLabel = container!.querySelector<HTMLElement>('[data-report-period-label]')

    expect(fromInput?.value).toBe('2026-04-13')
    expect(toInput?.value).toBe('2026-04-19')
    expect(periodLabel?.textContent).toContain('Apr')
    expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(initialCallCount)
    expect(vi.mocked(apiFetch).mock.calls.some((call) => String(call[0]).includes('/api/attendance/summary?'))).toBe(true)
  })
})
