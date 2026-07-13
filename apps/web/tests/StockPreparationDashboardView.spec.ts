import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Stock Preparation UI humanization H1/H2 (H0 plane-boundary design-lock PR #4202 — PLANE A ONLY).
// StockPreparationDashboardView is the "task-oriented entry": a project picker (H1) + a current-project
// chip + the recommended-next-step banner (H1) + the embedded six-stage stepper (H2). Mocks the
// underlying service MODULES directly (same idiom as StockPreparationProjectWorkspaceView.spec.ts) —
// not apiFetch — since this spec is about rendering/orchestration, not wire-level request shape (the
// existing per-view specs already pin each service's own request wiring).

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  getOverview: vi.fn(),
  listSnapshotBatches: vi.fn(),
  getMappingSummary: vi.fn(),
  getUnitSummary: vi.fn(),
  listPrepLines: vi.fn(),
  listExceptions: vi.fn(),
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
vi.mock('../src/services/integration/stockPreparation/bomSnapshotDiff', () => ({
  listStockPreparationSnapshotBatches: h.listSnapshotBatches,
}))
vi.mock('../src/services/integration/stockPreparation/materialMapping', () => ({
  getStockPreparationMaterialMappingSummary: h.getMappingSummary,
}))
vi.mock('../src/services/integration/stockPreparation/unitConversion', () => ({
  getStockPreparationUnitConversionSummary: h.getUnitSummary,
}))
vi.mock('../src/services/integration/stockPreparation/prepLine', () => ({
  listStockPreparationPrepLines: h.listPrepLines,
}))
vi.mock('../src/services/integration/stockPreparation/exceptionQueue', () => ({
  listStockPreparationExceptions: h.listExceptions,
}))
// confirmApi.ts is intentionally NOT mocked — the component's `instanceof StockPreparationConfirmApiError`
// forbidden-detection must see the REAL class, and this test constructs real instances of it below.

import StockPreparationDashboardView from '../src/components/integration/stockPreparation/StockPreparationDashboardView.vue'
import { StockPreparationConfirmApiError } from '../src/services/integration/stockPreparation/confirmApi'
import type { StockPreparationWorkspaceOverview } from '../src/services/integration/stockPreparation/projectWorkspace'

// Business values planted as EXTRA fields — a values-free view must render NONE of them.
const PLANTED_DRAWING_NO = 'DWG-77104-Z'
const PLANTED_MATERIAL_NAME = '齿轮箱总成'
const FORBIDDEN_SUBSTRINGS = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_NAME, 'password', 'secret', 'connectionString']

function buildOverview(openExceptionCount = 0): StockPreparationWorkspaceOverview {
  return {
    projectCount: 1,
    statusCounts: { active: 1 },
    projects: [
      {
        projectId: 'proj-alpha',
        projectStatus: 'active',
        lastSyncRunId: 'run-handle-alpha',
        snapshotBatchCount: 2,
        openExceptionCount,
        readyLineCount: 3,
        heldLineCount: 0,
        // Planted business values (not part of the type) — must never reach the DOM.
        drawingNo: PLANTED_DRAWING_NO,
        materialName: PLANTED_MATERIAL_NAME,
      },
    ],
  } as unknown as StockPreparationWorkspaceOverview
}

function mockClearStageReads(): void {
  h.listSnapshotBatches.mockResolvedValue({
    projectId: 'proj-alpha',
    batchCount: 2,
    batches: [
      { snapshotBatchId: 'b1', snapshotVersion: 1, snapshotStatus: 'active', syncRunId: 'r1', lineCount: 3, createdAtPresent: true, incomplete: false },
      { snapshotBatchId: 'b2', snapshotVersion: 2, snapshotStatus: 'active', syncRunId: 'r2', lineCount: 3, createdAtPresent: true, incomplete: false },
    ],
  })
  h.getMappingSummary.mockResolvedValue({
    totalMappingCount: 5, activeMappingCount: 5,
    matchStatusCounts: { matched: 5, pending_confirm: 0, multi_candidate: 0, not_found: 0, version_conflict: 0 },
    versionPolicyCounts: { drawing_and_version: 5, drawing_only: 0, category_rule: 0, manual: 0 },
    pendingConfirmCount: 0,
  })
  h.getUnitSummary.mockResolvedValue({
    totalRuleCount: 2, activeRuleCount: 2, requiresConfirmationCount: 0,
    scopeTypeCounts: { material: 2, category: 0, generic: 0 },
    roundingRuleCounts: { none: 2, ceil: 0, floor: 0, nearest: 0, pack_size: 0 },
    pendingUnitLineCount: 0,
  })
  h.listPrepLines.mockResolvedValue({
    rowCount: 3, byPrepStatus: { draft: 3, held: 0 },
    byMappingStatus: { matched: 3, pending_confirm: 0, multi_candidate: 0, not_found: 0, version_conflict: 0 },
    byUnitStatus: { converted: 3, missing_rule: 0, conflict: 0 },
    rows: [],
  })
  h.listExceptions.mockResolvedValue({
    rowCount: 0, unresolvedBlockingCount: 0, byType: {}, byStatus: {}, bySeverity: {}, rows: [],
  })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationDashboardView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.getOverview.mockReset()
    h.listSnapshotBatches.mockReset()
    h.getMappingSummary.mockReset()
    h.getUnitSummary.mockReset()
    h.listPrepLines.mockReset()
    h.listExceptions.mockReset()
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

  function mountView(props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(StockPreparationDashboardView as Component, props)
    app.mount(container!)
    return container!
  }

  it('shows the loading state before the project overview settles', async () => {
    let resolveOverview!: (value: StockPreparationWorkspaceOverview) => void
    h.getOverview.mockReturnValue(new Promise((resolve) => { resolveOverview = resolve }))
    const root = mountView()
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-loading"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-body"]')).toBeNull()
    resolveOverview(buildOverview())
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-loading"]')).toBeNull()
  })

  it('renders a neutral error state when the overview GET rejects, never the raw error body', async () => {
    const rawBody = 'connectionString=host=erp;pwd=secret-42007;'
    h.getOverview.mockRejectedValue(new Error(`404 Not Found ${rawBody}`))
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-error"]')).not.toBeNull()
    const text = root.textContent || ''
    expect(text).not.toContain(rawBody)
    expect(text).not.toContain('secret')
  })

  it('renders the empty state when no projects are synced yet', async () => {
    h.getOverview.mockResolvedValue({ projectCount: 0, statusCounts: {}, projects: [] })
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-empty"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-body"]')).toBeNull()
  })

  it('prompts to select a project when none is chosen, and does not fetch the five stage reads', async () => {
    h.getOverview.mockResolvedValue(buildOverview())
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-picker"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-no-project"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-recommend"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-stepper"]')).toBeNull()
    expect(h.listSnapshotBatches).not.toHaveBeenCalled()
  })

  it('emits select-project (not navigate-stage) when the picker is used — stays on the dashboard', async () => {
    h.getOverview.mockResolvedValue(buildOverview())
    mockClearStageReads()
    const onSelectProject = vi.fn()
    const onNavigateStage = vi.fn()
    const root = mountView({ onSelectProject, onNavigateStage })
    await flushUi()

    const select = root.querySelector('[data-testid="stock-prep-dashboard-project-select"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    select.value = 'proj-alpha'
    select.dispatchEvent(new Event('change'))
    await flushUi()

    expect(onSelectProject).toHaveBeenCalledWith('proj-alpha')
    expect(onNavigateStage).not.toHaveBeenCalled()
    // The projectId handle rides the <option> VALUE only — never visible text.
    expect(root.textContent || '').not.toContain('proj-alpha')
  })

  it('renders the current-project chip + stepper + a blocked recommendation when admin detail succeeds', async () => {
    h.getOverview.mockResolvedValue(buildOverview())
    mockClearStageReads()
    // Override mapping summary so "map" is the one blocked stage (highest priority in the walk).
    h.getMappingSummary.mockResolvedValue({
      totalMappingCount: 5, activeMappingCount: 5,
      matchStatusCounts: { matched: 2, pending_confirm: 3, multi_candidate: 0, not_found: 0, version_conflict: 0 },
      versionPolicyCounts: { drawing_and_version: 5, drawing_only: 0, category_rule: 0, manual: 0 },
      pendingConfirmCount: 3,
    })
    const onNavigateStage = vi.fn()
    const root = mountView({ projectId: 'proj-alpha', onNavigateStage })
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-dashboard-current"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-current-status"]')?.textContent).toContain('active')
    expect(root.querySelector('[data-testid="stock-prep-dashboard-current-run"]')?.textContent).toContain('run-handle-alpha')

    const stepper = root.querySelector('[data-testid="stock-prep-stage-stepper"]')
    expect(stepper).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-blocking-map"]')?.textContent).toContain('3')

    const recommend = root.querySelector('[data-testid="stock-prep-dashboard-recommend"]') as HTMLElement
    expect(recommend.getAttribute('data-kind')).toBe('go_to_stage')
    expect(recommend.textContent).toContain('3')

    const action = root.querySelector('[data-testid="stock-prep-dashboard-recommend-action"]') as HTMLButtonElement
    expect(action).not.toBeNull()
    action.click()
    expect(onNavigateStage).toHaveBeenCalledWith('material-mapping')
  })

  it('degrades gracefully (never errors) when the five admin-gated reads are forbidden, and falls back to tier-1', async () => {
    // openExceptionCount:2 on the read-gated /projects row drives the tier-1 fallback recommendation.
    h.getOverview.mockResolvedValue(buildOverview(2))
    h.listSnapshotBatches.mockRejectedValue(new Error('Insufficient integration permissions'))
    h.getMappingSummary.mockRejectedValue(new Error('Insufficient integration permissions'))
    h.getUnitSummary.mockRejectedValue(new Error('Insufficient integration permissions'))
    h.listPrepLines.mockRejectedValue(new StockPreparationConfirmApiError(403, 'FORBIDDEN', null))
    h.listExceptions.mockRejectedValue(new StockPreparationConfirmApiError(403, 'FORBIDDEN', null))

    const root = mountView({ projectId: 'proj-alpha' })
    await flushUi()

    // Provision is unaffected (read-gated) — the stepper still renders all six slots.
    const items = root.querySelectorAll('[data-testid="stock-prep-stage-item"]')
    expect(items.length).toBe(6)
    expect(root.querySelector('[data-status="forbidden"][data-stage="sync"]')).not.toBeNull()
    expect(root.querySelector('[data-status="forbidden"][data-stage="map"]')).not.toBeNull()
    expect(root.querySelector('[data-status="forbidden"][data-stage="unit"]')).not.toBeNull()
    expect(root.querySelector('[data-status="forbidden"][data-stage="generate"]')).not.toBeNull()
    expect(root.querySelector('[data-status="forbidden"][data-stage="exception"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-stage-forbidden-exception"]')).not.toBeNull()

    // Recommended step falls back to the tier-1 rule sourced from the read-gated /projects counts.
    const recommend = root.querySelector('[data-testid="stock-prep-dashboard-recommend"]') as HTMLElement
    expect(recommend.textContent).toContain('2')
  })

  it('is values-free: planted business-looking strings on the project row never render', async () => {
    h.getOverview.mockResolvedValue(buildOverview())
    mockClearStageReads()
    const root = mountView({ projectId: 'proj-alpha' })
    await flushUi()
    const text = root.textContent || ''
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('renders English copy when locale is not zh-CN', async () => {
    h.locale = 'en'
    h.getOverview.mockResolvedValue(buildOverview())
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-no-project"]')?.textContent).toMatch(/select a project/i)
  })
})
