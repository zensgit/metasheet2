import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Frontend MVP view 1: the readonly PROJECT WORKSPACE view. Covers the loading → data render,
// empty, and error/404-soft states, and pins the values-free contract: the view renders only
// counts / status enums / an internal run handle, never a customer business value, and never the
// raw error body. Mirrors the shell spec's mocking idiom (vi.hoisted holder + mocked locale).

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  getOverview: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/services/integration/stockPreparation/projectWorkspace', () => ({
  getStockPreparationWorkspaceOverview: h.getOverview,
}))

import StockPreparationProjectWorkspaceView from '../src/components/integration/stockPreparation/StockPreparationProjectWorkspaceView.vue'
import type { StockPreparationWorkspaceOverview } from '../src/services/integration/stockPreparation/projectWorkspace'

// Business values planted as EXTRA fields on the mocked rows. A values-free view must render NONE
// of them — proving it reads a fixed whitelist rather than stringifying the row.
const PLANTED_DRAWING_NO = 'DWG-88472-A'
const PLANTED_MATERIAL_CODE = 'MAT-ZX9911'
const PLANTED_PROJECT_NAME = '涡轮增压器总成'
const PLANTED_QUANTITY = '73920'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_CODE, PLANTED_PROJECT_NAME, PLANTED_QUANTITY]

function overviewWithPlantedExtras(): StockPreparationWorkspaceOverview {
  // lastSyncRunId is intentionally digit-free so a stray digit guard cannot false-positive on it.
  return {
    projectCount: 2,
    statusCounts: { active: 1, paused: 1 },
    projects: [
      {
        projectId: 'proj-alpha',
        projectStatus: 'active',
        lastSyncRunId: 'sync-run-alpha',
        snapshotBatchCount: 4,
        openExceptionCount: 1,
        readyLineCount: 12,
        heldLineCount: 3,
        // Planted business values (not part of the type) — must never reach the DOM.
        drawingNo: PLANTED_DRAWING_NO,
        materialCode: PLANTED_MATERIAL_CODE,
        projectName: PLANTED_PROJECT_NAME,
        quantity: PLANTED_QUANTITY,
      },
      {
        projectId: 'proj-beta',
        projectStatus: 'paused',
        lastSyncRunId: null,
        snapshotBatchCount: 0,
        openExceptionCount: 0,
        readyLineCount: 0,
        heldLineCount: 0,
      },
    ],
  } as unknown as StockPreparationWorkspaceOverview
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationProjectWorkspaceView (readonly, values-free)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.getOverview.mockReset()
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

  function mountView(): HTMLDivElement {
    app = createApp(StockPreparationProjectWorkspaceView as Component)
    app.mount(container!)
    return container!
  }

  it('shows the loading state before the readonly GET settles, then renders the data view', async () => {
    let resolveOverview!: (value: StockPreparationWorkspaceOverview) => void
    h.getOverview.mockReturnValue(
      new Promise<StockPreparationWorkspaceOverview>((resolve) => {
        resolveOverview = resolve
      }),
    )

    const root = mountView()
    await nextTick()
    // Pending: loading indicator only, no data/empty/error.
    expect(root.querySelector('[data-testid="stock-prep-project-loading"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-error"]')).toBeNull()

    resolveOverview(overviewWithPlantedExtras())
    await flushUi()

    // Settled: data view, loading gone.
    expect(root.querySelector('[data-testid="stock-prep-project-loading"]')).toBeNull()
    const overview = root.querySelector('[data-testid="stock-prep-project-overview"]')
    expect(overview).not.toBeNull()

    const rows = root.querySelectorAll('[data-testid="stock-prep-project-row"]')
    expect(rows.length).toBe(2)

    // Values-free fields DO render: status enum, counts, and the internal run handle.
    const text = root.textContent || ''
    expect(text).toContain('active')
    expect(text).toContain('paused')
    expect(text).toContain('sync-run-alpha')
    expect(text).toContain('12') // readyLineCount
    // Header summary carries projectCount + statusCounts.
    expect(root.querySelector('[data-testid="stock-prep-project-summary"]')?.textContent).toContain('2')

    // Values-free guard: no planted business value ever reaches the DOM.
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
    // The GET was issued exactly once (readonly, no write retry loop).
    expect(h.getOverview).toHaveBeenCalledTimes(1)
  })

  it('renders the empty state when no projects are synced yet', async () => {
    h.getOverview.mockResolvedValue({ projectCount: 0, statusCounts: {}, projects: [] })
    const root = mountView()
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-project-empty"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-loading"]')).toBeNull()
  })

  it('renders a neutral error state when the GET rejects (404-soft), never the raw error body', async () => {
    const rawBody = 'connectionString=host=erp;pwd=secret-42007;'
    h.getOverview.mockRejectedValue(new Error(`404 Not Found ${rawBody}`))
    const root = mountView()
    await flushUi()

    const errorEl = root.querySelector('[data-testid="stock-prep-project-error"]')
    expect(errorEl).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-overview"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-loading"]')).toBeNull()

    // The raw error body (status text, connection string, secret) must NOT be surfaced.
    const text = root.textContent || ''
    expect(text).not.toContain(rawBody)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('404')
    expect(text).not.toMatch(/\d{5,}/)
  })

  it('renders the English neutral error copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    h.getOverview.mockRejectedValue(new Error('boom'))
    const root = mountView()
    await flushUi()
    const errorEl = root.querySelector('[data-testid="stock-prep-project-error"]') as HTMLElement
    expect(errorEl).not.toBeNull()
    expect(errorEl.textContent).toMatch(/not ready/i)
  })
})
