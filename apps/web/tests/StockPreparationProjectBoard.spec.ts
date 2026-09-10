import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h as createElement, nextTick, ref, type App as VueApp, type Component } from 'vue'

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
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

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
    lastChangedFromPlmAt: null,
    lastChangedFromPlmBounded: false,
    pendingDecisionCount: 0,
    lastExportAt: '2026-09-01T02:03:04.000Z',
    fillTarget: { sheetId: SHEET_ID, viewId: VIEW_ID },
    directoryReady: true,
    ledgerReady: true,
    ...overrides,
  }
}

function directoryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    // U2's union opt-in is what 今天要处理 sends, and this is the key it now brings back: the SAME
    // `{ sheetId, viewId }` the board returns, from the same server-side tenant gate.
    fillTarget: { sheetId: SHEET_ID, viewId: VIEW_ID },
    ...overrides,
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
function syncApiDouble(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dryRun: vi.fn().mockResolvedValue({
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
    ...overrides,
  }
}

/** A large-BOM job api double that drives the bounded channel to `done` in one pass. */
function largeBomApiDouble({ onApplied }: { onApplied?: () => void } = {}): Record<string, unknown> {
  return {
    startExpansion: vi.fn().mockResolvedValue({ jobId: 'job_1', status: 'queued', authoritative: false }),
    runExpansion: vi.fn().mockResolvedValue({
      jobId: 'job_1',
      status: 'completed',
      authoritative: true,
      progress: { rowsExpanded: 620, readCount: 640, frontierRemaining: 0, completedChunks: 1 },
      budgets: { maxRows: 5000, maxPages: 50, maxReadCount: 6000, maxElapsedMs: 60000, maxDepth: 10, maxArtifactChunks: 1 },
    }),
    planExpansion: vi.fn().mockResolvedValue({
      jobId: 'job_1',
      status: 'completed',
      authoritative: true,
      evidence: { plan: { counts: { add: 620, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } } },
    }),
    startApply: vi.fn().mockResolvedValue({
      jobId: 'apply_1',
      status: 'queued',
      counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 },
    }),
    // The moment the rows really land in the sheet.
    runApplyChunk: vi.fn().mockImplementation(async () => {
      onApplied?.()
      return {
        jobId: 'apply_1',
        status: 'succeeded',
        counts: { created: 620, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 },
      }
    }),
    getExpansion: vi.fn().mockResolvedValue({ jobId: 'job_1', status: 'completed', authoritative: true }),
    getApply: vi.fn().mockResolvedValue({ jobId: 'apply_1', status: 'succeeded' }),
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
  /** Overrides folded into the directory payload — F-01/F-02 vary `fillTarget` and nothing else. */
  directory?: Record<string, unknown>
}

/** Route the mocked apiFetch by path so a spec can vary one endpoint without restating the others. */
function routeApi(options: RouteOptions = {}): void {
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/operator/projects')) {
      // FAITHFUL TO THE SERVER CONTRACT, and B-11 depends on it: `fillTarget` rides the U2 opt-in,
      // so the un-opted-in read 项目备料页 makes (see the view's `loadDirectory`) carries NO handle at
      // all. A fixture that returned it on every call would hand the workspace face a handle the real
      // server never sends there, and would quietly turn B-11's null-handle case into a deep link.
      const unioned = path.includes('includePullTargets=1')
      return ok(directoryPayload(unioned ? options.directory : { ...options.directory, fillTarget: undefined }))
    }
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
    // P0 补项 4c: the board's directory read is throttled per scope (operatorHomeDirectory.ts). Every
    // test in this file uses the SAME `SCOPE`, so a cold cache per test keeps each mount's directory
    // fetch behaving exactly as it did before the throttle existed — no test here is ABOUT the
    // throttle itself (that lives in StockPreparationOperatorHome.spec.ts).
    resetStockPreparationOperatorHomeDirectoryThrottle()
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
      expect(canOpenStockPrepProjectBoard({ roles: h.roles, permissions: h.permissions })).toBe(actor.visible)
      remount()
    }
  })

  // P1-1 / D2=A (2026-09-08). This case is about WHOSE LANDING IS WHOSE, and both halves still say
  // exactly that — the keys they name moved:
  //   * the operator lands on 今天要处理 rather than 项目备料. Same component, same pixels: P0 already
  //     rendered the task home inside the board whenever no project was open, and P1-1 gave that
  //     page its own rail item. `landsOnStockPrepProjectBoard` — the tier predicate, unchanged — is
  //     still asserted, because it is still what decides that this actor gets the operator landing.
  //   * the platform admin no longer keeps 确认队列. That is the D2 ruling itself: landing an admin
  //     on an empty queue was the documented dead end (设计稿 §2.3 A1). They land on 开始使用 here
  //     because this file's `routeApi` answers the deployment preflight with `{}`, i.e. not ready —
  //     and a not-ready (or unreadable) deployment lands on the wizard, never on the health page.
  it('B-01: an operator LANDS on 今天要处理; a platform admin lands where D2 sends them', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    h.roles = []
    let root = mount(StockPreparationWorkspace)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('home')
    expect(landsOnStockPrepProjectBoard({ roles: h.roles, permissions: h.permissions })).toBe(true)
    // ...and 项目备料 is still one click away, still its own rail item.
    expect(root.querySelector('[data-testid="stock-prep-tab-project-board"]')).not.toBeNull()
    remount()

    h.permissions = ['integration:admin']
    h.roles = ['admin']
    root = mount(StockPreparationWorkspace)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('getting-started')
    expect(landsOnStockPrepProjectBoard({ roles: h.roles, permissions: h.permissions })).toBe(false)
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
      expect(canRunStockPrepProjectSync({ roles: h.roles, permissions: h.permissions })).toBe(serverAdmitsOperator || legacyAdmin)
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

  // ---- B-16: THE BOUNDED BACKGROUND CHANNEL ALSO ENDS IN A REFRESH ---------------------------
  //
  // THE BUG. A large BOM leaves `runStockPreparationProjectSync` early and hands off to the
  // background channel, so the parent panel's `synced` never fired for it. The board therefore never
  // re-read after the channel imported its rows: no row count, no export button, and an empty state
  // still telling the operator to have an administrator sync a project they had just synced.

  it('B-16: after a bounded large-BOM pull the board re-reads and the export button appears', async () => {
    let boardReads = 0
    // THE TIMING IS THE WHOLE TEST. The parent panel emits its own `synced` when the four-step run
    // returns — which for a large BOM is the HANDOFF, before the channel has written a single row. So
    // the board is modelled the way the server really behaves: 404 until the channel's apply chunk
    // has actually run, a board afterwards. A refresh that only happens at handoff therefore sees the
    // 404 and leaves the operator on an empty page forever, which is exactly the reported bug; only a
    // refresh driven by the channel's COMPLETION can find the rows.
    let rowsWritten = false
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (path.includes('/board')) {
        boardReads += 1
        return rowsWritten
          ? ok(boardPayload())
          : notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
      }
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      return ok({})
    })

    const root = await mountBoard({
      // The small route reports the BOM is too large and hands off; the channel then completes.
      syncApi: syncApiDouble({
        dryRun: vi.fn().mockResolvedValue({
          status: 'large_bom_bounded',
          canApply: false,
          dryRunToken: null,
          counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
          evidence: {},
        }),
      }),
      largeBomApi: largeBomApiDouble({ onApplied: () => { rowsWritten = true } }),
      largeBomPollWait: async () => {},
    })
    expect(boardReads).toBe(1)
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).toBeNull()
    const readsBeforeRun = boardReads

    await runPullPanel(root)

    // The channel is mounted and finished…
    const channel = root.querySelector('[data-testid="stock-prep-large-bom-pull"]')
    expect(channel, 'the bounded background channel is the path this run took').not.toBeNull()

    // …and the board re-read AFTER the rows landed, not merely at handoff.
    expect(rowsWritten, 'the channel really wrote its rows').toBe(true)
    expect(boardReads, 'the background channel must end in a board refresh, like the small route does')
      .toBeGreaterThan(readsBeforeRun + 1)
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()
    expect(
      root.querySelector('[data-testid="stock-prep-project-board-export"]'),
      'and the operator can now export what they just pulled',
    ).not.toBeNull()
  })

  // ---- B-14: THE EMPTY STATE POINTS AT THE FIX, WHICH IS DIRECTLY BELOW IT --------------------
  //
  // The board reused the DIRECTORY's three-way empty state, which was written for the confirmation
  // queue — a page with no pull button, where 「请管理员先把项目同步进来」 is genuinely the next
  // step. Here it is a dead end pointing away from the answer: 从PLM拉取数据 renders six inches
  // below, and this operator may press it.

  it('B-14: a 404 tells the operator to pull it in, and names the control below', async () => {
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    const empty = root.querySelector('[data-testid="stock-prep-project-board-empty"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.textContent).toContain('还没有数据')
    expect(empty.textContent).toContain('从PLM拉取数据')
    expect(empty.textContent, 'the fix is on this page — do not send them away for it')
      .not.toContain('请管理员')
    // …and the control it names really is rendered, so the sentence is not a promise about a button
    // that is not there.
    const run = root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement
    expect(run).not.toBeNull()
    // H14 — AND IT CARRIES THAT NAME. Rendering *a* button was never the claim: the sentence names a
    // control, and until this assertion existed the button underneath said 「同步这个项目」 while the
    // sentence above it said 「从PLM拉取数据」. An operator who reads a page that names a button it
    // does not have looks down, finds no such thing, and stops — a dead end that is worse for
    // pointing at something visible. The repeat-safety promise rides along, because it is a fact
    // about the button rather than about the word.
    expect(run.textContent).toContain('从PLM拉取数据')
    expect(run.textContent, 'and it still promises what pressing twice does').toContain('不会重复写')
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).toBeNull()
  })

  // ---- B-17 (H13): THE TENANCY AND SCHEMA REFUSALS HAVE WORDS OF THEIR OWN ---------------------
  //
  // Both reach this page and neither had a sentence, so both fell through to the board's read
  // generic 「没能读到这个项目的情况,请稍后再试一次」. For a tenantless platform admin that invites a
  // person to retry forever a refusal that will never change; for a deployment one migration behind
  // it hides the only thing anyone could act on. Both now say what the account or the system is, and
  // whether waiting is the fix.

  it('B-17: a tenantless principal is told it is the account, not an outage', async () => {
    routeApi({
      board: () => new Response(
        JSON.stringify({ ok: false, error: { code: 'OPERATOR_SCOPE_TENANT_REQUIRED', message: 'x' } }),
        { status: 403 },
      ),
    })
    const root = await mountBoard()
    const banner = root.querySelector('[data-testid="stock-prep-project-board-error"]') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('不属于任何一家工厂')
    expect(banner.textContent, 'retrying is precisely what will not help').toContain('再试也一样')
    expect(banner.textContent, 'the read generic must not answer this').not.toContain('请稍后再试一次')
    expect(banner.textContent, 'and this page writes nothing').not.toContain('没有保存成功')
  })

  // ---------------------------------------------------------------------------
  // P0-5 —— TWO LINES ON THE SURFACE THE FLOOR ACTUALLY USES.
  //
  // `HANDOFF_NOT_CURRENT_HANDLER`'s second line —「看上面「轮到谁」,轮到您时这个按钮会自己亮」—
  // has exactly one render point in the whole app, and it is this banner. A wave that widened the
  // vocabulary but taught only the admin-facing queue to render the second line would have written
  // that sentence for nobody.
  // ---------------------------------------------------------------------------

  it('P0-5: a refusal renders 发生了什么 / 该做什么 plus a copy button', async () => {
    routeApi({
      board: () => new Response(
        JSON.stringify({ ok: false, error: { code: 'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER', message: 'x' } }),
        { status: 409 },
      ),
    })
    const root = await mountBoard()
    const banner = root.querySelector('[data-testid="stock-prep-project-board-error"]') as HTMLElement
    expect(banner).not.toBeNull()
    // First line: what happened. Unchanged from before this wave.
    expect(banner.textContent).toContain('现在不是您这一步')
    // Second line: what to do about it, and who does it.
    const next = banner.querySelector('[data-testid="stock-prep-project-board-error-next"]') as HTMLElement
    expect(next, 'the second line has nowhere else to render').not.toBeNull()
    expect(next.textContent).toContain('轮到')
    // ...and the one thing a person can hand to us.
    expect(banner.querySelector('[data-testid="stock-prep-project-board-error-copy"]')).not.toBeNull()
  })

  it('B-17: a database one migration behind names the fix instead of the generic', async () => {
    routeApi({
      board: () => new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE', message: 'x', details: { migration: '086' } },
        }),
        { status: 503 },
      ),
    })
    const root = await mountBoard()
    const banner = root.querySelector('[data-testid="stock-prep-project-board-error"]') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('数据库还差一次升级')
    expect(banner.textContent, 'this one IS clearable — but by an administrator, not by waiting')
      .toContain('管理员')
    expect(banner.textContent).not.toContain('没有保存成功')
  })

  it('B-14: …and only says "find an administrator" when the caller truly cannot pull', async () => {
    // A stock-prep:admin holder opens the tab (canOpenStockPrepProjectBoard) but does NOT satisfy
    // canRunStockPrepProjectSync's conjunction, so for them the pull control is genuinely absent and
    // pointing at somebody else is the honest answer rather than a dead end.
    h.permissions = ['stock-prep:read']
    h.roles = []
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    const empty = root.querySelector('[data-testid="stock-prep-project-board-empty"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.textContent).toContain('还没有数据')
    expect(empty.textContent).toContain('平台管理员')
  })

  // ---- B-15: A STALE RESPONSE NEVER OVERWRITES THE PROJECT THE OPERATOR JUST OPENED -----------

  it('B-15: an in-flight refresh cannot land on a newly opened project', async () => {
    // The refresh's board read is held open; while it is in flight the operator opens ANOTHER
    // project, which resolves first. When the stale answer finally arrives it must be dropped.
    const OTHER_NO = '230920099'
    let releaseStale: (() => void) | null = null
    const stale = new Promise<void>((resolve) => { releaseStale = resolve })
    let boardReads = 0
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) return ok(directoryPayload())
      if (path.includes('/board')) {
        boardReads += 1
        if (boardReads === 1) return ok(boardPayload())
        if (boardReads === 2) return stale.then(() => ok(boardPayload())) as unknown as Response
        return ok(boardPayload({ projectNo: OTHER_NO, projectName: null }))
      }
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      return ok({})
    })

    const projectNoProp = ref(PROJECT_NO)
    const Harness = defineComponent({
      setup() {
        return () => createElement(StockPreparationProjectBoardView as Component, {
          scope: SCOPE,
          projectNo: projectNoProp.value,
          syncApi: syncApiDouble(),
        })
      },
    })
    const root = mount(Harness)
    await flush()
    await runPullPanel(root)
    expect(boardReads).toBe(2)

    // HALF ONE: while that refresh is out, 「打开这个项目」 is disabled, so the operator cannot start
    // the race by hand at all.
    const openButton = root.querySelector('[data-testid="stock-prep-project-board-open"]') as HTMLButtonElement
    expect(openButton.disabled, 'the open control is disabled while a refresh is in flight').toBe(true)

    // HALF TWO — the necessary half. The SHELL can still change which project this tab is about
    // (a ?projectNo= navigation drives the prop watch), and that path has no button to disable. The
    // request generation is what makes it safe.
    projectNoProp.value = OTHER_NO
    await flush()
    expect(
      (root.querySelector('[data-testid="stock-prep-project-board-title"]') as HTMLElement).textContent,
    ).toContain(OTHER_NO)

    // The stale refresh answers now, about the PREVIOUS project.
    releaseStale!()
    await flush()
    expect(
      (root.querySelector('[data-testid="stock-prep-project-board-title"]') as HTMLElement).textContent,
      'a response for a project the operator has navigated away from must never be rendered',
    ).toContain(OTHER_NO)
  })

  it('B-15: a background refresh that fails raises no error banner', async () => {
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
      root.querySelector('[data-testid="stock-prep-project-board-error"]'),
      'the operator did not ask for that read; an error about it is noise that outlives the failure',
    ).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()
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

  // 最近变更(来自 PLM) — three states, and the middle one exists only because the row scan behind it
  // can be TRUNCATED (see stock-preparation-project-board.cjs `lastChangedFromPlmBounded`). The
  // message for that state must say "we could not count", not "never changed" — those are different
  // facts. NOTE: this is deliberately NOT labelled 上次同步/last sync — `lastPlmRefreshAt` is only
  // written on an add/update/inactive decision, never on a no-op sync (makeSkipDecision), so it can
  // sit unchanged across many successful pulls that found nothing new.
  it('B-04: 最近变更(来自 PLM) shows the last change, a truncation notice, or a dash — never the same text for all three', async () => {
    routeApi({ board: () => ok(boardPayload({ lastChangedFromPlmAt: null, lastChangedFromPlmBounded: false })) })
    const noneYet = await mountBoard()
    const dash = (noneYet.querySelector('[data-testid="stock-prep-project-board-last-changed-from-plm"]') as HTMLElement).textContent
    expect(dash).toContain('—')
    remount()

    routeApi({ board: () => ok(boardPayload({ lastChangedFromPlmAt: null, lastChangedFromPlmBounded: true })) })
    const truncated = await mountBoard()
    const truncatedText = (truncated.querySelector('[data-testid="stock-prep-project-board-last-changed-from-plm"]') as HTMLElement).textContent ?? ''
    expect(truncatedText).toContain('未统计')
    expect(truncatedText).not.toContain('—')
    remount()

    routeApi({ board: () => ok(boardPayload({ lastChangedFromPlmAt: '2026-09-04T08:00:00.000Z', lastChangedFromPlmBounded: false })) })
    const synced = await mountBoard()
    const syncedText = (synced.querySelector('[data-testid="stock-prep-project-board-last-changed-from-plm"]') as HTMLElement).textContent ?? ''
    expect(syncedText).not.toContain('—')
    expect(syncedText).not.toContain('未统计')
    expect(syncedText.trim().length).toBeGreaterThan(0)
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

  // ---- F: 「打开关联的备料多维表」 FROM THE LANDING PAGE ----------------------------------------
  //
  // THE GAP THIS CLOSES. B-11 above proves the handle works on 项目备料页 — a page that 404s until a
  // project number has been typed. An operator arriving at /stock-prep sees 今天要处理 first, and
  // until now nothing on it could reach the sheet they fill: the only 到多维表 buttons in reach
  // opened the multitable CHOOSER. The directory read this page already makes now carries the same
  // tenant-gated handle, so the entry lands where its label says.

  it('F-01: 今天要处理 offers 打开备料多维表 and the shell deep-links it to the bound sheet', async () => {
    routeApi({})
    const root = mount(StockPreparationWorkspace)
    await flush()
    // No project is open, so this really is the home face — the board read has not even happened.
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
    const entry = root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]') as HTMLButtonElement
    expect(entry, 'the handle came back, so the entry must be on screen').not.toBeNull()
    expect(entry.textContent).toContain('打开备料多维表')
    entry.click()
    await flush()
    expect(routerPush).toHaveBeenCalledWith({ path: `/multitable/${SHEET_ID}/${VIEW_ID}` })
  })

  it('F-02: no handle in the directory -> no entry at all, and nothing routes', async () => {
    // `null` is the server saying 「这台系统上没有能证明属于您的备料主表」 — an entry that opened the
    // chooser under a label promising the 备料主表 is the promise this pass exists to stop making.
    routeApi({ directory: { fillTarget: null } })
    const root = mount(StockPreparationWorkspace)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]')).toBeNull()
    expect(routerPush).not.toHaveBeenCalledWith({ path: `/multitable/${SHEET_ID}/${VIEW_ID}` })
  })

  it('F-03: an ABSENT key (older backend / no opt-in) is the same silence as null', async () => {
    routeApi({ directory: { fillTarget: undefined } })
    const root = mount(StockPreparationWorkspace)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-operator-home-open-multitable"]')).toBeNull()
  })
  // ---- P0-2: 二级视图寄生 —— `?projectNo=` 无值渲染首页,有值走既有工作区分支 --------------------
  //
  // 设计稿 §2.3's whole point: EVERY test above this block mounts with a `projectNo`, so it always
  // took the "existing workspace" branch and never once exercised the home page — which is exactly
  // what makes the P0 mechanism safe. This block is what actually mounts with none.

  it('P0-2: no projectNo renders the home page, not the workspace status section', async () => {
    const root = await mountBoard({ projectNo: '' })
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step"]')).toBeNull()
    // ONE project-number input on the screen, and it is the existing one: the home page contributes
    // the 「拉一个新项目」 heading and the honest sentence, never a second box with the same label.
    expect(root.querySelectorAll('[data-testid="stock-prep-project-board-input"]').length).toBe(1)
    expect(root.querySelectorAll('input[list="stock-prep-board-directory-options"]').length).toBe(1)
  })

  it('P0-2: every OTHER spec in this file seeds a projectNo and therefore never sees the home page', async () => {
    const root = await mountBoard()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()
  })

  it('P0-2: a seeded projectNo never paints the home page, not even for one frame', async () => {
    // THE REGRESSION. `showHome` used to be derived from a ref assigned inside `loadBoard`, which
    // `onMounted` only reached after awaiting a full directory round-trip — so a deep link, and
    // every switch back to this tab (the shell mounts it with `v-if`), painted a whole screen of
    // task home including 「这里还没有您的项目」 before the workspace replaced it. Asserted BEFORE
    // any flush, which is the only place the flash was ever visible.
    const root = mount(StockPreparationProjectBoardView, { scope: SCOPE, projectNo: PROJECT_NO })
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).toBeNull()
    await nextTick()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).toBeNull()
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).toBeNull()
  })

  it('P0-2: the home page carries this operator\'s own directory as a card', async () => {
    const root = await mountBoard({ projectNo: '' })
    const card = root.querySelector('[data-testid="stock-prep-operator-home-card"]') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.getAttribute('data-project-no')).toBe(PROJECT_NO)
  })

  it('P0-2: opening a project from the fallback input switches to the workspace', async () => {
    const root = await mountBoard({ projectNo: '' })
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
    const input = root.querySelector('[data-testid="stock-prep-project-board-input"]') as HTMLInputElement
    input.value = PROJECT_NO
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-board-open"]') as HTMLButtonElement).click()
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).not.toBeNull()
  })

  // ---- 线框 C ①: the way BACK. Without it `?projectNo=` is a one-way door. ----------------------

  it('P0-2: 「返回今天要处理」 takes the operator back to the home page', async () => {
    const root = await mountBoard()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).toBeNull()
    const back = root.querySelector('[data-testid="stock-prep-project-board-back-home"]') as HTMLButtonElement
    expect(back, 'the workspace must offer a way home').not.toBeNull()
    back.click()
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]')).toBeNull()
  })

  it('P0-2: through the shell, going back DROPS ?projectNo= instead of writing an empty one', async () => {
    const root = mount(StockPreparationWorkspace)
    await flush()
    await openProjectInShell(root)
    routerReplace.mockClear()
    ;(root.querySelector('[data-testid="stock-prep-project-board-back-home"]') as HTMLButtonElement).click()
    await flush()
    expect(routerReplace).toHaveBeenCalled()
    const query = (routerReplace.mock.calls[0][0] as { query: Record<string, string> }).query
    expect('projectNo' in query).toBe(false)
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
  })

  // ---- P0-3: 「下一步」条 ------------------------------------------------------------------------

  it('P0-3: shows the 全清 state for a fully-synced, fully-exported fixture — no primary button', async () => {
    const root = await mountBoard()
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.getAttribute('data-next-step')).toBe('clear')
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]')).toBeNull()
  })

  // P1-2 CHANGED WHERE THIS BUTTON GOES, not what it says. §5 流程 1's P1 column is 「主按钮就地展开
  // 面板 2」: the same queue, for the same project, is now composed on THIS page, so the press opens
  // it in place instead of asking the shell for another tab. The count and the sentence are the P0
  // assertions, unchanged.
  it('P0-3/P1-2: names the real count when decisions are pending, and the press opens 面板 2 IN PLACE — no tab switch', async () => {
    routeApi({ board: ok(boardPayload({ pendingDecisionCount: 3 })) })
    const navigateStageSpy = vi.fn()
    const root = await mountBoard({ onNavigateStage: navigateStageSpy })
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar.getAttribute('data-next-step')).toBe('pending')
    const action = root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]') as HTMLButtonElement
    expect(action).not.toBeNull()
    expect(action.textContent).toContain('3')
    expect(
      root.querySelector('[data-testid="stock-prep-confirmation-queue"]'),
      'nothing composed before the press — 面板 2 is collapsed by default',
    ).toBeNull()
    action.click()
    await flush()
    expect(
      root.querySelector('[data-testid="stock-prep-confirmation-queue"]'),
      'one press, and the rows are on this same screen',
    ).not.toBeNull()
    expect(navigateStageSpy, '…and the shell was never asked to move (3 击 0 跳转)').not.toHaveBeenCalled()
  })

  it('P0-3: G5 — a project that has never been pulled still shows a "下一步" bar (never a locked gate)', async () => {
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.getAttribute('data-next-step')).toBe('pull')
  })

  it('P0-3: the 拉取 button RUNS the sync — it is not a decoration that scrolls to another button', async () => {
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const syncApi = syncApiDouble()
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT', syncApi })
    ;(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]') as HTMLButtonElement).click()
    await flush()
    expect(syncApi.dryRun).toHaveBeenCalled()
  })

  it('P0-3: a caller who may not run the sync gets the SENTENCE and no button (R-11)', async () => {
    h.permissions = ['stock-prep:read']
    routeApi({ board: notFound('STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') })
    const root = await mountBoard({ projectNo: 'NO-SUCH-PROJECT' })
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar.getAttribute('data-next-step')).toBe('pull')
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]')).toBeNull()
  })

  // ---- P0-6: the workspace title's own posture badge ---------------------------------------------

  it('P0-6: the workspace title carries a posture badge', async () => {
    const root = await mountBoard()
    expect(root.querySelector('[data-testid="stock-prep-project-board-posture"]')).not.toBeNull()
  })

  // ---- P0-9: 缺件卡 (I-4) — top consequence + bottom closure, both already/newly present ---------

  it('P0-9 / I-4: 缺件卡 carries the top consequence sentence AND the bottom closure line, with the count tooltip', async () => {
    const syncApi = syncApiDouble({
      dryRun: vi.fn().mockResolvedValue({
        canApply: true,
        dryRunToken: 'tok_missing',
        counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
        evidence: {},
        projectName: PROJECT_NAME,
        missingComponents: {
          distinctCount: 2,
          probeCount: 3,
          truncated: false,
          items: [
            { componentSourceId: 'C-1', parentSourceId: 'P-1', bomId: 'BOM-1', depth: 1, occurrenceCount: 2, parentCount: 1, path: 'Root' },
            { componentSourceId: 'C-2', parentSourceId: 'P-2', bomId: 'BOM-1', depth: 2, occurrenceCount: 1, parentCount: 1, path: 'Root/P-2' },
          ],
        },
      }),
    })
    const root = await mountBoard({ syncApi })
    await runPullPanel(root)

    const box = root.querySelector('[data-testid="stock-prep-project-sync-missing-components"]') as HTMLElement
    expect(box).not.toBeNull()
    // I-4's top sentence: the CONSEQUENCE, before the list (design's own exact wording, unchanged by
    // this pass — this pins it stays there rather than re-derives it).
    expect(box.textContent).toContain('整个项目在补齐前一行都写不进去')
    // I-4's NEW bottom closure line (线框 D ③): no "mark done" button exists, and the card says so.
    expect(box.textContent).toContain('回到上面点「同步一次」')
    expect(box.textContent).toContain('不用在这里标记完成')
    // I-20: the summary's own tooltip — what the COUNT means.
    const summary = box.querySelector('summary') as HTMLElement
    expect(summary.title).toContain('去重后的数量')
  })

  // ---- P0-9: I-20 tooltips reachable from this page (the other two are on the composed queue) ----

  it('I-20: 表里有多少行 carries a values-free tooltip explaining what the row count does NOT mean', async () => {
    const root = await mountBoard()
    const dt = root.querySelector('[data-testid="stock-prep-project-board-rows"] dt') as HTMLElement
    expect(dt.title).toContain('不是 BOM 总行数')
  })

  it('I-20: the home page\'s 可以导出 filter carries a tooltip (the board composes the home page when no project is open)', async () => {
    const root = await mountBoard({ projectNo: '' })
    await flush()
    const chip = root.querySelector('[data-testid="stock-prep-operator-home-filter-ready"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.title).toContain('已经写进多维表')
  })

  // ---- U2 契约: WHO pays for the union scan --------------------------------------------------
  //
  // This one component file is both faces of §2.3 — 今天要处理 when `?projectNo=` is empty and 项目备料页
  // when it is not — and the U2 opt-in
  // (`?includePullTargets=1`) is NOT free: the backend module states in its own
  // header that the scan reads the whole binding sheet, pages by LIMIT/OFFSET, and that 「项目备料页
  // does not opt in — it runs its own NARROWED scan and must not also pay an unnarrowed one … so this
  // whole feature costs that route exactly zero queries」. These three cases are that ruling, expressed
  // as request URLs, because it is invisible in the DOM and a single `if` is all that separates
  // "charged once, on the home page" from "charged on every project an operator opens".

  function directoryRequestUrls(): string[] {
    return h.apiFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/operator/projects'))
  }

  it('U2: a WORKSPACE mount (a project is open) asks for the plain directory — no union scan is charged to it', async () => {
    await mountBoard({ projectNo: PROJECT_NO })
    const urls = directoryRequestUrls()
    expect(urls.length, 'the board still fills its datalist from one directory read').toBe(1)
    expect(urls[0]).not.toContain('includePullTargets')
    expect(urls[0]).not.toContain('includePendingCounts')
  })

  it('U2: a HOME mount (no project open) is the one read that opts in', async () => {
    await mountBoard({ projectNo: '' })
    const urls = directoryRequestUrls()
    expect(urls.length).toBe(1)
    expect(urls[0]).toContain('includePullTargets=1')
    expect(urls[0]).not.toContain('includePendingCounts')
  })

  it('U2: 返回今天要处理 re-reads WITH the opt-in — the home page never renders off the workspace\'s plain directory', async () => {
    const root = await mountBoard({ projectNo: PROJECT_NO })
    expect(directoryRequestUrls().length).toBe(1)

    ;(root.querySelector('[data-testid="stock-prep-project-board-back-home"]') as HTMLButtonElement).click()
    await flush()

    // The component does not remount when it comes home (the shell drops `?projectNo=` under a live
    // instance), so without an explicit re-read the home page would render off the un-opted-in payload
    // for the rest of the session: every U2 field absent, the three sentences therefore permanently
    // silent, and pull-target-only projects permanently missing from the cards.
    const urls = directoryRequestUrls()
    expect(urls.length, 'coming home issues exactly one more directory read').toBe(2)
    expect(urls[1]).toContain('includePullTargets=1')
    expect(urls[1]).not.toContain('includePendingCounts')
    expect(root.querySelector('[data-testid="stock-prep-operator-home"]')).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // P1-2 (§6.2 P1-2, 线框 C/D) — Panel 2: 就地展开 embedded 队列 + 进度条.
  //
  // WHAT THESE WITNESS. The panel composes #5445's confirmation queue IN PLACE via its own `embedded`
  // prop (StockPreparationConfirmationQueueView.vue) — nothing here re-implements the queue, and
  // stockPreparationConfirmationQueue.spec.ts's own P1-2 block already covers that prop's contract in
  // isolation (what it hides, and why each hide is a lie or a drift it prevents). What can ONLY be
  // witnessed from this side is: WHEN the panel appears at all, that it starts collapsed and still
  // says what it is, that expanding it never asks the shell to switch tabs, that the progress bar
  // reads the SAME response the composed queue fetched, that confirming the last row IN PLACE brings
  // the whole screen with it (§4.2 rule 4, on a path that never leaves the page), and that 「回到上面
  // 再同步一次」 goes up AND runs the sync rather than pointing at a button and hoping.
  // ---------------------------------------------------------------------------

  function decisionsListPayload(byStatus: Record<string, number>): Record<string, unknown> {
    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0)
    return { rowCount: total, byStatus, byResolutionAction: {}, parkedCount: 0, rows: [] }
  }

  /** Bare LIST route only. NOT `path.includes('/confirm')` — `'/confirmation-decisions'` itself
   *  contains that substring ("confirmation" starts with "confirm"), which would match the list call
   *  too; anchoring on the `/` before the differing suffix is what keeps it out. */
  function isDecisionsListUrl(path: string): boolean {
    return /\/confirmation-decisions(\?|$)/.test(path)
  }

  interface ConfirmPanelState {
    /** What the BOARD read answers — the number the title, the status card and 「下一步」 all read. */
    boardPending: number
    /** What the composed QUEUE's own LIST answers — the number the progress bar reads. */
    byStatus: Record<string, number>
    /** Directory switches, for the empty states 面板 2 can legitimately reach. */
    ledgerReady?: boolean
    directoryPending?: number
  }

  /** Mutable BY DESIGN: the whole point of the closed-loop test below is that these two numbers
   *  disagree for a moment — the operator has just confirmed the last row — and the page must notice. */
  function routeApiWithConfirmPanel(state: ConfirmPanelState): void {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/operator/projects')) {
        const directory = directoryPayload() as Record<string, unknown>
        if (state.ledgerReady === false) directory.ledgerReady = false
        if (typeof state.directoryPending === 'number') {
          const projects = directory.projects as Record<string, unknown>[]
          projects[0].pendingDecisionCount = state.directoryPending
          directory.pendingProjectCount = state.directoryPending > 0 ? 1 : 0
        }
        return ok(directory)
      }
      if (isDecisionsListUrl(path)) return ok(decisionsListPayload(state.byStatus))
      if (path.includes('/handoff')) return new Response('', { status: 404 })
      if (path.includes('/board')) return ok(boardPayload({ pendingDecisionCount: state.boardPending }))
      return ok({})
    })
  }

  function toggleConfirmPanel(root: HTMLElement): void {
    ;(root.querySelector('[data-testid="stock-prep-project-board-confirm-toggle"]') as HTMLButtonElement).click()
  }

  it('P1-2 (§2.4 P-2c): 面板 2 appears when something is waiting, and is absent when nothing is', async () => {
    routeApi({ board: ok(boardPayload({ pendingDecisionCount: 0 })) })
    const clear = await mountBoard()
    expect(
      clear.querySelector('[data-testid="stock-prep-project-board-confirm-panel"]'),
      'the entry condition is pendingDecisionCount > 0 — a project with nothing waiting gets no empty box',
    ).toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    routeApi({ board: ok(boardPayload({ pendingDecisionCount: 2 })) })
    const waiting = await mountBoard()
    expect(waiting.querySelector('[data-testid="stock-prep-project-board-confirm-panel"]')).not.toBeNull()
  })

  it('P1-2: Panel 2 starts COLLAPSED but not silent — 线框 C standing sentence included, and no request is gained', async () => {
    routeApi({ board: ok(boardPayload({ pendingDecisionCount: 2 })) })
    const root = await mountBoard()
    const panel = root.querySelector('[data-testid="stock-prep-project-board-confirm-panel"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('(2)')
    // I-3: the collapsed panel explains itself AND names the step the design says is missed most often.
    const note = root.querySelector('[data-testid="stock-prep-project-board-confirm-note"]') as HTMLElement
    expect(note, '线框 C draws this sentence in BOTH states').not.toBeNull()
    expect(note.textContent).toContain('同步一次')
    expect(
      root.querySelector('[data-testid="stock-prep-confirmation-queue"]'),
      'nothing composed until the operator asks',
    ).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-confirm-toggle"]')?.textContent).toContain('展开')
    // No request went to the confirmation-decisions LIST route — only board/handoff/directory, exactly
    // like every OTHER fixture in this file that never touches this toggle.
    const listCalls = h.apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => isDecisionsListUrl(url))
    expect(listCalls).toEqual([])
  })

  it('P1-2: expanding composes the queue IN PLACE (embedded — its own input/title stay hidden), never a tab switch', async () => {
    routeApiWithConfirmPanel({ boardPending: 2, byStatus: { confirmed: 1, pending: 1 } })
    const navigateStageSpy = vi.fn()
    const root = await mountBoard({ onNavigateStage: navigateStageSpy })

    toggleConfirmPanel(root)
    await flush()

    const embedded = root.querySelector('[data-testid="stock-prep-confirmation-queue"]')
    expect(embedded, 'expanding mounts the composed queue in place, on THIS SAME screen').not.toBeNull()
    expect(embedded!.querySelector('[data-testid="stock-prep-confirmation-project-input"]'), 'embedded hides its own project-no input').toBeNull()
    expect(embedded!.querySelector('[data-testid="stock-prep-confirmation-scope"]'), 'embedded hides its own scope/title paragraph').toBeNull()
    expect(navigateStageSpy, 'expanding never asks the shell to switch tabs').not.toHaveBeenCalled()
    // The board's own tab (data-active on the shell) is out of scope for a standalone board mount —
    // the absence of any `navigate-stage` call above is the direct proof no tab switch was requested.
    expect(root.querySelector('[data-testid="stock-prep-project-board-status"]'), 'and the workspace status card is still on screen underneath').not.toBeNull()
  })

  it('P1-2 (线框 D ①): 进度条 reads the SAME response the composed queue fetched, and lives INSIDE the expanded panel', async () => {
    routeApiWithConfirmPanel({ boardPending: 1, byStatus: { confirmed: 1, pending: 1 } })
    const root = await mountBoard()

    toggleConfirmPanel(root)
    await flush()

    const progress = root.querySelector('[data-testid="stock-prep-project-board-confirm-progress"]') as HTMLElement
    expect(progress, 'Panel 2 itself asks once on mount — the operator did not have to press 刷新列表').not.toBeNull()
    expect(progress.textContent).toContain('已处理 1 / 共 2')
    const fill = progress.querySelector('.sp-board__confirm-progress-fill') as HTMLElement
    expect(fill.style.width).toBe('50%')
    // §4.4 keeps 🟢 for 可以导出 / 已就绪 — a half-done bar must not wear it.
    expect(fill.className).not.toContain('sp-board__confirm-progress-fill--done')

    // Collapse again: the bar goes with the rows it describes. Left outside the expanded region it
    // kept showing the last ratio it saw — including, after a project switch, the PREVIOUS project's.
    toggleConfirmPanel(root)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-project-board-confirm-progress"]')).toBeNull()
  })

  it('P1-2 (§4.2 rule 4): confirming the last row IN PLACE re-reads the board — one screen, one number, and 再同步一次 finally fires', async () => {
    const state: ConfirmPanelState = { boardPending: 2, byStatus: { confirmed: 0, pending: 2 } }
    routeApiWithConfirmPanel(state)
    const root = await mountBoard()

    toggleConfirmPanel(root)
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-project-board-confirm-panel"]')?.textContent).toContain('(2)')

    // The operator confirms both rows inside the panel. What the SERVER holds afterwards:
    state.byStatus = { confirmed: 2, pending: 0 }
    state.boardPending = 0
    // …and the panel re-reads its own list — the same `loadQueue` a successful confirm runs.
    ;(root.querySelector('[data-testid="stock-prep-confirmation-queue-refresh"]') as HTMLButtonElement).click()
    await flush()

    // ALL FOUR PLACES AGREE. Before this, the three that read `board.pendingDecisionCount` kept saying
    // 2 while the progress bar directly under them said 「已处理 2 / 共 2」.
    const panel = root.querySelector('[data-testid="stock-prep-project-board-confirm-panel"]') as HTMLElement
    expect(panel, 'still on screen: it was expanded, so it does not vanish under the operator').not.toBeNull()
    expect(panel.textContent, 'the panel own (N) is gone').not.toContain('(2)')
    expect(
      root.querySelector('[data-testid="stock-prep-project-board-pending"]'),
      'and so is the status card sentence about things waiting',
    ).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-board-confirm-progress"]')?.textContent).toContain('已处理 2 / 共 2')
    // §4.2 rule 4 — 「都确认完了。再同步一次,数据才会写进多维表。」 The design calls this the step lost
    // most often, and on the in-place path it could never fire at all before this.
    const bar = root.querySelector('[data-testid="stock-prep-project-board-next-step"]') as HTMLElement
    expect(bar.getAttribute('data-next-step')).toBe('resync')
    expect(root.querySelector('[data-testid="stock-prep-project-board-next-step-action"]')?.textContent).toContain('再同步一次')
  })

  it('P1-2 (线框 D ④): 回到上面再同步一次 scrolls up AND runs the sync — it never navigates away', async () => {
    const state: ConfirmPanelState = { boardPending: 2, byStatus: { confirmed: 2, pending: 0 } }
    routeApiWithConfirmPanel(state)
    const navigateStageSpy = vi.fn()
    const syncApi = syncApiDouble()
    const root = await mountBoard({ onNavigateStage: navigateStageSpy, syncApi })

    state.boardPending = 0
    toggleConfirmPanel(root)
    await flush()

    const syncSection = root.querySelector('[data-testid="stock-prep-project-sync"]') as HTMLElement
    const scrollSpy = vi.fn()
    // jsdom implements no scrollIntoView at all — stub it on the element the handler actually targets.
    syncSection.scrollIntoView = scrollSpy
    const runButton = root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement
    const focusSpy = vi.spyOn(runButton, 'focus')

    const resync = root.querySelector('[data-testid="stock-prep-confirmation-empty-resync"]') as HTMLButtonElement
    expect(resync, 'nothing_pending (2 confirmed, 0 pending) renders the closed-loop button').not.toBeNull()
    expect(resync.textContent, 'the wireframe label, which promises the journey as well as the sync').toContain('回到上面再同步一次')
    resync.click()
    await flush()

    expect(scrollSpy, 'scrolled to the SAME sync panel 「下一步」 already reaches for').toHaveBeenCalled()
    expect(focusSpy, 'and focused its run button').toHaveBeenCalled()
    // THE LABEL IS NOT A DECORATION. A button that said 再同步一次 and only scrolled would put two
    // near-identically worded buttons on one screen with the upper one doing the work.
    expect(syncApi.dryRun, 'and the sync it names actually ran').toHaveBeenCalled()
    expect(navigateStageSpy, 'never asked the shell to switch tabs — the panel already IS 上面').not.toHaveBeenCalled()
  })

  it('P1-2 (R-11): 面板 2 carries no control whose click goes nowhere, and no second way to change project', async () => {
    // The account that would see the most: platform-admin capabilities on top of the operator tier.
    h.permissions = ['stock-prep:read', 'stock-prep:operate', 'integration:admin']
    routeApiWithConfirmPanel({ boardPending: 2, byStatus: { confirmed: 0, pending: 2 }, directoryPending: 4 })
    const root = await mountBoard()
    toggleConfirmPanel(root)
    await flush()

    const panel = root.querySelector('[data-testid="stock-prep-project-board-confirm-panel"]') as HTMLElement
    // The two `admin-action` emitters: this host is not the shell, so nothing would answer them here.
    expect(panel.querySelector('[data-testid="stock-prep-confirmation-ensure"]')).toBeNull()
    expect(panel.querySelector('[data-testid="stock-prep-confirmation-reconcile"]')).toBeNull()
    expect(panel.querySelector('[data-testid="stock-prep-confirmation-reconcile-note"]')).toBeNull()
    // The cross-project worklist: one click would point 面板 2 at another project while the title, the
    // status card, 导出 and 通知下一步 above it all stayed on this one.
    expect(panel.querySelector('[data-testid="stock-prep-operator-project-worklist"]')).toBeNull()
    expect(panel.querySelector('[data-testid="stock-prep-operator-project-pick"]')).toBeNull()
    // G4: the status filter would let a filtered `byStatus` redraw the progress bar above it.
    expect(panel.querySelector('[data-testid="stock-prep-confirmation-status-filter"]')).toBeNull()
    // G1: exactly ONE 导出 on the screen, the host's own.
    expect(root.querySelectorAll('[data-testid="stock-prep-confirmation-export"]').length).toBe(0)
    expect(root.querySelectorAll('[data-testid="stock-prep-project-board-export"]').length).toBe(1)
  })

  it('P1-2: 去装:开始使用 inside 面板 2 still reaches 开始使用 — the host forwards navigate-stage', async () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']
    routeApiWithConfirmPanel({ boardPending: 2, byStatus: {}, ledgerReady: false })
    const navigateStageSpy = vi.fn()
    const root = await mountBoard({ onNavigateStage: navigateStageSpy })
    toggleConfirmPanel(root)
    await flush()

    const empty = root.querySelector('[data-testid="stock-prep-confirmation-empty"]') as HTMLElement
    expect(empty?.getAttribute('data-empty-state')).toBe('ledger_missing')
    const goInstall = root.querySelector('[data-testid="stock-prep-confirmation-empty-go-install"]') as HTMLButtonElement
    expect(goInstall, 'the P0-7 dead-end fix is still on screen in the composed view').not.toBeNull()
    goInstall.click()
    await flush()
    // NOT a dead button: unlike the two admin-action emitters (absent above), this one rides the
    // `navigate-stage` this host already emits to the shell, and it is re-emitted verbatim.
    // P1-1 renamed the destination — 开始使用 is a rail item of its own now and the install page
    // no longer renders the wizard — so the stage name that reaches the shell moved with it. The
    // forwarding this case exists to pin (host re-emits the child's event unchanged) is unaffected.
    expect(navigateStageSpy).toHaveBeenCalledWith('getting-started')
  })
})
