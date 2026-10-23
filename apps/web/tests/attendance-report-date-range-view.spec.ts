import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { isAttendanceReportDateRangeValid } from '../src/views/attendance/attendanceReportDateRange'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

function response(data: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => ({ ok: status === 200, data }),
    text: async () => 'name,date\nSynthetic,2026-10-01\n', headers: new Headers() } as Response
}
function row(date = '2026-10-01') {
  return { id: `synthetic-${date}`, work_date: date, status: 'normal', work_minutes: 480,
    late_minutes: 0, early_leave_minutes: 0, meta: {}, workday_context: { timezone: 'UTC' } }
}
function requestGroups(count = 3) { return { items: [{ requestType: 'leave', status: 'pending', total: count, minutes: 60 }] } }

describe('report range strict calendar contract', () => {
  it.each([
    ['', ''], ['', '2026-10-22'], ['2026-10-01', ''], ['  ', '2026-10-22'],
    ['nonsense', 'nonsense'], ['2026-2-01', '2026-10-22'], ['2026-02-30', '2026-03-01'],
    ['2025-02-29', '2025-03-01'], ['2026-04-31', '2026-05-01'],
    ['2026-10-01T00:00:00Z', '2026-10-22'], [' 2026-10-01', '2026-10-22'],
    ['2026-10-22', '2026-10-01'],
  ])('rejects incomplete, non-calendar or reversed dates: %j / %j', (from, to) => {
    expect(isAttendanceReportDateRangeValid(from, to)).toBe(false)
  })
  it.each([['2024-02-29', '2024-02-29'], ['2026-10-01', '2026-10-22'], ['2000-02-29', '2000-03-01']])(
    'allows same-day and ordered real dates: %s / %s', (from, to) => {
      expect(isAttendanceReportDateRangeValid(from, to)).toBe(true)
    },
  )
})

type ReportTestState = {
  recordsPage: number
  summary: { total_days: number } | null
  loadedHistoryScope: ({ page: number } & Record<string, unknown>) | null
  reloadReportsWithStatus: () => Promise<void>
}

describe('mounted report range entries and response ownership', () => {
  let app: App<Element> | undefined
  let container: HTMLDivElement
  let intercept: ((url: string) => Promise<Response> | undefined) | undefined
  let downloads: Blob[]
  const urls = () => vi.mocked(apiFetch).mock.calls.map(call => String(call[0]))
  const top = () => container.querySelector<HTMLButtonElement>('.attendance__filters > button.attendance__btn')!
  const requestReload = () => container.querySelector<HTMLButtonElement>('[data-report-card="request-report"] button')!
  const page = (delta: number) => container.querySelectorAll<HTMLButtonElement>('.attendance__pagination button')[delta > 0 ? 1 : 0]!
  const exportButton = (kind: string) => kind === 'xlsx'
    ? container.querySelector<HTMLButtonElement>('[data-testid="attendance-export-xlsx"]')!
    : Array.from(container.querySelectorAll<HTMLButtonElement>('.attendance__filters button')).find(b => b.textContent?.trim() === 'Export CSV')!
  const recordsBody = () => container.querySelector('[data-report-card="records"] tbody')!
  const reportCard = () => container.querySelector('[data-report-card="request-report"]')!
  // Vue exposes this proxy at runtime, but omits it from its public instance type.
  const state = () => (app!._instance as unknown as { setupState: ReportTestState }).setupState
  const status = () => container.querySelector('.attendance__status')?.textContent || ''
  const forceClick = (button: HTMLButtonElement) => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
  const input = (id: string, value: string) => {
    const element = container.querySelector<HTMLInputElement>(`#attendance-${id}`)!
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const range = () => ['from', 'to'].map(id => container.querySelector<HTMLInputElement>(`#attendance-${id}-date`)!.value)
  const setRange = async (from: string, to: string) => { input('from-date', from); input('to-date', to); await nextTick() }
  const flush = async () => { for (let i = 0; i < 20; i += 1) { await Promise.resolve(); await nextTick() } }
  function hold(endpoint: string) {
    const pending: Array<{ url: string; resolve: (value: Response) => void; reject: (error: Error) => void }> = []
    intercept = url => url.includes(endpoint) ? new Promise((resolve, reject) => { pending.push({ url, resolve, reject }) }) : undefined
    return pending
  }
  const mount = async () => {
    app = createApp(AttendanceView, { mode: 'reports' })
    app.mount(container)
    await vi.waitFor(() => { expect(recordsBody()?.textContent).toContain('2026-10-01'); expect(top().disabled).toBe(false) })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
    localStorage.clear(); localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance?tab=reports')
    intercept = undefined; downloads = []
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected real network') }))
    vi.stubGlobal('URL', URL)
    URL.createObjectURL = vi.fn((blob: Blob) => { downloads.push(blob); return 'blob:synthetic' })
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.mocked(apiFetch).mockImplementation(async input => {
      const url = String(input)
      const held = intercept?.(url)
      if (held) return held
      if (url.includes('/summary?')) return response({ total_days: 2, total_minutes: 960, normal_days: 2 })
      if (url.includes('/records?')) return response({ items: [row(new URL(url, 'https://synthetic.invalid').searchParams.get('page') === '2' ? '2026-10-02' : '2026-10-01')], total: 60 })
      if (url.includes('/reports/requests?')) return response(requestGroups())
      return response({ items: [], total: 0 })
    })
    container = document.createElement('div'); document.body.appendChild(container)
  })
  afterEach(() => { app?.unmount(); app = undefined; container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each(['top', 'request', 'next', 'csv', 'xlsx', 'org'])(
    '%s rejects missing dates before HTTP, clearing data, changing page or success status', async entry => {
      await mount()
      const before = recordsBody().innerHTML
      const beforePage = state().recordsPage
      await setRange('', '')
      vi.mocked(apiFetch).mockClear()
      if (entry === 'top') forceClick(top())
      if (entry === 'request') forceClick(requestReload())
      if (entry === 'next') forceClick(page(1))
      if (entry === 'csv' || entry === 'xlsx') forceClick(exportButton(entry))
      if (entry === 'org') input('org-id', 'synthetic-next-org')
      await flush()
      expect(apiFetch, `${entry}: no HTTP before validation`).not.toHaveBeenCalled()
      expect(recordsBody().innerHTML, `${entry}: preserve rows`).toBe(before)
      expect(state().recordsPage, `${entry}: preserve page`).toBe(beforePage)
      expect(status(), `${entry}: named validation, no false success`).toContain('Choose both start and end dates')
    },
  )

  it.each([['2026-02-30', '2026-03-01', 'Use valid dates'], ['2026-10-22', '2026-10-01', 'Start date']])(
    'top rejects invalid calendar/order without clearing prior data: %s', async (from, to, message) => {
      await mount(); const before = recordsBody().innerHTML
      await setRange(from, to); vi.mocked(apiFetch).mockClear(); forceClick(top()); await flush()
      expect(apiFetch).not.toHaveBeenCalled(); expect(recordsBody().innerHTML).toBe(before)
      expect(status()).toContain(message)
    },
  )

  it('a preset repairs invalid manually entered dates rather than staying disabled', async () => {
    await mount(); await setRange('', 'not-a-date')
    const preset = container.querySelector<HTMLButtonElement>('[data-report-filter-value="this-month"]')!
    expect(preset.disabled).toBe(false); preset.click()
    await vi.waitFor(() => expect(exportButton('xlsx').disabled).toBe(false))
    expect(range()).toEqual(['2026-10-01', '2026-10-31'])
    expect(recordsBody().textContent).toContain('2026-10-01')
  })

  it('a same-target preset can still repair invalid dates after a cross-range partial reload', async () => {
    await mount(); input('org-id', 'synthetic-org'); await flush()
    await vi.waitFor(() => expect(top().disabled).toBe(false))
    await setRange('2026-09-01', '2026-09-30'); forceClick(requestReload()); await flush()
    await setRange('', 'not-a-date')
    const preset = container.querySelector<HTMLButtonElement>('[data-report-filter-value="this-month"]')!
    expect(preset.disabled, 'partial freshness must not discard the loaded record target').toBe(false)
    preset.click(); await vi.waitFor(() => expect(exportButton('xlsx').disabled).toBe(false))
    expect(range()).toEqual(['2026-10-01', '2026-10-31'])
  })

  it('valid same-day refresh, pagination, CSV and real XLSX remain usable', async () => {
    await mount(); await setRange('2026-10-10', '2026-10-10'); forceClick(top())
    await vi.waitFor(() => expect(exportButton('xlsx').disabled).toBe(false))
    forceClick(page(1)); await vi.waitFor(() => expect(recordsBody().textContent).toContain('2026-10-02'))
    expect(state().recordsPage).toBe(2)
    forceClick(exportButton('csv')); await vi.waitFor(() => expect(downloads).toHaveLength(1))
    forceClick(exportButton('xlsx')); await vi.waitFor(() => expect(downloads).toHaveLength(2), { timeout: 3000 })
    expect(downloads[1].size).toBeGreaterThan(200)
    expect(downloads.map(blob => blob.type)).toEqual(['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
    const exports = urls().filter(url => url.includes('/export?'))
    expect(exports).toHaveLength(2)
    for (const url of exports) {
      const params = new URL(url, 'https://synthetic.invalid').searchParams
      expect([params.get('from'), params.get('to')]).toEqual(['2026-10-10', '2026-10-10'])
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('records B requested locally cannot overwrite A after the input returns to A', async () => {
    await mount(); const original = range(); const before = recordsBody().innerHTML; const beforeStatus = status()
    const pending = hold('/records?')
    await setRange('2026-09-01', '2026-09-30'); forceClick(page(1))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await setRange(original[0], original[1]); pending[0].resolve(response({ items: [row('2026-09-15')], total: 60 })); await flush()
    expect(recordsBody().innerHTML, 'late B records must not pollute A').toBe(before)
    expect(status(), 'discarded records must not claim success').toBe(beforeStatus)
    expect(exportButton('xlsx').disabled, 'partial cross-range load cannot make A look fresh again').toBe(true)
  })

  it('request report B requested locally cannot overwrite A after the input returns to A', async () => {
    await mount(); const original = range(); const before = reportCard().textContent
    const pending = hold('/reports/requests?')
    await setRange('2026-09-01', '2026-09-30'); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await setRange(original[0], original[1]); pending[0].resolve(response(requestGroups(99))); await flush()
    expect(reportCard().textContent, 'late B request report must not pollute A').toBe(before)
    expect(exportButton('xlsx').disabled).toBe(true)
  })

  it('a local A response loses ownership across an A-B-A input cycle even when its key matches again', async () => {
    await mount(); const original = range(); const before = reportCard().textContent; const beforeStatus = status()
    const pending = hold('/reports/requests?'); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await setRange('2026-09-01', '2026-09-30'); await setRange(original[0], original[1])
    pending[0].resolve(response(requestGroups(99))); await flush()
    expect(reportCard().textContent, 'input generation must reject obsolete A').toBe(before)
    expect(status(), 'discarded local request must not claim success').toBe(beforeStatus)
  })

  it('old request failure after a new success cannot replace its data or success status', async () => {
    await mount(); const pending = hold('/reports/requests?'); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(1)); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(2)); pending[1].resolve(response(requestGroups(7))); await flush()
    const before = reportCard().textContent; const successfulStatus = status()
    pending[0].reject(new Error('obsolete synthetic failure')); await flush()
    expect(reportCard().textContent).toBe(before)
    expect(status(), 'old failure cannot replace new success').toBe(successfulStatus)
    expect(status()).not.toContain('obsolete synthetic failure')
  })

  it('an old request completion cannot clear the newer request loading indicator', async () => {
    await mount(); const pending = hold('/reports/requests?'); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(1)); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[0].resolve(response(requestGroups(99))); await flush()
    try {
      expect(requestReload().disabled, 'newer request retains its loading ownership').toBe(true)
      expect(requestReload().textContent).toContain('Loading')
    } finally {
      pending[1].resolve(response(requestGroups(7))); await flush()
    }
  })

  it('a same-range page request cancelled by A-B-A restores the displayed page and loaded scope', async () => {
    await mount(); const original = range(); const before = recordsBody().innerHTML
    const beforeScope = { ...state().loadedHistoryScope }; const beforeStatus = status()
    expect(beforeScope.page, 'initial loaded scope belongs to page one').toBe(1)
    const pending = hold('/records?'); forceClick(page(1))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await setRange('2026-09-01', '2026-09-30'); await setRange(original[0], original[1])
    pending[0].resolve(response({ items: [row('2026-10-02')], total: 60 })); await flush()
    expect(recordsBody().innerHTML, 'cancelled page must preserve displayed records').toBe(before)
    expect(state().recordsPage, 'cancelled page must restore the actual displayed page').toBe(1)
    expect(state().loadedHistoryScope, 'cancelled page must retain the displayed record scope').toEqual(beforeScope)
    expect(status(), 'cancelled page cannot claim success').toBe(beforeStatus)
    expect(exportButton('xlsx').disabled, 'restored original complete snapshot remains exportable').toBe(false)
  })

  it.each(['same-range', 'changed-range'])('an old full-batch failure cannot erase a newer local report success: %s', async context => {
    await mount(); const pending = hold('/summary?'); forceClick(top())
    await vi.waitFor(() => expect(pending).toHaveLength(1)); await flush()
    expect(requestReload().disabled, 'old batch request child has already completed').toBe(false)
    expect(recordsBody().textContent, 'old batch records child has already completed').toContain('2026-10-01')
    if (context === 'changed-range') await setRange('2026-09-01', '2026-09-30')
    vi.mocked(apiFetch).mockResolvedValueOnce(response(requestGroups(7)))
    forceClick(requestReload()); await flush()
    const before = reportCard().textContent; const successfulStatus = status()
    expect(successfulStatus).toContain('Report loaded')
    pending[0].reject(new Error('obsolete full-batch failure')); await flush()
    expect(reportCard().textContent, 'new local data must survive the older batch failure').toBe(before)
    expect(status(), 'new local success owns the status').toBe(successfulStatus)
    expect(exportButton('xlsx').disabled, 'partial local success does not complete the old batch').toBe(true)
    expect(top().disabled, 'superseded batch releases its own loading state').toBe(false)
  })

  it.each([
    ['/api/attendance/holidays?', 'failure'], ['/api/attendance/requests?', 'failure'],
    ['/api/attendance/holidays?', 'success'], ['/api/attendance/requests?', 'success'],
  ])('org refreshAll %s %s cannot publish after its report children completed and local B succeeded', async (endpoint, outcome) => {
    await mount(); const original = range(); const pending = hold(endpoint)
    input('org-id', 'synthetic-org-A')
    await vi.waitFor(() => expect(pending).toHaveLength(1)); await flush()
    expect(recordsBody().textContent, 'full records child settled').toContain('2026-10-01')
    expect(state().summary?.total_days, 'full summary child settled').toBe(2)
    expect(requestReload().disabled, 'full request-report child settled').toBe(false)
    expect(reportCard().textContent).toContain('3 requests')
    await setRange('2026-09-01', '2026-09-30')
    vi.mocked(apiFetch).mockResolvedValueOnce(response(requestGroups(7)))
    forceClick(requestReload()); await flush()
    const before = reportCard().textContent; const successfulStatus = status()
    expect(successfulStatus).toContain('Report loaded')
    if (outcome === 'failure') pending[0].reject(new Error('obsolete non-report child'))
    else pending[0].resolve(response({ items: [], total: 0 }))
    await flush()
    expect(reportCard().textContent, 'older auxiliary settlement must not clear local B').toBe(before)
    expect(status(), 'older auxiliary settlement must not replace local B status').toBe(successfulStatus)
    await setRange(original[0], original[1])
    expect(exportButton('xlsx').disabled, 'older auxiliary settlement cannot make a mixed A snapshot fresh').toBe(true)
    expect(top().disabled, 'obsolete batch releases only its own loading state').toBe(false)
  })

  it('invalid calendar input is not normalized into a fictitious date in the range summary', async () => {
    await mount(); await setRange('2026-02-30', '2026-03-01')
    expect(container.querySelector('[data-report-period-label]')?.textContent).toBe('Range not set')
  })

  it('the current records card guards both actual paging directions before HTTP', async () => {
    await mount(); forceClick(page(1)); await vi.waitFor(() => expect(state().recordsPage).toBe(2))
    await vi.waitFor(() => expect(recordsBody().textContent).toContain('2026-10-02'))
    await setRange('', ''); vi.mocked(apiFetch).mockClear()
    const buttons = recordsBody().closest('[data-report-card="records"]')!.querySelectorAll<HTMLButtonElement>('.attendance__pagination button')
    for (const button of buttons) { forceClick(button); await flush() }
    expect(apiFetch, 'records-card paging validates before HTTP').not.toHaveBeenCalled()
    expect(state().recordsPage, 'records-card paging preserves loaded page').toBe(2)
    expect(status()).toContain('Choose both start and end dates')
    await state().reloadReportsWithStatus(); await flush()
    expect(apiFetch, 'direct current report reload is also guarded').not.toHaveBeenCalled()
    expect(recordsBody().textContent).toContain('2026-10-02')
  })

  it('same-range pagination accepts the latest page and ignores an older completion', async () => {
    await mount(); const pending = hold('/records?'); forceClick(page(1))
    await vi.waitFor(() => expect(pending).toHaveLength(1)); forceClick(page(-1))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1].resolve(response({ items: [row('2026-10-05')], total: 60 })); await flush()
    pending[0].resolve(response({ items: [row('2026-10-02')], total: 60 })); await flush()
    expect(state().recordsPage).toBe(1)
    expect(recordsBody().textContent).toContain('2026-10-05')
    expect(recordsBody().textContent).not.toContain('2026-10-02')
  })

  it('a batch with a superseded child cannot announce a complete successful snapshot', async () => {
    await mount(); const pending = hold('/reports/requests?'); forceClick(top())
    await vi.waitFor(() => expect(pending).toHaveLength(1)); forceClick(requestReload())
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1].resolve(response(requestGroups(7))); await flush()
    pending[0].resolve(response(requestGroups(99))); await flush()
    expect(exportButton('xlsx').disabled, 'incomplete batch must not become fresh').toBe(true)
    expect(status(), 'superseded child must not become batch success').not.toContain('Reports refreshed')
  })

  it.each(['success', 'failure'])('old batch summary %s cannot overwrite a newer complete report', async outcome => {
    await mount(); const pending = hold('/summary?'); forceClick(top())
    await vi.waitFor(() => expect(pending).toHaveLength(1)); forceClick(top())
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1].resolve(response({ total_days: 9, total_minutes: 4320, normal_days: 9 })); await flush()
    const successfulStatus = status()
    if (outcome === 'failure') pending[0].reject(new Error('obsolete batch failure'))
    else pending[0].resolve(response({ total_days: 1, total_minutes: 480, normal_days: 1 }))
    await flush()
    expect(state().summary?.total_days, 'new summary owns the report').toBe(9)
    expect(exportButton('xlsx').disabled, 'old batch cannot clear fresh report').toBe(false)
    expect(status(), 'old batch cannot replace new success status').toBe(successfulStatus)
  })
})
