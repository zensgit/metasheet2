import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 项目备料页 — THE PAGE, and the four claims it must not get wrong.
//
//   B-01 WHO SEES IT. The tab is ABSENT for a read-only operator and for an integration:* holder,
//        present for the operator tier, and it is the LANDING tab for an operator while a platform
//        admin keeps today's landing (确认队列).
//   B-02 THE HANDOFF BUTTON IS OPTIONAL. A deployment whose handoff route is missing (404), not
//        wired (501) or unconfigured (`configured:false`) renders NO 通知下一步 control and says so
//        in 轮到谁 — the page works whether or not that slice has merged.
//   B-03 THE DEEP LINK IS A HANDLE. It renders only when the server returned one, it routes to
//        /multitable/<sheetId>/<viewId>, and it composes NO `?filter=` — the transient per-project
//        filter was not built, and a query param the workbench ignores would be a link that lies.
//   B-04 NO ROW VALUES, NO RAW CODES. The board's own fields are the only business strings on the
//        page; a 404 renders #5445's three-way empty state rather than an error code; and 推送宜搭
//        is a disabled placeholder whose copy says so in words.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read', 'stock-prep:operate'] as string[],
  roles: [] as string[],
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

/** The real ladder, not an exact-match stub: `stock-prep:admin` must satisfy operate here too. */
function realHasPermission(required: string): boolean {
  const normalized = String(required || '').trim()
  if (!normalized) return true
  if (h.roles.includes('admin') || h.permissions.includes('*:*') || h.permissions.includes('admin:all')) return true
  if (h.permissions.includes(normalized)) return true
  const [resource, action] = normalized.split(':')
  if (!resource || !action) return false
  if (h.permissions.includes(`${resource}:*`)) return true
  if (h.permissions.includes(`${resource}:admin`) && action !== 'admin') return true
  if (action === 'read' && h.permissions.includes(`${resource}:write`)) return true
  return false
}

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), roles: h.roles, permissions: h.permissions }),
    hasAdminAccess: () => h.roles.includes('admin'),
    hasPermission: (permission: string) => realHasPermission(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

const routerPush = vi.hoisted(() => vi.fn())
const routerReplace = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}))

import StockPreparationProjectBoardView from '../src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import {
  canOpenStockPrepProjectBoard,
  canRunStockPrepProjectSync,
  landsOnStockPrepProjectBoard,
  STOCK_PREP_OPERATOR_PULL_ACTION_ID,
  STOCK_PREP_OPERATOR_PULL_STEPS,
  STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS,
} from '../src/services/integration/stockPreparation/workbenchAccess'

const backendAccess = require('../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs')

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
const PROJECT_NO = '230920006'
const PROJECT_NAME = 'RY2注射水缓冲罐部件'
const SHEET_ID = 'sheet_abcdef0123456789'
const VIEW_ID = 'view_abcdef0123456789'

function boardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: SCOPE.tenantId,
    projectId: 'stockprep_project_a1',
    projectNo: PROJECT_NO,
    projectName: PROJECT_NAME,
    projectStatus: 'active',
    lastSyncRunId: 'run_a1',
    snapshotBatchCount: 2,
    openExceptionCount: 0,
    heldLineCount: 0,
    readyLineCount: 47,
    archivedSnapshotPresent: true,
    // The rows the pull itself wrote, in the bound target. This is the family the status bar reads.
    pullTargetReady: true,
    pulledRowCount: 47,
    activePulledRowCount: 47,
    pulledRowCountBounded: false,
    pendingDecisionCount: 0,
    lastExportAt: '2026-09-01T02:03:04.000Z',
    fillTarget: { sheetId: SHEET_ID, viewId: VIEW_ID },
    directoryReady: true,
    ledgerReady: true,
    ...overrides,
  }
}

function directoryPayload(): Record<string, unknown> {
  return {
    tenantId: SCOPE.tenantId,
    directoryReady: true,
    ledgerReady: true,
    projectCount: 1,
    pendingProjectCount: 0,
    projects: [{
      projectId: 'stockprep_project_a1',
      projectNo: PROJECT_NO,
      projectName: PROJECT_NAME,
      projectStatus: 'active',
      lastSyncRunId: 'run_a1',
      snapshotBatchCount: 2,
      openExceptionCount: 0,
      heldLineCount: 0,
      readyLineCount: 47,
      pendingDecisionCount: 0,
    }],
  }
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
}

/**
 * The four-step sync api the composed panel drives. Injected through the board's own test seam, so
 * B-09 can run a real pull and then assert on the report that run produced — the emit that used to
 * destroy it is a component event, not a DOM one, and can only be provoked by the real thing.
 */
function syncApiDouble(): Record<string, unknown> {
  return {
    plan: vi.fn().mockResolvedValue({
      canApply: true,
      dryRunToken: 'tok_abc',
      counts: { add: 3, update: 2, skip: 7, inactive: 0, manual_confirm: 0 },
      evidence: {},
      projectName: PROJECT_NAME,
    }),
    reconcile: vi.fn().mockResolvedValue({ counts: { created: 0, existing: 0, pending: 0 } }),
    apply: vi.fn().mockResolvedValue({
      status: 'succeeded',
      apply: { counts: { created: 3, updated: 2, inactive: 0, skipped: 7, held: 0, failed: 0 } },
    }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 5, run: 1 } }),
  }
}

/** Type the number into the composed pull panel and press 同步. */
async function runPullPanel(root: HTMLElement, projectNo = PROJECT_NO): Promise<void> {
  const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
  input.value = projectNo
  input.dispatchEvent(new Event('input'))
  await nextTick()
  ;(root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement).click()
  await flush()
}

function notFound(code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'no' } }), { status: 404 })
}

interface RouteOptions {
  board?: Response | (() => Response)
  handoff?: Response | (() => Response)
}

/** Route the mocked apiFetch by path so a spec can vary one endpoint without restating the others. */
function routeApi(options: RouteOptions = {}): void {
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/operator/projects')) return ok(directoryPayload())
    if (path.includes('/board')) {
      const answer = options.board ?? ok(boardPayload())
      return typeof answer === 'function' ? answer() : answer
    }
    if (path.includes('/handoff')) {
      const answer = options.handoff ?? new Response('', { status: 404 })
      return typeof answer === 'function' ? answer() : answer
    }
    return ok({})
  })
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

describe('项目备料页 — the operator project board', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    routeApi()
    routerPush.mockReset()
    routerReplace.mockReset()
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

  function mount(component: Component, props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(component, props)
    app.mount(container!)
    return container!
  }

  function remount(): void {
    if (app) app.unmount()
    app = null
    container!.innerHTML = ''
  }

  async function mountBoard(props: Record<string, unknown> = {}): Promise<HTMLElement> {
    const root = mount(StockPreparationProjectBoardView, { scope: SCOPE, projectNo: PROJECT_NO, ...props })
    await flush()
    return root
  }

  // ---- B-01 the tab, and whose landing it is -------------------------------------------------

  it('B-01: the tab is present for the operator tier and absent for everyone below it', async () => {
    const cases: { permissions: string[]; roles: string[]; visible: boolean }[] = [
      { permissions: ['stock-prep:read', 'stock-prep:operate'], roles: [], visible: true },
      { permissions: ['stock-prep:admin'], roles: [], visible: true },
      { permissions: [], roles: ['admin'], visible: true },
      { permissions: ['stock-prep:read'], roles: [], visible: false },
      { permissions: ['stock-prep:operate'], roles: [], visible: false },
      { permissions: ['integration:write'], roles: [], visible: false },
      { permissions: [], roles: [], visible: false },
    ]
    for (const actor of cases) {
      h.permissions = [...actor.permissions]
      h.roles = [...actor.roles]
      const root = mount(StockPreparationWorkspace)
      await nextTick()
      const tab = root.querySelector('[data-testid="stock-prep-tab-project-board"]')
      expect(Boolean(tab), `${JSON.stringify(actor)} tab visibility`).toBe(actor.visible)
      // The predicate and the DOM must agree — the tab is not allowed to have its own opinion.
      expect(canOpenStockPrepProjectBoard(realHasPermission)).toBe(actor.visible)
      remount()
    }
  })

  it('B-01: an operator LANDS on the board; a platform admin keeps 确认队列', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    let root = mount(StockPreparationWorkspace)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('project-board')
    expect(landsOnStockPrepProjectBoard(realHasPermission)).toBe(true)
    remount()

    h.permissions = ['integration:admin']
    h.roles = ['admin']
    root = mount(StockPreparationWorkspace)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('confirmation-queue')
    expect(landsOnStockPrepProjectBoard(realHasPermission)).toBe(false)
  })

  it('B-01: the pull control follows the SERVER split, and the two vocabularies are byte-mirrored', () => {
    expect(STOCK_PREP_OPERATOR_PULL_ACTION_ID).toBe(backendAccess.STOCK_PREP_OPERATOR_PULL_ACTION_ID)
    expect(STOCK_PREP_OPERATOR_PULL_STEPS.map((step) => ({ ...step })))
      .toEqual(backendAccess.STOCK_PREP_OPERATOR_PULL_STEPS.map((step: Record<string, unknown>) => ({ ...step })))
    expect(STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS.map((step) => ({ ...step })))
      .toEqual(backendAccess.STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS.map((step: Record<string, unknown>) => ({ ...step })))

    // The web predicate and the server rule must admit the same principals for the pull action.
    for (const actor of [
      { permissions: ['stock-prep:read', 'stock-prep:operate'], roles: [] as string[] },
      { permissions: ['stock-prep:operate'], roles: [] as string[] },
      { permissions: ['stock-prep:read'], roles: [] as string[] },
      { permissions: ['integration:write'], roles: [] as string[] },
      { permissions: ['integration:admin'], roles: ['admin'] },
      { permissions: [] as string[], roles: [] as string[] },
    ]) {
      h.permissions = [...actor.permissions]
      h.roles = [...actor.roles]
      const flattened = [...actor.permissions, ...actor.roles.map((role) => `role:${role}`)]
      const serverAdmitsOperator = backendAccess.operatorMayRunStockPrepPull(flattened, STOCK_PREP_OPERATOR_PULL_ACTION_ID)
      // The button renders when EITHER tier admits: the legacy platform admin, or the operator tier.
      const legacyAdmin = flattened.includes('integration:admin') || flattened.includes('role:admin')
      expect(canRunStockPrepProjectSync(realHasPermission)).toBe(serverAdmitsOperator || legacyAdmin)
    }
  })

  // ---- B-02 the handoff button is optional ---------------------------------------------------

  it('B-02: no 通知下一步 control when the handoff route is absent, not wired, or unconfigured', async () => {
    const absent: Response[] = [
      new Response('', { status: 404 }),
      new Response(JSON.stringify({ ok: false, error: { code: 'X' } }), { status: 501 }),
      ok({ configured: false, projectNo: PROJECT_NO, currentStepKey: null, stepIndex: null, stepCount: 0, terminal: false, completed: false, isCurrentHandler: false }),
    ]
    for (const handoff of absent) {
      routeApi({ handoff })
      const root = await mountBoard()
      expect(root.querySelector('[data-testid="stock-prep-project-board-notify-next"]')).toBeNull()
      const turn = root.querySelector('[data-testid="stock-prep-project-board-turn"]') as HTMLElement
      expect(turn.textContent).toContain('没有设置流转顺序')
      // Absence is not an error: the rest of the page is fully rendered.
      expect(root.querySelector('[data-testid="stock-prep-project-board-error"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()
      remount()
    }
  })

  it('B-02: a configured handoff renders the control and says whose turn it is', async () => {
    routeApi({
      handoff: ok({
        configured: true,
        projectNo: PROJECT_NO,
        currentStepKey: 'purchasing',
        stepIndex: 1,
        stepCount: 3,
        terminal: false,
        completed: false,
        isCurrentHandler: true,
      }),
    })
    const root = await mountBoard()
    const button = root.querySelector('[data-testid="stock-prep-project-board-notify-next"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(false)
    expect((root.querySelector('[data-testid="stock-prep-project-board-turn"]') as HTMLElement).textContent).toContain('轮到您了')
  })

  it('B-02: when it is somebody else\'s turn the control renders but cannot be pressed', async () => {
    routeApi({
      handoff: ok({
        configured: true,
        projectNo: PROJECT_NO,
        currentStepKey: 'warehouse',
        stepIndex: 2,
        stepCount: 3,
        terminal: false,
        completed: false,
        isCurrentHandler: false,
      }),
    })
    const root = await mountBoard()
    const button = root.querySelector('[data-testid="stock-prep-project-board-notify-next"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(true)
  })

  // ---- B-03 the deep link ---------------------------------------------------------------------

  it('B-03: the fill link renders only when the server returned a handle, and routes to it', async () => {
    const root = await mountBoard()
    const open = root.querySelector('[data-testid="stock-prep-project-board-open-multitable"]') as HTMLButtonElement
    expect(open).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-no-fill-target"]')).toBeNull()
    remount()

    routeApi({ board: ok(boardPayload({ fillTarget: null })) })
    const noTarget = await mountBoard()
    expect(noTarget.querySelector('[data-testid="stock-prep-project-board-open-multitable"]')).toBeNull()
    expect(noTarget.querySelector('[data-testid="stock-prep-project-board-no-fill-target"]')).not.toBeNull()
  })

  it('B-03: the shell routes the handle to /multitable/<sheetId>/<viewId> and composes NO filter', async () => {
    const root = mount(StockPreparationWorkspace)
    await flush()
    // The shell opens with nothing typed (no `?projectNo=`), so open the project the way an operator
    // would — that is also what proves the shell wires the board's events, not just its props.
    const input = root.querySelector('[data-testid="stock-prep-project-board-input"]') as HTMLInputElement
    input.value = PROJECT_NO
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-board-open"]') as HTMLButtonElement).click()
    await flush()
    const open = root.querySelector('[data-testid="stock-prep-project-board-open-multitable"]') as HTMLButtonElement
    expect(open, 'the operator lands on the board with a fill target').not.toBeNull()
    open.click()
    await flush()
    expect(routerPush).toHaveBeenCalledTimes(1)
    const target = routerPush.mock.calls[0][0] as { path: string }
    expect(target.path).toBe(`/multitable/${SHEET_ID}/${VIEW_ID}`)
    // THE HONEST HALF: no transient filter was built, so none is promised.
    expect(target.path).not.toContain('filter')
    expect(JSON.stringify(routerPush.mock.calls[0])).not.toContain('filter')
  })

  // ---- B-04 values, empty states and the placeholder -------------------------------------------

  it('B-04: a 404 renders the three-way empty state, not a raw code', async () => {
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    const empty = root.querySelector('[data-testid="stock-prep-project-board-empty"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.textContent).toContain('查不到')
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).toBeNull()
  })

  it('B-04: the status bar carries the project\'s own number and name, counts and timestamps — nothing else', async () => {
    const root = await mountBoard()
    const status = root.querySelector('[data-testid="stock-prep-project-board-status"]') as HTMLElement
    expect(status.textContent).toContain(PROJECT_NO)
    expect(status.textContent).toContain(PROJECT_NAME)
    expect((root.querySelector('[data-testid="stock-prep-project-board-rows"]') as HTMLElement).textContent).toContain('47')
    expect((root.querySelector('[data-testid="stock-prep-project-board-pull-state"]') as HTMLElement).textContent).toContain('47')
    // No internal handle is ever rendered — the projectId and the runId are state, not copy.
    expect(status.textContent).not.toContain('stockprep_project_a1')
    expect(status.textContent).not.toContain('run_a1')
  })

  it('B-04: 推送宜搭 is a disabled placeholder that says so in words', async () => {
    const root = await mountBoard()
    const yida = root.querySelector('[data-testid="stock-prep-project-board-yida"]') as HTMLButtonElement
    expect(yida).not.toBeNull()
    expect(yida.disabled).toBe(true)
    expect(`${yida.textContent} ${yida.getAttribute('title')}`).toContain('暂未接入')
  })

  it('B-04: opening a project mirrors the NUMBER into the query, never the internal handle', async () => {
    const root = mount(StockPreparationWorkspace)
    await flush()
    const input = root.querySelector('[data-testid="stock-prep-project-board-input"]') as HTMLInputElement
    input.value = PROJECT_NO
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-board-open"]') as HTMLButtonElement).click()
    await flush()
    expect(routerReplace).toHaveBeenCalled()
    const query = (routerReplace.mock.calls[0][0] as { query: Record<string, string> }).query
    expect(query.projectNo).toBe(PROJECT_NO)
    expect(JSON.stringify(query)).not.toContain('stockprep_project_a1')
  })

  it('B-04: the search datalist carries the caller\'s own directory, by number AND name', async () => {
    const root = await mountBoard({ projectNo: '' })
    const options = root.querySelectorAll('[data-testid="stock-prep-project-board-datalist"] option')
    expect(options.length).toBe(1)
    expect((options[0] as HTMLOptionElement).value).toBe(PROJECT_NO)
    expect(options[0].textContent).toBe(PROJECT_NAME)
  })

  // ---- B-07: THE PULL IS REACHABLE WHEN THERE IS NOTHING TO SHOW ------------------------------
  //
  // THE BUG. 从PLM拉取 lived inside `v-if="board"`, and the board 404s for a project number this
  // tenant has no data for. So the ONE control that CREATES that data was reachable only after the
  // data existed: an operator could never pull a NEW project from the page built for pulling
  // projects. The tenant boundary is untouched — the server still answers a foreign tenant's number
  // with a 404 byte-identical to an unknown one; what changed is only what this tab renders around
  // that refusal.

  it('B-07: a project with no data still shows the search box and the 从PLM拉取 panel', async () => {
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })

    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-input"]')).not.toBeNull()
    const pull = root.querySelector('[data-testid="stock-prep-project-board-pull"]')
    expect(pull, 'the pull panel must be reachable exactly when the board is empty').not.toBeNull()
    expect(pull.querySelector('[data-testid="stock-prep-project-sync"]')).not.toBeNull()
    // ...and it is ENABLED for this tier, seeded with the number the operator just typed.
    const run = root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement
    expect(run).not.toBeNull()
    expect(run.disabled).toBe(false)
    expect((root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement).value)
      .toBe('NO-SUCH-PROJECT')
    // The empty state still says which of the three situations this is.
    expect(root.querySelector('[data-testid="stock-prep-project-board-empty"]')).not.toBeNull()
  })

  it('B-07: exactly ONE pull panel is mounted, board or no board', async () => {
    const withBoard = await mountBoard()
    expect(withBoard.querySelectorAll('[data-testid="stock-prep-project-sync"]').length).toBe(1)
    remount()
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const without = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    expect(without.querySelectorAll('[data-testid="stock-prep-project-sync"]').length).toBe(1)
  })

  // ---- B-08: READ-SHAPED FAILURE COPY, AND NO DOUBLE ANSWER ------------------------------------

  it('B-08: a 404 does not ALSO render the write-failure banner', async () => {
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    expect(root.querySelector('[data-testid="stock-prep-project-board-empty"]')).not.toBeNull()
    expect(
      root.querySelector('[data-testid="stock-prep-project-board-error"]'),
      'the empty state already explains the 404 - the banner must not answer it a second time',
    ).toBeNull()
    expect(root.textContent).not.toContain('没有保存成功')
  })

  it('B-08: a board READ failure never says "nothing was saved"', async () => {
    routeApi({
      board: () => new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'x' } }), { status: 500 }),
    })
    const root = await mountBoard()
    const banner = root.querySelector('[data-testid="stock-prep-project-board-error"]') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('没能读到')
    expect(banner.textContent).not.toContain('没有保存成功')
  })

  // ---- B-09: A REFRESH DOES NOT UNMOUNT WHAT THE OPERATOR IS READING ---------------------------
  //
  // THE BUG. '@synced="reloadBoard"' fires inside the panel's own emit, and the loader's first
  // statement was 'board.value = null' - so Vue tore down the 'v-if="board"' subtree, the composed
  // sync panel with it, BEFORE the finished four-step report had ever rendered. The operator watched
  // their run's result vanish at the moment it succeeded.

  it('B-09: nothing the operator is reading is unmounted WHILE the refresh is in flight', async () => {
    // The board's second read is held open, so the in-flight window is observable rather than a
    // frame nobody can catch. That window is the whole bug: the old loader nulled 'board' as its
    // first statement, so everything under 'v-if="board"' disappeared for the duration of a network
    // round trip and came back rebuilt - and the four-step report, which lived there too, came back
    // empty because its component had been destroyed.
    let boardReads = 0
    let releaseSecondRead: (() => void) | null = null
    const secondRead = new Promise<void>((resolve) => { releaseSecondRead = resolve })
    routeApi({
      board: (() => {
        boardReads += 1
        if (boardReads === 1) return ok(boardPayload())
        return secondRead.then(() => ok(boardPayload())) as unknown as Response
      }) as unknown as () => Response,
    })

    const root = await mountBoard({ syncApi: syncApiDouble() })
    expect(boardReads).toBe(1)
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()

    // A REAL run, which is the only thing that emits '@synced'.
    await runPullPanel(root)
    expect(boardReads).toBeGreaterThan(1)

    // MID-FLIGHT: the second board read has not resolved yet.
    expect(
      root.querySelector('[data-testid="stock-prep-project-board-status"]'),
      'the board must stay on screen while its own refresh is in flight',
    ).not.toBeNull()
    expect(
      root.querySelector('[data-testid="stock-prep-project-sync-verdict"]'),
      'and so must the finished four-step report the refresh was triggered by',
    ).not.toBeNull()

    releaseSecondRead!()
    await flush()

    // …and after it lands, both are still there.
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')).not.toBeNull()
    expect(root.querySelectorAll('[data-testid="stock-prep-project-sync-step"]').length).toBeGreaterThan(0)
  })

  it('B-09: a refresh that FAILS leaves the numbers that were correct a second ago', async () => {
    let boardReads = 0
    routeApi({
      board: () => {
        boardReads += 1
        return boardReads === 1
          ? ok(boardPayload())
          : new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'x' } }), { status: 500 })
      },
    })
    const root = await mountBoard({ syncApi: syncApiDouble() })
    await runPullPanel(root)
    expect(boardReads).toBeGreaterThan(1)
    expect(
      root.querySelector('[data-testid="stock-prep-project-board-status"]'),
      'a background re-read that fails must not take the board away',
    ).not.toBeNull()
    expect(
      root.querySelector('[data-testid="stock-prep-project-sync-verdict"]'),
      'nor the report of the run that just finished',
    ).not.toBeNull()
  })

  // ---- B-10: THE PULL, NOT THE ARCHIVE, ANSWERS THE "has it been pulled?" QUESTION -------------

  it('B-10: rows in the bound table read as PULLED even with no archived snapshot', async () => {
    routeApi({
      board: ok(boardPayload({
        // Exactly the shape an operator's own run produces: apply wrote the rows, mvp-persist (which
        // is platform-admin) never ran, so the whole archive family is absent.
        projectId: null,
        projectName: null,
        lastSyncRunId: null,
        snapshotBatchCount: 0,
        heldLineCount: 0,
        readyLineCount: 0,
        archivedSnapshotPresent: false,
        pullTargetReady: true,
        pulledRowCount: 47,
        activePulledRowCount: 47,
      })),
    })
    const root = await mountBoard()
    const pullState = root.querySelector('[data-testid="stock-prep-project-board-pull-state"]') as HTMLElement
    expect(pullState.textContent).toContain('已拉进来')
    expect(pullState.textContent).not.toContain('还没从 PLM 拉过这个项目')
    expect((root.querySelector('[data-testid="stock-prep-project-board-rows"]') as HTMLElement).textContent).toContain('47')
    // And the archive is named as the administrator's, not shown as zeros reading like "never pulled".
    const archive = root.querySelector('[data-testid="stock-prep-project-board-archive"]') as HTMLElement
    expect(archive.textContent).toContain('管理员')
  })

  it('B-10: no rows anywhere still says so plainly', async () => {
    routeApi({
      board: ok(boardPayload({
        lastSyncRunId: null,
        archivedSnapshotPresent: false,
        pullTargetReady: true,
        pulledRowCount: 0,
        activePulledRowCount: 0,
      })),
    })
    const root = await mountBoard()
    expect((root.querySelector('[data-testid="stock-prep-project-board-pull-state"]') as HTMLElement).textContent)
      .toContain('还没从 PLM 拉过这个项目')
  })

  // ---- B-11: THE MULTITABLE CONTROL IS NEVER A SILENT NO-OP ------------------------------------

  it('B-11: with no fill handle the multitable control still goes somewhere', async () => {
    routeApi({ board: ok(boardPayload({ fillTarget: null })) })
    const root = await mountBoard()
    expect(root.querySelector('[data-testid="stock-prep-project-board-open-multitable"]')).toBeNull()
    const fallback = root.querySelector('[data-testid="stock-prep-project-board-open-multitable-fallback"]') as HTMLButtonElement
    expect(fallback, 'a board with no handle must still offer the plain workbench').not.toBeNull()
    expect(fallback.disabled).toBe(false)
  })

  /** The shell has no '?projectNo=' in these specs, so a board only appears once one is opened. */
  async function openProjectInShell(root: HTMLElement): Promise<void> {
    const input = root.querySelector('[data-testid="stock-prep-project-board-input"]') as HTMLInputElement
    input.value = PROJECT_NO
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-board-open"]') as HTMLButtonElement).click()
    await flush()
  }

  it('B-11: the shell routes a null handle to the plain multitable workbench', async () => {
    routeApi({ board: ok(boardPayload({ fillTarget: null })) })
    const root = mount(StockPreparationWorkspace)
    await flush()
    await openProjectInShell(root)
    const fallback = root.querySelector('[data-testid="stock-prep-project-board-open-multitable-fallback"]') as HTMLButtonElement
    expect(fallback).not.toBeNull()
    fallback.click()
    await flush()
    expect(routerPush).toHaveBeenCalledWith({ path: '/multitable' })
  })

  it('B-11: a real handle still deep-links to the bound sheet and view', async () => {
    const root = mount(StockPreparationWorkspace)
    await flush()
    await openProjectInShell(root)
    const cta = root.querySelector('[data-testid="stock-prep-project-board-open-multitable"]') as HTMLButtonElement
    expect(cta).not.toBeNull()
    cta.click()
    await flush()
    expect(routerPush).toHaveBeenCalledWith({ path: `/multitable/${SHEET_ID}/${VIEW_ID}` })
  })
})
