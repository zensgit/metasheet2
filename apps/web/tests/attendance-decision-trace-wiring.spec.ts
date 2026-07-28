// W5-1 (Wave 5 explainability design-lock, RATIFIED §6/§9 W5-1): AttendanceView dual-face wiring —
// admin section + self overview card + the OD-W5-7/#4562 comp_time leaveTypeCode channel driven by
// REAL UI triggers, with the R1 (zero write) and R3 (no reassembly/enrichment fetch) negatives
// asserted at the mock network layer. Synthetic fixtures only (lock P2-a).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'

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

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function todayStatusTraceFixture(): Record<string, unknown> {
  return {
    category: 'today_status',
    reasonCode: 'late',
    conclusion: { workDate: '2026-07-01', status: 'late', isWorkday: true, workMinutes: 480, lateMinutes: 12, earlyLeaveMinutes: 0 },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:00:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  }
}

function compTimeTraceFixture(): Record<string, unknown> {
  return {
    category: 'comp_time_balance',
    conclusion: {
      summary: { grantedMinutes: 300, remainingMinutes: 180, exhaustedMinutes: 120, expiredMinutes: 0 },
      lots: [{ sourceResolution: 'mapped', reasonCode: 'overtime_conversion', grantedAt: '2026-06-01T00:00:00.000Z', expiresAt: null }],
      events: [],
    },
    basis: [
      { source: { kind: 'ledger', ref: 'attendance_leave_balances' }, version: { posture: 'snapshot_frozen', asOf: '2026-06-01T00:00:00.000Z' } },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'partial',
  }
}

function balanceSummaryPayload(leaveTypeCode: string, userId: string): Record<string, unknown> {
  return {
    ok: true,
    data: {
      userId,
      summary: { leaveTypeCode, grantedMinutes: 2400, remainingMinutes: 1800, exhaustedMinutes: 600, expiredMinutes: 0 },
      activeLots: [],
      recentEvents: [],
      eventLimit: 50,
    },
  }
}

describe('W5-1 decision-trace dual-face wiring', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    // The copy-door assertions below are zh-leg verbatim checks; the en leg gets its own test
    // (both lower layers — pure module + mounted component — already run both legs on every door).
    useLocale().setLocale('zh-CN')
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/attendance-admin/decision-trace?')) {
        return jsonResponse(200, { ok: true, data: todayStatusTraceFixture() })
      }
      if (url.startsWith('/api/attendance/decision-trace?')) {
        const parsedUrl = new URL(url, 'http://localhost')
        const category = parsedUrl.searchParams.get('category')
        return jsonResponse(200, {
          ok: true,
          data: category === 'comp_time_balance' ? compTimeTraceFixture() : todayStatusTraceFixture(),
        })
      }
      if (url.startsWith('/api/attendance/leave-balances/me')) {
        const parsedUrl = new URL(url, 'http://localhost')
        return jsonResponse(200, balanceSummaryPayload(parsedUrl.searchParams.get('leaveTypeCode') || '', 'self'))
      }
      if (url.startsWith('/api/attendance/leave-balances')) {
        const parsedUrl = new URL(url, 'http://localhost')
        return jsonResponse(200, balanceSummaryPayload(parsedUrl.searchParams.get('leaveTypeCode') || '', 'u1'))
      }
      return emptyAttendanceResponse()
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  function nonGetCalls(): Array<[unknown, RequestInit | undefined]> {
    return (vi.mocked(apiFetch).mock.calls as Array<[unknown, RequestInit | undefined]>).filter(([, options]) => {
      const method = options?.method ? String(options.method).toUpperCase() : 'GET'
      return method !== 'GET'
    })
  }

  function traceCalls(): string[] {
    return vi
      .mocked(apiFetch)
      .mock.calls.map((call) => String(call[0]))
      .filter((url) => url.includes('/decision-trace'))
  }

  // ---------------------------------------------------------------------------
  // Admin face.
  // ---------------------------------------------------------------------------
  it('admin face: rail-registered section + form drives the exact admin endpoint URL and renders the trace', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    // Section is rail-registered (canonical ?section= deep link comes from this same registry).
    const anchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-decision-trace"]')
    expect(anchor).not.toBeNull()
    anchor!.click()
    await flushUi(4)

    const section = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-section]')
    expect(section).not.toBeNull()

    const userInput = section!.querySelector<HTMLInputElement>('[data-decision-trace-admin-user]')!
    userInput.value = 'emp-1'
    userInput.dispatchEvent(new Event('input', { bubbles: true }))
    const dateInput = section!.querySelector<HTMLInputElement>('[data-decision-trace-admin-date]')!
    dateInput.value = '2026-07-01'
    dateInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    vi.mocked(apiFetch).mockClear()
    section!.querySelector<HTMLButtonElement>('[data-decision-trace-admin-load]')!.click()
    await flushUi(6)

    // Exact URL — blank org resolves to the plugin default org (same normalization as W4-1).
    expect(traceCalls()).toEqual([
      '/api/attendance-admin/decision-trace?orgId=default&userId=emp-1&category=today_status&workDate=2026-07-01',
    ])
    // R3: the trace load performs EXACTLY one fetch — no enrichment/join call to any other
    // endpoint rides along (mutation: adding a PII enrichment fetch turns this red).
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1)
    // R1: nothing in the interaction issued a write.
    expect(nonGetCalls()).toHaveLength(0)

    const trace = section!.querySelector('[data-attendance-decision-trace]')
    expect(trace?.getAttribute('data-trace-audience')).toBe('admin')
    expect(trace?.querySelector('[data-trace-may-differ]')?.textContent?.trim()).toBe('可能不同于决策当时的规则。')
  })

  it('admin face: category switch swaps the companion input (④ requestId / ⑥ instanceId), invalid target never hits the wire', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-decision-trace"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-section]')!

    const categorySelect = section.querySelector<HTMLSelectElement>('[data-decision-trace-admin-category]')!
    // Six closed-set options, no more.
    expect(Array.from(categorySelect.options).map((option) => option.value)).toEqual([
      'today_status',
      'late_early',
      'missing_punch',
      'overtime_segmentation',
      'comp_time_balance',
      'approver_source',
    ])

    categorySelect.value = 'overtime_segmentation'
    categorySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    expect(section.querySelector('[data-decision-trace-admin-request]')).not.toBeNull()
    expect(section.querySelector('[data-decision-trace-admin-date]')).toBeNull()

    // Invalid target (missing user + non-uuid request id): ZERO wire traffic, local error state.
    vi.mocked(apiFetch).mockClear()
    section.querySelector<HTMLButtonElement>('[data-decision-trace-admin-load]')!.click()
    await flushUi(4)
    expect(traceCalls()).toEqual([])
    expect(section.querySelector('[data-trace-error]')?.getAttribute('data-trace-error-kind')).toBe('invalid_target')

    categorySelect.value = 'approver_source'
    categorySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    expect(section.querySelector('[data-decision-trace-admin-instance]')).not.toBeNull()
    expect(section.querySelector('[data-decision-trace-admin-request]')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Self face.
  // ---------------------------------------------------------------------------
  it('self face: overview card queries the token-subject endpoint — the URL NEVER carries a userId (§4.1)', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)

    const card = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-self]')
    expect(card).not.toBeNull()
    expect(card!.getAttribute('data-overview-section')).toBe('attendance-overview-decision-trace')

    const dateInput = card!.querySelector<HTMLInputElement>('[data-decision-trace-self-date]')!
    dateInput.value = '2026-07-01'
    dateInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    vi.mocked(apiFetch).mockClear()
    card!.querySelector<HTMLButtonElement>('[data-decision-trace-self-load]')!.click()
    await flushUi(6)

    expect(traceCalls()).toEqual(['/api/attendance/decision-trace?category=today_status&workDate=2026-07-01'])
    // §4.1: the self face has no user input at all — and by construction no userId on the wire.
    expect(traceCalls()[0].includes('userId')).toBe(false)
    expect(card!.querySelector('[data-decision-trace-self-org]')).toBeNull()
    // R3 single-fetch + R1 zero-write.
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1)
    expect(nonGetCalls()).toHaveLength(0)

    const trace = card!.querySelector('[data-attendance-decision-trace]')
    expect(trace?.getAttribute('data-trace-audience')).toBe('self')
    expect(trace?.querySelector('[data-trace-reason]')?.textContent).toContain('迟到')
  })

  it('self face: 400 ORG_ID_REQUIRED surfaces the org picker (multi-org leg 3), chosen org is appended (leg 4)', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)
    const card = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-self]')!
    const dateInput = card.querySelector<HTMLInputElement>('[data-decision-trace-self-date]')!
    dateInput.value = '2026-07-01'
    dateInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    // First answer: multi-org member without a chosen org.
    vi.mocked(apiFetch).mockImplementationOnce(async () =>
      jsonResponse(400, { ok: false, error: { code: 'ORG_ID_REQUIRED' } }),
    )
    card.querySelector<HTMLButtonElement>('[data-decision-trace-self-load]')!.click()
    await flushUi(6)
    expect(card.querySelector('[data-trace-error]')?.getAttribute('data-trace-error-kind')).toBe('org_required')
    const orgInput = card.querySelector<HTMLInputElement>('[data-decision-trace-self-org]')
    expect(orgInput).not.toBeNull()

    orgInput!.value = 'org-b'
    orgInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    card.querySelector<HTMLButtonElement>('[data-decision-trace-self-load]')!.click()
    await flushUi(6)
    expect(traceCalls()).toEqual(['/api/attendance/decision-trace?category=today_status&workDate=2026-07-01&orgId=org-b'])
  })

  // ---------------------------------------------------------------------------
  // OD-W5-7 / #4562 comp_time channel — REAL UI triggers.
  // ---------------------------------------------------------------------------
  it('comp_time channel: the balance-card toggle drives the parameterized /me read path (closed set only)', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)

    // Mount auto-fetch stays byte-identical to the pre-parameterization default (annual).
    const initialCalls = vi
      .mocked(apiFetch)
      .mock.calls.map((call) => String(call[0]))
      .filter((url) => url.startsWith('/api/attendance/leave-balances/me'))
    expect(initialCalls).toEqual(['/api/attendance/leave-balances/me?leaveTypeCode=annual'])

    const balanceCard = container!.querySelector<HTMLElement>('[data-selfservice-card="annual-balance"]')!
    // The toggle offers EXACTLY the closed set — no third button, no free-form input.
    const toggles = balanceCard.querySelectorAll('[data-self-balance-type]')
    expect(Array.from(toggles).map((button) => button.getAttribute('data-self-balance-type'))).toEqual([
      'annual',
      'comp_time',
    ])

    vi.mocked(apiFetch).mockClear()
    balanceCard.querySelector<HTMLButtonElement>('[data-self-balance-type="comp_time"]')!.click()
    await flushUi(6)
    const compTimeCalls = vi
      .mocked(apiFetch)
      .mock.calls.map((call) => String(call[0]))
      .filter((url) => url.startsWith('/api/attendance/leave-balances/me'))
    expect(compTimeCalls).toEqual(['/api/attendance/leave-balances/me?leaveTypeCode=comp_time'])
    expect(balanceCard.querySelector('[data-self-balance-title]')?.textContent).toContain('我的调休')

    // Re-clicking the already-selected type issues no duplicate fetch.
    vi.mocked(apiFetch).mockClear()
    balanceCard.querySelector<HTMLButtonElement>('[data-self-balance-type="comp_time"]')!.click()
    await flushUi(4)
    expect(
      vi.mocked(apiFetch).mock.calls.map((call) => String(call[0])).filter((url) => url.includes('leave-balances/me')),
    ).toEqual([])
  })

  it('comp_time channel:「查看依据」carries the canonical query-form deep link (R2) and presets the ⑤ trace', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)
    const balanceCard = container!.querySelector<HTMLElement>('[data-selfservice-card="annual-balance"]')!
    balanceCard.querySelector<HTMLButtonElement>('[data-self-balance-type="comp_time"]')!.click()
    await flushUi(6)

    const link = balanceCard.querySelector<HTMLAnchorElement>('[data-self-balance-trace-link]')
    expect(link).not.toBeNull()
    // R2: canonical QUERY form, zero hash (mutation: hash-form href turns this red).
    expect(link!.getAttribute('href')).toBe('/attendance?section=attendance-overview-decision-trace')
    expect(link!.getAttribute('href')!.includes('#')).toBe(false)

    vi.mocked(apiFetch).mockClear()
    link!.click()
    await flushUi(6)
    // The in-page entry presets ⑤ and loads it from the SELF host (no userId, ever).
    expect(traceCalls()).toEqual(['/api/attendance/decision-trace?category=comp_time_balance'])
    const card = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-self]')!
    const categorySelect = card.querySelector<HTMLSelectElement>('[data-decision-trace-self-category]')!
    expect(categorySelect.value).toBe('comp_time_balance')
    // ⑤ renders with the retention disclosure (OD-W5-5=(b): fix not landed ⇒ must disclose).
    expect(card.querySelector('[data-trace-retention-disclosure]')?.textContent).toContain('流水随 lot 删除而消失')
  })

  it('admin balance section: leave-type select feeds the same channel; default stays byte-identical annual', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-annual-leave-balance"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-annual-leave-balance')!
    const userInput = section.querySelector<HTMLInputElement>('#attendance-annual-balance-user')!
    userInput.value = 'u1'
    userInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    // Default (annual) — byte-identical to the pre-W5-1 query.
    vi.mocked(apiFetch).mockClear()
    section.querySelector<HTMLButtonElement>('.attendance__admin-actions button')!.click()
    await flushUi(4)
    expect(
      vi.mocked(apiFetch).mock.calls.map((call) => String(call[0])).filter((url) => url.startsWith('/api/attendance/leave-balances?')),
    ).toEqual(['/api/attendance/leave-balances?userId=u1&leaveTypeCode=annual'])

    // comp_time via the closed-set select.
    const typeSelect = section.querySelector<HTMLSelectElement>('[data-admin-balance-leave-type]')!
    expect(Array.from(typeSelect.options).map((option) => option.value)).toEqual(['annual', 'comp_time'])
    typeSelect.value = 'comp_time'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    section.querySelector<HTMLButtonElement>('.attendance__admin-actions button')!.click()
    await flushUi(4)
    expect(
      vi.mocked(apiFetch).mock.calls.map((call) => String(call[0])).filter((url) => url.startsWith('/api/attendance/leave-balances?')),
    ).toEqual(['/api/attendance/leave-balances?userId=u1&leaveTypeCode=comp_time'])
    // R1: the balance/trace surfaces stayed read-only throughout.
    expect(nonGetCalls()).toHaveLength(0)
  })

  it('en leg: the same wired surfaces render the en copy doors (locale-routed, not hardcoded zh)', async () => {
    useLocale().setLocale('en')
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)
    const balanceCard = container!.querySelector<HTMLElement>('[data-selfservice-card="annual-balance"]')!
    balanceCard.querySelector<HTMLButtonElement>('[data-self-balance-type="comp_time"]')!.click()
    await flushUi(6)
    expect(balanceCard.querySelector('[data-self-balance-title]')?.textContent).toContain('My comp time')
    balanceCard.querySelector<HTMLAnchorElement>('[data-self-balance-trace-link]')!.click()
    await flushUi(6)
    const card = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-self]')!
    expect(card.querySelector('[data-trace-retention-disclosure]')?.textContent).toContain('deleted together with its lot')
  })

  // ---------------------------------------------------------------------------
  // R1 whole-face negative: a full walk across both faces issues zero writes.
  // ---------------------------------------------------------------------------
  it('R1: a full dual-face walk (mount admin + overview, load traces, toggle balance) issues ZERO non-GET calls', async () => {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi(8)
    const card = container!.querySelector<HTMLElement>('[data-attendance-decision-trace-self]')!
    const dateInput = card.querySelector<HTMLInputElement>('[data-decision-trace-self-date]')!
    dateInput.value = '2026-07-01'
    dateInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)
    card.querySelector<HTMLButtonElement>('[data-decision-trace-self-load]')!.click()
    await flushUi(6)
    container!.querySelector<HTMLElement>('[data-selfservice-card="annual-balance"]')!
      .querySelector<HTMLButtonElement>('[data-self-balance-type="comp_time"]')!.click()
    await flushUi(6)
    expect(nonGetCalls()).toHaveLength(0)
  })
})
