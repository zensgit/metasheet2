import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// W7-A3: 场景 B 页面验收 spec（只加测试，不改 src）。
//
// 侦察结论（W7-A2 / #5877 实证的落库形状，见 docs/development/scenario-b-staging-persist-verification-20260918.md
// 与该 PR 的 __tests__/scenario-b-staging-persist.test.cjs）：合成 BOM 一次源运行落 1 个快照批次
// （snapshotBatchId 唯一）、54 行快照行、两层父子 6（level 1，子装配）/ 48（level 2，零件），incomplete=false。
//
// 这支 spec 验证的是"读路径"——阶段总览 StockPreparationDashboardView（内嵌 StockPreparationStageStepper）与
// 批次详情 StockPreparationSnapshotDiffView 两层页面，在读到这个落点形状时如何渲染——而不是落库写路径本身
// （写路径已由 #5877 的 plugin 测试覆盖）。前端 snapshot-batches 契约（StockPreparationSnapshotBatchSummary）
// 不携带 bomLevel，两层父子结构是后端 staging 表的内部形态，本视图层不拆分渲染，只读 batchCount / lineCount /
// incomplete 这些既有 values-free 字段——这一点在设计文档的"残余"一节里落地记录，不在这里假造一个不存在的
// UI 分层渲染断言。
//
// 因此本刀把"54 行"落在两处已有的、真实存在的渲染面上：
//   ① 总览：sync 阶段的批次计数（batchCount=1，对应"该批次"）+ generate 阶段的行计数（rowCount=54，
//      对应从这批 54 行快照行派生出的 54 条备料行，"该批次的行数"）；
//   ② 详情：SnapshotDiffView 的 diff 行明细表格渲染 54 行（listStockPreparationSnapshotDiffRows 返回
//      rowCount=54 的 54 条 diff 行）。
// 不依赖 #5876（W7-A1）或 #5877（W7-A2）是否已合入 main——只依赖两个既有 GET 契约的形状：
//   GET /api/integration/stock-preparation/snapshot-batches
//   GET /api/integration/stock-preparation/snapshot-batches/:id/diff(/rows)
// 这两个契约在 main 上早已存在（StockPreparationDashboardView.spec.ts / StockPreparationSnapshotDiffView.spec.ts
// 已经在跑），A1/A2 只是新增了它们背后的落库测试，没有改这两个契约的形状。

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  getOverview: vi.fn(),
  listSnapshotBatches: vi.fn(),
  getDiff: vi.fn(),
  listDiffRows: vi.fn(),
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
// Both StockPreparationDashboardView and StockPreparationSnapshotDiffView import this same module —
// one mock covers both views' reads of the same "场景 B" snapshot-batch surface.
vi.mock('../src/services/integration/stockPreparation/bomSnapshotDiff', () => ({
  listStockPreparationSnapshotBatches: h.listSnapshotBatches,
  getStockPreparationSnapshotDiff: h.getDiff,
  listStockPreparationSnapshotDiffRows: h.listDiffRows,
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

import StockPreparationDashboardView from '../src/components/integration/stockPreparation/StockPreparationDashboardView.vue'
import StockPreparationSnapshotDiffView from '../src/components/integration/stockPreparation/StockPreparationSnapshotDiffView.vue'
import type { StockPreparationWorkspaceOverview } from '../src/services/integration/stockPreparation/projectWorkspace'
import type {
  StockPreparationSnapshotBatchListResult,
  StockPreparationSnapshotDiffSummary,
} from '../src/services/integration/stockPreparation/bomSnapshotDiff'

// ── 场景 B 合成落点形状（synthetic — 无任何真实客户字段值）────────────────────────────────────────
const SCENARIO_B_PROJECT_ID = 'proj-scenario-b'
const SCENARIO_B_BATCH_ID = 'batch-scenario-b-01'
const SCENARIO_B_RUN_ID = 'run-scenario-b-01'
const SCENARIO_B_LINE_COUNT = 54 // #5877 实证：6（level 1）+ 48（level 2）

function scenarioBOverview(): StockPreparationWorkspaceOverview {
  return {
    projectCount: 1,
    statusCounts: { active: 1 },
    projects: [
      {
        projectId: SCENARIO_B_PROJECT_ID,
        projectStatus: 'active',
        lastSyncRunId: SCENARIO_B_RUN_ID,
        snapshotBatchCount: 1,
        openExceptionCount: 0,
        readyLineCount: SCENARIO_B_LINE_COUNT,
        heldLineCount: 0,
      },
    ],
  } as unknown as StockPreparationWorkspaceOverview
}

function scenarioBBatchList(): StockPreparationSnapshotBatchListResult {
  return {
    projectId: SCENARIO_B_PROJECT_ID,
    batchCount: 1,
    batches: [
      {
        snapshotBatchId: SCENARIO_B_BATCH_ID,
        snapshotVersion: 1,
        snapshotStatus: 'active',
        syncRunId: SCENARIO_B_RUN_ID,
        lineCount: SCENARIO_B_LINE_COUNT,
        createdAtPresent: true,
        incomplete: false,
      },
    ],
  } as unknown as StockPreparationSnapshotBatchListResult
}

function scenarioBDiffSummary(): StockPreparationSnapshotDiffSummary {
  return {
    snapshotBatchId: SCENARIO_B_BATCH_ID,
    baseSnapshotBatchId: null,
    changeCounts: {
      added: SCENARIO_B_LINE_COUNT,
      removed: 0,
      quantityChanged: 0,
      unitChanged: 0,
      versionChanged: 0,
      pathChanged: 0,
      missingChildBom: 0,
      fingerprintChanged: 0,
    },
    blockingExceptionCount: 0,
  }
}

// 54 条合成 diff 行（全部 diffType=added，reviewStatus=ready）——只用契约允许的枚举值/句柄形状，
// 不携带任何业务字段值。diffId 与 keyFingerprint 必须匹配前端边界校验的正则（否则整包判 malformed）。
function scenarioBDiffRows(): unknown {
  const rows = Array.from({ length: SCENARIO_B_LINE_COUNT }, (_, i) => {
    const hex = i.toString(16).padStart(16, '0')
    return {
      diffId: `stockprep_diff_${hex}`,
      diffType: 'added',
      reviewStatus: 'ready',
      changeTypes: [],
      rowCount: 1,
      keyFingerprint: `sha16:${hex}`,
    }
  })
  return {
    snapshotBatchId: SCENARIO_B_BATCH_ID,
    baseSnapshotBatchId: null,
    rowCount: SCENARIO_B_LINE_COUNT,
    heldRowCount: 0,
    rows,
  }
}

function mockDashboardClearStageReads(): void {
  h.listSnapshotBatches.mockResolvedValue(scenarioBBatchList())
  h.getMappingSummary.mockResolvedValue({
    totalMappingCount: SCENARIO_B_LINE_COUNT, activeMappingCount: SCENARIO_B_LINE_COUNT,
    matchStatusCounts: { matched: SCENARIO_B_LINE_COUNT, pending_confirm: 0, multi_candidate: 0, not_found: 0, version_conflict: 0 },
    versionPolicyCounts: { drawing_and_version: SCENARIO_B_LINE_COUNT, drawing_only: 0, category_rule: 0, manual: 0 },
    pendingConfirmCount: 0,
  })
  h.getUnitSummary.mockResolvedValue({
    totalRuleCount: 2, activeRuleCount: 2, requiresConfirmationCount: 0,
    scopeTypeCounts: { material: 2, category: 0, generic: 0 },
    roundingRuleCounts: { none: 2, ceil: 0, floor: 0, nearest: 0, pack_size: 0 },
    pendingUnitLineCount: 0,
  })
  // "行数" surfaces here: 54 备料行，一一对应这批次的 54 行快照行。
  h.listPrepLines.mockResolvedValue({
    rowCount: SCENARIO_B_LINE_COUNT, byPrepStatus: { draft: SCENARIO_B_LINE_COUNT, held: 0 },
    byMappingStatus: { matched: SCENARIO_B_LINE_COUNT, pending_confirm: 0, multi_candidate: 0, not_found: 0, version_conflict: 0 },
    byUnitStatus: { converted: SCENARIO_B_LINE_COUNT, missing_rule: 0, conflict: 0 },
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

describe('StockPreparationScenarioBAcceptance (W7-A3, values-free)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.getOverview.mockReset()
    h.listSnapshotBatches.mockReset()
    h.getDiff.mockReset()
    h.listDiffRows.mockReset()
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

  function mountDashboard(props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(StockPreparationDashboardView as Component, props)
    app.mount(container!)
    return container!
  }

  function mountDiffView(props: Record<string, unknown> = { projectId: SCENARIO_B_PROJECT_ID }): HTMLDivElement {
    app = createApp(StockPreparationSnapshotDiffView as Component, props)
    app.mount(container!)
    return container!
  }

  // ── ① 阶段总览：渲染出该批次与行数 ─────────────────────────────────────────────────────────────
  it('① dashboard stage overview renders the scenario-B batch (sync=1) and its row count (generate=54)', async () => {
    h.getOverview.mockResolvedValue(scenarioBOverview())
    mockDashboardClearStageReads()
    const root = mountDashboard({ projectId: SCENARIO_B_PROJECT_ID })
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-stage-stepper"]')).not.toBeNull()
    // "该批次": the sync stage's total count is the batch count (1), not the line count.
    expect(root.querySelector('[data-testid="stock-prep-stage-count-sync"]')?.textContent).toContain('1')
    // "行数": the generate stage's total count is this batch's 54 derived prep-lines.
    expect(root.querySelector('[data-testid="stock-prep-stage-count-generate"]')?.textContent).toContain('54')
    // Provision is unaffected — all six stage slots render.
    expect(root.querySelectorAll('[data-testid="stock-prep-stage-item"]').length).toBe(6)
    expect(h.listSnapshotBatches).toHaveBeenCalledWith(expect.objectContaining({ projectId: SCENARIO_B_PROJECT_ID }))
  })

  // ── ② 批次详情：渲染 54 行 diff 明细 ───────────────────────────────────────────────────────────
  it('② snapshot-diff detail view renders all 54 rows of the scenario-B batch', async () => {
    h.listSnapshotBatches.mockResolvedValue(scenarioBBatchList())
    h.getDiff.mockResolvedValue(scenarioBDiffSummary())
    h.listDiffRows.mockResolvedValue(scenarioBDiffRows())
    const root = mountDiffView()
    await flushUi()

    // The batch list shows exactly the one scenario-B batch, complete (not incomplete → selectable).
    const batchRows = root.querySelectorAll('[data-testid="stock-prep-snapshot-batch-row"]')
    expect(batchRows.length).toBe(1)
    expect(root.querySelector('[data-testid="stock-prep-snapshot-incomplete-badge"]')).toBeNull()

    const select = root.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement
    select.click()
    await flushUi()

    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff"]')).not.toBeNull()
    // Open the row-level drill-down (lazy — same idiom as the existing view-2 spec).
    const toggle = root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-toggle"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    toggle.click()
    await flushUi()

    const diffRows = root.querySelectorAll('[data-testid="stock-prep-snapshot-diff-row"]')
    expect(diffRows.length).toBe(SCENARIO_B_LINE_COUNT) // all 54 rows render — this is the mutation target
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-meta"]')?.textContent).toContain('54')
  })

  // ── ③ 空态：0 批次 ─────────────────────────────────────────────────────────────────────────────
  it('③ empty state: the dashboard and the detail view both show the no-batches empty state (0 batches)', async () => {
    h.getOverview.mockResolvedValue({
      projectCount: 1,
      statusCounts: { active: 1 },
      projects: [
        { projectId: SCENARIO_B_PROJECT_ID, projectStatus: 'active', lastSyncRunId: null, snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      ],
    } as unknown as StockPreparationWorkspaceOverview)
    mockDashboardClearStageReads()
    h.listSnapshotBatches.mockResolvedValue({ projectId: SCENARIO_B_PROJECT_ID, batchCount: 0, batches: [] })

    const dashboardRoot = mountDashboard({ projectId: SCENARIO_B_PROJECT_ID })
    await flushUi()
    expect(dashboardRoot.querySelector('[data-testid="stock-prep-stage-count-sync"]')?.textContent).toContain('0')

    if (app) app.unmount()
    container!.innerHTML = ''

    h.listSnapshotBatches.mockResolvedValue({ projectId: SCENARIO_B_PROJECT_ID, batchCount: 0, batches: [] })
    const diffRoot = mountDiffView()
    await flushUi()
    expect(diffRoot.querySelector('[data-testid="stock-prep-snapshot-empty"]')).not.toBeNull()
    expect(diffRoot.querySelector('[data-testid="stock-prep-snapshot-overview"]')).toBeNull()
    expect(h.getDiff).not.toHaveBeenCalled()
  })

  // ── ④ 错误态：接口 5xx ────────────────────────────────────────────────────────────────────────
  it('④ error state: a 5xx on the snapshot-batches GET renders a neutral error, never the raw body, on both views', async () => {
    const raw5xxBody = 'connectionString=host=erp;pwd=secret-scenario-b;'
    h.getOverview.mockRejectedValue(new Error(`503 Service Unavailable ${raw5xxBody}`))
    // No projectId here: the overview GET is what fails, and it must fail before any stage-detail
    // read is attempted — matching StockPreparationDashboardView.spec.ts's own error-state idiom.
    const dashboardRoot = mountDashboard()
    await flushUi()
    expect(dashboardRoot.querySelector('[data-testid="stock-prep-dashboard-error"]')).not.toBeNull()
    expect((dashboardRoot.textContent || '')).not.toContain(raw5xxBody)

    if (app) app.unmount()
    container!.innerHTML = ''

    h.listSnapshotBatches.mockRejectedValue(new Error(`503 Service Unavailable ${raw5xxBody}`))
    const diffRoot = mountDiffView()
    await flushUi()
    expect(diffRoot.querySelector('[data-testid="stock-prep-snapshot-error"]')).not.toBeNull()
    const diffText = diffRoot.textContent || ''
    expect(diffText).not.toContain(raw5xxBody)
    expect(diffText).not.toContain('secret')
  })

  // ── ⑤ values-free: 渲染 DOM 里不出现主机 / 连接串样式字符串 ───────────────────────────────────
  it('⑤ values-free: neither view ever renders an http:// host or a connection-string-shaped string', async () => {
    h.getOverview.mockResolvedValue(scenarioBOverview())
    mockDashboardClearStageReads()
    const dashboardRoot = mountDashboard({ projectId: SCENARIO_B_PROJECT_ID })
    await flushUi()
    const dashboardText = dashboardRoot.textContent || ''
    expect(dashboardText).not.toMatch(/https?:\/\//i)
    expect(dashboardText).not.toMatch(/[a-z0-9.-]+=[^;]+;.*(pwd|password|secret)=/i)

    if (app) app.unmount()
    container!.innerHTML = ''

    h.listSnapshotBatches.mockResolvedValue(scenarioBBatchList())
    h.getDiff.mockResolvedValue(scenarioBDiffSummary())
    h.listDiffRows.mockResolvedValue(scenarioBDiffRows())
    const diffRoot = mountDiffView()
    await flushUi()
    ;(diffRoot.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement).click()
    await flushUi()
    ;(diffRoot.querySelector('[data-testid="stock-prep-snapshot-diff-rows-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const diffText = diffRoot.textContent || ''
    expect(diffText).not.toMatch(/https?:\/\//i)
    expect(diffText).not.toMatch(/[a-z0-9.-]+=[^;]+;.*(pwd|password|secret)=/i)
  })
})
