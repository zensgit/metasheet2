import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { useLocale } from '../src/composables/useLocale'
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
              reason: 'Family medical appointment',
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
              reason: 'Forgot to check in at the lobby kiosk',
              status: 'rejected',
              metadata: {
                resolution: {
                  action: 'reject',
                  status: 'rejected',
                  comment: 'Please attach lobby access evidence.',
                },
              },
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
    if (url.includes('/api/attendance/effective-calendar?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          mode: 'userId',
          from: '2026-03-30',
          to: '2026-05-03',
          timezone: 'Asia/Shanghai',
          items: [
            {
              date: '2026-04-05',
              base: { isWorkingDay: false, source: 'national', name: '清明节-1', holidayId: 'h_qm', dayIndex: 1 },
              effective: { isWorkingDay: false, source: 'national', label: '清明节-1' },
              layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: '清明节-1' }],
              overlays: [],
            },
            {
              date: '2026-04-10',
              base: { isWorkingDay: true, source: 'rule' },
              effective: { isWorkingDay: true, source: 'rule' },
              layers: [{ kind: 'base_rule', source: 'rule', isWorkingDay: true }],
              overlays: [
                { kind: 'overtime', source: 'attendance_requests', requestType: 'overtime', minutes: 180, status: 'approved', refId: 'request-approved' },
              ],
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
    if (url.includes('/api/attendance/effective-calendar?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          mode: 'userId',
          from: '2026-03-30',
          to: '2026-05-03',
          timezone: 'Asia/Shanghai',
          items: [],
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
    useLocale().setLocale('en')
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

  it('renders effective-calendar holiday anchors and approved overlays in the personal calendar', async () => {
    useLocale().setLocale('zh-CN')
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(12)

    const targetInput = container?.querySelector('input[name="targetUserId"]') as HTMLInputElement | null
    expect(targetInput).toBeTruthy()
    targetInput!.value = 'user-self'
    targetInput!.dispatchEvent(new Event('input', { bubbles: true }))
    findButton(container!, '刷新').click()
    await flushUi(12)

    const chips = Array.from(container!.querySelectorAll('.attendance__calendar-holiday')) as HTMLElement[]
    const statutoryChip = chips.find((chip) => chip.textContent?.includes('清明节'))
    expect(statutoryChip).toBeTruthy()
    expect(statutoryChip!.textContent).toContain('休')
    expect(statutoryChip!.textContent?.includes('清明节-1')).toBe(false)
    expect(statutoryChip!.classList.contains('calendar-source--national')).toBe(true)

    const overtimeChip = chips.find((chip) => chip.textContent?.includes('加 3h'))
    expect(overtimeChip).toBeTruthy()
    expect(overtimeChip!.textContent).toContain('班')
    expect(overtimeChip!.getAttribute('title') ?? '').toContain('加班 · 180m')
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
    expect(requestsCard).toContain('Reason: Family medical appointment')
    expect(requestsCard).toContain('Reason: Forgot to check in at the lobby kiosk')
    expect(requestsCard).toContain('Rejection note: Please attach lobby access evidence.')
    expect(requestsCard).toContain('has already been approved')
    expect(requestsCard).toContain('was rejected')
    expect(actionsCard).toContain('Resolve anomaly reminders')
    expect(actionsCard).toContain('Start with missing-punch handling to resolve the current anomaly reminder.')
  })

  it('requires and submits a rejection note when rejecting an attendance request', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Needs manager evidence')
    try {
      app = createApp(AttendanceView, { mode: 'overview' })
      app.mount(container!)
      await flushUi()

      findButton(container!, 'Reject').click()
      await flushUi()

      const rejectCall = vi.mocked(apiFetch).mock.calls.find(call =>
        String(call[0]).includes('/api/attendance/requests/request-pending/reject')
      )
      expect(rejectCall).toBeTruthy()
      expect(JSON.parse(String(rejectCall?.[1]?.body))).toEqual({
        comment: 'Needs manager evidence',
      })
    } finally {
      promptSpy.mockRestore()
    }
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

  it('loads active leave and overtime policies into self-service request selectors', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]) === '/api/attendance/leave-types?isActive=true'
    )).toBe(true)
    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]) === '/api/attendance/overtime-rules?isActive=true'
    )).toBe(true)

    const requestType = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    expect(requestType).toBeTruthy()
    requestType!.value = 'leave'
    requestType!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const leaveType = container!.querySelector<HTMLSelectElement>('#attendance-request-leave-type')
    expect(leaveType).toBeTruthy()
    expect(leaveType!.disabled).toBe(false)
    expect(leaveType!.value).toBe('leave-annual')
    expect(leaveType!.textContent).toContain('Annual Leave')

    requestType!.value = 'overtime'
    requestType!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const overtimeRule = container!.querySelector<HTMLSelectElement>('#attendance-request-overtime-rule')
    expect(overtimeRule).toBeTruthy()
    expect(overtimeRule!.disabled).toBe(false)
    expect(overtimeRule!.value).toBe('ot-default')
    expect(overtimeRule!.textContent).toContain('Standard Overtime')
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

    const requestType = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    expect(requestType).toBeTruthy()
    requestType!.value = 'leave'
    requestType!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const leaveType = container!.querySelector<HTMLSelectElement>('#attendance-request-leave-type')
    expect(leaveType).toBeTruthy()
    expect(leaveType!.disabled).toBe(true)
    expect(container!.textContent).toContain('Ask an attendance admin to enable an active leave type')

    requestType!.value = 'overtime'
    requestType!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const overtimeRule = container!.querySelector<HTMLSelectElement>('#attendance-request-overtime-rule')
    expect(overtimeRule).toBeTruthy()
    expect(overtimeRule!.disabled).toBe(true)
    expect(container!.textContent).toContain('Ask an attendance admin to enable an active overtime rule')
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

  // PR2 review fix (Codex Blocking #1): the personal calendar must read a
  // userId committed at Refresh-time, NOT the live v-model value of the
  // targetUserId input. This test types into the input without refreshing
  // and asserts that no new effective-calendar fetch fired for the typed
  // value; then clicks Refresh and asserts the fetch URL carries the typed
  // userId — same commit point as summary/records/requests.
  it('PR2 review #1: typing targetUserId does not request effective-calendar until Refresh commits it', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const effectiveCalls = () => vi.mocked(apiFetch).mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('/api/attendance/effective-calendar'),
    )
    const baselineCalls = effectiveCalls().length
    expect(effectiveCalls().some((call) => String(call[0]).includes('userId=typed-user-pr2'))).toBe(false)

    const targetInput = container?.querySelector('input[name="targetUserId"]') as HTMLInputElement | null
    expect(targetInput).toBeTruthy()
    targetInput!.value = 'typed-user-pr2'
    targetInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    // Typing must NOT have produced a new effective-calendar fetch
    expect(effectiveCalls().length).toBe(baselineCalls)
    expect(effectiveCalls().some((call) => String(call[0]).includes('userId=typed-user-pr2'))).toBe(false)

    findButton(container!, 'Refresh').click()
    await flushUi(12)

    const afterRefresh = effectiveCalls()
    expect(afterRefresh.length).toBeGreaterThan(baselineCalls)
    expect(afterRefresh.some((call) => String(call[0]).includes('userId=typed-user-pr2'))).toBe(true)
  })
})
