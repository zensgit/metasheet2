import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Frontend MVP view 4: UNIT CONVERSION CONFIRMATION. This spec mocks ONLY apiFetch and drives the
// REAL service module (unitConversion.ts + confirmApi.ts) through the view, pinning BOTH directions
// of the wire contract (mock-is-not-the-contract):
//   - requests: exact URL paths, exact query key sets, exact POST body key sets (tri-XOR modes) —
//     and that confirmedBy / confirmedAt NEVER appear anywhere in a request body (server-stamped);
//   - responses: only the values-free projection renders — planted candidate values (unit symbols /
//     factors) never reach the DOM; 404 CONFIRM_READS_BATCH_NOT_FOUND is a neutral no-batch state;
//     409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND surfaces the STALE notice with a re-read entry.

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

import StockPreparationUnitConfirmView from '../src/components/integration/stockPreparation/StockPreparationUnitConfirmView.vue'

// Planted business values — the view must render NONE of them (fixed-whitelist rendering).
const PLANTED_UNIT = 'KG-SENTINEL'
const PLANTED_FACTOR = '73991'
const PLANTED_RAW_ERROR = 'connectionString=host=erp;pwd=secret-42007;unit=PCS-LEAK'
const FORBIDDEN = [PLANTED_UNIT, PLANTED_FACTOR, 'secret-42007', 'PCS-LEAK']

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
    totalRuleCount: 4,
    activeRuleCount: 3,
    requiresConfirmationCount: 1,
    scopeTypeCounts: { material: 2, category: 0, generic: 1 },
    roundingRuleCounts: { none: 2, ceil: 1, floor: 0, nearest: 0, pack_size: 0 },
    pendingUnitLineCount: 2,
  }
}

function candidatesData(): Record<string, unknown> {
  return {
    status: 'pending_confirmation',
    snapshotBatchId: 'batch-handle-alpha',
    rowCount: 3,
    byOutcome: { reused: 1, candidate: 1, held: 1 },
    byReason: { unknown: 2, rule_missing: 1 },
    rows: [
      {
        contextFingerprint: 'fp-handle-alpha',
        outcome: 'candidate',
        hasCandidate: true,
        // Planted candidate values (the REAL server strips these) — must never reach the DOM.
        candidateRule: { plmUnit: PLANTED_UNIT, conversionFactor: PLANTED_FACTOR },
        plmUnit: PLANTED_UNIT,
      },
      {
        contextFingerprint: 'fp-handle-beta',
        outcome: 'reused',
        conversionRuleId: 'rule-handle-gamma',
        hasCandidate: false,
      },
      {
        contextFingerprint: 'fp-handle-delta',
        outcome: 'held',
        reason: 'rule_missing',
        hasCandidate: false,
      },
    ],
  }
}

interface MockOverrides {
  candidates?: () => Response
  confirm?: () => Response
  retire?: () => Response
}

function mockRoutes(overrides: MockOverrides = {}): void {
  h.apiFetch.mockImplementation(async (url: string) => {
    if (url.includes('/unit-conversions/candidates')) {
      return overrides.candidates ? overrides.candidates() : ok(candidatesData())
    }
    if (url.includes('/unit-conversions/summary')) return ok(summaryData())
    if (url.includes('/unit-conversions/confirm')) {
      return overrides.confirm
        ? overrides.confirm()
        : ok({
            persisted: true,
            mode: 'created',
            conversionRuleId: 'rule-handle-created',
            evidence: { subject: 'unit_rule', mode: 'created', target: { objectId: 'obj', keyField: 'conversionRuleId' }, valuesFree: true },
          }, 201)
    }
    if (url.includes('/unit-conversions/retire')) {
      return overrides.retire
        ? overrides.retire()
        : ok({
            persisted: true,
            mode: 'retired',
            conversionRuleId: 'rule-handle-gamma',
            evidence: { subject: 'unit_rule', mode: 'retired', target: { objectId: 'obj', keyField: 'conversionRuleId' }, valuesFree: true },
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

describe('StockPreparationUnitConfirmView (view 4: confirm reads + human confirm writes)', () => {
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
    app = createApp(StockPreparationUnitConfirmView as Component, props)
    app.mount(container!)
    return container!
  }

  it('shows the select-a-project state and issues NO request when no projectId is provided', async () => {
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-unit-no-project"]')).not.toBeNull()
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it('loads summary + computed candidates via exact readonly GETs and renders the values-free projection', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-queue"]')

    // Direction pin (request): exact paths, exact query key sets, and NO write options on the GETs.
    const summaryParts = queryKeys(urlsMatching('/unit-conversions/summary')[0])
    expect(summaryParts.path).toBe('/api/integration/stock-preparation/unit-conversions/summary')
    expect([...summaryParts.params.keys()].sort()).toEqual(['projectId'])
    expect(summaryParts.params.get('projectId')).toBe('proj-alpha')
    const candidateParts = queryKeys(urlsMatching('/unit-conversions/candidates')[0])
    expect(candidateParts.path).toBe('/api/integration/stock-preparation/unit-conversions/candidates')
    expect([...candidateParts.params.keys()].sort()).toEqual(['projectId'])
    for (const call of h.apiFetch.mock.calls) {
      expect((call[1] as { method?: string } | undefined)?.method).toBeUndefined()
    }

    // Summary header: the six indicators.
    const metrics = root.querySelectorAll('[data-testid="stock-prep-unit-metric"]')
    expect(metrics.length).toBe(6)
    expect(root.querySelector('[data-testid="stock-prep-unit-metric"][data-kind="total"]')?.textContent).toContain('4')
    expect(root.querySelector('[data-testid="stock-prep-unit-metric"][data-kind="active"]')?.textContent).toContain('3')
    expect(root.querySelector('[data-testid="stock-prep-unit-metric"][data-kind="requires-confirmation"]')?.textContent).toContain('1')
    expect(root.querySelector('[data-testid="stock-prep-unit-metric"][data-kind="pending-lines"]')?.textContent).toContain('2')
    expect(root.querySelectorAll('[data-testid="stock-prep-unit-scope-count"]').length).toBe(3)
    expect(root.querySelectorAll('[data-testid="stock-prep-unit-rounding-count"]').length).toBe(5)

    // Candidate list header + rows: handles / outcome enums / reason / booleans only.
    expect(root.querySelector('[data-testid="stock-prep-unit-status"]')?.getAttribute('data-status')).toBe('pending_confirmation')
    expect(root.querySelector('[data-testid="stock-prep-unit-batch-handle"]')?.textContent).toContain('batch-handle-alpha')
    const rows = root.querySelectorAll('[data-testid="stock-prep-unit-row"]')
    expect(rows.length).toBe(3)
    expect(rows[0].querySelector('[data-testid="stock-prep-unit-row-fingerprint"]')?.textContent).toBe('fp-handle-alpha')
    expect(rows[1].querySelector('[data-testid="stock-prep-unit-row-rule-handle"]')?.textContent).toBe('rule-handle-gamma')
    expect(rows[2].querySelector('[data-testid="stock-prep-unit-row-reason"]')?.textContent).toContain('rule_missing')

    // ONLY the computed 1:1 candidate row is confirmable; reused/held rows carry no confirm entry.
    expect(root.querySelectorAll('[data-testid="stock-prep-unit-row-confirm"]').length).toBe(1)
    expect(rows[0].querySelector('[data-testid="stock-prep-unit-row-confirm"]')).not.toBeNull()

    // Values-free guard: no planted candidate value ever reaches the DOM.
    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders the neutral no-complete-batch state on 404 CONFIRM_READS_BATCH_NOT_FOUND (summary intact)', async () => {
    mockRoutes({ candidates: () => fail(404, 'CONFIRM_READS_BATCH_NOT_FOUND') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-no-batch"]')

    expect(root.querySelector('[data-testid="stock-prep-unit-summary"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-unit-candidates-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-unit-queue"]')).toBeNull()
    expect(root.textContent || '').not.toContain('secret-42007')
  })

  it('confirms a computed candidate in fingerprint mode with the EXACT body key set, then refreshes', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-queue"]')
    ;(root.querySelector('[data-testid="stock-prep-unit-row-confirm"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-unit-action-notice"]')

    const posts = postCalls('/unit-conversions/confirm')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/unit-conversions/confirm')
    // Tri-XOR pin: fingerprint mode carries contextFingerprint (+ the batch the operator SAW) and
    // neither conversionRuleId nor rule; server-stamped fields NEVER cross.
    expect(Object.keys(posts[0].body).sort()).toEqual(['contextFingerprint', 'projectId', 'snapshotBatchId'])
    expect(posts[0].body.contextFingerprint).toBe('fp-handle-alpha')
    expect(posts[0].body.projectId).toBe('proj-alpha')
    expect(posts[0].body.snapshotBatchId).toBe('batch-handle-alpha')
    const rawBody = JSON.stringify(posts[0].body)
    expect(rawBody).not.toContain('confirmedBy')
    expect(rawBody).not.toContain('confirmedAt')

    // Confirm → both reads re-issued.
    await waitForCondition(() => urlsMatching('/unit-conversions/summary').length === 2)
    expect(urlsMatching('/unit-conversions/candidates').length).toBe(2)
    expect(root.querySelector('[data-testid="stock-prep-unit-action-notice"]')?.textContent).toContain('created')
  })

  it('surfaces the STALE notice on 409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND and re-reads on refresh', async () => {
    mockRoutes({ confirm: () => fail(409, 'CONFIRM_UNIT_CANDIDATE_NOT_FOUND') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-queue"]')
    ;(root.querySelector('[data-testid="stock-prep-unit-row-confirm"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-unit-stale"]')

    // Stale is its own surface (a refresh prompt), not the generic action error.
    expect(root.querySelector('[data-testid="stock-prep-unit-action-error"]')).toBeNull()
    expect(root.textContent || '').not.toContain('secret-42007')

    // The refresh entry re-issues the candidates GET and clears the notice.
    ;(root.querySelector('[data-testid="stock-prep-unit-stale-refresh"]') as HTMLButtonElement).click()
    await waitForCondition(() => urlsMatching('/unit-conversions/candidates').length === 2)
    await waitForCondition(() => root.querySelector('[data-testid="stock-prep-unit-stale"]') === null)
  })

  it('mirrors the server rule-mode checks client-side ({field} errors, NO premature POST)', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-rule-form"]')
    const form = root.querySelector('[data-testid="stock-prep-unit-rule-form"]') as HTMLFormElement

    // Empty form → first missing required field, by NAME.
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-unit-form-error"]')
    expect(root.querySelector('[data-testid="stock-prep-unit-form-error"]')?.textContent).toContain('plmUnit')

    // conversionFactor must be a finite number > 0.
    setInput(root, 'stock-prep-unit-form-plm-unit', 'sheet')
    setInput(root, 'stock-prep-unit-form-erp-unit', 'roll')
    setInput(root, 'stock-prep-unit-form-factor', '0')
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForCondition(() =>
      (root.querySelector('[data-testid="stock-prep-unit-form-error"]')?.textContent || '').includes('conversionFactor'))

    // material/category scope requires a scopeKey.
    setInput(root, 'stock-prep-unit-form-factor', '2.5')
    setSelect(root, 'stock-prep-unit-form-scope-type', 'material')
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForCondition(() =>
      (root.querySelector('[data-testid="stock-prep-unit-form-error"]')?.textContent || '').includes('scopeKey'))

    // No confirm POST was ever issued by the client mirror.
    expect(postCalls('/unit-conversions/confirm').length).toBe(0)
  })

  it('creates a manual rule with the EXACT nested key set (grounded to the server allowlist)', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-rule-form"]')

    setInput(root, 'stock-prep-unit-form-plm-unit', 'sheet')
    setInput(root, 'stock-prep-unit-form-erp-unit', 'roll')
    setInput(root, 'stock-prep-unit-form-factor', '2.5')
    setSelect(root, 'stock-prep-unit-form-scope-type', 'material')
    await nextTick()
    setInput(root, 'stock-prep-unit-form-scope-key', 'OPERATOR-SCOPE-1')
    const form = root.querySelector('[data-testid="stock-prep-unit-rule-form"]') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-unit-action-notice"]')

    const posts = postCalls('/unit-conversions/confirm')
    expect(posts.length).toBe(1)
    // Tri-XOR pin: rule mode carries rule and neither conversionRuleId nor contextFingerprint.
    expect(Object.keys(posts[0].body).sort()).toEqual(['projectId', 'rule'])
    const rule = posts[0].body.rule as Record<string, unknown>
    expect(Object.keys(rule).sort()).toEqual([
      'conversionFactor',
      'erpIssueUnit',
      'plmUnit',
      'roundingRule',
      'scopeKey',
      'scopeType',
    ])
    // Numbers cross as numbers (the server validates > 0 on a numeric parse).
    expect(rule.conversionFactor).toBe(2.5)
    expect(rule.roundingRule).toBe('none')
    const rawBody = JSON.stringify(posts[0].body)
    expect(rawBody).not.toContain('confirmedBy')
    expect(rawBody).not.toContain('confirmedAt')

    // Success → notice + form cleared + reads refreshed.
    expect(root.querySelector('[data-testid="stock-prep-unit-action-notice"]')?.textContent).toContain('created')
    expect((root.querySelector('[data-testid="stock-prep-unit-form-plm-unit"]') as HTMLInputElement).value).toBe('')
    await waitForCondition(() => urlsMatching('/unit-conversions/summary').length === 2)
  })

  it('clears scopeKey when switching to the generic scope (scopeKey is forbidden there)', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-rule-form"]')

    setInput(root, 'stock-prep-unit-form-plm-unit', 'sheet')
    setInput(root, 'stock-prep-unit-form-erp-unit', 'roll')
    setInput(root, 'stock-prep-unit-form-factor', '4')
    setSelect(root, 'stock-prep-unit-form-scope-type', 'material')
    await nextTick()
    setInput(root, 'stock-prep-unit-form-scope-key', 'LEFTOVER-KEY')
    setSelect(root, 'stock-prep-unit-form-scope-type', 'generic')
    await nextTick()
    const form = root.querySelector('[data-testid="stock-prep-unit-rule-form"]') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-unit-action-notice"]')

    const rule = postCalls('/unit-conversions/confirm')[0].body.rule as Record<string, unknown>
    expect(Object.keys(rule).sort()).toEqual([
      'conversionFactor',
      'erpIssueUnit',
      'plmUnit',
      'roundingRule',
      'scopeType',
    ])
    expect(rule.scopeType).toBe('generic')
    expect(JSON.stringify(rule)).not.toContain('LEFTOVER-KEY')
  })

  it('routes a server {field} error into the form field-error surface (server stays authoritative)', async () => {
    mockRoutes({ confirm: () => fail(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'roundingRule') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-rule-form"]')

    setInput(root, 'stock-prep-unit-form-plm-unit', 'sheet')
    setInput(root, 'stock-prep-unit-form-erp-unit', 'roll')
    setInput(root, 'stock-prep-unit-form-factor', '2')
    setSelect(root, 'stock-prep-unit-form-scope-type', 'generic')
    const form = root.querySelector('[data-testid="stock-prep-unit-rule-form"]') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await waitForSelector(root, '[data-testid="stock-prep-unit-form-error"]')

    expect(root.querySelector('[data-testid="stock-prep-unit-form-error"]')?.textContent).toContain('roundingRule')
    expect(root.textContent || '').not.toContain('secret-42007')
    expect(root.textContent || '').not.toContain('PCS-LEAK')
  })

  it('retires a rule by handle with the EXACT body key set', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-retire-block"]')

    const retireButton = root.querySelector('[data-testid="stock-prep-unit-retire-submit"]') as HTMLButtonElement
    expect(retireButton.disabled).toBe(true)
    setInput(root, 'stock-prep-unit-retire-input', 'rule-handle-gamma')
    await waitForCondition(() => !(root.querySelector('[data-testid="stock-prep-unit-retire-submit"]') as HTMLButtonElement).disabled)
    ;(root.querySelector('[data-testid="stock-prep-unit-retire-submit"]') as HTMLButtonElement).click()
    await waitForSelector(root, '[data-testid="stock-prep-unit-action-notice"]')

    const posts = postCalls('/unit-conversions/retire')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe('/api/integration/stock-preparation/unit-conversions/retire')
    expect(Object.keys(posts[0].body).sort()).toEqual(['conversionRuleId', 'projectId'])
    expect(posts[0].body.conversionRuleId).toBe('rule-handle-gamma')
  })

  it('renders the English copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    mockRoutes()
    const root = mountView({})
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-unit-no-project"]')?.textContent).toMatch(/select a project/i)
  })

  // H4-3 (responsive + long-table usability): both error surfaces (summary + candidates) offer a
  // Retry that re-runs the SAME readonly load — same idiom as the H4-1 dashboard retry.
  it('H4-3: the summary error state offers a Retry that re-runs loadAll() and recovers', async () => {
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-unit-retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    expect(retry?.getAttribute('aria-label')).toBe('重试读取单位换算确认')

    mockRoutes() // the retry succeeds
    const callsBefore = h.apiFetch.mock.calls.length
    retry!.click()
    await waitForSelector(root, '[data-testid="stock-prep-unit-queue"]')
    expect(h.apiFetch.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(root.querySelector('[data-testid="stock-prep-unit-error"]')).toBeNull()
  })

  it('H4-3: the candidates error state offers a Retry that re-runs loadCandidates() and recovers', async () => {
    mockRoutes({ candidates: () => fail(500, 'BACKEND_NOT_READY') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-candidates-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-unit-candidates-retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    expect(retry?.getAttribute('aria-label')).toBe('重试读取计算候选行')

    mockRoutes() // the retry succeeds
    retry!.click()
    await waitForSelector(root, '[data-testid="stock-prep-unit-queue"]')
    expect(root.querySelector('[data-testid="stock-prep-unit-candidates-error"]')).toBeNull()
  })

  it('H4-3: the summary retry button is bilingual + carries an accessible name (aria-label)', async () => {
    h.locale = 'en'
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-unit-retry"]') as HTMLButtonElement
    expect(retry.textContent?.trim()).toBe('Retry')
    expect(retry.getAttribute('aria-label')).toBe('Retry loading unit-conversion confirmation')
  })

  // H4-2 keyboard (H4-1 pattern, StockPreparationDashboardView.vue): the error branch unmounts
  // the retry button while the load is in flight, so the browser drops focus to <body>. A keyboard
  // operator who pressed Retry must not be stranded there when the failed state re-renders.
  it('H4-2: a failed summary retry returns focus to the retry button (our own unmount dropped it to body)', async () => {
    h.apiFetch.mockImplementation(async () => fail(500, 'BACKEND_NOT_READY'))
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-unit-retry"]') as HTMLButtonElement
    retry.focus()
    expect(document.activeElement).toBe(retry)
    const callsBefore = h.apiFetch.mock.calls.length
    retry.click() // still failing → button unmounts during the load, then re-renders; drops focus to <body>
    await waitForCondition(() => h.apiFetch.mock.calls.length > callsBefore)
    await waitForSelector(root, '[data-testid="stock-prep-unit-error"]')
    await waitForCondition(() => document.activeElement === root.querySelector('[data-testid="stock-prep-unit-retry"]'))
    expect(document.activeElement).toBe(root.querySelector('[data-testid="stock-prep-unit-retry"]'))
  })

  // The candidates-retry entry is the one where `:disabled` alone was NEVER load-bearing for the
  // double-click guard — loadCandidates() never touched the summary `loading` flag (fixed here by a
  // dedicated candidatesLoading flag). But the FOCUS-drop itself is driven by the surrounding
  // `v-else-if="candidatesErrored"` block: loadCandidates() resets candidatesErrored to false before
  // its GET, so the button's whole parent unmounts for the duration of the retry — that unmount (not
  // just :disabled) is what drops focus to <body>, and the remount on re-failure is what this test
  // exercises the restore against.
  it('H4-2: a failed candidates retry returns focus to the retry button (our own unmount dropped it to body)', async () => {
    mockRoutes({ candidates: () => fail(500, 'BACKEND_NOT_READY') })
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-candidates-error"]')
    const retry = root.querySelector('[data-testid="stock-prep-unit-candidates-retry"]') as HTMLButtonElement
    retry.focus()
    expect(document.activeElement).toBe(retry)
    const callsBefore = h.apiFetch.mock.calls.length
    retry.click() // still failing → the candidatesErrored branch unmounts the button during the load
    await waitForCondition(() => h.apiFetch.mock.calls.length > callsBefore)
    await waitForSelector(root, '[data-testid="stock-prep-unit-candidates-error"]')
    await waitForCondition(() => document.activeElement === root.querySelector('[data-testid="stock-prep-unit-candidates-retry"]'))
    expect(document.activeElement).toBe(root.querySelector('[data-testid="stock-prep-unit-candidates-retry"]'))
  })

  // H4-3 keyboard: the table wrap is a jsdom-testable, load-bearing scroll region — attribute
  // presence is what a future refactor could silently delete (unlike the CSS focus ring, which
  // jsdom cannot compute and is verified only via the browser harness in the PR description).
  it('H4-3: the table wrap is a keyboard-reachable scroll region (tabindex/role/aria-label)', async () => {
    mockRoutes()
    const root = mountView()
    await waitForSelector(root, '[data-testid="stock-prep-unit-queue"]')
    const wrap = root.querySelector('.sp-unit__table-wrap') as HTMLElement
    expect(wrap).not.toBeNull()
    expect(wrap.getAttribute('tabindex')).toBe('0')
    expect(wrap.getAttribute('role')).toBe('region')
    expect(wrap.getAttribute('aria-label')).toBeTruthy()
  })
})
