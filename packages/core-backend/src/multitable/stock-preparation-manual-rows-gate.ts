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
 * THE PARENT PAIR (ADR §12, owner-ruled 2026-11-19; slice P1). 父组件图号 / 父组件名称 join the lock exemption (6 + 2 = 8
 * columns) on the same three routes and nowhere else. A request that names the pair is gated additionally on the
 * pair's own columns (`manualRowParentPairGateReason`: present and locked, else `contract_mismatch` / `lock_missing` —
 * the latter with its own sentence when the pair's lock is the only one missing, `MANUAL_ROW_PARENT_LOCK_MISSING_MESSAGE`),
 * judged by rules P3 – P5 (`StockPrepManualRowParentRefusedError`; P5 for an edit inside the write transaction, under
 * the row lock, in both directions) and by the actor's per-subject field permissions for BOTH columns (the routes).
 * P5 on an edit compares the request with a STORED cell of the row, so the edit route first requires that the actor
 * may read the row and that cell (`manualRowEditFieldIdsComparedWithUnreadableCell`) — its answer must never say what
 * a cell the actor cannot read holds.
 * /context names the pair as `parentFieldIds` only to an actor who may write both; never as `editableFieldIds`.
 *
 * GENERIC CREATE (slice B3, ADR §3.1). POST /records and the xlsx import refuse a generic create on a P_reg sheet before
 * RecordService.createRecord, by the same verdict /context reports (`resolveGenericCreateRefusal`, below the /context
 * section); every other sheet keeps its old answer.
 *
 * VALUES-FREE. Refusals carry a closed code, a fixed message and a closed reason token — never a sheet, project number,
 * key or value. Their reader already holds create / edit capability on the sheet.
 */
import { humanWriteLockKindOfProperty, stripHumanWriteLockKey } from './human-write-lock'
import { fieldsCarryExactStockPreparationStanza, resolvePlmKeyFieldIds } from './plm-row-delete-guard'
import { getObjectFieldId } from './provisioning'
import { normalizeProperty } from './record-duplicate-guard'
import { isStockPreparationOverviewSheetIdCandidate } from './stock-preparation-overview-contract'
import { isStockPreparationProjectSheetObjectId } from './stock-preparation-project-sheet-grant-contract'
import { STOCK_PREPARATION_PROJECT_SHEET_PLUGIN } from './stock-preparation-project-sheet-schema-clamp'
import {
  MANUAL_ROW_ACTIVE_FIELD_ID,
  MANUAL_ROW_COMPONENT_CODE_FIELD_ID,
  MANUAL_ROW_COMPONENT_NAME_FIELD_ID,
  MANUAL_ROW_DIALOG_FIELD_IDS,
  MANUAL_ROW_FILLABLE_FIELD_IDS,
  MANUAL_ROW_KEY_FIELD_ID,
  MANUAL_ROW_LOCK_EXEMPT_CLASSES,
  MANUAL_ROW_NEVER_WRITTEN_CLASSES,
  MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS,
  MANUAL_ROW_PARENT_CODE_FIELD_ID,
  MANUAL_ROW_PARENT_NAME_FIELD_ID,
  MANUAL_ROW_PROJECT_NO_FIELD_ID,
  MANUAL_ROW_REQUIRED_ADDED_FIELD_IDS,
  MANUAL_ROW_REQUIRED_DROPPED_FIELD_IDS,
  MANUAL_ROW_STAMP_FIELD_IDS,
  MANUAL_ROW_TEMPLATE_CLASSES,
  MANUAL_ROWS_POLICY_DISABLED,
  isBlankManualRowParentValue,
  isManualRowSelfParent,
  isManualSupplementRow,
  isNonBlankString,
  manualRowParentPairProblem,
  manualRowsPolicyOfProperty,
  type ManualRowParentPairProblem,
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
  /**
   * The six fillable columns, physical ids, template order — the columns a manual row's cells are edited ONE BY ONE
   * (/context `editableFieldIds`). The parent pair is not among them.
   */
  fillable: readonly string[]
  /** 父组件图号 / 父组件名称 (ADR §12): the pair a manual-row route may write, only together. */
  parent: Readonly<{ code: string; name: string }>
  /** 图号 / 名称 of the row itself (two of the six): P5 compares 父组件图号 with `componentCode`. */
  componentCode: string
  componentName: string
  /** fillable ∪ the parent pair (8): the ONLY columns the lock exemption covers. */
  lockExempt: ReadonlySet<string>
  /** Identity/RUN ∪ stamp: no manual-row route writes a value into these. */
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
  const lockExempt = new Set<string>()
  for (const [physical, cls] of classOf) {
    if (MANUAL_ROW_NEVER_WRITTEN_CLASSES.includes(cls)) neverWritten.add(physical)
    if (MANUAL_ROW_LOCK_EXEMPT_CLASSES.includes(cls)) lockExempt.add(physical)
  }
  return Object.freeze({
    key: physicalOf(MANUAL_ROW_KEY_FIELD_ID),
    projectNo: physicalOf(MANUAL_ROW_PROJECT_NO_FIELD_ID),
    active: physicalOf(MANUAL_ROW_ACTIVE_FIELD_ID),
    byLogical: Object.freeze(byLogical),
    classOf,
    fillable: Object.freeze(MANUAL_ROW_FILLABLE_FIELD_IDS.map(physicalOf)),
    parent: Object.freeze({ code: physicalOf(MANUAL_ROW_PARENT_CODE_FIELD_ID), name: physicalOf(MANUAL_ROW_PARENT_NAME_FIELD_ID) }),
    componentCode: physicalOf(MANUAL_ROW_COMPONENT_CODE_FIELD_ID),
    componentName: physicalOf(MANUAL_ROW_COMPONENT_NAME_FIELD_ID),
    lockExempt,
    neverWritten,
    requiredDropped: new Set(MANUAL_ROW_REQUIRED_DROPPED_FIELD_IDS.map(physicalOf)),
    requiredAdded: Object.freeze(MANUAL_ROW_REQUIRED_ADDED_FIELD_IDS.map(physicalOf)),
    notClearable: Object.freeze(MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS.map(physicalOf)),
  })
}

/** Does this request (its submitted physical field ids) name 父组件图号 or 父组件名称? */
export function namesManualRowParentPair(derived: Pick<ManualRowsDerivedFieldIds, 'parent'>, submittedFieldIds: Iterable<string> | null | undefined): boolean {
  if (!submittedFieldIds) return false
  for (const fieldId of submittedFieldIds) if (fieldId === derived.parent.code || fieldId === derived.parent.name) return true
  return false
}

/**
 * THE PARENT PAIR'S OWN CONDITION (ADR §12.3 「锁豁免的边界变化」, last bullet). A manual-row route writes the pair only
 * where BOTH columns exist and BOTH carry the human write lock: there the manual-row routes are the pair's only
 * person writers (P1) and rules P3 – P5 hold for every such write. Where a pair column carries no lock, /patch already
 * writes it on every row with none of those rules, and a second, stricter way of writing the same two cells would
 * only make the sheet's state ambiguous — so a request that NAMES the pair is refused there (`lock_missing`; a missing
 * column is `contract_mismatch`), 「复制为新行」 carries neither value, and /context sends no `parentFieldIds`.
 *
 * SCOPE — only a request that names the pair. The gate's other answers are unchanged: a create or an edit that does
 * not touch the pair behaves on such a sheet exactly as before this rule existed.
 */
export function manualRowParentPairGateReason(
  fields: ReadonlyArray<GateFieldLike>,
  derived: Pick<ManualRowsDerivedFieldIds, 'parent'>,
): 'contract_mismatch' | 'lock_missing' | null {
  const pair = [derived.parent.code, derived.parent.name]
  const propertyById = new Map<string, unknown>()
  for (const field of fields) if (typeof field?.id === 'string' && pair.includes(field.id)) propertyById.set(field.id, field.property)
  if (!pair.every((id) => propertyById.has(id))) return 'contract_mismatch'
  if (!pair.every((id) => humanWriteLockKindOfProperty(propertyById.get(id)) !== null)) return 'lock_missing'
  return null
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
  | Readonly<{
    kind: 'unavailable'
    reason: ManualRowsUnavailableReason
    sheet: ManualRowsSheet | null
    /**
     * Present (true) only with `lock_missing`, and only when the locks every manual-row write needs ARE there and the
     * one that is missing is the PARENT PAIR's (ADR §12.3) — so only for a request that names the pair, or the parent
     * picker. It changes the sentence the refusal carries (`MANUAL_ROW_PARENT_LOCK_MISSING_MESSAGE`), nothing else:
     * the code and the reason token are the ones of every `lock_missing`.
     */
    parentPairLock?: true
  }>

const NOT_PROJECT_SHEET: ManualRowsVerdict = Object.freeze({ kind: 'not_project_sheet' as const })
const TARGET_STATUSES: ReadonlySet<unknown> = new Set(['active', 'archived'])

function unavailable(reason: ManualRowsUnavailableReason, sheet: ManualRowsSheet | null): ManualRowsVerdict {
  return Object.freeze({ kind: 'unavailable' as const, reason, sheet })
}

/** `lock_missing` for the parent pair's own lock (the stamped / key columns are locked). */
function parentPairLockMissing(sheet: ManualRowsSheet): ManualRowsVerdict {
  return Object.freeze({ kind: 'unavailable' as const, reason: 'lock_missing' as const, sheet, parentPairLock: true as const })
}

/**
 * Pure. `mode: 'create'` runs conditions 2–6 (5 only when `flagOn` is given — the in-transaction re-check omits it, as
 * ADR §3.2 names only 3, 4 and 6 there); `mode: 'edit'` asks what the edit route needs (ADR §3.4): P_reg, the
 * structural contract and the key column's lock — an archived project, the deployment switch and the per-sheet switch
 * do NOT stop an edit (§4 「关闭的含义」, §6 归档对比).
 *
 * `submittedFieldIds` (ADR §12.3): the physical field ids the request writes. When they name 父组件图号 or 父组件名称, BOTH
 * pair columns must exist (`contract_mismatch` otherwise) and carry the lock (`lock_missing` otherwise), in either
 * mode — see `manualRowParentPairGateReason` for why, and why only then. Omitted or not naming the pair: the verdict is
 * exactly what it was before the pair became writable.
 */
export function evaluateManualRowsGate(input: {
  sheetId: string
  fields: ReadonlyArray<GateFieldLike>
  host: ManualRowsHostRegistryRead
  target: ManualRowsProjectTargetRead | null
  mode: 'create' | 'edit'
  flagOn?: boolean
  submittedFieldIds?: Iterable<string> | null
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
  // The parent pair joins both lists ONLY for a request that names it (ADR §12.3; `manualRowParentPairGateReason`).
  const pair = namesManualRowParentPair(derived, input.submittedFieldIds) ? [derived.parent.code, derived.parent.name] : []
  const needed = mode === 'create'
    ? [derived.key, derived.projectNo, derived.active, ...derived.requiredAdded, derived.byLogical.totalQuantity, ...pair]
    : [derived.key, ...pair]
  if (!needed.every((id) => propertyById.has(id))) return unavailable('contract_mismatch', sheet)

  // 3: the locks. An edit needs the key's lock only (ADR §3.4 「K 已加锁」) — plus the pair's, when it writes the pair.
  // The pair's lock is judged AFTER the others, so a sheet that lacks the key / 项目号 / 有效 lock answers what it
  // always answered; only a sheet that lacks nothing but the pair's lock is told so (`parentPairLock`).
  const isLocked = (id: string) => humanWriteLockKindOfProperty(propertyById.get(id)) !== null
  const locked = mode === 'create' ? [derived.key, derived.projectNo, derived.active] : [derived.key]
  if (!locked.every(isLocked)) return unavailable('lock_missing', sheet)
  if (!pair.every(isLocked)) return parentPairLockMissing(sheet)

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

/**
 * Reads both registries (the plugin one only for a project-sheet host row) and evaluates. Never throws on a read.
 * `submittedFieldIds`: the physical field ids the request writes (see `evaluateManualRowsGate`).
 */
export async function loadManualRowsVerdict(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<GateFieldLike>,
  mode: 'create' | 'edit',
  flagOn?: boolean,
  submittedFieldIds?: Iterable<string> | null,
): Promise<ManualRowsVerdict> {
  // An ordinary sheet (no exact stanza) issues no statement at all.
  if (!fieldsCarryExactStockPreparationStanza(fields)) return NOT_PROJECT_SHEET
  const host = await readManualRowsHostRegistry(query, sheetId)
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, sheetId) : null
  return evaluateManualRowsGate({ sheetId, fields, host, target, mode, flagOn, submittedFieldIds })
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────

export const STOCK_PREP_MANUAL_ROWS_DISABLED_CODE = 'STOCK_PREP_MANUAL_ROWS_DISABLED'
export const STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE = 'STOCK_PREP_MANUAL_ROWS_UNAVAILABLE'
/** The edit route on a row that is not a manual supplementary row (M fails). */
export const STOCK_PREP_MANUAL_ROW_REQUIRED_CODE = 'STOCK_PREP_MANUAL_ROW_REQUIRED'
/** The edit route was handed a column outside the eight it accepts (the six fillable ones and the parent pair). */
export const STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE_CODE = 'STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE'
/** zh, shown as-is by the web. Names the columns by what they are called on the sheet's template, never a value. */
export const STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE_MESSAGE =
  '这个入口只修改人工补充行的图号、名称、规格、材料、用量、总用量，以及父组件图号和父组件名称（这两列要一起提交）；其他列请照常编辑。'

export type ManualRowsRefusalReason = ManualRowsUnavailableReason | 'not_project_sheet' | 'disabled' | 'not_manual_row'

/**
 * zh, shown as-is by the web (ADR §3.1's table; the two route-only reasons are this slice's). These are the sentences
 * of the CREATE path and of every refusal that is not about the parent pair; they are unchanged since B2.
 */
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

/**
 * zh, shown as-is by the web. `lock_missing` when the lock that is missing is the PARENT PAIR's (ADR §12.3): the sheet
 * still takes new rows and edits of the six — what it cannot do is name a parent, so the sentence says that and not
 * 「不能新增行」. Same code (STOCK_PREP_MANUAL_ROWS_UNAVAILABLE) and the same reason token (`lock_missing`) as the
 * create path's refusal; only the sentence differs. Values-free.
 */
export const MANUAL_ROW_PARENT_LOCK_MISSING_MESSAGE = '本表的父组件列还没有加锁，暂时不能指定父组件；请联系管理员修复本表。'

function refusalCodeOf(reason: ManualRowsRefusalReason): string {
  if (reason === 'disabled') return STOCK_PREP_MANUAL_ROWS_DISABLED_CODE
  if (reason === 'not_manual_row') return STOCK_PREP_MANUAL_ROW_REQUIRED_CODE
  return STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE
}

export class StockPrepManualRowsRefusedError extends Error {
  readonly status: number
  readonly code: string
  /**
   * `subject: 'parent_pair'` — only with `lock_missing` — picks the parent pair's sentence. The code, the status and
   * `details.reason` are the same either way.
   */
  constructor(readonly reason: ManualRowsRefusalReason, subject?: 'parent_pair') {
    super(reason === 'lock_missing' && subject === 'parent_pair' ? MANUAL_ROW_PARENT_LOCK_MISSING_MESSAGE : MANUAL_ROWS_REFUSAL_MESSAGES[reason])
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
  throw new StockPrepManualRowsRefusedError(verdict.reason, verdict.parentPairLock === true ? 'parent_pair' : undefined)
}

// ── the parent pair's refusals (ADR §12.3, P3 – P5) ──────────────────────────────────────────────────

/** A request's 父组件图号 / 父组件名称 break rule P3, P4 or P5. One closed code; `details.reason` says which rule. */
export const STOCK_PREP_MANUAL_PARENT_INVALID_CODE = 'STOCK_PREP_MANUAL_PARENT_INVALID'

export type ManualRowParentRefusalReason = ManualRowParentPairProblem | 'self_parent'

/** zh, shown as-is by the web. Values-free: no 图号, name or id. */
export const MANUAL_ROW_PARENT_REFUSAL_MESSAGES: Readonly<Record<ManualRowParentRefusalReason, string>> = Object.freeze({
  pair_incomplete: '父组件图号和父组件名称要一起提交，不能只改其中一列。',
  not_text: '父组件图号和父组件名称只能填文字，或者留空。',
  name_without_code: '只填了父组件名称、没有父组件图号，不能保存；请补上父组件图号，或者把两项都清空。',
  self_parent: '父组件图号不能和这一行自己的图号相同。',
})

/**
 * 400 for a malformed request (P3 a half pair; P4 a value that is neither text nor null), 422 for a well-formed pair
 * the rules do not accept (P4 a name without a 图号; P5 the row as its own parent).
 */
export class StockPrepManualRowParentRefusedError extends Error {
  readonly status: number
  readonly code = STOCK_PREP_MANUAL_PARENT_INVALID_CODE
  constructor(readonly reason: ManualRowParentRefusalReason) {
    super(MANUAL_ROW_PARENT_REFUSAL_MESSAGES[reason])
    this.name = 'StockPrepManualRowParentRefusedError'
    this.status = reason === 'pair_incomplete' || reason === 'not_text' ? 400 : 422
  }

  body(): { ok: false; error: { code: string; message: string; details: { reason: ManualRowParentRefusalReason } } } {
    return { ok: false, error: { code: this.code, message: this.message, details: { reason: this.reason } } }
  }
}

const hasOwn = (data: Readonly<Record<string, unknown>>, fieldId: string) => Object.prototype.hasOwnProperty.call(data, fieldId)

/** P3 + P4 over the pair a request body (physical field id → value) names; null when it is acceptable or not named. */
export function manualRowParentPairProblemOf(sheet: ManualRowsSheet, data: Readonly<Record<string, unknown>>): ManualRowParentPairProblem | null {
  const { code, name } = sheet.derived.parent
  return manualRowParentPairProblem({ hasCode: hasOwn(data, code), hasName: hasOwn(data, name), code: data[code], name: data[name] })
}

/**
 * P3, P4 and P5 for a NEW manual row, whose own 图号 is in the same body (新增 and 复制为新行). Throws the refusal. Called by
 * the create route before anything is written AND by RecordService.createRecord's manual-row branch inside the create
 * transaction, so no caller that reaches the branch can store a pair these rules refuse.
 */
export function assertManualRowParentPairForCreate(sheet: ManualRowsSheet, data: Readonly<Record<string, unknown>>): void {
  const problem = manualRowParentPairProblemOf(sheet, data)
  if (problem) throw new StockPrepManualRowParentRefusedError(problem)
  if (isManualRowSelfParent(data[sheet.derived.parent.code], data[sheet.derived.componentCode])) {
    throw new StockPrepManualRowParentRefusedError('self_parent')
  }
}

// ── /context (ADR §3.7) ──────────────────────────────────────────────────────────────────────────────

export type ManualRowsContextBlock = {
  state: ManualRowsState
  reason?: ManualRowsUnavailableReason
  editableFieldIds: string[]
  requiredFieldIds: string[]
  /** Slice B3: the 新增人工补充行 dialog's columns in its order (MANUAL_ROW_DIALOG_FIELD_IDS, the present ones). */
  dialogFieldIds: string[]
  /**
   * ADR §12.6: the physical ids of 父组件图号 / 父组件名称 — present ONLY when a manual-row route would accept the pair on
   * this sheet (both columns exist and are locked, and the edit gate passes) AND this actor may write both columns
   * (rule P7). Absent otherwise, and the web then shows no parent picker. Independent of `state`: a switched-off or
   * archived sheet still lets the parent of an EXISTING manual row be changed (rule P8), so the key can accompany
   * `disabled` and `unavailable/project_archived`. Never part of `editableFieldIds`.
   */
  parentFieldIds?: { code: string; name: string }
  /**
   * The physical id of the row's OWN 图号 column — what the web compares a chosen parent with before it submits (rule
   * P5, the self-parent pre-check) and what it watches to warn before a 图号 other manual rows name as their parent is
   * changed (ADR §12.7 ①). Present ONLY together with `parentFieldIds`, and only when the column exists on the sheet
   * and this actor may READ it; a block without `parentFieldIds` never carries it and is byte-identical to what it
   * was. Absent beside `parentFieldIds` = this actor cannot read the row's own 图号: the web has nothing to compare
   * with, and PATCH …/manual-fields refuses that actor's change of an EXISTING row's parent (403 — rule P5 would
   * compare with a cell they may not read; a new row can still be given a parent). An id only — never a value.
   */
  componentCodeFieldId?: string
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
  const dialogFieldIds = sheet
    ? MANUAL_ROW_DIALOG_FIELD_IDS.map((logical) => sheet.derived.byLogical[logical]).filter((id): id is string => typeof id === 'string' && present.has(id))
    : []
  if (verdict.kind === 'unavailable') return { state: 'unavailable', reason: verdict.reason, editableFieldIds, requiredFieldIds, dialogFieldIds }
  return { state: verdict.kind, editableFieldIds, requiredFieldIds, dialogFieldIds }
}

/**
 * Pure. THE PARENT PAIR'S GATE: the EDIT gate evaluated for a request that names both pair columns — the weakest gate
 * under which any of the three routes writes the pair (the create gate only adds conditions to it). So it answers
 * `lock_missing` / `contract_mismatch` for the pair exactly as the routes do, and it does not look at the switch, the
 * archive status or the deployment switch (rule P8: a switched-off or archived sheet still lets an existing manual
 * row's parent be changed). Evaluated in two steps so the pair's ids come from the gate's own derivation.
 */
export function evaluateManualRowParentPairGate(input: {
  sheetId: string
  fields: ReadonlyArray<GateFieldLike>
  host: ManualRowsHostRegistryRead
  target: ManualRowsProjectTargetRead | null
}): ManualRowsVerdict {
  const edit = evaluateManualRowsGate({ ...input, mode: 'edit' })
  if (edit.kind !== 'allowed') return edit
  const { code, name } = edit.sheet.derived.parent
  return evaluateManualRowsGate({ ...input, mode: 'edit', submittedFieldIds: [code, name] })
}

/**
 * The parent pair's gate with its two registry reads — what GET …/manual-rows/parent-options is gated on (ADR §12.6
 * 「P_reg 按修改的口径判断」). Never throws on a read.
 */
export async function loadManualRowParentPairVerdict(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<GateFieldLike>,
): Promise<ManualRowsVerdict> {
  // An ordinary sheet (no exact stanza) issues no statement at all.
  if (!fieldsCarryExactStockPreparationStanza(fields)) return NOT_PROJECT_SHEET
  const host = await readManualRowsHostRegistry(query, sheetId)
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, sheetId) : null
  return evaluateManualRowParentPairGate({ sheetId, fields, host, target })
}

/**
 * GET /context's block (only for an actor who can create, edit or delete — the caller decides). A sheet without the
 * exact stanza issues no statement. Never throws: a registry that cannot be read is `unavailable/registry_unreadable`.
 *
 * `actorCanWriteParentPair` (ADR §12.6, rule P7): the route's answer to "may THIS actor write both pair columns?",
 * asked only for a sheet on which the routes accept the pair at all. `parentFieldIds` is sent only when it says yes;
 * without the callback the key is never sent. No statement beyond the two registry reads the block already cost.
 *
 * `actorCanReadField`: the route's answer to "may THIS actor read this column?" (layer-2 ∧ layer-3). It is asked about
 * ONE column, the row's own 图号, and only once `parentFieldIds` is being sent: `componentCodeFieldId` accompanies the
 * pair when the column exists on the sheet and the answer is yes. Without the callback the key is never sent.
 */
export async function resolveManualRowsContextBlock(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<GateFieldLike>,
  env: NodeJS.ProcessEnv = process.env,
  actorCanWriteParentPair?: (sheet: ManualRowsSheet) => boolean,
  actorCanReadField?: (fieldId: string) => boolean,
): Promise<ManualRowsContextBlock | null> {
  // An ordinary sheet (no exact stanza) issues no statement at all.
  if (!fieldsCarryExactStockPreparationStanza(fields)) return null
  const host = await readManualRowsHostRegistry(query, sheetId)
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, sheetId) : null
  const verdict = evaluateManualRowsGate({ sheetId, fields, host, target, mode: 'create', flagOn: stockPrepProjectSheetsEnabledForManualRows(env) })
  const block = manualRowsContextBlockOf(verdict, fields)
  if (!block || !actorCanWriteParentPair) return block
  const pairVerdict = evaluateManualRowParentPairGate({ sheetId, fields, host, target })
  if (pairVerdict.kind === 'allowed' && actorCanWriteParentPair(pairVerdict.sheet)) {
    const { derived } = pairVerdict.sheet
    block.parentFieldIds = { code: derived.parent.code, name: derived.parent.name }
    // The row's own 图号, beside the pair and never without it: the column must exist, and the actor must be able to read it.
    const componentCodeExists = fields.some((field) => field?.id === derived.componentCode)
    if (componentCodeExists && actorCanReadField?.(derived.componentCode) === true) block.componentCodeFieldId = derived.componentCode
  }
  return block
}

// ── generic create on a P_reg sheet (ADR §3.1, slice B3) ─────────────────────────────────────────────
//
// POST /records (session and `mst_` tokens share that route) and POST /sheets/:sheetId/import-xlsx refuse a generic
// create on a P_reg sheet BEFORE RecordService.createRecord, by the SAME verdict /context's block reports (one
// `loadManualRowsVerdict(…, 'create', flag)` — so the refusal and the web's hidden entries can never disagree about a
// sheet's state): 409, or 503 when a registry cannot be read, with the §3.1 code and text. Only `allowed` points at
// 「新增人工补充行」. Every other sheet keeps its old answer (an ordinary sheet's 200 / 422 / 403; a sheet only provisioned
// without a plugin registry row — PB-05 — keeps its 403 / 422).

/** §3.1 row `allowed`: rows on this sheet are added through 「新增人工补充行」 (PLM rows come from the pull). */
export const STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE = 'STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW'
export const GENERIC_CREATE_USE_MANUAL_ROW_MESSAGE = '备料项目表上请用「新增人工补充行」新增行；PLM 行由拉取写入。'

/** Values-free details: the block's own state (and, except for `allowed`, the reason token the manual-row routes use). */
export type GenericCreateRefusalDetails =
  | Readonly<{ state: 'allowed' }>
  | Readonly<{ state: 'disabled'; reason: 'disabled' }>
  | Readonly<{ state: 'unavailable'; reason: ManualRowsUnavailableReason }>

export class StockPrepGenericCreateRefusedError extends Error {
  readonly status: number
  readonly code: string
  constructor(readonly details: GenericCreateRefusalDetails) {
    super(details.state === 'allowed' ? GENERIC_CREATE_USE_MANUAL_ROW_MESSAGE : MANUAL_ROWS_REFUSAL_MESSAGES[details.reason])
    this.name = 'StockPrepGenericCreateRefusedError'
    this.code = details.state === 'allowed'
      ? STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE
      : details.state === 'disabled' ? STOCK_PREP_MANUAL_ROWS_DISABLED_CODE : STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE
    this.status = details.state === 'unavailable' && details.reason === 'registry_unreadable' ? 503 : 409
  }

  body(): { ok: false; error: { code: string; message: string; details: GenericCreateRefusalDetails } } {
    return { ok: false, error: { code: this.code, message: this.message, details: this.details } }
  }
}

/** Pure. The §3.1 refusal for a P_reg sheet's generic create; null for every other sheet (the old behaviour stays). */
export function genericCreateRefusalOf(verdict: ManualRowsVerdict): StockPrepGenericCreateRefusedError | null {
  if (verdict.kind === 'not_project_sheet') return null
  if (verdict.kind === 'allowed') return new StockPrepGenericCreateRefusedError(Object.freeze({ state: 'allowed' as const }))
  if (verdict.kind === 'disabled') return new StockPrepGenericCreateRefusedError(Object.freeze({ state: 'disabled' as const, reason: 'disabled' as const }))
  return new StockPrepGenericCreateRefusedError(Object.freeze({ state: 'unavailable' as const, reason: verdict.reason }))
}

/**
 * The two generic-create routes' one call. `fields` is the route's own fresh field read, or a loader for a route that
 * has none before the create (POST /records). A sheet id outside the plugin-derived shape (`sheet_` + 24 hex) can never
 * be a registered project sheet — the R-66 ② lookup drops it the same way before its statement
 * (stock-preparation-project-sheet-schema-clamp.ts loadStockPreparationProjectSheetIds, the lookup (a) is defined by) —
 * so such a sheet (every sheet a person creates) costs no statement here; a sheet without the exact stanza costs none
 * beyond the field read. Never throws on a registry read (unreadable → 503 registry_unreadable).
 */
export async function resolveGenericCreateRefusal(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<GateFieldLike> | (() => Promise<ReadonlyArray<GateFieldLike>>),
  env: NodeJS.ProcessEnv = process.env,
): Promise<StockPrepGenericCreateRefusedError | null> {
  if (!isStockPreparationOverviewSheetIdCandidate(sheetId)) return null
  const loaded = typeof fields === 'function' ? await fields() : fields
  const verdict = await loadManualRowsVerdict(query, sheetId, loaded, 'create', stockPrepProjectSheetsEnabledForManualRows(env))
  return genericCreateRefusalOf(verdict)
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
 *
 * `submittedFieldIds`: the field ids of the create's own data. When they name the parent pair, the pair's condition
 * (both columns present and locked, ADR §12.3) is re-checked here too, on the same re-read fields — derived from the
 * data itself, never from a flag on the extension.
 */
export async function assertManualRowCreateInTransaction(
  query: ManualRowsQueryFn,
  extension: ManualRowCreateExtension,
  fieldRows: ReadonlyArray<GateFieldLike>,
  submittedFieldIds?: Iterable<string> | null,
): Promise<ManualRowsSheet> {
  const host = await readManualRowsHostRegistry(query, extension.sheetId)
  if (host.kind === 'present' && (host.row.projectId !== extension.hostProjectId || host.row.objectId !== extension.hostObjectId)) {
    throw new StockPrepManualRowsRefusedError('contract_mismatch')
  }
  const target = isManualRowsProjectSheetHost(host) ? await readManualRowsProjectTarget(query, extension.sheetId) : null
  const sheet = assertManualRowsAllowed(evaluateManualRowsGate({ sheetId: extension.sheetId, fields: fieldRows, host, target, mode: 'create', submittedFieldIds }))
  if (sheet.projectNo === null) throw new StockPrepManualRowsRefusedError('contract_mismatch')
  return sheet
}

/**
 * The edit route's in-transaction re-check (ADR §3.4), run by RecordWriteService.patchRecords as its pre-write guard
 * — after the fence, before the record is read for the patch: the record row is locked FOR UPDATE and must STILL be a
 * manual supplementary row (M), and the sheet must still pass the edit gate on fields and registries re-read on the
 * transaction's own query, with the same host registry identity the route resolved. Throws the refusal otherwise.
 *
 * `changes` (ADR §12.3): the route's own patch, physical field id → value.
 *   - When it names the parent pair, the pair's condition (both columns present and locked) is part of the re-check.
 *   - RULE P5, BOTH DIRECTIONS, decided HERE and nowhere earlier: when the patch names 父组件图号 (the pair is being
 *     changed) or the row's own 图号 (an ordinary fillable edit, which the grid sends on its own), the row as it WILL be
 *     — the locked row's stored cells overlaid with the patch — must not be its own parent. The route's first read of
 *     the row happens outside this transaction; two edits racing, one setting the parent and one setting the 图号 to
 *     the same text, would each pass a check made on that stale read. Under the row lock the second one sees the
 *     first's committed value and is refused (422 `self_parent`). A patch that names neither column is not judged, so
 *     an unrelated edit never fails on a row's existing cells.
 */
export async function assertManualRowEditInTransaction(
  query: ManualRowsQueryFn,
  sheet: ManualRowsSheet,
  recordId: string,
  changes: Readonly<Record<string, unknown>> = {},
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
    submittedFieldIds: Object.keys(changes),
  }))
  const data = normalizeProperty(record?.data) ?? {}
  if (!record || !isManualSupplementRow({ objectId: fresh.hostObjectId, createdBy: record.created_by, recordId: record.id, key: data[fresh.derived.key] })) {
    throw new StockPrepManualRowsRefusedError('not_manual_row')
  }
  // P3 / P4 again (the route already answered them before the transaction; this guard does not depend on that).
  const pairProblem = manualRowParentPairProblemOf(fresh, changes)
  if (pairProblem) throw new StockPrepManualRowParentRefusedError(pairProblem)
  const parentCodeId = fresh.derived.parent.code
  const componentCodeId = fresh.derived.componentCode
  if (hasOwn(changes, parentCodeId) || hasOwn(changes, componentCodeId)) {
    const merged = (fieldId: string) => (hasOwn(changes, fieldId) ? changes[fieldId] : data[fieldId])
    if (isManualRowSelfParent(merged(parentCodeId), merged(componentCodeId))) throw new StockPrepManualRowParentRefusedError('self_parent')
  }
}

/**
 * RULE P5 READS A STORED CELL — who may be given its answer (ADR §12.3 P5; the anti-oracle rule).
 *
 * `assertManualRowEditInTransaction` decides P5 on the locked, MERGED row: the patch's value where the patch names a
 * column, the row's stored cell otherwise. So
 *   - a patch that names the parent pair but not the row's own 图号 is compared with the STORED 图号, and
 *   - a patch that names 图号 but not 父组件图号 is compared with the STORED 父组件图号,
 * and the 422 `self_parent` it may answer says whether the submitted text EQUALS that stored cell. That answer comes
 * before the write's own checks (the record lock, `expectedVersion`), so a request built to fail one of those would
 * read the cell without writing anything. An actor who may not read the cell must therefore not reach the comparison
 * at all: the edit route refuses the write (403) before the transaction.
 *
 * Returns the SUBMITTED field ids that cannot be written for that reason (empty = nothing to refuse): the pair's
 * columns when the row's own 图号 is not readable for the actor, the 图号 when 父组件图号 is not. Only submitted ids, so
 * the refusal can name them without telling the caller about a column it did not send.
 *   - The pair is one unit here as in rule P7: either of its columns names it.
 *   - A patch that names BOTH 图号 and 父组件图号 is judged on its own two values; no stored cell is read and nothing is
 *     required of the actor.
 * `canReadStoredCell`: the route's answer for ONE column of this sheet — the layer-2 ∧ layer-3 read set through the
 * stored-data chokepoint, and true for a column the sheet does not have (no cell, nothing to learn). Pure.
 */
export function manualRowEditFieldIdsComparedWithUnreadableCell(
  derived: Pick<ManualRowsDerivedFieldIds, 'parent' | 'componentCode'>,
  submittedFieldIds: Iterable<string>,
  canReadStoredCell: (fieldId: string) => boolean,
): string[] {
  const submitted = new Set(submittedFieldIds)
  const { code, name } = derived.parent
  const own = derived.componentCode
  const refused: string[] = []
  if ((submitted.has(code) || submitted.has(name)) && !submitted.has(own) && !canReadStoredCell(own)) {
    for (const fieldId of [code, name]) if (submitted.has(fieldId)) refused.push(fieldId)
  }
  if (submitted.has(own) && !submitted.has(code) && !canReadStoredCell(code)) refused.push(own)
  return refused
}

// ── field helpers the routes share ───────────────────────────────────────────────────────────────────

/**
 * Copies of the eight lock-exempt fields — the six fillable ones and the parent pair (ADR §12.3) — with the human
 * write lock removed from `property` (every other field is returned as is). Fed to deriveFieldPermissions / the
 * field-guard builder by the manual-row routes ONLY: the lock-induced read-only goes for exactly these eight physical
 * ids, every other restriction (per-subject field_permissions, hidden, always-read-only) stays. Whether a route may
 * write the PAIR at all is the gate's question (`manualRowParentPairGateReason`), not this helper's.
 */
export function liftManualRowExemptLocks<T extends { id: string; property?: Record<string, unknown> }>(fields: readonly T[], sheet: ManualRowsSheet): T[] {
  const exempt = sheet.derived.lockExempt
  return fields.map((field) => (exempt.has(field.id) && field.property
    ? { ...field, property: stripHumanWriteLockKey(field.property) }
    : field))
}

/**
 * ADR §3.3's whitelist for 「复制为新行」: 'read_write' = copied when the actor can read AND write the column;
 * 'never' = never copied; 'pair' = the parent pair (ADR §12.5, OQ-P1), which the copy carries BOTH of or NEITHER of
 * and so is decided for the two columns together, never column by column (`manualRowCopyParentPair`). Template columns
 * by class (the six fillable and 备料计划 copy; 进度与回复, identity / RUN and the stamps never do); a column with the
 * stanza that is not a template column copies only when its ownership is `human_preserved` (the `ext_` rule); a
 * column without the stanza copies like any column.
 */
export function manualRowCopyRule(field: { id: string; property?: unknown }, sheet: ManualRowsSheet): 'read_write' | 'pair' | 'never' {
  const cls = sheet.derived.classOf.get(field.id)
  if (cls === 'parent_assignable') return 'pair'
  if (cls) return cls === 'fillable' || cls === 'plan' ? 'read_write' : 'never'
  const property = normalizeProperty(field.property)
  if (property && Object.prototype.hasOwnProperty.call(property, 'stockPreparation')) {
    const stanza = normalizeProperty(property.stockPreparation)
    return stanza?.ownership === 'human_preserved' ? 'read_write' : 'never'
  }
  return 'read_write'
}

/**
 * 「复制为新行」 and the parent pair (ADR §12.5, owner ruling OQ-P1 「带上」). The copy carries the SOURCE row's pair — a PLM
 * row's or a manual row's — only when EVERY one of these holds, and otherwise carries NEITHER column (the copy then
 * lands in the no-parent group; it never fails because of the pair):
 *   - a manual-row route may write the pair on this sheet at all (both columns present and locked);
 *   - the actor can READ both source columns and WRITE both columns (`canRead` / `canWrite` are the route's own
 *     layer-2 ∧ layer-3 answers — a per-subject rule that covers one column only drops both);
 *   - the source pair is acceptable under P4 and names a parent: text or empty, a non-blank 图号 (a PLM child whose
 *     parent has no drawing number holds a name without a 图号 — not carried);
 *   - P5 against the NEW row: the parent is not the copy's own 图号.
 * Returns the entries to add to the copy's data — both keys, the values as the source stores them (an absent name
 * becomes null, so the create still receives the pair together, P3) — or an empty object. Pure.
 */
export function manualRowCopyParentPair(input: {
  fields: ReadonlyArray<GateFieldLike>
  sheet: ManualRowsSheet
  sourceData: Readonly<Record<string, unknown>>
  /** The copy's own 图号 as it will be written (undefined when the copy carries none). */
  copyComponentCode: unknown
  canRead: (fieldId: string) => boolean
  canWrite: (fieldId: string) => boolean
}): Record<string, unknown> {
  const { code, name } = input.sheet.derived.parent
  if (manualRowParentPairGateReason(input.fields, input.sheet.derived) !== null) return {}
  if (![code, name].every((fieldId) => input.canRead(fieldId) && input.canWrite(fieldId))) return {}
  const sourceCode = input.sourceData[code] ?? null
  const sourceName = input.sourceData[name] ?? null
  if (manualRowParentPairProblem({ hasCode: true, hasName: true, code: sourceCode, name: sourceName }) !== null) return {}
  if (isBlankManualRowParentValue(sourceCode)) return {}
  if (isManualRowSelfParent(sourceCode, input.copyComponentCode)) return {}
  return { [code]: sourceCode, [name]: sourceName }
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
