import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import { attendanceCivilDateWindow } from '../src/views/attendance/attendanceDateTimePresentation'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
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

function emptyAttendanceResponse(): Response {
  return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function installFrozenNow(iso: string): void {
  const frozen = new Date(iso).getTime()
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) super(frozen)
      else super(...args)
    }

    static now(): number {
      return frozen
    }
  }
  vi.stubGlobal('Date', FrozenDate)
}

function requestUrl(input: unknown): string {
  return String(input)
}

function rulePayload(timezone: string) {
  return {
    ok: true,
    data: {
      name: 'Default',
      timezone,
      workStartTime: '09:00',
      workEndTime: '18:00',
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 0,
      workingDays: [1, 2, 3, 4, 5],
    },
  }
}

const groupPayload = {
  ok: true,
  data: {
    items: [{
      id: 'group-a',
      name: 'Ops Team',
      code: 'ops',
      timezone: 'Asia/Shanghai',
      ruleSetId: null,
      attendanceType: 'fixed_shift',
      description: null,
      memberCount: 0,
    }],
    total: 1,
  },
}

describe('attendance civil-date defaults and roster caps', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    useLocale().setLocale('en')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.unstubAllGlobals()
  })

  it('fills missed-punch and decision-trace defaults from the attendance rule IANA, not UTC', async () => {
    installFrozenNow('2026-09-10T19:15:49.000Z')
    const expected = attendanceCivilDateWindow(new Date('2026-09-10T19:15:49.000Z'), 'Asia/Shanghai')
    expect(expected).toEqual({ from: '2026-08-12', to: '2026-09-11' })
    expect(new Date('2026-09-10T19:15:49.000Z').toISOString().slice(0, 10)).toBe('2026-09-10')

    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.startsWith('/api/attendance/rules/me')) {
        return jsonResponse(200, { ok: true, data: { runtimeRule: { timezone: 'Asia/Shanghai' } } })
      }
      if (url.includes('/api/attendance/rules/default')) {
        return jsonResponse(200, rulePayload('America/Los_Angeles'))
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(20)

    const from = container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-from]')
    const to = container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-to]')
    const adminDate = container!.querySelector<HTMLInputElement>('[data-decision-trace-admin-date]')
    expect(from?.value).toBe('2026-08-12')
    expect(to?.value).toBe('2026-09-11')
    expect(adminDate?.value).toBe('2026-09-11')
    expect(container!.querySelector('[data-missed-punch-reminder-date-pending]')).toBeNull()
  })

  it('uses the org default rule timezone when the signed-in runtime rule has none', async () => {
    installFrozenNow('2026-09-11T02:30:00.000Z')
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.startsWith('/api/attendance/rules/me')) {
        return jsonResponse(200, { ok: true, data: { runtimeRule: { timezone: '' } } })
      }
      if (url.includes('/api/attendance/rules/default')) {
        return jsonResponse(200, rulePayload('America/Los_Angeles'))
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(20)

    expect(container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-to]')?.value).toBe('2026-09-10')
    expect(container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-from]')?.value).toBe('2026-08-11')
    expect(container!.querySelector<HTMLInputElement>('[data-decision-trace-admin-date]')?.value).toBe('2026-09-10')
  })

  it('keeps a date the operator already edited when the rule timezone arrives later', async () => {
    installFrozenNow('2026-09-10T19:15:49.000Z')
    let releaseRules: () => void = () => {}
    const rulesGate = new Promise<void>((resolve) => {
      releaseRules = resolve
    })
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.startsWith('/api/attendance/rules/me')) {
        await rulesGate
        return jsonResponse(200, { ok: true, data: { runtimeRule: { timezone: 'Asia/Shanghai' } } })
      }
      if (url.includes('/api/attendance/rules/default')) {
        await rulesGate
        return jsonResponse(200, rulePayload('Asia/Shanghai'))
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(12)

    const from = container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-from]')!
    expect(from.value).toBe('')
    from.value = '2026-01-15'
    from.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    releaseRules()
    await flushUi(16)

    expect(container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-from]')?.value).toBe('2026-01-15')
    expect(container!.querySelector<HTMLInputElement>('[data-missed-punch-reminder-to]')?.value).toBe('2026-09-11')
  })

  it('fills the self decision-trace work date from the signed-in attendance rule timezone', async () => {
    installFrozenNow('2026-09-10T19:15:49.000Z')
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.startsWith('/api/attendance/rules/me')) {
        return jsonResponse(200, { ok: true, data: { runtimeRule: { timezone: 'Asia/Shanghai' } } })
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(20)

    expect(container!.querySelector<HTMLInputElement>('[data-decision-trace-self-date]')?.value).toBe('2026-09-11')
  })

  it('loads owners past the default page of 50 and discloses a further page', async () => {
    const managerCalls: string[] = []
    const memberCalls: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = requestUrl(input)
      const path = url.split('?')[0]
      if (path === '/api/attendance/groups/group-a/managers') {
        managerCalls.push(url)
        const page = new URL(url, 'http://localhost').searchParams.get('page')
        if (page === '2') {
          return jsonResponse(200, {
            ok: true,
            data: {
              items: [
                { id: 'm-2', userId: 'owner-2', role: 'owner' },
                { id: 'm-3', userId: 'owner-3', role: 'sub_owner' },
              ],
              total: 3,
              page: 2,
              pageSize: 200,
            },
          })
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [{ id: 'm-1', userId: 'owner-1', role: 'owner' }],
            total: 3,
            page: 1,
            pageSize: 200,
          },
        })
      }
      if (path === '/api/attendance/groups/group-a/members') {
        memberCalls.push(url)
        const page = new URL(url, 'http://localhost').searchParams.get('page')
        if (page === '2') {
          return jsonResponse(200, {
            ok: true,
            data: {
              items: [{ id: 'member-2', groupId: 'group-a', userId: 'user-2' }],
              total: 2,
              page: 2,
              pageSize: 200,
            },
          })
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [{ id: 'member-1', groupId: 'group-a', userId: 'user-1' }],
            total: 2,
            page: 1,
            pageSize: 200,
          },
        })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, groupPayload)
      }
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(24)

    expect(managerCalls[0]).toContain('page=1')
    expect(managerCalls[0]).toContain('pageSize=200')
    expect(memberCalls[0]).toContain('pageSize=200')
    expect(container!.querySelector('[data-attendance-group-manager-count]')?.textContent).toContain('Showing 1 of 3 owners')
    expect(container!.querySelectorAll('[data-attendance-group-manager-row]')).toHaveLength(1)

    container!.querySelector<HTMLButtonElement>('[data-attendance-group-managers-load-more]')!.click()
    await flushUi(12)

    expect(managerCalls.some((url) => url.includes('page=2') && url.includes('pageSize=200'))).toBe(true)
    expect(container!.querySelectorAll('[data-attendance-group-manager-row]')).toHaveLength(3)
    expect(container!.querySelector('[data-attendance-group-manager-count]')?.textContent).toContain('2 owner(s)')
    expect(container!.querySelector('[data-attendance-group-manager-count]')?.textContent).toContain('1 sub-owner')
    expect(container!.querySelector('[data-attendance-group-managers-load-more]')).toBeNull()

    expect(container!.querySelector('[data-attendance-group-member-count]')?.textContent).toContain('Showing 1 of 2 members')
    container!.querySelector<HTMLButtonElement>('[data-attendance-group-members-load-more]')!.click()
    await flushUi(12)
    expect(memberCalls.some((url) => url.includes('page=2') && url.includes('pageSize=200'))).toBe(true)
    expect(container!.querySelectorAll('[data-attendance-group-member-user-id]')).toHaveLength(2)
    expect(container!.querySelector('[data-attendance-group-members-load-more]')).toBeNull()
  })

  it('shows all 51 owners when the server total fits in one catalog page', async () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      id: `m-${index + 1}`,
      userId: `owner-${index + 1}`,
      role: 'owner',
    }))
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.split('?')[0] === '/api/attendance/groups/group-a/managers') {
        return jsonResponse(200, { ok: true, data: { items, total: 51, page: 1, pageSize: 200 } })
      }
      if (url.startsWith('/api/attendance/groups?')) return jsonResponse(200, groupPayload)
      return emptyAttendanceResponse()
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(24)

    expect(container!.querySelectorAll('[data-attendance-group-manager-row]')).toHaveLength(51)
    expect(container!.querySelector('[data-attendance-group-manager-count]')?.textContent).toContain('51 owner(s)')
    expect(container!.querySelector('[data-attendance-group-managers-load-more]')).toBeNull()
    expect(container!.textContent).not.toContain('Showing 51 of')
  })
})
