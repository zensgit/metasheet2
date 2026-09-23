import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

const pluginHarness = vi.hoisted(() => ({
  fetchPlugins: vi.fn(),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' as const }]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: pluginHarness.fetchPlugins,
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)]),
  } as unknown as Response
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('attendance admin list truncation', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    pluginHarness.fetchPlugins.mockResolvedValue(undefined)
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('shows payroll cycle truncation and requests the next page', async () => {
    const calls: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/attendance/payroll-cycles?')) {
        const page = new URL(url, 'http://local').searchParams.get('page')
        const item = page === '2'
          ? { id: 'cycle-2', name: 'Older cycle', startDate: '2024-01-01', endDate: '2024-01-31', status: 'closed', templateId: null }
          : { id: 'cycle-1', name: 'Latest cycle', startDate: '2026-01-01', endDate: '2026-01-31', status: 'open', templateId: null }
        return jsonResponse({ ok: true, data: { items: [item], total: 2, page: Number(page || 1), pageSize: 200 } })
      }
      return jsonResponse({ ok: true, data: { items: [], total: 0 } })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(20)

    const section = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-payroll-cycles"]')
    expect(section).toBeTruthy()
    expect(section!.textContent).toContain('Showing 1 of 2.')
    expect(calls.some((url) => url.includes('/api/attendance/payroll-cycles?') && url.includes('pageSize=200') && url.includes('page=1'))).toBe(true)

    section!.querySelector<HTMLButtonElement>('[data-attendance-list-load-more="payroll-cycles"]')!.click()
    await flushUi(8)

    expect(section!.textContent).toContain('Latest cycle')
    expect(section!.textContent).toContain('Older cycle')
    expect(calls.some((url) => url.includes('/api/attendance/payroll-cycles?') && url.includes('page=2'))).toBe(true)
    expect(section!.querySelector('[data-attendance-list-truncated="payroll-cycles"]')).toBeNull()
  })

  it('requests shift-swap and missed-punch pages at the API cap and discloses a short page', async () => {
    const calls: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/attendance/shift-swap-requests?')) {
        return jsonResponse({
          ok: true,
          data: {
            items: [{
              requestId: 'swap-1',
              requesterUserId: 'user-1',
              counterpartyUserId: 'user-2',
              requesterAssignmentId: 'asg-1',
              counterpartyAssignmentId: 'asg-2',
              requesterWorkDate: '2026-03-01',
              counterpartyWorkDate: '2026-03-02',
              requestStatus: 'pending',
              counterpartyStatus: 'pending',
            }],
            total: 3,
            page: 1,
            pageSize: 200,
          },
        })
      }
      if (url.includes('/api/attendance/manual-missed-punch-reminders/candidates')) {
        return jsonResponse({
          ok: true,
          data: {
            items: [{
              recordId: '00000000-0000-4000-8000-000000000abc',
              userId: 'worker-1',
              workDate: '2026-06-10',
              status: 'absent',
              missingSide: 'both',
              selectedByDefault: true,
              pendingRequest: null,
              latestRequest: null,
            }],
            total: 4,
            page: 1,
            pageSize: 200,
          },
        })
      }
      return jsonResponse({ ok: true, data: { items: [], total: 0 } })
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(16)

    const swapCalls = calls.filter((url) => url.includes('/api/attendance/shift-swap-requests?'))
    expect(swapCalls.length).toBeGreaterThan(0)
    expect(swapCalls[0]).toMatch(/[?&]pageSize=200(?:&|$)/)
    const swapSection = container!.querySelector('[data-shift-swap-requests]')
    expect(swapSection?.textContent).toContain('Showing 1 of 3.')

    app?.unmount()
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-notification-deliveries')
    expect(section).toBeTruthy()
    section!.querySelector<HTMLButtonElement>('[data-missed-punch-reminder-load]')!.click()
    await flushUi(8)
    const candidateCall = calls.find((url) => url.includes('/api/attendance/manual-missed-punch-reminders/candidates'))
    expect(candidateCall).toBeTruthy()
    expect(candidateCall).toMatch(/[?&]pageSize=200(?:&|$)/)
    expect(section!.textContent).toContain('Showing 1 of 4.')
    expect(section!.textContent).toContain('Select all applies to loaded rows only.')
    section!.querySelector<HTMLButtonElement>('[data-missed-punch-reminder-open-confirm]')!.click()
    await flushUi(2)
    expect(section!.querySelector('[data-missed-punch-reminder-coverage]')?.textContent).toContain('1 / 4')
  })
})
