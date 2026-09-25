import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
// Static import for the same reason IntegrationWorkbenchView.spec.ts uses one: a dynamic import of
// this ~5400-line SFC inside a test body pays the whole module graph's transform cost against that
// test's own 5000ms timeout (the #4614 flake). Collect-phase import is not timeout-bounded.
import View from '../src/views/IntegrationWorkbenchView.vue'
import { useLocale } from '../src/composables/useLocale'

// SC-04 frontend wiring: the 运行监控 panel's per-run 详情 entry reads ONE run through
// GET /api/integration/runs/:runId (plugin handler `runsGet`, PR #5887) and renders it in a
// read-only dialog.
//
// The mock is installed at the apiFetch/URL seam, NOT at the service-function seam, on purpose:
// a service-level mock would still pass if the service called the wrong URL, which is exactly the
// regression this file has to catch (the list route answers `/api/integration/runs?...`, the single
// read answers `/api/integration/runs/<id>` — a query-shaped single read would silently return a
// LIST and the dialog would render nothing). Mutating the service URL to `/runs?id=` turns the
// first two cases red here.
const ElCard = defineComponent({
  name: 'ElCard',
  props: { shadow: { type: String, required: false, default: undefined } },
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-card' }, [
      slots.header ? h('div', { class: 'el-card__header' }, slots.header()) : null,
      h('div', { class: 'el-card__body' }, slots.default?.()),
    ])
  },
})

const apiFetchMock = vi.fn()
const apiGetMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}))

const PIPELINE_ID = 'pipe_rd'
const RUN_ID = 'run_rd_1'
const LIST_URL = `/api/integration/runs?tenantId=default&pipelineId=${PIPELINE_ID}&limit=5`
const DEAD_LETTERS_URL = `/api/integration/dead-letters?tenantId=default&pipelineId=${PIPELINE_ID}&status=open&limit=5`
// workspaceId is null in the default scope, and buildQueryString drops null — so the detail URL
// carries only the tenant echo. This literal is the contract this file pins.
const DETAIL_URL = `/api/integration/runs/${RUN_ID}?tenantId=default`
// Q4a: the per-run provenance sub-route. Same query-suffix rule as the detail URL (workspaceId is
// null in the default scope and buildQueryString drops it), and `provenance` is a PATH segment —
// a `/runs/<id>?provenance=1` shaped call would hit the single-run read instead.
const PROVENANCE_URL = `/api/integration/runs/${RUN_ID}/provenance?tenantId=default`
const PROVENANCE_PATH = `/api/integration/runs/${RUN_ID}/provenance`
const PROVENANCE_ITEMS = [
  {
    runId: RUN_ID, pipelineId: PIPELINE_ID, rowId: 'DEMO-001',
    eventType: 'row_cleaned', at: '2026-09-19T02:00:00.500Z', attrs: { rule: 'trim' },
    eventIndex: 1, runStatus: 'partial', runMode: 'dry-run', runCreatedAt: '2026-09-19T02:00:00.000Z',
  },
  {
    runId: RUN_ID, pipelineId: PIPELINE_ID, rowId: 'DEMO-001',
    eventType: 'target_write_succeeded', at: '2026-09-19T02:00:01.000Z', attrs: {},
    eventIndex: 2, runStatus: 'partial', runMode: 'dry-run', runCreatedAt: '2026-09-19T02:00:00.000Z',
  },
]
// f-prov200: the route's page envelope for a complete two-event run.
const PROVENANCE_PAGE = { items: PROVENANCE_ITEMS, total: 2, truncated: false, nextCursor: null }

const LIST_RUN = {
  id: RUN_ID,
  tenantId: 'default',
  workspaceId: null,
  pipelineId: PIPELINE_ID,
  mode: 'dry-run',
  triggeredBy: 'api',
  status: 'running',
  rowsRead: 4,
  rowsCleaned: 4,
  rowsWritten: 0,
  rowsFailed: 0,
  startedAt: '2026-09-19T02:00:00.000Z',
  details: {},
}

// The single read answers with state the cached list row predates (finished, with details) — that
// is the whole point of re-reading instead of showing the already-listed row.
const DETAIL_RUN = {
  ...LIST_RUN,
  status: 'partial',
  rowsWritten: 3,
  rowsFailed: 1,
  durationMs: 1800,
  finishedAt: '2026-09-19T02:00:01.800Z',
  errorSummary: '1 row failed validation',
  details: {
    watermarkAdvanced: false,
    targetWriteSummaries: [{ code: 'DEMO-001', result: 'ok' }],
  },
  createdAt: '2026-09-19T02:00:00.000Z',
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

describe('IntegrationWorkbenchView run detail (SC-04)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let detailCalls: Array<{ url: string; init?: RequestInit }> = []
  let provenanceCalls: Array<{ url: string; init?: RequestInit }> = []

  beforeEach(() => {
    setActivePinia(createPinia())
    detailCalls = []
    provenanceCalls = []
    apiGetMock.mockReset()
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/data-sources') return { ok: true, data: { items: [] } }
      throw new Error(`unexpected apiGet ${url}`)
    })
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
    // useLocale keeps module-level state that survives between tests in this file; pin it so a
    // case that switched to zh-CN cannot decide the next case's expected copy.
    setLocale('en')
  })

  // Same helper the approval i18n specs use: storage + the composable, because the module-level
  // locale ref was already initialized at import time.
  function setLocale(locale: 'en' | 'zh-CN'): void {
    window.localStorage.setItem('metasheet_locale', locale)
    useLocale().setLocale(locale)
  }

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  // `answerDetail` decides what the SINGLE read returns; everything else is the same bootstrap +
  // list answer for all four cases.
  // The provenance branch dispatches on the PATH and hands the full URL (query included) to
  // `answerProvenance`, so a paged fake can decide its answer from the `cursor` / `limit` it was
  // actually sent — a prefix-only mock would answer page one to every request and could not see a
  // client that forgot the cursor.
  function installMocks(
    answerDetail: () => Response,
    answerProvenance: (url: string) => Response | Promise<Response> = () => jsonResponse(PROVENANCE_PAGE),
  ): void {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === LIST_URL) return jsonResponse([LIST_RUN])
      if (url === DEAD_LETTERS_URL) return jsonResponse([])
      if (url.split('?')[0] === PROVENANCE_PATH) {
        provenanceCalls.push({ url, init })
        return answerProvenance(url)
      }
      if (url === DETAIL_URL) {
        detailCalls.push({ url, init })
        return answerDetail()
      }
      throw new Error(`unexpected URL ${url}`)
    })
  }

  async function expandProvenance(host: HTMLDivElement): Promise<void> {
    const toggle = host.querySelector('[data-testid="toggle-run-provenance"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    toggle.click()
    await flushUi()
  }

  async function mountAndListRuns(): Promise<HTMLDivElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('ElCard', ElCard)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()
    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = PIPELINE_ID
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container.querySelector(`[data-testid="pipeline-run-${RUN_ID}"]`)).not.toBeNull()
    return container
  }

  async function openDetail(host: HTMLDivElement): Promise<void> {
    const button = host.querySelector(`[data-testid="open-run-detail-${RUN_ID}"]`) as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    await flushUi()
  }

  it('the 详情 entry reads the single-run route with the runId in the path (and no hand-rolled tenant header)', async () => {
    installMocks(() => jsonResponse(DETAIL_RUN))
    const host = await mountAndListRuns()
    // Listing alone must not have fetched any single run.
    expect(detailCalls).toHaveLength(0)
    await openDetail(host)
    expect(detailCalls).toHaveLength(1)
    expect(detailCalls[0].url).toBe(DETAIL_URL)
    // The runId rides in the PATH, not as a query parameter (`/runs?id=` would be the list route).
    expect(detailCalls[0].url.split('?')[0]).toBe(`/api/integration/runs/${RUN_ID}`)
    // x-tenant-id hole: the value-plane request must lean on the session JWT that apiFetch
    // attaches, never on a tenant header the service assembles itself.
    const headers = new Headers((detailCalls[0].init?.headers ?? {}) as HeadersInit)
    expect(headers.get('x-tenant-id')).toBeNull()
  })

  it('renders the fetched run — including state newer than the listed row — plus its details JSON', async () => {
    installMocks(() => jsonResponse(DETAIL_RUN))
    const host = await mountAndListRuns()
    // The listed row is still 'running': the dialog's content must come from the single read.
    expect((host.querySelector(`[data-testid="run-status-${RUN_ID}"]`) as HTMLElement).textContent).toContain('running')
    await openDetail(host)
    const dialog = host.querySelector('[data-testid="run-detail-dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect((host.querySelector('[data-testid="run-detail-id"]') as HTMLElement).textContent).toContain(RUN_ID)
    expect((host.querySelector('[data-testid="run-detail-status"]') as HTMLElement).textContent).toContain('partial')
    expect((host.querySelector('[data-testid="run-detail-mode"]') as HTMLElement).textContent).toContain('dry-run')
    const metrics = (host.querySelector('[data-testid="run-detail-metrics"]') as HTMLElement).textContent ?? ''
    expect(metrics).toContain('write 3')
    expect(metrics).toContain('fail 1')
    expect(metrics).toContain('1800ms')
    expect((host.querySelector('[data-testid="run-detail-times"]') as HTMLElement).textContent).toContain('2026-09-19T02:00:01.800Z')
    expect((host.querySelector('[data-testid="run-detail-error-summary"]') as HTMLElement).textContent).toContain('1 row failed validation')
    const payload = (host.querySelector('[data-testid="run-detail-payload"]') as HTMLElement).textContent ?? ''
    expect(payload).toContain('watermarkAdvanced')
    expect(payload).toContain('DEMO-001')
    expect(host.querySelector('[data-testid="run-detail-payload-empty"]')).toBeNull()
    // Read-only: the dialog offers no replay/retry/write control.
    expect(dialog.querySelector('[data-testid^="replay-"]')).toBeNull()
    // Closing clears it.
    ;(host.querySelector('[data-testid="close-run-detail"]') as HTMLButtonElement).click()
    await flushUi()
    expect(host.querySelector('[data-testid="run-detail-dialog"]')).toBeNull()
  })

  it.each([
    ['zh-CN' as const, '没有附加详情'],
    ['en' as const, 'no extra details'],
  ])('shows the empty state when the run carries no details payload (%s)', async (locale, copy) => {
    setLocale(locale)
    installMocks(() => jsonResponse({ ...DETAIL_RUN, details: {}, errorSummary: null }))
    const host = await mountAndListRuns()
    await openDetail(host)
    expect(host.querySelector('[data-testid="run-detail-payload"]')).toBeNull()
    const empty = host.querySelector('[data-testid="run-detail-payload-empty"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.textContent).toContain(copy)
  })

  it.each([
    ['zh-CN' as const, '运行不存在或不可见'],
    ['en' as const, 'does not exist or is not visible'],
  ])('maps RUN_NOT_FOUND (404) to the not-visible copy, not the raw server prose (%s)', async (locale, copy) => {
    setLocale(locale)
    installMocks(() => errorResponse(404, 'RUN_NOT_FOUND', 'pipeline run not found'))
    const host = await mountAndListRuns()
    await openDetail(host)
    const error = host.querySelector('[data-testid="run-detail-error"]') as HTMLElement
    expect(error).not.toBeNull()
    expect(error.textContent).toContain(copy)
    // Branching is on the CODE: the server's own prose must not be what the operator reads, so a
    // re-worded (or differently localized) backend message cannot silently kill this state.
    expect(error.textContent).not.toContain('pipeline run not found')
    expect(host.querySelector('[data-testid="run-detail-payload"]')).toBeNull()
  })

  it.each([
    ['zh-CN' as const, '当前版本未启用'],
    ['en' as const, 'not enabled in this version'],
  ])('maps RUN_READ_NOT_IMPLEMENTED (501) to the not-enabled copy (%s)', async (locale, copy) => {
    setLocale(locale)
    installMocks(() => errorResponse(501, 'RUN_READ_NOT_IMPLEMENTED', 'Run read is not implemented'))
    const host = await mountAndListRuns()
    await openDetail(host)
    const error = host.querySelector('[data-testid="run-detail-error"]') as HTMLElement
    expect(error).not.toBeNull()
    expect(error.textContent).toContain(copy)
    expect(error.textContent).not.toContain('Run read is not implemented')
  })

  // --- Q4a: per-run provenance section ------------------------------------------------------
  it('fetches the run provenance from the per-run sub-route with the runId in the path, and only on expand', async () => {
    installMocks(() => jsonResponse(DETAIL_RUN))
    const host = await mountAndListRuns()
    await openDetail(host)
    // Opening 详情 must NOT have fetched the timeline: the section is collapsed by default, so the
    // dialog still costs exactly one request.
    expect(provenanceCalls).toHaveLength(0)
    expect(host.querySelector('[data-testid="run-provenance-timeline"]')).toBeNull()
    await expandProvenance(host)
    expect(provenanceCalls).toHaveLength(1)
    expect(provenanceCalls[0].url).toBe(PROVENANCE_URL)
    // `provenance` rides in the PATH under the runId — `/runs/<id>?provenance=1` is the single read.
    expect(provenanceCalls[0].url.split('?')[0]).toBe(`/api/integration/runs/${RUN_ID}/provenance`)
    // x-tenant-id hole: the value-plane request leans on the session JWT apiFetch attaches.
    const headers = new Headers((provenanceCalls[0].init?.headers ?? {}) as HeadersInit)
    expect(headers.get('x-tenant-id')).toBeNull()
    // collapse + re-expand reuses the fetched timeline (no second request for the same run)
    await expandProvenance(host)
    await expandProvenance(host)
    expect(provenanceCalls).toHaveLength(1)
  })

  it('renders one entry per provenance event, in event_index order, values-free', async () => {
    installMocks(() => jsonResponse(DETAIL_RUN))
    const host = await mountAndListRuns()
    await openDetail(host)
    await expandProvenance(host)
    const entries = host.querySelectorAll('[data-testid^="run-provenance-entry-"]')
    expect(entries).toHaveLength(PROVENANCE_ITEMS.length)
    const first = (entries[0] as HTMLElement).textContent ?? ''
    expect(first).toContain('row_cleaned')
    expect(first).toContain('#1')
    expect(first).toContain('DEMO-001')
    const second = (entries[1] as HTMLElement).textContent ?? ''
    expect(second).toContain('target_write_succeeded')
    expect(second).toContain('#2')
    // Read-only: the provenance section adds no replay/retry control.
    const section = host.querySelector('[data-testid="run-provenance"]') as HTMLElement
    expect(section.querySelector('[data-testid^="replay-"]')).toBeNull()
    // f-prov200: a page that states it is complete (total 2, truncated false) shows NO notice.
    expect(section.querySelector('[data-testid="run-provenance-truncated"]')).toBeNull()
    expect(section.querySelector('[data-testid="run-provenance-load-more"]')).toBeNull()
    // Values-free: no URL- or host-shaped strings reach the rendered timeline.
    const sectionText = section.textContent ?? ''
    expect(sectionText).not.toMatch(/https?:\/\//)
    expect(sectionText).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })

  it('clears the provenance section when the dialog is closed and re-opened', async () => {
    installMocks(() => jsonResponse(DETAIL_RUN))
    const host = await mountAndListRuns()
    await openDetail(host)
    await expandProvenance(host)
    expect(provenanceCalls).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid^="run-provenance-entry-"]')).toHaveLength(2)
    ;(host.querySelector('[data-testid="close-run-detail"]') as HTMLButtonElement).click()
    await flushUi()
    await openDetail(host)
    // Re-opened collapsed: a timeline fetched for an earlier dialog must never be showing under a
    // freshly opened one (that is how run A's lineage would appear under run B's header).
    expect(host.querySelector('[data-testid="run-provenance"]')).toBeNull()
    expect(host.querySelector('[data-testid="run-provenance-timeline"]')).toBeNull()
    // ...and the cache was cleared too, so expanding again really re-reads rather than replaying
    // whatever the previous dialog happened to hold.
    await expandProvenance(host)
    expect(provenanceCalls).toHaveLength(2)
    expect(host.querySelectorAll('[data-testid^="run-provenance-entry-"]')).toHaveLength(2)
  })

  it.each([
    ['zh-CN' as const, '运行不存在或不可见'],
    ['en' as const, 'does not exist or is not visible'],
  ])('maps a 404 on the provenance sub-route to the not-visible copy, not an empty timeline (%s)', async (locale, copy) => {
    setLocale(locale)
    installMocks(
      () => jsonResponse(DETAIL_RUN),
      () => errorResponse(404, 'RUN_NOT_FOUND', 'pipeline run not found'),
    )
    const host = await mountAndListRuns()
    await openDetail(host)
    await expandProvenance(host)
    const error = host.querySelector('[data-testid="run-provenance-error"]') as HTMLElement
    expect(error).not.toBeNull()
    expect(error.textContent).toContain(copy)
    // Branching is on the CODE, so the server's own prose is never what the operator reads.
    expect(error.textContent).not.toContain('pipeline run not found')
    // A 404 must NOT be shown as "this run recorded no events" — that is the state a real,
    // empty run gets, and conflating them is exactly what the route's 404 exists to prevent.
    expect(host.querySelector('[data-testid="run-provenance-empty"]')).toBeNull()
    expect(host.querySelector('[data-testid="run-provenance-timeline"]')).toBeNull()
  })

  it('keeps the detail surface values-free (no host/URL-shaped strings in the rendered dialog)', async () => {
    installMocks(() => jsonResponse(DETAIL_RUN))
    const host = await mountAndListRuns()
    await openDetail(host)
    const dialogText = (host.querySelector('[data-testid="run-detail-dialog"]') as HTMLElement).textContent ?? ''
    expect(dialogText).not.toMatch(/https?:\/\//)
    // Bare host:port shapes (e.g. an accidentally surfaced server address) are out too. The ISO
    // timestamps this dialog does render contain ':' but no dotted host label before it.
    expect(dialogText).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })

  // --- Q4b: non-terminal runs auto-refresh every RUN_DETAIL_POLL_MS ---------------------------
  // Only `setInterval`/`clearInterval` are faked: `flushUi`'s own `setTimeout(…, 0)` microtask
  // pump must keep running on real timers, or the mount/open sequence above never settles.
  const RUN_DETAIL_POLL_MS = 5000

  describe('Q4b auto-polling', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('re-fetches the run after RUN_DETAIL_POLL_MS while it is still non-terminal (running)', async () => {
      installMocks(() => jsonResponse({ ...DETAIL_RUN, status: 'running', finishedAt: null }))
      const host = await mountAndListRuns()
      await openDetail(host)
      expect(detailCalls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
      expect(detailCalls[1].url).toBe(DETAIL_URL)
      // The label reflects an armed timer.
      expect((host.querySelector('[data-testid="run-detail-poll-status"]') as HTMLElement).textContent)
        .toContain('Auto-refreshing')
    })

    it('does not poll again once the run reaches a terminal status (succeeded)', async () => {
      let call = 0
      installMocks(() => {
        call += 1
        // First read is still running; the poll it schedules comes back succeeded.
        const status = call === 1 ? 'running' : 'succeeded'
        return jsonResponse({ ...DETAIL_RUN, status, finishedAt: call === 1 ? null : DETAIL_RUN.finishedAt })
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      expect(detailCalls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
      expect((host.querySelector('[data-testid="run-detail-status"]') as HTMLElement).textContent).toContain('succeeded')
      expect((host.querySelector('[data-testid="run-detail-poll-status"]') as HTMLElement).textContent)
        .toContain('stopped')
      // A run that just turned terminal must never fire a THIRD read on the next tick.
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
    })

    it('clears the timer when the dialog is closed, so no further reads happen', async () => {
      installMocks(() => jsonResponse({ ...DETAIL_RUN, status: 'running', finishedAt: null }))
      const host = await mountAndListRuns()
      await openDetail(host)
      expect(detailCalls).toHaveLength(1)
      ;(host.querySelector('[data-testid="close-run-detail"]') as HTMLButtonElement).click()
      await flushUi()
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(1)
    })

    // --- #5950 review N1/N2: delayed-response interleavings -----------------------------------
    // These drive the REAL view through the apiFetch seam with hand-resolved promises, so the
    // order in which responses land is decided by the test, not by the mock's microtask timing.
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((r) => { resolve = r })
      return { promise, resolve }
    }
    const RUNNING_RUN = { ...DETAIL_RUN, status: 'running', finishedAt: null }

    it('N1: an initial read still in flight at unmount cannot re-arm polling when it lands', async () => {
      const initial = deferred<Response>()
      installMocks(() => initial.promise as unknown as Response)
      const host = await mountAndListRuns()
      await openDetail(host)
      expect(detailCalls).toHaveLength(1)
      app!.unmount()
      app = null
      initial.resolve(jsonResponse(RUNNING_RUN))
      await flushUi()
      expect(vi.getTimerCount(), 'no interval may be armed after unmount').toBe(0)
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS * 2)
      await flushUi()
      expect(detailCalls, 'unmounted view must not issue another run GET').toHaveLength(1)
    })

    it('N1: a background tick in flight at unmount cannot re-arm polling when it lands', async () => {
      const tick = deferred<Response>()
      let call = 0
      installMocks(() => {
        call += 1
        return (call === 2 ? tick.promise : jsonResponse(RUNNING_RUN)) as unknown as Response
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
      app!.unmount()
      app = null
      tick.resolve(jsonResponse(RUNNING_RUN))
      await flushUi()
      expect(vi.getTimerCount(), 'no interval may be armed after unmount').toBe(0)
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS * 2)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
    })

    it('N1: a provenance re-pull in flight at unmount cannot re-arm polling when it lands', async () => {
      const repull = deferred<Response>()
      let provenanceCall = 0
      installMocks(
        () => jsonResponse(RUNNING_RUN),
        () => {
          provenanceCall += 1
          return (provenanceCall === 2 ? repull.promise : jsonResponse(PROVENANCE_PAGE)) as unknown as Response
        },
      )
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      expect(provenanceCalls).toHaveLength(1)
      // The tick's run read lands; the quiet provenance re-pull it chains is still pending.
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
      expect(provenanceCalls).toHaveLength(2)
      app!.unmount()
      app = null
      repull.resolve(jsonResponse(PROVENANCE_PAGE))
      await flushUi()
      expect(vi.getTimerCount(), 'no interval may be armed after unmount').toBe(0)
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS * 2)
      await flushUi()
      expect(detailCalls).toHaveLength(2)
    })

    it('N2: a background tick that lands before a pending manual refresh does not leave the button stuck', async () => {
      const manual = deferred<Response>()
      let call = 0
      installMocks(() => {
        call += 1
        return (call === 2 ? manual.promise : jsonResponse(RUNNING_RUN)) as unknown as Response
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      const refresh = host.querySelector('[data-testid="refresh-run-detail"]') as HTMLButtonElement
      refresh.click()
      await flushUi()
      expect(refresh.disabled).toBe(true)
      expect(host.querySelector('[data-testid="run-detail-loading"]')).not.toBeNull()
      // The background tick is issued while the manual read is pending, and answers first.
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(3)
      manual.resolve(jsonResponse(RUNNING_RUN))
      await flushUi()
      expect(refresh.disabled, 'a completed manual refresh must release its loading state').toBe(false)
      expect(host.querySelector('[data-testid="run-detail-loading"]')).toBeNull()
      // Polling is still alive afterwards (the fix must not have stopped the background loop).
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(detailCalls).toHaveLength(4)
    })
  })

  // --- f-prov200: per-run provenance truncation disclosure + 加载更多 -------------------------
  // The route answers ONE page (server default 200 events) plus `total` / `truncated` /
  // `nextCursor`. These cases drive the real view against a paged fake and pin: no notice at
  // 199/200, a notice + 加载更多 at 201, the cursor actually sent on 加载更多, fail-closed handling
  // of an answer that does not state completeness, and that a late page never lands in a
  // different dialog.
  describe('f-prov200 provenance truncation disclosure', () => {
    function provenanceEvent(eventIndex: number) {
      return {
        runId: RUN_ID, pipelineId: PIPELINE_ID, rowId: `ROW-${eventIndex}`,
        eventType: 'row_cleaned', at: '2026-09-19T02:00:00.500Z', attrs: {},
        eventIndex, runStatus: 'partial', runMode: 'dry-run', runCreatedAt: '2026-09-19T02:00:00.000Z',
      }
    }

    // A paged fake of GET /api/integration/runs/:runId/provenance that DISPATCHES ON THE QUERY:
    // `cursor` and `limit` are parsed out of the URL the client actually sent and decide the
    // slice answered, mirroring the plugin registry (keyset strictly after `cursor`, server
    // default page 200, `truncated` iff an event exists past the page). A client that drops or
    // reuses a stale cursor is answered the wrong slice — visibly — instead of a canned page.
    function pagedProvenance(totalEvents: number) {
      const events = Array.from({ length: totalEvents }, (_, i) => provenanceEvent(i + 1))
      const requests: URLSearchParams[] = []
      function answer(url: string): Response {
        const [path, query = ''] = url.split('?')
        expect(path).toBe(PROVENANCE_PATH)
        const params = new URLSearchParams(query)
        requests.push(params)
        for (const key of params.keys()) {
          expect(['tenantId', 'workspaceId', 'limit', 'cursor']).toContain(key)
        }
        expect(params.get('tenantId')).toBe('default')
        const limit = params.has('limit') ? Number(params.get('limit')) : 200
        const cursor = params.has('cursor') ? Number(params.get('cursor')) : 0
        const after = events.filter((event) => event.eventIndex > cursor)
        const items = after.slice(0, limit)
        const truncated = after.length > limit
        return jsonResponse({
          items,
          total: events.length,
          truncated,
          nextCursor: truncated ? String(items[items.length - 1].eventIndex) : null,
        })
      }
      return { answer, requests }
    }

    function hasCursor(url: string): boolean {
      return new URLSearchParams(url.split('?')[1] ?? '').has('cursor')
    }

    function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
      let resolve!: (value: Response) => void
      const promise = new Promise<Response>((r) => { resolve = r })
      return { promise, resolve }
    }

    function renderedIndexes(host: HTMLDivElement): number[] {
      // The entry head renders `<strong>type</strong><span>#N</span><span>at</span>`; read the
      // `#N` span on its own (the concatenated textContent runs N into the timestamp).
      return Array.from(host.querySelectorAll('[data-testid^="run-provenance-entry-"]')).map((el) => {
        const ordinal = el.querySelector('.integration-workbench__provenance-event-head span')
        const match = /^#(\d+)$/.exec((ordinal?.textContent ?? '').trim())
        return match ? Number(match[1]) : Number.NaN
      })
    }

    function range(from: number, to: number): number[] {
      return Array.from({ length: to - from + 1 }, (_, i) => from + i)
    }

    function notice(host: HTMLDivElement): HTMLElement | null {
      return host.querySelector('[data-testid="run-provenance-truncated"]')
    }

    function loadMoreButton(host: HTMLDivElement): HTMLButtonElement | null {
      return host.querySelector('[data-testid="run-provenance-load-more"]')
    }

    async function clickLoadMore(host: HTMLDivElement): Promise<void> {
      const button = loadMoreButton(host)
      expect(button).not.toBeNull()
      button!.click()
      await flushUi()
    }

    it.each([199, 200])('%i events (not more than one page): all rendered, NO truncation notice, no 加载更多', async (size) => {
      const fake = pagedProvenance(size)
      installMocks(() => jsonResponse(DETAIL_RUN), fake.answer)
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      expect(renderedIndexes(host)).toEqual(range(1, size))
      expect(notice(host)).toBeNull()
      expect(loadMoreButton(host)).toBeNull()
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0].has('cursor')).toBe(false)
    })

    it.each([
      ['en' as const, 'showing 200 of 201'],
      ['zh-CN' as const, '已显示 200 条，共 201 条'],
    ])('201 events: discloses 200 of 201, and 加载更多 sends the cursor and completes the timeline (%s)', async (locale, copy) => {
      setLocale(locale)
      const fake = pagedProvenance(201)
      installMocks(() => jsonResponse(DETAIL_RUN), fake.answer)
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(notice(host)).not.toBeNull()
      expect(notice(host)!.textContent).toContain(copy)
      expect(notice(host)!.getAttribute('role')).toBe('status')
      expect(fake.requests).toHaveLength(1)

      await clickLoadMore(host)
      expect(fake.requests).toHaveLength(2)
      expect(fake.requests[1].get('cursor')).toBe('200')
      // Same scope on the follow-up page: the cursor never replaces or widens it.
      expect(fake.requests[1].get('tenantId')).toBe('default')
      expect(renderedIndexes(host)).toEqual(range(1, 201))
      // Complete now: the notice and the button are gone.
      expect(notice(host)).toBeNull()
      expect(loadMoreButton(host)).toBeNull()
    })

    it('450 events: each 加载更多 sends the LATEST page cursor (200, then 400) and no event repeats', async () => {
      const fake = pagedProvenance(450)
      installMocks(() => jsonResponse(DETAIL_RUN), fake.answer)
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      expect(notice(host)!.textContent).toContain('showing 200 of 450')
      await clickLoadMore(host)
      expect(fake.requests[1].get('cursor')).toBe('200')
      expect(renderedIndexes(host)).toEqual(range(1, 400))
      expect(notice(host)!.textContent).toContain('showing 400 of 450')
      await clickLoadMore(host)
      expect(fake.requests[2].get('cursor')).toBe('400')
      expect(renderedIndexes(host)).toEqual(range(1, 450))
      expect(notice(host)).toBeNull()
      expect(fake.requests).toHaveLength(3)
    })

    it.each([
      ['an answer with no disclosure fields at all', { items: PROVENANCE_ITEMS }, 'may be incomplete', 2],
      ['truncated:false with a total above what was returned', { items: PROVENANCE_ITEMS, total: 5, truncated: false, nextCursor: null }, 'showing 2 of 5', 2],
      ['an empty page whose total says events exist', { items: [], total: 3, truncated: false, nextCursor: null }, 'showing 0 of 3', 0],
    ])('fail-closed: %s is NOT rendered as a complete timeline', async (_label, body, copy, shown) => {
      installMocks(() => jsonResponse(DETAIL_RUN), () => jsonResponse(body))
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      expect(host.querySelectorAll('[data-testid^="run-provenance-entry-"]')).toHaveLength(shown)
      expect(notice(host)).not.toBeNull()
      expect(notice(host)!.textContent).toContain(copy)
      // No cursor was handed out, so there is nothing to page to — but the notice still stands.
      expect(loadMoreButton(host)).toBeNull()
      // ...and "no events" is never claimed while the page says events exist / may exist.
      expect(host.querySelector('[data-testid="run-provenance-empty"]')).toBeNull()
    })

    it('a failed 加载更多 keeps the loaded events, the notice and the button; a retry resumes from the same cursor', async () => {
      const fake = pagedProvenance(201)
      let failCursorOnce = true
      installMocks(() => jsonResponse(DETAIL_RUN), (url) => {
        if (hasCursor(url) && failCursorOnce) {
          failCursorOnce = false
          return errorResponse(500, 'INTERNAL_ERROR', 'provenance page failed')
        }
        return fake.answer(url)
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      await clickLoadMore(host)
      expect(host.querySelector('[data-testid="run-provenance-load-more-error"]')).not.toBeNull()
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(notice(host)!.textContent).toContain('showing 200 of 201')
      expect(loadMoreButton(host)!.disabled).toBe(false)

      await clickLoadMore(host)
      const cursorRequests = provenanceCalls.filter((call) => hasCursor(call.url))
      expect(cursorRequests).toHaveLength(2)
      expect(new URLSearchParams(cursorRequests[1].url.split('?')[1]).get('cursor')).toBe('200')
      expect(renderedIndexes(host)).toEqual(range(1, 201))
      expect(notice(host)).toBeNull()
      expect(host.querySelector('[data-testid="run-provenance-load-more-error"]')).toBeNull()
    })

    it('a 加载更多 answer that lands after the dialog was closed and re-opened is discarded, not appended', async () => {
      const fake = pagedProvenance(201)
      const held = deferredResponse()
      let heldUrl = ''
      installMocks(() => jsonResponse(DETAIL_RUN), (url) => {
        if (hasCursor(url) && !heldUrl) {
          heldUrl = url
          return held.promise
        }
        return fake.answer(url)
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      await clickLoadMore(host)
      expect(heldUrl).not.toBe('')
      expect(loadMoreButton(host)!.disabled).toBe(true)
      ;(host.querySelector('[data-testid="close-run-detail"]') as HTMLButtonElement).click()
      await flushUi()
      await openDetail(host)
      await expandProvenance(host)
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      // The earlier dialog's next page lands now — it must not extend this dialog's timeline.
      held.resolve(fake.answer(heldUrl))
      await flushUi()
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(notice(host)!.textContent).toContain('showing 200 of 201')
      expect(loadMoreButton(host)!.disabled).toBe(false)
    })

    it('a next page that overlaps what is already shown never duplicates an event', async () => {
      const fake = pagedProvenance(201)
      installMocks(() => jsonResponse(DETAIL_RUN), (url) => {
        if (!hasCursor(url)) return fake.answer(url)
        // A misbehaving server re-sends #150..#201 for cursor=200.
        return jsonResponse({
          items: range(150, 201).map(provenanceEvent),
          total: 201,
          truncated: false,
          nextCursor: null,
        })
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      await clickLoadMore(host)
      expect(renderedIndexes(host)).toEqual(range(1, 201))
      expect(notice(host)).toBeNull()
    })

    it('a manual 刷新 while 加载更多 is in flight re-reads page one, releases the button, and fences the late page out', async () => {
      const fake = pagedProvenance(201)
      const held = deferredResponse()
      let heldUrl = ''
      installMocks(() => jsonResponse(DETAIL_RUN), (url) => {
        if (hasCursor(url) && !heldUrl) {
          heldUrl = url
          return held.promise
        }
        return fake.answer(url)
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      await clickLoadMore(host)
      expect(loadMoreButton(host)!.disabled).toBe(true)
      ;(host.querySelector('[data-testid="refresh-run-detail"]') as HTMLButtonElement).click()
      await flushUi()
      // The refresh replaced the timeline with its first page: the orphaned 加载更多 must not keep
      // the button stuck in "loading" waiting for an answer that can no longer apply.
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(loadMoreButton(host)!.disabled).toBe(false)
      held.resolve(fake.answer(heldUrl))
      await flushUi()
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(notice(host)!.textContent).toContain('showing 200 of 201')
    })

    // --- f-prov200 review round 1: a 加载更多 issued DURING a replacing re-read ------------------
    // The case above issues 加载更多 BEFORE the re-read starts, so the request token alone fences
    // it. Here the polling re-read starts first (bumping the token), and only THEN does the
    // operator click 加载更多 on the 1..400 timeline still on screen: the click captures the NEW
    // token and sends cursor=400. The token cannot tell that answer apart, so the page must be
    // fenced against the timeline it was issued for — appending #401.. after the re-read's #1..#200
    // would silently drop #201..#400 from the middle and take the button away (nextCursor null).
    function pollingRaceMocks(fake: ReturnType<typeof pagedProvenance>, cursorAnswer?: () => Response) {
      const state = {
        holdFirstPage: false,
        holdCursorPage: false,
        heldFirst: deferredResponse(),
        heldFirstUrl: '',
        heldMore: deferredResponse(),
        heldMoreUrl: '',
      }
      installMocks(() => jsonResponse({ ...DETAIL_RUN, status: 'running', finishedAt: null }), (url) => {
        if (state.holdFirstPage && !hasCursor(url)) {
          state.holdFirstPage = false
          state.heldFirstUrl = url
          return state.heldFirst.promise
        }
        if (state.holdCursorPage && hasCursor(url)) {
          state.holdCursorPage = false
          state.heldMoreUrl = url
          return state.heldMore.promise
        }
        return fake.answer(url)
      })
      return {
        state,
        releaseFirst: () => state.heldFirst.resolve(fake.answer(state.heldFirstUrl)),
        releaseMore: () => state.heldMore.resolve(cursorAnswer ? cursorAnswer() : fake.answer(state.heldMoreUrl)),
      }
    }

    // Drives: 1..400 shown → polling re-read held → 加载更多 (cursor 400) held → re-read lands.
    async function clickLoadMoreDuringPollingReread(
      race: ReturnType<typeof pollingRaceMocks>,
    ): Promise<HTMLDivElement> {
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      await clickLoadMore(host)
      expect(renderedIndexes(host)).toEqual(range(1, 400))
      race.state.holdFirstPage = true
      await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
      await flushUi()
      expect(race.state.heldFirstUrl).not.toBe('')
      // The re-read is in flight, the 1..400 timeline and its cursor are still on screen, and the
      // button is live — this is the click the token alone cannot fence.
      expect(loadMoreButton(host)!.disabled).toBe(false)
      race.state.holdCursorPage = true
      await clickLoadMore(host)
      expect(race.state.heldMoreUrl).not.toBe('')
      expect(new URLSearchParams(race.state.heldMoreUrl.split('?')[1]).get('cursor')).toBe('400')
      race.releaseFirst()
      await flushUi()
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      return host
    }

    it('a 加载更多 clicked while a polling re-read is in flight, landing AFTER the re-read replaced the timeline, is discarded (no silent gap)', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        const fake = pagedProvenance(450)
        const race = pollingRaceMocks(fake)
        const host = await clickLoadMoreDuringPollingReread(race)
        // The cursor-400 page lands last: it extends a timeline that is no longer on screen.
        race.releaseMore()
        await flushUi()
        const shown = renderedIndexes(host)
        expect(shown).toEqual(range(1, 200))
        expect(notice(host)!.textContent).toContain('showing 200 of 450')
        // The button survives (the late page did not clear nextCursor) and is not stuck loading...
        expect(loadMoreButton(host)!.disabled).toBe(false)
        expect(host.querySelector('[data-testid="run-provenance-load-more-error"]')).toBeNull()
        // ...and paging resumes from the NEW timeline's own cursor, contiguously.
        await clickLoadMore(host)
        expect(fake.requests[fake.requests.length - 1].get('cursor')).toBe('200')
        expect(renderedIndexes(host)).toEqual(range(1, 400))
      } finally {
        vi.useRealTimers()
      }
    })

    it('a 加载更多 clicked during a polling re-read that FAILS after the re-read landed does not flag the new timeline', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        const fake = pagedProvenance(450)
        const race = pollingRaceMocks(fake, () => errorResponse(500, 'INTERNAL_ERROR', 'provenance page failed'))
        const host = await clickLoadMoreDuringPollingReread(race)
        race.releaseMore()
        await flushUi()
        // The failure belongs to a page of the replaced timeline; the one on screen never asked.
        expect(host.querySelector('[data-testid="run-provenance-load-more-error"]')).toBeNull()
        expect(renderedIndexes(host)).toEqual(range(1, 200))
        expect(notice(host)!.textContent).toContain('showing 200 of 450')
        expect(loadMoreButton(host)!.disabled).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    // --- f-prov200 review round 1: close + reopen, released while the section is COLLAPSED -------
    // The earlier close/reopen case re-expands BEFORE releasing the held page, and that expand
    // issues its own read (bumping the token), which would hide a reset that forgot to fence. Here
    // the late answer lands while the reopened dialog is still collapsed, so only the reset itself
    // stands between it and the new dialog — and a painted-in timeline would also make the next
    // expand skip its read (the section reuses what it holds).
    it('a held 加载更多 page released after close + reopen, before re-expanding, never reaches the reopened dialog', async () => {
      const fake = pagedProvenance(201)
      const held = deferredResponse()
      let heldUrl = ''
      installMocks(() => jsonResponse(DETAIL_RUN), (url) => {
        if (hasCursor(url) && !heldUrl) {
          heldUrl = url
          return held.promise
        }
        return fake.answer(url)
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      await clickLoadMore(host)
      expect(heldUrl).not.toBe('')
      ;(host.querySelector('[data-testid="close-run-detail"]') as HTMLButtonElement).click()
      await flushUi()
      await openDetail(host)
      held.resolve(fake.answer(heldUrl))
      await flushUi()
      await expandProvenance(host)
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(notice(host)!.textContent).toContain('showing 200 of 201')
      // The reopened dialog read its own first page rather than reusing anything painted in.
      expect(fake.requests.filter((params) => !params.has('cursor'))).toHaveLength(2)
    })

    it('a held FIRST-page read released after close + reopen, before re-expanding, never reaches the reopened dialog', async () => {
      // Two distinguishable answers: the earlier dialog's read is answered from a 201-event run,
      // everything after the reopen from a 450-event one.
      const earlier = pagedProvenance(201)
      const current = pagedProvenance(450)
      const held = deferredResponse()
      let heldUrl = ''
      installMocks(() => jsonResponse(DETAIL_RUN), (url) => {
        if (!heldUrl) {
          heldUrl = url
          return held.promise
        }
        return current.answer(url)
      })
      const host = await mountAndListRuns()
      await openDetail(host)
      await expandProvenance(host)
      expect(heldUrl).not.toBe('')
      ;(host.querySelector('[data-testid="close-run-detail"]') as HTMLButtonElement).click()
      await flushUi()
      await openDetail(host)
      held.resolve(earlier.answer(heldUrl))
      await flushUi()
      await expandProvenance(host)
      expect(current.requests).toHaveLength(1)
      expect(renderedIndexes(host)).toEqual(range(1, 200))
      expect(notice(host)!.textContent).toContain('showing 200 of 450')
    })

    it('a polling re-read replaces the entries AND their disclosure together (0 events while running, 201 once terminal)', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        const finished = pagedProvenance(201)
        let detailCall = 0
        let terminal = false
        installMocks(
          () => {
            detailCall += 1
            terminal = detailCall >= 2
            return jsonResponse(terminal ? DETAIL_RUN : { ...DETAIL_RUN, status: 'running', finishedAt: null })
          },
          (url) => (terminal
            ? finished.answer(url)
            : jsonResponse({ items: [], total: 0, truncated: false, nextCursor: null })),
        )
        const host = await mountAndListRuns()
        await openDetail(host)
        await expandProvenance(host)
        // While running the persisted timeline is still empty — and complete: no notice.
        expect(host.querySelector('[data-testid="run-provenance-empty"]')).not.toBeNull()
        expect(notice(host)).toBeNull()
        await vi.advanceTimersByTimeAsync(RUN_DETAIL_POLL_MS)
        await flushUi()
        expect(detailCalls).toHaveLength(2)
        expect(renderedIndexes(host)).toEqual(range(1, 200))
        expect(notice(host)!.textContent).toContain('showing 200 of 201')
        expect(loadMoreButton(host)).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
