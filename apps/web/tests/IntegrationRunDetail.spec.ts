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
  function installMocks(
    answerDetail: () => Response,
    answerProvenance: () => Response = () => jsonResponse({ items: PROVENANCE_ITEMS }),
  ): void {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === LIST_URL) return jsonResponse([LIST_RUN])
      if (url === DEAD_LETTERS_URL) return jsonResponse([])
      if (url === PROVENANCE_URL) {
        provenanceCalls.push({ url, init })
        return answerProvenance()
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
  })
})
