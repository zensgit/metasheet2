import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

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
        // Planted business values (not part of the type) — must never reach the DOM.
        drawingNo: PLANTED_DRAWING_NO,
        materialCode: PLANTED_MATERIAL_CODE,
        projectName: PLANTED_PROJECT_NAME,
        quantity: PLANTED_QUANTITY,
      },
      {
        snapshotBatchId: 'batch-beta',
        snapshotVersion: 2,
        snapshotStatus: 'superseded',
        syncRunId: null,
        lineCount: 4,
        createdAtPresent: false,
      },
    ],
  } as unknown as StockPreparationSnapshotBatchListResult
}

function diffSummary(): StockPreparationSnapshotDiffSummary {
  return {
    snapshotBatchId: 'batch-alpha',
    baseSnapshotBatchId: 'batch-beta',
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

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationSnapshotDiffView (readonly, values-free)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.listBatches.mockReset()
    h.getDiff.mockReset()
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
})
