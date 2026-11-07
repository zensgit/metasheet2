import type { Request } from 'express'

/**
 * YiDa standardization slice Y2: prepare a draft from a multitable sheet or view instead of pasted rowsText.
 *
 * The read runs with the OWNER'S OWN multitable permissions, through the same permission primitives the grid
 * read path (`GET /api/multitable/view`) and the export path use: sheet read capability (and export capability,
 * since the rows leave MetaSheet towards YiDa), sheet liveness, the People-sheet bound, field visibility and
 * per-subject field permissions, record permissions and row-level read deny, and the view's filter. There is
 * no elevated or plugin-scoped read. Nothing read here is logged; errors are fixed codes only.
 *
 * The result is EXACTLY the rowsText shape the existing plan builder consumes (a JSON array of objects keyed by
 * the config's `fieldMap[].source` names), so the draft that follows is the draft the same pasted rowsText would
 * have produced (parity is tested). Bounded: at most MAX_SCAN records are read, at most MAX_ROWS rows and
 * MAX_TEXT_BYTES bytes of rowsText may result; past a bound the request is refused, never truncated.
 */
export const YIDA_SHEET_SOURCE_LIMITS = Object.freeze({ maxScan: 2000, maxRows: 100, maxColumns: 64, maxTextBytes: 128 * 1024 })
// Only plainly stored scalar columns. Computed (formula/lookup/rollup), relational (link/person), file,
// multi-value and rich columns are refused rather than coerced.
export const YIDA_SHEET_SOURCE_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'select', 'date',
  'currency', 'percent', 'rating', 'url', 'email', 'phone'])
const COMPUTED_FILTER_TYPES = new Set(['formula', 'lookup', 'rollup'])
const IDENTIFIER = /^[\p{L}\p{N}_-]{1,128}$/u

export type YidaSheetSourceCode = 'INPUT' | 'DENIED' | 'NOT_FOUND' | 'LIMIT' | 'UNSUPPORTED' | 'UNAVAILABLE'
const CODES = new Set<unknown>(['INPUT', 'DENIED', 'NOT_FOUND', 'LIMIT', 'UNSUPPORTED', 'UNAVAILABLE'])
const ownErrors = new WeakMap<object, YidaSheetSourceCode>()
export class YidaSheetSourceError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const fixed = (CODES.has(code) ? code : 'UNAVAILABLE') as YidaSheetSourceCode
    super(`YIDA_SHEET_SOURCE_${fixed}`)
    this.name = 'YidaSheetSourceError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
export function yidaSheetSourceErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : `YIDA_SHEET_SOURCE_${code}`
}
function fail(code: YidaSheetSourceCode): never { throw new YidaSheetSourceError(code) }

export type YidaSheetSourceColumn = Readonly<{ fieldId: string; source: string }>
export type YidaSheetSourceInput = Readonly<{ sheetId: string; viewId?: string; columns: readonly YidaSheetSourceColumn[] }>
export type YidaSheetSourceField = Readonly<{ id: string; type: string; property?: unknown }>
export type YidaSheetSourceAccess = Readonly<{
  userId: string | null; isAdminRole: boolean; canRead: boolean; canExport: boolean
  live: boolean; bounded: boolean; capabilities: unknown
}>
type FilterNode = unknown
type FilterLeaf = Readonly<{ fieldId: string }>
export type YidaSheetSourceDependencies = Readonly<{
  resolveAccess(req: Request, sheetId: string): Promise<YidaSheetSourceAccess>
  loadFields(sheetId: string): Promise<readonly YidaSheetSourceField[]>
  readableFieldIds(sheetId: string, userId: string, fields: readonly YidaSheetSourceField[], capabilities: unknown): Promise<ReadonlySet<string>>
  loadView(viewId: string): Promise<Readonly<{ sheetId: string; filterInfo: unknown }> | null>
  loadRecords(sheetId: string, limit: number): Promise<readonly Readonly<{ id: string; data: unknown }>[]>
  readableRecordIds(sheetId: string, userId: string, isAdminRole: boolean, recordIds: readonly string[], capabilities: unknown): Promise<ReadonlySet<string>>
  filter: Readonly<{
    parse(filterInfo: unknown): FilterNode | null
    prune(node: FilterNode, keep: (leaf: FilterLeaf) => boolean): FilterNode | null
    leaves(node: FilterNode): readonly FilterLeaf[]
    evaluate(node: FilterNode, leaf: (leaf: FilterLeaf) => boolean): boolean
    leafMatches(fieldType: string, value: unknown, leaf: FilterLeaf): boolean
    effectiveType(field: YidaSheetSourceField): string
  }>
  /**
   * Source binding (design baseline v2.3 §7.2): the ACTIVE project-sheet registry row (migration 087) that names
   * this sheet for the request's verified tenant, or null when the sheet is not a registered project sheet. Only
   * a registered sheet yields a binding; without this dependency every read stays unbound (pasted-text shape).
   */
  resolveProjectSheet?(req: Request, sheetId: string): Promise<Readonly<{ projectNo: string }> | null>
}>
/**
 * The binding the server captured while reading a registered project sheet (never reconstructible from
 * rowsText): the sheet, its key column (the template column flagged `stockPreparation.key`), the alias → field
 * id map of the columns actually read, and per row the record id, the key cell and the registered project.
 * `records[i]` is the row `rowsText[i]` came from. The draft compiler turns it into the two row digests.
 */
export type YidaSheetSourceBinding = Readonly<{
  sheetId: string; keyFieldId: string; fieldBindings: Readonly<Record<string, string>>
  records: readonly Readonly<{ recordId: string; keyValue: string; projectNo: string }>[]
}>
const MAX_KEY_VALUE_LENGTH = 4096
function isKeyColumn(field: YidaSheetSourceField): boolean {
  const property = field.property
  if (!property || typeof property !== 'object' || Array.isArray(property)) return false
  const marker = (property as Record<string, unknown>).stockPreparation
  return Boolean(marker) && typeof marker === 'object' && !Array.isArray(marker) && (marker as Record<string, unknown>).key === true
}

function literal(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
/** Closed, values-free capture of the request's `source` object (route body). */
export function parseYidaSheetSourceInput(value: unknown): YidaSheetSourceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.some(key => !['kind', 'sheetId', 'viewId', 'columns'].includes(key))
    || row.kind !== 'sheet' || !Object.hasOwn(row, 'sheetId') || !Object.hasOwn(row, 'columns')) fail('INPUT')
  const sheetId = literal(row.sheetId)
  const viewId = Object.hasOwn(row, 'viewId') ? literal(row.viewId) : undefined
  if (!Array.isArray(row.columns) || row.columns.length < 1 || row.columns.length > YIDA_SHEET_SOURCE_LIMITS.maxColumns) fail('INPUT')
  const fieldIds = new Set<string>(), sources = new Set<string>()
  const columns = row.columns.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INPUT')
    const column = item as Record<string, unknown>
    const names = Object.keys(column)
    if (names.length !== 2 || !Object.hasOwn(column, 'fieldId') || !Object.hasOwn(column, 'source')) fail('INPUT')
    const fieldId = literal(column.fieldId), source = literal(column.source)
    if (!IDENTIFIER.test(source) || fieldIds.has(fieldId) || sources.has(source)) fail('INPUT')
    fieldIds.add(fieldId); sources.add(source)
    return Object.freeze({ fieldId, source })
  })
  return Object.freeze({ sheetId, ...(viewId === undefined ? {} : { viewId }), columns: Object.freeze(columns) })
}

function cell(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  fail('UNSUPPORTED')
}

/**
 * Reads the mapped columns of the owner-visible rows and returns rowsText for the existing draft compiler.
 * Never returns values other than inside rowsText, and never logs. When the sheet is a REGISTERED project
 * sheet the result also carries the source binding (record ids, key cells, registered project), which the
 * host hands to the draft compiler and which never enters rowsText; a registered sheet whose key column is
 * not among the read columns, or whose row lacks a key, is refused rather than drafted unbound.
 */
export async function readYidaSheetSourceRows(req: Request, input: YidaSheetSourceInput,
  dependencies: YidaSheetSourceDependencies): Promise<Readonly<{ rowsText: string; rowCount: number; binding?: YidaSheetSourceBinding }>> {
  try {
    const access = await dependencies.resolveAccess(req, input.sheetId)
    if (!access.userId) fail('DENIED')
    // No read and no export = no rows towards YiDa. Liveness answers after the capability (no oracle).
    if (!access.canRead || !access.canExport) fail('DENIED')
    if (!access.live) fail('NOT_FOUND')
    // The People system sheet is never bulk-exported (export path parity).
    if (access.bounded) fail('DENIED')
    const fields = await dependencies.loadFields(input.sheetId)
    const byId = new Map(fields.map(field => [field.id, field] as const))
    const readable = await dependencies.readableFieldIds(input.sheetId, access.userId, fields, access.capabilities)
    for (const column of input.columns) {
      const field = byId.get(column.fieldId)
      // Unknown and unreadable look the same: the column cannot be used.
      if (!field || !readable.has(field.id)) fail('INPUT')
      if (!YIDA_SHEET_SOURCE_FIELD_TYPES.has(field.type)) fail('UNSUPPORTED')
    }
    // Binding (§7.2): only a registered, active project sheet is bound. Exactly one key column must exist, it
    // must be one of the read (so owner-readable) columns, and the registered project is every row's project.
    const registered = dependencies.resolveProjectSheet ? await dependencies.resolveProjectSheet(req, input.sheetId) : null
    let keyFieldId: string | null = null
    if (registered) {
      literal(registered.projectNo)
      const keyColumns = fields.filter(isKeyColumn)
      if (keyColumns.length !== 1) fail('UNSUPPORTED')
      keyFieldId = keyColumns[0].id
      if (!input.columns.some(column => column.fieldId === keyFieldId)) fail('INPUT')
    }
    const boundRecords: Array<{ recordId: string; keyValue: string; projectNo: string }> = []
    let filter: FilterNode | null = null
    if (input.viewId !== undefined) {
      const view = await dependencies.loadView(input.viewId)
      if (!view || view.sheetId !== input.sheetId) fail('NOT_FOUND')
      const parsed = dependencies.filter.parse(view.filterInfo)
      // Same selection rule as the grid: a leaf on a field the owner cannot read is treated as absent.
      filter = parsed ? dependencies.filter.prune(parsed, leaf => byId.has(leaf.fieldId) && readable.has(leaf.fieldId)) : null
      if (filter && dependencies.filter.leaves(filter).some(leaf => {
        const field = byId.get(leaf.fieldId)
        return !field || COMPUTED_FILTER_TYPES.has(field.type) || COMPUTED_FILTER_TYPES.has(dependencies.filter.effectiveType(field))
      })) fail('UNSUPPORTED')
    }
    const records = await dependencies.loadRecords(input.sheetId, YIDA_SHEET_SOURCE_LIMITS.maxScan + 1)
    if (records.length > YIDA_SHEET_SOURCE_LIMITS.maxScan) fail('LIMIT')
    const allowed = await dependencies.readableRecordIds(input.sheetId, access.userId, access.isAdminRole,
      records.map(record => record.id), access.capabilities)
    const rows: Record<string, string | number | boolean>[] = []
    for (const record of records) {
      if (!allowed.has(record.id)) continue
      const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? record.data as Record<string, unknown> : {}
      if (filter && !dependencies.filter.evaluate(filter, leaf => {
        const field = byId.get(leaf.fieldId)!
        return dependencies.filter.leafMatches(dependencies.filter.effectiveType(field), data[leaf.fieldId], leaf)
      })) continue
      const row: Record<string, string | number | boolean> = {}
      for (const column of input.columns) {
        const value = cell(Object.hasOwn(data, column.fieldId) ? data[column.fieldId] : undefined)
        if (value !== undefined) row[column.source] = value
      }
      if (registered && keyFieldId !== null) {
        // The key cell is the server-read idempotency key: a non-empty, trimmed, control-free string.
        const keyValue = Object.hasOwn(data, keyFieldId) ? data[keyFieldId] : undefined
        if (typeof keyValue !== 'string' || !keyValue || keyValue.length > MAX_KEY_VALUE_LENGTH
          || keyValue.trim() !== keyValue || /[\u0000-\u001f\u007f]/u.test(keyValue)) fail('INPUT')
        boundRecords.push({ recordId: literal(record.id), keyValue, projectNo: registered.projectNo })
      }
      rows.push(row)
      if (rows.length > YIDA_SHEET_SOURCE_LIMITS.maxRows) fail('LIMIT')
    }
    if (rows.length === 0) fail('INPUT')
    const rowsText = JSON.stringify(rows)
    if (Buffer.byteLength(rowsText, 'utf8') > YIDA_SHEET_SOURCE_LIMITS.maxTextBytes) fail('LIMIT')
    if (!registered || keyFieldId === null) return Object.freeze({ rowsText, rowCount: rows.length })
    const fieldBindings: Record<string, string> = {}
    for (const column of input.columns) fieldBindings[column.source] = column.fieldId
    const binding: YidaSheetSourceBinding = Object.freeze({ sheetId: input.sheetId, keyFieldId,
      fieldBindings: Object.freeze(fieldBindings), records: Object.freeze(boundRecords.map(entry => Object.freeze(entry))) })
    return Object.freeze({ rowsText, rowCount: rows.length, binding })
  } catch (error) {
    // Never forward a dependency message, row, id or value.
    throw new YidaSheetSourceError(ownErrors.get(error as object) ?? 'UNAVAILABLE')
  }
}

/*
 * ── In-transaction re-authorization (design baseline v2.3 §7.2 「进授权」 + 「分界是准入提交」, D21; slice Y5) ──
 *
 * A bound row is re-authorized at APPROVAL and again at ADMISSION, inside the caller's own transaction and on the
 * caller's own `trx`, by the SAME decisions the draft-time read above made with the owner's permissions:
 *   1. the project-sheet registry (087) has an ACTIVE row for (tenant, projectNo) and it names the bound sheet;
 *   2. table level: readable AND exportable, live, not the People system sheet;
 *   3. field level: the key column and EVERY real field id a sent target depends on (direct, copy, concat — and,
 *      once Y6 registers it, generated — through `fieldDependencies`, by field id, never by alias) is readable;
 *   4. record level: the bound record is readable (record permissions and row-level / conditional read deny),
 *      judged on the row AFTER it is locked.
 * The final conclusion comes from THIS transaction: admin-ness and permission codes are the facts of the rows the
 * D21 helper locked (`multitable/authz-version-protocol.ts`), never a request's token or the 60 s RBAC cache. The
 * lock order is: registry row FOR SHARE (its writers take it FOR UPDATE under their own advisory lock and never
 * hold a protocol row) → the D21 helper (sheet version rows → the actor's subject version row, already held by
 * the service prelude → live-authority rows → the bound record FOR SHARE). A revocation that is an INSERT (a deny
 * row, a hidden field, a deny-group membership) therefore waits on a version row until this transaction commits.
 *
 * HARD CONDITION (§7.2): every entry of the protocol's gap registry must be handled here, or the source is refused.
 * The verdict is a frozen plain object, never a thrown denial: the service maps it to its own fixed codes.
 */
export type YidaSourceReauthorizationCode = 'INPUT' | 'REGISTRY' | 'SHEET' | 'FIELD' | 'RECORD' | 'CONFLICT' | 'PROTOCOL'
export type YidaSourceReauthorizationVerdict =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; code: YidaSourceReauthorizationCode }>
export type YidaSourceReauthorizationActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
/** One planned row's binding, exactly the plugin compiler's shape (yida-send-approval-service.ts YidaSourceRowBinding). */
export type YidaSourceReauthorizationBinding = Readonly<{
  sheetId: string; recordId: string; keyFieldId: string; keyValue: string; projectNo: string
  fieldBindings: Readonly<Record<string, string>>; fieldDependencies: Readonly<Record<string, readonly string[]>>
}>
export type YidaSourceReauthorizationQueryable = Readonly<{ query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }>
/** The facts of the rows the D21 helper locked (`lockAuthorizationVersionsForAdmission`), nothing else. */
export type YidaSourceReauthorizationLockedAuthority = Readonly<{
  permissionCodes: readonly string[]; isAdmin: boolean
  record: Readonly<{ recordId: string; sheetId: string; data: unknown; deletedAt: string | null }> | null
}>
export type YidaSourceReauthorizationAccess = Readonly<{
  canRead: boolean; canExport: boolean; live: boolean; bounded: boolean; capabilities: unknown
}>
export type YidaSourceReauthorizationDependencies = Readonly<{
  /** The D21 helper: fixed lock order (sheet version → subject version → live-authority rows → the bound record) and the locked facts. */
  lockAuthority(trx: YidaSourceReauthorizationQueryable, input: Readonly<{ sheetId: string; actorId: string; tenantId: string; recordId: string }>): Promise<YidaSourceReauthorizationLockedAuthority>
  /** Whether a failure thrown by any dependency above or below is a lock conflict: the protocol's typed conflict or a
   *  raw 40P01 / 40001 / 55P03 from a statement of this transaction (never a pass: CONFLICT). */
  isLockConflict(error: unknown): boolean
  /** The protocol's hard-condition registry (`AUTHORIZATION_PROTOCOL_GAPS`); an entry this module does not handle refuses. */
  protocolGaps: readonly Readonly<{ id: string }>[]
  /** `current_setting('session_replication_role')` of THIS session: the triggers fire only for 'origin'. */
  sessionReplicationRole(trx: YidaSourceReauthorizationQueryable): Promise<string>
  /** The (tenant, projectNo) registry row, locked FOR SHARE in this transaction; null when absent. */
  lockProjectRegistration(trx: YidaSourceReauthorizationQueryable, input: Readonly<{ tenantId: string; projectNo: string }>): Promise<Readonly<{ sheetId: string; status: string }> | null>
  /** Check 2 from an ALREADY-ADJUDICATED access snapshot (the locked codes and admin-ness), never from a request. */
  resolveSheetAccess(trx: YidaSourceReauthorizationQueryable, input: Readonly<{ sheetId: string; userId: string; tenantId: string; permissions: readonly string[]; isAdminRole: boolean }>): Promise<YidaSourceReauthorizationAccess>
  loadFields(trx: YidaSourceReauthorizationQueryable, sheetId: string): Promise<readonly YidaSheetSourceField[]>
  readableFieldIds(trx: YidaSourceReauthorizationQueryable, sheetId: string, userId: string, fields: readonly YidaSheetSourceField[], capabilities: unknown): Promise<ReadonlySet<string>>
  readableRecordIds(trx: YidaSourceReauthorizationQueryable, sheetId: string, userId: string, isAdminRole: boolean, recordIds: readonly string[], capabilities: unknown): Promise<ReadonlySet<string>>
}>
/**
 * The gap-registry entries this re-authorization handles, by id, and HOW:
 *   - `stock-prep-project-registry` (check 1): the registry row is read in this transaction and held FOR SHARE,
 *     so an archive / move (the store's `transition`: advisory lock → row FOR UPDATE → update) waits for the commit;
 *   - `request-cache-admin-and-codes` (checks 2–4): admin-ness and codes are the D21 helper's locked facts only;
 *   - `session-replication-role-replica`: this session's `session_replication_role` must be 'origin' (another
 *     session's replica window is operational: the send switch stays off during a restore rehearsal);
 *   - `triggers-not-installed`: the helper's posture check refuses before any lock is taken.
 * A registry entry outside this list is a writer nobody brought into the protocol: the source is refused.
 */
export const YIDA_SOURCE_REAUTHORIZATION_HANDLED_GAPS: ReadonlySet<string> = new Set([
  'stock-prep-project-registry', 'request-cache-admin-and-codes', 'session-replication-role-replica', 'triggers-not-installed',
])
const REAUTHORIZATION_CODES = new Set<unknown>(['INPUT', 'REGISTRY', 'SHEET', 'FIELD', 'RECORD', 'CONFLICT', 'PROTOCOL'])
const REAUTHORIZED: YidaSourceReauthorizationVerdict = Object.freeze({ authorized: true as const })
function refuse(code: YidaSourceReauthorizationCode): YidaSourceReauthorizationVerdict {
  return Object.freeze({ authorized: false as const, code: (REAUTHORIZATION_CODES.has(code) ? code : 'PROTOCOL') as YidaSourceReauthorizationCode })
}
class ReauthorizationInput extends Error {}
function opaque(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new ReauthorizationInput()
  return value
}
function plainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReauthorizationInput()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new ReauthorizationInput()
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new ReauthorizationInput()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new ReauthorizationInput()
    result[key] = descriptor.value
  }
  return result
}
function closedBinding(value: unknown): YidaSourceReauthorizationBinding {
  const row = plainRecord(value, ['sheetId', 'recordId', 'keyFieldId', 'keyValue', 'projectNo', 'fieldBindings', 'fieldDependencies'])
  const sheetId = opaque(row.sheetId), recordId = opaque(row.recordId), keyFieldId = opaque(row.keyFieldId), projectNo = opaque(row.projectNo)
  if (typeof row.keyValue !== 'string' || !row.keyValue) throw new ReauthorizationInput()
  const bindings = row.fieldBindings, dependencies = row.fieldDependencies
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || !dependencies || typeof dependencies !== 'object'
    || Array.isArray(dependencies)) throw new ReauthorizationInput()
  const fieldBindings: Record<string, string> = {}
  for (const [alias, fieldId] of Object.entries(bindings as Record<string, unknown>)) fieldBindings[alias] = opaque(fieldId)
  const fieldDependencies: Record<string, readonly string[]> = {}
  for (const [target, ids] of Object.entries(dependencies as Record<string, unknown>)) {
    if (!Array.isArray(ids)) throw new ReauthorizationInput()
    fieldDependencies[target] = Object.freeze(ids.map(opaque))
  }
  return Object.freeze({ sheetId, recordId, keyFieldId, keyValue: row.keyValue, projectNo,
    fieldBindings: Object.freeze(fieldBindings), fieldDependencies: Object.freeze(fieldDependencies) })
}
function closedActor(value: unknown): YidaSourceReauthorizationActor {
  const row = plainRecord(value, ['actorId', 'tenantId', 'workspaceId'])
  if (row.workspaceId !== null) throw new ReauthorizationInput()
  return Object.freeze({ actorId: opaque(row.actorId), tenantId: opaque(row.tenantId), workspaceId: null })
}

/**
 * Re-runs the four checks of §7.2 for ONE bound row on the caller's `trx`, in the lock order described above, and
 * answers with a frozen verdict: `{ authorized: true }`, or `{ authorized: false, code }` where the code is the
 * check that refused (REGISTRY / SHEET / FIELD / RECORD), CONFLICT for a lock conflict met at any step — the helper's
 * typed conflict or a raw 40P01 / 40001 / 55P03 (the transaction is aborted, the caller rolls back; never a pass), PROTOCOL for a
 * hard-condition gap or a dependency failure, INPUT for a malformed actor or binding. Values-free: no id, row or
 * dependency message leaves this function. The caller holds the transaction open through its own commit.
 */
export async function reauthorizeYidaSourceBinding(trx: YidaSourceReauthorizationQueryable, actor: unknown, binding: unknown,
  dependencies: YidaSourceReauthorizationDependencies): Promise<YidaSourceReauthorizationVerdict> {
  let who: YidaSourceReauthorizationActor, bound: YidaSourceReauthorizationBinding
  try { who = closedActor(actor); bound = closedBinding(binding) } catch { return refuse('INPUT') }
  try {
    // Hard condition first: a registry entry nobody handles, or a session whose triggers do not fire, refuses before
    // any lock is taken (the posture of the triggers themselves is the helper's first statement).
    if (!Array.isArray(dependencies.protocolGaps)
      || dependencies.protocolGaps.some(gap => !gap || typeof gap.id !== 'string' || !YIDA_SOURCE_REAUTHORIZATION_HANDLED_GAPS.has(gap.id))) return refuse('PROTOCOL')
    if ((await dependencies.sessionReplicationRole(trx)) !== 'origin') return refuse('PROTOCOL')
    // 1. The registry row, FOR SHARE, before the protocol rows (see the lock-order note above).
    const registered = await dependencies.lockProjectRegistration(trx, { tenantId: who.tenantId, projectNo: bound.projectNo })
    if (!registered || registered.status !== 'active' || registered.sheetId !== bound.sheetId) return refuse('REGISTRY')
    // D21: the version rows, the live-authority rows and the bound record, held to the caller's commit.
    let locked: YidaSourceReauthorizationLockedAuthority
    try {
      locked = await dependencies.lockAuthority(trx, { sheetId: bound.sheetId, actorId: who.actorId, tenantId: who.tenantId, recordId: bound.recordId })
    } catch (error) { return refuse(dependencies.isLockConflict(error) ? 'CONFLICT' : 'PROTOCOL') }
    // 2. Table level, from the locked codes and admin-ness only.
    const access = await dependencies.resolveSheetAccess(trx, { sheetId: bound.sheetId, userId: who.actorId, tenantId: who.tenantId,
      permissions: locked.permissionCodes, isAdminRole: locked.isAdmin === true })
    if (!access.canRead || !access.canExport || !access.live || access.bounded) return refuse('SHEET')
    // 3. Field level: the key column explicitly (fieldDependencies is keyed by target and carries the key column only
    //    when some target maps from it) plus every real field id any target depends on — by id, never by alias.
    const fields = await dependencies.loadFields(trx, bound.sheetId)
    const readable = await dependencies.readableFieldIds(trx, bound.sheetId, who.actorId, fields, access.capabilities)
    const required = new Set<string>([bound.keyFieldId])
    for (const ids of Object.values(bound.fieldDependencies)) for (const fieldId of ids) required.add(fieldId)
    for (const fieldId of required) if (!readable.has(fieldId)) return refuse('FIELD')
    // 4. Record level, on the row the helper locked: it must still be the bound record of the bound sheet, live, and
    //    readable under the record permissions and the read-deny rules evaluated after the lock.
    const record = locked.record
    if (!record || record.recordId !== bound.recordId || record.sheetId !== bound.sheetId || record.deletedAt !== null) return refuse('RECORD')
    const allowed = await dependencies.readableRecordIds(trx, bound.sheetId, who.actorId, locked.isAdmin === true, [bound.recordId], access.capabilities)
    if (!allowed.has(bound.recordId)) return refuse('RECORD')
    return REAUTHORIZED
  } catch (error) {
    // A dependency failure is never a pass and never projected. A lock conflict met by ANY step (PostgreSQL picks the
    // deadlock victim wherever this transaction happens to wait: the registry row, a permission read) is CONFLICT;
    // everything else is PROTOCOL.
    let conflict = false
    try { conflict = dependencies.isLockConflict(error) === true } catch { conflict = false }
    return refuse(conflict ? 'CONFLICT' : 'PROTOCOL')
  }
}
