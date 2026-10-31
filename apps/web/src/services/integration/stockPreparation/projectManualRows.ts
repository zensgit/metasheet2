// 人工补充行 B4 — the web half of the PER-SHEET SWITCH 「允许人工补充行」 (ADR adr-stock-prep-manual-rows-20261030 §4 /
// §5.3 / §8 「B4」; OQ6; register R-68). The two plugin routes it calls:
//
//   GET  /api/integration/stock-preparation/projects/:projectNo/target/manual-rows   ADMIN (stock-prep:admin; platform admin)
//   POST /api/integration/stock-preparation/projects/:projectNo/target/manual-rows   ADMIN, body { confirmProjectNo, policy }
//
// Both answer 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED while the deployment's project-sheets switch is off — the
// panel then shows nothing (`kind: 'disabled'`), exactly as the pull panel walks its old flow then.
//
// WHAT THE GET CARRIES: the switch (`policy`, and whether it was ever SET or is the default), whether the key column
// carries the PLM lock (a manual row can only be added once it does), the registry handles, `may.set`, and the last
// small-lane pull's persisted reminder — `lastPull.status` 'none' means NO record, i.e. all zeros (B1's contract),
// 'unavailable' means the store could not be read (null counts: never read as zeros).
//
// THE SET: the operator TYPES the project number shown on the panel; nothing is sent until it matches
// (`stockPrepProjectNumbersMatch`, the archive / restore / pilot rule), and the server compares it again (400
// STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH). ADMIN only: `canSet` is the client mirror; the route re-checks its gate.
//
// VALUES-FREE: states, booleans, counts, handles and capped record ids. The project number is the one the panel was
// handed; it is sent in the path and the body and NEVER read back from a response.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'
import { clampErrorCode } from './projectSync'
import { STOCK_PREP_PROJECT_SHEETS_DISABLED_CODE, stockPrepProjectNumbersMatch } from './projectTarget'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const STOCK_PREP_MANUAL_ROWS_POLICIES = Object.freeze(['allowed', 'disabled'] as const)
export type StockPrepManualRowsPolicy = (typeof STOCK_PREP_MANUAL_ROWS_POLICIES)[number]
export type StockPrepManualRowsPolicySource = 'default' | 'set'
export type StockPrepManualRowsLastPullStatus = 'recorded' | 'none' | 'unavailable'
export type StockPrepManualRowsSheetStatus = 'absent' | 'active' | 'archived'

/** B1's per-sheet cap on each id list; a longer list from a server is clamped to it. */
export const STOCK_PREP_MANUAL_ROWS_ID_LIMIT = 50

/**
 * The refusal codes the switch flow can meet beyond the project-target ones, each with its own two-line plain-language
 * row in plainLanguage.ts `STOCK_PREP_ERROR_PLAIN` (StockPreparationProjectTargetManualRows.spec.ts MR-COPY pins that
 * every one resolves to a SPECIFIC sentence, never the generic one).
 */
export const STOCK_PREP_MANUAL_ROWS_ERROR_CODES: readonly string[] = Object.freeze([
  'STOCK_PREP_MANUAL_ROWS_POLICY_INVALID',
  'STOCK_PREP_MANUAL_ROWS_KEY_COLUMN_MISSING',
  'STOCK_PREP_MANUAL_ROWS_SWITCH_UNCONFIRMED',
  'STOCK_PREP_MANUAL_ROWS_HOST_UNSUPPORTED',
])

/** The last small-lane pull's reminder, as the server answers it. */
export interface StockPrepManualRowsLastPull {
  status: StockPrepManualRowsLastPullStatus
  /** The pull's time ('recorded' only). */
  at: string | null
  mode: 'dry_run' | 'apply' | null
  /** Null only while 'unavailable' — never read as zero. */
  rowCount: number | null
  unboundKeyCount: number | null
  matchedManualCount: number | null
  matchedManualRecordIds: string[]
  unboundRecordIds: string[]
}

/** GET …/target/manual-rows (ADMIN): what the panel renders. */
export interface StockPrepManualRowsState {
  status: StockPrepManualRowsSheetStatus
  sheetId: string | null
  /** The fill view's handle — the 「查看这些行」 deep links open the rows in it. */
  viewId: string | null
  keyColumn: 'present' | 'missing' | null
  policy: StockPrepManualRowsPolicy | null
  policySource: StockPrepManualRowsPolicySource | null
  /** Whether the key column carries the PLM human-write lock (a manual row can only be added once it does). */
  keyLocked: boolean | null
  lastPull: StockPrepManualRowsLastPull | null
  /** Computed by the server (ADMIN tier): an ACTIVE sheet with a key column. Advisory — the route re-checks. */
  may: { set: boolean }
}

/** POST …/target/manual-rows (ADMIN): the state as READ BACK after the write, and what the write did. */
export interface StockPrepManualRowsSetResult extends StockPrepManualRowsState {
  /** True when the key column was written now; false when it already held the value asked for. */
  written: boolean
  /** True when the switch's EFFECT changed. */
  changed: boolean
}

// ---------------------------------------------------------------------------
// clamps — a malformed answer is refused (null), never guessed at
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function handleOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function idListOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const id of value) {
    if (typeof id !== 'string' || id.trim() === '') return null
    if (ids.length < STOCK_PREP_MANUAL_ROWS_ID_LIMIT) ids.push(id)
  }
  return ids
}

function policyOf(value: unknown): StockPrepManualRowsPolicy | null {
  return value === 'allowed' || value === 'disabled' ? value : null
}

function clampLastPull(raw: unknown): StockPrepManualRowsLastPull | null {
  if (!isRecord(raw)) return null
  const status = raw.status
  if (status !== 'recorded' && status !== 'none' && status !== 'unavailable') return null
  const matchedManualRecordIds = idListOf(raw.matchedManualRecordIds)
  const unboundRecordIds = idListOf(raw.unboundRecordIds)
  if (!matchedManualRecordIds || !unboundRecordIds) return null
  if (status === 'unavailable') {
    return { status, at: null, mode: null, rowCount: null, unboundKeyCount: null, matchedManualCount: null, matchedManualRecordIds: [], unboundRecordIds: [] }
  }
  const rowCount = countOrNull(raw.rowCount)
  const unboundKeyCount = countOrNull(raw.unboundKeyCount)
  const matchedManualCount = countOrNull(raw.matchedManualCount)
  if (rowCount === null || unboundKeyCount === null || matchedManualCount === null) return null
  const mode = raw.mode === 'dry_run' || raw.mode === 'apply' ? raw.mode : null
  const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : null
  if (status === 'recorded' && (mode === null || at === null)) return null
  return {
    status,
    at: status === 'recorded' ? at : null,
    mode: status === 'recorded' ? mode : null,
    rowCount,
    unboundKeyCount,
    matchedManualCount,
    matchedManualRecordIds,
    unboundRecordIds,
  }
}

export function clampStockPrepManualRowsState(raw: unknown): StockPrepManualRowsState | null {
  if (!isRecord(raw)) return null
  const status = raw.status
  if (status !== 'absent' && status !== 'active' && status !== 'archived') return null
  const may = isRecord(raw.may) ? raw.may : {}
  if (status === 'absent') {
    return { status, sheetId: null, viewId: null, keyColumn: null, policy: null, policySource: null, keyLocked: null, lastPull: null, may: { set: false } }
  }
  const keyColumn = raw.keyColumn === 'present' || raw.keyColumn === 'missing' ? raw.keyColumn : null
  if (keyColumn === null) return null
  const policy = policyOf(raw.policy)
  const policySource = raw.policySource === 'default' || raw.policySource === 'set' ? raw.policySource : null
  if (keyColumn === 'present' && (policy === null || policySource === null || typeof raw.keyLocked !== 'boolean')) return null
  const lastPull = clampLastPull(raw.lastPull)
  if (!lastPull) return null
  return {
    status,
    sheetId: handleOf(raw.sheetId),
    viewId: handleOf(raw.viewId),
    keyColumn,
    policy: keyColumn === 'present' ? policy : null,
    policySource: keyColumn === 'present' ? policySource : null,
    keyLocked: keyColumn === 'present' ? raw.keyLocked === true : null,
    lastPull,
    may: { set: may.set === true && status === 'active' && keyColumn === 'present' },
  }
}

export function clampStockPrepManualRowsSetResult(raw: unknown): StockPrepManualRowsSetResult | null {
  const state = clampStockPrepManualRowsState(raw)
  if (!state || state.status === 'absent' || !isRecord(raw)) return null
  if (typeof raw.written !== 'boolean' || typeof raw.changed !== 'boolean') return null
  return { ...state, written: raw.written, changed: raw.changed }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/** A refused or malformed call: the HTTP status and a clamped code, never a message. */
export class StockPreparationManualRowsCallError extends Error {
  status: number
  code: string | null
  malformed: boolean

  constructor(status: number, route: string, options: { code?: string | null; malformed?: boolean } = {}) {
    super(`stock-preparation manual-rows switch call failed (${route} -> ${status})`)
    this.name = 'StockPreparationManualRowsCallError'
    this.status = status
    this.code = options.code ?? null
    this.malformed = options.malformed === true
  }
}

export interface StockPreparationManualRowsApi {
  get(projectNo: string): Promise<StockPrepManualRowsState>
  set(projectNo: string, confirmProjectNo: string, policy: StockPrepManualRowsPolicy): Promise<StockPrepManualRowsSetResult>
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
    throw new StockPreparationManualRowsCallError(status, route, { code: clampErrorCode(envelope?.error?.code) })
  }
  const clamped = envelope && envelope.ok === true ? clamp(envelope.data) : null
  if (!clamped) throw new StockPreparationManualRowsCallError(status, route, { malformed: true })
  return clamped
}

const BASE = '/api/integration/stock-preparation'

export function createStockPreparationManualRowsApi(scope: IntegrationScope): StockPreparationManualRowsApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  return {
    // The read carries the scope query like the other project-target reads; the write, like every write here, carries
    // NO query and the server's closed body `{ confirmProjectNo, policy }`.
    async get(projectNo: string) {
      const route = 'GET …/projects/:projectNo/target/manual-rows'
      const response = await apiFetch(`${BASE}/projects/${encodeURIComponent(projectNo)}/target/manual-rows${suffix}`)
      return readEnvelope(response, route, clampStockPrepManualRowsState)
    },
    async set(projectNo: string, confirmProjectNo: string, policy: StockPrepManualRowsPolicy) {
      const route = 'POST …/projects/:projectNo/target/manual-rows'
      const response = await apiFetch(`${BASE}/projects/${encodeURIComponent(projectNo)}/target/manual-rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmProjectNo, policy }),
      })
      return readEnvelope(response, route, clampStockPrepManualRowsSetResult)
    },
  }
}

// ---------------------------------------------------------------------------
// the two flows
// ---------------------------------------------------------------------------

export type StockPrepManualRowsLoad =
  /** The deployment does not run per-project sheets (404 DISABLED): the panel shows nothing. */
  | { kind: 'disabled' }
  | { kind: 'ready'; state: StockPrepManualRowsState }
  /** Anything else: the status and a clamped code, for one plain sentence. */
  | { kind: 'refused'; status: number; code: string | null }

export async function loadStockPreparationManualRows(api: StockPreparationManualRowsApi, projectNo: string): Promise<StockPrepManualRowsLoad> {
  try {
    return { kind: 'ready', state: await api.get(projectNo.trim()) }
  } catch (error) {
    const status = error instanceof StockPreparationManualRowsCallError ? error.status : 0
    const code = error instanceof StockPreparationManualRowsCallError ? error.code : null
    if (status === 404 && code === STOCK_PREP_PROJECT_SHEETS_DISABLED_CODE) return { kind: 'disabled' }
    return { kind: 'refused', status, code }
  }
}

export type StockPrepManualRowsSetOutcome =
  /** The server set it (or it already held the value — `result.written`); `result` is the state READ BACK. */
  | { kind: 'done'; result: StockPrepManualRowsSetResult }
  /** The typed number does not match the project: NOTHING was sent. */
  | { kind: 'mismatch' }
  /** This caller does not hold the ADMIN tier: nothing was sent. */
  | { kind: 'not_permitted' }
  /** The server refused (ARCHIVED / CONFIRM_MISMATCH / KEY_COLUMN_MISSING / SWITCH_UNCONFIRMED / a gate …). */
  | { kind: 'refused'; status: number; code: string | null }

/**
 * Set the switch of ONE project. ADMIN only (`canSet` is the client mirror; the server re-checks its gate). A
 * mismatched confirmation is stopped HERE, before any request — the server would refuse it too, but nothing should
 * leave the browser on a typo.
 */
export async function setStockPreparationManualRows(
  deps: { api: StockPreparationManualRowsApi | null; canSet: boolean },
  projectNo: string,
  typedProjectNo: string,
  policy: StockPrepManualRowsPolicy,
): Promise<StockPrepManualRowsSetOutcome> {
  if (!deps.api || !deps.canSet) return { kind: 'not_permitted' }
  if (!stockPrepProjectNumbersMatch(projectNo, typedProjectNo)) return { kind: 'mismatch' }
  try {
    return { kind: 'done', result: await deps.api.set(projectNo.trim(), typedProjectNo.trim(), policy) }
  } catch (error) {
    const status = error instanceof StockPreparationManualRowsCallError ? error.status : 0
    const code = error instanceof StockPreparationManualRowsCallError ? error.code : null
    return { kind: 'refused', status, code }
  }
}

/** The value the switch control offers: the opposite of the current effect. */
export function stockPrepManualRowsNextPolicy(policy: StockPrepManualRowsPolicy | null): StockPrepManualRowsPolicy {
  return policy === 'disabled' ? 'allowed' : 'disabled'
}

/**
 * The deep link that opens ONE record of the project sheet (the multitable route `/multitable/:sheetId/:viewId` with
 * `?recordId=`), under the app's router base (main.ts `createWebHistory(import.meta.env.BASE_URL)`). Every segment is
 * a handle, encoded. Null when a handle is missing.
 */
export function stockPrepManualRowsRecordHref(
  base: string | null | undefined,
  handles: { sheetId: string | null; viewId: string | null },
  recordId: string,
): string | null {
  if (!handles.sheetId || !handles.viewId || !recordId) return null
  const trimmed = (base ?? '').trim().replace(/\/+$/, '')
  return `${trimmed}/multitable/${encodeURIComponent(handles.sheetId)}/${encodeURIComponent(handles.viewId)}?recordId=${encodeURIComponent(recordId)}`
}
