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

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function installOverviewMock(): void {
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url

    if (url.includes('/api/attendance/summary?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          total_days: 10,
          total_minutes: 4320,
          total_late_minutes: 32,
          total_early_leave_minutes: 18,
          normal_days: 4,
          late_days: 1,
          early_leave_days: 0,
          late_early_days: 2,
          partial_days: 1,
          absent_days: 0,
          adjusted_days: 1,
          off_days: 2,
          leave_minutes: 480,
          overtime_minutes: 120,
        },
      })
    }
    if (url.includes('/api/attendance/records?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'record-today',
              work_date: '2026-04-15',
              first_in_at: '2026-04-15T09:18:00+08:00',
              last_out_at: '2026-04-15T17:42:00+08:00',
              work_minutes: 444,
              late_minutes: 18,
              early_leave_minutes: 18,
              status: 'late_early',
              meta: {},
            },
            {
              id: 'record-yesterday',
              work_date: '2026-04-14',
              first_in_at: '2026-04-14T09:00:00+08:00',
              last_out_at: '2026-04-14T18:06:00+08:00',
              work_minutes: 486,
              late_minutes: 0,
              early_leave_minutes: 0,
              status: 'adjusted',
              meta: {},
            },
          ],
          total: 2,
        },
      })
    }
    if (url.includes('/api/attendance/requests?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'request-pending',
              work_date: '2026-04-15',
              request_type: 'leave',
              requested_in_at: '2026-04-15T09:00:00+08:00',
              requested_out_at: '2026-04-15T18:00:00+08:00',
              status: 'pending',
              metadata: { minutes: 480 },
            },
            {
              id: 'request-approved',
              work_date: '2026-04-10',
              request_type: 'overtime',
              requested_in_at: '2026-04-10T18:30:00+08:00',
              requested_out_at: '2026-04-10T21:30:00+08:00',
              status: 'approved',
              metadata: { minutes: 180 },
            },
            {
              id: 'request-rejected',
              work_date: '2026-04-09',
              request_type: 'missed_check_in',
              requested_in_at: '2026-04-09T09:00:00+08:00',
              requested_out_at: null,
              status: 'rejected',
              metadata: {},
            },
          ],
        },
      })
    }
    if (url.includes('/api/attendance/anomalies?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              recordId: 'record-today',
              workDate: '2026-04-15',
              status: 'late_early',
              isWorkday: true,
              firstInAt: '2026-04-15T09:18:00+08:00',
              lastOutAt: '2026-04-15T17:42:00+08:00',
              workMinutes: 444,
              lateMinutes: 18,
              earlyLeaveMinutes: 18,
              warnings: ['missing punch review'],
              state: 'open',
              request: null,
              suggestedRequestType: 'missed_check_in',
            },
          ],
        },
      })
    }
    if (url.includes('/api/attendance/reports/requests?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
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
    if (url.includes('/api/attendance/leave-types')) {
      return jsonResponse(200, { ok: true, data: { items: [{ id: 'leave-annual', name: 'Annual Leave' }] } })
    }
    if (url.includes('/api/attendance/overtime-rules')) {
      return jsonResponse(200, { ok: true, data: { items: [{ id: 'ot-default', name: 'Standard Overtime' }] } })
    }

    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })
}

function installZeroStateMock(): void {
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url

    if (url.includes('/api/attendance/summary?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          total_days: 0,
          total_minutes: 0,
          total_late_minutes: 0,
          total_early_leave_minutes: 0,
          normal_days: 0,
          late_days: 0,
          early_leave_days: 0,
          late_early_days: 0,
          partial_days: 0,
          absent_days: 0,
          adjusted_days: 0,
          off_days: 0,
          leave_minutes: 0,
          overtime_minutes: 0,
        },
      })
    }
    if (url.includes('/api/attendance/records?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          total: 0,
        },
      })
    }
    if (url.includes('/api/attendance/requests?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
        },
      })
    }
    if (url.includes('/api/attendance/anomalies?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
        },
      })
    }
    if (url.includes('/api/attendance/reports/requests?')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
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
    if (url.includes('/api/attendance/leave-types')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }
    if (url.includes('/api/attendance/overtime-rules')) {
      return jsonResponse(200, { ok: true, data: { items: [] } })
    }

    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })
}

describe('Attendance self-service dashboard', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T08:00:00Z'))
    HTMLElement.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    installOverviewMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    vi.useRealTimers()
    app = null
    container = null
  })

  it('renders self-service cards with status, request summaries, quick actions, and status guide', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    expect(container?.querySelector('[data-selfservice-card="status"]')?.textContent).toContain('Late + Early')
    expect(container?.querySelector('[data-selfservice-card="status"]')?.textContent).toContain('Both a late arrival and an early departure')
    expect(container?.querySelector('[data-selfservice-focus-list]')?.textContent).toContain('Resolve anomaly reminders')
    expect(container?.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('Pending · 1')
    expect(container?.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('Approved · 1')
    expect(container?.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('Rejected · 1')
    expect(container?.querySelector('[data-selfservice-request-followup]')?.textContent).toContain('Pending follow-up')
    expect(container?.querySelector('[data-selfservice-card="actions"]')?.textContent).toContain('Fix missing punch')
    expect(container?.querySelector('[data-selfservice-primary-action]')?.textContent).toContain('Resolve anomaly reminders')
    expect(container?.querySelector('[data-selfservice-card="guide"]')?.textContent).toContain('Adjusted')
    expect(container?.querySelector('[data-selfservice-card="guide"]')?.textContent).toContain('manual correction')
  })

  it('surfaces anomaly-driven follow-up guidance and request backlog detail', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const statusCard = container!.querySelector('[data-selfservice-card="status"]')?.textContent ?? ''
    const requestsCard = container!.querySelector('[data-selfservice-card="requests"]')?.textContent ?? ''
    const actionsCard = container!.querySelector('[data-selfservice-card="actions"]')?.textContent ?? ''

    expect(statusCard).toContain('Attention items')
    expect(statusCard).toContain('1')
    expect(statusCard).toContain('You have 1 anomaly reminders in this range.')
    expect(statusCard).toContain('Resolve anomaly reminders')
    expect(statusCard).toContain('Track pending approvals')
    expect(requestsCard).toContain('Summarizes the current request backlog from the visible date range.')
    expect(requestsCard).toContain('Pending follow-up')
    expect(requestsCard).toContain('waiting for approval')
    expect(requestsCard).toContain('Pending · 1')
    expect(requestsCard).toContain('Approved · 1')
    expect(requestsCard).toContain('Rejected · 1')
    expect(requestsCard).toContain('In:')
    expect(requestsCard).toContain('Out:')
    expect(requestsCard).toContain('has already been approved')
    expect(requestsCard).toContain('was rejected')
    expect(actionsCard).toContain('Resolve anomaly reminders')
    expect(actionsCard).toContain('Start with missing-punch handling to resolve the current anomaly reminder.')
  })

  it('prefills the request form from quick actions without leaving overview', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const requestType = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    const workDate = container!.querySelector<HTMLInputElement>('#attendance-request-work-date')
    const leaveButton = container!.querySelector<HTMLButtonElement>('[data-selfservice-action="leave"]')
    const missingPunchButton = container!.querySelector<HTMLButtonElement>('[data-selfservice-action="missing-punch"]')

    expect(requestType).toBeTruthy()
    expect(workDate).toBeTruthy()
    expect(leaveButton).toBeTruthy()
    expect(missingPunchButton).toBeTruthy()

    leaveButton!.click()
    await flushUi(3)
    expect(requestType?.value).toBe('leave')
    expect(workDate?.value).toBe('2026-04-15')

    missingPunchButton!.click()
    await flushUi(3)
    expect(requestType?.value).toBe('missed_check_in')
    expect(workDate?.value).toBe('2026-04-15')
  })

  it('explains zero-data onboarding when no attendance records exist yet', async () => {
    installZeroStateMock()
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const statusCard = container!.querySelector('[data-selfservice-card="status"]')?.textContent ?? ''
    const setupHint = container!.querySelector('[data-selfservice-setup-hint]')?.textContent ?? ''
    const focusList = container!.querySelector('[data-selfservice-focus-list]')?.textContent ?? ''
    const actionsCard = container!.querySelector('[data-selfservice-card="actions"]')?.textContent ?? ''

    expect(statusCard).toContain('No attendance data is available in this range yet.')
    expect(setupHint).toContain('you may not be assigned to an attendance group yet')
    expect(setupHint).toContain('confirm your group and shift setup')
    expect(focusList).toContain('Check attendance setup')
    expect(actionsCard).toContain('Wait for attendance setup')
  })

  it('surfaces punch-too-soon failures with status code, hint, and retry affordance', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch')) {
        expect((init as RequestInit | undefined)?.method).toBe('POST')
        return jsonResponse(400, {
          ok: false,
          error: {
            code: 'PUNCH_TOO_SOON',
            message: 'PUNCH_TOO_SOON',
          },
        })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check Out').click()
    await flushUi(4)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('Punch interval is too short. Try again shortly.')
    expect(pageText).toContain('Code: PUNCH_TOO_SOON')
    expect(pageText).toContain('Minimum punch interval is enforced by policy. Retry after the interval.')
    expect(pageText).toContain('Retry refresh')
  })
})
