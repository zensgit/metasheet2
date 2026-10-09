import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 一个项目一张备料表 — S2 (ADR adr-stock-prep-project-sheets-20261008 §4 / §5 / §7; register R-36).
//
//   PT-CLIENT  the three S1 routes: paths, verbs, an EMPTY create body with no query, strict clamps,
//              and the switch-off 404 recognised as "disabled" (never as a failure).
//   PT-FLOW    runStockPreparationProjectPull, decision by decision — and THE ORDER RULE (Q4): the
//              sheet is CREATED before the preview (dry run) on the absent path; declining anywhere
//              writes nothing and never undoes a create (no 「撤销新建」).
//   PT-HOOK    runStockPreparationProjectSync's optional confirmWrite: declined → no apply,
//              WRITE_NOT_CONFIRMED, verdict not_written; absent hook → the run is unchanged.
//   PT-CODES   every project-sheet refusal code has its own two-line sentence; the dry-run classifier
//              sorts them BY CODE; the copy never says 「覆盖」 or 「撤销新建」.
//   PT-PANEL   the pull panel's DOM: create prompt → create → preview prompt → write; the re-pull
//              prompt carries the bounded row count; archived / refused / declined each say who acts
//              next; with the switch off the panel runs exactly as before (no prompt, no create).
//   PT-BOARD   项目备料页's sheet-state line (absent / active / archived), 「直接打开」 with the
//              project's OWN handle, 「请联系拉取人员」 for a caller without the pull right.
//   PT-HOME    今天要处理: the 「每个项目一张备料表」 line and per-card row counts from the registry;
//              Q8 「平台登记」 wording with the switch off.
//   PT-QUERY   项目查询: the `mvp` source reads 「平台登记」, never 「归档过」 (Q8).
//   PT-ALIGN   the three new manifest controls render for EXACTLY the actors the manifest grants, on
//              the surfaces they live on (the web matrix suite defers to this block).
//
// Synthetic, obviously-fake project numbers only.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] as string[],
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

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), email: '', roles: h.roles, permissions: h.permissions }),
    hasAdminAccess: () => h.roles.includes('admin'),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import StockPreparationProjectBoardView from '../src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue'
import StockPreparationOperatorHome from '../src/components/integration/stockPreparation/StockPreparationOperatorHome.vue'
import {
  STOCK_PREP_PROJECT_TARGET_ERROR_CODES,
  StockPreparationProjectTargetCallError,
  clampStockPrepProjectTargetState,
  createStockPreparationProjectTargetApi,
  isStockPrepProjectSheetsDisabled,
  runStockPreparationProjectPull,
  type StockPrepProjectTargetConfirmRequest,
  type StockPrepProjectTargetList,
  type StockPrepProjectTargetState,
  type StockPreparationProjectTargetApi,
} from '../src/services/integration/stockPreparation/projectTarget'
import {
  classifyPlanReadFailureReason,
  runStockPreparationProjectSync,
  StockPreparationProjectSyncCallError,
  STOCK_PREP_PROJECT_SHEET_PLAN_REFUSAL_REASONS,
  type StockPreparationProjectSyncApi,
  type StockPreparationProjectSyncReport,
} from '../src/services/integration/stockPreparation/projectSync'
import {
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_PROJECT_TARGET_PLAIN,
  STOCK_PREP_SOURCE_MVP_LABEL,
  STOCK_PREP_SYNC_REASON_PLAIN,
  STOCK_PREP_SYNC_VERDICT_PLAIN,
  stockPrepProjectTargetRowCountText,
} from '../src/services/integration/stockPreparation/plainLanguage'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const PROJECT = 'PRJ-SYN-S2-01'
const SHEET = 'sheet_syn_project_s2'
const FILL_VIEW = 'view_syn_fill_s2'
const TODO_VIEW = 'view_syn_todo_s2'

const PULLER = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']
const FLOOR = ['stock-prep:read', 'stock-prep:operate']

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'synthetic refusal' } }), { status })
}

function targetState(overrides: Partial<StockPrepProjectTargetState> = {}): StockPrepProjectTargetState {
  return {
    status: 'active',
    sheetId: SHEET,
    viewId: FILL_VIEW,
    todoViewId: TODO_VIEW,
    rowCount: 12,
    activeRowCount: 10,
    rowCountBounded: false,
    lastPulledAt: null,
    lastPullOutcome: null,
    archivedAt: null,
    may: { create: false, archive: true, restore: false },
    ...overrides,
  }
}

const ABSENT = (mayCreate = true): StockPrepProjectTargetState => targetState({
  status: 'absent', sheetId: null, viewId: null, todoViewId: null, rowCount: null, activeRowCount: null, rowCountBounded: null,
  may: { create: mayCreate, archive: false, restore: false },
})

function disabledError(): StockPreparationProjectTargetCallError {
  return new StockPreparationProjectTargetCallError(404, 'GET …/target', { code: 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED' })
}

/** A target client double that logs into `log`. `get` answers the queued states in order. */
function targetDouble(log: string[], states: Array<StockPrepProjectTargetState | Error>, options: { create?: () => Promise<unknown> } = {}): StockPreparationProjectTargetApi {
  let reads = 0
  return {
    get: vi.fn(async () => {
      log.push('target.get')
      const answer = states[Math.min(reads, states.length - 1)]
      reads += 1
      if (answer instanceof Error) throw answer
      return answer
    }),
    create: vi.fn(async () => {
      log.push('target.create')
      if (options.create) return options.create() as never
      return { status: 'active', created: true, sheetId: SHEET, viewId: FILL_VIEW, todoViewId: TODO_VIEW }
    }),
    list: vi.fn(async () => {
      log.push('target.list')
      return { count: 0, limit: 200, items: [] }
    }),
  } as StockPreparationProjectTargetApi
}

function syncDouble(log: string[], overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn(async () => {
      log.push('dryRun')
      return { status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 5, update: 1, skip: 3, inactive: 0, manual_confirm: 0 } }
    }),
    reconcile: vi.fn(async () => { log.push('reconcile'); return { counts: { pending: 0 } } }),
    apply: vi.fn(async () => {
      log.push('apply')
      return { status: 'succeeded', apply: { counts: { created: 5, updated: 1, inactive: 0, skipped: 3, held: 0, failed: 0 } } }
    }),
    archive: vi.fn(async () => { log.push('archive'); return { status: 'created', persisted: true, created: { batch: 1, lines: 6, run: 1 } } }),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

let app: VueApp | null = null
let container: HTMLDivElement | null = null

function mount(component: Component, props: Record<string, unknown>): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(component, props)
  app.mount(container)
  return container
}

function unmountAll(): void {
  if (app) app.unmount()
  if (container) container.remove()
  app = null
  container = null
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
}

async function typeAndRun(root: HTMLElement, projectNo = PROJECT): Promise<void> {
  const input = testid(root, 'stock-prep-project-sync-project-no') as HTMLInputElement
  input.value = projectNo
  input.dispatchEvent(new Event('input'))
  await nextTick()
  ;(testid(root, 'stock-prep-project-sync-run') as HTMLButtonElement).click()
  await flush()
}

async function press(root: HTMLElement, id: string): Promise<void> {
  const button = testid(root, id) as HTMLButtonElement | null
  expect(button, `${id} must render`).not.toBeNull()
  button!.click()
  await flush()
}

beforeEach(() => {
  h.locale = 'zh-CN'
  h.permissions = [...PULLER]
  h.roles = []
  h.apiFetch.mockReset()
  resetStockPreparationOperatorHomeDirectoryThrottle()
})

afterEach(() => {
  unmountAll()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// PT-CLIENT
// ---------------------------------------------------------------------------

describe('PT-CLIENT — the three project-sheet routes', () => {
  it('get / create / list: paths, verbs, an EMPTY create body and no query on the write', async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/project-targets')) return ok({ count: 1, limit: 200, items: [{ projectNo: PROJECT, status: 'active', sheetId: SHEET, rowCount: 3, activeRowCount: 3, countsBounded: false }] })
      if (init?.method === 'POST') return ok({ projectNo: PROJECT, status: 'active', created: true, sheetId: SHEET, objectId: 'x', viewId: FILL_VIEW, todoViewId: TODO_VIEW }, 201)
      return ok({ projectNo: PROJECT, ...targetState() })
    })
    const api = createStockPreparationProjectTargetApi(SCOPE)
    const state = await api.get(PROJECT)
    expect(state.status).toBe('active')
    expect(state.rowCount).toBe(12)
    const created = await api.create(PROJECT)
    expect(created.created).toBe(true)
    const list = await api.list()
    expect(list.items.map((item) => item.projectNo)).toEqual([PROJECT])
    const calls = h.apiFetch.mock.calls.map(([path, init]) => [String(path), (init as RequestInit | undefined)?.method ?? 'GET', (init as RequestInit | undefined)?.body ?? null])
    expect(calls[0]).toEqual([`/api/integration/stock-preparation/projects/${PROJECT}/target?tenantId=tenant-syn&workspaceId=workspace-syn`, 'GET', null])
    expect(calls[1]).toEqual([`/api/integration/stock-preparation/projects/${PROJECT}/target`, 'POST', '{}'])
    expect(calls[2]).toEqual(['/api/integration/stock-preparation/project-targets?tenantId=tenant-syn&workspaceId=workspace-syn', 'GET', null])
  })

  it('the switch-off 404 is recognised as DISABLED; a 2xx that is not a state is malformed, never a state', async () => {
    h.apiFetch.mockImplementation(async () => refused(404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED'))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    const error = await api.get(PROJECT).catch((caught) => caught)
    expect(isStockPrepProjectSheetsDisabled(error)).toBe(true)
    h.apiFetch.mockImplementation(async () => ok({}))
    const malformed = await api.get(PROJECT).catch((caught) => caught)
    expect(malformed).toBeInstanceOf(StockPreparationProjectTargetCallError)
    expect((malformed as StockPreparationProjectTargetCallError).malformed).toBe(true)
    expect(isStockPrepProjectSheetsDisabled(malformed)).toBe(false)
    expect(clampStockPrepProjectTargetState({ status: 'deleted', may: { create: true, archive: true, restore: true } })).toBeNull()
    expect(clampStockPrepProjectTargetState({ status: 'active', may: { create: 'yes', archive: true, restore: true } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PT-FLOW
// ---------------------------------------------------------------------------

describe('PT-FLOW — runStockPreparationProjectPull', () => {
  function deps(log: string[], states: Array<StockPrepProjectTargetState | Error>, answers: Record<string, boolean> = {}, canPull = true, createImpl?: () => Promise<unknown>) {
    const asked: StockPrepProjectTargetConfirmRequest[] = []
    const sync = syncDouble(log)
    return {
      asked,
      sync,
      deps: {
        targetApi: targetDouble(log, states, { create: createImpl }),
        canPull,
        confirm: async (request: StockPrepProjectTargetConfirmRequest) => {
          asked.push(request)
          log.push(`confirm:${request.kind}`)
          return answers[request.kind] !== false
        },
        runSync: (hooks: Parameters<typeof runStockPreparationProjectSync>[3]) => runStockPreparationProjectSync(sync, PROJECT, undefined, hooks),
      },
    }
  }

  it('ABSENT: confirm 「新建」 → CREATE → dry run → preview confirm → write — the create precedes the preview (Q4)', async () => {
    const log: string[] = []
    const { deps: d } = deps(log, [ABSENT(), targetState({ rowCount: 6, activeRowCount: 6 })])
    const outcome = await runStockPreparationProjectPull(d, PROJECT)
    expect(outcome.kind).toBe('synced')
    expect(log).toEqual(['target.get', 'confirm:create', 'target.create', 'dryRun', 'confirm:write', 'apply', 'archive', 'target.get'])
    expect(log.indexOf('target.create')).toBeLessThan(log.indexOf('dryRun'))
    if (outcome.kind === 'synced') {
      expect(outcome.mode).toBe('created')
      expect(outcome.createdSheet).toBe(true)
      expect(outcome.report.verdict).toBe('imported')
      expect(outcome.after?.rowCount).toBe(6)
    }
  })

  it('ABSENT, 「先不建」: nothing created, nothing planned', async () => {
    const log: string[] = []
    const { deps: d } = deps(log, [ABSENT()], { create: false })
    expect(await runStockPreparationProjectPull(d, PROJECT)).toEqual({ kind: 'cancelled', stage: 'create' })
    expect(log).toEqual(['target.get', 'confirm:create'])
  })

  it('ABSENT, the preview declined: the sheet stays (no undo), nothing written, verdict not_written', async () => {
    const log: string[] = []
    const { deps: d } = deps(log, [ABSENT(), targetState({ rowCount: 0, activeRowCount: 0 })], { write: false })
    const outcome = await runStockPreparationProjectPull(d, PROJECT)
    expect(log).toEqual(['target.get', 'confirm:create', 'target.create', 'dryRun', 'confirm:write', 'target.get'])
    expect(outcome.kind).toBe('synced')
    if (outcome.kind === 'synced') {
      expect(outcome.report.verdict).toBe('not_written')
      expect(outcome.report.steps.find((step) => step.id === 'apply')?.reason).toBe('WRITE_NOT_CONFIRMED')
      expect(outcome.after?.status).toBe('active')
    }
  })

  it('ABSENT without the pull right, or without may.create: 「请联系拉取人员」, no question asked', async () => {
    for (const [canPull, mayCreate] of [[false, true], [true, false]] as const) {
      const log: string[] = []
      const { deps: d } = deps(log, [ABSENT(mayCreate)], {}, canPull)
      expect(await runStockPreparationProjectPull(d, PROJECT)).toEqual({ kind: 'contact_puller' })
      expect(log).toEqual(['target.get'])
    }
  })

  it('a refused create stops before any plan; EXISTS (a race partner) carries on; DISABLED falls back to the old run', async () => {
    const limit = deps([], [ABSENT()], {}, true, async () => { throw new StockPreparationProjectTargetCallError(409, 'POST', { code: 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT' }) })
    const refusedOutcome = await runStockPreparationProjectPull(limit.deps, PROJECT)
    expect(refusedOutcome).toEqual({ kind: 'create_refused', status: 409, code: 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT' })
    expect(limit.sync.dryRun).not.toHaveBeenCalled()

    const raceLog: string[] = []
    const race = deps(raceLog, [ABSENT(), targetState()], {}, true, async () => { throw new StockPreparationProjectTargetCallError(409, 'POST', { code: 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS' }) })
    const raced = await runStockPreparationProjectPull(race.deps, PROJECT)
    expect(raced.kind).toBe('synced')
    expect(raceLog).toContain('dryRun')

    const offLog: string[] = []
    const off = deps(offLog, [ABSENT()], {}, true, async () => { throw disabledError() })
    const fellBack = await runStockPreparationProjectPull(off.deps, PROJECT)
    expect(fellBack.kind === 'synced' && fellBack.mode).toBe('legacy')
    expect(offLog).not.toContain('confirm:write')
  })

  it('ACTIVE: one 「重新拉取」 question carrying the bounded counts, then the unchanged run (no preview question)', async () => {
    const log: string[] = []
    const { deps: d, asked } = deps(log, [targetState(), targetState({ rowCount: 15, activeRowCount: 14 })])
    const outcome = await runStockPreparationProjectPull(d, PROJECT)
    expect(asked).toEqual([{ kind: 'repull', rowCount: 12, activeRowCount: 10, rowCountBounded: false }])
    expect(log).toEqual(['target.get', 'confirm:repull', 'dryRun', 'apply', 'archive', 'target.get'])
    expect(outcome.kind === 'synced' && outcome.mode).toBe('existing')
    const declined = deps([], [targetState()], { repull: false })
    expect(await runStockPreparationProjectPull(declined.deps, PROJECT)).toEqual({ kind: 'cancelled', stage: 'repull' })
    expect(declined.sync.dryRun).not.toHaveBeenCalled()
  })

  it('ARCHIVED: stop, read-only, no question, no plan', async () => {
    const log: string[] = []
    const archived = targetState({ status: 'archived', may: { create: false, archive: false, restore: true } })
    const { deps: d } = deps(log, [archived])
    const outcome = await runStockPreparationProjectPull(d, PROJECT)
    expect(outcome.kind).toBe('archived')
    expect(outcome.kind === 'archived' && outcome.mayRestore).toBe(true)
    expect(log).toEqual(['target.get'])
  })

  it('switch OFF (or unreadable): the old run, exactly — no question, no create, no re-read', async () => {
    for (const answer of [disabledError(), new StockPreparationProjectTargetCallError(500, 'GET', { code: 'INTERNAL' })]) {
      const log: string[] = []
      const { deps: d } = deps(log, [answer])
      const outcome = await runStockPreparationProjectPull(d, PROJECT)
      expect(outcome.kind === 'synced' && outcome.mode).toBe('legacy')
      expect(log).toEqual(['target.get', 'dryRun', 'apply', 'archive'])
    }
    const noClient: string[] = []
    const { deps: d } = deps(noClient, [ABSENT()])
    const outcome = await runStockPreparationProjectPull({ ...d, targetApi: null }, PROJECT)
    expect(outcome.kind === 'synced' && outcome.mode).toBe('legacy')
    expect(noClient).toEqual(['dryRun', 'apply', 'archive'])
  })
})

// ---------------------------------------------------------------------------
// PT-HOOK
// ---------------------------------------------------------------------------

describe('PT-HOOK — the optional write confirmation inside the four-step run', () => {
  it('declined → no apply, WRITE_NOT_CONFIRMED, archive not attempted; accepted → apply; no hook → unchanged', async () => {
    const declinedLog: string[] = []
    const declined = await runStockPreparationProjectSync(syncDouble(declinedLog), PROJECT, undefined, { confirmWrite: () => false })
    expect(declinedLog).toEqual(['dryRun'])
    expect(declined.steps.map((step) => [step.id, step.status, step.reason])).toEqual([
      ['dry-run', 'ok', 'PLAN_READY'],
      ['confirm-queue', 'skip', 'NOTHING_TO_CONFIRM'],
      ['apply', 'skip', 'WRITE_NOT_CONFIRMED'],
      ['archive', 'skip', 'BATCH_ARCHIVE_NOT_ATTEMPTED'],
    ])
    expect(declined.verdict).toBe('not_written')
    expect(declined.imported).toBe(false)

    const plannedSeen: unknown[] = []
    const acceptedLog: string[] = []
    const accepted = await runStockPreparationProjectSync(syncDouble(acceptedLog), PROJECT, undefined, { confirmWrite: (planned) => { plannedSeen.push(planned); return true } })
    expect(acceptedLog).toEqual(['dryRun', 'apply', 'archive'])
    expect(plannedSeen).toEqual([{ add: 5, update: 1, skip: 3, inactive: 0, manualConfirm: 0 }])
    expect(accepted.verdict).toBe('imported')

    const plainLog: string[] = []
    const plain = await runStockPreparationProjectSync(syncDouble(plainLog), PROJECT)
    expect(plainLog).toEqual(['dryRun', 'apply', 'archive'])
    expect(plain.verdict).toBe('imported')
  })
})

// ---------------------------------------------------------------------------
// PT-CODES
// ---------------------------------------------------------------------------

describe('PT-CODES — every project-sheet refusal says who acts next', () => {
  it('each refusal code has its own two-line sentence (never the generic one)', () => {
    expect(STOCK_PREP_PROJECT_TARGET_ERROR_CODES.length).toBeGreaterThanOrEqual(11)
    for (const code of STOCK_PREP_PROJECT_TARGET_ERROR_CODES) {
      const entry = STOCK_PREP_ERROR_PLAIN[code]
      expect(entry, code).toBeTruthy()
      expect(entry).not.toBe(STOCK_PREP_ERROR_GENERIC)
      for (const key of ['zh', 'en', 'zhNext', 'enNext'] as const) {
        expect(String(entry[key] ?? '').trim().length, `${code}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('the dry-run classifier sorts the project-sheet codes BY CODE, ahead of the status rules', () => {
    expect(classifyPlanReadFailureReason(409, 'STOCK_PREPARATION_PROJECT_ABSENT')).toBe('PLAN_PROJECT_SHEET_ABSENT')
    expect(classifyPlanReadFailureReason(409, 'STOCK_PREPARATION_PROJECT_ARCHIVED')).toBe('PLAN_PROJECT_SHEET_ARCHIVED')
    expect(classifyPlanReadFailureReason(409, 'TABLE_ACTION_TARGET_TENANT_MISMATCH')).toBe('PLAN_TARGET_NOT_OURS')
    expect(classifyPlanReadFailureReason(409, 'TABLE_ACTION_TARGET_OWNER_UNKNOWN')).toBe('PLAN_TARGET_NOT_OURS')
    expect(classifyPlanReadFailureReason(422, 'TARGET_SCHEMA_INCOMPLETE')).toBe('PLAN_TARGET_SCHEMA_INCOMPLETE')
    // Unchanged neighbours.
    expect(classifyPlanReadFailureReason(409, 'TARGET_SHEET_FOREIGN_PROJECT')).toBe('PLAN_READ_FAILED_FOREIGN_PROJECT')
    expect(classifyPlanReadFailureReason(403, null)).toBe('PLAN_READ_NOT_PERMITTED')
    for (const reason of new Set(Object.values(STOCK_PREP_PROJECT_SHEET_PLAN_REFUSAL_REASONS))) {
      const entry = STOCK_PREP_SYNC_REASON_PLAIN[reason]
      expect(entry, reason).toBeTruthy()
      expect(String(entry.zhNext ?? '').length, reason).toBeGreaterThan(0)
    }
    expect(STOCK_PREP_SYNC_REASON_PLAIN.WRITE_NOT_CONFIRMED.zhNext).toContain('不会再建第二张表')
    expect(STOCK_PREP_SYNC_VERDICT_PLAIN.not_written).toBeTruthy()
  })

  it('the copy never calls the re-pull 「覆盖」 and never offers 「撤销新建」', () => {
    const all = JSON.stringify(STOCK_PREP_PROJECT_TARGET_PLAIN)
    expect(all).not.toContain('覆盖')
    expect(all).not.toContain('撤销新建')
    expect(all.toLowerCase()).not.toContain('overwrite')
  })

  it('row-count sentence: total, total with active, bounded, and nothing when the server could not count', () => {
    expect(stockPrepProjectTargetRowCountText({ rowCount: 12, activeRowCount: 10, rowCountBounded: false })?.zh).toBe('表里现在共 12 行(有效 10 行)')
    expect(stockPrepProjectTargetRowCountText({ rowCount: 12, activeRowCount: 12, rowCountBounded: false })?.zh).toBe('表里现在共 12 行')
    expect(stockPrepProjectTargetRowCountText({ rowCount: 5000, activeRowCount: 4000, rowCountBounded: true })?.zh).toBe('表里现在超过 5000 行')
    expect(stockPrepProjectTargetRowCountText({ rowCount: null, activeRowCount: null, rowCountBounded: null })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PT-PANEL
// ---------------------------------------------------------------------------

describe('PT-PANEL — the pull panel', () => {
  function mountPanel(log: string[], states: Array<StockPrepProjectTargetState | Error>, options: { create?: () => Promise<unknown>; sync?: Partial<StockPreparationProjectSyncApi> } = {}) {
    const onTarget = vi.fn()
    const root = mount(StockPreparationProjectSyncPanel as Component, {
      scope: SCOPE,
      api: syncDouble(log, options.sync),
      targetApi: targetDouble(log, states, { create: options.create }),
      onProjectTargetChanged: onTarget,
    })
    return { root, onTarget }
  }

  it('absent → 「新建备料表并拉取」 → create → preview → 「确认写入」 → imported, and the result line says how many rows the sheet holds now', async () => {
    const log: string[] = []
    const { root, onTarget } = mountPanel(log, [ABSENT(), targetState({ rowCount: 6, activeRowCount: 5 })])
    await typeAndRun(root)
    const prompt = testid(root, 'stock-prep-project-sync-target-prompt')
    expect(prompt?.dataset.prompt).toBe('create')
    expect(testid(root, 'stock-prep-project-sync-target-prompt-project-no')?.textContent).toBe(PROJECT)
    expect(log).toEqual(['target.get'])
    await press(root, 'stock-prep-project-target-create')
    expect(testid(root, 'stock-prep-project-sync-target-prompt')?.dataset.prompt).toBe('write')
    expect(testid(root, 'stock-prep-project-sync-target-prompt-preview')?.textContent).toContain('将写入 6 行')
    expect(log).toEqual(['target.get', 'target.create', 'dryRun'])
    await press(root, 'stock-prep-project-sync-target-prompt-confirm')
    expect(log).toEqual(['target.get', 'target.create', 'dryRun', 'apply', 'archive', 'target.get'])
    expect(testid(root, 'stock-prep-project-sync-verdict')?.dataset.verdict).toBe('imported')
    expect(testid(root, 'stock-prep-project-sync-target-rows')?.textContent).toContain('表里现在共 6 行(有效 5 行)')
    expect(testid(root, 'stock-prep-project-sync-target-prompt')).toBeNull()
    expect(onTarget).toHaveBeenCalledTimes(1)
  })

  it('absent → 「先不建」: nothing created, nothing planned, and the panel says so', async () => {
    const log: string[] = []
    const { root } = mountPanel(log, [ABSENT()])
    await typeAndRun(root)
    await press(root, 'stock-prep-project-sync-target-prompt-cancel')
    expect(log).toEqual(['target.get'])
    const notice = testid(root, 'stock-prep-project-sync-target-notice')
    expect(notice?.dataset.notice).toBe('cancelled')
    expect(notice?.textContent).toContain('没有新建,什么都没有改动。')
    expect(testid(root, 'stock-prep-project-sync-verdict')).toBeNull()
  })

  it('the preview declined: verdict not_written, no apply, the sheet stays (no undo control anywhere)', async () => {
    const log: string[] = []
    const { root } = mountPanel(log, [ABSENT(), targetState({ rowCount: 0, activeRowCount: 0 })])
    await typeAndRun(root)
    await press(root, 'stock-prep-project-target-create')
    await press(root, 'stock-prep-project-sync-target-prompt-cancel')
    expect(log).not.toContain('apply')
    expect(testid(root, 'stock-prep-project-sync-verdict')?.dataset.verdict).toBe('not_written')
    expect(root.textContent).not.toContain('撤销新建')
    expect(testid(root, 'stock-prep-project-sync-target-rows')?.textContent).toContain('表里现在共 0 行')
  })

  it('active → the re-pull question names the bounded row count and the safe semantics, never 「覆盖」', async () => {
    const log: string[] = []
    const { root } = mountPanel(log, [targetState(), targetState({ rowCount: 13, activeRowCount: 11 })])
    await typeAndRun(root)
    expect(testid(root, 'stock-prep-project-sync-target-prompt')?.dataset.prompt).toBe('repull')
    const rows = testid(root, 'stock-prep-project-sync-target-prompt-rows')?.textContent ?? ''
    expect(rows).toContain('表里现在共 12 行(有效 10 行)')
    expect(rows).toContain('您填的列保留')
    expect(testid(root, 'stock-prep-project-sync-target-prompt')?.textContent).not.toContain('覆盖')
    await press(root, 'stock-prep-project-sync-target-prompt-confirm')
    expect(log).toEqual(['target.get', 'dryRun', 'apply', 'archive', 'target.get'])
    expect(testid(root, 'stock-prep-project-sync-target-rows')?.textContent).toContain('表里现在共 13 行(有效 11 行)')
  })

  it('archived → stops with who restores it; a refused create names its code and next step', async () => {
    const archivedLog: string[] = []
    const { root } = mountPanel(archivedLog, [targetState({ status: 'archived', may: { create: false, archive: false, restore: false } })])
    await typeAndRun(root)
    expect(archivedLog).toEqual(['target.get'])
    const notice = testid(root, 'stock-prep-project-sync-target-notice')
    expect(notice?.dataset.notice).toBe('archived')
    expect(notice?.textContent).toContain('请联系拉取人员恢复')
    unmountAll()

    const limitLog: string[] = []
    const limited = mountPanel(limitLog, [ABSENT()], { create: async () => { throw new StockPreparationProjectTargetCallError(409, 'POST', { code: 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT' }) } })
    await typeAndRun(limited.root)
    await press(limited.root, 'stock-prep-project-target-create')
    const refusal = testid(limited.root, 'stock-prep-project-sync-target-notice')
    expect(refusal?.dataset.notice).toBe('create_refused')
    expect(refusal?.textContent).toContain(STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_PROJECT_TARGET_LIMIT.zh)
    expect(refusal?.textContent).toContain('STOCK_PREPARATION_PROJECT_TARGET_LIMIT')
    expect(limitLog).not.toContain('dryRun')
  })

  it('switch OFF: no question, no create — the run is the pre-S2 run', async () => {
    const log: string[] = []
    const { root } = mountPanel(log, [disabledError()])
    await typeAndRun(root)
    expect(testid(root, 'stock-prep-project-sync-target-prompt')).toBeNull()
    expect(testid(root, 'stock-prep-project-sync-target-notice')).toBeNull()
    expect(testid(root, 'stock-prep-project-sync-target-rows')).toBeNull()
    expect(log).toEqual(['target.get', 'dryRun', 'apply', 'archive'])
    expect(testid(root, 'stock-prep-project-sync-verdict')?.dataset.verdict).toBe('imported')
  })

  it('a dry run refused 409 ABSENT (the probe could not read) gets the project-sheet sentence, not 「稍后再试」', async () => {
    const log: string[] = []
    const { root } = mountPanel(log, [new StockPreparationProjectTargetCallError(503, 'GET', { code: 'X' })], {
      sync: { dryRun: vi.fn(async () => { log.push('dryRun'); throw new StockPreparationProjectSyncCallError(409, 'dry-run', { code: 'STOCK_PREPARATION_PROJECT_ABSENT' }) }) },
    })
    await typeAndRun(root)
    const reason = root.querySelector('[data-step="dry-run"] [data-testid="stock-prep-project-sync-step-reason"]')?.textContent ?? ''
    expect(reason).toContain(STOCK_PREP_SYNC_REASON_PLAIN.PLAN_PROJECT_SHEET_ABSENT.zh)
  })
})

// ---------------------------------------------------------------------------
// PT-BOARD / PT-HOME / PT-QUERY
// ---------------------------------------------------------------------------

function routeBoardApi(): void {
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/operator/projects')) {
      return ok({ tenantId: SCOPE.tenantId, directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] })
    }
    if (path.includes('/board')) return refused(404, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
    return refused(404, 'NOT_ROUTED_IN_THIS_SUITE')
  })
}

describe('PT-BOARD — 项目备料页 says which sheet is the project\'s own', () => {
  it('active: the status line, the bounded row count and 「直接打开」 with the project sheet\'s own handle', async () => {
    routeBoardApi()
    const onOpen = vi.fn()
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [targetState()]), onOpenMultitable: onOpen })
    await flush()
    const line = testid(root, 'stock-prep-project-target-status')
    expect(line?.dataset.targetStatus).toBe('active')
    expect(testid(root, 'stock-prep-project-target-rows')?.textContent).toContain('表里现在共 12 行(有效 10 行)')
    await press(root, 'stock-prep-project-target-open')
    expect(onOpen).toHaveBeenLastCalledWith({ sheetId: SHEET, viewId: FILL_VIEW })
  })

  it('absent: the puller is told the pull creates it; the floor operator is told to contact a pull operator', async () => {
    routeBoardApi()
    let root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [ABSENT(true)]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('absent')
    expect(testid(root, 'stock-prep-project-target-next')?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.absent_can_create.zh)
    expect(testid(root, 'stock-prep-project-target-open')).toBeNull()
    unmountAll()
    h.permissions = [...FLOOR]
    root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [ABSENT(false)]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-next')?.textContent).toContain('请联系拉取人员')
  })

  it('archived: 「打开(已归档)」 and who restores it; switch OFF: no line at all', async () => {
    routeBoardApi()
    let root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [targetState({ status: 'archived', may: { create: false, archive: false, restore: true } })]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('archived')
    expect(testid(root, 'stock-prep-project-target-open')?.textContent).toContain('打开(已归档)')
    expect(testid(root, 'stock-prep-project-target-next')?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.restore_pending.zh)
    unmountAll()
    root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [disabledError()]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')).toBeNull()
  })
})

describe('PT-HOME / PT-QUERY — 今天要处理 and 项目查询', () => {
  function directory(): Record<string, unknown> {
    return {
      tenantId: SCOPE.tenantId, directoryReady: true, ledgerReady: true, projectCount: 1, pendingProjectCount: 0,
      projects: [{ projectId: 'p_syn_1', projectNo: PROJECT, projectName: '合成项目甲', projectStatus: 'active', pendingDecisionCount: 0 }],
    }
  }
  const list: StockPrepProjectTargetList = {
    count: 1,
    limit: 200,
    items: [{ projectNo: PROJECT, status: 'active', sheetId: SHEET, rowCount: 8, activeRowCount: 7, countsBounded: false }],
  }

  it('switch on: 「每个项目一张备料表」 with the registered count, per-card rows, and the hint for the new world', async () => {
    const root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory: directory(), directoryLoaded: true, projectTargets: list })
    await flush()
    const line = testid(root, 'stock-prep-project-target-list')
    expect(line?.textContent).toContain('每个项目一张备料表')
    expect(line?.textContent).toContain('已经有 1 个项目建了表')
    expect(testid(root, 'stock-prep-operator-home-card-rows')?.textContent).toContain('表里现在共 8 行(有效 7 行)')
    expect(testid(root, 'stock-prep-operator-home-quick-open-hint')?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.home_one_sheet_per_project.zhNext!)
  })

  it('switch off: no line, no card rows, and the Q8 wording — 「平台登记」, never 「归档过」', async () => {
    const root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory: directory(), directoryLoaded: true })
    await flush()
    expect(testid(root, 'stock-prep-project-target-list')).toBeNull()
    expect(testid(root, 'stock-prep-operator-home-card-rows')).toBeNull()
    const hint = testid(root, 'stock-prep-operator-home-quick-open-hint')?.textContent ?? ''
    expect(hint).toContain('平台登记的项目')
    expect(hint).not.toContain('归档过')
  })

  it('项目查询\'s `mvp` source label is 「平台登记」 (code key unchanged)', async () => {
    expect(STOCK_PREP_SOURCE_MVP_LABEL).toEqual({ zh: '平台登记', en: 'Platform-registered' })
    const source = await import('../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue?raw')
    const text = String((source as { default: string }).default)
    expect(text).not.toMatch(/['"]归档过/)
    expect(text).toContain('mvp: [STOCK_PREP_SOURCE_MVP_LABEL.zh, STOCK_PREP_SOURCE_MVP_LABEL.en]')
  })
})

// ---------------------------------------------------------------------------
// PT-ALIGN — the three manifest controls, both directions, per actor
// ---------------------------------------------------------------------------

describe('PT-ALIGN — rendered project-sheet controls equal granted capabilities', () => {
  const ACTORS: Array<{ name: string; roles: string[]; permissions: string[] }> = [
    { name: 'reader', roles: [], permissions: ['stock-prep:read'] },
    { name: 'floor', roles: [], permissions: [...FLOOR] },
    { name: 'puller', roles: [], permissions: [...PULLER] },
    { name: 'workbench-admin', roles: [], permissions: ['stock-prep:admin'] },
    { name: 'platform-admin', roles: ['admin'], permissions: ['integration:admin'] },
    { name: 'pull-orphan', roles: [], permissions: ['stock-prep:pull'] },
  ]
  const byCapability = new Map(STOCK_PREP_WORKBENCH_CAPABILITIES.map((capability) => [capability.capability, capability]))

  /** The server's own gate, answered as the S1 routes answer it: 403 below the tier. */
  function gatedTargetApi(state: StockPrepProjectTargetState): StockPreparationProjectTargetApi {
    const granted = () => grantedStockPrepCapabilities({ roles: h.roles, permissions: h.permissions })
    const refuse = () => new StockPreparationProjectTargetCallError(403, 'gate', { code: 'FORBIDDEN' })
    return {
      get: vi.fn(async () => {
        if (!granted().includes('projectTarget.read')) throw refuse()
        return { ...state, may: { ...state.may, create: state.status === 'absent' && granted().includes('projectTarget.create') } }
      }),
      create: vi.fn(async () => {
        if (!granted().includes('projectTarget.create')) throw refuse()
        return { status: 'active' as const, created: true, sheetId: SHEET, viewId: FILL_VIEW, todoViewId: TODO_VIEW }
      }),
      list: vi.fn(async () => {
        if (!granted().includes('projectTarget.list')) throw refuse()
        return { count: 0, limit: 200, items: [] }
      }),
    }
  }

  it('the three controls are manifest members with these ids (anti-vacuity)', () => {
    expect(byCapability.get('projectTarget.read')?.control).toBe('stock-prep-project-target-status')
    expect(byCapability.get('projectTarget.create')?.control).toBe('stock-prep-project-target-create')
    expect(byCapability.get('projectTarget.list')?.control).toBe('stock-prep-project-target-list')
  })

  it('status (board), create (pull panel) and list (home) render iff the manifest grants them', async () => {
    for (const actor of ACTORS) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      const granted = grantedStockPrepCapabilities({ roles: actor.roles, permissions: actor.permissions })

      routeBoardApi()
      let root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: gatedTargetApi(targetState()) })
      await flush()
      expect(testid(root, 'stock-prep-project-target-status') !== null, `${actor.name}: status`).toBe(granted.includes('projectTarget.read'))
      unmountAll()

      root = mount(StockPreparationProjectSyncPanel as Component, { scope: SCOPE, api: syncDouble([]), targetApi: gatedTargetApi(ABSENT()) })
      await nextTick()
      if (testid(root, 'stock-prep-project-sync-run')) await typeAndRun(root)
      expect(testid(root, 'stock-prep-project-target-create') !== null, `${actor.name}: create`).toBe(granted.includes('projectTarget.create'))
      unmountAll()

      routeBoardApi()
      resetStockPreparationOperatorHomeDirectoryThrottle()
      root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectTargetApi: gatedTargetApi(targetState()) })
      await flush()
      expect(testid(root, 'stock-prep-project-target-list') !== null, `${actor.name}: list`).toBe(granted.includes('projectTarget.list'))
      unmountAll()
    }
  })
})

// Keep the report type import used (the run's own shape is what the flow returns).
export type _Report = StockPreparationProjectSyncReport
