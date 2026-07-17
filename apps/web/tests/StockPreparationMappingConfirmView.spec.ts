import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Frontend MVP view 3: MATERIAL MAPPING CONFIRMATION. This spec mocks ONLY apiFetch and drives the
// REAL service module (materialMapping.ts + confirmApi.ts) through the view, so it pins BOTH
// directions of the wire contract (mock-is-not-the-contract):
//   - requests: exact URL paths, exact query key sets, exact POST body key sets — and above all
//     that confirmedBy / confirmedAt NEVER appear anywhere in a request body (server-stamped);
//   - responses: the view renders only the values-free projection — planted business values
//     (drawing numbers / material names / ERP codes) never reach the DOM, and error surfaces render
//     the clamped code / field NAME, never the raw error body.

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

import StockPreparationMappingConfirmView from '../src/components/integration/stockPreparation/StockPreparationMappingConfirmView.vue'

// Planted business values — the view must render NONE of them (fixed-whitelist rendering).
const PLANTED_DRAWING_NO = 'DWG-88472-A'
const PLANTED_MATERIAL_NAME = '涡轮叶片总成'
const PLANTED_ERP_CODE = 'MAT-ZX9911'
const PLANTED_RAW_ERROR = 'connectionString=host=erp;pwd=secret-42007;drawing=DWG-LEAK-9'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_NAME, PLANTED_ERP_CODE, 'secret-42007', 'DWG-LEAK-9']

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

function summaryData(): Record<string, unknown> {
  return {
    totalMappingCount: 6,
    activeMappingCount: 5,
    matchStatusCounts: { matched: 2, pending_confirm: 1, multi_candidate: 1, not_found: 1, version_conflict: 0 },
    versionPolicyCounts: { drawing_and_version: 3, drawing_only: 1, category_rule: 0, manual: 1 },
    pendingConfirmCount: 3,
  }
}

function candidatesData(): Record<string, unknown> {
  return {
    rowCount: 2,
    byMatchStatus: { matched: 0, pending_confirm: 1, multi_candidate: 0, not_found: 1, version_conflict: 0 },
    rows: [
      {
        mappingId: 'map-handle-alpha',
        matchStatus: 'pending_confirm',
        matchMethod: 'exact_code_candidate',
        versionPolicy: 'drawing_and_version',
        confidence: 0.9,
        isActive: true,
        confirmed: false,
        hasErpTarget: true,
        plmVersionPresent: true,
        // Planted business values (NOT part of the wire shape) — must never reach the DOM.
        plmDrawingNo: PLANTED_DRAWING_NO,
        plmMaterialName: PLANTED_MATERIAL_NAME,
        erpMaterialCode: PLANTED_ERP_CODE,
      },
      {
        mappingId: 'map-handle-beta',
        matchStatus: 'not_found',
        versionPolicy: 'drawing_only',
        confidence: null,
        isActive: true,
        confirmed: false,
        hasErpTarget: false,
        plmVersionPresent: false,
      },
    ],
  }
}

interface MockOverrides {
  confirm?: () => Response
  sync?: () => Response
  retire?: () => Response
}

function mockRoutes(overrides: MockOverrides = {}): void {
  h.apiFetch.mockImplementation(async (url: string) => {
    // Order matters: /candidates/sync must be matched BEFORE /candidates.
    if (url.includes('/material-mappings/candidates/sync')) {
      return overrides.sync
        ? overrides.sync()
        : ok({
            persisted: true,
            mode: 'created',
            created: { mappings: 3 },
            skipped: { existing: 1, matched: 0 },
            status: 'pending_confirmation',
            snapshotBatchId: 'batch-handle-alpha',
            evidence: { valuesFree: true },
          }, 201)
    }
    if (url.includes('/material-mappings/candidates')) return ok(candidatesData())
    if (url.includes('/material-mappings/summary')) return ok(summaryData())
    if (url.includes('/material-mappings/confirm')) {
      return overrides.confirm
        ? overrides.confirm()
        : ok({
            persisted: true,
            mode: 'confirmed',
            mappingId: 'map-handle-alpha',
            evidence: { subject: 'mapping', mode: 'confirmed', target: { objectId: 'obj', keyField: 'mappingId' }, valuesFree: true },
          })
    }
    if (url.includes('/material-mappings/retire')) {
      return overrides.retire
        ? overrides.retire()
        : ok({
            persisted: true,
            mode: 'retired',
            mappingId: 'map-handle-alpha',
            evidence: { subject: 'mapping', mode: 'retired', target: { objectId: 'obj', keyField: 'mappingId' }, valuesFree: true },
          })
    }
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

function setInput(root: HTMLElement, testid: string, value: string): void {
  const input = root.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelect(root: HTMLElement, testid: string, value: string): void {
  const select = root.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('StockPreparationMappingConfirmView (view 3: confirm reads + human confirm writes)', () => {
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
    app = createApp(StockPreparationMappingConfirmView as Component, props)
    app.mount(container!)
    return container!
  }

  it('shows the select-a-project state and issues NO request when no projectId is provided', async () => {
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-mapping-no-project"]')).not.toBeNull()
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it('loads summary + queue via exact readonly GETs and renders the values-free projection', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')

    // Direction pin (request): exact paths, exact query key sets, and NO write options on the GETs.
    const summaryUrls = urlsMatching('/material-mappings/summary')
    expect(summaryUrls.length).toBe(1)
    const summaryParts = queryKeys(summaryUrls[0])
    expect(summaryParts.path).toBe('/api/integration/stock-preparation/material-mappings/summary')
    expect([...summaryParts.params.keys()].sort()).toEqual(['projectId'])
    expect(summaryParts.params.get('projectId')).toBe('proj-alpha')

    const candidateUrls = urlsMatching('/material-mappings/candidates')
    expect(candidateUrls.length).toBe(1)
    const candidateParts = queryKeys(candidateUrls[0])
    expect(candidateParts.path).toBe('/api/integration/stock-preparation/material-mappings/candidates')
    expect([...candidateParts.params.keys()].sort()).toEqual(['projectId'])
    for (const call of h.apiFetch.mock.calls) {
      expect((call[1] as { method?: string } | undefined)?.method).toBeUndefined()
    }

    // Summary header: the five indicators.
    const metrics = root.querySelectorAll('[data-testid="stock-prep-mapping-metric"]')
    expect(metrics.length).toBe(5)
    expect(root.querySelector('[data-testid="stock-prep-mapping-metric"][data-kind="total"]')?.textContent).toContain('6')
    expect(root.querySelector('[data-testid="stock-prep-mapping-metric"][data-kind="active"]')?.textContent).toContain('5')
    expect(root.querySelector('[data-testid="stock-prep-mapping-metric"][data-kind="pending-confirm"]')?.textContent).toContain('3')
    expect(root.querySelectorAll('[data-testid="stock-prep-mapping-status-count"]').length).toBe(5)
    expect(root.querySelectorAll('[data-testid="stock-prep-mapping-policy-count"]').length).toBe(4)

    // Queue rows render enum/boolean/handle whitelist only.
    const rows = root.querySelectorAll('[data-testid="stock-prep-mapping-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0].querySelector('[data-testid="stock-prep-mapping-row-handle"]')?.textContent).toBe('map-handle-alpha')
    expect(rows[0].querySelector('[data-testid="stock-prep-mapping-row-status"]')?.textContent?.trim()).toBe('pending_confirm')
    expect(rows[0].querySelector('[data-testid="stock-prep-mapping-row-method"]')?.textContent).toContain('exact_code_candidate')
    expect(rows[1].querySelector('[data-testid="stock-prep-mapping-row-method"]')?.textContent).toContain('—')
    expect(rows[1].querySelector('[data-testid="stock-prep-mapping-row-confidence"]')?.textContent).toContain('—')
    expect(rows[0].querySelector('[data-testid="stock-prep-mapping-row-erp-target"]')?.getAttribute('data-flag')).toBe('true')
    expect(rows[1].querySelector('[data-testid="stock-prep-mapping-row-erp-target"]')?.getAttribute('data-flag')).toBe('false')

    // Values-free guard: no planted business value ever reaches the DOM.
    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('re-reads the queue with the exact matchStatus filter key set when the filter changes', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')

    setSelect(root, 'stock-prep-mapping-filter', 'not_found')
    await waitForCondition(() => urlsMatching('/material-mappings/candidates').length === 2)

    const parts = queryKeys(urlsMatching('/material-mappings/candidates')[1])
    expect([...parts.params.keys()].sort()).toEqual(['matchStatus', 'projectId'])
    expect(parts.params.get('matchStatus')).toBe('not_found')
  })

  it('confirms a candidate in mappingId mode with the EXACT body key set, then refreshes both reads', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')

    const rows = root.querySelectorAll('[data-testid="stock-prep-mapping-row"]')
    // Only the row with BOTH ERP identifiers is confirmable (server 409s otherwise).
    const confirmAlpha = rows[0].querySelector('[data-testid="stock-prep-mapping-row-confirm"]') as HTMLButtonElement
    const confirmBeta = rows[1].querySelector('[data-testid="stock-prep-mapping-row-confirm"]') as HTMLButtonElement
    expect(confirmAlpha.disabled).toBe(false)
    expect(confirmBeta.disabled).toBe(true)

    confirmAlpha.click()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-action-notice"]')

    const posts = postCalls('/material-mappings/confirm')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/material-mappings/confirm')
    // XOR pin: mappingId mode carries mappingId and NOT mapping; server-stamped fields NEVER cross.
    expect(Object.keys(posts[0].body).sort()).toEqual(['mappingId', 'projectId'])
    expect(posts[0].body.mappingId).toBe('map-handle-alpha')
    expect(posts[0].body.projectId).toBe('proj-alpha')
    const rawBody = JSON.stringify(posts[0].body)
    expect(rawBody).not.toContain('confirmedBy')
    expect(rawBody).not.toContain('confirmedAt')

    // Confirm → both reads re-issued (summary + candidates twice each).
    await waitForCondition(() => urlsMatching('/material-mappings/summary').length === 2)
    expect(urlsMatching('/material-mappings/candidates').length).toBe(2)
    expect(root.querySelector('[data-testid="stock-prep-mapping-action-notice"]')?.textContent).toContain('confirmed')
  })

  it('renders a values-free action error (clamped code, never the raw body) on a 409 confirm', async () => {
    mockRoutes({ confirm: () => fail(409, 'CONFIRM_MAPPING_TARGET_INCOMPLETE') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')
    ;(root.querySelector('[data-testid="stock-prep-mapping-row-confirm"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-action-error"]')

    const text = root.textContent || ''
    expect(text).toContain('CONFIRM_MAPPING_TARGET_INCOMPLETE')
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('retires a row with the EXACT body key set', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')
    ;(root.querySelector('[data-testid="stock-prep-mapping-row-retire"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-action-notice"]')

    const posts = postCalls('/material-mappings/retire')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/material-mappings/retire')
    expect(Object.keys(posts[0].body).sort()).toEqual(['mappingId', 'projectId'])
    expect(JSON.stringify(posts[0].body)).not.toContain('confirmed')
  })

  it('gates candidate sync on an explicit defaultVersionPolicy (OD2: no default) and posts the exact keys', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')

    // No policy chosen → sync entry disabled and no POST possible.
    const syncButton = root.querySelector('[data-testid="stock-prep-mapping-sync"]') as HTMLButtonElement
    expect(syncButton.disabled).toBe(true)
    syncButton.click()
    await nextTick()
    expect(postCalls('/material-mappings/candidates/sync').length).toBe(0)

    setSelect(root, 'stock-prep-mapping-sync-policy', 'drawing_only')
    await waitForCondition(() => !(root.querySelector('[data-testid="stock-prep-mapping-sync"]') as HTMLButtonElement).disabled)
    ;(root.querySelector('[data-testid="stock-prep-mapping-sync"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-sync-result"]')

    const posts = postCalls('/material-mappings/candidates/sync')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/material-mappings/candidates/sync')
    expect(Object.keys(posts[0].body).sort()).toEqual(['defaultVersionPolicy', 'projectId'])
    expect(posts[0].body.defaultVersionPolicy).toBe('drawing_only')

    // Values-free sync note: mode + created count only; reads refreshed.
    const note = root.querySelector('[data-testid="stock-prep-mapping-sync-result"]') as HTMLElement
    expect(note.textContent).toContain('created')
    expect(note.textContent).toContain('3')
    await waitForCondition(() => urlsMatching('/material-mappings/summary').length === 2)
  })

  it('mirrors the server create-mode rules client-side ({field} errors, NO premature POST)', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')
    const form = root.querySelector('[data-testid="stock-prep-mapping-create-form"]') as HTMLFormElement

    // Empty form → first missing required field, by NAME.
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-mapping-form-error"]')
    expect(root.querySelector('[data-testid="stock-prep-mapping-form-error"]')?.textContent).toContain('plmDrawingNo')

    // Both ERP identifiers are required.
    setInput(root, 'stock-prep-mapping-form-drawing', 'OPERATOR-DRAWING-1')
    setInput(root, 'stock-prep-mapping-form-erp-code', 'OPERATOR-CODE-1')
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForCondition(() =>
      (root.querySelector('[data-testid="stock-prep-mapping-form-error"]')?.textContent || '').includes('erpMaterialInternalId'))

    // drawing_and_version requires a plmVersion.
    setInput(root, 'stock-prep-mapping-form-erp-internal', 'OPERATOR-INTERNAL-1')
    setSelect(root, 'stock-prep-mapping-form-policy', 'drawing_and_version')
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForCondition(() =>
      (root.querySelector('[data-testid="stock-prep-mapping-form-error"]')?.textContent || '').includes('plmVersion'))

    // No confirm POST was ever issued by the client mirror.
    expect(postCalls('/material-mappings/confirm').length).toBe(0)
  })

  it('creates a confirmed mapping with the EXACT nested key set (grounded to the server allowlist)', async () => {
    mockRoutes({
      confirm: () => ok({
        persisted: true,
        mode: 'created',
        mappingId: 'map-handle-created',
        evidence: { subject: 'mapping', mode: 'created', target: { objectId: 'obj', keyField: 'mappingId' }, valuesFree: true },
      }, 201),
    })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')

    setInput(root, 'stock-prep-mapping-form-drawing', 'OPERATOR-DRAWING-1')
    setInput(root, 'stock-prep-mapping-form-version', 'B')
    setInput(root, 'stock-prep-mapping-form-erp-code', 'OPERATOR-CODE-1')
    setInput(root, 'stock-prep-mapping-form-erp-internal', 'OPERATOR-INTERNAL-1')
    setSelect(root, 'stock-prep-mapping-form-policy', 'drawing_and_version')
    setInput(root, 'stock-prep-mapping-form-notes', 'operator note')
    const form = root.querySelector('[data-testid="stock-prep-mapping-create-form"]') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-mapping-action-notice"]')

    const posts = postCalls('/material-mappings/confirm')
    expect(posts.length).toBe(1)
    // XOR pin: create mode carries mapping and NOT mappingId.
    expect(Object.keys(posts[0].body).sort()).toEqual(['mapping', 'projectId'])
    const mapping = posts[0].body.mapping as Record<string, unknown>
    expect(Object.keys(mapping).sort()).toEqual([
      'erpMaterialCode',
      'erpMaterialInternalId',
      'notes',
      'plmDrawingNo',
      'plmVersion',
      'versionPolicy',
    ])
    expect(mapping.versionPolicy).toBe('drawing_and_version')
    const rawBody = JSON.stringify(posts[0].body)
    expect(rawBody).not.toContain('confirmedBy')
    expect(rawBody).not.toContain('confirmedAt')

    // Success → notice + form cleared + reads refreshed.
    expect(root.querySelector('[data-testid="stock-prep-mapping-action-notice"]')?.textContent).toContain('created')
    expect((root.querySelector('[data-testid="stock-prep-mapping-form-drawing"]') as HTMLInputElement).value).toBe('')
    await waitForCondition(() => urlsMatching('/material-mappings/summary').length === 2)
  })

  it('routes a server {field} error into the form field-error surface (server stays authoritative)', async () => {
    mockRoutes({ confirm: () => fail(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'plmVersion') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')

    // Client mirror passes (drawing_only needs no version) — the server error must still land.
    setInput(root, 'stock-prep-mapping-form-drawing', 'OPERATOR-DRAWING-1')
    setInput(root, 'stock-prep-mapping-form-erp-code', 'OPERATOR-CODE-1')
    setInput(root, 'stock-prep-mapping-form-erp-internal', 'OPERATOR-INTERNAL-1')
    setSelect(root, 'stock-prep-mapping-form-policy', 'drawing_only')
    const form = root.querySelector('[data-testid="stock-prep-mapping-create-form"]') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-mapping-form-error"]')

    const text = root.querySelector('[data-testid="stock-prep-mapping-form-error"]')?.textContent || ''
    expect(text).toContain('plmVersion')
    // The raw error body (message with values) never reaches the DOM.
    expect(root.textContent || '').not.toContain('secret-42007')
    expect(root.textContent || '').not.toContain('DWG-LEAK-9')
  })

  it('renders a neutral error state when a read rejects (404-soft), never the raw body', async () => {
    h.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/material-mappings/summary')) return fail(404, 'NOT_FOUND')
      return ok(candidatesData())
    })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-error"]')
    expect(root.querySelector('[data-testid="stock-prep-mapping-overview"]')).toBeNull()
    expect(root.textContent || '').not.toContain('secret-42007')
  })

  // H4-3 (responsive + long-table usability): the error state offers a Retry that re-runs loadAll()
  // and recovers — same idiom as the H4-1 dashboard retry.
  it('H4-3: the error state offers a Retry that re-runs loadAll() and recovers', async () => {
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-mapping-retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    expect(retry?.getAttribute('aria-label')).toBe('重试读取物料映射确认')

    mockRoutes() // the retry succeeds
    const callsBefore = h.apiFetch.mock.calls.length
    retry!.click()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-overview"]')
    expect(h.apiFetch.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(root.querySelector('[data-testid="stock-prep-mapping-error"]')).toBeNull()
  })

  it('H4-3: the retry button is bilingual + carries an accessible name (aria-label)', async () => {
    h.locale = 'en'
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-mapping-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-mapping-retry"]') as HTMLButtonElement
    expect(retry.textContent?.trim()).toBe('Retry')
    expect(retry.getAttribute('aria-label')).toBe('Retry loading the material-mapping confirmation queue')
  })

  it('renders the English copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-mapping-no-project"]')?.textContent).toMatch(/select a project/i)
  })
})
