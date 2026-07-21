import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { useLocale } from '../src/composables/useLocale'
import { apiFetch } from '../src/utils/api'
import { resolveMakeupPunchRequestStatusCopy } from '../src/views/attendance/makeupPunchRequestStatus'

const authMockState = vi.hoisted(() => ({
  currentUserId: 'swap-user-a',
}))

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
    getCurrentUserId: vi.fn(async () => authMockState.currentUserId),
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
    if (url.endsWith('/api/attendance/requests/request-focused')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          request: {
            id: 'request-focused',
            work_date: '2026-04-16',
            request_type: 'time_correction',
            requested_in_at: '2026-04-16T09:05:00+08:00',
            requested_out_at: '2026-04-16T18:02:00+08:00',
            reason: 'Approval-center pending item',
            status: 'pending',
            metadata: {},
          },
        },
      })
    }
    if (url.endsWith('/api/attendance/requests/request-missing')) {
      return jsonResponse(404, {
        ok: false,
        error: { message: 'Focused request is no longer available.' },
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
    if (url.includes('/api/attendance/rules/me')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          userId: 'swap-user-a',
          orgId: 'default',
          resolvedForDate: '2026-04-15',
          assignment: {
            attendanceGroups: [{ id: 'group-a', name: 'Shanghai Store A', attendanceType: 'scheduled_shift' }],
            scheduleGroups: [{ id: 'schedule-a', name: 'Morning rotation', effectiveFrom: '2026-04-01', effectiveTo: null }],
          },
          runtimeRule: {
            name: 'Morning rule',
            timezone: 'Asia/Shanghai',
            workStartTime: '09:00',
            workEndTime: '18:00',
            workingDays: [1, 2, 3, 4, 5],
            lateGraceMinutes: 5,
            earlyGraceMinutes: 5,
            severeLateThresholdMinutes: 30,
            absenceLateThresholdMinutes: 60,
            geofence: 'raw-geofence-secret',
          },
          configuredGroupRule: { groupId: 'group-a', ruleSetId: 'rule-set-a', enforcement: 'not_user_calc_chain' },
          punchPolicy: {
            source: 'org_settings',
            unscheduledMode: 'block',
            outdoorApprovalRequired: true,
            outdoorNoteRequired: true,
            approvalFlowId: 'approval-flow-secret',
            geofence: { latitude: 31.2304, longitude: 121.4737 },
            wifiAllowlist: ['wifi-secret'],
            integrationConfig: { webhookToken: 'integration-secret' },
            merge: { internalWinsOnIn: true, externalWinsOnOut: true },
          },
          warnings: [{ code: 'GROUP_RULE_SET_PREVIEW_DIVERGENCE' }],
        },
      })
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
    if (
      url.includes('/api/attendance/requests/request-focused/approve')
      || url.includes('/api/attendance/requests/request-focused/reject')
    ) {
      return jsonResponse(200, { ok: true, data: { requestId: 'request-focused', status: 'approved' } })
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
    if (url.includes('/api/attendance/rules/me')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          userId: 'swap-user-a',
          orgId: 'default',
          resolvedForDate: '2026-04-15',
          assignment: { attendanceGroups: [], scheduleGroups: [] },
          runtimeRule: { timezone: 'Asia/Shanghai' },
          punchPolicy: { unscheduledMode: 'allow', outdoorApprovalRequired: false, merge: {} },
          warnings: [{ code: 'NO_ATTENDANCE_GROUP' }, { code: 'DEFAULT_RULE_FALLBACK' }],
        },
      })
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

function installShiftSwapSelfServiceMock(options: { actorUserId?: string } = {}) {
  const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
  const createBodies: unknown[] = []
  const acceptCalls: string[] = []
  const rejectCalls: string[] = []
  const cancelCalls: string[] = []
  const actorUserId = options.actorUserId ?? 'swap-user-a'
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const method = String((init as RequestInit | undefined)?.method || 'GET').toUpperCase()

    if (url.includes('/api/attendance/assignments?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              assignment: {
                id: 'assignment-a',
                userId: 'swap-user-a',
                shiftId: 'shift-a',
                startDate: '2026-04-15',
                endDate: '2026-04-15',
                isActive: true,
                publishStatus: 'published',
                assignmentKind: 'regular',
                producerType: null,
                slotIndex: 0,
              },
              shift: { id: 'shift-a', name: 'Morning', timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', lateGraceMinutes: 10, earlyGraceMinutes: 5, roundingMinutes: 5, workingDays: [1, 2, 3, 4, 5] },
            },
            {
              assignment: {
                id: 'assignment-b',
                userId: 'swap-user-b',
                shiftId: 'shift-b',
                startDate: '2026-04-16',
                endDate: '2026-04-16',
                isActive: true,
                publishStatus: 'published',
                assignmentKind: 'regular',
                producerType: null,
                slotIndex: 0,
              },
              shift: { id: 'shift-b', name: 'Evening', timezone: 'Asia/Shanghai', workStartTime: '13:00', workEndTime: '22:00', lateGraceMinutes: 10, earlyGraceMinutes: 5, roundingMinutes: 5, workingDays: [1, 2, 3, 4, 5] },
            },
          ],
          total: 2,
        },
      })
    }

    if (url.includes('/api/attendance/shift-swap-requests?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              requestId: 'swap-request-1',
              requestStatus: 'pending',
              requesterUserId: 'swap-user-a',
              counterpartyUserId: 'swap-user-b',
              counterpartyStatus: 'pending',
              requesterAssignmentId: 'assignment-a',
              counterpartyAssignmentId: 'assignment-b',
              requesterWorkDate: '2026-04-15',
              counterpartyWorkDate: '2026-04-16',
            },
          ].filter(item => item.requesterUserId === actorUserId || item.counterpartyUserId === actorUserId),
          total: actorUserId === 'swap-user-a' || actorUserId === 'swap-user-b' ? 1 : 0,
        },
      })
    }

    if (url.endsWith('/api/attendance/shift-swap-requests') && method === 'POST') {
      createBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body || '{}')))
      return jsonResponse(201, {
        ok: true,
        data: {
          request: { id: 'swap-request-1', request_type: 'shift_swap', status: 'pending', work_date: '2026-04-15', metadata: {} },
          shiftSwap: { requestId: 'swap-request-1', counterpartyStatus: 'pending' },
        },
      })
    }

    if (url.endsWith('/api/attendance/shift-swap-requests/swap-request-1/accept') && method === 'POST') {
      acceptCalls.push(url)
      return jsonResponse(200, {
        ok: true,
        data: {
          shiftSwap: {
            requestId: 'swap-request-1',
            requestStatus: 'pending',
            requesterUserId: 'swap-user-a',
            counterpartyUserId: 'swap-user-b',
            counterpartyStatus: 'accepted',
          },
        },
      })
    }

    if (url.endsWith('/api/attendance/shift-swap-requests/swap-request-1/reject') && method === 'POST') {
      rejectCalls.push(url)
      return jsonResponse(200, {
        ok: true,
        data: {
          shiftSwap: {
            requestId: 'swap-request-1',
            requestStatus: 'rejected',
            requesterUserId: 'swap-user-a',
            counterpartyUserId: 'swap-user-b',
            counterpartyStatus: 'rejected',
          },
        },
      })
    }

    if (url.endsWith('/api/attendance/shift-swap-requests/swap-request-1/cancel') && method === 'POST') {
      cancelCalls.push(url)
      return jsonResponse(200, {
        ok: true,
        data: {
          shiftSwap: {
            requestId: 'swap-request-1',
            requestStatus: 'cancelled',
            requesterUserId: 'swap-user-a',
            counterpartyUserId: 'swap-user-b',
            counterpartyStatus: 'pending',
          },
        },
      })
    }

    if (defaultImpl) return defaultImpl(input, init)
    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })

  return { createBodies, acceptCalls, rejectCalls, cancelCalls }
}

// MP-5: wrap the default overview mock so POST /api/attendance/requests returns a
// makeup-punch policy rejection (and capture each POST body). `succeedAfter`
// lets a retry succeed after N rejections (used by the attachment-retry test).
function installMakeupRejectMock(options: { code: string; status?: number; succeedAfter?: number }) {
  const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
  const createBodies: Array<Record<string, unknown>> = []
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const method = String((init as RequestInit | undefined)?.method || 'GET').toUpperCase()
    if (url.endsWith('/api/attendance/requests') && method === 'POST') {
      createBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body || '{}')))
      if (options.succeedAfter !== undefined && createBodies.length > options.succeedAfter) {
        return jsonResponse(200, { ok: true, data: { request: { id: 'req-new', status: 'pending' } } })
      }
      return jsonResponse(options.status ?? 422, {
        ok: false,
        error: { code: options.code, message: options.code },
      })
    }
    if (defaultImpl) return defaultImpl(input, init)
    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })
  return { createBodies }
}

function setFormValue(root: HTMLElement, selector: string, value: string): void {
  const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
  expect(el, `expected ${selector}`).toBeTruthy()
  el!.value = value
  el!.dispatchEvent(new Event(el!.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
}

function requestPostCount(): number {
  return vi.mocked(apiFetch).mock.calls.filter(([url, init]) =>
    String(url).endsWith('/api/attendance/requests')
    && String((init as RequestInit | undefined)?.method || 'GET').toUpperCase() === 'POST',
  ).length
}

function requestListGetCount(): number {
  return vi.mocked(apiFetch).mock.calls.filter(([url]) =>
    typeof url === 'string' && url.includes('/api/attendance/requests?'),
  ).length
}

function settingsFetchCount(): number {
  return vi.mocked(apiFetch).mock.calls.filter(([url]) =>
    typeof url === 'string' && url.includes('/api/attendance/settings'),
  ).length
}

describe('MP-5 makeup-punch request status copy (pure)', () => {
  const tr = (en: string) => en

  it('maps all seven MAKEUP_PUNCH_* codes with correct message/action', () => {
    const quota = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_QUOTA_EXCEEDED', tr)
    expect(quota?.message).toBe('Makeup-punch quota for this cycle has been used.')
    expect(quota?.action).toBe('reload-requests')

    const window = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_WINDOW_EXPIRED', tr)
    expect(window?.message).toContain('outside the allowed makeup-punch window')
    expect(window?.action).toBeUndefined()

    const future = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED', tr)
    expect(future?.message).toContain('Future work dates cannot be submitted')
    expect(future?.action).toBeUndefined()

    const type = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_TYPE_NOT_ALLOWED', tr)
    expect(type?.message).toContain('not eligible under the current makeup-punch policy')
    expect(type?.action).toBeUndefined()
    // Must not claim an anomaly definitely does not exist.
    expect(String(type?.hint)).not.toMatch(/no anomaly (exists|is present|was found)/i)
    expect(String(type?.hint)).toContain('anomaly quick action if available')

    const reason = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_REASON_REQUIRED', tr)
    expect(reason?.message).toContain('A reason is required')
    expect(reason?.action).toBe('retry-submit-request')

    const attachment = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_ATTACHMENT_REQUIRED', tr)
    expect(attachment?.message).toContain('An attachment is required')
    expect(attachment?.action).toBe('retry-submit-request')

    // CROSS_USER is PUT-only: covered by the pure mapper, never a faked POST.
    const crossUser = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_CROSS_USER_FORBIDDEN', tr)
    expect(crossUser?.message).toContain('cannot be edited for another user')
    expect(crossUser?.action).toBeUndefined()
  })

  it('returns null for non-makeup codes', () => {
    expect(resolveMakeupPunchRequestStatusCopy('PUNCH_TOO_SOON', tr)).toBeNull()
    expect(resolveMakeupPunchRequestStatusCopy('FORBIDDEN', tr)).toBeNull()
    expect(resolveMakeupPunchRequestStatusCopy('', tr)).toBeNull()
  })

  it('renders Chinese copy when tr picks the zh string', () => {
    const zh = (_en: string, zhText: string) => zhText
    const quota = resolveMakeupPunchRequestStatusCopy('MAKEUP_PUNCH_QUOTA_EXCEEDED', zh)
    expect(quota?.message).toContain('补卡')
  })
})

describe('Attendance self-service dashboard', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T08:00:00Z'))
    authMockState.currentUserId = 'swap-user-a'
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
    // Employee-overview task-first design-lock (RATIFIED 2026-07-21) §4.2: ONE
    // canonical attention item replaces the old focus-list + primary-action
    // "two competing copies" (data-selfservice-focus-list / -primary-action).
    expect(container?.querySelector('[data-attendance-overview-attention]')?.textContent).toContain('Resolve anomaly reminders')
    expect(container?.querySelector('[data-attendance-overview-attention]')?.getAttribute('data-attendance-overview-attention-key')).toBe('anomaly')
    expect(container?.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('Pending · 1')
    expect(container?.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('Approved · 1')
    expect(container?.querySelector('[data-selfservice-card="requests"]')?.textContent).toContain('Rejected · 1')
    expect(container?.querySelector('[data-selfservice-request-followup]')?.textContent).toContain('Pending follow-up')
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Shanghai Store A')
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Morning rotation')
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('09:00-18:00 · Asia/Shanghai')
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Mon, Tue, Wed, Thu, Fri')
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Late 5m / Early 5m')
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Severe 30m / Absence 60m')
    expect(container?.querySelector('[data-selfservice-rules-warnings]')?.textContent).toContain('Group rule is preview-only')
    const rulesCard = container?.querySelector('[data-selfservice-card="rules"]')?.textContent ?? ''
    expect(rulesCard).not.toContain('raw-geofence-secret')
    expect(rulesCard).not.toContain('approvalFlowId')
    expect(rulesCard).not.toContain('approval-flow-secret')
    expect(rulesCard).not.toContain('wifi-secret')
    expect(rulesCard).not.toContain('integration-secret')
    expect(container?.querySelector('[data-selfservice-card="actions"]')?.textContent).toContain('Fix missing punch')
    expect(container?.querySelector('[data-selfservice-card="guide"]')?.textContent).toContain('Adjusted')
    expect(container?.querySelector('[data-selfservice-card="guide"]')?.textContent).toContain('manual correction')
  })

  // ---- Employee-overview task-first design-lock (RATIFIED 2026-07-21) ----
  // docs/development/attendance-employee-overview-task-first-design-lock-20260716.md
  // AttendanceEmployeeWorkspace.vue mounted coverage: Today/attention/tools
  // band order (§4, §9.2), OD-O1 first-match precedence surfaced through the
  // mount, OD-O2 collapsed-by-default history disclosure + expand without
  // reset, OD-O3 requests/quick-actions-before-balance/rules ordering, and
  // the statusMessage visibility guard (§5: "not part of the disclosure").

  function domOrderIndex(container: HTMLElement, selector: string): number {
    const el = container.querySelector(selector)
    expect(el, `expected an element for ${selector}`).toBeTruthy()
    return Array.from(container.querySelectorAll('*')).indexOf(el as Element)
  }

  it('W2/4355 DOM order: Today -> Needs-attention -> tools bands, and exactly one primary attention action', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const heroIndex = domOrderIndex(container!, '[data-testid="attendance-hero-punch"]')
    const todayStatusIndex = domOrderIndex(container!, '[data-selfservice-card="status"]')
    const attentionIndex = domOrderIndex(container!, '[data-attendance-overview-attention]')
    const requestsIndex = domOrderIndex(container!, '[data-selfservice-card="requests"]')
    const actionsIndex = domOrderIndex(container!, '[data-selfservice-card="actions"]')
    const balanceIndex = domOrderIndex(container!, '[data-selfservice-card="annual-balance"]')
    const rulesIndex = domOrderIndex(container!, '[data-selfservice-card="rules"]')
    const filtersIndex = domOrderIndex(container!, '[data-attendance-history-filters]')
    const summaryIndex = domOrderIndex(container!, '#attendance-overview-requests')
    const guideIndex = domOrderIndex(container!, '[data-selfservice-card="guide"]')

    expect(heroIndex).toBeLessThan(todayStatusIndex)
    expect(todayStatusIndex).toBeLessThan(attentionIndex)
    expect(attentionIndex).toBeLessThan(requestsIndex)
    // OD-O3: request status + quick actions ahead of annual balance/rules.
    expect(requestsIndex).toBeLessThan(actionsIndex)
    expect(actionsIndex).toBeLessThan(balanceIndex)
    expect(balanceIndex).toBeLessThan(rulesIndex)
    expect(rulesIndex).toBeLessThan(filtersIndex)
    // lock §5: the history disclosure sits immediately before historical content.
    expect(filtersIndex).toBeLessThan(summaryIndex)
    // lock §4.3 item 6: status guide is the last, lowest-frequency surface — pinned against EVERY
    // historical section, not just the requests summary (review NIT: under-pinned order).
    const anomaliesIndex = domOrderIndex(container!, '#attendance-overview-anomalies')
    const requestReportIndex = domOrderIndex(container!, '#attendance-overview-request-report')
    expect(summaryIndex).toBeLessThan(guideIndex)
    expect(anomaliesIndex).toBeLessThan(guideIndex)
    expect(requestReportIndex).toBeLessThan(guideIndex)

    // §9.2: exactly one primary recommended action across the whole page.
    expect(container!.querySelectorAll('[data-attendance-overview-attention-action]')).toHaveLength(1)
    expect(container!.querySelector('[data-attendance-overview-attention]')?.getAttribute('data-attendance-overview-attention-key')).toBe('anomaly')
  })

  it('W2/4355 OD-O1: an actionable punch failure outranks anomaly/pending in the attention band, with no second retry control', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch')) {
        return jsonResponse(400, { ok: false, error: { code: 'PUNCH_TOO_SOON', message: 'PUNCH_TOO_SOON' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check Out').click()
    await flushUi(4)

    const attention = container!.querySelector('[data-attendance-overview-attention]')
    expect(attention?.getAttribute('data-attendance-overview-attention-key')).toBe('punch_failure')
    expect(attention?.textContent).not.toContain('Resolve anomaly reminders')
    // The status banner (Today band) carries the one real retry for this
    // state; the attention band must not render a second actionable control.
    expect(container!.querySelectorAll('[data-attendance-overview-attention-action]')).toHaveLength(0)
    expect(container!.textContent).toContain('Retry refresh')
  })

  it('W2/4355 negative scoping: a NON-punch error must never occupy the punch_failure attention slot', async () => {
    // Review P3-a: punchFailureActive = statusKind==='error' AND statusSource==='punch'. The shared
    // status banner is reused by refresh/admin/import/save paths with source=null — a regression that
    // widens statusSource to every error must turn THIS leg red (the sibling punch test alone cannot:
    // it only ever drives a punch error).
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // After a clean mount, make every attendance GET fail, then drive the overview Refresh action —
    // a non-punch setStatus(error) path (source=null) through the SHARED banner.
    vi.mocked(apiFetch).mockImplementation(async () =>
      jsonResponse(500, { ok: false, error: { code: 'INTERNAL', message: 'refresh boom' } }))

    const details = container!.querySelector('[data-attendance-history-filters]') as HTMLDetailsElement
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    await flushUi()
    findButton(container!, 'Refresh').click()
    await flushUi(4)

    // Positive control INSIDE the negative test: the refresh failure genuinely reached the shared
    // banner (its retry control renders the refresh-overview action label) — without this the leg
    // could pass vacuously with no error at all.
    expect(container!.textContent).toContain('Retry refresh')

    const attention = container!.querySelector('[data-attendance-overview-attention]')
    expect(attention).toBeTruthy()
    expect(attention?.getAttribute('data-attendance-overview-attention-key')).not.toBe('punch_failure')
  })

  it('W2/4355 OD-O2: history filters start collapsed, expand without resetting values or firing new requests', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const details = container!.querySelector('[data-attendance-history-filters]') as HTMLDetailsElement
    expect(details).toBeTruthy()
    expect(details.open).toBe(false)

    const orgInput = container!.querySelector<HTMLInputElement>('input[name="orgId"]')
    expect(orgInput).toBeTruthy()
    orgInput!.value = 'collapsed-entry-org'
    orgInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const callsBeforeExpand = vi.mocked(apiFetch).mock.calls.length
    const summary = details.querySelector('summary') as HTMLElement
    summary.click()
    await flushUi()

    expect(details.open).toBe(true)
    expect(orgInput!.value).toBe('collapsed-entry-org')
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(callsBeforeExpand)

    summary.click()
    await flushUi()
    expect(details.open).toBe(false)
    expect(orgInput!.value).toBe('collapsed-entry-org')
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(callsBeforeExpand)
  })

  it('W2/4355 statusMessage visibility guard: stays outside the disclosure and visible while filters are collapsed', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch')) {
        return jsonResponse(400, { ok: false, error: { code: 'PUNCH_TOO_SOON', message: 'PUNCH_TOO_SOON' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const details = container!.querySelector('[data-attendance-history-filters]') as HTMLDetailsElement
    expect(details.open).toBe(false)

    findButton(container!, 'Check Out').click()
    await flushUi(4)

    expect(container!.textContent).toContain('Punch interval is too short. Try again shortly.')
    const statusBlock = container!.querySelector('.attendance__status-block')
    expect(statusBlock).toBeTruthy()
    expect(details.contains(statusBlock)).toBe(false)
    expect(details.open).toBe(false)
  })

  it('W2/4355 compatibility: the five reused state signals still surface through their preserved anchors', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // activeWorkbenchRecord — Today status card, unchanged anchor.
    expect(container!.querySelector('[data-selfservice-card="status"]')?.textContent).toContain('Late + Early')
    // heroTodayTimeline — unchanged data-testid.
    expect(container!.querySelector('[data-testid="attendance-hero-timeline"]')).toBeTruthy()
    // selfServiceRequestFollowup — unchanged anchor, still request-card-owned.
    expect(container!.querySelector('[data-selfservice-request-followup]')?.textContent).toContain('Pending follow-up')
    // selfServiceFocusItems / selfServicePrimaryAction — deliberately
    // consolidated (lock §4.2) into the single attention-band anchor; the
    // underlying facts (anomaly count) still surface, just once.
    expect(container!.querySelector('[data-attendance-overview-attention]')?.textContent).toContain('Resolve anomaly reminders')
    expect(container!.querySelector('[data-selfservice-focus-list]')).toBeNull()
    expect(container!.querySelector('[data-selfservice-primary-action]')).toBeNull()
  })

  it('updates self-service rules weekday labels when the locale changes', async () => {
    useLocale().setLocale('en')
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const rulesCard = () => container?.querySelector('[data-selfservice-card="rules"]')?.textContent ?? ''
    expect(rulesCard()).toContain('Mon, Tue, Wed, Thu, Fri')

    useLocale().setLocale('zh-CN')
    await flushUi(4)

    expect(rulesCard()).toContain('周一, 周二, 周三, 周四, 周五')
    expect(rulesCard()).not.toContain('Mon, Tue, Wed, Thu, Fri')
  })

  it('clears stale self-service rules while a reload is in flight', async () => {
    installOverviewMock()
    const baseImpl = vi.mocked(apiFetch).getMockImplementation()
    let rulesCallCount = 0
    let resolveSecondRules: ((response: Response) => void) | null = null
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rules/me')) {
        rulesCallCount += 1
        if (rulesCallCount === 1) {
          return jsonResponse(200, {
            ok: true,
            data: {
              userId: 'swap-user-a',
              orgId: 'default',
              assignment: { attendanceGroups: [{ id: 'group-a', name: 'Store A' }], scheduleGroups: [] },
              runtimeRule: { timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
              punchPolicy: { unscheduledMode: 'block', outdoorApprovalRequired: false, merge: {} },
              warnings: [],
            },
          })
        }
        return new Promise<Response>((resolve) => {
          resolveSecondRules = resolve
        })
      }
      if (baseImpl) return baseImpl(input, init)
      return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(12)
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Store A')

    findButton(container!, 'Refresh').click()
    await flushUi(2)
    const rulesCardDuringLoad = container?.querySelector('[data-selfservice-card="rules"]')?.textContent ?? ''
    expect(rulesCardDuringLoad).not.toContain('Store A')
    expect(rulesCardDuringLoad).toContain('Loading...')

    expect(resolveSecondRules).toBeTruthy()
    resolveSecondRules!(jsonResponse(200, {
      ok: true,
      data: {
        userId: 'swap-user-a',
        orgId: 'default',
        assignment: { attendanceGroups: [{ id: 'group-b', name: 'Store B' }], scheduleGroups: [] },
        runtimeRule: { timezone: 'Asia/Shanghai', workStartTime: '10:00', workEndTime: '19:00', workingDays: [2, 3, 4] },
        punchPolicy: { unscheduledMode: 'allow', outdoorApprovalRequired: false, merge: {} },
        warnings: [],
      },
    }))
    await flushUi(12)
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Store B')
  })

  it('clears stale self-service rules when a reload fails', async () => {
    installOverviewMock()
    const baseImpl = vi.mocked(apiFetch).getMockImplementation()
    let rulesCallCount = 0
    let resolveSecondRules: ((response: Response) => void) | null = null
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/rules/me')) {
        rulesCallCount += 1
        if (rulesCallCount === 1) {
          return jsonResponse(200, {
            ok: true,
            data: {
              userId: 'swap-user-a',
              orgId: 'default',
              assignment: { attendanceGroups: [{ id: 'group-a', name: 'Store A' }], scheduleGroups: [] },
              runtimeRule: { timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
              punchPolicy: { unscheduledMode: 'block', outdoorApprovalRequired: false, merge: {} },
              warnings: [],
            },
          })
        }
        return new Promise<Response>((resolve) => {
          resolveSecondRules = resolve
        })
      }
      if (baseImpl) return baseImpl(input, init)
      return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(12)
    expect(container?.querySelector('[data-selfservice-card="rules"]')?.textContent).toContain('Store A')

    findButton(container!, 'Refresh').click()
    await flushUi(2)
    const rulesCardDuringLoad = container?.querySelector('[data-selfservice-card="rules"]')?.textContent ?? ''
    expect(rulesCardDuringLoad).not.toContain('Store A')
    expect(rulesCardDuringLoad).toContain('Loading...')

    expect(resolveSecondRules).toBeTruthy()
    resolveSecondRules!(jsonResponse(500, { ok: false, error: { message: 'rules failed' } }))
    await flushUi(12)
    const rulesCardAfterFailure = container?.querySelector('[data-selfservice-card="rules"]')?.textContent ?? ''
    expect(rulesCardAfterFailure).toContain('rules failed')
    expect(rulesCardAfterFailure).not.toContain('Store A')
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

    const requestsCard = container!.querySelector('[data-selfservice-card="requests"]')?.textContent ?? ''
    const actionsCard = container!.querySelector('[data-selfservice-card="actions"]')?.textContent ?? ''
    const attentionBand = container!.querySelector('[data-attendance-overview-attention]')?.textContent ?? ''

    // Employee-overview task-first design-lock (RATIFIED 2026-07-21) §4.1:
    // Today's status card is narrowed to exactly latest-punch/work-minutes/
    // late-early — the anomaly count/copy moves to the single Needs-attention
    // item (§4.2), which is anomaly (priority 2) here, never a second
    // competing "Track pending approvals" copy for the same fixture.
    expect(attentionBand).toContain('Resolve anomaly reminders')
    expect(attentionBand).not.toContain('Track pending approvals')
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
    expect(actionsCard).toContain('Start with missing-punch handling to resolve the current anomaly reminder.')
  })

  it('hides approval actions from employee self-service request cards', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    expect(findButton(container!, 'Cancel')).toBeTruthy()
    expect(Array.from(container!.querySelectorAll('button')).some(
      candidate => candidate.textContent?.trim() === 'Approve'
    )).toBe(false)
    expect(Array.from(container!.querySelectorAll('button')).some(
      candidate => candidate.textContent?.trim() === 'Reject'
    )).toBe(false)
    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      /\/api\/attendance\/requests\/request-pending\/(?:approve|reject)/.test(String(call[0]))
    )).toBe(false)
  })

  it('opens a focused attendance approval request from approval center and exposes review actions', async () => {
    app = createApp(AttendanceView, {
      mode: 'overview',
      initialSectionId: 'attendance-overview-requests',
      initialRequestId: 'request-focused',
    })
    app.mount(container!)
    await flushUi(12)

    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]).endsWith('/api/attendance/requests/request-focused'),
    )).toBe(true)

    const focusedItem = container!.querySelector<HTMLElement>('[data-attendance-request-id="request-focused"]')
    expect(focusedItem).toBeTruthy()
    expect(focusedItem?.dataset.attendanceRequestFocused).toBe('true')
    expect(focusedItem?.textContent).toContain('Opened from Approval Center')
    expect(focusedItem?.textContent).toContain('Time correction')
    expect(focusedItem?.textContent).toContain('Approval-center pending item')
    expect(focusedItem?.textContent).toContain('Approve')
    expect(focusedItem?.textContent).toContain('Reject')

    findButton(container!, 'Approve').click()
    await flushUi(12)

    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]).includes('/api/attendance/requests/request-focused/approve'),
    )).toBe(true)
  })

  it('keeps the request list available when the focused approval request cannot be loaded', async () => {
    app = createApp(AttendanceView, {
      mode: 'overview',
      initialSectionId: 'attendance-overview-requests',
      initialRequestId: 'request-missing',
    })
    app.mount(container!)
    await flushUi(12)

    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]).endsWith('/api/attendance/requests/request-missing'),
    )).toBe(true)

    expect(container!.textContent).toContain('Focused request is no longer available.')
    expect(container!.textContent).toContain('Family medical appointment')
    expect(container!.querySelector('[data-attendance-request-focused="true"]')).toBeNull()
  })

  it('keeps focused attendance rejection comment required before calling the API', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce('').mockReturnValueOnce('Need evidence')

    app = createApp(AttendanceView, {
      mode: 'overview',
      initialSectionId: 'attendance-overview-requests',
      initialRequestId: 'request-focused',
    })
    app.mount(container!)
    await flushUi(12)

    findButton(container!, 'Reject').click()
    await flushUi(4)

    expect(vi.mocked(apiFetch).mock.calls.some(call =>
      String(call[0]).includes('/api/attendance/requests/request-focused/reject'),
    )).toBe(false)
    expect(container!.textContent).toContain('Rejection reason is required.')

    findButton(container!, 'Reject').click()
    await flushUi(12)

    const rejectCall = vi.mocked(apiFetch).mock.calls.find(call =>
      String(call[0]).includes('/api/attendance/requests/request-focused/reject'),
    )
    expect(rejectCall).toBeTruthy()
    expect(JSON.parse(String(rejectCall?.[1]?.body ?? '{}'))).toEqual({ comment: 'Need evidence' })
    promptSpy.mockRestore()
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

  it('submits shift-swap requests through the dedicated route with exact assignment ids', async () => {
    authMockState.currentUserId = 'swap-user-a'
    const { createBodies } = installShiftSwapSelfServiceMock({ actorUserId: 'swap-user-a' })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const requestType = container!.querySelector<HTMLSelectElement>('#attendance-request-type')
    expect(requestType).toBeTruthy()
    requestType!.value = 'shift_swap'
    requestType!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(3)

    const requesterAssignment = container!.querySelector<HTMLSelectElement>('#attendance-shift-swap-requester-assignment')
    const counterpartyAssignment = container!.querySelector<HTMLSelectElement>('#attendance-shift-swap-counterparty-assignment')
    expect(requesterAssignment).toBeTruthy()
    expect(counterpartyAssignment).toBeTruthy()
    expect(requesterAssignment!.value).toBe('assignment-a')
    expect(counterpartyAssignment!.value).toBe('assignment-b')

    const reason = container!.querySelector<HTMLInputElement>('#attendance-request-reason')
    expect(reason).toBeTruthy()
    reason!.value = 'Need to swap with evening shift'
    reason!.dispatchEvent(new Event('input', { bubbles: true }))

    findButton(container!, 'Submit request').click()
    await flushUi(4)

    expect(createBodies).toEqual([
      {
        requesterAssignmentId: 'assignment-a',
        counterpartyAssignmentId: 'assignment-b',
        reason: 'Need to swap with evening shift',
      },
    ])
    const genericRequestPosts = vi.mocked(apiFetch).mock.calls.filter(([url, init]) =>
      String(url).endsWith('/api/attendance/requests')
      && String((init as RequestInit | undefined)?.method || 'GET').toUpperCase() === 'POST',
    )
    expect(genericRequestPosts).toEqual([])
  })

  it('lets the counterparty accept a pending shift-swap request from the dedicated list', async () => {
    authMockState.currentUserId = 'swap-user-b'
    const { acceptCalls } = installShiftSwapSelfServiceMock({ actorUserId: 'swap-user-b' })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const shiftSwapSection = container!.querySelector<HTMLElement>('[data-shift-swap-requests]')
    expect(shiftSwapSection).toBeTruthy()
    expect(shiftSwapSection!.textContent).toContain('Counterparty pending')
    expect(shiftSwapSection!.textContent).toContain('swap-user-a')
    expect(shiftSwapSection!.textContent).toContain('swap-user-b')
    expect(shiftSwapSection!.textContent).toContain('Accept swap')
    expect(shiftSwapSection!.textContent).toContain('Reject swap')
    expect(shiftSwapSection!.textContent).not.toContain('Cancel')

    findButton(container!, 'Accept swap').click()
    await flushUi(4)

    expect(acceptCalls).toEqual(['/api/attendance/shift-swap-requests/swap-request-1/accept'])
  })

  it('lets the counterparty reject a pending shift-swap request through the dedicated route', async () => {
    authMockState.currentUserId = 'swap-user-b'
    const { rejectCalls } = installShiftSwapSelfServiceMock({ actorUserId: 'swap-user-b' })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const shiftSwapSection = container!.querySelector<HTMLElement>('[data-shift-swap-requests]')
    expect(shiftSwapSection).toBeTruthy()
    expect(shiftSwapSection!.textContent).toContain('Reject swap')
    expect(shiftSwapSection!.textContent).not.toContain('Cancel')

    findButton(container!, 'Reject swap').click()
    await flushUi(4)

    expect(rejectCalls).toEqual(['/api/attendance/shift-swap-requests/swap-request-1/reject'])
  })

  it('lets the requester cancel a pending shift-swap request through the dedicated route', async () => {
    authMockState.currentUserId = 'swap-user-a'
    const { cancelCalls } = installShiftSwapSelfServiceMock({ actorUserId: 'swap-user-a' })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const shiftSwapSection = container!.querySelector<HTMLElement>('[data-shift-swap-requests]')
    expect(shiftSwapSection).toBeTruthy()
    expect(shiftSwapSection!.textContent).toContain('Cancel')
    expect(shiftSwapSection!.textContent).not.toContain('Accept swap')
    expect(shiftSwapSection!.textContent).not.toContain('Reject swap')

    const cancel = Array.from(shiftSwapSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Cancel')
    expect(cancel).toBeTruthy()
    cancel!.click()
    await flushUi(4)

    expect(cancelCalls).toEqual(['/api/attendance/shift-swap-requests/swap-request-1/cancel'])
  })

  it('explains zero-data onboarding when no attendance records exist yet', async () => {
    installZeroStateMock()
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const statusCard = container!.querySelector('[data-selfservice-card="status"]')?.textContent ?? ''
    const setupHint = container!.querySelector('[data-selfservice-setup-hint]')?.textContent ?? ''
    const attentionBand = container!.querySelector('[data-attendance-overview-attention]')?.textContent ?? ''
    const attentionKey = container!.querySelector('[data-attendance-overview-attention]')?.getAttribute('data-attendance-overview-attention-key')
    const actionsCard = container!.querySelector('[data-selfservice-card="actions"]')?.textContent ?? ''

    expect(statusCard).toContain('No attendance data is available in this range yet.')
    expect(setupHint).toContain('you may not be assigned to an attendance group yet')
    expect(setupHint).toContain('confirm your group and shift setup')
    // Employee-overview task-first design-lock §4.2 row 6 (setup_needed):
    // the single canonical attention item reuses this same setup guidance —
    // no fabricated CTA and no second competing "primary action" copy.
    expect(attentionKey).toBe('setup_needed')
    expect(attentionBand).toContain('Check attendance setup')
    expect(container!.querySelector('[data-attendance-overview-attention-action]')).toBeNull()
    expect(actionsCard).toContain('confirm your group and shift setup')

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

  // ---- MP-5 makeup-punch request-side UX runtime ----

  it('MP-5 no-success-on-reject: anomaly-prefilled draft rejected with QUOTA_EXCEEDED shows failure, appends no row', async () => {
    const { createBodies } = installMakeupRejectMock({ code: 'MAKEUP_PUNCH_QUOTA_EXCEEDED', status: 409 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // Anomaly quick action = per-anomaly "Create request" button → prefill only, no POST.
    findButton(container!, 'Create request').click()
    await flushUi(3)
    expect(container!.querySelector<HTMLSelectElement>('#attendance-request-type')?.value).toBe('missed_check_in')
    expect(requestPostCount()).toBe(0)

    const listGetsBefore = requestListGetCount()
    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('Makeup-punch quota for this cycle has been used.')
    expect(pageText).toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')
    expect(pageText).toContain('Reload requests')
    expect(pageText).not.toContain('Request submitted.')
    expect(createBodies).toHaveLength(1)
    // Reject must not reload the request list → no fake row appended for this date.
    expect(requestListGetCount()).toBe(listGetsBefore)
  })

  it('MP-5 mapper: WINDOW_EXPIRED direct submit shows localized message + code, no action button', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_WINDOW_EXPIRED', status: 422 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    setFormValue(container!, '#attendance-request-type', 'missed_check_in')
    await flushUi(2)
    setFormValue(container!, '#attendance-request-work-date', '2026-04-01')
    setFormValue(container!, '#attendance-request-in', '2026-04-01T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('This work date is outside the allowed makeup-punch window.')
    expect(pageText).toContain('Code: MAKEUP_PUNCH_WINDOW_EXPIRED')
    expect(pageText).not.toContain('Request submitted.')
  })

  it('MP-5 mapper: FUTURE_DATE_UNSUPPORTED direct submit shows localized message + code', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED', status: 422 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    setFormValue(container!, '#attendance-request-type', 'missed_check_in')
    await flushUi(2)
    setFormValue(container!, '#attendance-request-work-date', '2026-05-01')
    setFormValue(container!, '#attendance-request-in', '2026-05-01T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('Future work dates cannot be submitted for makeup punch.')
    expect(pageText).toContain('Code: MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED')
    expect(pageText).not.toContain('Request submitted.')
  })

  it('MP-5 mapper: TYPE_NOT_ALLOWED hint points to policy eligibility, never "no anomaly exists"', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_TYPE_NOT_ALLOWED', status: 422 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Create request').click()
    await flushUi(3)
    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('The selected date/type is not eligible under the current makeup-punch policy.')
    expect(pageText).toContain('Code: MAKEUP_PUNCH_TYPE_NOT_ALLOWED')
    expect(pageText).toContain('anomaly quick action if available')
    expect(pageText).not.toMatch(/no anomaly (exists|is present|was found)/i)
    expect(pageText).not.toContain('Request submitted.')
  })

  it('MP-5 mapper: REASON_REQUIRED keeps a submit-focused retry action', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_REASON_REQUIRED', status: 422 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    setFormValue(container!, '#attendance-request-type', 'missed_check_in')
    await flushUi(2)
    setFormValue(container!, '#attendance-request-work-date', '2026-04-13')
    setFormValue(container!, '#attendance-request-in', '2026-04-13T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('A reason is required by the makeup-punch policy.')
    expect(pageText).toContain('Code: MAKEUP_PUNCH_REASON_REQUIRED')
    expect(pageText).toContain('Retry submit request')
    expect(pageText).not.toContain('Request submitted.')
  })

  it('MP-5 attachment gate: ATTACHMENT_REQUIRED exposes the input; retry after filling sends attachmentUrl', async () => {
    const { createBodies } = installMakeupRejectMock({
      code: 'MAKEUP_PUNCH_ATTACHMENT_REQUIRED',
      status: 422,
      succeedAfter: 1,
    })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    setFormValue(container!, '#attendance-request-type', 'time_correction')
    await flushUi(2)
    // Attachment field is exposed for makeup request types (broadened v-if).
    const attachments = container!.querySelectorAll('#attendance-request-attachment')
    expect(attachments).toHaveLength(1) // no duplicate DOM id
    setFormValue(container!, '#attendance-request-work-date', '2026-04-13')
    setFormValue(container!, '#attendance-request-in', '2026-04-13T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    const afterReject = container!.textContent ?? ''
    expect(afterReject).toContain('An attachment is required by the makeup-punch policy.')
    expect(afterReject).toContain('Code: MAKEUP_PUNCH_ATTACHMENT_REQUIRED')
    expect(afterReject).toContain('Retry submit request')
    expect(afterReject).not.toContain('Request submitted.')
    expect(createBodies).toHaveLength(1)
    expect(createBodies[0].attachmentUrl).toBeUndefined()

    // Fill the attachment URL and retry → succeeds and carries attachmentUrl.
    setFormValue(container!, '#attendance-request-attachment', 'https://example.com/proof.png')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    expect(createBodies).toHaveLength(2)
    expect(createBodies[1].attachmentUrl).toBe('https://example.com/proof.png')
  })

  it('MP-5 shared path: missing-punch quick action (with anomaly) posts exactly one request, none during prefill', async () => {
    const { createBodies } = installMakeupRejectMock({ code: 'IGNORED', succeedAfter: 0 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-selfservice-action="missing-punch"]')!.click()
    await flushUi(3)
    expect(container!.querySelector<HTMLSelectElement>('#attendance-request-type')?.value).toBe('missed_check_in')
    expect(requestPostCount()).toBe(0)

    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    expect(requestPostCount()).toBe(1)
    expect(createBodies).toHaveLength(1)
    expect(createBodies[0].requestType).toBe('missed_check_in')
  })

  it('MP-5 shared path: missing-punch quick action with no anomaly still posts one request', async () => {
    installOverviewMock()
    const baseImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/anomalies?')) {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      if (baseImpl) return baseImpl(input, init)
      return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    })
    const { createBodies } = installMakeupRejectMock({ code: 'IGNORED', succeedAfter: 0 })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-selfservice-action="missing-punch"]')!.click()
    await flushUi(3)
    expect(container!.querySelector<HTMLSelectElement>('#attendance-request-type')?.value).toBe('missed_check_in')
    expect(container!.querySelector<HTMLInputElement>('#attendance-request-work-date')?.value).toBeTruthy()
    expect(requestPostCount()).toBe(0)

    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)

    expect(requestPostCount()).toBe(1)
    expect(createBodies).toHaveLength(1)
  })

  it('MP-5 no settings leak: the employee MP-5 flow makes no GET /api/attendance/settings', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_QUOTA_EXCEEDED', status: 409 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Create request').click()
    await flushUi(3)
    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)
    container!.querySelector<HTMLButtonElement>('[data-selfservice-action="missing-punch"]')!.click()
    await flushUi(3)

    expect(settingsFetchCount()).toBe(0)
  })

  it('MP-5 stale-error: a new prefill clears a prior request-submit rejection banner', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_QUOTA_EXCEEDED', status: 409 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Create request').click()
    await flushUi(3)
    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)
    expect(container!.textContent).toContain('Makeup-punch quota for this cycle has been used.')
    expect(container!.textContent).toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')

    // A fresh prefill must drop the stale request-submit rejection banner.
    container!.querySelector<HTMLButtonElement>('[data-selfservice-action="missing-punch"]')!.click()
    await flushUi(3)
    expect(container!.textContent).not.toContain('Makeup-punch quota for this cycle has been used.')
    expect(container!.textContent).not.toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')
  })

  it('MP-5 stale-error: manually CHANGING the draft (work date) clears a prior request-submit rejection', async () => {
    // §6 gate-4 is "changing OR refilling"; this covers the changing half — a hand edit
    // of a form field, with no fresh prefill, must still drop a prior MAKEUP_PUNCH_* banner.
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_QUOTA_EXCEEDED', status: 409 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Create request').click()
    await flushUi(3)
    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)
    expect(container!.textContent).toContain('Makeup-punch quota for this cycle has been used.')
    expect(container!.textContent).toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')

    // Manually edit the work-date field only (no quick action / no prefill).
    setFormValue(container!, '#attendance-request-work-date', '2026-04-20')
    await flushUi(2)
    expect(container!.textContent).not.toContain('Makeup-punch quota for this cycle has been used.')
    expect(container!.textContent).not.toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')
  })

  it('MP-5 stale-error: manually CHANGING the request type clears a prior request-submit rejection', async () => {
    installMakeupRejectMock({ code: 'MAKEUP_PUNCH_QUOTA_EXCEEDED', status: 409 })
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Create request').click()
    await flushUi(3)
    setFormValue(container!, '#attendance-request-in', '2026-04-15T09:00')
    findButton(container!, 'Submit request').click()
    await flushUi(4)
    expect(container!.textContent).toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')

    setFormValue(container!, '#attendance-request-type', 'time_correction')
    await flushUi(2)
    expect(container!.textContent).not.toContain('Makeup-punch quota for this cycle has been used.')
    expect(container!.textContent).not.toContain('Code: MAKEUP_PUNCH_QUOTA_EXCEEDED')
  })

  it('UI-P0 hero punch card: live clock renders and punch buttons keep their contract', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, data: { items: [], summary: null } }))

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(4)

    const hero = container!.querySelector('[data-testid="attendance-hero-punch"]') as HTMLElement | null
    expect(hero, 'expected hero punch card in overview mode').toBeTruthy()
    const time = hero!.querySelector('[data-testid="attendance-hero-time"]') as HTMLElement
    expect(time.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/)

    const checkIn = Array.from(hero!.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === 'Check In'
    )
    expect(checkIn, 'Check In stays findable by copy').toBeTruthy()
    expect(checkIn!.classList.contains('attendance__btn')).toBe(true)
    expect(checkIn!.classList.contains('attendance__btn--primary')).toBe(true)
    expect(checkIn!.classList.contains('attendance__btn--hero')).toBe(true)
    const checkOut = Array.from(hero!.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === 'Check Out'
    )
    expect(checkOut, 'Check Out stays findable by copy').toBeTruthy()
    expect(checkOut!.classList.contains('attendance__btn')).toBe(true)
  })

  it('UI-P0 hero punch card: absent outside overview mode', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, data: { items: [], summary: null } }))

    app = createApp(AttendanceView, { mode: 'reports' })
    app.mount(container!)
    await flushUi(4)

    expect(container!.querySelector('[data-testid="attendance-hero-punch"]')).toBeNull()
  })

  it('UI-P1: hero today timeline renders both punches from the current-day record', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const timeline = container!.querySelector('[data-testid="attendance-hero-timeline"]') as HTMLElement | null
    expect(timeline, 'expected today timeline in hero card').toBeTruthy()
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeOf = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
    expect(timeline!.textContent).toContain(timeOf('2026-04-15T09:18:00+08:00'))
    expect(timeline!.textContent).toContain(timeOf('2026-04-15T17:42:00+08:00'))
    expect(timeline!.querySelectorAll('.attendance__hero-timeline-node--pending')).toHaveLength(0)
  })

  it('UI-P1: stat cards keep their copy and color late/early as warning', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // Employee-overview task-first design-lock (RATIFIED 2026-07-21) §4.1:
    // Today's status card narrows to exactly latest-punch/work-minutes/
    // late-early — no fourth "Attention items" stat (that signal now lives
    // solely in the Needs-attention band, §4.2, avoiding a second copy).
    const summary = container!.querySelector('.attendance__summary--workbench') as HTMLElement
    expect(summary.textContent).toContain('Latest punch')
    expect(summary.textContent).toContain('Work minutes')
    expect(summary.textContent).toContain('Late / Early')
    expect(summary.textContent).not.toContain('Attention items')
    const warning = summary.querySelector('.attendance__summary-value--warning') as HTMLElement | null
    expect(warning, 'late/early 18/18 should color as warning').toBeTruthy()
    expect(warning!.textContent).toContain('18 / 18')
  })

  it('UI-P1: no timeline when the active record is not from today', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    const baseImpl = apiFetchMock.getMockImplementation()!
    apiFetchMock.mockImplementation(async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.includes('/api/attendance/records?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [{
              id: 'record-yesterday',
              work_date: '2026-04-14',
              first_in_at: '2026-04-14T09:00:00+08:00',
              last_out_at: '2026-04-14T18:06:00+08:00',
              work_minutes: 486,
              late_minutes: 0,
              early_leave_minutes: 0,
              status: 'adjusted',
              meta: {},
            }],
            total: 1,
          },
        })
      }
      return baseImpl(input as never, init as never)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-testid="attendance-hero-timeline"]')).toBeNull()
  })

  it('UI-P1 768px targets exist: stat-card container class + filter fields (selector-preservation guard)', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // The 768px media rules key off these; assert the selectors' DOM targets
    // survive (the media query itself is verified on-device per E4).
    expect(container!.querySelector('.attendance__summary--stat'), 'stat-card container').toBeTruthy()
    const filterFields = container!.querySelectorAll('.attendance__filters .attendance__field')
    expect(filterFields.length, 'filter fields present').toBeGreaterThan(0)
    expect(container!.querySelector('.attendance__hero-timeline'), 'hero timeline present').toBeTruthy()
  })
})
