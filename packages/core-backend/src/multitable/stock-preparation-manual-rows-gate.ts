/**
 * 人工补充行 (manual supplementary rows) — the HOST half of ADR adr-stock-prep-manual-rows-20261030, slice B2: the IO
 * part. The pure predicates live in stock-preparation-manual-rows.ts.
 *
 * WHAT THIS MODULE DECIDES. Whether a sheet supports manual rows, in which STATE, and — for the create routes — the
 * stamp values and the derived column ids the record-create extension writes with. It never writes anything.
 *
 * SCOPE: P_reg (ADR §3.0). A sheet is in scope when (a) its HOST registry row (`plugin_multitable_object_registry`)
 * names `plugin-integration-core` and a registered project-sheet object id (the R-66 ② rule), AND the PLUGIN registry
 * (`integration_stock_prep_project_target`, migration 087) holds a row for it, whatever its status. Every other sheet —
 * the env main table, copies, adopted older sandbox sheets, a sheet only provisioned (PB-05) — keeps its old behaviour:
 * no block on /context, and the manual-row routes refuse with `not_project_sheet`.
 *
 * THE HOST READS A PLUGIN TABLE (ADR §9 risk 1; precedent plugin-write-fence.ts). Fixed SQL, only columns migration
 * 087 created (`MANUAL_ROWS_PROJECT_TARGET_SQL`; the contract test parses 087 and pins it). Failure direction, by
 * SQLSTATE and never by message text: 42P01 (the table does not exist) means NOT REGISTERED — the old behaviour stays;
 * any other error means REGISTRY_UNREADABLE — the write routes answer 503 and /context reports
 * `unavailable/registry_unreadable` (fail closed: the web hides its generic create entries).
 *
 * THE ORDER of the create checks (ADR §3.2; each refuses BEFORE any write):
 *   1. canCreateRecord (the route, on the actor's OWN capabilities);
 *   2. P_reg — host registry (a), then the plugin registry row; otherwise `not_project_sheet` (`registry_unreadable` when
 *      a registry cannot be read). Then the structural contract: exactly one key column (b) and it IS the key column
 *      derived from the host registry row (provisioning.ts getObjectFieldId), and the stamped / required columns exist
 *      — otherwise `contract_mismatch` (fail closed);
 *   3. the key, 项目号 and 有效 columns carry `humanWriteLock`; otherwise `lock_missing`;
 *   4. the plugin registry row is well formed, names the SAME object id as the host registry row, and is `active`;
 *      otherwise `contract_mismatch` / `project_archived`;
 *   5. MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED is exactly `'true'`, read per request with the plugin's rule
 *      (stock-preparation-project-targets.cjs stockPreparationProjectSheetsEnabled); otherwise `project_sheets_off`;
 *   6. the switch on the key column is not disabled; otherwise `disabled`.
 * 3, 4 and 6 run AGAIN inside the create transaction, after the fence, on the RE-READ fields and the plugin registry row
 * read in that same transaction (`assertManualRowCreateInTransaction`, called by RecordService.createRecord).
 *
 * THE EXTENSION TOKEN. RecordService.createRecord runs the manual-row branch only for an extension object minted HERE
 * (`mintManualRowCreateExtension`; a module-private WeakSet records every minted object, the plugin-write-fence.ts
 * precedent). The token turns the extension ON; it never stands in for capabilities — the create still runs on the
 * actor's own resolved capabilities and still checks canCreateRecord (unlike the copy-sheet path, which hands the
 * server constant COPY_SHEET_RECORD_CAPABILITIES as its capability object; that precedent is deliberately NOT copied).
 *
 * VALUES-FREE. Refusals carry a closed code, a fixed message and a closed reason token — never a sheet, project number,
 * key or value. Their reader already holds create / edit capability on the sheet.
 */
import { humanWriteLockKindOfProperty, stripHumanWriteLockKey } from './human-write-lock'
import { fieldsCarryExactStockPreparationStanza, resolvePlmKeyFieldIds } from './plm-row-delete-guard'
import { getObjectFieldId } from './provisioning'
import { normalizeProperty } from './record-duplicate-guard'
import { isStockPreparationProjectSheetObjectId } from './stock-preparation-project-sheet-grant-contract'
import { STOCK_PREPARATION_PROJECT_SHEET_PLUGIN } from './stock-preparation-project-sheet-schema-clamp'
import {
  MANUAL_ROW_ACTIVE_FIELD_ID,
  MANUAL_ROW_FILLABLE_FIELD_IDS,
  MANUAL_ROW_KEY_FIELD_ID,
  MANUAL_ROW_NEVER_WRITTEN_CLASSES,
  MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS,
  MANUAL_ROW_PROJECT_NO_FIELD_ID,
  MANUAL_ROW_REQUIRED_ADDED_FIELD_IDS,
  MANUAL_ROW_REQUIRED_DROPPED_FIELD_IDS,
  MANUAL_ROW_STAMP_FIELD_IDS,
  MANUAL_ROW_TEMPLATE_CLASSES,
  MANUAL_ROWS_POLICY_DISABLED,
  isManualSupplementRow,
  isNonBlankString,
  manualRowsPolicyOfProperty,
  type ManualRowTemplateClass,
} from './stock-preparation-manual-rows'

export type ManualRowsQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

type GateFieldLike = { id?: unknown; property?: unknown }

// ── the deployment switch the host now reads (ADR §3.2 condition 5) ─────────────────────────────────

export const STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'

/** EXACT literal 'true' (`' true'`, `'TRUE'`, `'1'` are OFF), read per call — the plugin's own rule. */
export function stockPrepProjectSheetsEnabledForManualRows(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env) && env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV] === 'true'
}

// ── the two registry reads (fixed SQL) ───────────────────────────────────────────────────────────────

/** The host registry row: the plugin that provisioned the sheet, and the (project, object) its ids derive from. */
export const MANUAL_ROWS_HOST_REGISTRY_SQL =
  'SELECT project_id, object_id, plugin_name FROM plugin_multitable_object_registry WHERE sheet_id = $1 LIMIT 1'

/** The plugin registry (migration 087). Every column read here is one 087 created; nothing added later is read. */
export const MANUAL_ROWS_PROJECT_TARGET_TABLE = 'integration_stock_prep_project_target'
export const MANUAL_ROWS_PROJECT_TARGET_COLUMNS = Object.freeze(['sheet_id', 'project_no', 'status', 'object_id', 'tenant_id'] as const)
export const MANUAL_ROWS_PROJECT_TARGET_SQL =
  'SELECT sheet_id, project_no, status, object_id, tenant_id FROM integration_stock_prep_project_target WHERE sheet_id = $1'

/** SQLSTATE of an undefined table — the one error that means "not registered" (ADR §3.0). */
export const UNDEFINED_TABLE_SQLSTATE = '42P01'

export function sqlStateOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null
}

export type ManualRowsHostRegistryRow = Readonly<{ projectId: unknown; objectId: unknown; pluginName: unknown }>
export type ManualRowsHostRegistryRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; row: ManualRowsHostRegistryRow }>
  | Readonly<{ kind: 'unreadable'; sqlState: string | null }>

export type ManualRowsProjectTargetRow = Readonly<{ sheetId: unknown; projectNo: unknown; status: unknown; objectId: unknown; tenantId: unknown }>
export type ManualRowsProjectTargetRead =
  | Readonly<{ kind: 'absent'; cause: 'no_row' | 'table_missing' }>
  | Readonly<{ kind: 'present'; row: ManualRowsProjectTargetRow }>
  | Readonly<{ kind: 'unreadable'; sqlState: string | null }>

/** The host registry. Any error is UNREADABLE — the table is the core's own, so there is no "missing" case. */
export async function readManualRowsHostRegistry(query: ManualRowsQueryFn, sheetId: string): Promise<ManualRowsHostRegistryRead> {
  try {
    const result = await query(MANUAL_ROWS_HOST_REGISTRY_SQL, [sheetId])
    const row = (Array.isArray(result?.rows) ? result.rows[0] : undefined) as Record<string, unknown> | undefined
    if (!row) return Object.freeze({ kind: 'absent' as const })
    return Object.freeze({
      kind: 'present' as const,
      row: Object.freeze({ projectId: row.project_id, objectId: row.object_id, pluginName: row.plugin_name }),
    })
  } catch (error) {
    return Object.freeze({ kind: 'unreadable' as const, sqlState: sqlStateOf(error) })
  }
}

/** The plugin registry: 42P01 = not registered (absent); every other error = unreadable. Classified by SQLSTATE. */
export async function readManualRowsProjectTarget(query: ManualRowsQueryFn, sheetId: string): Promise<ManualRowsProjectTargetRead> {
  try {
    const result = await query(MANUAL_ROWS_PROJECT_TARGET_SQL, [sheetId])
    const row = (Array.isArray(result?.rows) ? result.rows[0] : undefined) as Record<string, unknown> | undefined
    if (!row) return Object.freeze({ kind: 'absent' as const, cause: 'no_row' as const })
    return Object.freeze({
      kind: 'present' as const,
      row: Object.freeze({ sheetId: row.sheet_id, projectNo: row.project_no, status: row.status, objectId: row.object_id, tenantId: row.tenant_id }),
    })
  } catch (error) {
    const sqlState = sqlStateOf(error)
    if (sqlState === UNDEFINED_TABLE_SQLSTATE) return Object.freeze({ kind: 'absent' as const, cause: 'table_missing' as const })
    return Object.freeze({ kind: 'unreadable' as const, sqlState })
  }
}

/** (a): the host registry row names the plugin and a registered project-sheet object id. */
export function isManualRowsProjectSheetHost(read: ManualRowsHostRegistryRead): read is Readonly<{ kind: 'present'; row: ManualRowsHostRegistryRow }> {
  return read.kind === 'present'
    && read.row.pluginName === STOCK_PREPARATION_PROJECT_SHEET_PLUGIN
    && isStockPreparationProjectSheetObjectId(read.row.objectId)
}

// ── the derived column ids ───────────────────────────────────────────────────────────────────────────

export type ManualRowsDerivedFieldIds = Readonly<{
  key: string
  projectNo: string
  active: string
  /** Every template logical id → its physical id on this sheet. */
  byLogical: Readonly<Record<string, string>>
  /** Physical id → template class. */
  classOf: ReadonlyMap<string, ManualRowTemplateClass>
  /** The six fillable columns, physical ids, template order — the ONLY columns the lock exemption covers. */
  fillable: readonly string[]
  /** Lineage ∪ identity/RUN ∪ stamp: no manual-row route writes a value into these. */
  neverWritten: ReadonlySet<string>
  requiredDropped: ReadonlySet<string>
  requiredAdded: readonly string[]
  notClearable: readonly string[]
}>

/** Physical ids as provisioning derives them (getObjectFieldId over the host registry row's project and object). */
export function deriveManualRowsFieldIds(projectId: string, objectId: string): ManualRowsDerivedFieldIds {
  const byLogical: Record<string, string> = {}
  const classOf = new Map<string, ManualRowTemplateClass>()
  for (const [cls, ids] of Object.entries(MANUAL_ROW_TEMPLATE_CLASSES) as Array<[ManualRowTemplateClass, readonly string[]]>) {
    for (const logical of ids) {
      const physical = getObjectFieldId(projectId, objectId, logical)
      byLogical[logical] = physical
      classOf.set(physical, cls)
    }
  }
  const physicalOf = (logical: string) => byLogical[logical]
  const neverWritten = new Set<string>()
  for (const [physical, cls] of classOf) if (MANUAL_ROW_NEVER_WRITTEN_CLASSES.includes(cls)) neverWritten.add(physical)
  return Object.freeze({
    key: physicalOf(MANUAL_ROW_KEY_FIELD_ID),
    projectNo: physicalOf(MANUAL_ROW_PROJECT_NO_FIELD_ID),
    active: physicalOf(MANUAL_ROW_ACTIVE_FIELD_ID),
    byLogical: Object.freeze(byLogical),
    classOf,
    fillable: Object.freeze(MANUAL_ROW_FILLABLE_FIELD_IDS.map(physicalOf)),
    neverWritten,
    requiredDropped: new Set(MANUAL_ROW_REQUIRED_DROPPED_FIELD_IDS.map(physicalOf)),
    requiredAdded: Object.freeze(MANUAL_ROW_REQUIRED_ADDED_FIELD_IDS.map(physicalOf)),
    notClearable: Object.freeze(MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS.map(physicalOf)),
  })
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────────

export type ManualRowsUnavailableReason =
  | 'lock_missing'
  | 'project_archived'
  | 'project_sheets_off'
  | 'contract_mismatch'
  | 'registry_unreadable'

export type ManualRowsState = 'allowed' | 'disabled' | 'unavailable'

/** A P_reg sheet, as far as the gate could establish it. */
export type ManualRowsSheet = Readonly<{
  sheetId: string
  hostProjectId: string
  hostObjectId: string
  derived: ManualRowsDerivedFieldIds
  /** The plugin registry row's project number (the 项目号 stamp); null when it could not be read. */
  projectNo: string | null
}>

export type ManualRowsVerdict =
  | Readonly<{ kind: 'not_project_sheet' }>
  | Readonly<{ kind: 'allowed'; sheet: ManualRowsSheet }>
  | Readonly<{ kind: 'disabled'; sheet: ManualRowsSheet }>
  | Readonly<{ kind: 'unavailable'; reason: ManualRowsUnavailableReason; sheet: ManualRowsSheet | null }>

const NOT_PROJECT_SHEET: ManualRowsVerdict = Object.freeze({ kind: 'not_project_sheet' as const })
const TARGET_STATUSES: ReadonlySet<unknown> = new Set(['active', 'archived'])

function unavailable(reason: ManualRowsUnavailableReason, sheet: ManualRowsSheet | null): ManualRowsVerdict {
  return Object.freeze({ kind: 'unavailable' as const, reason, sheet })
}

/**
 * Pure. `mode: 'create'` runs conditions 2–6 (5 only when `flagOn` is given — the in-transaction re-check omits it, as
 * ADR §3.2 names only 3, 4 and 6 there); `mode: 'edit'` asks what the edit route needs (ADR §3.4): P_reg, the
 * structural contract and the key column's lock — an archived project, the deployment switch and the per-sheet switch
 * do NOT stop an edit (§4 「关闭的含义」, §6 归档对比).
 */
export function evaluateManualRowsGate(input: {
  sheetId: string
  fields: ReadonlyArray<GateFieldLike>
  host: ManualRowsHostRegistryRead
  target: ManualRowsProjectTargetRead | null
  mode: 'create' | 'edit'
  flagOn?: boolean
}): ManualRowsVerdict {
  const { sheetId, fields, host, mode } = input
  if (!fieldsCarryExactStockPreparationStanza(fields)) return NOT_PROJECT_SHEET
  if (host.kind === 'unreadable') return unavailable('registry_unreadable', null)
  if (!isManualRowsProjectSheetHost(host)) return NOT_PROJECT_SHEET
  const target = input.target
  if (!target) throw new TypeError('evaluateManualRowsGate: the plugin registry must be read for a project-sheet host row')
  if (target.kind === 'unreadable') return unavailable('registry_unreadable', null)
  if (target.kind === 'absent') return NOT_PROJECT_SHEET

  const hostObjectId = host.row.objectId as string
  if (!isNonBlankString(host.row.projectId)) return unavailable('contract_mismatch', null)
  const hostProjectId = host.row.projectId
  const derived = deriveManualRowsFieldIds(hostProjectId, hostObjectId)
  const row = target.row
  const projectNo = isNonBlankString(row.projectNo) ? row.projectNo : null
  const sheet: ManualRowsSheet = Object.freeze({ sheetId, hostProjectId, hostObjectId, derived, projectNo })

  // (b) and the derivation agree: exactly ONE key column, and it is the one the host registry row derives.
  const keyFieldIds = resolvePlmKeyFieldIds(fields)
  if (keyFieldIds.length !== 1 || keyFieldIds[0] !== derived.key) return unavailable('contract_mismatch', sheet)
  const propertyById = new Map<string, unknown>()
  for (const field of fields) if (typeof field?.id === 'string') propertyById.set(field.id, field.property)
  const needed = mode === 'create'
    ? [derived.key, derived.projectNo, derived.active, ...derived.requiredAdded, derived.byLogical.totalQuantity]
    : [derived.key]
  if (!needed.every((id) => propertyById.has(id))) return unavailable('contract_mismatch', sheet)

  // 3: the locks. An edit needs the key's lock only (ADR §3.4 「K 已加锁」).
  const locked = mode === 'create' ? [derived.key, derived.projectNo, derived.active] : [derived.key]
  if (!locked.every((id) => humanWriteLockKindOfProperty(propertyById.get(id)) !== null)) return unavailable('lock_missing', sheet)

  // 4: the plugin registry row — well formed, the same object, and (for a create) active.
  if (row.sheetId !== sheetId || projectNo === null || !isNonBlankString(row.tenantId) || typeof row.objectId !== 'string' || !TARGET_STATUSES.has(row.status)) {
    return unavailable('contract_mismatch', sheet)
  }
  if (row.objectId !== hostObjectId) return unavailable('contract_mismatch', sheet)
  if (mode === 'edit') return Object.freeze({ kind: 'allowed' as const, sheet })
  if (row.status !== 'active') return unavailable('project_archived', sheet)

  // 5: the deployment switch (route and /context only).
  if (input.flagOn === false) return unavailable('project_sheets_off', sheet)

  // 6: the per-sheet switch, on the key column.
  if (manualRowsPolicyOfProperty(propertyById.get(derived.key)) === MANUAL_ROWS_POLICY_DISABLED) {
    return Object.freeze({ kind: 'disabled' as const, sheet })
  }
  return Object.freeze({ kind: 'allowed' as const, sheet })
}

/** Reads both registries (the plugin one only for a project-sheet host row) and evaluates. Never throws on a read. */
export async function loadManualRowsVerdict(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<GateFieldLike>,
  mode: 'create' | 'edit',
  flagOn?: boolean,
): Promise<ManualRowsVerdict> {
  // An ordinary sheet (no exact stanza) issues no statement at all.
  if (!fieldsCarryExactStockPreparationStanza(fields)) return NOT_PROJECT_SHEET
  const host = await readManualRowsHostRegistry(query, sheetId)
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, sheetId) : null
  return evaluateManualRowsGate({ sheetId, fields, host, target, mode, flagOn })
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────

export const STOCK_PREP_MANUAL_ROWS_DISABLED_CODE = 'STOCK_PREP_MANUAL_ROWS_DISABLED'
export const STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE = 'STOCK_PREP_MANUAL_ROWS_UNAVAILABLE'
/** The edit route on a row that is not a manual supplementary row (M fails). */
export const STOCK_PREP_MANUAL_ROW_REQUIRED_CODE = 'STOCK_PREP_MANUAL_ROW_REQUIRED'
/** The edit route was handed a column outside the six fillable ones. */
export const STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE_CODE = 'STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE'

export type ManualRowsRefusalReason = ManualRowsUnavailableReason | 'not_project_sheet' | 'disabled' | 'not_manual_row'

/** zh, shown as-is by the web (ADR §3.1's table; the two route-only reasons are this slice's). */
export const MANUAL_ROWS_REFUSAL_MESSAGES: Readonly<Record<ManualRowsRefusalReason, string>> = Object.freeze({
  disabled: '本项目表已关闭「允许人工补充行」，不能新增行；如需新增请联系备料管理员。',
  lock_missing: '本表的 PLM 列锁还没有补齐，暂时不能新增行；请联系管理员修复本表。',
  project_archived: '本项目的备料表已归档，不能新增行。',
  project_sheets_off: '「一个项目一张备料表」功能未开启，不能在这张表上新增行。',
  contract_mismatch: '本表结构与备料模板不一致，暂时不能新增行；请联系管理员核对本表。',
  registry_unreadable: '暂时读不到项目登记信息，请稍后重试；仍不行请联系管理员。',
  not_project_sheet: '这张表不是已登记的备料项目表，不能使用人工补充行。',
  not_manual_row: '这一行不是人工补充行，不能用这个入口修改；请照常编辑。',
})

function refusalCodeOf(reason: ManualRowsRefusalReason): string {
  if (reason === 'disabled') return STOCK_PREP_MANUAL_ROWS_DISABLED_CODE
  if (reason === 'not_manual_row') return STOCK_PREP_MANUAL_ROW_REQUIRED_CODE
  return STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE
}

export class StockPrepManualRowsRefusedError extends Error {
  readonly status: number
  readonly code: string
  constructor(readonly reason: ManualRowsRefusalReason) {
    super(MANUAL_ROWS_REFUSAL_MESSAGES[reason])
    this.name = 'StockPrepManualRowsRefusedError'
    this.code = refusalCodeOf(reason)
    this.status = reason === 'registry_unreadable' ? 503 : 409
  }

  body(): { ok: false; error: { code: string; message: string; details: { reason: ManualRowsRefusalReason } } } {
    return { ok: false, error: { code: this.code, message: this.message, details: { reason: this.reason } } }
  }
}

/** Refuses unless the verdict allows; returns the sheet otherwise. */
export function assertManualRowsAllowed(verdict: ManualRowsVerdict): ManualRowsSheet {
  if (verdict.kind === 'allowed') return verdict.sheet
  if (verdict.kind === 'not_project_sheet') throw new StockPrepManualRowsRefusedError('not_project_sheet')
  if (verdict.kind === 'disabled') throw new StockPrepManualRowsRefusedError('disabled')
  throw new StockPrepManualRowsRefusedError(verdict.reason)
}

// ── /context (ADR §3.7) ──────────────────────────────────────────────────────────────────────────────

export type ManualRowsContextBlock = {
  state: ManualRowsState
  reason?: ManualRowsUnavailableReason
  editableFieldIds: string[]
  requiredFieldIds: string[]
}

function explicitlyRequired(property: unknown): boolean {
  const rules = normalizeProperty(property)?.validation
  return Array.isArray(rules) && rules.some((rule) => Boolean(rule) && typeof rule === 'object' && (rule as { type?: unknown }).type === 'required')
}

/**
 * The columns a manual-row create needs a value for, in field order: 名称 (required for this create), then every column
 * whose own validation requires it — except the three the server stamps and the two the create drops.
 */
export function manualRowRequiredFieldIds(fields: ReadonlyArray<GateFieldLike>, sheet: ManualRowsSheet): string[] {
  const stamped = new Set(MANUAL_ROW_STAMP_FIELD_IDS.map((logical) => sheet.derived.byLogical[logical]))
  const added = new Set(sheet.derived.requiredAdded)
  const out: string[] = []
  for (const field of fields) {
    const id = field?.id
    if (typeof id !== 'string' || stamped.has(id) || sheet.derived.requiredDropped.has(id)) continue
    if (added.has(id) || explicitlyRequired(field.property)) out.push(id)
  }
  return out
}

/** The block a P_reg sheet's /context carries; null for every other sheet (the body then stays byte-identical). */
export function manualRowsContextBlockOf(verdict: ManualRowsVerdict, fields: ReadonlyArray<GateFieldLike>): ManualRowsContextBlock | null {
  if (verdict.kind === 'not_project_sheet') return null
  const sheet = verdict.sheet
  const present = new Set(fields.map((field) => field?.id).filter((id): id is string => typeof id === 'string'))
  const editableFieldIds = sheet ? sheet.derived.fillable.filter((id) => present.has(id)) : []
  const requiredFieldIds = sheet ? manualRowRequiredFieldIds(fields, sheet) : []
  if (verdict.kind === 'unavailable') return { state: 'unavailable', reason: verdict.reason, editableFieldIds, requiredFieldIds }
  return { state: verdict.kind, editableFieldIds, requiredFieldIds }
}

/**
 * GET /context's block (only for an actor who can create, edit or delete — the caller decides). A sheet without the
 * exact stanza issues no statement. Never throws: a registry that cannot be read is `unavailable/registry_unreadable`.
 */
export async function resolveManualRowsContextBlock(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<GateFieldLike>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManualRowsContextBlock | null> {
  const verdict = await loadManualRowsVerdict(query, sheetId, fields, 'create', stockPrepProjectSheetsEnabledForManualRows(env))
  return manualRowsContextBlockOf(verdict, fields)
}

// ── the create extension (ADR §3.2 「实现」) ───────────────────────────────────────────────────────────

export type ManualRowCreateOrigin = 'create' | 'copy'

/** Minted only here. Carries the sheet and the host registry identity the gate saw; no capability of any kind. */
export type ManualRowCreateExtension = Readonly<{
  sheetId: string
  hostProjectId: string
  hostObjectId: string
  origin: ManualRowCreateOrigin
}>

const MINTED_MANUAL_ROW_EXTENSIONS = new WeakSet<object>()

export function mintManualRowCreateExtension(sheet: ManualRowsSheet, origin: ManualRowCreateOrigin): ManualRowCreateExtension {
  const extension = Object.freeze({ sheetId: sheet.sheetId, hostProjectId: sheet.hostProjectId, hostObjectId: sheet.hostObjectId, origin })
  MINTED_MANUAL_ROW_EXTENSIONS.add(extension)
  return extension
}

export function isMintedManualRowCreateExtension(value: unknown): value is ManualRowCreateExtension {
  return typeof value === 'object' && value !== null && MINTED_MANUAL_ROW_EXTENSIONS.has(value)
}

/**
 * Inside the create transaction, after the fence: conditions 3, 4 and 6 on the RE-READ fields (raw `meta_fields` rows)
 * and on both registries read on the transaction's own query — and the host registry must still be the one the route
 * minted the extension from. Returns the sheet the create stamps from; throws the refusal otherwise.
 */
export async function assertManualRowCreateInTransaction(
  query: ManualRowsQueryFn,
  extension: ManualRowCreateExtension,
  fieldRows: ReadonlyArray<GateFieldLike>,
): Promise<ManualRowsSheet> {
  const host = await readManualRowsHostRegistry(query, extension.sheetId)
  if (host.kind === 'present' && (host.row.projectId !== extension.hostProjectId || host.row.objectId !== extension.hostObjectId)) {
    throw new StockPrepManualRowsRefusedError('contract_mismatch')
  }
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, extension.sheetId) : null
  const sheet = assertManualRowsAllowed(evaluateManualRowsGate({ sheetId: extension.sheetId, fields: fieldRows, host, target, mode: 'create' }))
  if (sheet.projectNo === null) throw new StockPrepManualRowsRefusedError('contract_mismatch')
  return sheet
}

/**
 * The edit route's in-transaction re-check (ADR §3.4), run by RecordWriteService.patchRecords as its pre-write guard
 * — after the fence, before the record is read for the patch: the record row is locked FOR UPDATE and must STILL be a
 * manual supplementary row (M), and the sheet must still pass the edit gate on fields and registries re-read on the
 * transaction's own query, with the same host registry identity the route resolved. Throws the refusal otherwise.
 */
export async function assertManualRowEditInTransaction(
  query: ManualRowsQueryFn,
  sheet: ManualRowsSheet,
  recordId: string,
): Promise<void> {
  const recordRes = await query('SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE', [sheet.sheetId, recordId])
  const record = (Array.isArray(recordRes?.rows) ? recordRes.rows[0] : undefined) as Record<string, unknown> | undefined
  const fieldRes = await query('SELECT id, property FROM meta_fields WHERE sheet_id = $1', [sheet.sheetId])
  const host = await readManualRowsHostRegistry(query, sheet.sheetId)
  if (host.kind === 'present' && (host.row.projectId !== sheet.hostProjectId || host.row.objectId !== sheet.hostObjectId)) {
    throw new StockPrepManualRowsRefusedError('contract_mismatch')
  }
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, sheet.sheetId) : null
  const fresh = assertManualRowsAllowed(evaluateManualRowsGate({
    sheetId: sheet.sheetId,
    fields: (Array.isArray(fieldRes?.rows) ? fieldRes.rows : []) as Array<{ id?: unknown; property?: unknown }>,
    host,
    target,
    mode: 'edit',
  }))
  const data = normalizeProperty(record?.data) ?? {}
  if (!record || !isManualSupplementRow({ objectId: fresh.hostObjectId, createdBy: record.created_by, recordId: record.id, key: data[fresh.derived.key] })) {
    throw new StockPrepManualRowsRefusedError('not_manual_row')
  }
}

// ── field helpers the routes share ───────────────────────────────────────────────────────────────────

/**
 * Copies of the six fillable fields with the human write lock removed from `property` (every other field is returned
 * as is). Fed to deriveFieldPermissions / the field-guard builder by the manual-row routes ONLY: the lock-induced
 * read-only goes for exactly these six physical ids, every other restriction (per-subject field_permissions, hidden,
 * always-read-only) stays.
 */
export function liftManualRowFillableLocks<T extends { id: string; property?: Record<string, unknown> }>(fields: readonly T[], sheet: ManualRowsSheet): T[] {
  const fillable = new Set(sheet.derived.fillable)
  return fields.map((field) => (fillable.has(field.id) && field.property
    ? { ...field, property: stripHumanWriteLockKey(field.property) }
    : field))
}

/**
 * ADR §3.3's whitelist for 「复制为新行」: 'read_write' = copied when the actor can read AND write the column;
 * 'never' = never copied. Template columns by class (the six fillable and 备料计划 copy; lineage, 进度与回复, identity /
 * RUN and the stamps never do); a column with the stanza that is not a template column copies only when its ownership
 * is `human_preserved` (the `ext_` rule); a column without the stanza copies like any column.
 */
export function manualRowCopyRule(field: { id: string; property?: unknown }, sheet: ManualRowsSheet): 'read_write' | 'never' {
  const cls = sheet.derived.classOf.get(field.id)
  if (cls) return cls === 'fillable' || cls === 'plan' ? 'read_write' : 'never'
  const property = normalizeProperty(field.property)
  if (property && Object.prototype.hasOwnProperty.call(property, 'stockPreparation')) {
    const stanza = normalizeProperty(property.stockPreparation)
    return stanza?.ownership === 'human_preserved' ? 'read_write' : 'never'
  }
  return 'read_write'
}

/** The validation a manual-row create runs: `required` dropped from componentSourceId / path, added to 名称. */
export function rewriteManualRowValidation<T extends { id: string; config?: { validation?: Array<{ type: string }> } }>(
  validationFields: readonly T[],
  sheet: ManualRowsSheet,
): T[] {
  const added = new Set(sheet.derived.requiredAdded)
  return validationFields.map((field) => {
    const rules = field.config?.validation ?? []
    if (sheet.derived.requiredDropped.has(field.id)) {
      const kept = rules.filter((rule) => rule.type !== 'required')
      return { ...field, config: kept.length > 0 ? { ...field.config, validation: kept } : undefined } as T
    }
    if (added.has(field.id) && !rules.some((rule) => rule.type === 'required')) {
      return { ...field, config: { ...field.config, validation: [...rules, { type: 'required' }] } } as T
    }
    return field
  })
}
