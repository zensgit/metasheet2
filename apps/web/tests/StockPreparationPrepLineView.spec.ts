import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Frontend MVP view 5: STOCK PREPARATION LINES. This spec mocks ONLY apiFetch and drives the REAL
// service module (prepLine.ts + confirmApi.ts) through the view, so it pins BOTH directions of the
// wire contract (mock-is-not-the-contract):
//   - requests: exact URL paths, exact query key sets, the exact generation-run POST body key set —
//     and that resolvedBy / resolvedAt / confirmedBy / confirmedAt NEVER appear in any body;
//   - responses: the view renders only the values-free projection — planted business values
//     (drawing numbers / quantities / unit symbols / ERP codes) never reach the DOM, and error
//     surfaces render the clamped code / field NAME, never the raw error body.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return {
    ...actual,
    apiFetch: h.apiFetch,
  }
})

import StockPreparationPrepLineView from '../src/components/integration/stockPreparation/StockPreparationPrepLineView.vue'

// Planted business values — the view must render NONE of them (fixed-whitelist rendering).
const PLANTED_DRAWING_NO = 'DWG-77291-C'
const PLANTED_ERP_CODE = 'MAT-QX5522'
const PLANTED_QTY = '1234.567'
const PLANTED_UNIT = '千克kg'
const PLANTED_RAW_ERROR = 'connectionString=host=erp;pwd=secret-91007;drawing=DWG-LEAK-5'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_ERP_CODE, PLANTED_QTY, PLANTED_UNIT, 'secret-91007', 'DWG-LEAK-5']

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function fail(status: number, code: string, field?: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message: PLANTED_RAW_ERROR, details: field ? { field } : {} },
    }),
    { status },
  )
}

function prepLinesData(): Record<string, unknown> {
  return {
    rowCount: 2,
    byPrepStatus: { draft: 1, held: 1 },
    byMappingStatus: { matched: 1, pending_confirm: 0, multi_candidate: 0, not_found: 1, version_conflict: 0 },
    byUnitStatus: { converted: 1, missing_rule: 1, conflict: 0 },
    rows: [
      {
        stockPrepLineId: 'line-handle-alpha',
        snapshotBatchId: 'batch-handle-alpha',
        snapshotLineId: 'snap-line-alpha',
        prepStatus: 'draft',
        mappingStatus: 'matched',
        unitStatus: 'converted',
        exceptionCount: 0,
        hasIssueQty: true,
        hasErpTarget: true,
        createdFromRunId: 'run-handle-alpha',
        // Planted business values (NOT part of the wire shape) — must never reach the DOM.
        plmDrawingNo: PLANTED_DRAWING_NO,
        erpMaterialCode: PLANTED_ERP_CODE,
        issueQtyFinal: PLANTED_QTY,
        issueUnit: PLANTED_UNIT,
      },
      {
        stockPrepLineId: 'line-handle-beta',
        prepStatus: 'held',
        mappingStatus: 'not_found',
        unitStatus: 'missing_rule',
        exceptionCount: 2,
        hasIssueQty: false,
        hasErpTarget: false,
      },
    ],
  }
}

function generationRunData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    persisted: true,
    mode: 'created',
    snapshotBatchId: 'batch-handle-alpha',
    runId: 'run-handle-alpha',
    status: 'ready',
    ready: true,
    unresolvedBlockingExceptionCount: 0,
    created: { lines: 3, exceptions: 0, run: 1 },
    patched: { lines: 1, run: 0 },
    skipped: { exceptions: 0 },
    evidence: { valuesFree: true },
    ...overrides,
  }
}

interface MockOverrides {
  run?: () => Response
}

function mockRoutes(overrides: MockOverrides = {}): void {
  h.apiFetch.mockImplementation(async (url: string) => {
    if (url.includes('/generation/run')) {
      return overrides.run ? overrides.run() : ok(generationRunData(), 201)
    }
    if (url.includes('/prep-lines')) return ok(prepLinesData())
    return ok({})
  })
}

// Bounded polling wait (#4017 idiom): real Response.json() can take macrotask turns, so
// microtask-only flushes are timing-fragile on slower CI runners. Throws on timeout.
async function waitForSelector(container: HTMLElement, selector: string, cycles = 40): Promise<Element> {
  for (let i = 0; i < cycles; i += 1) {
    const el = container.querySelector(selector)
    if (el) return el
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`Timed out waiting for selector: ${selector}`)
}

async function waitForCondition(check: () => boolean, cycles = 40): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error('Timed out waiting for condition')
}

function urlsMatching(fragment: string): string[] {
  return h.apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => url.includes(fragment))
}

function postCalls(fragment: string): Array<{ url: string; body: Record<string, unknown> }> {
  return h.apiFetch.mock.calls
    .filter((call) => String(call[0]).includes(fragment) && (call[1] as { method?: string } | undefined)?.method === 'POST')
    .map((call) => ({ url: String(call[0]), body: JSON.parse(String((call[1] as { body?: string }).body)) as Record<string, unknown> }))
}

function queryKeys(url: string): { path: string; params: URLSearchParams } {
  const [path, query = ''] = url.split('?')
  return { path, params: new URLSearchParams(query) }
}

function setSelect(root: HTMLElement, testid: string, value: string): void {
  const select = root.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('StockPreparationPrepLineView (view 5: values-free prep lines + generation run)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.apiFetch.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  function mountView(props: Record<string, unknown> = { projectId: 'proj-alpha' }): HTMLDivElement {
    app = createApp(StockPreparationPrepLineView as Component, props)
    app.mount(container!)
    return container!
  }

  it('shows the select-a-project state and issues NO request when no projectId is provided', async () => {
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-line-no-project"]')).not.toBeNull()
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it('loads the list via the exact readonly GET and renders the values-free projection', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')

    // Direction pin (request): exact path, exact query key set, and NO write options on the GET.
    const listUrls = urlsMatching('/prep-lines')
    expect(listUrls.length).toBe(1)
    const parts = queryKeys(listUrls[0])
    expect(parts.path).toBe('/api/integration/stock-preparation/prep-lines')
    expect([...parts.params.keys()].sort()).toEqual(['projectId'])
    expect(parts.params.get('projectId')).toBe('proj-alpha')
    for (const call of h.apiFetch.mock.calls) {
      expect((call[1] as { method?: string } | undefined)?.method).toBeUndefined()
    }

    // Header cards: total + the three status count groups (zero-filled closed vocabularies).
    const metrics = root.querySelectorAll('[data-testid="stock-prep-line-metric"]')
    expect(metrics.length).toBe(4)
    expect(root.querySelector('[data-testid="stock-prep-line-metric"][data-kind="total"]')?.textContent).toContain('2')
    expect(root.querySelectorAll('[data-testid="stock-prep-line-prep-status-count"]').length).toBe(2)
    expect(root.querySelectorAll('[data-testid="stock-prep-line-mapping-status-count"]').length).toBe(5)
    expect(root.querySelectorAll('[data-testid="stock-prep-line-unit-status-count"]').length).toBe(3)

    // Rows render handle/enum/count/boolean whitelist only.
    const rows = root.querySelectorAll('[data-testid="stock-prep-line-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-handle"]')?.textContent).toBe('line-handle-alpha')
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-prep-status"]')?.textContent?.trim()).toBe('draft')
    expect(rows[1].querySelector('[data-testid="stock-prep-line-row-prep-status"]')?.textContent?.trim()).toBe('held')
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-mapping-status"]')?.textContent?.trim()).toBe('matched')
    expect(rows[1].querySelector('[data-testid="stock-prep-line-row-unit-status"]')?.textContent?.trim()).toBe('missing_rule')
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-exceptions"]')?.textContent).toContain('0')
    expect(rows[1].querySelector('[data-testid="stock-prep-line-row-exceptions"]')?.textContent).toContain('2')
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-issue-qty"]')?.getAttribute('data-flag')).toBe('true')
    expect(rows[1].querySelector('[data-testid="stock-prep-line-row-issue-qty"]')?.getAttribute('data-flag')).toBe('false')
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-erp-target"]')?.getAttribute('data-flag')).toBe('true')
    expect(rows[1].querySelector('[data-testid="stock-prep-line-row-erp-target"]')?.getAttribute('data-flag')).toBe('false')
    expect(rows[0].querySelector('[data-testid="stock-prep-line-row-run"]')?.textContent).toBe('run-handle-alpha')
    expect(rows[1].querySelector('[data-testid="stock-prep-line-row-run"]')?.textContent).toBe('—')

    // Values-free guard: no planted drawing number / ERP code / quantity / unit reaches the DOM.
    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('re-reads the list with the exact prepStatus filter key set when the filter changes', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')

    setSelect(root, 'stock-prep-line-filter', 'held')
    await waitForCondition(() => urlsMatching('/prep-lines').length === 2)

    const parts = queryKeys(urlsMatching('/prep-lines')[1])
    expect([...parts.params.keys()].sort()).toEqual(['prepStatus', 'projectId'])
    expect(parts.params.get('prepStatus')).toBe('held')
  })

  it('runs generation with the EXACT body key set, renders the verdict, and refreshes the list', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')
    ;(root.querySelector('[data-testid="stock-prep-line-generate"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-line-generate-result"]')

    const posts = postCalls('/generation/run')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/generation/run')
    // Closed body: scope only (no batch picker in this view) — server-stamped fields NEVER cross.
    expect(Object.keys(posts[0].body).sort()).toEqual(['projectId'])
    expect(posts[0].body.projectId).toBe('proj-alpha')
    const rawBody = JSON.stringify(posts[0].body)
    for (const stamp of ['resolvedBy', 'resolvedAt', 'confirmedBy', 'confirmedAt']) {
      expect(rawBody).not.toContain(stamp)
    }

    // Values-free verdict note: status/ready/blocking count + created/patched counts.
    const note = root.querySelector('[data-testid="stock-prep-line-generate-result"]') as HTMLElement
    expect(note.textContent).toContain('ready')
    expect(note.textContent).toContain('0')
    expect(note.textContent).toContain('3')
    // ready:true → NO blocked hint.
    expect(root.querySelector('[data-testid="stock-prep-line-generate-blocked"]')).toBeNull()

    // Run → the list read is re-issued (refresh-after-write).
    await waitForCondition(() => urlsMatching('/prep-lines').length === 2)
  })

  it('shows the go-to-view-6 hint when the run returns ready:false (blocking exceptions remain)', async () => {
    mockRoutes({
      run: () => ok(generationRunData({
        status: 'partial',
        ready: false,
        unresolvedBlockingExceptionCount: 4,
        created: { lines: 1, exceptions: 4, run: 1 },
      }), 201),
    })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')
    ;(root.querySelector('[data-testid="stock-prep-line-generate"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-line-generate-blocked"]')

    const result = root.querySelector('[data-testid="stock-prep-line-generate-result"]') as HTMLElement
    expect(result.textContent).toContain('partial')
    expect(result.textContent).toContain('4')
    const hint = root.querySelector('[data-testid="stock-prep-line-generate-blocked"]') as HTMLElement
    expect(hint.textContent).toContain('异常队列')
  })

  it('mirrors the SERVER ready field, never a local recompute from status (asymmetric fixture)', async () => {
    // P3-1 (#4030 review): status says 'ready' but the server invariant verdict is ready:false
    // (e.g. pre-existing unresolved blocking exceptions counted AFTER persistence). A UI that
    // recomputed ready from status === 'ready' would render 是/yes and hide the blocked hint —
    // both surfaces MUST follow the server's ready field alone.
    mockRoutes({
      run: () => ok(generationRunData({
        status: 'ready',
        ready: false,
        unresolvedBlockingExceptionCount: 2,
        created: { lines: 0, exceptions: 0, run: 0 },
        patched: { lines: 0, run: 0 },
      }), 200),
    })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')
    ;(root.querySelector('[data-testid="stock-prep-line-generate"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-line-generate-blocked"]')

    const result = root.querySelector('[data-testid="stock-prep-line-generate-result"]') as HTMLElement
    // The status enum still renders as-is…
    expect(result.textContent).toContain('ready')
    // …but ready=false renders 否 and the server's unresolved blocking count (the only 2 — all
    // created/patched counts are zeroed in this fixture).
    expect(result.textContent).toContain('否')
    expect(result.textContent).toContain('2')
    expect(root.querySelector('[data-testid="stock-prep-line-generate-blocked"]')).not.toBeNull()
  })

  it('renders a values-free action error (clamped code, never the raw body) on a failed run', async () => {
    mockRoutes({ run: () => fail(422, 'GENERATION_BATCH_NOT_FOUND') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-overview"]')
    ;(root.querySelector('[data-testid="stock-prep-line-generate"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-line-action-error"]')

    const text = root.textContent || ''
    expect(text).toContain('GENERATION_BATCH_NOT_FOUND')
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders a neutral error state when the read rejects (404-soft), never the raw body', async () => {
    h.apiFetch.mockImplementation(async () => fail(404, 'NOT_FOUND'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-line-error"]')
    expect(root.querySelector('[data-testid="stock-prep-line-overview"]')).toBeNull()
    expect(root.textContent || '').not.toContain('secret-91007')
  })

  it('renders the English copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-line-no-project"]')?.textContent).toMatch(/select a project/i)
  })
})
