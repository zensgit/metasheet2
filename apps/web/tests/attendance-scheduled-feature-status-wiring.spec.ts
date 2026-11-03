import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import {
  buttonByText,
  emptyAttendanceResponse,
  flushUi,
  jsonResponse,
  recordApiCall,
  setCheckbox,
  setViewportWidth,
  type RecordedApiCall,
} from './helpers/attendanceA1Harness'

// A1 「提示与实际状态」 - mounted AttendanceView (admin mode). The report-digest subscription and the monthly
// annual-leave auto-accrual each show BOTH 「已配置」 (from the SAVED settings) and 「当前是否可运行」 (the server
// run switches reported in the `runtimeGates` sibling of GET /api/attendance/settings). Hard rules pinned here:
//   - no PUT body changes; the PUT response carries no gate report and none is needed;
//   - toggling a checkbox never moves the configured status - only a saved response does;
//   - a missing gate report is "unknown" (fail-closed); an open gate is "on", never "running";
//   - a failed or denied settings read never keeps an earlier "on": the gate report is dropped on the first mount AND
//     on a later reload of the same mounted instance (the reload is the only way to be holding a stale gate report),
//     whichever reader fails - "Reload admin" (loadSettings) or the annual card's "Reload policy" (loadAnnualPolicy);
//   - the 「已配置」 half is never turned into "not configured" by a failed read either: it reads "Not loaded" when the
//     failed reader owns the document it derives from (loadSettings clears the settings document the digest card
//     reads), and otherwise keeps the last loaded value (the annual card reads the last SAVED annual policy, which no
//     failed read clears; loadAnnualPolicy touches neither).

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

const DIGEST_ON = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  channel: 'work_notification',
  cadences: {
    daily: { enabled: true, sendAt: '18:30', recipients: ['self'] },
    weekly: { enabled: false, weekday: 1, sendAt: '09:00', recipients: ['self'] },
    monthly: { enabled: false, dayOfMonth: 1, sendAt: '09:00', recipients: ['self'] },
  },
}
const DIGEST_OFF = { ...DIGEST_ON, enabled: false }
const ANNUAL = (engine: boolean, trigger: boolean) => ({
  enabled: engine,
  tenureMode: 'cumulative_service',
  standardDayMinutes: 480,
  tiers: [{ minYears: 1, maxYears: null, days: 5 }],
  carryover: { enabled: false },
  timezone: 'Asia/Shanghai',
  scheduledTrigger: { enabled: trigger },
})
const GATES_ALL_CLOSED = {
  reportDigest: { gatesOpen: false, closedGates: ['digestProducer', 'scheduler', 'deliveryWorker'] },
  annualLeaveAccrualScheduled: { gatesOpen: false, closedGates: ['accrualTrigger', 'scheduler'] },
}
const GATES_ALL_OPEN = {
  reportDigest: { gatesOpen: true, closedGates: [] },
  annualLeaveAccrualScheduled: { gatesOpen: true, closedGates: [] },
}

describe('AttendanceView · scheduled features show 已配置 and 当前是否可运行', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let settingsData: Record<string, unknown> = {}
  let runtimeGates: unknown = undefined
  let settingsGetStatus = 200
  let settingsGets = 0
  let mounts = 0
  // null = leave GET /api/attendance/groups to the catch-all (catalog scope resolves to 'org').
  let groupsScope: 'managed' | null = null
  let puts: RecordedApiCall[] = []
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    settingsData = {}
    runtimeGates = undefined
    settingsGetStatus = 200
    settingsGets = 0
    mounts = 0
    groupsScope = null
    puts = []
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const call = recordApiCall(input, init)
      if (call.url.includes('/api/attendance/settings')) {
        if (call.method === 'PUT') {
          puts.push(call)
          // The PUT response echoes the saved document and carries NO gate report (the backend leaves PUT alone).
          return jsonResponse(200, { ok: true, data: { ...settingsData, ...(call.body ?? {}) } })
        }
        settingsGets += 1
        if (settingsGetStatus !== 200) {
          return jsonResponse(settingsGetStatus, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'settings unavailable' } })
        }
        const body: Record<string, unknown> = { ok: true, data: settingsData }
        if (runtimeGates !== undefined) body.runtimeGates = runtimeGates
        return jsonResponse(200, body)
      }
      if (groupsScope && call.method === 'GET' && /\/api\/attendance\/groups\?/.test(call.url)) {
        return jsonResponse(200, { ok: true, data: { items: [], total: 0, scope: groupsScope } })
      }
      return emptyAttendanceResponse()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: originalScrollIntoView })
    }
    app = null
    container = null
    useLocale().setLocale('en')
  })

  async function mountAdmin(): Promise<HTMLElement> {
    mounts += 1
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(16)
    return container!
  }

  const digestCard = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-attendance-report-digest-policy]')!
  const annualCard = (root: HTMLElement) => root.querySelector<HTMLElement>('#attendance-admin-annual-leave-policy')!
  const statusIn = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-attendance-scheduled-feature-status]')!
  const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const adminStatusText = (root: HTMLElement) => textOf(root.querySelector('.attendance__status-block--admin .attendance__status'))

  // ---- report digest --------------------------------------------------------------------------------------

  it('digest: configured + gates closed shows 已配置 and "No" with every closed gate named, from the GET sibling', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const status = statusIn(digestCard(root))
    expect(status).toBeTruthy()
    expect(status.getAttribute('data-scheduled-feature')).toBe('reportDigest')
    expect(status.getAttribute('data-configured-state')).toBe('configured')
    expect(status.getAttribute('data-runnable-state')).toBe('closed')
    expect(textOf(status.querySelector('[data-scheduled-feature-configured]'))).toBe('Configured')
    expect(textOf(status.querySelector('[data-scheduled-feature-runnable]'))).toBe('No — not all server run switches are on in the answering process')
    const detail = textOf(status.querySelector('[data-scheduled-feature-detail]'))
    expect(detail).toContain('answering process reported')
    expect(detail).not.toMatch(/will not send/i)
    expect(detail).toContain('ATTENDANCE_REPORT_DIGEST_ENABLED')
    expect(detail).toContain('ATTENDANCE_SCHEDULER_ENABLED')
    expect(detail).toContain('ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED')
  })

  it('digest: gates open reads "Server run switches are on" - never "running" - and names the per-process snapshot, a cache lag and the channel caveat', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON }
    runtimeGates = GATES_ALL_OPEN
    const root = await mountAdmin()
    const status = statusIn(digestCard(root))
    expect(status.getAttribute('data-runnable-state')).toBe('open')
    expect(textOf(status.querySelector('[data-scheduled-feature-runnable]'))).toBe('Server run switches are on')
    const text = textOf(status)
    expect(text).toContain('process that answered this request')
    expect(text).toContain('next re-reads its settings')
    expect(text).not.toMatch(/\d+\s*seconds?/i)
    expect(text).toContain('The selected channel still needs its own server configuration')
    expect(text).not.toMatch(/\brunning\b/i)
    expect(text).not.toMatch(/\bin effect\b/i)
  })

  it('digest: no gate report from the server (older server) is "unknown", fail-closed - not open', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON }
    runtimeGates = undefined
    const root = await mountAdmin()
    const status = statusIn(digestCard(root))
    expect(status.getAttribute('data-runnable-state')).toBe('unknown')
    expect(textOf(status.querySelector('[data-scheduled-feature-detail]'))).toContain('do not treat it as running')
  })

  it('digest: a malformed gate report is treated like no report', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON }
    runtimeGates = { reportDigest: { gatesOpen: true, closedGates: ['scheduler'] } }
    const root = await mountAdmin()
    expect(statusIn(digestCard(root)).getAttribute('data-runnable-state')).toBe('unknown')
  })

  it('digest: enabled with no cadence is "Incomplete" - nothing would ever be produced', async () => {
    settingsData = {
      attendanceReportDigestPolicy: {
        ...DIGEST_ON,
        cadences: { ...DIGEST_ON.cadences, daily: { ...DIGEST_ON.cadences.daily, enabled: false } },
      },
    }
    runtimeGates = GATES_ALL_OPEN
    const root = await mountAdmin()
    const status = statusIn(digestCard(root))
    expect(status.getAttribute('data-configured-state')).toBe('incomplete')
    expect(textOf(status)).toContain('no send cadence is enabled')
  })

  it('digest: not configured is shown as such, even when the gates are closed', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_OFF }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const status = statusIn(digestCard(root))
    expect(status.getAttribute('data-configured-state')).toBe('not_configured')
    expect(textOf(status.querySelector('[data-scheduled-feature-configured]'))).toBe('Not configured')
    expect(textOf(status)).toContain('Even once switched on, the answering process reports')
  })

  it('digest: ticking the checkbox does NOT move the configured status; only a saved response does', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_OFF }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = digestCard(root)
    setCheckbox(card, '[data-report-digest="enabled"]', true)
    await flushUi(3)
    expect(statusIn(card).getAttribute('data-configured-state')).toBe('not_configured') // unsaved edit: unchanged

    buttonByText(card, 'Save report digest subscription').click()
    await flushUi(10)
    expect(puts).toHaveLength(1)
    expect(statusIn(card).getAttribute('data-configured-state')).toBe('configured') // saved response moved it
    expect(statusIn(card).getAttribute('data-runnable-state')).toBe('closed')
  })

  it('PIN digest: saving sends exactly the same PUT body as before - ONLY the digest policy, no gate report, no extra key', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_OFF }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = digestCard(root)
    setCheckbox(card, '[data-report-digest="enabled"]', true)
    await flushUi(3)
    buttonByText(card, 'Save report digest subscription').click()
    await flushUi(10)

    expect(puts).toHaveLength(1)
    expect(Object.keys(puts[0].body!)).toEqual(['attendanceReportDigestPolicy'])
    expect(Object.keys(puts[0].body!.attendanceReportDigestPolicy as Record<string, unknown>).sort())
      .toEqual(['cadences', 'channel', 'enabled', 'timezone'])
    expect((puts[0].body!.attendanceReportDigestPolicy as { enabled: boolean }).enabled).toBe(true)
  })

  it('digest: after saving, the status bounds the verdict to the answering process and names the closed gates', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_OFF }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = digestCard(root)
    setCheckbox(card, '[data-report-digest="enabled"]', true)
    await flushUi(3)
    buttonByText(card, 'Save report digest subscription').click()
    await flushUi(10)

    const status = adminStatusText(root)
    expect(status).toContain('Report digest subscription saved')
    expect(status).toContain('answering process reported')
    expect(status).toContain('cannot confirm other instances')
    expect(status).toContain('ATTENDANCE_REPORT_DIGEST_ENABLED')
  })

  it('digest: saving with the gates open never says the digest is now being sent', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_OFF }
    runtimeGates = GATES_ALL_OPEN
    const root = await mountAdmin()
    const card = digestCard(root)
    setCheckbox(card, '[data-report-digest="enabled"]', true)
    await flushUi(3)
    buttonByText(card, 'Save report digest subscription').click()
    await flushUi(10)
    const status = adminStatusText(root)
    expect(status).toContain('Report digest subscription saved')
    expect(status).toContain('process that answered the last settings read')
    expect(status).not.toMatch(/\d+\s*seconds?/i)
    expect(status).not.toMatch(/\brunning\b|\bin effect\b|\bnow being sent\b/i)
  })

  it('digest: saving it OFF keeps the original status text exactly', async () => {
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = digestCard(root)
    setCheckbox(card, '[data-report-digest="enabled"]', false)
    await flushUi(3)
    buttonByText(card, 'Save report digest subscription').click()
    await flushUi(10)
    expect(adminStatusText(root)).toBe('Report digest subscription saved')
  })

  it('a failed settings read is "Not loaded", never "Not configured"', async () => {
    settingsGetStatus = 500
    const root = await mountAdmin()
    const digest = statusIn(digestCard(root))
    expect(digest.getAttribute('data-configured-state')).toBe('unknown')
    expect(textOf(digest.querySelector('[data-scheduled-feature-configured]'))).toBe('Not loaded')
    expect(textOf(digest.querySelector('[data-scheduled-feature-runnable]'))).toContain('Unknown')
  })

  // ---- a failed RELOAD on the SAME mounted instance (gate r1 P2-1) ---------------------------------------------
  // The first-mount test above cannot guard the reset in loadSettings(): the gate report starts as null, so the cards
  // read "unknown" whether or not the reset exists. The only way to be HOLDING a stale report is a successful load
  // followed by a failing reload. A remount restarts from null and would prove nothing, so both loads below go
  // through ONE mounted app and the failing load is triggered from the page itself. (`mounts` is asserted to be 1 in
  // every same-instance case only so that a later edit cannot quietly turn one into a remount case. The counter is
  // the test's own, so it says nothing about the product: the evidence that the reset lines are guarded is that
  // deleting one of them turns exactly its own case red.)
  // Trigger = the "Reload admin" button of the admin console header (@click="loadAdminData"), which is always
  // rendered in admin mode. The status-bar "Reload admin" action only exists after an error, and admin mode renders
  // no org input to drive the orgId watcher.
  // The assertions re-query the cards after the reload instead of holding on to the nodes from before it: a 403
  // blocks the admin surface until the group catalog answers, which re-creates the cards (the gate report lives in
  // the parent, so the new cards must read "unknown" too). The admin status line is NOT asserted: a later loader's
  // success message ("Rule templates loaded.") overwrites the settings error in that one shared line.

  async function mountWithOpenGates(): Promise<HTMLElement> {
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON, annualLeavePolicy: ANNUAL(true, true) }
    runtimeGates = GATES_ALL_OPEN
    const root = await mountAdmin()
    for (const card of [digestCard(root), annualCard(root)]) {
      expect(statusIn(card).getAttribute('data-configured-state')).toBe('configured')
      expect(statusIn(card).getAttribute('data-runnable-state')).toBe('open')
    }
    return root
  }

  function clickReloadAdmin(root: HTMLElement): void {
    const button = buttonByText(root, 'Reload admin')
    expect(button.disabled).toBe(false)
    button.click()
  }

  function expectGateReportDropped(root: HTMLElement): void {
    const digest = statusIn(digestCard(root))
    const annual = statusIn(annualCard(root))
    // The stale "server run switches are on" must be gone from BOTH cards.
    expect(digest.getAttribute('data-runnable-state')).toBe('unknown')
    expect(annual.getAttribute('data-runnable-state')).toBe('unknown')
    expect(textOf(digest.querySelector('[data-scheduled-feature-runnable]'))).toContain('Unknown')
    expect(textOf(annual.querySelector('[data-scheduled-feature-runnable]'))).toContain('Unknown')
    expect(textOf(digest)).not.toContain('Server run switches are on')
    expect(textOf(annual)).not.toContain('Server run switches are on')
    // Current, deliberate asymmetry (gate r1 P2-1 asked for it to be written into the case): the digest card derives
    // "configured" from the settings document, which a failed read clears, so it reads "Not loaded"; the annual card
    // derives it from the last SAVED annual policy, which a failed read leaves in place - exactly like the annual form
    // beside it, which also keeps its last loaded values. Only the gate report is dropped on both.
    expect(digest.getAttribute('data-configured-state')).toBe('unknown')
    expect(textOf(digest.querySelector('[data-scheduled-feature-configured]'))).toBe('Not loaded')
    expect(annual.getAttribute('data-configured-state')).toBe('configured')
  }

  it('a FAILED reload on the same mounted instance drops the last gate report: both cards go "unknown", neither keeps "on"', async () => {
    const root = await mountWithOpenGates()
    const getsBefore = settingsGets

    settingsGetStatus = 500
    clickReloadAdmin(root)
    await flushUi(16)

    expect(mounts).toBe(1)
    expect(settingsGets).toBeGreaterThan(getsBefore) // the reload really hit the failing endpoint
    expectGateReportDropped(root)
  })

  it('a 403 on the next load of the same mounted instance also drops the last gate report', async () => {
    const root = await mountWithOpenGates()
    const getsBefore = settingsGets

    // On a 403 the admin surface is replaced by a "permissions required" notice unless the group catalog says the
    // user manages groups (a delegated group manager can read groups but not settings). Switch the catalog to
    // 'managed' together with the 403 so the cards are rendered again once every loader has finished.
    settingsGetStatus = 403
    groupsScope = 'managed'
    clickReloadAdmin(root)
    await flushUi(16)

    expect(mounts).toBe(1)
    expect(settingsGets).toBeGreaterThan(getsBefore)
    expectGateReportDropped(root)
  })

  // ---- a failed "Reload policy" on the SAME mounted instance (gate r2 P2-1) -----------------------------------
  // The annual card's own "Reload policy" is the SECOND reader of GET /api/attendance/settings (loadAnnualPolicy); the
  // cases above only drive the first one (loadSettings, through "Reload admin"). It has to drop the gate report on a
  // failed or denied read as well, and because the two cards share ONE report, BOTH go "unknown". Unlike loadSettings
  // it neither clears the settings document nor touches the saved annual policy, so BOTH cards keep what was
  // configured (contrast expectGateReportDropped, where the digest card reads "Not loaded"). `settingsGets` is asserted
  // to be exactly one more, which shows that no other loader ran and reset the report as a side effect.

  function expectGateReportUnknown(root: HTMLElement): void {
    for (const card of [digestCard(root), annualCard(root)]) {
      const status = statusIn(card)
      expect(status.getAttribute('data-runnable-state')).toBe('unknown')
      expect(textOf(status.querySelector('[data-scheduled-feature-runnable]'))).toContain('Unknown')
      expect(textOf(status)).not.toContain('Server run switches are on')
    }
  }

  function expectConfiguredKept(root: HTMLElement): void {
    for (const card of [digestCard(root), annualCard(root)]) {
      const status = statusIn(card)
      expect(status.getAttribute('data-configured-state')).toBe('configured')
      expect(textOf(status.querySelector('[data-scheduled-feature-configured]'))).toBe('Configured')
    }
  }

  it('annual: a FAILED "Reload policy" on the same mounted instance drops the last gate report: both cards go "unknown", both keep "Configured"', async () => {
    const root = await mountWithOpenGates()
    const getsBefore = settingsGets

    settingsGetStatus = 500
    buttonByText(annualCard(root), 'Reload policy').click()
    await flushUi(10)

    expect(mounts).toBe(1)
    expect(settingsGets).toBe(getsBefore + 1) // the card's own reload, nothing else
    expectGateReportUnknown(root)
    expectConfiguredKept(root)
    // The failure reached the catch branch. Only this one loader ran, so nothing overwrote the shared status line.
    expect(adminStatusText(root)).toContain('settings unavailable')
  })

  it('annual: a 403 on "Reload policy" of the same mounted instance also drops the last gate report', async () => {
    // 'managed' has to be in place BEFORE the first mount: this reload does not re-read the group catalog, and under
    // any other scope a 403 replaces the whole admin surface with a "permissions required" notice, leaving no card.
    groupsScope = 'managed'
    const root = await mountWithOpenGates()
    const getsBefore = settingsGets

    settingsGetStatus = 403
    buttonByText(annualCard(root), 'Reload policy').click()
    await flushUi(10)

    expect(mounts).toBe(1)
    expect(settingsGets).toBe(getsBefore + 1)
    expectGateReportUnknown(root)
    expectConfiguredKept(root)
  })

  // ---- monthly annual-leave auto-accrual -------------------------------------------------------------------

  it('annual: configured + gates closed shows 已配置 and "No", names only the closed gates, and the manual run stays out of it', async () => {
    settingsData = { annualLeavePolicy: ANNUAL(true, true) }
    runtimeGates = { ...GATES_ALL_OPEN, annualLeaveAccrualScheduled: { gatesOpen: false, closedGates: ['accrualTrigger'] } }
    const root = await mountAdmin()
    const status = statusIn(annualCard(root))
    expect(status.getAttribute('data-scheduled-feature')).toBe('annualLeaveAccrualScheduled')
    expect(status.getAttribute('data-configured-state')).toBe('configured')
    expect(status.getAttribute('data-runnable-state')).toBe('closed')
    const detail = textOf(status.querySelector('[data-scheduled-feature-detail]'))
    expect(detail).toContain('answering process reported')
    expect(detail).toContain('The manual run is not affected')
    expect(detail).toContain('ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED')
    expect(detail).not.toContain('ATTENDANCE_SCHEDULER_ENABLED')
    expect(detail).toContain('The manual run is not affected')
  })

  it('annual: the old over-claim ("runs automatically ... no admin click required") is gone, replaced by the two-halves explanation', async () => {
    settingsData = { annualLeavePolicy: ANNUAL(true, true) }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const hint = textOf(annualCard(root).querySelector('[data-annual-policy-scheduled-hint]'))
    expect(hint).toContain('only records the setting')
    expect(hint).toContain('server run switches')
    expect(textOf(annualCard(root))).not.toContain('no admin click required')
  })

  it('annual: scheduled trigger on while the engine is off is "Incomplete"', async () => {
    settingsData = { annualLeavePolicy: ANNUAL(false, true) }
    runtimeGates = GATES_ALL_OPEN
    const root = await mountAdmin()
    const status = statusIn(annualCard(root))
    expect(status.getAttribute('data-configured-state')).toBe('incomplete')
    expect(textOf(status)).toContain('the annual leave engine above is not enabled')
  })

  it('annual: ticking the scheduled trigger does NOT move the configured status; only the saved response does', async () => {
    settingsData = { annualLeavePolicy: ANNUAL(true, false) }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = annualCard(root)
    expect(statusIn(card).getAttribute('data-configured-state')).toBe('not_configured')
    setCheckbox(card, '[data-annual-policy="scheduled-trigger"]', true)
    await flushUi(3)
    expect(statusIn(card).getAttribute('data-configured-state')).toBe('not_configured') // unsaved edit: unchanged

    buttonByText(card, 'Save policy').click()
    await flushUi(10)
    expect(puts).toHaveLength(1)
    expect(statusIn(card).getAttribute('data-configured-state')).toBe('configured')
    const status = adminStatusText(root)
    expect(status).toContain('Annual leave policy saved')
    expect(status).toContain('answering process reported')
    expect(status).toContain('The manual run is not affected')
  })

  it('PIN annual: saving sends exactly the same PUT body as before - ONLY annualLeavePolicy with the same keys', async () => {
    settingsData = { annualLeavePolicy: ANNUAL(true, false) }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = annualCard(root)
    setCheckbox(card, '[data-annual-policy="scheduled-trigger"]', true)
    await flushUi(3)
    buttonByText(card, 'Save policy').click()
    await flushUi(10)

    expect(puts).toHaveLength(1)
    expect(Object.keys(puts[0].body!)).toEqual(['annualLeavePolicy'])
    expect(Object.keys(puts[0].body!.annualLeavePolicy as Record<string, unknown>).sort())
      .toEqual(['carryover', 'enabled', 'scheduledTrigger', 'standardDayMinutes', 'tenureMode', 'tiers', 'timezone'])
    expect((puts[0].body!.annualLeavePolicy as { scheduledTrigger: unknown }).scheduledTrigger).toEqual({ enabled: true })
  })

  it('annual: saving the trigger OFF keeps the original status text exactly', async () => {
    settingsData = { annualLeavePolicy: ANNUAL(true, true) }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = annualCard(root)
    setCheckbox(card, '[data-annual-policy="scheduled-trigger"]', false)
    await flushUi(3)
    buttonByText(card, 'Save policy').click()
    await flushUi(10)
    expect(adminStatusText(root)).toBe('Annual leave policy saved')
  })

  it('annual: "Reload policy" re-reads the settings and refreshes the gate report along with the policy', async () => {
    // Ops turn the switches on and restart the server while the page stays open; the card's own Reload button
    // is how the admin picks that up without reloading the whole console.
    settingsData = { annualLeavePolicy: ANNUAL(true, true) }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    const card = annualCard(root)
    expect(statusIn(card).getAttribute('data-runnable-state')).toBe('closed')
    const getsBefore = settingsGets

    runtimeGates = GATES_ALL_OPEN
    buttonByText(card, 'Reload policy').click()
    await flushUi(10)

    expect(settingsGets).toBe(getsBefore + 1) // the card's own reload, nothing else
    expect(statusIn(card).getAttribute('data-runnable-state')).toBe('open')
    expect(statusIn(card).getAttribute('data-configured-state')).toBe('configured')
  })

  // ---- zh leg ------------------------------------------------------------------------------------------------

  it('zh: both cards use the literal labels 已配置 and 当前是否可运行', async () => {
    useLocale().setLocale('zh-CN')
    settingsData = { attendanceReportDigestPolicy: DIGEST_ON, annualLeavePolicy: ANNUAL(true, true) }
    runtimeGates = GATES_ALL_CLOSED
    const root = await mountAdmin()
    for (const card of [digestCard(root), annualCard(root)]) {
      const status = statusIn(card)
      expect(textOf(status.querySelector('[data-scheduled-feature-configured]'))).toBe('已配置')
      expect(textOf(status)).toContain('当前是否可运行')
      expect(textOf(status.querySelector('[data-scheduled-feature-runnable]'))).toBe('否：应答进程的服务端运行开关未全部开启')
    }
  })
})
