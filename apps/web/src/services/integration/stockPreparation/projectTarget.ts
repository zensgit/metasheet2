// 一个项目一张备料表 — the web half of S2 (ADR adr-stock-prep-project-sheets-20261008 §4 / §7;
// register R-36). The S1 routes (R-35) it calls:
//
//   GET  /api/integration/stock-preparation/projects/:projectNo/target   OPERATE
//   POST /api/integration/stock-preparation/projects/:projectNo/target   PULL (201 created / 200 replay)
//   GET  /api/integration/stock-preparation/project-targets              OPERATE
//
// All three answer 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED while the server's default-OFF
// switch is off. That answer is how this module knows the switch is off — and with it off, the pull
// panel walks EXACTLY the flow it walked before S2 (`kind: 'legacy'` below): no confirmation, no
// create, no extra sentence.
//
// THE FLOW (`runStockPreparationProjectPull`), and the one ordering rule it exists to keep:
//
//   probe the sheet ─┬─ disabled (switch off, 404) ─────────────────────────▶ the old four-step run
//                    ├─ unreadable (anything else) ────────────────────────▶ STOP, say so, offer 重试
//                    ├─ absent  ─ (pull tier?) ─ confirm 「新建」 ─ CREATE ─▶ preview ─ confirm ─ write
//                    ├─ active  ─ (pull tier?) ─ confirm 「重新拉取」 ──────▶ the old four-step run
//                    └─ archived ──────────────────────────────────────────▶ stop (restore is S4)
//
//   CREATE COMES BEFORE THE PREVIEW (Q4). With the switch on, a dry run against an unregistered
//   project is refused 409 ABSENT, so the sheet must exist first. Declining the preview leaves the
//   new sheet in place (「还没拉过」) — there is no 「撤销新建」; an empty sheet nobody needs is archived
//   by a puller (S4).
//
// THE SERVER STAYS AUTHORITATIVE. `canPull` (workbenchAccess.canRunStockPrepProjectSync) and `may.*`
// only decide what this page OFFERS; every route re-checks its own gate. A probe that could not be
// read for any reason other than the switch-off 404 STOPS the run (S2 fix round 1): falling back to
// the old flow would pull on a guess about which sheet the project has.
//
// REPAIR (S2 fix round 1). A project sheet that lost — or never got — the customer's extension
// columns answers its dry run 422 TARGET_SCHEMA_INCOMPLETE. `stockPrepProjectSheetRepairAffordance`
// offers a puller 「修复项目表（重装客户包）」: the create route's 200 replay re-installs the pack
// (server-side heal), then the four steps run again.
//
// VALUES-FREE: states, handles, counts and clamped codes. The one business string is the project
// number the OPERATOR typed, which is sent in the path and never read back from a response.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'
import {
  clampErrorCode,
  type StockPreparationProjectSyncHooks,
  type StockPreparationProjectSyncReport,
} from './projectSync'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const STOCK_PREP_PROJECT_TARGET_STATUSES = Object.freeze(['absent', 'active', 'archived'] as const)
export type StockPrepProjectTargetStatus = (typeof STOCK_PREP_PROJECT_TARGET_STATUSES)[number]

export const STOCK_PREP_PROJECT_TARGET_PULL_OUTCOMES = Object.freeze(['applied', 'previewed', 'refused'] as const)
export type StockPrepProjectTargetPullOutcome = (typeof STOCK_PREP_PROJECT_TARGET_PULL_OUTCOMES)[number]

/** The switch-off answer of all three routes. A deployment setting, not a fault. */
export const STOCK_PREP_PROJECT_SHEETS_DISABLED_CODE = 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED'
/** A race partner registered the same project a moment ago — the same sheet; carry on. */
export const STOCK_PREP_PROJECT_TARGET_EXISTS_CODE = 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS'

/**
 * The refusal codes the project-sheet flow can meet, each with its own plain-language row in
 * plainLanguage.ts `STOCK_PREP_ERROR_PLAIN` (StockPreparationProjectTarget.spec.ts pins that every
 * one resolves to a SPECIFIC sentence, never the generic one).
 */
export const STOCK_PREP_PROJECT_TARGET_ERROR_CODES: readonly string[] = Object.freeze([
  STOCK_PREP_PROJECT_SHEETS_DISABLED_CODE,
  'STOCK_PREPARATION_PROJECT_ABSENT',
  'STOCK_PREPARATION_PROJECT_ARCHIVED',
  'STOCK_PREPARATION_PROJECT_TARGET_LIMIT',
  STOCK_PREP_PROJECT_TARGET_EXISTS_CODE,
  'STOCK_PREPARATION_PROJECT_NO_REQUIRED',
  'STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE',
  'STOCK_PREPARATION_PROJECT_TARGET_PACK_INSTALL_FAILED',
  'STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED',
  'STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID',
  'STOCK_PREPARATION_JOB_TARGET_STALE',
  'TABLE_ACTION_TARGET_TENANT_MISMATCH',
  'TABLE_ACTION_TARGET_OWNER_UNKNOWN',
])

export interface StockPrepProjectTargetState {
  status: StockPrepProjectTargetStatus
  /** Deep-link handles (ids, never values). Null while absent. */
  sheetId: string | null
  viewId: string | null
  todoViewId: string | null
  /** Counted in THIS project's sheet, bounded; null when the server could not count. */
  rowCount: number | null
  activeRowCount: number | null
  rowCountBounded: boolean | null
  lastPulledAt: string | null
  lastPullOutcome: StockPrepProjectTargetPullOutcome | null
  archivedAt: string | null
  /** Computed by the server on the PULL tier. Advisory here — the routes re-check. */
  may: { create: boolean; archive: boolean; restore: boolean }
}

export interface StockPrepProjectTargetCreated {
  status: StockPrepProjectTargetStatus
  created: boolean
  sheetId: string | null
  viewId: string | null
  todoViewId: string | null
}

export interface StockPrepProjectTargetListItem {
  /** The tenant's own project number (OPERATE tier — the same number the directory already shows). */
  projectNo: string
  status: StockPrepProjectTargetStatus
  sheetId: string | null
  rowCount: number | null
  activeRowCount: number | null
  countsBounded: boolean | null
}

export interface StockPrepProjectTargetList {
  count: number
  limit: number | null
  items: StockPrepProjectTargetListItem[]
}

// ---------------------------------------------------------------------------
// the strict clamps — a 2xx is not an answer until its shape is one
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function handleOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(value) ? value : null
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function statusOf(value: unknown): StockPrepProjectTargetStatus | null {
  return typeof value === 'string' && (STOCK_PREP_PROJECT_TARGET_STATUSES as readonly string[]).includes(value)
    ? (value as StockPrepProjectTargetStatus)
    : null
}

function timestampOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * The GET target payload, or null when it is not one. Strict: an unknown status, or a `may` block
 * that is not three booleans, is NOT a state — the caller treats it as unreadable.
 */
export function clampStockPrepProjectTargetState(raw: unknown): StockPrepProjectTargetState | null {
  if (!isRecord(raw)) return null
  const status = statusOf(raw.status)
  if (!status) return null
  const may = isRecord(raw.may) ? raw.may : null
  if (!may || typeof may.create !== 'boolean' || typeof may.archive !== 'boolean' || typeof may.restore !== 'boolean') return null
  const outcome = typeof raw.lastPullOutcome === 'string'
    && (STOCK_PREP_PROJECT_TARGET_PULL_OUTCOMES as readonly string[]).includes(raw.lastPullOutcome)
    ? (raw.lastPullOutcome as StockPrepProjectTargetPullOutcome)
    : null
  return {
    status,
    sheetId: handleOf(raw.sheetId),
    viewId: handleOf(raw.viewId),
    todoViewId: handleOf(raw.todoViewId),
    rowCount: countOf(raw.rowCount),
    activeRowCount: countOf(raw.activeRowCount),
    rowCountBounded: boolOrNull(raw.rowCountBounded),
    lastPulledAt: timestampOf(raw.lastPulledAt),
    lastPullOutcome: outcome,
    archivedAt: timestampOf(raw.archivedAt),
    may: { create: may.create, archive: may.archive, restore: may.restore },
  }
}

export function clampStockPrepProjectTargetCreated(raw: unknown): StockPrepProjectTargetCreated | null {
  if (!isRecord(raw)) return null
  const status = statusOf(raw.status)
  if (!status || typeof raw.created !== 'boolean') return null
  return {
    status,
    created: raw.created,
    sheetId: handleOf(raw.sheetId),
    viewId: handleOf(raw.viewId),
    todoViewId: handleOf(raw.todoViewId),
  }
}

export function clampStockPrepProjectTargetList(raw: unknown): StockPrepProjectTargetList | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null
  const items: StockPrepProjectTargetListItem[] = []
  for (const entry of raw.items.slice(0, 500)) {
    if (!isRecord(entry)) continue
    const status = statusOf(entry.status)
    if (!status || typeof entry.projectNo !== 'string' || entry.projectNo.length === 0 || entry.projectNo.length > 128) continue
    items.push({
      projectNo: entry.projectNo,
      status,
      sheetId: handleOf(entry.sheetId),
      rowCount: countOf(entry.rowCount),
      activeRowCount: countOf(entry.activeRowCount),
      countsBounded: boolOrNull(entry.countsBounded),
    })
  }
  return { count: items.length, limit: countOf(raw.limit), items }
}

/** The fill-view deep link a state carries, in the board's own handle shape — or null. */
export function stockPrepProjectTargetFillTarget(state: StockPrepProjectTargetState | null): { sheetId: string; viewId: string } | null {
  if (!state || state.status === 'absent' || !state.sheetId || !state.viewId) return null
  return { sheetId: state.sheetId, viewId: state.viewId }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/** HTTP status + clamped error code of a failed call. Never carries a server message. */
export class StockPreparationProjectTargetCallError extends Error {
  status: number
  code: string | null
  malformed: boolean

  constructor(status: number, route: string, options: { code?: string | null; malformed?: boolean } = {}) {
    super(`stock-preparation project target call failed (${route} -> ${status})`)
    this.name = 'StockPreparationProjectTargetCallError'
    this.status = status
    this.code = options.code ?? null
    this.malformed = options.malformed === true
  }
}

export function projectTargetErrorStatus(error: unknown): number {
  return error instanceof StockPreparationProjectTargetCallError ? error.status : 0
}

export function projectTargetErrorCode(error: unknown): string | null {
  return error instanceof StockPreparationProjectTargetCallError ? error.code : null
}

/** The switch is off: the deployment does not run per-project sheets. */
export function isStockPrepProjectSheetsDisabled(error: unknown): boolean {
  return projectTargetErrorStatus(error) === 404 && projectTargetErrorCode(error) === STOCK_PREP_PROJECT_SHEETS_DISABLED_CODE
}

export interface StockPreparationProjectTargetApi {
  get(projectNo: string): Promise<StockPrepProjectTargetState>
  create(projectNo: string): Promise<StockPrepProjectTargetCreated>
  list(): Promise<StockPrepProjectTargetList>
}

async function readEnvelope<T>(response: Response | undefined, route: string, clamp: (raw: unknown) => T | null): Promise<T> {
  let payload: unknown = null
  try {
    payload = await response?.json()
  } catch {
    payload = null
  }
  const status = typeof response?.status === 'number' ? response.status : 0
  const envelope = isRecord(payload) ? (payload as unknown as IntegrationApiEnvelope<unknown>) : null
  if (!response?.ok || envelope?.ok === false) {
    throw new StockPreparationProjectTargetCallError(status, route, { code: clampErrorCode(envelope?.error?.code) })
  }
  const clamped = envelope && envelope.ok === true ? clamp(envelope.data) : null
  if (!clamped) throw new StockPreparationProjectTargetCallError(status, route, { malformed: true })
  return clamped
}

const TARGET_BASE = '/api/integration/stock-preparation'

export function createStockPreparationProjectTargetApi(scope: IntegrationScope): StockPreparationProjectTargetApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  return {
    async get(projectNo: string) {
      const route = 'GET …/projects/:projectNo/target'
      const response = await apiFetch(`${TARGET_BASE}/projects/${encodeURIComponent(projectNo)}/target${suffix}`)
      return readEnvelope(response, route, clampStockPrepProjectTargetState)
    },
    async create(projectNo: string) {
      const route = 'POST …/projects/:projectNo/target'
      // An EMPTY body (the server's closed allowlist) and NO query: the tenant is the authenticated
      // principal's, and a write carries no steering field.
      const response = await apiFetch(`${TARGET_BASE}/projects/${encodeURIComponent(projectNo)}/target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      return readEnvelope(response, route, clampStockPrepProjectTargetCreated)
    },
    async list() {
      const route = 'GET …/project-targets'
      const response = await apiFetch(`${TARGET_BASE}/project-targets${suffix}`)
      return readEnvelope(response, route, clampStockPrepProjectTargetList)
    },
  }
}

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

export type StockPrepProjectTargetProbe =
  | { kind: 'disabled' }
  | { kind: 'unreadable'; status: number; code: string | null }
  | { kind: 'state'; state: StockPrepProjectTargetState }

export async function probeStockPreparationProjectTarget(
  api: StockPreparationProjectTargetApi,
  projectNo: string,
): Promise<StockPrepProjectTargetProbe> {
  try {
    return { kind: 'state', state: await api.get(projectNo) }
  } catch (error) {
    if (isStockPrepProjectSheetsDisabled(error)) return { kind: 'disabled' }
    return { kind: 'unreadable', status: projectTargetErrorStatus(error), code: projectTargetErrorCode(error) }
  }
}

/** What the page must ask the operator, in the order the flow asks it. */
export type StockPrepProjectTargetConfirmRequest =
  | { kind: 'create' }
  | { kind: 'repull'; rowCount: number | null; activeRowCount: number | null; rowCountBounded: boolean | null }
  | { kind: 'write'; planned: NonNullable<StockPreparationProjectSyncReport['planned']> }

export type StockPrepProjectPullOutcome =
  /** The four-step run happened. `mode` says on which path; `after` is the re-read sheet (counts). */
  | {
    kind: 'synced'
    mode: 'legacy' | 'created' | 'existing' | 'repaired'
    createdSheet: boolean
    report: StockPreparationProjectSyncReport
    after: StockPrepProjectTargetState | null
  }
  /** The operator said no before anything was created or pulled. */
  | { kind: 'cancelled'; stage: 'create' | 'repull' }
  /** No sheet yet, and this caller cannot create one. */
  | { kind: 'contact_puller' }
  /** Archived: read-only until a puller restores it (S4). */
  | { kind: 'archived'; mayRestore: boolean; state: StockPrepProjectTargetState }
  /** The create (or the repair's replay) was refused; nothing was pulled. */
  | { kind: 'create_refused'; status: number; code: string | null }
  /** The sheet state could not be read (not the switch-off 404): nothing was pulled. */
  | { kind: 'probe_failed'; status: number; code: string | null }

export interface StockPrepProjectPullDeps {
  /** Null → this page has no target client: the old run, unchanged. */
  targetApi: StockPreparationProjectTargetApi | null
  /** The existing four-step run, with the S2 hook threaded in. */
  runSync: (hooks: StockPreparationProjectSyncHooks) => Promise<StockPreparationProjectSyncReport>
  /** Ask the operator. Anything but `true` is a no. */
  confirm: (request: StockPrepProjectTargetConfirmRequest) => Promise<boolean>
  /** May this caller pull (and so create)? The PULL-tier mirror; the server re-checks. */
  canPull: boolean
}

async function rereadCounts(api: StockPreparationProjectTargetApi, projectNo: string): Promise<StockPrepProjectTargetState | null> {
  try {
    return await api.get(projectNo)
  } catch {
    return null
  }
}

export async function runStockPreparationProjectPull(
  deps: StockPrepProjectPullDeps,
  projectNo: string,
): Promise<StockPrepProjectPullOutcome> {
  const legacy = async (): Promise<StockPrepProjectPullOutcome> => ({
    kind: 'synced',
    mode: 'legacy',
    createdSheet: false,
    report: await deps.runSync({}),
    after: null,
  })
  const api = deps.targetApi
  if (!api) return legacy()

  const probe = await probeStockPreparationProjectTarget(api, projectNo)
  // Switch off → the old flow, byte for byte. Unreadable → STOP: nothing is pulled on a guess.
  if (probe.kind === 'disabled') return legacy()
  if (probe.kind === 'unreadable') return { kind: 'probe_failed', status: probe.status, code: probe.code }
  const state = probe.state

  if (state.status === 'archived') return { kind: 'archived', mayRestore: state.may.restore, state }
  if (!deps.canPull) return { kind: 'contact_puller' }

  if (state.status === 'absent') {
    if (!state.may.create) return { kind: 'contact_puller' }
    if ((await deps.confirm({ kind: 'create' })) !== true) return { kind: 'cancelled', stage: 'create' }
    // CREATE FIRST (Q4). The preview below is a dry run, and a dry run needs the registered sheet.
    let createdSheet = false
    try {
      const created = await api.create(projectNo)
      createdSheet = created.created
    } catch (error) {
      const code = projectTargetErrorCode(error)
      if (isStockPrepProjectSheetsDisabled(error)) return legacy()
      if (code !== STOCK_PREP_PROJECT_TARGET_EXISTS_CODE) {
        return { kind: 'create_refused', status: projectTargetErrorStatus(error), code }
      }
      // EXISTS: a colleague's create won the race — it is this project's one sheet; carry on.
    }
    const report = await deps.runSync({ projectSheet: true, confirmWrite: (planned) => deps.confirm({ kind: 'write', planned }) })
    return { kind: 'synced', mode: 'created', createdSheet, report, after: await rereadCounts(api, projectNo) }
  }

  // active — the idempotent re-pull, after the operator has seen what is in the sheet now.
  const go = await deps.confirm({
    kind: 'repull',
    rowCount: state.rowCount,
    activeRowCount: state.activeRowCount,
    rowCountBounded: state.rowCountBounded,
  })
  if (go !== true) return { kind: 'cancelled', stage: 'repull' }
  const report = await deps.runSync({ projectSheet: true })
  return { kind: 'synced', mode: 'existing', createdSheet: false, report, after: await rereadCounts(api, projectNo) }
}

/**
 * 「修复项目表（重装客户包）」 — offered after a run ON A PROJECT SHEET whose dry run (or write) the
 * server refused 422 TARGET_SCHEMA_INCOMPLETE. A puller gets the repair; anyone else is told whom to
 * ask. Off a project sheet (switch off) nothing is offered: that refusal is about the env sheet and
 * keeps its pre-S2 reading.
 */
export function stockPrepProjectSheetRepairAffordance(
  report: StockPreparationProjectSyncReport | null,
  context: { projectSheet: boolean; canPull: boolean },
): 'repair' | 'contact_puller' | null {
  if (!report || context.projectSheet !== true) return null
  const missingColumns = report.steps.some((step) => (step.id === 'dry-run' && step.reason === 'PLAN_TARGET_SCHEMA_INCOMPLETE')
    || (step.id === 'apply' && step.detail.code === 'TARGET_SCHEMA_INCOMPLETE'))
  if (!missingColumns) return null
  return context.canPull ? 'repair' : 'contact_puller'
}

/**
 * THE REPAIR: the create route's 200 replay (which heals a registered sheet's customer pack server-
 * side — R-36), then the four steps again. A refusal of the replay stops with its code; nothing is
 * pulled. Pull tier only, like the create it replays; the server re-checks.
 */
export async function repairStockPreparationProjectSheet(
  deps: Pick<StockPrepProjectPullDeps, 'targetApi' | 'runSync' | 'canPull'>,
  projectNo: string,
): Promise<StockPrepProjectPullOutcome> {
  const api = deps.targetApi
  if (!api || !deps.canPull) return { kind: 'contact_puller' }
  try {
    await api.create(projectNo)
  } catch (error) {
    return { kind: 'create_refused', status: projectTargetErrorStatus(error), code: projectTargetErrorCode(error) }
  }
  const report = await deps.runSync({ projectSheet: true })
  return { kind: 'synced', mode: 'repaired', createdSheet: false, report, after: await rereadCounts(api, projectNo) }
}
