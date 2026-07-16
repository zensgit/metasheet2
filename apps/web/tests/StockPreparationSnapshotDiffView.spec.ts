import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as renderH, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Frontend MVP view 2: the readonly BOM SNAPSHOT BATCH & DIFF view. Covers the loading → batches
// render, empty (batchCount 0), error/404-soft, select-a-project (no projectId), and select-a-batch
// → diff-summary flows, and pins the values-free contract: the view renders only counts / status
// enums / booleans / internal handles, never a customer business value, and never the raw error
// body. Mirrors the view-1 spec's mocking idiom (vi.hoisted holder + mocked locale), and — because
// this view calls TWO service functions — the module mock returns BOTH.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  listBatches: vi.fn(),
  getDiff: vi.fn(),
  listRows: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/services/integration/stockPreparation/bomSnapshotDiff', () => ({
  listStockPreparationSnapshotBatches: h.listBatches,
  getStockPreparationSnapshotDiff: h.getDiff,
  listStockPreparationSnapshotDiffRows: h.listRows,
}))

import StockPreparationSnapshotDiffView from '../src/components/integration/stockPreparation/StockPreparationSnapshotDiffView.vue'
import type {
  StockPreparationSnapshotBatchListResult,
  StockPreparationSnapshotDiffSummary,
} from '../src/services/integration/stockPreparation/bomSnapshotDiff'

// Business values planted as EXTRA fields on the mocked rows. A values-free view must render NONE of
// them — proving it reads a fixed whitelist rather than stringifying the row.
const PLANTED_DRAWING_NO = 'DWG-88472-A'
const PLANTED_MATERIAL_CODE = 'MAT-ZX9911'
const PLANTED_PROJECT_NAME = '涡轮增压器总成'
const PLANTED_QUANTITY = '73920'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_CODE, PLANTED_PROJECT_NAME, PLANTED_QUANTITY]

function batchListWithPlantedExtras(): StockPreparationSnapshotBatchListResult {
  // syncRunId is intentionally digit-free so a stray digit guard cannot false-positive on it.
  return {
    projectId: 'proj-alpha',
    batchCount: 2,
    batches: [
      {
        snapshotBatchId: 'batch-alpha',
        snapshotVersion: 3,
        snapshotStatus: 'active',
        syncRunId: 'sync-run-alpha',
        lineCount: 7,
        createdAtPresent: true,
        incomplete: false,
        // Planted business values (not part of the type) — must never reach the DOM.
        drawingNo: PLANTED_DRAWING_NO,
        materialCode: PLANTED_MATERIAL_CODE,
        projectName: PLANTED_PROJECT_NAME,
        quantity: PLANTED_QUANTITY,
      },
      {
        // Incomplete batch (#4002 semantics: run row absent → incomplete) — the view must surface
        // the boolean flag and disable this batch's diff entry.
        snapshotBatchId: 'batch-beta',
        snapshotVersion: 2,
        snapshotStatus: 'superseded',
        syncRunId: null,
        lineCount: 4,
        createdAtPresent: false,
        incomplete: true,
      },
    ],
  } as unknown as StockPreparationSnapshotBatchListResult
}

// TWO selectable (complete) batches, so a real A→B switch can be driven — batch-beta above is
// incomplete/disabled, so clicking "the batch-select button" only ever re-selects batch-alpha.
function batchListTwoComplete(): StockPreparationSnapshotBatchListResult {
  return {
    projectId: 'proj-alpha',
    batchCount: 2,
    batches: [
      { snapshotBatchId: 'batch-alpha', snapshotVersion: 3, snapshotStatus: 'active', syncRunId: 'sync-run-alpha', lineCount: 7, createdAtPresent: true, incomplete: false },
      { snapshotBatchId: 'batch-gamma', snapshotVersion: 4, snapshotStatus: 'active', syncRunId: 'sync-run-gamma', lineCount: 9, createdAtPresent: true, incomplete: false },
    ],
  } as unknown as StockPreparationSnapshotBatchListResult
}

// `baseId` distinguishes one batch's summary from another's in the DOM (it renders as a <code> handle),
// so a stale summary is detectable — batch A's `base-of-alpha` must never show while B is selected.
function diffSummary(baseId = 'batch-beta'): StockPreparationSnapshotDiffSummary {
  return {
    snapshotBatchId: 'batch-alpha',
    baseSnapshotBatchId: baseId,
    changeCounts: {
      added: 2,
      removed: 1,
      quantityChanged: 3,
      unitChanged: 0,
      versionChanged: 4,
      pathChanged: 0,
      missingChildBom: 1,
      fingerprintChanged: 5,
    },
    blockingExceptionCount: 1,
  }
}

// `idPrefix` distinguishes one batch's rows from another's, so a stale-batch response is detectable in
// the DOM (batch A's `diff-alpha-*` must never show while batch B is open).
function diffRowsResult(idPrefix = 'diff', batchId = 'batch-alpha'): unknown {
  // Planted business values as EXTRA fields on each row — the values-free table must render NONE of them.
  return {
    snapshotBatchId: batchId,
    baseSnapshotBatchId: 'batch-beta',
    rowCount: 2,
    heldRowCount: 1,
    rows: [
      {
        diffId: `${idPrefix}-one`,
        diffType: 'changed',
        reviewStatus: 'held',
        changeTypes: ['quantity_changed', 'unit_changed'],
        reason: 'unit_mismatch',
        rowCount: 1,
        previousSnapshotLineId: 'line-prev-one',
        currentSnapshotLineId: 'line-cur-one',
        keyFingerprint: 'sha16:0123456789abcdef',
        previousPathKeyFingerprint: 'fedcba9876543210',
        currentPathKeyFingerprint: '0011223344556677',
        drawingNo: PLANTED_DRAWING_NO,
        materialCode: PLANTED_MATERIAL_CODE,
        projectName: PLANTED_PROJECT_NAME,
        quantity: PLANTED_QUANTITY,
      },
      {
        diffId: `${idPrefix}-two`,
        diffType: 'added',
        reviewStatus: 'ready',
        changeTypes: [],
        reason: null,
        rowCount: 4,
        previousSnapshotLineId: null,
        currentSnapshotLineId: 'line-cur-two',
        keyFingerprint: 'sha16:99aabbccddeeff00',
        previousPathKeyFingerprint: null,
        currentPathKeyFingerprint: '7788990011223344',
      },
    ],
  }
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// Open the row-detail drill-down after a batch's summary is showing.
async function openRowDetail(root: HTMLDivElement): Promise<void> {
  const toggle = root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-toggle"]') as HTMLButtonElement
  toggle.click()
  await flushUi()
}

describe('StockPreparationSnapshotDiffView (readonly, values-free)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.listBatches.mockReset()
    h.getDiff.mockReset()
    h.listRows.mockReset()
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
    app = createApp(StockPreparationSnapshotDiffView as Component, props)
    app.mount(container!)
    return container!
  }

  it('shows the loading state before the readonly GET settles, then renders the batches', async () => {
    let resolveList!: (value: StockPreparationSnapshotBatchListResult) => void
    h.listBatches.mockReturnValue(
      new Promise<StockPreparationSnapshotBatchListResult>((resolve) => {
        resolveList = resolve
      }),
    )

    const root = mountView()
    await nextTick()
    // Pending: loading indicator only, no data/empty/error.
    expect(root.querySelector('[data-testid="stock-prep-snapshot-loading"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-error"]')).toBeNull()

    resolveList(batchListWithPlantedExtras())
    await flushUi()

    // Settled: overview + rows, loading gone.
    expect(root.querySelector('[data-testid="stock-prep-snapshot-loading"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-overview"]')).not.toBeNull()
    const rows = root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-row"]')
    expect(rows.length).toBe(2)

    // Values-free fields DO render: status enum, counts, internal run handle, recorded indicator.
    const text = root.textContent || ''
    expect(text).toContain('active')
    expect(text).toContain('superseded')
    expect(text).toContain('sync-run-alpha')
    expect(root.querySelector('[data-testid="stock-prep-snapshot-summary"]')?.textContent).toContain('2')
    expect(root.querySelector('[data-testid="stock-prep-snapshot-recorded"]')?.textContent).toContain('已记录')

    // Default: no batch selected → neutral hint, no diff panel yet, diff GET not issued.
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-hint"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff"]')).toBeNull()
    expect(h.getDiff).not.toHaveBeenCalled()

    // The list GET was issued exactly once, scoped to the project handle (readonly, no write retry).
    expect(h.listBatches).toHaveBeenCalledTimes(1)
    expect(h.listBatches).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-alpha' }))

    // Values-free guard: no planted business value ever reaches the DOM.
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders the empty state when the project has no snapshot batches yet', async () => {
    h.listBatches.mockResolvedValue({ projectId: 'proj-alpha', batchCount: 0, batches: [] })
    const root = mountView()
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-snapshot-empty"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-loading"]')).toBeNull()
  })

  it('renders a neutral error state when the list GET rejects (404-soft), never the raw error body', async () => {
    const rawBody = 'connectionString=host=erp;pwd=secret-42007;'
    h.listBatches.mockRejectedValue(new Error(`404 Not Found ${rawBody}`))
    const root = mountView()
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-snapshot-error"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-loading"]')).toBeNull()

    // The raw error body (status text, connection string, secret) must NOT be surfaced.
    const text = root.textContent || ''
    expect(text).not.toContain(rawBody)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('404')
    expect(text).not.toMatch(/\d{5,}/)
  })

  it('renders the English neutral error copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    h.listBatches.mockRejectedValue(new Error('boom'))
    const root = mountView()
    await flushUi()
    const errorEl = root.querySelector('[data-testid="stock-prep-snapshot-error"]') as HTMLElement
    expect(errorEl).not.toBeNull()
    expect(errorEl.textContent).toMatch(/not ready/i)
  })

  it('shows the select-a-project state and issues NO GET when no projectId is provided', async () => {
    const root = mountView({})
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-snapshot-no-project"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-loading"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-error"]')).toBeNull()
    // No project handle → no readonly GET at all.
    expect(h.listBatches).not.toHaveBeenCalled()
  })

  it('loads and renders the values-free diff summary when a batch is selected', async () => {
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()

    const selectButtons = root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')
    expect(selectButtons.length).toBe(2)
    ;(selectButtons[0] as HTMLButtonElement).click()
    await flushUi()

    // Diff GET issued once for the clicked batch id (readonly).
    expect(h.getDiff).toHaveBeenCalledTimes(1)
    expect(h.getDiff).toHaveBeenCalledWith('batch-alpha', expect.anything())

    const diffPanel = root.querySelector('[data-testid="stock-prep-snapshot-diff"]') as HTMLElement
    expect(diffPanel).not.toBeNull()
    // Hint gone once a diff is shown.
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-hint"]')).toBeNull()

    // All eight change-count kinds render.
    const counts = root.querySelectorAll('[data-testid="stock-prep-snapshot-diff-count"]')
    expect(counts.length).toBe(8)
    const kinds = Array.from(counts).map((el) => el.getAttribute('data-kind'))
    expect(kinds).toEqual([
      'added',
      'removed',
      'quantityChanged',
      'unitChanged',
      'versionChanged',
      'pathChanged',
      'missingChildBom',
      'fingerprintChanged',
    ])

    // Blocking-exception count + base-batch handle render (base = predecessor).
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-blocking"]')?.textContent).toContain('1')
    const baseEl = root.querySelector('[data-testid="stock-prep-snapshot-diff-base"]') as HTMLElement
    expect(baseEl.textContent).toContain('batch-beta')
  })

  it('shows "no predecessor" when the selected batch has no base batch', async () => {
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    h.getDiff.mockResolvedValue({ ...diffSummary(), baseSnapshotBatchId: null })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement).click()
    await flushUi()

    const baseEl = root.querySelector('[data-testid="stock-prep-snapshot-diff-base"]') as HTMLElement
    expect(baseEl).not.toBeNull()
    expect(baseEl.textContent).toContain('无前序批次')
  })

  it('renders a neutral diff-error state when the diff GET rejects (404-soft)', async () => {
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    h.getDiff.mockRejectedValue(new Error('404 Not Found pwd=secret-99'))
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement).click()
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-diff-error"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff"]')).toBeNull()
    const text = root.textContent || ''
    expect(text).not.toContain('secret')
    expect(text).not.toContain('404')
  })

  it('marks an incomplete batch with a values-free badge and disables its diff entry', async () => {
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()

    // Exactly ONE incomplete badge (only batch-beta is incomplete), boolean-derived copy only.
    const badges = root.querySelectorAll('[data-testid="stock-prep-snapshot-incomplete-badge"]')
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toContain('不完整')
    // The badge sits in the incomplete row, not the complete one.
    const rows = root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-row"]')
    expect(rows[0].querySelector('[data-testid="stock-prep-snapshot-incomplete-badge"]')).toBeNull()
    expect(rows[1].querySelector('[data-testid="stock-prep-snapshot-incomplete-badge"]')).not.toBeNull()

    // Complete batch keeps a live diff entry; the incomplete batch's entry is disabled.
    const selectButtons = root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')
    expect((selectButtons[0] as HTMLButtonElement).disabled).toBe(false)
    expect((selectButtons[1] as HTMLButtonElement).disabled).toBe(true)

    // Activating the incomplete batch's entry never issues the diff GET (disabled + guard).
    ;(selectButtons[1] as HTMLButtonElement).click()
    await flushUi()
    expect(h.getDiff).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-hint"]')).not.toBeNull()
  })

  it('renders the English incomplete badge copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    const root = mountView()
    await flushUi()
    const badge = root.querySelector('[data-testid="stock-prep-snapshot-incomplete-badge"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toMatch(/incomplete/i)
  })

  it('never renders a planted business value even after a batch is selected (values-free)', async () => {
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement).click()
    await flushUi()

    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  // ── view-2 per-row drill-down (/diff/rows) ─────────────────────────────────────────────────────
  async function mountWithDiffShown(): Promise<HTMLDivElement> {
    h.listBatches.mockResolvedValue(batchListWithPlantedExtras())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement).click()
    await flushUi()
    return root
  }

  it('does NOT fetch the row detail until the operator opens it (lazy)', async () => {
    h.listRows.mockResolvedValue(diffRowsResult())
    const root = await mountWithDiffShown()
    // Summary is shown; the rows GET has not been issued, and the table is absent.
    expect(h.listRows).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows"]')).toBeNull()
    const toggle = root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-toggle"]')
    expect(toggle).not.toBeNull()
  })

  it('opening the detail loads and renders the values-free diff rows on demand', async () => {
    h.listRows.mockResolvedValue(diffRowsResult())
    const root = await mountWithDiffShown()
    await openRowDetail(root)

    expect(h.listRows).toHaveBeenCalledTimes(1)
    // Scope carries the projectId; the batch id is the first arg.
    expect(h.listRows.mock.calls[0][0]).toBe('batch-alpha')
    const rows = root.querySelectorAll('[data-testid="stock-prep-snapshot-diff-row"]')
    expect(rows.length).toBe(2)

    const text = root.textContent || ''
    // Values-free fields DO render: handle, enums, counts, opaque fingerprint prefix.
    expect(text).toContain('diff-one')
    expect(text).toContain('held')
    expect(text).toContain('added')
    expect(text).toContain('sha16:0123456789abcdef') // the full opaque sha16 handle (22 chars) — was the misleading 4-hex slice
    // The meta line surfaces the counts.
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-meta"]')?.textContent).toContain('2')
  })

  it('never renders a planted business value in the row detail (values-free)', async () => {
    h.listRows.mockResolvedValue(diffRowsResult())
    const root = await mountWithDiffShown()
    await openRowDetail(root)

    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('404-softs the row detail: neutral error state, never the raw body, table absent', async () => {
    h.listRows.mockRejectedValue(new Error('secret-backend-detail MAT-ZX9911'))
    const root = await mountWithDiffShown()
    await openRowDetail(root)

    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-error"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-table"]')).toBeNull()
    expect(root.textContent || '').not.toContain('secret-backend-detail')
  })

  it('renders the empty state when the batch has zero diff rows', async () => {
    h.listRows.mockResolvedValue({ snapshotBatchId: 'batch-alpha', baseSnapshotBatchId: null, rowCount: 0, heldRowCount: 0, rows: [] })
    const root = await mountWithDiffShown()
    await openRowDetail(root)

    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-empty"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-table"]')).toBeNull()
  })

  // Mount with TWO complete batches; select the first (batch-alpha) and show its summary.
  async function mountWithTwoBatches(): Promise<HTMLDivElement> {
    h.listBatches.mockResolvedValue(batchListTwoComplete())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()
    ;(root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')[0] as HTMLButtonElement).click()
    await flushUi()
    return root
  }

  it('a REAL batch switch (A→B) collapses the detail and re-fetches B fresh — B never shows A rows', async () => {
    h.listRows.mockImplementation((batchId: string) =>
      Promise.resolve(batchId === 'batch-gamma' ? diffRowsResult('diff-gamma', 'batch-gamma') : diffRowsResult('diff-alpha', 'batch-alpha')),
    )
    const root = await mountWithTwoBatches()
    await openRowDetail(root)
    expect(h.listRows).toHaveBeenCalledTimes(1)
    expect(root.textContent).toContain('diff-alpha-one')

    // Select the SECOND batch (batch-gamma) — a real switch. The detail collapses.
    ;(root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')[1] as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows"]')).toBeNull()

    // Re-open → a FRESH fetch keyed on batch-gamma; it shows gamma rows, never alpha's.
    await openRowDetail(root)
    expect(h.listRows).toHaveBeenCalledTimes(2)
    expect(h.listRows.mock.calls[1][0]).toBe('batch-gamma')
    expect(root.textContent).toContain('diff-gamma-one')
    expect(root.textContent).not.toContain('diff-alpha-one')
  })

  it('a slow A response arriving AFTER switching to B is discarded (monotonic guard, not cached under B)', async () => {
    // Batch A's rows load is DEFERRED; B's resolves immediately.
    let releaseAlpha!: (v: unknown) => void
    h.listRows.mockImplementation((batchId: string) => {
      if (batchId === 'batch-alpha') return new Promise((resolve) => { releaseAlpha = resolve })
      return Promise.resolve(diffRowsResult('diff-gamma', 'batch-gamma'))
    })
    const root = await mountWithTwoBatches()
    await openRowDetail(root) // opens A → A's rows GET is in flight (deferred)
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-loading"]')).not.toBeNull()

    // Switch to B while A is still pending, and open + resolve B.
    ;(root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')[1] as HTMLButtonElement).click()
    await flushUi()
    await openRowDetail(root)
    expect(root.textContent).toContain('diff-gamma-one')

    // NOW A's slow response finally arrives — it must be dropped, NOT cached under B.
    releaseAlpha(diffRowsResult('diff-alpha', 'batch-alpha'))
    await flushUi()
    expect(root.textContent).toContain('diff-gamma-one')
    expect(root.textContent).not.toContain('diff-alpha-one')
  })

  // ── sibling async loaders: batch-LIST and diff-SUMMARY must drop stale responses too ─────────────
  // Mount with a REACTIVE projectId so a project switch (the watch) can be driven within one instance.
  function mountReactiveProject(projectIdRef: { value: string }): HTMLDivElement {
    app = createApp({ render: () => renderH(StockPreparationSnapshotDiffView as Component, { projectId: projectIdRef.value }) })
    app.mount(container!)
    return container!
  }

  it('a slow batch-LIST response for project A, arriving after switching to B, is dropped (not shown under B)', async () => {
    let releaseA!: (v: StockPreparationSnapshotBatchListResult) => void
    h.listBatches.mockImplementation((scope: { projectId?: string }) => {
      if (scope.projectId === 'proj-A') return new Promise((resolve) => { releaseA = resolve })
      return Promise.resolve({ projectId: 'proj-B', batchCount: 1, batches: [
        { snapshotBatchId: 'batch-in-B', snapshotVersion: 1, snapshotStatus: 'active', syncRunId: 'sync-B', lineCount: 2, createdAtPresent: true, incomplete: false },
      ] } as unknown as StockPreparationSnapshotBatchListResult)
    })
    const projectIdRef = ref('proj-A')
    const root = mountReactiveProject(projectIdRef)
    await nextTick() // project A's list GET is in flight (deferred)

    projectIdRef.value = 'proj-B' // switch — watch fires loadBatches(B), which resolves immediately
    await flushUi()
    expect(root.textContent).toContain('sync-B')

    // A's slow list finally arrives — must be dropped, NOT rendered over B's list.
    releaseA({ projectId: 'proj-A', batchCount: 1, batches: [
      { snapshotBatchId: 'batch-in-A', snapshotVersion: 1, snapshotStatus: 'active', syncRunId: 'sync-A', lineCount: 2, createdAtPresent: true, incomplete: false },
    ] } as unknown as StockPreparationSnapshotBatchListResult)
    await flushUi()
    expect(root.textContent).toContain('sync-B')
    expect(root.textContent).not.toContain('sync-A')
  })

  it('a slow diff-SUMMARY response for batch A, arriving after selecting B, is dropped (not shown under B)', async () => {
    let releaseA!: (v: StockPreparationSnapshotDiffSummary) => void
    h.listBatches.mockResolvedValue(batchListTwoComplete())
    h.getDiff.mockImplementation((batchId: string) => {
      if (batchId === 'batch-alpha') return new Promise((resolve) => { releaseA = resolve })
      return Promise.resolve(diffSummary('base-of-gamma'))
    })
    const root = mountView()
    await flushUi()
    ;(root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')[0] as HTMLButtonElement).click() // select A → summary in flight
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-diff-loading"]')).not.toBeNull()

    ;(root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')[1] as HTMLButtonElement).click() // select B → resolves
    await flushUi()
    expect(root.textContent).toContain('base-of-gamma')

    // A's slow summary finally arrives — must be dropped, NOT overwrite B's summary.
    releaseA(diffSummary('base-of-alpha'))
    await flushUi()
    expect(root.textContent).toContain('base-of-gamma')
    expect(root.textContent).not.toContain('base-of-alpha')
  })

  // A→B→A: the id-match check alone (projectId/batchId) CANNOT catch this — after returning to A, the id
  // is A again, so only the monotonic SEQ distinguishes the stale first-A load from the fresh third one.
  it('batch-LIST A→B→A: the STALE first-A response is dropped even after returning to project A', async () => {
    let releaseA1!: (v: StockPreparationSnapshotBatchListResult) => void
    let aCall = 0
    const listFor = (proj: string, run: string) => ({ projectId: proj, batchCount: 1, batches: [
      { snapshotBatchId: `batch-${run}`, snapshotVersion: 1, snapshotStatus: 'active', syncRunId: run, lineCount: 2, createdAtPresent: true, incomplete: false },
    ] } as unknown as StockPreparationSnapshotBatchListResult)
    h.listBatches.mockImplementation((scope: { projectId?: string }) => {
      if (scope.projectId === 'proj-A') {
        aCall += 1
        if (aCall === 1) return new Promise((resolve) => { releaseA1 = resolve }) // stale first-A load
        return Promise.resolve(listFor('proj-A', 'sync-A-fresh')) // fresh third load
      }
      return Promise.resolve(listFor('proj-B', 'sync-B'))
    })
    const projectIdRef = ref('proj-A')
    const root = mountReactiveProject(projectIdRef)
    await nextTick() // first-A load in flight (deferred)
    projectIdRef.value = 'proj-B'; await flushUi()
    projectIdRef.value = 'proj-A'; await flushUi() // back to A → fresh third load resolves
    expect(root.textContent).toContain('sync-A-fresh')

    releaseA1(listFor('proj-A', 'sync-A-stale')) // stale first-A now arrives — must be dropped
    await flushUi()
    expect(root.textContent).toContain('sync-A-fresh')
    expect(root.textContent).not.toContain('sync-A-stale')
  })

  it('diff-SUMMARY A→B→A: the STALE first-batch-A summary is dropped even after re-selecting batch A', async () => {
    let releaseA1!: (v: StockPreparationSnapshotDiffSummary) => void
    let aCall = 0
    h.listBatches.mockResolvedValue(batchListTwoComplete())
    h.getDiff.mockImplementation((batchId: string) => {
      if (batchId === 'batch-alpha') {
        aCall += 1
        if (aCall === 1) return new Promise((resolve) => { releaseA1 = resolve }) // stale first select-A
        return Promise.resolve(diffSummary('base-alpha-fresh')) // fresh third select-A
      }
      return Promise.resolve(diffSummary('base-gamma'))
    })
    const root = mountView()
    await flushUi()
    const sel = () => root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-select"]')
    ;(sel()[0] as HTMLButtonElement).click(); await flushUi() // select A → summary #1 deferred
    ;(sel()[1] as HTMLButtonElement).click(); await flushUi() // select B → resolves
    ;(sel()[0] as HTMLButtonElement).click(); await flushUi() // re-select A → fresh summary #3 resolves
    expect(root.textContent).toContain('base-alpha-fresh')

    releaseA1(diffSummary('base-alpha-stale')) // stale first-A summary now arrives — must be dropped
    await flushUi()
    expect(root.textContent).toContain('base-alpha-fresh')
    expect(root.textContent).not.toContain('base-alpha-stale')
  })
})
