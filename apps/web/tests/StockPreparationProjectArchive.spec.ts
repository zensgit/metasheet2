import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 一个项目一张备料表 — S4 归档与恢复 (ADR adr-stock-prep-project-sheets-20261008 §4 archived row / §6;
// register R-38).
//
//   PA-CLIENT  archive / restore: POST, the body is EXACTLY `{ confirmProjectNo }`, NO query (a write
//              carries no steering field), a strict clamp, a refusal's status + code surfaced.
//   PA-FLOW    changeStockPreparationProjectTargetLifecycle: a typed number that does not match (empty,
//              different, case-folded, prefix) sends NOTHING; no pull right sends nothing and says whom
//              to ask; a match calls the route with the trimmed numbers and re-reads the sheet; a
//              server refusal comes back with its code.
//   PA-BOARD   项目备料页's sheet-state line: 「归档项目」 on an active sheet / 「恢复这张表」 on an archived
//              one, for a puller only; the typed confirmation (button disabled until it matches, the
//              「从列表移除 vs 归档项目」 line on archive); the line follows the new state; a refusal shows
//              its plain sentence and code; the floor operator gets no button and 「请联系拉取人员」.
//   PA-PANEL   the pull panel on an archived sheet: a puller gets 「恢复并重新拉取」 → type → RESTORE → the
//              same pull runs again and asks the 「重新拉取」 question; anyone else reads 「请联系拉取人员
//              恢复」 and gets no button; a refused restore stops with its code and pulls nothing.
//   PA-COPY    the S2 placeholder 「恢复入口随后上线」 is gone; every new refusal code has its own
//              two-line zh + en sentence.
//   PA-ALIGN   the two new manifest controls render for EXACTLY the actors the SERVER grants (the plugin
//              module, imported live) on the line they live on; the client rows are byte-equal to the
//              plugin's (F-01 for these rows).
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
import {
  STOCK_PREP_PROJECT_TARGET_ERROR_CODES,
  StockPreparationProjectTargetCallError,
  changeStockPreparationProjectTargetLifecycle,
  clampStockPrepProjectTargetLifecycle,
  createStockPreparationProjectTargetApi,
  stockPrepProjectNumbersMatch,
  type StockPrepProjectTargetState,
  type StockPreparationProjectTargetApi,
} from '../src/services/integration/stockPreparation/projectTarget'
import type { StockPreparationProjectSyncApi } from '../src/services/integration/stockPreparation/projectSync'
import {
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_PROJECT_TARGET_PLAIN,
} from '../src/services/integration/stockPreparation/plainLanguage'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

// The SERVER's own manifest and decision, imported live (the F-01 posture).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backendAccess = require('../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs')

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const PROJECT = 'PRJ-SYN-S4-01'
const SHEET = 'sheet_syn_project_s4'
const FILL_VIEW = 'view_syn_fill_s4'
const TODO_VIEW = 'view_syn_todo_s4'

const PULLER = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']
const FLOOR = ['stock-prep:read', 'stock-prep:operate']

const LIFECYCLE_CODES = [
  'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED',
  'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED',
  'STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH',
]

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

const ARCHIVED = (mayRestore = true): StockPrepProjectTargetState => targetState({
  status: 'archived',
  archivedAt: '2026-10-09T00:00:00.000Z',
  may: { create: false, archive: false, restore: mayRestore },
})

function lifecycleResult(status: 'active' | 'archived') {
  return {
    status,
    sheetId: SHEET,
    archivedAt: status === 'archived' ? '2026-10-09T01:00:00.000Z' : null,
    restoredAt: status === 'active' ? '2026-10-09T02:00:00.000Z' : null,
    may: { create: false, archive: status === 'active', restore: status === 'archived' },
  }
}

/** A target client double that logs into `log`. `get` answers the queued states in order. */
function targetDouble(
  log: string[],
  states: Array<StockPrepProjectTargetState | Error>,
  options: { archive?: () => Promise<unknown>; restore?: () => Promise<unknown> } = {},
): StockPreparationProjectTargetApi & { calls: Array<[string, string, string]> } {
  let reads = 0
  const calls: Array<[string, string, string]> = []
  return {
    calls,
    get: vi.fn(async () => {
      log.push('target.get')
      const answer = states[Math.min(reads, states.length - 1)]
      reads += 1
      if (answer instanceof Error) throw answer
      return answer
    }),
    create: vi.fn(async () => {
      log.push('target.create')
      return { status: 'active' as const, created: true, sheetId: SHEET, viewId: FILL_VIEW, todoViewId: TODO_VIEW }
    }),
    list: vi.fn(async () => {
      log.push('target.list')
      return { count: 0, limit: 200, items: [] }
    }),
    archive: vi.fn(async (projectNo: string, confirmProjectNo: string) => {
      log.push('target.archive')
      calls.push(['archive', projectNo, confirmProjectNo])
      if (options.archive) return options.archive() as never
      return lifecycleResult('archived')
    }),
    restore: vi.fn(async (projectNo: string, confirmProjectNo: string) => {
      log.push('target.restore')
      calls.push(['restore', projectNo, confirmProjectNo])
      if (options.restore) return options.restore() as never
      return lifecycleResult('active')
    }),
  }
}

function syncDouble(log: string[]): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn(async () => {
      log.push('dryRun')
      return { status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 0, update: 1, skip: 3, inactive: 0, manual_confirm: 0 } }
    }),
    reconcile: vi.fn(async () => { log.push('reconcile'); return { counts: { pending: 0 } } }),
    apply: vi.fn(async () => {
      log.push('apply')
      return { status: 'succeeded', apply: { counts: { created: 0, updated: 1, inactive: 0, skipped: 3, held: 0, failed: 0 } } }
    }),
    archive: vi.fn(async () => { log.push('mvp-archive'); return { status: 'created', persisted: true, created: { batch: 1, lines: 1, run: 1 } } }),
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

async function press(root: HTMLElement, id: string): Promise<void> {
  const button = testid(root, id) as HTMLButtonElement | null
  expect(button, `${id} must render`).not.toBeNull()
  button!.click()
  await flush()
}

async function type(root: HTMLElement, id: string, value: string): Promise<void> {
  const input = testid(root, id) as HTMLInputElement | null
  expect(input, `${id} must render`).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
  await nextTick()
}

function disabled(root: HTMLElement, id: string): boolean {
  return (testid(root, id) as HTMLButtonElement | null)?.disabled === true
}

function routeBoardApi(): void {
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/operator/projects')) {
      return ok({ tenantId: SCOPE.tenantId, directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] })
    }
    if (path.includes('/board')) return refused(404, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
    return refused(404, 'NOT_ROUTED_IN_THIS_SUITE')
  })
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
// PA-CLIENT
// ---------------------------------------------------------------------------

describe('PA-CLIENT — the archive / restore routes', () => {
  it('POST, a body of exactly { confirmProjectNo }, no query; the answer is clamped strictly', async () => {
    h.apiFetch.mockImplementation(async (path: string) => ok(lifecycleResult(path.endsWith('/archive') ? 'archived' : 'active')))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    const archived = await api.archive!(PROJECT, PROJECT)
    expect(archived.status).toBe('archived')
    expect(archived.may).toEqual({ create: false, archive: false, restore: true })
    const restored = await api.restore!(PROJECT, PROJECT)
    expect(restored.status).toBe('active')
    const calls = h.apiFetch.mock.calls.map(([path, init]) => [String(path), (init as RequestInit | undefined)?.method, (init as RequestInit | undefined)?.body])
    expect(calls).toEqual([
      [`/api/integration/stock-preparation/projects/${PROJECT}/target/archive`, 'POST', JSON.stringify({ confirmProjectNo: PROJECT })],
      [`/api/integration/stock-preparation/projects/${PROJECT}/target/restore`, 'POST', JSON.stringify({ confirmProjectNo: PROJECT })],
    ])
    // Strict: an absent status, or a `may` that is not three booleans, is not an answer.
    expect(clampStockPrepProjectTargetLifecycle({ status: 'absent', may: { create: false, archive: false, restore: false } })).toBeNull()
    expect(clampStockPrepProjectTargetLifecycle({ status: 'archived', may: { create: false, archive: 'no', restore: true } })).toBeNull()
    expect(clampStockPrepProjectTargetLifecycle({ status: 'deleted', may: { create: false, archive: false, restore: true } })).toBeNull()
  })

  it('a refusal surfaces its status and clamped code; a malformed 2xx is malformed, never a result', async () => {
    h.apiFetch.mockImplementation(async () => refused(409, 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED'))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    const error = await api.archive!(PROJECT, PROJECT).catch((caught) => caught)
    expect(error).toBeInstanceOf(StockPreparationProjectTargetCallError)
    expect((error as StockPreparationProjectTargetCallError).status).toBe(409)
    expect((error as StockPreparationProjectTargetCallError).code).toBe('STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED')
    h.apiFetch.mockImplementation(async () => ok({}))
    const malformed = await api.restore!(PROJECT, PROJECT).catch((caught) => caught)
    expect((malformed as StockPreparationProjectTargetCallError).malformed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PA-FLOW
// ---------------------------------------------------------------------------

describe('PA-FLOW — changeStockPreparationProjectTargetLifecycle', () => {
  it('the typed number must match exactly (trimmed, never folded); a mismatch sends nothing', async () => {
    expect(stockPrepProjectNumbersMatch(PROJECT, PROJECT)).toBe(true)
    expect(stockPrepProjectNumbersMatch(PROJECT, `  ${PROJECT} `)).toBe(true)
    for (const typed of ['', '   ', PROJECT.toLowerCase(), PROJECT.slice(0, -1), `${PROJECT}0`, 'PRJ-SYN-S4-02']) {
      expect(stockPrepProjectNumbersMatch(PROJECT, typed), JSON.stringify(typed)).toBe(false)
      const log: string[] = []
      const api = targetDouble(log, [targetState()])
      const outcome = await changeStockPreparationProjectTargetLifecycle({ targetApi: api, canPull: true }, 'archive', PROJECT, typed)
      expect(outcome).toEqual({ kind: 'mismatch', action: 'archive' })
      expect(log, 'nothing was sent').toEqual([])
    }
    expect(stockPrepProjectNumbersMatch('', '')).toBe(false)
  })

  it('no pull right → contact_puller, nothing sent; a match → the route with trimmed numbers, then a re-read', async () => {
    const log: string[] = []
    const api = targetDouble(log, [ARCHIVED()])
    expect(await changeStockPreparationProjectTargetLifecycle({ targetApi: api, canPull: false }, 'archive', PROJECT, PROJECT)).toEqual({ kind: 'contact_puller', action: 'archive' })
    expect(log).toEqual([])
    const done = await changeStockPreparationProjectTargetLifecycle({ targetApi: api, canPull: true }, 'archive', PROJECT, ` ${PROJECT} `)
    expect(done.kind).toBe('done')
    expect(done.kind === 'done' && done.state?.status).toBe('archived')
    expect(log).toEqual(['target.archive', 'target.get'])
    expect(api.calls).toEqual([['archive', PROJECT, PROJECT]])
  })

  it('a server refusal comes back with its status and code; nothing is re-read', async () => {
    const log: string[] = []
    const api = targetDouble(log, [targetState()], {
      restore: async () => { throw new StockPreparationProjectTargetCallError(409, 'POST', { code: 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED' }) },
    })
    const outcome = await changeStockPreparationProjectTargetLifecycle({ targetApi: api, canPull: true }, 'restore', PROJECT, PROJECT)
    expect(outcome).toEqual({ kind: 'refused', action: 'restore', status: 409, code: 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED' })
    expect(log).toEqual(['target.restore'])
  })
})

// ---------------------------------------------------------------------------
// PA-BOARD
// ---------------------------------------------------------------------------

describe('PA-BOARD — 项目备料页 archives and restores the project\'s own sheet', () => {
  it('active, puller: 「归档项目」 → typed confirmation (disabled until it matches) → archived, the line follows', async () => {
    routeBoardApi()
    const log: string[] = []
    const api = targetDouble(log, [targetState(), ARCHIVED()])
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: api })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('active')
    expect(testid(root, 'stock-prep-project-target-restore')).toBeNull()
    await press(root, 'stock-prep-project-target-archive')
    const prompt = testid(root, 'stock-prep-project-target-lifecycle-prompt')
    expect(prompt?.dataset.action).toBe('archive')
    expect(prompt?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.confirm_archive.zh)
    expect(testid(root, 'stock-prep-project-target-lifecycle-remove-vs-archive')?.textContent).toContain('从列表移除')
    expect(testid(root, 'stock-prep-project-target-lifecycle-project-no')?.textContent).toBe(PROJECT)
    expect(disabled(root, 'stock-prep-project-target-lifecycle-confirm'), 'nothing typed').toBe(true)
    await type(root, 'stock-prep-project-target-lifecycle-input', PROJECT.toLowerCase())
    expect(disabled(root, 'stock-prep-project-target-lifecycle-confirm'), 'case-folded').toBe(true)
    await type(root, 'stock-prep-project-target-lifecycle-input', PROJECT)
    expect(disabled(root, 'stock-prep-project-target-lifecycle-confirm')).toBe(false)
    await press(root, 'stock-prep-project-target-lifecycle-confirm')
    expect(api.calls).toEqual([['archive', PROJECT, PROJECT]])
    expect(testid(root, 'stock-prep-project-target-lifecycle-prompt')).toBeNull()
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('archived')
    const result = testid(root, 'stock-prep-project-target-lifecycle-result')
    expect(result?.dataset.result).toBe('done')
    expect(result?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.archived_done.zh)
    expect(testid(root, 'stock-prep-project-target-open')?.textContent).toContain('打开(已归档)')
    expect(testid(root, 'stock-prep-project-target-archive')).toBeNull()
    expect(testid(root, 'stock-prep-project-target-restore'), 'the restore control replaces it').not.toBeNull()
  })

  it('archived, puller: 「恢复这张表」 → typed confirmation → active again; cancel sends nothing', async () => {
    routeBoardApi()
    const log: string[] = []
    const api = targetDouble(log, [ARCHIVED(), targetState()])
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: api })
    await flush()
    expect(testid(root, 'stock-prep-project-target-next')?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.restore_pending.zh)
    await press(root, 'stock-prep-project-target-restore')
    expect(testid(root, 'stock-prep-project-target-lifecycle-prompt')?.dataset.action).toBe('restore')
    expect(testid(root, 'stock-prep-project-target-lifecycle-remove-vs-archive')).toBeNull()
    await press(root, 'stock-prep-project-target-lifecycle-cancel')
    expect(testid(root, 'stock-prep-project-target-lifecycle-prompt')).toBeNull()
    expect(api.calls).toEqual([])
    await press(root, 'stock-prep-project-target-restore')
    await type(root, 'stock-prep-project-target-lifecycle-input', PROJECT)
    await press(root, 'stock-prep-project-target-lifecycle-confirm')
    expect(api.calls).toEqual([['restore', PROJECT, PROJECT]])
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('active')
    expect(testid(root, 'stock-prep-project-target-lifecycle-result')?.textContent).toContain(STOCK_PREP_PROJECT_TARGET_PLAIN.restored_done.zh)
  })

  it('a refusal shows its own sentence and code and leaves the line as it was', async () => {
    routeBoardApi()
    const api = targetDouble([], [targetState()], {
      archive: async () => { throw new StockPreparationProjectTargetCallError(409, 'POST', { code: 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED' }) },
    })
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: api })
    await flush()
    await press(root, 'stock-prep-project-target-archive')
    await type(root, 'stock-prep-project-target-lifecycle-input', PROJECT)
    await press(root, 'stock-prep-project-target-lifecycle-confirm')
    const result = testid(root, 'stock-prep-project-target-lifecycle-result')
    expect(result?.dataset.result).toBe('refused')
    expect(result?.textContent).toContain(STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED.zh)
    expect(result?.textContent).toContain('STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED')
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('active')
  })

  it('the floor operator: no archive button on an active sheet, no restore button on an archived one — 「请联系拉取人员」', async () => {
    h.permissions = [...FLOOR]
    routeBoardApi()
    let root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [targetState({ may: { create: false, archive: false, restore: false } })]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')).not.toBeNull()
    expect(testid(root, 'stock-prep-project-target-archive')).toBeNull()
    unmountAll()
    routeBoardApi()
    root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [ARCHIVED(false)]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-restore')).toBeNull()
    expect(testid(root, 'stock-prep-project-target-next')?.textContent).toContain('请联系拉取人员')
    // ...and even a server that (wrongly) said `may.archive` cannot make the floor's button appear:
    // the control also needs the client's PULL-tier capability.
    unmountAll()
    routeBoardApi()
    root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetDouble([], [targetState()]) })
    await flush()
    expect(testid(root, 'stock-prep-project-target-archive')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PA-PANEL
// ---------------------------------------------------------------------------

describe('PA-PANEL — 「恢复并重新拉取」 in the pull panel', () => {
  async function typeAndRun(root: HTMLElement): Promise<void> {
    await type(root, 'stock-prep-project-sync-project-no', PROJECT)
    ;(testid(root, 'stock-prep-project-sync-run') as HTMLButtonElement).click()
    await flush()
  }

  it('puller: archived → 「恢复并重新拉取」 → typed confirmation → RESTORE → the same pull asks 「重新拉取」', async () => {
    const log: string[] = []
    const api = targetDouble(log, [ARCHIVED(), targetState(), targetState()])
    const onTarget = vi.fn()
    const root = mount(StockPreparationProjectSyncPanel as Component, { scope: SCOPE, api: syncDouble(log), targetApi: api, onProjectTargetChanged: onTarget })
    await nextTick()
    await typeAndRun(root)
    expect(testid(root, 'stock-prep-project-sync-target-notice')?.dataset.notice).toBe('archived')
    expect(testid(root, 'stock-prep-project-sync-target-notice')?.textContent).not.toContain('随后上线')
    await press(root, 'stock-prep-project-sync-restore')
    expect(testid(root, 'stock-prep-project-sync-restore-project-no')?.textContent).toBe(PROJECT)
    expect(disabled(root, 'stock-prep-project-sync-restore-confirm')).toBe(true)
    await type(root, 'stock-prep-project-sync-restore-input', 'PRJ-SYN-S4-99')
    expect(disabled(root, 'stock-prep-project-sync-restore-confirm')).toBe(true)
    await type(root, 'stock-prep-project-sync-restore-input', PROJECT)
    await press(root, 'stock-prep-project-sync-restore-confirm')
    expect(api.calls).toEqual([['restore', PROJECT, PROJECT]])
    // restore → re-read (counts) → the run again: probe → the 「重新拉取」 question (nothing pulled yet).
    expect(log).toEqual(['target.get', 'target.restore', 'target.get', 'target.get'])
    expect(testid(root, 'stock-prep-project-sync-target-prompt')?.dataset.prompt).toBe('repull')
    expect(onTarget).toHaveBeenCalledTimes(1)
    await press(root, 'stock-prep-project-sync-target-prompt-confirm')
    expect(log).toContain('dryRun')
    expect(log).toContain('apply')
  })

  it('the floor operator: 「请联系拉取人员恢复」 and no restore button', async () => {
    h.permissions = [...FLOOR]
    const log: string[] = []
    const root = mount(StockPreparationProjectSyncPanel as Component, { scope: SCOPE, api: syncDouble(log), targetApi: targetDouble(log, [ARCHIVED(false)]) })
    await nextTick()
    // The floor has no run button at all (R-33); the board is where the floor reads the sheet state.
    expect(testid(root, 'stock-prep-project-sync-run')).toBeNull()
    expect(testid(root, 'stock-prep-project-sync-restore')).toBeNull()
  })

  it('a puller whose server says may.restore = false sees no button; a refused restore stops with its code and pulls nothing', async () => {
    let log: string[] = []
    let root = mount(StockPreparationProjectSyncPanel as Component, { scope: SCOPE, api: syncDouble(log), targetApi: targetDouble(log, [ARCHIVED(false)]) })
    await nextTick()
    await typeAndRun(root)
    expect(testid(root, 'stock-prep-project-sync-target-notice')?.textContent).toContain('请联系拉取人员恢复')
    expect(testid(root, 'stock-prep-project-sync-restore')).toBeNull()
    unmountAll()

    log = []
    const api = targetDouble(log, [ARCHIVED()], {
      restore: async () => { throw new StockPreparationProjectTargetCallError(409, 'POST', { code: 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED' }) },
    })
    root = mount(StockPreparationProjectSyncPanel as Component, { scope: SCOPE, api: syncDouble(log), targetApi: api })
    await nextTick()
    await typeAndRun(root)
    await press(root, 'stock-prep-project-sync-restore')
    await type(root, 'stock-prep-project-sync-restore-input', PROJECT)
    await press(root, 'stock-prep-project-sync-restore-confirm')
    const refusal = testid(root, 'stock-prep-project-sync-restore-refused')
    expect(refusal?.dataset.result).toBe('refused')
    expect(refusal?.textContent).toContain(STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_PROJECT_NOT_ARCHIVED.zh)
    expect(refusal?.textContent).toContain('STOCK_PREPARATION_PROJECT_NOT_ARCHIVED')
    expect(log).toEqual(['target.get', 'target.restore'])
    expect(log).not.toContain('dryRun')
  })
})

// ---------------------------------------------------------------------------
// PA-COPY
// ---------------------------------------------------------------------------

describe('PA-COPY — the words', () => {
  it('the S2 placeholder 「恢复入口随后上线」 is gone; the lifecycle sentences exist in zh and en', () => {
    const all = JSON.stringify(STOCK_PREP_PROJECT_TARGET_PLAIN)
    expect(all).not.toContain('随后上线')
    expect(all.toLowerCase()).not.toContain('ships next')
    for (const key of ['archive_action', 'restore_action', 'restore_and_repull_action', 'confirm_archive', 'confirm_restore', 'confirm_type_project_no', 'confirm_archive_action', 'confirm_restore_action', 'confirm_lifecycle_cancel', 'archived_done', 'restored_done', 'remove_vs_archive', 'contact_puller_restore', 'restore_pending']) {
      const entry = STOCK_PREP_PROJECT_TARGET_PLAIN[key]
      expect(entry, key).toBeTruthy()
      expect(entry.zh.trim().length, `${key}.zh`).toBeGreaterThan(0)
      expect(entry.en.trim().length, `${key}.en`).toBeGreaterThan(0)
    }
  })

  it('every lifecycle refusal code is a member of the project-sheet code list and has its own two-line sentence', () => {
    for (const code of LIFECYCLE_CODES) {
      expect(STOCK_PREP_PROJECT_TARGET_ERROR_CODES).toContain(code)
      const entry = STOCK_PREP_ERROR_PLAIN[code]
      expect(entry, code).toBeTruthy()
      for (const key of ['zh', 'en', 'zhNext', 'enNext'] as const) {
        expect(String(entry[key] ?? '').trim().length, `${code}.${key}`).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// PA-ALIGN
// ---------------------------------------------------------------------------

describe('PA-ALIGN — rendered archive / restore controls equal granted capabilities', () => {
  const ACTORS: Array<{ name: string; roles: string[]; permissions: string[] }> = [
    { name: 'reader', roles: [], permissions: ['stock-prep:read'] },
    { name: 'floor', roles: [], permissions: [...FLOOR] },
    { name: 'puller', roles: [], permissions: [...PULLER] },
    { name: 'workbench-admin', roles: [], permissions: ['stock-prep:admin'] },
    { name: 'platform-admin', roles: ['admin'], permissions: ['integration:admin'] },
    { name: 'pull-orphan', roles: [], permissions: ['stock-prep:pull'] },
    { name: 'pull-without-operate', roles: [], permissions: ['stock-prep:read', 'stock-prep:pull'] },
  ]
  const LIFECYCLE_CAPABILITIES = ['projectTarget.archive', 'projectTarget.restore']

  /** The SERVER's grant (the plugin module itself), flattened the way the plugin flattens a principal. */
  function serverGranted(roles: readonly string[], permissions: readonly string[]): string[] {
    return backendAccess.grantedStockPrepCapabilities([...permissions, ...roles.map((role) => `role:${role}`)])
  }

  /** The GET answers as the server would for THIS actor: `may.*` from the plugin's own grant. */
  function gatedTargetApi(state: StockPrepProjectTargetState): StockPreparationProjectTargetApi {
    const granted = () => serverGranted(h.roles, h.permissions)
    return {
      get: vi.fn(async () => {
        if (!granted().includes('projectTarget.read')) throw new StockPreparationProjectTargetCallError(403, 'gate', { code: 'FORBIDDEN' })
        return {
          ...state,
          may: {
            create: false,
            archive: state.status === 'active' && granted().includes('projectTarget.archive'),
            restore: state.status === 'archived' && granted().includes('projectTarget.restore'),
          },
        }
      }),
      create: vi.fn(async () => { throw new Error('unexpected create') }),
      list: vi.fn(async () => ({ count: 0, limit: 200, items: [] })),
    }
  }

  it('the client rows for archive / restore are BYTE-EQUAL to the plugin module\'s (F-01 for these rows)', () => {
    const pick = (rows: readonly { capability: string }[]) => rows.filter((row) => LIFECYCLE_CAPABILITIES.includes(row.capability))
    const server = pick(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES)
    expect(server.map((row: { capability: string }) => row.capability)).toEqual(LIFECYCLE_CAPABILITIES)
    expect(JSON.stringify(pick(STOCK_PREP_WORKBENCH_CAPABILITIES))).toBe(JSON.stringify(server))
    expect(server.map((row: { code: string; control: string }) => [row.code, row.control])).toEqual([
      ['stock-prep:pull', 'stock-prep-project-target-archive'],
      ['stock-prep:pull', 'stock-prep-project-target-restore'],
    ])
  })

  it('archive (on an active sheet) and restore (on an archived one) render iff the SERVER grants them', async () => {
    let anyRendered = 0
    for (const actor of ACTORS) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      const granted = serverGranted(actor.roles, actor.permissions)
      // The client mirror agrees with the server for this actor.
      expect(grantedStockPrepCapabilities({ roles: actor.roles, permissions: actor.permissions }).filter((id) => LIFECYCLE_CAPABILITIES.includes(id)))
        .toEqual(granted.filter((id: string) => LIFECYCLE_CAPABILITIES.includes(id)))
      for (const [state, control, capability] of [
        [targetState(), 'stock-prep-project-target-archive', 'projectTarget.archive'],
        [ARCHIVED(), 'stock-prep-project-target-restore', 'projectTarget.restore'],
      ] as const) {
        routeBoardApi()
        const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: gatedTargetApi(state) })
        await flush()
        const rendered = testid(root, control) !== null
        expect(rendered, `${actor.name}: ${control}`).toBe(granted.includes(capability))
        if (rendered) anyRendered += 1
        unmountAll()
      }
    }
    // Anti-vacuity: puller, stock-prep:admin and the platform admin see both — 3 × 2.
    expect(anyRendered).toBe(6)
  })
})
