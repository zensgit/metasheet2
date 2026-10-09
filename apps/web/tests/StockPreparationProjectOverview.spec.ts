import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { createRequire } from 'node:module'

// 一个项目一张备料表 — S3 项目总览表 + 项目级列 (ADR adr-stock-prep-project-sheets-20261008 §5;
// register R-37).
//
//   PO-CLIENT  GET / PUT …/target/project-fields and POST …/project-overview/refresh: verbs, paths, the
//              scope query on the read only, the PUT body = ONLY the changed keys, the strict clamps, a
//              422's `details.field` clamped to the whitelist (never the value), DISABLED recognised, a
//              malformed 2xx never a state; the registry list's new `overview` handles and counts.
//   PO-MIRROR  the cross-language posture mirror: the web's `stockPrepPosture` and the plugin's
//              `projectOverviewPosture` (required live, the `*-vocab-mirror` precedent) agree on
//              key / zh / en / tone over a matrix of inputs — 「已归档」 first even with pending > 0.
//   PO-HOME    今天要处理: archived projects leave the main list for a collapsed 「已归档（N）」 section
//              (absent at N = 0); registry rows carry real postures (no 「看不到进度」 where the counts
//              decide); 「刷新项目总览」 (busy, result line, refusal line) and 「打开项目总览」 (the
//              overview's own handles, routed by the board as-is).
//   PO-BOARD   项目备料页's sheet-state line: the three project-level fields, read LAZILY (never on absent,
//              never with the switch off), 保存 sends ONLY what changed, 已保存, the archived read-only
//              line, and the 409 ARCHIVED / 422 INVALID (names the field, never the value) / DISABLED lines.
//   PO-QUERY   项目查询: the 「已归档」 tag, the independent 「含已归档」 toggle (default on, NOT a status key).
//   PO-ALIGN   the three new manifest controls render for EXACTLY the actors the SERVER grants (the plugin
//              module, imported live), on the surface they live on; the client rows are byte-equal to the
//              plugin's (F-01 for these rows).
//
// Synthetic, obviously-fake project numbers and texts only.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:read', 'stock-prep:operate'] as string[],
  roles: [] as string[],
  apiFetch: vi.fn(),
  routerReplace: vi.fn(),
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
  useRouter: () => ({ push: vi.fn(), replace: h.routerReplace }),
}))

import StockPreparationOperatorHome from '../src/components/integration/stockPreparation/StockPreparationOperatorHome.vue'
import StockPreparationProjectBoardView from '../src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue'
import StockPreparationProjectQueryView from '../src/components/integration/stockPreparation/StockPreparationProjectQueryView.vue'
import {
  STOCK_PREP_PROJECT_TARGET_ERROR_CODES,
  StockPreparationProjectTargetCallError,
  clampStockPrepProjectFieldsSaved,
  clampStockPrepProjectFieldsState,
  clampStockPrepProjectOverviewRefresh,
  clampStockPrepProjectTargetList,
  createStockPreparationProjectTargetApi,
  isStockPrepProjectSheetsDisabled,
  saveStockPreparationProjectFields,
  stockPrepProjectFieldsChangedPatch,
  stockPrepProjectFieldsDraft,
  type StockPrepProjectFieldsState,
  type StockPrepProjectOverviewRefreshResult,
  type StockPrepProjectTargetList,
  type StockPrepProjectTargetState,
  type StockPreparationProjectTargetApi,
} from '../src/services/integration/stockPreparation/projectTarget'
import { stockPrepPosture, type StockPrepPostureInput } from '../src/services/integration/stockPreparation/projectPosture'
import { buildOperatorHomeCards, partitionOperatorHomeCards } from '../src/services/integration/stockPreparation/operatorHomeCards'
import {
  STOCK_PREP_PROJECT_QUERY_STATUS_KEYS,
  buildStockPrepProjectQueryRows,
  filterStockPrepProjectQueryRows,
} from '../src/services/integration/stockPreparation/projectQuery'
import { STOCK_PREP_HOME_FILTER_KEYS } from '../src/services/integration/stockPreparation/operatorHomeCards'
import {
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_PROJECT_OVERVIEW_PLAIN,
  stockPrepClockText,
  stockPrepProjectOverviewRefreshText,
} from '../src/services/integration/stockPreparation/plainLanguage'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'
import type { StockPreparationOperatorDirectory } from '../src/services/integration/stockPreparation/confirmationQueue'

// The SERVER's own manifest, decision and posture, required live (the F-01 / `*-vocab-mirror` posture).
const nodeRequire = createRequire(import.meta.url)
const backendAccess = nodeRequire('../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs') as {
  STOCK_PREP_WORKBENCH_CAPABILITIES: ReadonlyArray<{ capability: string; code: string; method: string; path: string; control: string | null }>
  grantedStockPrepCapabilities: (principal: string[]) => string[]
}
const backendOverview = nodeRequire('../../../plugins/plugin-integration-core/lib/stock-preparation-project-overview.cjs') as {
  projectOverviewPosture: (input: Record<string, unknown>) => { key: string; zh: string; en: string; tone: string }
}

const SCOPE = { tenantId: 'tenant-syn-s3', workspaceId: 'workspace-syn-s3' }
const PROJECT = 'PRJ-SYN-S3-01'
const PROJECT_READY = 'PRJ-SYN-S3-02'
const PROJECT_UNSTAMPED = 'PRJ-SYN-S3-03'
const PROJECT_MVP_ONLY = 'PRJ-SYN-S3-04'
const PROJECT_ARCHIVED = 'PRJ-SYN-S3-09'
const SHEET = 'sheet_syn_project_s3'
const FILL_VIEW = 'view_syn_fill_s3'
const TODO_VIEW = 'view_syn_todo_s3'
const OVERVIEW_SHEET = 'sheet_syn_overview_s3'
const OVERVIEW_ACTIVE_VIEW = 'view_syn_overview_active_s3'
const OVERVIEW_ARCHIVED_VIEW = 'view_syn_overview_archived_s3'
const SYN_OWNER = '合成负责人甲'
const SYN_NOTE = '合成备注一'
const SYN_DAY = '2026-11-30'
const COUNTS_AT = '2026-10-09T06:07:00.000Z'

const FLOOR = ['stock-prep:read', 'stock-prep:operate']
const S3_CAPABILITIES = ['projectFields.read', 'projectFields.update', 'projectOverview.refresh']

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refused(status: number, code: string, details?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'synthetic refusal with a value 合成负责人甲', ...(details ? { details } : {}) } }), { status })
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
    may: { create: false, archive: false, restore: false },
    ...overrides,
  }
}

function fieldsState(status: 'active' | 'archived' = 'active', overrides: Partial<StockPrepProjectFieldsState> = {}): StockPrepProjectFieldsState {
  return {
    status,
    fields: { responsibleLabel: SYN_OWNER, note: SYN_NOTE, plannedFinishOn: SYN_DAY },
    updatedAt: '2026-10-09T05:00:00.000Z',
    may: { update: status === 'active' },
    ...overrides,
  }
}

function refreshResult(overrides: Partial<StockPrepProjectOverviewRefreshResult> = {}): StockPrepProjectOverviewRefreshResult {
  return {
    sheetId: OVERVIEW_SHEET,
    sheetCreated: true,
    activeViewId: OVERVIEW_ACTIVE_VIEW,
    archivedViewId: OVERVIEW_ARCHIVED_VIEW,
    projectCount: 3,
    countedCount: 3,
    unreadableCount: 0,
    boundedCount: 0,
    rowsCreated: 3,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    truncated: false,
    ledgerReady: true,
    countsAt: COUNTS_AT,
    ...overrides,
  }
}

function registryList(overview: Partial<NonNullable<StockPrepProjectTargetList['overview']>> = {}): StockPrepProjectTargetList {
  return {
    count: 1,
    limit: 200,
    items: [{ projectNo: PROJECT, status: 'active', sheetId: SHEET, rowCount: 12, activeRowCount: 10, countsBounded: false }],
    overview: { sheetId: null, activeViewId: null, archivedViewId: null, ...overview },
  }
}

function dirRow(projectNo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: null,
    projectNo,
    projectName: null,
    projectStatus: 'active',
    lastSyncRunId: null,
    snapshotBatchCount: 0,
    openExceptionCount: 0,
    heldLineCount: 0,
    readyLineCount: 0,
    pendingDecisionCount: 0,
    ...extra,
  }
}

/** Switch ON: registry rows carry `archived` / counts; one 「平台登记」-only row carries `archived: null`. */
function registryDirectory(): StockPreparationOperatorDirectory {
  return {
    tenantId: SCOPE.tenantId,
    directoryReady: true,
    ledgerReady: true,
    projectCount: 5,
    pendingProjectCount: 1,
    pullTargetReady: true,
    projects: [
      dirRow(PROJECT, { pendingDecisionCount: 2, archived: false, pulledRowCount: 12, missingComponentsCount: 0, sources: ['pull_target'] }),
      dirRow(PROJECT_READY, { archived: false, pulledRowCount: 40, missingComponentsCount: 0, sources: ['pull_target'] }),
      dirRow(PROJECT_UNSTAMPED, { archived: false, pulledRowCount: null, missingComponentsCount: null, sources: ['pull_target'] }),
      dirRow(PROJECT_MVP_ONLY, { projectId: 'p_syn_mvp', archived: null, pulledRowCount: null, missingComponentsCount: null, sources: ['mvp'] }),
      // Archived WITH a pending decision: 「已归档」 still wins.
      dirRow(PROJECT_ARCHIVED, { pendingDecisionCount: 1, archived: true, pulledRowCount: 30, missingComponentsCount: 0, sources: ['pull_target'] }),
    ],
  } as unknown as StockPreparationOperatorDirectory
}

/** Switch OFF: the S2 shape, no `archived` key anywhere. */
function legacyDirectory(): StockPreparationOperatorDirectory {
  return {
    tenantId: SCOPE.tenantId,
    directoryReady: true,
    ledgerReady: true,
    projectCount: 1,
    pendingProjectCount: 0,
    projects: [dirRow(PROJECT, { projectId: 'p_syn_1', sources: ['mvp'] })],
  } as unknown as StockPreparationOperatorDirectory
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

function testids(root: HTMLElement, id: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]
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
  return (testid(root, id) as HTMLButtonElement | HTMLInputElement | null)?.disabled === true
}

function callsOf(fragment: string): Array<{ path: string; method: string; body: unknown }> {
  return h.apiFetch.mock.calls
    .map(([path, init]) => ({ path: String(path), method: String((init as RequestInit | undefined)?.method ?? 'GET'), body: (init as RequestInit | undefined)?.body }))
    .filter((call) => call.path.includes(fragment))
}

/**
 * The board's API, switch ON, with the real project-target client: the plain directory, a board
 * 404, the sheet state, the registry list and the project-fields pair (answers configurable).
 */
function routeBoardApi(options: {
  target?: () => Response
  fieldsGet?: () => Response
  fieldsPut?: (body: unknown) => Response
  list?: () => Response
  directory?: () => Response
} = {}): void {
  h.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET')
    if (path.includes('/target/project-fields')) {
      if (method === 'PUT') return (options.fieldsPut ?? (() => refused(404, 'NOT_ROUTED_IN_THIS_SUITE')))(init?.body ? JSON.parse(String(init.body)) : null)
      return (options.fieldsGet ?? (() => ok(fieldsState())))()
    }
    if (path.includes('/project-targets')) return (options.list ?? (() => ok(registryList())))()
    if (path.includes('/operator/projects')) {
      return (options.directory ?? (() => ok({ tenantId: SCOPE.tenantId, directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] })))()
    }
    if (path.includes('/board')) return refused(404, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
    if (/\/projects\/[^/]+\/target(\?|$)/.test(path)) return (options.target ?? (() => ok({ projectNo: PROJECT, ...targetState() })))()
    return refused(404, 'NOT_ROUTED_IN_THIS_SUITE')
  })
}

beforeEach(() => {
  h.locale = 'zh-CN'
  h.permissions = [...FLOOR]
  h.roles = []
  h.apiFetch.mockReset()
  h.routerReplace.mockReset()
  resetStockPreparationOperatorHomeDirectoryThrottle()
  try { window.localStorage.clear() } catch { /* jsdom always has it */ }
})

afterEach(() => {
  unmountAll()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// PO-CLIENT
// ---------------------------------------------------------------------------

describe('PO-CLIENT — the project-fields and overview-refresh routes', () => {
  it('GET project-fields: the scope query, a strict clamp; `may.update` never true off an active sheet', async () => {
    h.apiFetch.mockImplementation(async () => ok({ projectNo: PROJECT, ...fieldsState() }))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    const state = await api.getProjectFields!(PROJECT)
    expect(state).toEqual(fieldsState())
    expect(callsOf('/project-fields')).toEqual([{
      path: `/api/integration/stock-preparation/projects/${PROJECT}/target/project-fields?tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`,
      method: 'GET',
      body: undefined,
    }])
    // Absent: fields null. Archived: `may.update` forced false whatever the payload says.
    expect(clampStockPrepProjectFieldsState({ status: 'absent', fields: null, updatedAt: null, may: { update: false } }))
      .toEqual({ status: 'absent', fields: null, updatedAt: null, may: { update: false } })
    expect(clampStockPrepProjectFieldsState({ ...fieldsState('archived'), may: { update: true } })?.may.update).toBe(false)
    // Strict: an unknown status, a non-boolean `may.update`, or an existing sheet without fields is not a state.
    expect(clampStockPrepProjectFieldsState({ ...fieldsState(), status: 'deleted' })).toBeNull()
    expect(clampStockPrepProjectFieldsState({ ...fieldsState(), may: { update: 'yes' } })).toBeNull()
    expect(clampStockPrepProjectFieldsState({ ...fieldsState(), fields: null })).toBeNull()
    // A malformed day is not a day; an over-long text is not the text.
    expect(clampStockPrepProjectFieldsState({ ...fieldsState(), fields: { responsibleLabel: 'x'.repeat(81), note: null, plannedFinishOn: '30/11/2026' } })?.fields)
      .toEqual({ responsibleLabel: null, note: null, plannedFinishOn: null })
  })

  it('PUT project-fields: NO query, the body carries ONLY the keys in the patch (trimmed; empty = null)', async () => {
    h.apiFetch.mockImplementation(async () => ok({ projectNo: PROJECT, status: 'active', fields: { responsibleLabel: SYN_OWNER, note: 'n2', plannedFinishOn: null }, updatedAt: '2026-10-09T05:30:00.000Z', changed: ['note', 'plannedFinishOn'] }))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    const saved = await api.updateProjectFields!(PROJECT, { note: '  n2 ', plannedFinishOn: '' })
    expect(saved).toEqual({ status: 'active', fields: { responsibleLabel: SYN_OWNER, note: 'n2', plannedFinishOn: null }, updatedAt: '2026-10-09T05:30:00.000Z', changed: ['note', 'plannedFinishOn'] })
    await api.updateProjectFields!(PROJECT, { responsibleLabel: SYN_OWNER })
    // A key outside the whitelist never leaves the browser.
    await api.updateProjectFields!(PROJECT, { note: null, sneaky: 'x' } as never)
    expect(callsOf('/project-fields')).toEqual([
      { path: `/api/integration/stock-preparation/projects/${PROJECT}/target/project-fields`, method: 'PUT', body: JSON.stringify({ note: 'n2', plannedFinishOn: null }) },
      { path: `/api/integration/stock-preparation/projects/${PROJECT}/target/project-fields`, method: 'PUT', body: JSON.stringify({ responsibleLabel: SYN_OWNER }) },
      { path: `/api/integration/stock-preparation/projects/${PROJECT}/target/project-fields`, method: 'PUT', body: JSON.stringify({ note: null }) },
    ])
    // The write only ever lands on an ACTIVE sheet; `changed` is clamped to the whitelist.
    expect(clampStockPrepProjectFieldsSaved({ status: 'archived', fields: {}, changed: [] })).toBeNull()
    expect(clampStockPrepProjectFieldsSaved({ status: 'active', fields: {}, changed: ['note', 'evil'] })?.changed).toEqual(['note'])
  })

  it('the patch is ONLY what changed — an untouched field is never sent, so a save cannot overwrite a colleague\'s column', async () => {
    const original = { responsibleLabel: SYN_OWNER, note: SYN_NOTE, plannedFinishOn: SYN_DAY }
    const draft = stockPrepProjectFieldsDraft(original)
    expect(stockPrepProjectFieldsChangedPatch(original, draft)).toEqual({})
    expect(stockPrepProjectFieldsChangedPatch(original, { ...draft, note: ` ${SYN_NOTE}  ` })).toEqual({})
    expect(stockPrepProjectFieldsChangedPatch(original, { ...draft, note: 'n2' })).toEqual({ note: 'n2' })
    expect(stockPrepProjectFieldsChangedPatch(original, { ...draft, plannedFinishOn: '' })).toEqual({ plannedFinishOn: null })
    expect(stockPrepProjectFieldsChangedPatch(null, { responsibleLabel: 'a', note: '', plannedFinishOn: '' })).toEqual({ responsibleLabel: 'a' })
    // Unchanged → NOTHING is sent.
    const update = vi.fn()
    const outcome = await saveStockPreparationProjectFields({ updateProjectFields: update } as unknown as StockPreparationProjectTargetApi, PROJECT, original, draft)
    expect(outcome).toEqual({ kind: 'unchanged' })
    expect(update).not.toHaveBeenCalled()
  })

  it('POST refresh: NO query, an empty body, a strict clamp; a malformed 2xx is malformed, never a result', async () => {
    h.apiFetch.mockImplementation(async () => ok(refreshResult()))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    expect(await api.refreshOverview!()).toEqual(refreshResult())
    expect(callsOf('/project-overview')).toEqual([{ path: '/api/integration/stock-preparation/project-overview/refresh', method: 'POST', body: '{}' }])
    expect(clampStockPrepProjectOverviewRefresh({ ...refreshResult(), sheetId: null })).toBeNull()
    expect(clampStockPrepProjectOverviewRefresh({ ...refreshResult(), countsAt: 'not a time' })).toBeNull()
    expect(clampStockPrepProjectOverviewRefresh({ ...refreshResult(), truncated: 'no' })).toBeNull()
    h.apiFetch.mockImplementation(async () => ok({}))
    const malformed = await api.refreshOverview!().catch((caught) => caught)
    expect((malformed as StockPreparationProjectTargetCallError).malformed).toBe(true)
  })

  it('all three answer the switch-off 404 as DISABLED; a 422 names the FIELD (whitelisted) and never carries the value', async () => {
    h.apiFetch.mockImplementation(async () => refused(404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED'))
    const api = createStockPreparationProjectTargetApi(SCOPE)
    for (const call of [() => api.getProjectFields!(PROJECT), () => api.updateProjectFields!(PROJECT, { note: 'x' }), () => api.refreshOverview!()]) {
      const error = await call().catch((caught) => caught)
      expect(isStockPrepProjectSheetsDisabled(error)).toBe(true)
    }
    h.apiFetch.mockImplementation(async () => refused(422, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID', { field: 'plannedFinishOn' }))
    const invalid = await api.updateProjectFields!(PROJECT, { plannedFinishOn: '2026-02-30' }).catch((caught) => caught) as StockPreparationProjectTargetCallError
    expect([invalid.status, invalid.code, invalid.field]).toEqual([422, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID', 'plannedFinishOn'])
    expect(invalid.message).not.toContain(SYN_OWNER)
    expect(invalid.message).not.toContain('2026-02-30')
    h.apiFetch.mockImplementation(async () => refused(422, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID', { field: 'password' }))
    const foreign = await api.updateProjectFields!(PROJECT, { note: 'x' }).catch((caught) => caught) as StockPreparationProjectTargetCallError
    expect(foreign.field).toBeNull()
  })

  it('the registry list gains `overview` handles and the per-item counts — tolerant of an older server', () => {
    const list = clampStockPrepProjectTargetList({
      items: [{ projectNo: PROJECT, status: 'active', sheetId: SHEET, rowCount: 12, activeRowCount: 10, countsBounded: false, missingComponentsCount: 2, procurementOpenCount: 5, warehouseOpenCount: 7, lastPullCode: 'TARGET_SCHEMA_INCOMPLETE' }],
      limit: 200,
      overview: { sheetId: OVERVIEW_SHEET, activeViewId: OVERVIEW_ACTIVE_VIEW, archivedViewId: OVERVIEW_ARCHIVED_VIEW },
    })!
    expect(list.overview).toEqual({ sheetId: OVERVIEW_SHEET, activeViewId: OVERVIEW_ACTIVE_VIEW, archivedViewId: OVERVIEW_ARCHIVED_VIEW })
    expect(list.items[0]).toMatchObject({ missingComponentsCount: 2, procurementOpenCount: 5, warehouseOpenCount: 7, lastPullCode: 'TARGET_SCHEMA_INCOMPLETE' })
    const older = clampStockPrepProjectTargetList({ items: [{ projectNo: PROJECT, status: 'active', sheetId: SHEET }], limit: 200 })!
    expect(older.overview).toEqual({ sheetId: null, activeViewId: null, archivedViewId: null })
    expect(older.items[0]).toMatchObject({ missingComponentsCount: null, procurementOpenCount: null, warehouseOpenCount: null, lastPullCode: null })
  })

  it('every S3 refusal code is in the project-sheet code list and has its own two-line zh + en sentence', () => {
    for (const code of [
      'STOCK_PREPARATION_PROJECT_FIELDS_INVALID',
      'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED',
      'STOCK_PREPARATION_PROJECT_OVERVIEW_SCHEMA_INCOMPLETE',
      'STOCK_PREPARATION_PROJECT_OVERVIEW_PROVISIONING_UNAVAILABLE',
    ]) {
      expect(STOCK_PREP_PROJECT_TARGET_ERROR_CODES).toContain(code)
      const entry = STOCK_PREP_ERROR_PLAIN[code]
      expect(entry, code).toBeTruthy()
      expect(entry).not.toBe(STOCK_PREP_ERROR_GENERIC)
      for (const key of ['zh', 'en', 'zhNext', 'enNext'] as const) {
        expect(String(entry[key] ?? '').trim().length, `${code}.${key}`).toBeGreaterThan(0)
      }
    }
    // The archived lines never say the grid is frozen (S4 fix round 1 holds for S3's words too).
    for (const key of ['fields_archived_readonly', 'fields_archived_refused'] as const) {
      const entry = STOCK_PREP_PROJECT_OVERVIEW_PLAIN[key]
      expect(`${entry.zh}${entry.zhNext ?? ''}`, key).toContain('填写')
      expect(`${entry.en}${entry.enNext ?? ''}`.toLowerCase(), key).toContain('fill')
    }
  })
})

// ---------------------------------------------------------------------------
// PO-COPY — the refresh result line, counts only
// ---------------------------------------------------------------------------

describe('PO-COPY — the refresh result line', () => {
  it('「已刷新 N 个项目（截至 hh:mm）」, plus the unreadable and truncated clauses only when they apply', () => {
    const clock = stockPrepClockText(COUNTS_AT)
    expect(stockPrepProjectOverviewRefreshText({ projectCount: 7, unreadableCount: 0, truncated: false, countsAt: COUNTS_AT }))
      .toEqual({ zh: `已刷新 7 个项目（截至 ${clock}）。`, en: `Refreshed 7 project(s) (as of ${clock}).` })
    const both = stockPrepProjectOverviewRefreshText({ projectCount: 200, unreadableCount: 2, truncated: true, countsAt: COUNTS_AT })
    expect(both.zh).toContain('其中 2 个项目的表这次没读到')
    expect(both.zh).toContain(STOCK_PREP_PROJECT_OVERVIEW_PLAIN.overview_truncated.zh)
    expect(both.en).toContain(STOCK_PREP_PROJECT_OVERVIEW_PLAIN.overview_truncated.en)
    expect(stockPrepProjectOverviewRefreshText({ projectCount: 1, unreadableCount: null, truncated: false, countsAt: 'not a time' }).zh).toBe('已刷新 1 个项目。')
  })
})

// ---------------------------------------------------------------------------
// PO-MIRROR
// ---------------------------------------------------------------------------

describe('PO-MIRROR — the web posture and the plugin\'s `projectOverviewPosture` are the same predicate', () => {
  const MATRIX: StockPrepPostureInput[] = [
    { archived: true, pendingDecisionCount: 3 },
    { archived: true, pendingDecisionCount: 1, missingComponentsCount: 2, pulledRowCount: 10 },
    { archived: true, missingComponentsCount: 2 },
    { archived: true, pulledRowCount: 10 },
    { archived: true },
    { archived: false, pendingDecisionCount: 1 },
    { pendingDecisionCount: 5, missingComponentsCount: 2, pulledRowCount: 9 },
    { pendingDecisionCount: 12 },
    { missingComponentsCount: 1 },
    { archived: false, missingComponentsCount: 4, pulledRowCount: 20 },
    { pulledRowCount: 1 },
    { archived: false, pulledRowCount: 1200 },
    { pendingDecisionCount: 0, missingComponentsCount: 0, pulledRowCount: 7 },
    {},
    { archived: false, pendingDecisionCount: 0, missingComponentsCount: 0, pulledRowCount: 0 },
    { archived: false },
  ]

  it('drives both with the same inputs and asserts key / zh / en / tone equal', () => {
    expect(MATRIX.length).toBeGreaterThanOrEqual(12)
    const keys = new Set<string>()
    for (const input of MATRIX) {
      const web = stockPrepPosture(input)
      const server = backendOverview.projectOverviewPosture({ ...input })
      const pick = (p: { key: string; zh: string; en: string; tone: string }) => ({ key: p.key, zh: p.zh, en: p.en, tone: p.tone })
      expect(pick(web), JSON.stringify(input)).toEqual(pick(server))
      keys.add(web.key)
    }
    // Anti-vacuity: the matrix reaches all five overview states.
    expect([...keys].sort()).toEqual(['archived', 'blocked', 'not_pulled', 'pending_decision', 'ready'])
  })

  it('「已归档」 comes FIRST — even over a pending decision, on both sides', () => {
    const input = { archived: true, pendingDecisionCount: 4, missingComponentsCount: 3, pulledRowCount: 2 }
    expect(stockPrepPosture(input)).toEqual({ key: 'archived', zh: '已归档', en: 'Archived', tone: 'neutral' })
    expect(backendOverview.projectOverviewPosture(input)).toEqual({ key: 'archived', zh: '已归档', en: 'Archived', tone: 'neutral' })
  })
})

// ---------------------------------------------------------------------------
// PO-HOME
// ---------------------------------------------------------------------------

describe('PO-HOME — 今天要处理: the archived section, real postures, 刷新 / 打开项目总览', () => {
  it('registry rows carry real postures; the archived one leaves the main list; an unstamped row stays honest', () => {
    const cards = buildOperatorHomeCards(registryDirectory().projects, [])
    const byNo = Object.fromEntries(cards.map((card) => [card.projectNo, card]))
    expect(byNo[PROJECT].posture.key).toBe('pending_decision')
    expect(byNo[PROJECT_READY].posture.key).toBe('ready')
    expect(byNo[PROJECT_READY].postureFromMemory).toBe(false)
    // Counts not stamped yet (null): neither 「还没拉过」 nor 「可以导出」 can be claimed.
    expect(byNo[PROJECT_UNSTAMPED].posture.key).toBe('unknown')
    expect(byNo[PROJECT_MVP_ONLY].posture.key).toBe('unknown')
    expect(byNo[PROJECT_ARCHIVED].posture.key).toBe('archived')
    expect(byNo[PROJECT_ARCHIVED].archived).toBe(true)
    const { active, archived } = partitionOperatorHomeCards(cards)
    expect(archived.map((card) => card.projectNo)).toEqual([PROJECT_ARCHIVED])
    expect(active.map((card) => card.projectNo)).not.toContain(PROJECT_ARCHIVED)
    // Switch off: the S2 merge, untouched — no `archived` anywhere, `unknown` as before.
    const legacy = buildOperatorHomeCards(legacyDirectory().projects, [])
    expect(legacy.map((card) => [card.posture.key, card.archived])).toEqual([['unknown', false]])
  })

  it('the main list excludes archived; 「已归档（N）」 is collapsed below it, each row tagged 「已归档」', async () => {
    const root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory: registryDirectory(), directoryLoaded: true, projectTargets: registryList() })
    await flush()
    const mainNos = testids(root, 'stock-prep-operator-home-card').map((card) => card.dataset.projectNo)
    expect(mainNos).not.toContain(PROJECT_ARCHIVED)
    expect(mainNos).toContain(PROJECT)
    const section = testid(root, 'stock-prep-operator-home-archived') as HTMLDetailsElement | null
    expect(section).not.toBeNull()
    expect(section!.tagName).toBe('DETAILS')
    expect(section!.open, 'collapsed by default').toBe(false)
    expect(testid(root, 'stock-prep-operator-home-archived-summary')?.textContent?.trim()).toBe('已归档（1）')
    const archivedRows = testids(root, 'stock-prep-operator-home-archived-card')
    expect(archivedRows.map((row) => row.dataset.projectNo)).toEqual([PROJECT_ARCHIVED])
    expect(testid(archivedRows[0], 'stock-prep-operator-home-archived-tag')?.textContent?.trim()).toBe('已归档')
    // The five chips count the MAIN list only: 「全部」 = 4, not 5.
    expect(testid(root, 'stock-prep-operator-home-filter-all')?.textContent).toContain('4')
  })

  it('no archived project → no archived section at all; English heading reads "Archived (N)"', async () => {
    let root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory: legacyDirectory(), directoryLoaded: true })
    await flush()
    expect(testid(root, 'stock-prep-operator-home-archived')).toBeNull()
    unmountAll()
    h.locale = 'en-US'
    root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory: registryDirectory(), directoryLoaded: true })
    await flush()
    expect(testid(root, 'stock-prep-operator-home-archived-summary')?.textContent?.trim()).toBe('Archived (1)')
  })

  it('a tenant whose every project is archived is not told 「这里还没有您的项目」', async () => {
    const directory = { ...registryDirectory(), projects: [dirRow(PROJECT_ARCHIVED, { archived: true, pulledRowCount: 3, missingComponentsCount: 0 })] }
    const root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory, directoryLoaded: true })
    await flush()
    expect(testid(root, 'stock-prep-operator-home-empty')?.dataset.emptyState).not.toBe('no_projects')
    expect(testid(root, 'stock-prep-operator-home-archived')).not.toBeNull()
  })

  it('刷新项目总览: busy while in flight, then 「已刷新 N 个项目（截至 hh:mm）」; the open link follows the refresh', async () => {
    let resolveRefresh: (value: StockPrepProjectOverviewRefreshResult) => void = () => undefined
    const refreshOverview = vi.fn(() => new Promise<StockPrepProjectOverviewRefreshResult>((resolve) => { resolveRefresh = resolve }))
    const onOverviewRefreshed = vi.fn()
    const onOpenMultitable = vi.fn()
    const root = mount(StockPreparationOperatorHome as Component, {
      scope: SCOPE, directory: legacyDirectory(), directoryLoaded: true, projectTargets: registryList(),
      canRefreshOverview: true, targetApi: { refreshOverview } as unknown as StockPreparationProjectTargetApi,
      onOverviewRefreshed, onOpenMultitable,
    })
    await flush()
    // No handles yet (never refreshed) → no open link.
    expect(testid(root, 'stock-prep-project-overview-open')).toBeNull()
    ;(testid(root, 'stock-prep-project-overview-refresh') as HTMLButtonElement).click()
    await nextTick()
    expect(disabled(root, 'stock-prep-project-overview-refresh')).toBe(true)
    expect(testid(root, 'stock-prep-project-overview-refresh')?.textContent).toContain('正在刷新')
    ;(testid(root, 'stock-prep-project-overview-refresh') as HTMLButtonElement).click()
    expect(refreshOverview).toHaveBeenCalledTimes(1)
    resolveRefresh(refreshResult())
    await flush()
    expect(disabled(root, 'stock-prep-project-overview-refresh')).toBe(false)
    const clock = stockPrepClockText(COUNTS_AT)!
    expect(clock).toMatch(/^\d{2}:\d{2}$/)
    const result = testid(root, 'stock-prep-project-overview-result')
    expect(result?.dataset.result).toBe('done')
    expect(result?.textContent).toContain(`已刷新 3 个项目（截至 ${clock}）`)
    expect(onOverviewRefreshed).toHaveBeenCalledWith(refreshResult())
    await press(root, 'stock-prep-project-overview-open')
    expect(onOpenMultitable).toHaveBeenCalledWith({ sheetId: OVERVIEW_SHEET, viewId: OVERVIEW_ACTIVE_VIEW })
  })

  it('a refused refresh shows the refusal\'s own plain line and code; DISABLED reads as the switch-off sentence', async () => {
    for (const [code, status] of [['STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED', 409], ['STOCK_PREPARATION_PROJECT_SHEETS_DISABLED', 404]] as const) {
      const refreshOverview = vi.fn(async () => { throw new StockPreparationProjectTargetCallError(status, 'POST', { code }) })
      const root = mount(StockPreparationOperatorHome as Component, {
        scope: SCOPE, directory: legacyDirectory(), directoryLoaded: true, projectTargets: registryList(),
        canRefreshOverview: true, targetApi: { refreshOverview } as unknown as StockPreparationProjectTargetApi,
      })
      await flush()
      await press(root, 'stock-prep-project-overview-refresh')
      const result = testid(root, 'stock-prep-project-overview-result')
      expect(result?.dataset.result, code).toBe('refused')
      expect(result?.textContent, code).toContain(STOCK_PREP_ERROR_PLAIN[code].zh)
      expect(result?.textContent, code).toContain(code)
      unmountAll()
    }
  })

  it('the open link renders from the list\'s handles only when BOTH are present; nothing renders with the switch off', async () => {
    const onOpenMultitable = vi.fn()
    let root = mount(StockPreparationOperatorHome as Component, {
      scope: SCOPE, directory: legacyDirectory(), directoryLoaded: true,
      projectTargets: registryList({ sheetId: OVERVIEW_SHEET, activeViewId: OVERVIEW_ACTIVE_VIEW, archivedViewId: OVERVIEW_ARCHIVED_VIEW }),
      onOpenMultitable,
    })
    await flush()
    // A floor operator WITHOUT the refresh right still gets the link (a deep link grants nothing).
    expect(testid(root, 'stock-prep-project-overview-refresh')).toBeNull()
    await press(root, 'stock-prep-project-overview-open')
    expect(onOpenMultitable).toHaveBeenCalledWith({ sheetId: OVERVIEW_SHEET, viewId: OVERVIEW_ACTIVE_VIEW })
    unmountAll()
    root = mount(StockPreparationOperatorHome as Component, {
      scope: SCOPE, directory: legacyDirectory(), directoryLoaded: true, projectTargets: registryList({ sheetId: OVERVIEW_SHEET }),
    })
    await flush()
    expect(testid(root, 'stock-prep-project-overview-open')).toBeNull()
    unmountAll()
    root = mount(StockPreparationOperatorHome as Component, { scope: SCOPE, directory: legacyDirectory(), directoryLoaded: true, canRefreshOverview: true })
    await flush()
    expect(testid(root, 'stock-prep-project-overview-refresh')).toBeNull()
    expect(testid(root, 'stock-prep-project-overview-open')).toBeNull()
  })

  it('the board routes 「打开项目总览」 as-is and 「打开备料多维表」 through its fill-target resolver, unchanged', async () => {
    const list = registryList({ sheetId: OVERVIEW_SHEET, activeViewId: OVERVIEW_ACTIVE_VIEW, archivedViewId: OVERVIEW_ARCHIVED_VIEW })
    const targetApi = {
      get: vi.fn(async () => targetState()),
      create: vi.fn(async () => { throw new Error('unexpected create') }),
      list: vi.fn(async () => list),
    } as StockPreparationProjectTargetApi
    routeBoardApi({ directory: () => ok({ ...legacyDirectory(), fillTarget: { sheetId: 'sheet_syn_env', viewId: 'view_syn_env' } }) })
    const onOpenMultitable = vi.fn()
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectTargetApi: targetApi, onOpenMultitable })
    await flush()
    await press(root, 'stock-prep-project-overview-open')
    expect(onOpenMultitable).toHaveBeenLastCalledWith({ sheetId: OVERVIEW_SHEET, viewId: OVERVIEW_ACTIVE_VIEW })
    await press(root, 'stock-prep-operator-home-open-multitable')
    expect(onOpenMultitable).toHaveBeenLastCalledWith({ sheetId: 'sheet_syn_env', viewId: 'view_syn_env' })
  })
})

// ---------------------------------------------------------------------------
// PO-BOARD
// ---------------------------------------------------------------------------

describe('PO-BOARD — 项目备料页\'s project-level fields', () => {
  it('active: the three fields render; 保存 is disabled until something changes and then sends ONLY that key', async () => {
    let putBody: unknown = null
    routeBoardApi({
      fieldsPut: (body) => {
        putBody = body
        return ok({ projectNo: PROJECT, status: 'active', fields: { responsibleLabel: SYN_OWNER, note: 'n2', plannedFinishOn: SYN_DAY }, updatedAt: '2026-10-09T05:30:00.000Z', changed: ['note'] })
      },
    })
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    const form = testid(root, 'stock-prep-project-fields')
    expect(form?.dataset.fieldsStatus).toBe('active')
    expect((testid(root, 'stock-prep-project-fields-responsible') as HTMLInputElement).value).toBe(SYN_OWNER)
    expect((testid(root, 'stock-prep-project-fields-note') as HTMLInputElement).value).toBe(SYN_NOTE)
    expect((testid(root, 'stock-prep-project-fields-planned-finish') as HTMLInputElement).value).toBe(SYN_DAY)
    expect(disabled(root, 'stock-prep-project-fields-save'), 'nothing changed yet').toBe(true)
    await type(root, 'stock-prep-project-fields-note', 'n2')
    expect(disabled(root, 'stock-prep-project-fields-save')).toBe(false)
    await press(root, 'stock-prep-project-fields-save')
    expect(putBody).toEqual({ note: 'n2' })
    expect(callsOf('/project-fields').filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([JSON.stringify({ note: 'n2' })])
    const result = testid(root, 'stock-prep-project-fields-result')
    expect(result?.dataset.result).toBe('saved')
    expect(result?.textContent).toContain('已保存')
    expect(disabled(root, 'stock-prep-project-fields-save'), 'saved = nothing left to save').toBe(true)
  })

  it('LAZY: no fields read on an absent sheet, nor with the switch off', async () => {
    routeBoardApi({ target: () => ok({ projectNo: PROJECT, ...targetState({ status: 'absent', sheetId: null, viewId: null, todoViewId: null, rowCount: null, activeRowCount: null, rowCountBounded: null }) }) })
    let root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('absent')
    expect(testid(root, 'stock-prep-project-fields')).toBeNull()
    expect(callsOf('/project-fields')).toEqual([])
    unmountAll()
    h.apiFetch.mockReset()
    routeBoardApi({ target: () => refused(404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED') })
    root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')).toBeNull()
    expect(testid(root, 'stock-prep-project-fields')).toBeNull()
    expect(callsOf('/project-fields')).toEqual([])
  })

  it('archived: read-only with 「已归档，不能改」, no 保存', async () => {
    routeBoardApi({
      target: () => ok({ projectNo: PROJECT, ...targetState({ status: 'archived', archivedAt: '2026-10-09T00:00:00.000Z' }) }),
      fieldsGet: () => ok({ projectNo: PROJECT, ...fieldsState('archived') }),
    })
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    expect(testid(root, 'stock-prep-project-fields')?.dataset.fieldsStatus).toBe('archived')
    expect(testid(root, 'stock-prep-project-fields-save')).toBeNull()
    for (const id of ['stock-prep-project-fields-responsible', 'stock-prep-project-fields-note', 'stock-prep-project-fields-planned-finish']) {
      expect(disabled(root, id), id).toBe(true)
    }
    expect(testid(root, 'stock-prep-project-fields-archived')?.textContent).toContain('已归档，不能改')
  })

  it('active, but the server says `may.update: false`: read-only, no 保存 — the page never offers a write the server declined', async () => {
    routeBoardApi({ fieldsGet: () => ok({ projectNo: PROJECT, ...fieldsState('active'), may: { update: false } }) })
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    expect(testid(root, 'stock-prep-project-fields')?.dataset.fieldsStatus).toBe('active')
    expect(testid(root, 'stock-prep-project-fields-save')).toBeNull()
    expect(disabled(root, 'stock-prep-project-fields-note')).toBe(true)
  })

  it('422 names the FIELD and never echoes the value; 409 ARCHIVED and DISABLED each get their own line', async () => {
    const TYPED = '2026-02-30'
    for (const [answer, expectZh, field] of [
      [() => refused(422, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID', { field: 'plannedFinishOn' }), STOCK_PREP_PROJECT_OVERVIEW_PLAIN.fields_invalid_plannedFinishOn.zh, 'plannedFinishOn'],
      [() => refused(409, 'STOCK_PREPARATION_PROJECT_ARCHIVED'), STOCK_PREP_PROJECT_OVERVIEW_PLAIN.fields_archived_refused.zh, ''],
      [() => refused(404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED'), STOCK_PREP_ERROR_PLAIN.STOCK_PREPARATION_PROJECT_SHEETS_DISABLED.zh, ''],
    ] as const) {
      h.apiFetch.mockReset()
      routeBoardApi({ fieldsPut: answer })
      const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
      await flush()
      await type(root, 'stock-prep-project-fields-planned-finish', TYPED)
      ;(testid(root, 'stock-prep-project-fields-save') as HTMLButtonElement).click()
      await flush()
      const result = testid(root, 'stock-prep-project-fields-result')
      expect(result?.dataset.result, expectZh).toBe('refused')
      expect(result?.dataset.field, expectZh).toBe(field)
      expect(result?.textContent, expectZh).toContain(expectZh)
      expect(result?.textContent, 'never the value').not.toContain(TYPED)
      unmountAll()
    }
  })

  it('a 409 ARCHIVED on save re-reads the sheet state, and the form follows it to read-only', async () => {
    let archived = false
    routeBoardApi({
      target: () => ok({ projectNo: PROJECT, ...targetState(archived ? { status: 'archived' } : {}) }),
      fieldsGet: () => ok({ projectNo: PROJECT, ...fieldsState(archived ? 'archived' : 'active') }),
      fieldsPut: () => { archived = true; return refused(409, 'STOCK_PREPARATION_PROJECT_ARCHIVED') },
    })
    const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT })
    await flush()
    await type(root, 'stock-prep-project-fields-note', 'n3')
    await press(root, 'stock-prep-project-fields-save')
    await flush()
    expect(testid(root, 'stock-prep-project-target-status')?.dataset.targetStatus).toBe('archived')
    expect(testid(root, 'stock-prep-project-fields')?.dataset.fieldsStatus).toBe('archived')
    expect(testid(root, 'stock-prep-project-fields-save')).toBeNull()
    expect(testid(root, 'stock-prep-project-fields-result')?.textContent).toContain(STOCK_PREP_PROJECT_OVERVIEW_PLAIN.fields_archived_refused.zh)
  })
})

// ---------------------------------------------------------------------------
// PO-QUERY
// ---------------------------------------------------------------------------

describe('PO-QUERY — 项目查询: 「已归档」 tag and the independent 「含已归档」 toggle', () => {
  it('the status keys stay the home page\'s five — 含已归档 is not one of them', () => {
    expect([...STOCK_PREP_PROJECT_QUERY_STATUS_KEYS]).toEqual([...STOCK_PREP_HOME_FILTER_KEYS])
    expect([...STOCK_PREP_PROJECT_QUERY_STATUS_KEYS]).toEqual(['all', 'pending_decision', 'blocked', 'ready', 'not_pulled'])
    const rows = buildStockPrepProjectQueryRows(registryDirectory(), [])
    expect(rows.find((row) => row.projectNo === PROJECT_ARCHIVED)?.archived).toBe(true)
    const base = { status: 'all' as const, source: 'all' as const, search: '' }
    expect(filterStockPrepProjectQueryRows(rows, base).map((row) => row.projectNo)).toContain(PROJECT_ARCHIVED)
    expect(filterStockPrepProjectQueryRows(rows, { ...base, includeArchived: true }).length).toBe(rows.length)
    expect(filterStockPrepProjectQueryRows(rows, { ...base, includeArchived: false }).map((row) => row.projectNo)).not.toContain(PROJECT_ARCHIVED)
  })

  it('switch on: the archived row is tagged; the toggle defaults ON and hides it when turned off', async () => {
    h.apiFetch.mockImplementation(async (path: string) => (path.includes('/operator/projects') ? ok(registryDirectory()) : refused(404, 'NOT_ROUTED_IN_THIS_SUITE')))
    const root = mount(StockPreparationProjectQueryView as Component, { scope: SCOPE })
    await flush()
    const toggle = testid(root, 'stock-prep-project-query-include-archived') as HTMLInputElement | null
    expect(toggle).not.toBeNull()
    expect(toggle!.checked, 'default ON').toBe(true)
    const archivedRow = testids(root, 'stock-prep-project-query-row').find((row) => row.dataset.projectNo === PROJECT_ARCHIVED)
    expect(archivedRow).toBeTruthy()
    expect(testid(archivedRow!, 'stock-prep-project-query-archived-tag')?.textContent?.trim()).toBe('已归档')
    expect(testid(archivedRow!, 'stock-prep-project-query-row-badge')).toBeNull()
    expect(testids(root, 'stock-prep-project-query-archived-tag').length).toBe(1)
    // The 「平台登记」 wording for the mvp source is kept (Q8).
    const mvpRow = testids(root, 'stock-prep-project-query-row').find((row) => row.dataset.projectNo === PROJECT_MVP_ONLY)
    expect(testid(mvpRow!, 'stock-prep-project-query-row-source')?.textContent).toContain('平台登记')
    toggle!.checked = false
    toggle!.dispatchEvent(new Event('change'))
    await flush()
    expect(testids(root, 'stock-prep-project-query-row').map((row) => row.dataset.projectNo)).not.toContain(PROJECT_ARCHIVED)
    expect(testids(root, 'stock-prep-project-query-row').length).toBe(4)
    // A session-local bit: it never writes the URL.
    expect(h.routerReplace).not.toHaveBeenCalled()
  })

  it('switch off (no `archived` key): no toggle, no tag', async () => {
    h.apiFetch.mockImplementation(async (path: string) => (path.includes('/operator/projects') ? ok(legacyDirectory()) : refused(404, 'NOT_ROUTED_IN_THIS_SUITE')))
    const root = mount(StockPreparationProjectQueryView as Component, { scope: SCOPE })
    await flush()
    expect(testids(root, 'stock-prep-project-query-row').length).toBe(1)
    expect(testid(root, 'stock-prep-project-query-include-archived')).toBeNull()
    expect(testid(root, 'stock-prep-project-query-archived-tag')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PO-ALIGN
// ---------------------------------------------------------------------------

describe('PO-ALIGN — rendered S3 controls equal granted capabilities', () => {
  const ACTORS: Array<{ name: string; roles: string[]; permissions: string[] }> = [
    { name: 'reader', roles: [], permissions: ['stock-prep:read'] },
    { name: 'floor', roles: [], permissions: [...FLOOR] },
    { name: 'puller', roles: [], permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] },
    { name: 'workbench-admin', roles: [], permissions: ['stock-prep:admin'] },
    { name: 'platform-admin', roles: ['admin'], permissions: ['integration:admin'] },
    { name: 'pull-orphan', roles: [], permissions: ['stock-prep:pull'] },
    { name: 'pull-without-operate', roles: [], permissions: ['stock-prep:read', 'stock-prep:pull'] },
  ]

  /** The SERVER's grant (the plugin module itself), flattened the way the plugin flattens a principal. */
  function serverGranted(roles: readonly string[], permissions: readonly string[]): string[] {
    return backendAccess.grantedStockPrepCapabilities([...permissions, ...roles.map((role) => `role:${role}`)])
  }

  function forbidden(): StockPreparationProjectTargetCallError {
    return new StockPreparationProjectTargetCallError(403, 'gate', { code: 'FORBIDDEN' })
  }

  /**
   * The routes as the SERVER answers them for the current actor (`gated`), or answering everyone
   * (`gated: false`) — the second isolates the CLIENT's own guard: with the server out of the way,
   * only the page's capability check can keep a control off screen.
   */
  function targetApi(options: { gated: boolean; list?: StockPrepProjectTargetList }): StockPreparationProjectTargetApi & { getProjectFields: ReturnType<typeof vi.fn>; refreshOverview: ReturnType<typeof vi.fn> } {
    const granted = (capability: string) => !options.gated || serverGranted(h.roles, h.permissions).includes(capability)
    return {
      get: vi.fn(async () => {
        if (!granted('projectTarget.read')) throw forbidden()
        return targetState()
      }),
      create: vi.fn(async () => { throw new Error('unexpected create') }),
      list: vi.fn(async () => {
        if (!granted('projectTarget.list')) throw forbidden()
        return options.list ?? registryList()
      }),
      getProjectFields: vi.fn(async () => {
        if (!granted('projectFields.read')) throw forbidden()
        return { ...fieldsState(), may: { update: granted('projectFields.update') } }
      }),
      updateProjectFields: vi.fn(async () => {
        if (!granted('projectFields.update')) throw forbidden()
        return { status: 'active' as const, fields: fieldsState().fields!, updatedAt: null, changed: ['note' as const] }
      }),
      refreshOverview: vi.fn(async () => {
        if (!granted('projectOverview.refresh')) throw forbidden()
        return refreshResult()
      }),
    }
  }

  it('the client rows for the three capabilities are BYTE-EQUAL to the plugin module\'s (F-01 for these rows)', () => {
    const pick = (rows: readonly { capability: string }[]) => rows.filter((row) => S3_CAPABILITIES.includes(row.capability))
    const server = pick(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES)
    expect(server.map((row) => row.capability)).toEqual(S3_CAPABILITIES)
    expect(JSON.stringify(pick(STOCK_PREP_WORKBENCH_CAPABILITIES))).toBe(JSON.stringify(server))
    expect((server as Array<{ code: string; method: string; control: string }>).map((row) => [row.code, row.method, row.control])).toEqual([
      ['stock-prep:operate', 'GET', 'stock-prep-project-fields'],
      ['stock-prep:operate', 'PUT', 'stock-prep-project-fields-save'],
      ['stock-prep:operate', 'POST', 'stock-prep-project-overview-refresh'],
    ])
    // Position: right after the S4 lifecycle rows, in both manifests.
    const order = (rows: readonly { capability: string }[]) => rows.map((row) => row.capability)
    const clientOrder = order(STOCK_PREP_WORKBENCH_CAPABILITIES)
    expect(clientOrder.slice(clientOrder.indexOf('projectTarget.restore'), clientOrder.indexOf('projectTarget.restore') + 4))
      .toEqual(['projectTarget.restore', ...S3_CAPABILITIES])
    expect(clientOrder).toEqual(order(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES))
  })

  it('the fields form and 保存 render iff the SERVER grants them (server-gated routes)', async () => {
    let fieldsRendered = 0
    let saveRendered = 0
    for (const actor of ACTORS) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      const granted = serverGranted(actor.roles, actor.permissions)
      expect(grantedStockPrepCapabilities({ roles: actor.roles, permissions: actor.permissions }).filter((id) => S3_CAPABILITIES.includes(id)), actor.name)
        .toEqual(granted.filter((id: string) => S3_CAPABILITIES.includes(id)))
      routeBoardApi()
      const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: targetApi({ gated: true }) })
      await flush()
      const form = testid(root, 'stock-prep-project-fields') !== null
      const save = testid(root, 'stock-prep-project-fields-save') !== null
      expect(form, `${actor.name}: stock-prep-project-fields`).toBe(granted.includes('projectFields.read'))
      expect(save, `${actor.name}: stock-prep-project-fields-save`).toBe(granted.includes('projectFields.update'))
      if (form) fieldsRendered += 1
      if (save) {
        saveRendered += 1
        // ...and actionable: the server takes the write for this actor.
        await type(root, 'stock-prep-project-fields-note', 'n-align')
        await press(root, 'stock-prep-project-fields-save')
        expect(testid(root, 'stock-prep-project-fields-result')?.dataset.result, actor.name).toBe('saved')
      }
      unmountAll()
    }
    // Anti-vacuity: floor, puller, stock-prep:admin and the platform admin.
    expect([fieldsRendered, saveRendered]).toEqual([4, 4])
  })

  it('the CLIENT guard alone keeps the fields off screen (routes answer everyone) — and sends no read for a non-holder', async () => {
    for (const actor of ACTORS) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      const granted = serverGranted(actor.roles, actor.permissions)
      routeBoardApi()
      const api = targetApi({ gated: false })
      const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectNo: PROJECT, projectTargetApi: api })
      await flush()
      expect(testid(root, 'stock-prep-project-fields') !== null, `${actor.name}: fields`).toBe(granted.includes('projectFields.read'))
      expect(testid(root, 'stock-prep-project-fields-save') !== null, `${actor.name}: save`).toBe(granted.includes('projectFields.update'))
      expect(api.getProjectFields.mock.calls.length > 0, `${actor.name}: fields read sent`).toBe(granted.includes('projectFields.read'))
      unmountAll()
    }
  })

  it('刷新项目总览 renders iff the SERVER grants projectOverview.refresh, and every rendered button is actionable', async () => {
    let rendered = 0
    for (const gated of [true, false]) {
      for (const actor of ACTORS) {
        h.roles = actor.roles
        h.permissions = actor.permissions
        const granted = serverGranted(actor.roles, actor.permissions)
        routeBoardApi()
        resetStockPreparationOperatorHomeDirectoryThrottle()
        // The list answers everyone here so the button's OWN guard is what decides (the list's gate is PT-ALIGN's).
        const api = targetApi({ gated })
        api.list = vi.fn(async () => registryList())
        const root = mount(StockPreparationProjectBoardView as Component, { scope: SCOPE, projectTargetApi: api })
        await flush()
        expect(testid(root, 'stock-prep-project-target-list'), `${actor.name}: the list line is on screen`).not.toBeNull()
        const button = testid(root, 'stock-prep-project-overview-refresh')
        expect(button !== null, `${actor.name} (gated=${gated}): refresh`).toBe(granted.includes('projectOverview.refresh'))
        if (button) {
          rendered += 1
          await press(root, 'stock-prep-project-overview-refresh')
          expect(testid(root, 'stock-prep-project-overview-result')?.dataset.result, actor.name).toBe('done')
        }
        unmountAll()
      }
    }
    // Anti-vacuity: floor, puller, stock-prep:admin and the platform admin — in both runs.
    expect(rendered).toBe(8)
  })
})
