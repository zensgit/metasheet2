import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Frontend MVP view 6: EXCEPTION CONFIRMATION QUEUE. This spec mocks ONLY apiFetch and drives the
// REAL service module (exceptionQueue.ts + confirmApi.ts) through the view, so it pins BOTH
// directions of the wire contract (mock-is-not-the-contract):
//   - requests: exact URL paths, exact query key sets, exact POST body key sets — and above all
//     that resolvedBy / resolvedAt NEVER appear anywhere in a request body (server-stamped);
//   - responses: the view renders only the values-free projection — the planted exception message
//     and business values never reach the DOM, and error surfaces render the clamped code / field
//     NAME, never the raw error body.
// It also pins the FE MIRROR of the server's same-reason bulk gate (#3890): mixed exceptionTypes
// disable the bulk entry BEFORE any request — while the server's 409 EXCEPTION_BULK_MIXED_TYPES
// stays the authoritative gate and lands in the values-free error surface.

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

import StockPreparationExceptionQueueView from '../src/components/integration/stockPreparation/StockPreparationExceptionQueueView.vue'

// Planted business values — the view must render NONE of them (fixed-whitelist rendering).
const PLANTED_MESSAGE = '图号 DWG-33107-B 无法映射到 ERP 物料 MAT-KX7733'
const PLANTED_DRAWING_NO = 'DWG-33107-B'
const PLANTED_ERP_CODE = 'MAT-KX7733'
const PLANTED_RESOLVER = 'ops-admin@example.com'
const PLANTED_RAW_ERROR = 'connectionString=host=erp;pwd=secret-63007;drawing=DWG-LEAK-6'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_ERP_CODE, PLANTED_RESOLVER, 'secret-63007', 'DWG-LEAK-6']

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

function exceptionsData(): Record<string, unknown> {
  return {
    rowCount: 4,
    unresolvedBlockingCount: 2,
    byType: {
      missing_mapping: 2,
      multi_candidate: 0,
      version_conflict: 0,
      erp_item_missing: 0,
      unit_missing: 1,
      unit_conflict: 0,
      invalid_qty: 0,
      missing_child_bom: 1,
    },
    byStatus: { open: 3, resolved: 1, ignored: 0, deferred: 0 },
    bySeverity: { info: 0, warning: 1, blocking: 3 },
    rows: [
      {
        exceptionId: 'exc-handle-alpha',
        snapshotBatchId: 'batch-handle-alpha',
        snapshotLineId: 'snap-line-alpha',
        stockPrepLineId: 'line-handle-alpha',
        exceptionType: 'missing_mapping',
        severity: 'blocking',
        status: 'open',
        resolved: false,
        resolvedByPresent: false,
        // Planted business values (NOT part of the wire shape) — must never reach the DOM.
        message: PLANTED_MESSAGE,
        resolvedBy: PLANTED_RESOLVER,
      },
      {
        exceptionId: 'exc-handle-beta',
        exceptionType: 'missing_mapping',
        severity: 'blocking',
        status: 'open',
        resolved: false,
        resolvedByPresent: false,
      },
      {
        exceptionId: 'exc-handle-gamma',
        exceptionType: 'unit_missing',
        severity: 'warning',
        status: 'open',
        resolved: false,
        resolvedByPresent: false,
      },
      {
        exceptionId: 'exc-handle-delta',
        exceptionType: 'missing_child_bom',
        severity: 'blocking',
        status: 'resolved',
        resolutionAction: 'accepted_change',
        resolved: true,
        resolvedByPresent: true,
      },
    ],
  }
}

interface MockOverrides {
  resolve?: () => Response
  bulk?: () => Response
}

function mockRoutes(overrides: MockOverrides = {}): void {
  h.apiFetch.mockImplementation(async (url: string) => {
    // Order matters: the resolve fragments must be matched BEFORE the bare /exceptions list.
    if (url.includes('/exceptions/bulk-resolve')) {
      return overrides.bulk
        ? overrides.bulk()
        : ok({
            persisted: true,
            mode: 'resolved',
            resolved: 2,
            skipped: 0,
            exceptionType: 'missing_mapping',
            evidence: { subject: 'exception', mode: 'resolved', target: { objectId: 'obj', keyField: 'exceptionId' }, resolved: 2, skipped: 0, valuesFree: true },
          })
    }
    if (url.includes('/exceptions/resolve')) {
      return overrides.resolve
        ? overrides.resolve()
        : ok({
            persisted: true,
            mode: 'resolved',
            exceptionId: 'exc-handle-alpha',
            evidence: { subject: 'exception', mode: 'resolved', target: { objectId: 'obj', keyField: 'exceptionId' }, valuesFree: true },
          })
    }
    if (url.includes('/exceptions')) return ok(exceptionsData())
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

function listUrls(): string[] {
  // The bare list read only — resolve POST urls also contain '/exceptions'.
  return h.apiFetch.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.split('?')[0] === '/api/integration/stock-preparation/exceptions')
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

function rowCheckboxes(root: HTMLElement): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('[data-testid="stock-prep-exception-row-select"]')) as HTMLInputElement[]
}

function clickCheckbox(box: HTMLInputElement): void {
  box.checked = !box.checked
  box.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('StockPreparationExceptionQueueView (view 6: queue reads + human resolution)', () => {
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
    app = createApp(StockPreparationExceptionQueueView as Component, props)
    app.mount(container!)
    return container!
  }

  it('shows the select-a-project state and issues NO request when no projectId is provided', async () => {
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-exception-no-project"]')).not.toBeNull()
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it('loads the queue via the exact readonly GET and renders the values-free projection', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    // Direction pin (request): exact path, exact query key set, and NO write options on the GET.
    const reads = listUrls()
    expect(reads.length).toBe(1)
    const parts = queryKeys(reads[0])
    expect(parts.path).toBe('/api/integration/stock-preparation/exceptions')
    expect([...parts.params.keys()].sort()).toEqual(['projectId'])
    expect(parts.params.get('projectId')).toBe('proj-alpha')
    for (const call of h.apiFetch.mock.calls) {
      expect((call[1] as { method?: string } | undefined)?.method).toBeUndefined()
    }

    // Header cards: the blocking gate count + total + byType/byStatus chip groups.
    expect(root.querySelector('[data-testid="stock-prep-exception-blocking-count"]')?.textContent).toBe('2')
    expect(root.querySelector('[data-testid="stock-prep-exception-metric"][data-kind="total"]')?.textContent).toContain('4')
    expect(root.querySelectorAll('[data-testid="stock-prep-exception-type-count"]').length).toBe(8)
    expect(root.querySelectorAll('[data-testid="stock-prep-exception-status-count"]').length).toBe(4)

    // Queue rows render enum/boolean/handle whitelist only; the RESOLVED row is read-only.
    const rows = root.querySelectorAll('[data-testid="stock-prep-exception-row"]')
    expect(rows.length).toBe(4)
    expect(rows[0].querySelector('[data-testid="stock-prep-exception-row-handle"]')?.textContent).toBe('exc-handle-alpha')
    expect(rows[0].querySelector('[data-testid="stock-prep-exception-row-type"]')?.textContent?.trim()).toBe('missing_mapping')
    expect(rows[0].querySelector('[data-testid="stock-prep-exception-row-severity"]')?.textContent?.trim()).toBe('blocking')
    expect(rows[0].querySelector('[data-testid="stock-prep-exception-row-status"]')?.textContent?.trim()).toBe('open')
    expect(rows[0].querySelector('[data-testid="stock-prep-exception-row-resolution"]')?.textContent?.trim()).toBe('—')
    expect(rows[3].querySelector('[data-testid="stock-prep-exception-row-resolution"]')?.textContent?.trim()).toBe('accepted_change')
    expect(rows[3].querySelector('[data-testid="stock-prep-exception-row-resolver"]')?.getAttribute('data-flag')).toBe('true')
    expect((rows[3].querySelector('[data-testid="stock-prep-exception-row-select"]') as HTMLInputElement).disabled).toBe(true)
    expect((rows[3].querySelector('[data-testid="stock-prep-exception-row-resolve"]') as HTMLButtonElement).disabled).toBe(true)

    // Values-free guard: the planted message / drawing number / ERP code / resolver identity never
    // reach the DOM (resolver surfaces ONLY as a presence flag).
    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('re-reads the queue with the exact status/exceptionType filter key sets', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    setSelect(root, 'stock-prep-exception-filter-status', 'open')
    await waitForCondition(() => listUrls().length === 2)
    let parts = queryKeys(listUrls()[1])
    expect([...parts.params.keys()].sort()).toEqual(['projectId', 'status'])
    expect(parts.params.get('status')).toBe('open')

    setSelect(root, 'stock-prep-exception-filter-type', 'missing_mapping')
    await waitForCondition(() => listUrls().length === 3)
    parts = queryKeys(listUrls()[2])
    expect([...parts.params.keys()].sort()).toEqual(['exceptionType', 'projectId', 'status'])
    expect(parts.params.get('exceptionType')).toBe('missing_mapping')
  })

  it('gates the row resolve on an explicit resolutionAction (required, no default), then posts the EXACT body and refreshes', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    // No action chosen → every resolve entry is disabled and no POST possible.
    const resolveAlpha = root.querySelector('[data-testid="stock-prep-exception-row-resolve"]') as HTMLButtonElement
    expect(resolveAlpha.disabled).toBe(true)
    resolveAlpha.click()
    await nextTick()
    expect(postCalls('/exceptions/resolve').length).toBe(0)

    setSelect(root, 'stock-prep-exception-action-select', 'mapping_confirmed')
    await waitForCondition(() => !(root.querySelector('[data-testid="stock-prep-exception-row-resolve"]') as HTMLButtonElement).disabled)
    ;(root.querySelector('[data-testid="stock-prep-exception-row-resolve"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-exception-action-notice"]')

    const posts = postCalls('/exceptions/resolve')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/exceptions/resolve')
    // Closed body: scope + exceptionId + resolutionAction — server-stamped fields NEVER cross.
    expect(Object.keys(posts[0].body).sort()).toEqual(['exceptionId', 'projectId', 'resolutionAction'])
    expect(posts[0].body.exceptionId).toBe('exc-handle-alpha')
    expect(posts[0].body.resolutionAction).toBe('mapping_confirmed')
    const rawBody = JSON.stringify(posts[0].body)
    expect(rawBody).not.toContain('resolvedBy')
    expect(rawBody).not.toContain('resolvedAt')

    // Resolve → the queue read is re-issued (refresh-after-write).
    await waitForCondition(() => listUrls().length === 2)
    expect(root.querySelector('[data-testid="stock-prep-exception-action-notice"]')?.textContent).toContain('resolved')
  })

  it('bulk-resolves a SAME-TYPE selection with the EXACT body key set and refreshes', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    setSelect(root, 'stock-prep-exception-action-select', 'mapping_confirmed')
    const boxes = rowCheckboxes(root)
    clickCheckbox(boxes[0]) // missing_mapping
    clickCheckbox(boxes[1]) // missing_mapping
    await waitForCondition(() => !(root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement).disabled)
    expect(root.querySelector('[data-testid="stock-prep-exception-mixed-hint"]')).toBeNull()
    ;(root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-exception-action-notice"]')

    const posts = postCalls('/exceptions/bulk-resolve')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/exceptions/bulk-resolve')
    expect(Object.keys(posts[0].body).sort()).toEqual(['exceptionIds', 'projectId', 'resolutionAction'])
    expect(posts[0].body.exceptionIds).toEqual(['exc-handle-alpha', 'exc-handle-beta'])
    expect(posts[0].body.resolutionAction).toBe('mapping_confirmed')
    const rawBody = JSON.stringify(posts[0].body)
    expect(rawBody).not.toContain('resolvedBy')
    expect(rawBody).not.toContain('resolvedAt')

    // Bulk resolve → queue refresh + values-free counts in the notice.
    await waitForCondition(() => listUrls().length === 2)
    const notice = root.querySelector('[data-testid="stock-prep-exception-action-notice"]') as HTMLElement
    expect(notice.textContent).toContain('resolved')
    expect(notice.textContent).toContain('2')
  })

  it('PRUNES the selection on reload: a selected row that comes back resolved leaves the set', async () => {
    // P3-2 (#4030 review): after a single resolve, the refreshed list returns the selected alpha row
    // as RESOLVED. The selection set must be pruned to the still-open rows only — a stale handle
    // lingering in the set would ride into the next bulk payload (and skew the bulk gate).
    let listReads = 0
    h.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/exceptions/resolve')) {
        return ok({
          persisted: true,
          mode: 'resolved',
          exceptionId: 'exc-handle-alpha',
          evidence: { subject: 'exception', mode: 'resolved', target: { objectId: 'obj', keyField: 'exceptionId' }, valuesFree: true },
        })
      }
      if (url.includes('/exceptions')) {
        listReads += 1
        if (listReads === 1) return ok(exceptionsData())
        // Reload: alpha is now resolved (server-stamped) — everything else unchanged.
        const data = exceptionsData() as { rows: Array<Record<string, unknown>> }
        data.rows[0] = {
          ...data.rows[0],
          status: 'resolved',
          resolutionAction: 'mapping_confirmed',
          resolved: true,
          resolvedByPresent: true,
        }
        return ok(data)
      }
      return ok({})
    })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    setSelect(root, 'stock-prep-exception-action-select', 'mapping_confirmed')
    const boxes = rowCheckboxes(root)
    clickCheckbox(boxes[0]) // alpha (missing_mapping)
    clickCheckbox(boxes[1]) // beta (missing_mapping)
    await waitForCondition(() =>
      (root.querySelector('[data-testid="stock-prep-exception-selected-count"]')?.textContent || '').includes('2'))

    // Single-resolve alpha → reload returns it resolved → the set keeps ONLY beta.
    ;(root.querySelector('[data-testid="stock-prep-exception-row-resolve"]') as HTMLButtonElement).click()
    await waitForCondition(() => listReads === 2)
    await waitForCondition(() =>
      (root.querySelector('[data-testid="stock-prep-exception-selected-count"]')?.textContent || '').includes('1'))

    const boxesAfter = rowCheckboxes(root)
    // Alpha row is read-only now: deselected AND disabled.
    expect(boxesAfter[0].checked).toBe(false)
    expect(boxesAfter[0].disabled).toBe(true)
    // Beta survives the prune, and the (same-type, action-chosen) bulk entry stays enabled for it.
    expect(boxesAfter[1].checked).toBe(true)
    expect((root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('MIRRORS the same-reason gate: a mixed-type selection disables bulk resolve and posts NOTHING', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    setSelect(root, 'stock-prep-exception-action-select', 'manual_hold')
    const boxes = rowCheckboxes(root)
    clickCheckbox(boxes[0]) // missing_mapping
    clickCheckbox(boxes[2]) // unit_missing → mixed
    await waitForSelector(root, '[data-testid="stock-prep-exception-mixed-hint"]')

    const bulkButton = root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement
    expect(bulkButton.disabled).toBe(true)
    bulkButton.click()
    await nextTick()
    expect(postCalls('/exceptions/bulk-resolve').length).toBe(0)

    // Deselecting the off-type row re-enables the entry (the mirror is per-selection, not sticky).
    clickCheckbox(rowCheckboxes(root)[2])
    await waitForCondition(() => !(root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement).disabled)
    expect(root.querySelector('[data-testid="stock-prep-exception-mixed-hint"]')).toBeNull()
  })

  it('renders the server 409 EXCEPTION_BULK_MIXED_TYPES as a values-free clamped code (server stays authoritative)', async () => {
    mockRoutes({ bulk: () => fail(409, 'EXCEPTION_BULK_MIXED_TYPES') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')

    setSelect(root, 'stock-prep-exception-action-select', 'mapping_confirmed')
    const boxes = rowCheckboxes(root)
    clickCheckbox(boxes[0])
    clickCheckbox(boxes[1])
    await waitForCondition(() => !(root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement).disabled)
    ;(root.querySelector('[data-testid="stock-prep-exception-bulk-resolve"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-exception-action-error"]')

    const text = root.textContent || ''
    expect(text).toContain('EXCEPTION_BULK_MIXED_TYPES')
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders a neutral error state when the read rejects (404-soft), never the raw body', async () => {
    h.apiFetch.mockImplementation(async () => fail(404, 'NOT_FOUND'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-error"]')
    expect(root.querySelector('[data-testid="stock-prep-exception-overview"]')).toBeNull()
    expect(root.textContent || '').not.toContain('secret-63007')
  })

  it('renders the English copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-exception-no-project"]')?.textContent).toMatch(/select a project/i)
  })

  // H4-3 (responsive + long-table usability): the error state offers a Retry that re-runs loadList()
  // and recovers — same idiom as the H4-1 dashboard retry.
  it('H4-3: the error state offers a Retry that re-runs loadList() and recovers', async () => {
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-exception-retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    expect(retry?.getAttribute('aria-label')).toBe('重试读取异常队列')

    mockRoutes() // the retry succeeds
    const callsBefore = h.apiFetch.mock.calls.length
    retry!.click()
    await waitForSelector(root, '[data-testid="stock-prep-exception-overview"]')
    expect(h.apiFetch.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(root.querySelector('[data-testid="stock-prep-exception-error"]')).toBeNull()
  })

  it('H4-3: the retry button is bilingual + carries an accessible name (aria-label)', async () => {
    h.locale = 'en'
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-exception-retry"]') as HTMLButtonElement
    expect(retry.textContent?.trim()).toBe('Retry')
    expect(retry.getAttribute('aria-label')).toBe('Retry loading the exception queue')
  })

  // H4-2 keyboard (H4-1 pattern, StockPreparationDashboardView.vue): a NATIVE disabled button is
  // pulled from the tab order, so the browser drops focus to <body> when a re-failed retry re-renders
  // with `:disabled` — a keyboard operator who pressed Retry must not be stranded there.
  it('H4-2: a failed retry returns focus to the retry button (our own :disabled dropped it to body)', async () => {
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-exception-retry"]') as HTMLButtonElement
    retry.focus()
    expect(document.activeElement).toBe(retry)
    const callsBefore = h.apiFetch.mock.calls.length
    retry.click() // still failing → button unmounts during the load, then re-renders; drops focus to <body>
    await waitForCondition(() => h.apiFetch.mock.calls.length > callsBefore)
    await waitForSelector(root, '[data-testid="stock-prep-exception-error"]')
    await waitForCondition(() => document.activeElement === root.querySelector('[data-testid="stock-prep-exception-retry"]'))
    expect(document.activeElement).toBe(root.querySelector('[data-testid="stock-prep-exception-retry"]'))
  })

  // H4-3 keyboard: the table wrap is a jsdom-testable, load-bearing scroll region — attribute
  // presence is what a future refactor could silently delete (unlike the CSS focus ring, which
  // jsdom cannot compute and is verified only via the browser harness in the PR description).
  it('H4-3: the table wrap is a keyboard-reachable scroll region (tabindex/role/aria-label)', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-exception-queue"]')
    const wrap = root.querySelector('.sp-exq__table-wrap') as HTMLElement
    expect(wrap).not.toBeNull()
    expect(wrap.getAttribute('tabindex')).toBe('0')
    expect(wrap.getAttribute('role')).toBe('region')
    expect(wrap.getAttribute('aria-label')).toBeTruthy()
  })
})
