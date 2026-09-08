import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 项目查询 (P2-1 · 设计稿 §6.3 第一行) — what this suite pins:
//
//   Q-01 两级筛选 —— 姿态 × 来源 × 搜索,组合起来是 AND,而且是通过真组件挂载证明的,不是把纯函数
//        断言两遍。「来源」的三个非 all 取值各一条,含 `both` 是 `mvp`/`pull_target` 的子集这一裁决。
//   Q-02 URL 恢复 —— `?q=&status=&source=&sel=` 进来就是那一屏;非法枚举值被忽略(回落「全部」),
//        不是报错、也不是渲染一个谁都叫不出名字的筛选。
//   Q-03 URL 回写 —— replace 而不是 push;默认值删键而不是写空串;`tab=project-query` 一起写回去
//        (否则刷新会落到别人的落地页,四个状态位一个都不生效)。
//   Q-04 sel 才读看板 —— 没选中零次 board 读;选中读一次;再点同一行不再读;换一行再读一次。
//        「不轮询」是这一条的反面,一并证:等待若干个 tick 之后计数不涨。
//   Q-05 空态四态 —— no_projects / filter_empty / directory_unavailable / no_selection,四个
//        `data-empty-state` 值互不相同,且四段文案两两不共享(G2)。
//   Q-06 来源字段缺失 —— 筛选控件 disabled 且说明「后端未提供来源」,清单本身不受影响(G4)。
//   Q-07 values-free 反向断言 —— 搜索词只出现在组件状态与 URL 里:不写 localStorage、不进任何请求
//        的 URL 或 body、组件源码里没有 console.*、没有 localStorage.*。
//   Q-08 G1 —— 整页 primary 填充按钮 ≤ 1(真色值由浏览器 lane 数;jsdom 数的是那一个类)。
//   Q-09 最近导出 —— 「—」与「从未导出过」的分界,由 `lastExportAtMayBeIncomplete === false` 决定;
//        undefined 不得被当成 false。
//   Q-10 三句中性提示沿用首页那一份文案与优先级。
//
// 与首页并集的关系:本面板不自带并集实现,`projectQuery.ts` 调 `operatorHomeCards.ts` 的
// `buildOperatorHomeCards`。Q-01 里那条「记忆里的项目也进清单」就是这一点的见证 —— 如果哪天有人在这
// 里复制一份并集,那条会因为少了 memory-only 行而红。

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read', 'stock-prep:operate'] as string[],
  route: {
    path: '/stock-prep',
    fullPath: '/stock-prep',
    meta: {} as Record<string, unknown>,
    query: {} as Record<string, unknown>,
  },
  router: { push: vi.fn(), replace: vi.fn() },
  apiFetch: vi.fn(),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRoute: () => h.route, useRouter: () => h.router }
})

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, roles: [], permissions: h.permissions }),
    hasAdminAccess: () => false,
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationProjectQueryView from '../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue'
import { recordStockPrepProjectVisit } from '../src/services/integration/stockPreparation/operatorHomeMemory'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'
import {
  buildStockPrepProjectQueryRows,
  filterStockPrepProjectQueryRows,
  resolveStockPrepProjectQueryEmptyState,
  stockPrepLastExportDisplay,
  stockPrepProjectQuerySearchFromQuery,
  stockPrepProjectQuerySelectionFromQuery,
  stockPrepProjectQuerySourceAvailable,
  stockPrepProjectQuerySourceFromQuery,
  stockPrepProjectQueryStatusFromQuery,
  stockPrepProjectQueryUrlState,
} from '../src/services/integration/stockPreparation/projectQuery'
import type {
  StockPreparationOperatorDirectory,
  StockPreparationOperatorProject,
} from '../src/services/integration/stockPreparation/confirmationQueue'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
const PROJECT_A = 'PQ-0001'
const PROJECT_B = 'PQ-0002'
const PROJECT_C = 'PQ-0003'

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code } }), { status })
}

function row(overrides: Record<string, unknown> = {}): StockPreparationOperatorProject {
  return {
    projectId: 'p',
    projectNo: PROJECT_A,
    projectName: null,
    projectStatus: 'active',
    lastSyncRunId: null,
    snapshotBatchCount: 0,
    openExceptionCount: 0,
    heldLineCount: 0,
    readyLineCount: 0,
    pendingDecisionCount: 0,
    ...overrides,
  } as StockPreparationOperatorProject
}

function directory(
  projects: StockPreparationOperatorProject[],
  overrides: Record<string, unknown> = {},
): StockPreparationOperatorDirectory {
  return {
    tenantId: 'tenant-a',
    directoryReady: true,
    ledgerReady: true,
    projectCount: projects.length,
    pendingProjectCount: projects.filter((project) => project.pendingDecisionCount > 0).length,
    projects,
    pullTargetReady: true,
    directoryMayBeIncomplete: false,
    pullTargetScanCapped: false,
    lastExportAtMayBeIncomplete: false,
    ...overrides,
  } as StockPreparationOperatorDirectory
}

function board(projectNo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'tenant-a',
    projectId: null,
    projectNo,
    projectName: null,
    projectStatus: 'active',
    lastSyncRunId: null,
    snapshotBatchCount: 0,
    openExceptionCount: 0,
    heldLineCount: 0,
    readyLineCount: 0,
    archivedSnapshotPresent: false,
    pullTargetReady: true,
    pulledRowCount: 12,
    activePulledRowCount: 11,
    pulledRowCountBounded: false,
    lastChangedFromPlmAt: null,
    lastChangedFromPlmBounded: false,
    pendingDecisionCount: 0,
    lastExportAt: null,
    fillTarget: null,
    directoryReady: true,
    ledgerReady: true,
    ...overrides,
  }
}

/** The two GETs this panel can make, and nothing else — an unexpected path fails loudly. */
function routeApi(input: {
  directory?: StockPreparationOperatorDirectory | 'reject'
  boards?: Record<string, Record<string, unknown>>
}): void {
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/operator/projects')) {
      if (input.directory === 'reject') return refusal(403, 'OPERATOR_SCOPE_TENANT_REQUIRED')
      return ok(input.directory ?? directory([]))
    }
    const match = /\/projects\/([^/?]+)\/board/.exec(path)
    if (match) {
      const projectNo = decodeURIComponent(match[1])
      const hit = input.boards?.[projectNo]
      if (!hit) return refusal(404, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
      return ok(hit)
    }
    throw new Error(`unexpected request from 项目查询: ${path}`)
  })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let app: VueApp | null = null
let container: HTMLDivElement | null = null

async function mount(): Promise<HTMLDivElement> {
  app = createApp(StockPreparationProjectQueryView as Component, { scope: SCOPE })
  app.mount(container!)
  await flushUi()
  return container!
}

function boardReadCount(): number {
  return h.apiFetch.mock.calls.filter(([path]) => typeof path === 'string' && path.includes('/board')).length
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${id}"]`)
}

function rowNumbers(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-testid="stock-prep-project-query-row"]')]
    .map((node) => node.getAttribute('data-project-no') ?? '')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  h.locale = 'zh-CN'
  h.permissions = ['stock-prep:read', 'stock-prep:operate']
  h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }
  h.router.push.mockReset()
  h.router.replace.mockReset()
  h.apiFetch.mockReset()
  localStorage.clear()
  resetStockPreparationOperatorHomeDirectoryThrottle()
})

afterEach(() => {
  if (app) app.unmount()
  app = null
  if (container) container.remove()
  container = null
  localStorage.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Q-01 两级筛选
// ---------------------------------------------------------------------------

describe('项目查询 · 两级筛选(Q-01)', () => {
  function threeProjects(): StockPreparationOperatorDirectory {
    return directory([
      row({ projectId: 'a', projectNo: PROJECT_A, projectName: '甲项目', pendingDecisionCount: 2, sources: ['mvp'] }),
      row({ projectId: null, projectNo: PROJECT_B, projectName: '乙项目', pendingDecisionCount: 0, sources: ['pull_target'] }),
      row({ projectId: 'c', projectNo: PROJECT_C, projectName: '丙项目', pendingDecisionCount: 0, sources: ['mvp', 'pull_target'] }),
    ])
  }

  it('姿态 × 来源 × 搜索 三者是 AND,而且 both 同时满足 mvp 与 pull_target', () => {
    const rows = buildStockPrepProjectQueryRows(threeProjects(), [])
    const pick = (status: 'all' | 'pending_decision', source: 'all' | 'mvp' | 'pull_target' | 'both', search = '') =>
      filterStockPrepProjectQueryRows(rows, { status, source, search }).map((entry) => entry.projectNo)

    expect(pick('all', 'all')).toEqual([PROJECT_A, PROJECT_B, PROJECT_C])
    expect(pick('pending_decision', 'all')).toEqual([PROJECT_A])
    // `both` 是 `mvp` 与 `pull_target` 各自的子集,不是第四个互斥桶 —— 这条裁决写在 projectQuery.ts。
    expect(pick('all', 'mvp')).toEqual([PROJECT_A, PROJECT_C])
    expect(pick('all', 'pull_target')).toEqual([PROJECT_B, PROJECT_C])
    expect(pick('all', 'both')).toEqual([PROJECT_C])
    // AND,不是 OR:甲是 mvp 且待确认,乙是 pull_target 且不待确认,交集为空。
    expect(pick('pending_decision', 'pull_target')).toEqual([])
    // 搜索走项目号与名称两处,大小写无关。
    expect(pick('all', 'all', 'pq-0002')).toEqual([PROJECT_B])
    expect(pick('all', 'all', '丙')).toEqual([PROJECT_C])
    expect(pick('all', 'mvp', '丙')).toEqual([PROJECT_C])
  })

  it('本机记忆里的项目也在清单里 —— 并集用的是首页那一份实现,不是这里另写一份', async () => {
    // 目录里只有甲;记忆里另有一个从未归档过的项目(F1 的那类自助拉取项目)。
    recordStockPrepProjectVisit(PROJECT_B, 'ready', SCOPE)
    routeApi({ directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })]) })
    const root = await mount()
    expect(rowNumbers(root).sort()).toEqual([PROJECT_A, PROJECT_B])
    // 记忆行没有来源可言 —— 服务端没为它答过,所以是「看不到」,不是「没有」。
    const memoryRow = root.querySelector(`[data-project-no="${PROJECT_B}"]`) as HTMLElement
    expect(memoryRow.textContent).toContain('看不到')
  })

  it('点姿态 chip 之后清单收窄,再点同一个 chip 回到全部', async () => {
    routeApi({ directory: threeProjects() })
    const root = await mount()
    expect(rowNumbers(root)).toHaveLength(3)

    const chip = testid(root, 'stock-prep-project-query-status-pending_decision') as HTMLButtonElement
    chip.click()
    await flushUi()
    expect(rowNumbers(root)).toEqual([PROJECT_A])
    expect(chip.getAttribute('aria-pressed')).toBe('true')

    chip.click()
    await flushUi()
    expect(rowNumbers(root)).toHaveLength(3)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// Q-02 / Q-03 URL 状态位
// ---------------------------------------------------------------------------

describe('项目查询 · URL 状态位(Q-02 / Q-03)', () => {
  const dir = () => directory([
    row({ projectNo: PROJECT_A, projectName: '甲项目', pendingDecisionCount: 2, sources: ['mvp'] }),
    row({ projectId: null, projectNo: PROJECT_B, projectName: '乙项目', sources: ['pull_target'] }),
  ])

  it('Q-02 进入时从 query 恢复筛选与选中', async () => {
    h.route.query = { q: '甲', status: 'pending_decision', source: 'mvp', sel: PROJECT_A }
    routeApi({ directory: dir(), boards: { [PROJECT_A]: board(PROJECT_A, { pendingDecisionCount: 2 }) } })
    const root = await mount()

    expect((testid(root, 'stock-prep-project-query-search') as HTMLInputElement).value).toBe('甲')
    expect((testid(root, 'stock-prep-project-query-source') as HTMLSelectElement).value).toBe('mvp')
    expect(testid(root, 'stock-prep-project-query-status-pending_decision')!.getAttribute('aria-pressed')).toBe('true')
    expect(rowNumbers(root)).toEqual([PROJECT_A])
    const selected = root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLElement
    expect(selected.getAttribute('data-selected')).toBe('true')
    // 恢复一个 sel 就是「这条链接要的就是这个项目」,所以看板读了一次。
    expect(boardReadCount()).toBe(1)
  })

  it('Q-02 非法枚举值被忽略,回落到「全部」,不报错也不渲染一个叫不出名字的筛选', async () => {
    h.route.query = { status: 'definitely-not-a-status', source: 'nope' }
    routeApi({ directory: dir() })
    const root = await mount()

    expect(testid(root, 'stock-prep-project-query-status-all')!.getAttribute('aria-pressed')).toBe('true')
    expect((testid(root, 'stock-prep-project-query-source') as HTMLSelectElement).value).toBe('all')
    expect(rowNumbers(root)).toHaveLength(2)
    // 纯函数层的同一条,含「重复参数取第一个」这一形状。
    expect(stockPrepProjectQueryStatusFromQuery(['blocked', 'ready'])).toBe('blocked')
    expect(stockPrepProjectQueryStatusFromQuery(undefined)).toBe('all')
    expect(stockPrepProjectQuerySourceFromQuery('both')).toBe('both')
    expect(stockPrepProjectQuerySourceFromQuery(null)).toBe('all')
    expect(stockPrepProjectQuerySearchFromQuery(42)).toBe('')
    expect(stockPrepProjectQuerySelectionFromQuery(`  ${PROJECT_A} `)).toBe(PROJECT_A)
  })

  it('Q-03 操作时 router.replace 回写(不 push),并带上 tab=project-query', async () => {
    routeApi({ directory: dir(), boards: { [PROJECT_A]: board(PROJECT_A) } })
    const root = await mount()
    expect(h.router.replace).not.toHaveBeenCalled()
    expect(h.router.push).not.toHaveBeenCalled()

    ;(testid(root, 'stock-prep-project-query-status-pending_decision') as HTMLButtonElement).click()
    await flushUi()
    expect(h.router.push, '筛选不是一步历史').not.toHaveBeenCalled()
    expect(h.router.replace).toHaveBeenCalledTimes(1)
    expect(h.router.replace.mock.calls[0][0]).toEqual({
      query: { tab: 'project-query', status: 'pending_decision' },
    })

    ;(root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement).click()
    await flushUi()
    expect(h.router.replace.mock.calls[1][0]).toEqual({
      query: { tab: 'project-query', status: 'pending_decision', sel: PROJECT_A },
    })
    expect(h.router.push).not.toHaveBeenCalled()
  })

  it('Q-03 默认值删键而不是写空串 —— 「回到默认」不该在地址栏里留垃圾', () => {
    expect(stockPrepProjectQueryUrlState({ status: 'all', source: 'all', search: '   ', selection: '' })).toEqual({
      q: undefined,
      status: undefined,
      source: undefined,
      sel: undefined,
    })
    expect(stockPrepProjectQueryUrlState({ status: 'ready', source: 'both', search: ' 甲 ', selection: PROJECT_B })).toEqual({
      q: '甲',
      status: 'ready',
      source: 'both',
      sel: PROJECT_B,
    })
  })
})

// ---------------------------------------------------------------------------
// Q-04 sel 才读看板
// ---------------------------------------------------------------------------

describe('项目查询 · 右栏只在选中时读一次看板(Q-04)', () => {
  const dir = () => directory([
    row({ projectNo: PROJECT_A, sources: ['mvp'] }),
    row({ projectNo: PROJECT_B, sources: ['mvp'] }),
  ])

  it('没选中 → 零次;选中 → 一次;再点同一行 → 还是一次;换一行 → 两次', async () => {
    routeApi({
      directory: dir(),
      boards: {
        [PROJECT_A]: board(PROJECT_A, { pendingDecisionCount: 3, pulledRowCount: 1240, activePulledRowCount: 1200 }),
        [PROJECT_B]: board(PROJECT_B),
      },
    })
    const root = await mount()
    expect(boardReadCount()).toBe(0)
    expect(testid(root, 'stock-prep-project-query-detail-empty')).not.toBeNull()

    const first = root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement
    first.click()
    await flushUi()
    expect(boardReadCount()).toBe(1)
    expect(testid(root, 'stock-prep-project-query-metric-pending')!.textContent).toContain('3')
    expect(testid(root, 'stock-prep-project-query-metric-rows')!.textContent).toContain('1240')

    first.click()
    await flushUi()
    expect(boardReadCount(), '再点已选中的那一行不发第二次请求').toBe(1)

    ;(root.querySelector(`[data-project-no="${PROJECT_B}"]`) as HTMLButtonElement).click()
    await flushUi()
    expect(boardReadCount()).toBe(2)
  })

  it('不轮询 —— 选中之后放着不动,读数不涨', async () => {
    routeApi({ directory: dir(), boards: { [PROJECT_A]: board(PROJECT_A) } })
    const root = await mount()
    ;(root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement).click()
    await flushUi()
    expect(boardReadCount()).toBe(1)
    await flushUi(20)
    expect(boardReadCount()).toBe(1)
  })

  it('看板读不到时是一句看得见的话(G3:选中是人主动点的),而且不是空态', async () => {
    routeApi({ directory: dir(), boards: {} })
    const root = await mount()
    ;(root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement).click()
    await flushUi()
    const error = testid(root, 'stock-prep-project-query-detail-error')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('还没有数据')
    expect(error!.hasAttribute('data-empty-state')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Q-05 空态四态
// ---------------------------------------------------------------------------

describe('项目查询 · 四个空态各有各的话(Q-05)', () => {
  it('no_projects / filter_empty / directory_unavailable / no_selection,四个值互不相同', async () => {
    // 1) 目录空 → no_projects
    routeApi({ directory: directory([]) })
    let root = await mount()
    expect(testid(root, 'stock-prep-project-query-empty')!.getAttribute('data-empty-state')).toBe('no_projects')
    const noProjects = testid(root, 'stock-prep-project-query-empty')!.textContent ?? ''
    // 右栏此时是 no_selection —— 两个空态同屏,值不同、话也不同。
    expect(testid(root, 'stock-prep-project-query-detail-empty')!.getAttribute('data-empty-state')).toBe('no_selection')
    const noSelection = testid(root, 'stock-prep-project-query-detail-empty')!.textContent ?? ''
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // 2) 有项目但筛不出来 → filter_empty(不是「暂无数据」)
    resetStockPreparationOperatorHomeDirectoryThrottle()
    h.route.query = { q: '这个词一个项目都对不上' }
    routeApi({ directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })]) })
    root = await mount()
    const filterEmpty = testid(root, 'stock-prep-project-query-empty')!
    expect(filterEmpty.getAttribute('data-empty-state')).toBe('filter_empty')
    const filterEmptyText = filterEmpty.textContent ?? ''
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // 3) 目录读失败 → directory_unavailable,而且是静默降级:没有 alert,没有错误条。
    resetStockPreparationOperatorHomeDirectoryThrottle()
    h.route.query = {}
    routeApi({ directory: 'reject' })
    root = await mount()
    const unavailable = testid(root, 'stock-prep-project-query-empty')!
    expect(unavailable.getAttribute('data-empty-state')).toBe('directory_unavailable')
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(testid(root, 'stock-prep-project-query-detail-error')).toBeNull()
    const unavailableText = unavailable.textContent ?? ''

    // 四段文案两两不共享(G2)。
    const texts = [noProjects, filterEmpty ? filterEmptyText : '', unavailableText, noSelection]
    for (let i = 0; i < texts.length; i += 1) {
      expect(texts[i].length).toBeGreaterThan(0)
      for (let j = i + 1; j < texts.length; j += 1) {
        expect(texts[i], `空态 ${i} 与 ${j} 不得共享文案`).not.toBe(texts[j])
      }
    }
    // 「读不到」明确不是「没有」。
    expect(unavailableText).toContain('读不到')
    expect(unavailableText).not.toBe(noProjects)
  })

  it('第一次目录读还没落地时没有任何空态(G4:没查过就不下结论)', () => {
    expect(resolveStockPrepProjectQueryEmptyState({
      directorySettled: false,
      directoryAvailable: false,
      rowCount: 0,
      visibleRowCount: 0,
    })).toBeNull()
    expect(resolveStockPrepProjectQueryEmptyState({
      directorySettled: true,
      directoryAvailable: false,
      rowCount: 3,
      visibleRowCount: 3,
    })).toBe('directory_unavailable')
  })
})

// ---------------------------------------------------------------------------
// Q-06 来源缺失
// ---------------------------------------------------------------------------

describe('项目查询 · 后端没给来源时(Q-06)', () => {
  it('筛选禁用并说明原因,清单本身照常渲染', async () => {
    // `sources` 整个字段缺席 —— 老后端,或者没有 opt-in 的那种响应。
    routeApi({
      directory: directory(
        [row({ projectNo: PROJECT_A }), row({ projectNo: PROJECT_B })],
        { lastExportAtMayBeIncomplete: undefined },
      ),
    })
    const root = await mount()
    const select = testid(root, 'stock-prep-project-query-source') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(testid(root, 'stock-prep-project-query-source-unavailable')!.textContent).toContain('后端未提供来源')
    expect(rowNumbers(root)).toHaveLength(2)
  })

  it('只要有一行带 sources,筛选就可用', () => {
    expect(stockPrepProjectQuerySourceAvailable(directory([row({ projectNo: PROJECT_A })]))).toBe(false)
    expect(stockPrepProjectQuerySourceAvailable(directory([
      row({ projectNo: PROJECT_A }),
      row({ projectNo: PROJECT_B, sources: ['mvp'] }),
    ]))).toBe(true)
    expect(stockPrepProjectQuerySourceAvailable(null)).toBe(false)
  })

  it('没有来源的行只匹配「全部」—— 不会被塞进 mvp 或 pull_target', () => {
    const rows = buildStockPrepProjectQueryRows(directory([row({ projectNo: PROJECT_A })]), [])
    expect(rows[0].sources).toBeNull()
    expect(filterStockPrepProjectQueryRows(rows, { status: 'all', source: 'all', search: '' })).toHaveLength(1)
    for (const source of ['mvp', 'pull_target', 'both'] as const) {
      expect(filterStockPrepProjectQueryRows(rows, { status: 'all', source, search: '' })).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Q-07 values-free 反向断言
// ---------------------------------------------------------------------------

describe('项目查询 · 搜索词只留在这一屏与地址栏里(Q-07)', () => {
  const SECRET_LOOKING_TERM = '张三的私人备注'

  it('搜索词不进 localStorage、不进任何请求', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    routeApi({
      directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })]),
      boards: { [PROJECT_A]: board(PROJECT_A) },
    })
    const root = await mount()

    const input = testid(root, 'stock-prep-project-query-search') as HTMLInputElement
    input.value = SECRET_LOOKING_TERM
    input.dispatchEvent(new Event('input'))
    await flushUi()
    ;(root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement | null)?.click()
    await flushUi()

    for (const call of setItem.mock.calls) {
      expect(String(call[0]), 'localStorage 的键里不许出现搜索词').not.toContain(SECRET_LOOKING_TERM)
      expect(String(call[1]), 'localStorage 的值里不许出现搜索词').not.toContain(SECRET_LOOKING_TERM)
    }
    for (const call of h.apiFetch.mock.calls) {
      expect(String(call[0]), '请求 URL 里不许出现搜索词').not.toContain(SECRET_LOOKING_TERM)
      expect(JSON.stringify(call[1] ?? null), '请求 body 里不许出现搜索词').not.toContain(SECRET_LOOKING_TERM)
    }
    // 正向对照:它确实进了地址栏 —— 否则上面三条可能只是因为「压根没生效」。
    const written = h.router.replace.mock.calls.map((call) => JSON.stringify(call[0])).join('\n')
    expect(written).toContain(SECRET_LOOKING_TERM)
  })

  it('源码层面:这两个文件不碰 localStorage,也不写日志', () => {
    const files = [
      join(__dirname, '../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue'),
      join(__dirname, '../src/services/integration/stockPreparation/projectQuery.ts'),
    ]
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} 不得直接读写 localStorage`).not.toMatch(/localStorage\s*\./)
      expect(source, `${file} 不得写日志`).not.toMatch(/console\s*\./)
    }
  })
})

// ---------------------------------------------------------------------------
// Q-08 / Q-09 / Q-10
// ---------------------------------------------------------------------------

describe('项目查询 · G1、最近导出、三句提示(Q-08 / Q-09 / Q-10)', () => {
  it('Q-08 整屏只有一个主操作位', async () => {
    routeApi({
      directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })]),
      boards: { [PROJECT_A]: board(PROJECT_A) },
    })
    const root = await mount()
    // 没选中的时候连那一个都还没出现。
    expect(root.querySelectorAll('.sp-pq__primary')).toHaveLength(0)
    ;(root.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement).click()
    await flushUi()
    // jsdom 数的是类;真色值(`--ms-color-primary` 解析之后的填充)由浏览器 lane 数。
    expect(root.querySelectorAll('.sp-pq__primary')).toHaveLength(1)
    expect(testid(root, 'stock-prep-project-query-open-board')!.className).toContain('sp-pq__primary')
    expect(testid(root, 'stock-prep-project-query-open-queue')!.className).not.toContain('sp-pq__primary')
  })

  it('Q-08 两个动作都走 navigate-stage,并且都带项目号', async () => {
    routeApi({
      directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })]),
      boards: { [PROJECT_A]: board(PROJECT_A) },
    })
    const emitted: Array<[string, string | undefined]> = []
    app = createApp(StockPreparationProjectQueryView as Component, {
      scope: SCOPE,
      onNavigateStage: (viewKey: string, projectNo?: string) => emitted.push([viewKey, projectNo]),
    })
    app.mount(container!)
    await flushUi()
    ;(container!.querySelector(`[data-project-no="${PROJECT_A}"]`) as HTMLButtonElement).click()
    await flushUi()
    ;(testid(container!, 'stock-prep-project-query-open-board') as HTMLButtonElement).click()
    ;(testid(container!, 'stock-prep-project-query-open-queue') as HTMLButtonElement).click()
    expect(emitted).toEqual([
      ['project-board', PROJECT_A],
      ['confirmation-queue', PROJECT_A],
    ])
  })

  it('Q-09 最近导出:窗口不完整就是「—」,只有明确说完整了才敢说「从未导出过」', async () => {
    expect(stockPrepLastExportDisplay('2026-09-01T00:00:00.000Z', false)).toBe('timestamp')
    expect(stockPrepLastExportDisplay(null, false)).toBe('never')
    expect(stockPrepLastExportDisplay(null, true)).toBe('unknown')
    // undefined(老后端 / 没 opt-in)绝不能被当成 false —— 这正是 U2 契约要防的那次静默降级。
    expect(stockPrepLastExportDisplay(null, undefined)).toBe('unknown')

    routeApi({
      directory: directory(
        [row({ projectNo: PROJECT_A, sources: ['mvp'], lastExportAt: null })],
        { lastExportAtMayBeIncomplete: true },
      ),
    })
    const root = await mount()
    const cell = testid(root, 'stock-prep-project-query-row-export')!
    expect(cell.textContent).toContain('—')
    expect(cell.textContent).not.toContain('从未')
  })

  it('Q-10 三句中性提示与首页同词同序', async () => {
    routeApi({
      directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })], {
        pullTargetReady: true,
        pullTargetScanCapped: true,
        directoryMayBeIncomplete: true,
      }),
    })
    const root = await mount()
    const banner = testid(root, 'stock-prep-project-query-pull-banner')!
    // scanCapped 比 mayBeIncomplete 更具体,所以它赢 —— 与首页同一条优先级。
    expect(banner.getAttribute('data-pull-banner')).toBe('pull_target_scan_capped')
    expect(banner.textContent).toContain('超过一次扫描的上限')
    app!.unmount()
    app = null
    container!.innerHTML = ''

    resetStockPreparationOperatorHomeDirectoryThrottle()
    routeApi({
      directory: directory([row({ projectNo: PROJECT_A, sources: ['mvp'] })], {
        pullTargetReady: false,
        pullTargetScanCapped: true,
        directoryMayBeIncomplete: true,
      }),
    })
    const second = await mount()
    expect(testid(second, 'stock-prep-project-query-pull-banner')!.getAttribute('data-pull-banner'))
      .toBe('pull_target_unreadable')
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // 字段整体缺席(老后端)= 一句都不说。undefined 不是 false。
    resetStockPreparationOperatorHomeDirectoryThrottle()
    routeApi({
      directory: directory([row({ projectNo: PROJECT_A })], {
        pullTargetReady: undefined,
        pullTargetScanCapped: undefined,
        directoryMayBeIncomplete: undefined,
      }),
    })
    const third = await mount()
    expect(testid(third, 'stock-prep-project-query-pull-banner')).toBeNull()
  })
})
