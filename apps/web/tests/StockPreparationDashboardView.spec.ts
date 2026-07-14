import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as renderH, nextTick, ref, type App as VueApp, type Component } from 'vue'

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

  it('H4-1: the error state offers a Retry that re-runs the overview load and recovers', async () => {
    h.getOverview.mockRejectedValueOnce(new Error('503 backend not ready'))
    h.getOverview.mockResolvedValue(buildOverview()) // the retry succeeds
    const root = mountView()
    await flushUi()
    const retry = root.querySelector('[data-testid="stock-prep-dashboard-retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-error"]')).not.toBeNull()
    const callsBefore = h.getOverview.mock.calls.length
    retry!.click()
    await flushUi()
    expect(h.getOverview.mock.calls.length).toBeGreaterThan(callsBefore) // loadOverview was re-invoked
    expect(root.querySelector('[data-testid="stock-prep-dashboard-error"]')).toBeNull() // error state cleared
    expect(root.querySelector('[data-testid="stock-prep-dashboard-body"]')).not.toBeNull() // renders normally after recovery
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

  // #4207 stricter terminal semantics (owner review 2026-07-13): admin reads that fail for a
  // NON-permission reason (not 403) leave adminDetailAvailable true but the stages 'unknown'. The banner
  // must say the detail is incomplete — never a reassuring all_clear, never "admin required".
  it('shows an explicit "detail incomplete" recommendation when the admin reads fail for a non-permission reason', async () => {
    h.getOverview.mockResolvedValue(buildOverview(0)) // CLEAN tier-1 signals — a wrong fallback would say all_clear
    h.listSnapshotBatches.mockRejectedValue(new Error('backend not ready'))
    h.getMappingSummary.mockRejectedValue(new Error('backend not ready'))
    h.getUnitSummary.mockRejectedValue(new Error('backend not ready'))
    h.listPrepLines.mockRejectedValue(new StockPreparationConfirmApiError(500, 'BACKEND_NOT_READY', null))
    h.listExceptions.mockRejectedValue(new StockPreparationConfirmApiError(500, 'BACKEND_NOT_READY', null))

    const root = mountView({ projectId: 'proj-alpha' })
    await flushUi()

    const recommend = root.querySelector('[data-testid="stock-prep-dashboard-recommend"]') as HTMLElement
    expect(recommend.getAttribute('data-kind')).toBe('detail_unavailable')
    expect(recommend.textContent).toContain('部分阶段详情') // the honest "read incomplete" copy
    expect(recommend.textContent).not.toContain('没有需要处理') // never the false all_clear
    expect(recommend.textContent).not.toContain('需要管理员权限') // and not mislabelled as a permission problem
  })

  // ── H4-1: detail-stage retry (only for a transient detail_unavailable, never a 403) ──────────────
  function mockDetailUnavailable(): void {
    h.getOverview.mockResolvedValue(buildOverview(0))
    h.listSnapshotBatches.mockRejectedValue(new Error('backend not ready'))
    h.getMappingSummary.mockRejectedValue(new Error('backend not ready'))
    h.getUnitSummary.mockRejectedValue(new Error('backend not ready'))
    h.listPrepLines.mockRejectedValue(new StockPreparationConfirmApiError(500, 'BACKEND_NOT_READY', null))
    h.listExceptions.mockRejectedValue(new StockPreparationConfirmApiError(500, 'BACKEND_NOT_READY', null))
  }

  it('H4-1: detail_unavailable offers a Retry that re-runs loadStageDetail and recovers', async () => {
    mockDetailUnavailable()
    const root = mountView({ projectId: 'proj-alpha' })
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-dashboard-recommend"]')?.getAttribute('data-kind')).toBe('detail_unavailable')
    const retry = root.querySelector('[data-testid="stock-prep-dashboard-detail-retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    mockClearStageReads() // the retry succeeds
    const before = h.listSnapshotBatches.mock.calls.length
    retry!.click()
    await flushUi()
    expect(h.listSnapshotBatches.mock.calls.length).toBeGreaterThan(before) // loadStageDetail re-invoked
    expect(root.querySelector('[data-testid="stock-prep-dashboard-recommend"]')?.getAttribute('data-kind')).not.toBe('detail_unavailable') // recovered
  })

  it('H4-1: a 403 (admin_required / forbidden) detail state has NO retry — a permission denial is not transient', async () => {
    h.getOverview.mockResolvedValue(buildOverview(0))
    h.listSnapshotBatches.mockRejectedValue(new Error('Insufficient integration permissions'))
    h.getMappingSummary.mockRejectedValue(new Error('Insufficient integration permissions'))
    h.getUnitSummary.mockRejectedValue(new Error('Insufficient integration permissions'))
    h.listPrepLines.mockRejectedValue(new StockPreparationConfirmApiError(403, 'FORBIDDEN', null))
    h.listExceptions.mockRejectedValue(new StockPreparationConfirmApiError(403, 'FORBIDDEN', null))
    const root = mountView({ projectId: 'proj-alpha' })
    await flushUi()
    // A confirmed 403 is never classified detail_unavailable → the detail-retry button must be absent.
    expect(root.querySelector('[data-testid="stock-prep-dashboard-recommend"]')?.getAttribute('data-kind')).not.toBe('detail_unavailable')
    expect(root.querySelector('[data-testid="stock-prep-dashboard-detail-retry"]')).toBeNull()
  })

  it('H4-1: both retry buttons are bilingual + carry an accessible name (aria-label)', async () => {
    h.locale = 'en'
    mockDetailUnavailable()
    const root = mountView({ projectId: 'proj-alpha' })
    await flushUi()
    const detailRetry = root.querySelector('[data-testid="stock-prep-dashboard-detail-retry"]') as HTMLButtonElement
    expect(detailRetry.textContent?.trim()).toBe('Retry')
    expect(detailRetry.getAttribute('aria-label')).toBe('Retry loading stage detail')
    // overview retry (separate mount, error state)
    h.getOverview.mockRejectedValue(new Error('503'))
    const root2 = mountView()
    await flushUi()
    const overviewRetry = root2.querySelector('[data-testid="stock-prep-dashboard-retry"]') as HTMLButtonElement
    expect(overviewRetry.textContent?.trim()).toBe('Retry')
    expect(overviewRetry.getAttribute('aria-label')).toBe('Retry loading workbench overview')
  })

  it('H4-1: a project switch DURING a detail retry drops the stale retry (retry path honors the seq guard)', async () => {
    h.getOverview.mockResolvedValue({
      projectCount: 2, statusCounts: { active: 2 },
      projects: [
        // snapshotBatchCount ≥ 1 so the tier-1 no-snapshot nudge does NOT fire — an unknown detail read
        // with clean tier-1 then classifies detail_unavailable (which is what carries the retry button).
        { projectId: 'proj-A', projectStatus: 'active', lastSyncRunId: 'r-a', snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
        { projectId: 'proj-B', projectStatus: 'active', lastSyncRunId: 'r-b', snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      ],
    } as unknown as StockPreparationWorkspaceOverview)
    // proj-A: FIRST load all reject (→ detail_unavailable + a retry button); the RETRY's snapshot read is
    // held with a stale batchCount 99. proj-B resolves cleanly to 7.
    let releaseRetryA!: () => void
    const retryA = new Promise((resolve) => { releaseRetryA = () => resolve({ batchCount: 99, batches: [] }) })
    let aSnap = 0
    h.listSnapshotBatches.mockImplementation((scope: { projectId?: string }) => {
      if (scope.projectId === 'proj-A') { aSnap += 1; return aSnap === 1 ? Promise.reject(new Error('backend not ready')) : retryA }
      return Promise.resolve({ batchCount: 7, batches: [] }) // B
    })
    const failFirstA = (ok: unknown) => { let n = 0; return (scope: { projectId?: string }) => (scope.projectId === 'proj-A' && ++n === 1 ? Promise.reject(new StockPreparationConfirmApiError(500, 'X', null)) : Promise.resolve(ok)) }
    h.getMappingSummary.mockImplementation(failFirstA({ activeMappingCount: 0, pendingConfirmCount: 0 }))
    h.getUnitSummary.mockImplementation(failFirstA({ pendingUnitLineCount: 0 }))
    h.listPrepLines.mockImplementation(failFirstA({ rowCount: 0, byPrepStatus: {} }))
    h.listExceptions.mockImplementation(failFirstA({ rowCount: 0, unresolvedBlockingCount: 0 }))

    const projectId = ref<string>('proj-A')
    app = createApp({ render: () => renderH(StockPreparationDashboardView as Component, { projectId: projectId.value, scope: () => ({}) }) })
    app.mount(container!)
    await flushUi() // A mount → detail_unavailable
    const retry = container!.querySelector('[data-testid="stock-prep-dashboard-detail-retry"]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    retry.click()             // retry for A → snapshot read (99) HELD
    await flushUi()
    projectId.value = 'proj-B' // switch mid-retry → B loads (7)
    await flushUi()
    releaseRetryA()            // the stale A retry (99) finally resolves — lower seq, must be dropped
    await flushUi()
    const text = container!.textContent || ''
    expect(text).toContain('7')
    expect(text).not.toContain('99')
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

  // #4207 review (owner focus: concurrent-request stale results / project-switch stale-count pollution).
  // The watcher re-fires loadStageDetail on every projectId change, so an earlier project's late
  // response must NOT overwrite a newer project's stage counts. The "sync" stage count comes from
  // listSnapshotBatches().batchCount, so we give project A a distinct 99 (held until after the switch)
  // and project B a 7 — the DOM must settle on B's 7, never A's stale 99.
  it('drops a superseded stage-detail response when the project changes mid-load', async () => {
    h.getOverview.mockResolvedValue({
      projectCount: 2,
      statusCounts: { active: 2 },
      projects: [
        { projectId: 'proj-A', projectStatus: 'active', lastSyncRunId: 'r-a', snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
        { projectId: 'proj-B', projectStatus: 'active', lastSyncRunId: 'r-b', snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      ],
    } as unknown as StockPreparationWorkspaceOverview)

    let releaseA!: () => void
    const aBatches = new Promise((resolve) => { releaseA = () => resolve({ batchCount: 99, batches: [] }) })
    h.listSnapshotBatches.mockImplementation((scope: { projectId?: string }) =>
      scope.projectId === 'proj-A' ? aBatches : Promise.resolve({ batchCount: 7, batches: [] }))
    h.getMappingSummary.mockResolvedValue({ activeMappingCount: 0, pendingConfirmCount: 0 })
    h.getUnitSummary.mockResolvedValue({ pendingUnitLineCount: 0 })
    h.listPrepLines.mockResolvedValue({ rowCount: 0, byPrepStatus: {} })
    h.listExceptions.mockResolvedValue({ rowCount: 0, unresolvedBlockingCount: 0 })

    const projectId = ref<string>('proj-A')
    app = createApp({ render: () => renderH(StockPreparationDashboardView as Component, { projectId: projectId.value, scope: () => ({}) }) })
    app.mount(container!)
    await flushUi() // project A's stage-detail load is in flight (its snapshot-batches read is held)

    projectId.value = 'proj-B' // switch — the watcher starts a fresh loadStageDetail for B
    await flushUi() // B fully resolves and renders (sync stage count = 7)

    releaseA() // A's stale snapshot-batches finally resolve (count 99) — must be dropped by the guard
    await flushUi()

    const text = container!.textContent || ''
    expect(text).toContain('7')
    expect(text).not.toContain('99')
  })

  // #4207 review P2: A → B → A. The newest load and a stale earliest-A load share projectId 'proj-A',
  // so an id-only guard would let the late earliest-A response overwrite the newest A's numbers. Only
  // a monotonic sequence guard is safe.
  it('drops the stale earliest-A response even after A → B → A (sequence guard, not id)', async () => {
    h.getOverview.mockResolvedValue({
      projectCount: 2,
      statusCounts: { active: 2 },
      projects: [
        { projectId: 'proj-A', projectStatus: 'active', lastSyncRunId: 'r-a', snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
        { projectId: 'proj-B', projectStatus: 'active', lastSyncRunId: 'r-b', snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      ],
    } as unknown as StockPreparationWorkspaceOverview)

    let releaseFirstA!: () => void
    const firstA = new Promise((resolve) => { releaseFirstA = () => resolve({ batchCount: 99, batches: [] }) })
    let aCalls = 0
    h.listSnapshotBatches.mockImplementation((scope: { projectId?: string }) => {
      if (scope.projectId === 'proj-A') { aCalls += 1; return aCalls === 1 ? firstA : Promise.resolve({ batchCount: 42, batches: [] }) }
      return Promise.resolve({ batchCount: 7, batches: [] }) // B
    })
    h.getMappingSummary.mockResolvedValue({ activeMappingCount: 0, pendingConfirmCount: 0 })
    h.getUnitSummary.mockResolvedValue({ pendingUnitLineCount: 0 })
    h.listPrepLines.mockResolvedValue({ rowCount: 0, byPrepStatus: {} })
    h.listExceptions.mockResolvedValue({ rowCount: 0, unresolvedBlockingCount: 0 })

    const projectId = ref<string>('proj-A')
    app = createApp({ render: () => renderH(StockPreparationDashboardView as Component, { projectId: projectId.value, scope: () => ({}) }) })
    app.mount(container!)
    await flushUi()            // load#1 (A) in flight — its snapshot-batches read (99) is held

    projectId.value = 'proj-B'
    await flushUi()            // load#2 (B) resolves (7)
    projectId.value = 'proj-A'
    await flushUi()            // load#3 (A, second A call) resolves (42) — this is the current truth

    releaseFirstA()           // load#1's stale A (99) finally resolves — lower seq, must be dropped
    await flushUi()

    const text = container!.textContent || ''
    expect(text).toContain('42')
    expect(text).not.toContain('99')
  })

  // #4207 review P2 (owner): A in flight → DESELECT (projectId → '') → reselect A. If the sequence is
  // claimed AFTER the empty-project early return, deselecting does NOT bump it, so the in-flight A keeps a
  // sequence that still matches and commits its stale result on resolve — then reselecting A renders that
  // stale detail ("有 1 个不完整的快照批次") until the fresh A settles. Claiming the sequence at the
  // function head makes the deselect cancel the in-flight load.
  it('cancels an in-flight load when the project is DESELECTED, so a reselect never shows the stale recommendation', async () => {
    // proj-A has no snapshot batch per the read-gated overview (tier-1 truth), so once the stale detail is
    // correctly cancelled the reselect derives a DIFFERENT recommendation ("no snapshot yet"), never the
    // stale "1 incomplete batch". The recommendation banner is NOT gated on the stepper's loading flag, so
    // a wrongly-committed stale detail surfaces there even while the fresh reselect load is in flight.
    h.getOverview.mockResolvedValue({
      projectCount: 1,
      statusCounts: { active: 1 },
      projects: [
        { projectId: 'proj-A', projectStatus: 'active', lastSyncRunId: 'r-a', snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      ],
    } as unknown as StockPreparationWorkspaceOverview)

    let releaseFirstA!: () => void
    let releaseSecondA!: () => void
    // Stale A carries a BLOCKING incomplete batch → derives the "1 incomplete snapshot batch" recommendation
    // (the exact symptom owner saw). Fresh A is clean.
    const firstA = new Promise((resolve) => { releaseFirstA = () => resolve({ batchCount: 1, batches: [{ incomplete: true }] }) })
    const secondA = new Promise((resolve) => { releaseSecondA = () => resolve({ batchCount: 3, batches: [] }) })
    let aCalls = 0
    h.listSnapshotBatches.mockImplementation((scope: { projectId?: string }) => {
      if (scope.projectId === 'proj-A') { aCalls += 1; return aCalls === 1 ? firstA : secondA }
      return Promise.resolve({ batchCount: 0, batches: [] })
    })
    h.getMappingSummary.mockResolvedValue({ activeMappingCount: 0, pendingConfirmCount: 0 })
    h.getUnitSummary.mockResolvedValue({ pendingUnitLineCount: 0 })
    h.listPrepLines.mockResolvedValue({ rowCount: 0, byPrepStatus: {} })
    h.listExceptions.mockResolvedValue({ rowCount: 0, unresolvedBlockingCount: 0 })

    const projectId = ref<string>('proj-A')
    app = createApp({ render: () => renderH(StockPreparationDashboardView as Component, { projectId: projectId.value, scope: () => ({}) }) })
    app.mount(container!)
    await flushUi()            // load#1 (A) in flight — its snapshot-batches read is held

    projectId.value = ''       // DESELECT — must bump the sequence and cancel load#1
    await flushUi()

    releaseFirstA()            // load#1's stale A resolves AFTER the deselect — must be dropped, not committed
    await flushUi()

    projectId.value = 'proj-A'  // reselect A — the fresh load#3 is in flight (held); the stale banner is
    await flushUi()             // what would show right now if load#1 had wrongly committed its detail

    const recommend = container!.querySelector('[data-testid="stock-prep-dashboard-recommend-text"]')?.textContent || ''
    expect(recommend).not.toContain('不完整')        // never the stale blocking recommendation
    expect(recommend).not.toContain('incomplete')
    expect(recommend).toContain('尚无快照')          // the honest tier-1 recommendation for a no-snapshot project

    releaseSecondA()
    await flushUi()
    expect(container!.textContent || '').toContain('3') // the fresh reselect load settles cleanly
  })
})
