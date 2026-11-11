// 批次标识 BI-7 — the web half of the PULL-BATCH SETTINGS on 数据来源与体检 (batch-identifier design §5.5 / §7.1 / §11;
// coordinator rulings C2 / C6 / C8 / C10; register R-65). The three plugin routes it calls, all stock-prep:admin:
//
//   GET  /api/integration/stock-preparation/pull-batch/settings                               the tenant default, the
//        fixed facts, the vocabulary, the help copy and every registered sheet's captured values with their locks
//   POST /api/integration/stock-preparation/pull-batch/settings                               body { expectedVersion,
//        <changed settings> } — the tenant default, compare-and-set
//   POST /api/integration/stock-preparation/projects/:projectNo/target/pull-batch/settings    body { confirmProjectNo,
//        expectedVersion, firstPullBatchRule?, labelFormat? } — one captured, unlocked sheet
//
// INVISIBLE WHILE OFF (ruling C6, the R61 lesson). All three answer 404 STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED while the
// pull-batch or the project-sheets switch is off. ANY 404 on the read is `disabled` here (the members-page precedent:
// a host without the plugin route answers 404 too), and the panel renders nothing — no card, no line. There is no
// web-side switch read: the page follows the server's answer.
//
// FAIL CLOSED. A malformed answer is `refused`, never a partly painted page: every token is checked against the
// vocabulary pinned below (and the pinned vocabulary against the plugin's own modules, live, by PBS-VOCAB).
//
// VALUES-FREE: closed tokens, booleans, versions, times, sheet handles and the tenant's own project numbers (an
// admin-visible value, the 087 precedent). The project number a per-sheet edit sends is the one the row shows, typed
// back by the operator; nothing is read back from an answer into a request.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'
import { clampErrorCode } from './projectSync'
import { stockPrepProjectNumbersMatch } from './projectTarget'

// ---------------------------------------------------------------------------
// the vocabulary (pinned against the plugin's pure module and ledger store by PBS-VOCAB)
// ---------------------------------------------------------------------------

export const STOCK_PREP_PULL_BATCH_SETTING_KEYS = Object.freeze(['firstPullBatchRule', 'labelFormat', 'landing', 'placement'] as const)
export const STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS = Object.freeze(['firstPullBatchRule', 'labelFormat'] as const)
export const STOCK_PREP_PULL_BATCH_SETTING_VALUES = Object.freeze({
  firstPullBatchRule: Object.freeze(['material', 'predecessor_suffix'] as const),
  labelFormat: Object.freeze(['ordinal_date', 'ordinal'] as const),
  landing: Object.freeze(['promote_prep_fill', 'keep_current'] as const),
  placement: Object.freeze(['left', 'right'] as const),
})
/** The 10-27 design. */
export const STOCK_PREP_PULL_BATCH_BUILT_IN_SETTINGS = Object.freeze({
  firstPullBatchRule: 'material',
  labelFormat: 'ordinal_date',
  landing: 'promote_prep_fill',
  placement: 'left',
} as const)
/** Not configurable in v1 (ruling C2): shown as 「不可配置」. */
export const STOCK_PREP_PULL_BATCH_FIXED_FACTS = Object.freeze({
  pullBatchMeaning: 'created',
  formalExport: 'excluded',
  trashedRowsAreEvidence: false,
  firstPullBatchColumn: 'shown',
} as const)
export const STOCK_PREP_PULL_BATCH_FIXED_FACT_KEYS = Object.freeze(['pullBatchMeaning', 'formalExport', 'trashedRowsAreEvidence', 'firstPullBatchColumn'] as const)
export const STOCK_PREP_PULL_BATCH_CONFIG_LOCKS = Object.freeze({
  firstPullBatchRule: 'hasStamped',
  labelFormat: 'hasStamped',
  landing: 'landingApplied',
  placement: 'placementApplied',
} as const)
export const STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED_CODE = 'STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED'
/** The codes the settings flows can meet beyond the project-target ones; each has its own two-line copy. */
export const STOCK_PREP_PULL_BATCH_SETTINGS_ERROR_CODES: readonly string[] = Object.freeze([
  'STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED',
  'STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE',
  'STOCK_PREP_PULL_BATCH_STORE_FAILED',
  'STOCK_PREP_PULL_BATCH_CONFIG_INVALID',
  'STOCK_PREP_PULL_BATCH_CONFIG_LOCKED',
  'STOCK_PREP_PULL_BATCH_SETTINGS_VERSION_CONFLICT',
  'STOCK_PREP_PULL_BATCH_SETTINGS_NOT_CAPTURED',
])
export const STOCK_PREP_PULL_BATCH_VERSION_CONFLICT_CODE = 'STOCK_PREP_PULL_BATCH_SETTINGS_VERSION_CONFLICT'
export const STOCK_PREP_PULL_BATCH_CONFIG_LOCKED_CODE = 'STOCK_PREP_PULL_BATCH_CONFIG_LOCKED'
export const STOCK_PREP_PULL_BATCH_NOT_CAPTURED_CODE = 'STOCK_PREP_PULL_BATCH_SETTINGS_NOT_CAPTURED'

export type StockPrepPullBatchSettingKey = (typeof STOCK_PREP_PULL_BATCH_SETTING_KEYS)[number]
export type StockPrepPullBatchSheetSettingKey = (typeof STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS)[number]
export type StockPrepPullBatchSettings = { [K in StockPrepPullBatchSettingKey]: (typeof STOCK_PREP_PULL_BATCH_SETTING_VALUES)[K][number] }
export type StockPrepPullBatchSettingsPatch = Partial<Record<StockPrepPullBatchSettingKey, string>>
export type StockPrepPullBatchRegistryStatus = 'active' | 'archived'
export type StockPrepPullBatchHistoryStatus = 'pending' | 'installing' | 'born_empty' | 'backfilled'
export type StockPrepPullBatchLabelLocale = 'zh-CN' | 'en'

export interface StockPrepPullBatchTenantSettings {
  settings: StockPrepPullBatchSettings
  source: 'built_in' | 'tenant'
  version: number
}

export interface StockPrepPullBatchCaptured {
  firstPullBatchRule: string
  labelFormat: string
  landing: string | null
  placement: string | null
}

export interface StockPrepPullBatchLocks {
  firstPullBatchRule: boolean
  labelFormat: boolean
  landing: boolean
  placement: boolean
}

export interface StockPrepPullBatchSheetRow {
  projectNo: string
  sheetId: string
  registryStatus: StockPrepPullBatchRegistryStatus
  /** null = the sheet has not captured its settings yet (「安装时采用」). */
  captured: StockPrepPullBatchCaptured | null
  labelLocale: StockPrepPullBatchLabelLocale | null
  historyStatus: StockPrepPullBatchHistoryStatus | null
  locks: StockPrepPullBatchLocks | null
  lockedAt: string | null
  version: number | null
  may: { set: boolean }
}

/** The rule-help sentences, from the server (the pure module's PULL_BATCH_SETTINGS_HELP; C10's caveat for 按位置). */
export interface StockPrepPullBatchHelp {
  firstPullBatchRule: Record<string, { 'zh-CN': string; en: string }>
}

export interface StockPrepPullBatchSettingsState {
  tenant: StockPrepPullBatchTenantSettings
  builtIn: StockPrepPullBatchSettings
  help: StockPrepPullBatchHelp
  sheets: StockPrepPullBatchSheetRow[]
  unregisteredLedgerRowCount: number
}

// ---------------------------------------------------------------------------
// clamps (fail closed)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function inVocabulary(key: StockPrepPullBatchSettingKey, value: unknown): value is string {
  return typeof value === 'string' && (STOCK_PREP_PULL_BATCH_SETTING_VALUES[key] as readonly string[]).includes(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function clampSettings(raw: unknown): StockPrepPullBatchSettings | null {
  if (!isRecord(raw)) return null
  const out: Record<string, string> = {}
  for (const key of STOCK_PREP_PULL_BATCH_SETTING_KEYS) {
    if (!inVocabulary(key, raw[key])) return null
    out[key] = raw[key] as string
  }
  return out as StockPrepPullBatchSettings
}

function clampTenant(raw: unknown): StockPrepPullBatchTenantSettings | null {
  if (!isRecord(raw)) return null
  const settings = clampSettings(raw.settings)
  if (!settings || (raw.source !== 'built_in' && raw.source !== 'tenant') || !isVersion(raw.version)) return null
  return { settings, source: raw.source, version: raw.version }
}

function clampHelp(raw: unknown): StockPrepPullBatchHelp | null {
  if (!isRecord(raw) || !isRecord(raw.firstPullBatchRule)) return null
  const out: Record<string, { 'zh-CN': string; en: string }> = {}
  for (const value of STOCK_PREP_PULL_BATCH_SETTING_VALUES.firstPullBatchRule) {
    const entry = raw.firstPullBatchRule[value]
    if (!isRecord(entry) || typeof entry['zh-CN'] !== 'string' || typeof entry.en !== 'string' || !entry['zh-CN'].trim() || !entry.en.trim()) return null
    out[value] = { 'zh-CN': entry['zh-CN'], en: entry.en }
  }
  return { firstPullBatchRule: out }
}

const REGISTRY_STATUSES: readonly string[] = Object.freeze(['active', 'archived'])
const HISTORY_STATUSES: readonly string[] = Object.freeze(['pending', 'installing', 'born_empty', 'backfilled'])
const LABEL_LOCALES: readonly string[] = Object.freeze(['zh-CN', 'en'])

/** One per-sheet row, or null. A row is captured (all ledger fields present) or not (all null) — never half. */
export function clampStockPrepPullBatchSheetRow(raw: unknown): StockPrepPullBatchSheetRow | null {
  if (!isRecord(raw)) return null
  if (typeof raw.projectNo !== 'string' || !raw.projectNo.trim() || raw.projectNo.length > 80) return null
  if (typeof raw.sheetId !== 'string' || !raw.sheetId.trim()) return null
  if (typeof raw.registryStatus !== 'string' || !REGISTRY_STATUSES.includes(raw.registryStatus)) return null
  if (!isRecord(raw.may) || typeof raw.may.set !== 'boolean') return null
  const base = {
    projectNo: raw.projectNo,
    sheetId: raw.sheetId,
    registryStatus: raw.registryStatus as StockPrepPullBatchRegistryStatus,
  }
  if (raw.captured === null) {
    if (raw.locks !== null || raw.version !== null || raw.labelLocale !== null || raw.historyStatus !== null || raw.lockedAt !== null) return null
    if (raw.may.set !== false) return null
    return { ...base, captured: null, labelLocale: null, historyStatus: null, locks: null, lockedAt: null, version: null, may: { set: false } }
  }
  const captured = raw.captured
  if (!isRecord(captured)) return null
  if (!inVocabulary('firstPullBatchRule', captured.firstPullBatchRule) || !inVocabulary('labelFormat', captured.labelFormat)) return null
  if (captured.landing !== null && !inVocabulary('landing', captured.landing)) return null
  if (captured.placement !== null && !inVocabulary('placement', captured.placement)) return null
  const locks = raw.locks
  if (!isRecord(locks) || !STOCK_PREP_PULL_BATCH_SETTING_KEYS.every((key) => typeof locks[key] === 'boolean')) return null
  if (typeof raw.labelLocale !== 'string' || !LABEL_LOCALES.includes(raw.labelLocale)) return null
  if (typeof raw.historyStatus !== 'string' || !HISTORY_STATUSES.includes(raw.historyStatus)) return null
  if (raw.lockedAt !== null && (typeof raw.lockedAt !== 'string' || Number.isNaN(Date.parse(raw.lockedAt)))) return null
  if (!isVersion(raw.version)) return null
  // `may.set` is the server's (active ∧ captured ∧ unlocked); a contradicting answer is refused, not trusted.
  const maySet = raw.registryStatus === 'active' && locks.firstPullBatchRule === false
  if (raw.may.set === true && !maySet) return null
  return {
    ...base,
    captured: {
      firstPullBatchRule: captured.firstPullBatchRule as string,
      labelFormat: captured.labelFormat as string,
      landing: (captured.landing as string | null),
      placement: (captured.placement as string | null),
    },
    labelLocale: raw.labelLocale as StockPrepPullBatchLabelLocale,
    historyStatus: raw.historyStatus as StockPrepPullBatchHistoryStatus,
    locks: {
      firstPullBatchRule: locks.firstPullBatchRule as boolean,
      labelFormat: locks.labelFormat as boolean,
      landing: locks.landing as boolean,
      placement: locks.placement as boolean,
    },
    lockedAt: raw.lockedAt as string | null,
    version: raw.version,
    may: { set: raw.may.set },
  }
}

/** The whole GET answer, or null. The vocabulary, fixed facts, locks and sheet keys must be exactly the pinned ones. */
export function clampStockPrepPullBatchSettingsState(raw: unknown): StockPrepPullBatchSettingsState | null {
  if (!isRecord(raw)) return null
  if (!sameJson(raw.vocabulary, STOCK_PREP_PULL_BATCH_SETTING_VALUES)) return null
  if (!sameJson(raw.fixedFacts, STOCK_PREP_PULL_BATCH_FIXED_FACTS)) return null
  if (!sameJson(raw.locks, STOCK_PREP_PULL_BATCH_CONFIG_LOCKS)) return null
  if (!sameJson(raw.sheetKeys, STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS)) return null
  const builtIn = clampSettings(raw.builtIn)
  if (!builtIn || !sameJson(builtIn, STOCK_PREP_PULL_BATCH_BUILT_IN_SETTINGS)) return null
  const tenant = clampTenant(raw.tenant)
  const help = clampHelp(raw.help)
  if (!tenant || !help || !Array.isArray(raw.sheets)) return null
  if (!isVersion(raw.unregisteredLedgerRowCount)) return null
  const sheets: StockPrepPullBatchSheetRow[] = []
  for (const entry of raw.sheets) {
    const row = clampStockPrepPullBatchSheetRow(entry)
    if (!row) return null
    sheets.push(row)
  }
  return { tenant, builtIn, help, sheets, unregisteredLedgerRowCount: raw.unregisteredLedgerRowCount }
}

export interface StockPrepPullBatchTenantSetResult {
  tenant: StockPrepPullBatchTenantSettings
  written: boolean
  changedKeys: StockPrepPullBatchSettingKey[]
}

export function clampStockPrepPullBatchTenantSetResult(raw: unknown): StockPrepPullBatchTenantSetResult | null {
  if (!isRecord(raw) || typeof raw.written !== 'boolean' || !Array.isArray(raw.changedKeys)) return null
  const tenant = clampTenant(raw.tenant)
  if (!tenant) return null
  const keys = raw.changedKeys
  if (!keys.every((key) => typeof key === 'string' && (STOCK_PREP_PULL_BATCH_SETTING_KEYS as readonly string[]).includes(key))) return null
  return { tenant, written: raw.written, changedKeys: keys as StockPrepPullBatchSettingKey[] }
}

export interface StockPrepPullBatchSheetSetResult {
  sheet: StockPrepPullBatchSheetRow
  written: boolean
}

export function clampStockPrepPullBatchSheetSetResult(raw: unknown): StockPrepPullBatchSheetSetResult | null {
  if (!isRecord(raw) || typeof raw.written !== 'boolean') return null
  const sheet = clampStockPrepPullBatchSheetRow(raw.sheet)
  if (!sheet || sheet.captured === null) return null
  return { sheet, written: raw.written }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export class StockPreparationPullBatchSettingsCallError extends Error {
  status: number
  code: string | null
  /** A CONFIG_LOCKED refusal's locked keys, clamped to the two per-sheet keys (empty otherwise). */
  locked: StockPrepPullBatchSheetSettingKey[]
  malformed: boolean

  constructor(status: number, route: string, options: { code?: string | null; locked?: StockPrepPullBatchSheetSettingKey[]; malformed?: boolean } = {}) {
    super(`stock-preparation pull-batch settings call failed (${route} -> ${status})`)
    this.name = 'StockPreparationPullBatchSettingsCallError'
    this.status = status
    this.code = options.code ?? null
    this.locked = options.locked ?? []
    this.malformed = options.malformed === true
  }
}

function lockedKeysOf(details: unknown): StockPrepPullBatchSheetSettingKey[] {
  if (!isRecord(details) || !Array.isArray(details.locked)) return []
  return STOCK_PREP_PULL_BATCH_SHEET_SETTING_KEYS.filter((key) => (details.locked as unknown[]).includes(key))
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
    throw new StockPreparationPullBatchSettingsCallError(status, route, {
      code: clampErrorCode(envelope?.error?.code),
      locked: lockedKeysOf(envelope?.error?.details),
    })
  }
  const clamped = envelope && envelope.ok === true ? clamp(envelope.data) : null
  if (!clamped) throw new StockPreparationPullBatchSettingsCallError(status, route, { malformed: true })
  return clamped
}

export interface StockPreparationPullBatchSettingsApi {
  get(): Promise<StockPrepPullBatchSettingsState>
  setTenant(expectedVersion: number, patch: StockPrepPullBatchSettingsPatch): Promise<StockPrepPullBatchTenantSetResult>
  setSheet(projectNo: string, confirmProjectNo: string, expectedVersion: number, patch: StockPrepPullBatchSettingsPatch): Promise<StockPrepPullBatchSheetSetResult>
}

const BASE = '/api/integration/stock-preparation'

export function createStockPreparationPullBatchSettingsApi(scope: IntegrationScope): StockPreparationPullBatchSettingsApi {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const suffix = query ? `?${query}` : ''
  return {
    // The read carries the scope query like the other admin reads; the writes carry NO query, only the closed body.
    async get() {
      const route = 'GET …/pull-batch/settings'
      return readEnvelope(await apiFetch(`${BASE}/pull-batch/settings${suffix}`), route, clampStockPrepPullBatchSettingsState)
    },
    async setTenant(expectedVersion, patch) {
      const route = 'POST …/pull-batch/settings'
      const response = await apiFetch(`${BASE}/pull-batch/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion, ...patch }),
      })
      return readEnvelope(response, route, clampStockPrepPullBatchTenantSetResult)
    },
    async setSheet(projectNo, confirmProjectNo, expectedVersion, patch) {
      const route = 'POST …/projects/:projectNo/target/pull-batch/settings'
      const response = await apiFetch(`${BASE}/projects/${encodeURIComponent(projectNo)}/target/pull-batch/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmProjectNo, expectedVersion, ...patch }),
      })
      return readEnvelope(response, route, clampStockPrepPullBatchSheetSetResult)
    },
  }
}

// ---------------------------------------------------------------------------
// the flows
// ---------------------------------------------------------------------------

export type StockPrepPullBatchSettingsLoad =
  /** Any 404 (a switch off, or a host without the route): the panel renders NOTHING (C6). */
  | { kind: 'disabled' }
  | { kind: 'ready'; state: StockPrepPullBatchSettingsState }
  /** Anything else: the status and a clamped code, for one plain line. */
  | { kind: 'refused'; status: number; code: string | null }

export async function loadStockPreparationPullBatchSettings(api: StockPreparationPullBatchSettingsApi): Promise<StockPrepPullBatchSettingsLoad> {
  try {
    return { kind: 'ready', state: await api.get() }
  } catch (error) {
    const status = error instanceof StockPreparationPullBatchSettingsCallError ? error.status : 0
    const code = error instanceof StockPreparationPullBatchSettingsCallError ? error.code : null
    if (status === 404) return { kind: 'disabled' }
    return { kind: 'refused', status, code }
  }
}

/** Only the keys whose value moved (pure). An empty patch means there is nothing to save. */
export function changedPullBatchSettingsPatch(
  current: Partial<Record<string, string | null>>,
  draft: Partial<Record<string, string | null>>,
  keys: readonly string[] = STOCK_PREP_PULL_BATCH_SETTING_KEYS,
): StockPrepPullBatchSettingsPatch {
  const patch: Record<string, string> = {}
  for (const key of keys) {
    const next = draft[key]
    if (typeof next === 'string' && next !== current[key]) patch[key] = next
  }
  return patch as StockPrepPullBatchSettingsPatch
}

export type StockPrepPullBatchSetOutcome<T> =
  | { kind: 'done'; result: T }
  /** The typed project number does not match: NOTHING was sent. */
  | { kind: 'mismatch' }
  /** This caller does not hold the capability, or the patch is empty: nothing was sent. */
  | { kind: 'not_permitted' }
  /** The server refused; `locked` names the locked keys of a CONFIG_LOCKED refusal. */
  | { kind: 'refused'; status: number; code: string | null; locked: StockPrepPullBatchSheetSettingKey[] }

function refusedOf(error: unknown): { kind: 'refused'; status: number; code: string | null; locked: StockPrepPullBatchSheetSettingKey[] } {
  const known = error instanceof StockPreparationPullBatchSettingsCallError
  return { kind: 'refused', status: known ? error.status : 0, code: known ? error.code : null, locked: known ? error.locked : [] }
}

/** Save the tenant default: the changed keys only, with the version that was read. */
export async function setStockPreparationPullBatchTenantSettings(
  deps: { api: StockPreparationPullBatchSettingsApi | null; canSet: boolean },
  expectedVersion: number,
  patch: StockPrepPullBatchSettingsPatch,
): Promise<StockPrepPullBatchSetOutcome<StockPrepPullBatchTenantSetResult>> {
  if (!deps.api || !deps.canSet || Object.keys(patch).length === 0) return { kind: 'not_permitted' }
  try {
    return { kind: 'done', result: await deps.api.setTenant(expectedVersion, patch) }
  } catch (error) {
    return refusedOf(error)
  }
}

/**
 * Save ONE captured sheet's rule / format. A mismatched typed confirmation is stopped HERE, before any request (the
 * server compares it again: 400 STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH).
 */
export async function setStockPreparationProjectPullBatchSettings(
  deps: { api: StockPreparationPullBatchSettingsApi | null; canSet: boolean },
  projectNo: string,
  typedProjectNo: string,
  expectedVersion: number,
  patch: StockPrepPullBatchSettingsPatch,
): Promise<StockPrepPullBatchSetOutcome<StockPrepPullBatchSheetSetResult>> {
  if (!deps.api || !deps.canSet || Object.keys(patch).length === 0) return { kind: 'not_permitted' }
  if (!stockPrepProjectNumbersMatch(projectNo, typedProjectNo)) return { kind: 'mismatch' }
  try {
    return { kind: 'done', result: await deps.api.setSheet(projectNo.trim(), typedProjectNo.trim(), expectedVersion, patch) }
  } catch (error) {
    return refusedOf(error)
  }
}
