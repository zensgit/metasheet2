/**
 * PLM rows on a stock-preparation template sheet cannot be deleted by anyone — platform admins included
 * (owner ruling 2026-10-28 「管理员也不能删 PLM 行」; decision register R-66 ①).
 *
 * WHY THIS EXISTS. The stock-preparation plugin's PLM pull owns the rows it writes: it identifies each row by
 * its idempotency key, never deletes (the pull emits ADD / UPDATE / INACTIVE only — templates.cjs
 * `missingFromPlmPolicy: 'mark_inactive'`, `deleteByDefault: false`), and keeps inactive rows as carry sources.
 * A person deleting such a row loses every human-preserved cell on it; the next pull re-adds the key as a NEW
 * row with only the PLM columns, and a later restore from the trash then makes two rows with one key, which
 * holds every following plan as `duplicate_existing_key`. So every hard-delete sink refuses a PLM row, with no
 * admin branch anywhere in this module.
 *
 * WHICH ROW IS A PLM ROW — two halves, both must hold:
 *   (1) SHEET. The sheet carries the EXACT `property.stockPreparation` stanza on some field AND has a row in
 *       `plugin_multitable_object_registry` (`isPluginManagedSheet`, server-owned, written only inside a plugin's
 *       provisioning transaction). The exact stanza — not the `stockPreparation*` prefix the duplicate guard
 *       uses — because only this stanza carries the key flag: target provisioning writes
 *       `property.stockPreparation = { ownership, preserveOnRefresh, required, key }` on every template column
 *       (stock-preparation-target-provisioning.cjs buildFieldProperty), the template marks exactly the
 *       idempotency key `key: true`, and customer-pack columns carry `key: false`. The MVP tables
 *       (`stockPreparationMvp`), the confirmation ledger and the project overview (their own namespaces) are
 *       NOT covered here; the overview is read-only for every person already and its plugin port must keep
 *       deleting. Key presence of the stanza is enough for the sheet half (fail-closed); a stanza whose value
 *       is not an object only fails to supply a key column.
 *   (2) ROW. Some field whose stanza says `key === true` holds a non-empty (trimmed) string or a finite number
 *       in the row's data. A keyless row (a hand-made row, a future 人工补充行 that leaves the key column empty)
 *       stays deletable.
 *
 * FAIL CLOSED. Exact stanza ∧ registry row but no `key: true` column resolvable ⇒ EVERY row of that sheet is
 * refused (`key_column_missing`). A thrown registry probe propagates — nothing is deleted.
 *
 * WHAT IS NOT DONE HERE. Right-click copies made before the duplicate guard carry the key verbatim, so they are
 * PLM rows under this rule and no user path deletes them; their cleanup is an owner-approved database operation
 * (see the PR that introduced this module). No "person-created same-key row is deletable" exception: it would let
 * a person delete the only live row of a key once the genuine row sits in the trash.
 *
 * VALUES-FREE. Refusals name no sheet, record, field or value. Their reader can already read the sheet (every
 * caller checks its own capability gates first), so "this row is maintained by the PLM pull" discloses nothing
 * the sheet's own columns do not.
 */
import { normalizeProperty } from './record-duplicate-guard'
import { isPluginManagedSheet, type SheetDeleteGuardQueryFn } from './sheet-delete-guard'
import type { MultitableRowActions } from './access'

export type PlmRowGuardQueryFn = SheetDeleteGuardQueryFn

type FieldLike = { id?: unknown; property?: unknown } | null | undefined

/** The EXACT field-property stanza the plugin's target template writes (own key, not a prefix). */
export const PLM_ROW_FIELD_STANZA = 'stockPreparation'

export const RECORD_DELETE_REFUSED_PLM_ROW_CODE = 'RECORD_DELETE_REFUSED_PLM_ROW'
export const RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE = 'RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE'
export const PLM_ROW_REFUSAL_STATUS = 409

/** zh: the web shows a refused delete's / restore's server message as-is (precedent: the duplicate refusal). */
export const RECORD_DELETE_REFUSED_PLM_ROW_MESSAGE =
  '这一行由备料插件（PLM 拉取）维护，不能删除；请在 PLM 里处理后重新拉取。'
export const RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_MESSAGE =
  '表里已有同一唯一键的有效行，这条已删除的 PLM 行不能恢复（恢复会造成同键两行，拉取会被卡住）。'
export const PLM_KEY_COLUMN_MISSING_MESSAGE =
  '这张表由备料插件维护，但识别不出唯一键列，为安全起见不能删除 / 恢复行。'

/** The automation step error (failed step `error`, values-free log line): the fixed code first, then a fixed sentence. */
export const PLM_ROW_DELETE_AUTOMATION_REFUSAL =
  `${RECORD_DELETE_REFUSED_PLM_ROW_CODE}: this step deletes a row the PLM pull maintains; automations cannot delete it` as const

export type PlmRowDeleteRefusalReason = 'plm_row' | 'key_column_missing'
export type PlmRowRestoreRefusalReason = 'key_active' | 'key_column_missing'
/** Per trash row, on a PLM sheet only: why the trash list shows Restore disabled (display; the route decides). */
export type PlmTrashRestoreBlocked = 'plm_key_active' | 'plm_key_unresolved'
/** Per grid row: why `rowActions.canDelete` is false although the actor could otherwise delete. */
export const PLM_ROW_DELETE_BLOCKED_REASON = 'plm_row' as const

export class PlmRowDeleteRefusedError extends Error {
  readonly code = RECORD_DELETE_REFUSED_PLM_ROW_CODE
  readonly status = PLM_ROW_REFUSAL_STATUS
  constructor(readonly reason: PlmRowDeleteRefusalReason) {
    super(reason === 'key_column_missing' ? PLM_KEY_COLUMN_MISSING_MESSAGE : RECORD_DELETE_REFUSED_PLM_ROW_MESSAGE)
    this.name = 'PlmRowDeleteRefusedError'
  }
}

export class PlmRowRestoreRefusedError extends Error {
  readonly code = RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE
  readonly status = PLM_ROW_REFUSAL_STATUS
  constructor(readonly reason: PlmRowRestoreRefusalReason) {
    super(reason === 'key_column_missing' ? PLM_KEY_COLUMN_MISSING_MESSAGE : RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_MESSAGE)
    this.name = 'PlmRowRestoreRefusedError'
  }
}

export function plmRowDeleteRefusedBody(reason: PlmRowDeleteRefusalReason) {
  return {
    ok: false as const,
    error: {
      code: RECORD_DELETE_REFUSED_PLM_ROW_CODE,
      message: reason === 'key_column_missing' ? PLM_KEY_COLUMN_MISSING_MESSAGE : RECORD_DELETE_REFUSED_PLM_ROW_MESSAGE,
      details: { reason },
    },
  }
}

export function plmRowRestoreRefusedBody(reason: PlmRowRestoreRefusalReason) {
  return {
    ok: false as const,
    error: {
      code: RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE,
      message: reason === 'key_column_missing' ? PLM_KEY_COLUMN_MISSING_MESSAGE : RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_MESSAGE,
      details: { reason },
    },
  }
}

/** Does this field's property carry the exact `stockPreparation` own key? Pure; key presence is enough. */
export function fieldCarriesExactStockPreparationStanza(field: FieldLike): boolean {
  const property = normalizeProperty(field?.property)
  return !!property && Object.prototype.hasOwnProperty.call(property, PLM_ROW_FIELD_STANZA)
}

/** Sheet half, in memory: does any loaded field carry the exact stanza? An ordinary sheet issues no statement. */
export function fieldsCarryExactStockPreparationStanza(fields: ReadonlyArray<FieldLike>): boolean {
  return fields.some((field) => fieldCarriesExactStockPreparationStanza(field))
}

/** The ids of the fields whose stanza says `key === true` (the idempotency key column). */
export function resolvePlmKeyFieldIds(fields: ReadonlyArray<FieldLike>): string[] {
  const ids: string[] = []
  for (const field of fields) {
    const property = normalizeProperty(field?.property)
    if (!property) continue
    const stanza = normalizeProperty(property[PLM_ROW_FIELD_STANZA])
    if (!stanza || stanza.key !== true) continue
    const id = field?.id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/** Row half: a key value is present iff it is a non-empty trimmed string or a finite number. */
export function isPlmKeyValuePresent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  return typeof value === 'number' && Number.isFinite(value)
}

/** A `meta_records.data` value as the guard reads it (jsonb object, or an old JSON-string payload). */
export function normalizePlmRowData(value: unknown): Record<string, unknown> {
  return normalizeProperty(value) ?? {}
}

/** The text a present key compares as in SQL (`data ->> fieldId`); null when the key is absent. */
export function plmKeyText(value: unknown): string | null {
  if (!isPlmKeyValuePresent(value)) return null
  return typeof value === 'string' ? value : String(value)
}

export type PlmRowSheetProfile =
  | { readonly kind: 'not_plm' }
  | { readonly kind: 'plm'; readonly keyFieldIds: readonly string[] }
  | { readonly kind: 'key_column_missing' }

const NOT_PLM: PlmRowSheetProfile = Object.freeze({ kind: 'not_plm' as const })
const KEY_COLUMN_MISSING: PlmRowSheetProfile = Object.freeze({ kind: 'key_column_missing' as const })

/**
 * Both sheet halves. The registry is consulted ONLY when the exact stanza is present, so an ordinary sheet costs
 * no statement. Errors propagate (each caller decides the fail-closed direction).
 */
export async function loadPlmRowSheetProfile(
  query: PlmRowGuardQueryFn,
  sheetId: string,
  fields: ReadonlyArray<FieldLike>,
): Promise<PlmRowSheetProfile> {
  if (!fieldsCarryExactStockPreparationStanza(fields)) return NOT_PLM
  if (!(await isPluginManagedSheet(query, sheetId))) return NOT_PLM
  const keyFieldIds = resolvePlmKeyFieldIds(fields)
  return keyFieldIds.length > 0 ? Object.freeze({ kind: 'plm' as const, keyFieldIds: Object.freeze(keyFieldIds) }) : KEY_COLUMN_MISSING
}

/**
 * The fields the guard needs (`id`, RAW `property`) for a sink that has not loaded the sheet's fields itself (the
 * automation delete). One statement, on the caller's (transaction) query.
 */
export async function loadPlmGuardFields(
  query: PlmRowGuardQueryFn,
  sheetId: string,
): Promise<Array<{ id: unknown; property: unknown }>> {
  const res = await query('SELECT id, property FROM meta_fields WHERE sheet_id = $1', [sheetId])
  return res.rows as Array<{ id: unknown; property: unknown }>
}

/** Pure: why `data` may not be deleted on a sheet with this profile, or null when it may. */
export function plmRowDeleteRefusalReason(
  profile: PlmRowSheetProfile,
  data: Record<string, unknown> | null | undefined,
): PlmRowDeleteRefusalReason | null {
  if (profile.kind === 'not_plm') return null
  if (profile.kind === 'key_column_missing') return 'key_column_missing'
  const row = data ?? {}
  return profile.keyFieldIds.some((fieldId) => isPlmKeyValuePresent(row[fieldId])) ? 'plm_row' : null
}

/** The delete guard every hard-delete sink calls (after its own capability / lock checks, before any write). */
export async function assertPlmRowDeletable(
  query: PlmRowGuardQueryFn,
  sheetId: string,
  fields: ReadonlyArray<FieldLike>,
  data: Record<string, unknown> | null | undefined,
): Promise<void> {
  const reason = plmRowDeleteRefusalReason(await loadPlmRowSheetProfile(query, sheetId, fields), data)
  if (reason) throw new PlmRowDeleteRefusedError(reason)
}

/**
 * Restore from the trash. Refused when a LIVE row on the sheet already holds the snapshot's key (a restore would
 * make two rows per key and hold every later pull), and when the key column cannot be resolved on a PLM sheet.
 * A keyless snapshot, or a key no live row holds, is restored (it recovers the human cells; the next pull UPDATEs
 * by key). `query` should be the restore transaction's own query.
 */
export async function findPlmRowRestoreRefusal(
  query: PlmRowGuardQueryFn,
  sheetId: string,
  profile: PlmRowSheetProfile,
  snapshot: Record<string, unknown> | null | undefined,
): Promise<PlmRowRestoreRefusalReason | null> {
  if (profile.kind === 'not_plm') return null
  if (profile.kind === 'key_column_missing') return 'key_column_missing'
  const row = snapshot ?? {}
  for (const fieldId of profile.keyFieldIds) {
    const key = plmKeyText(row[fieldId])
    if (key === null) continue
    const live = await query(
      'SELECT 1 FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3 LIMIT 1',
      [sheetId, fieldId, key],
    )
    if (live.rows.length > 0) return 'key_active'
  }
  return null
}

/**
 * Trash list: which listed trash rows the Restore button should show disabled, on a PLM sheet only. One
 * `SELECT DISTINCT` per key column over the page's keys. Display only — the restore route decides.
 */
export async function loadPlmTrashRestoreBlocks(
  query: PlmRowGuardQueryFn,
  sheetId: string,
  profile: PlmRowSheetProfile,
  trashRows: ReadonlyArray<{ recordId: string; data: Record<string, unknown> | null | undefined }>,
): Promise<Map<string, PlmTrashRestoreBlocked>> {
  const blocked = new Map<string, PlmTrashRestoreBlocked>()
  if (profile.kind === 'not_plm' || trashRows.length === 0) return blocked
  if (profile.kind === 'key_column_missing') {
    for (const row of trashRows) blocked.set(row.recordId, 'plm_key_unresolved')
    return blocked
  }
  for (const fieldId of profile.keyFieldIds) {
    const keys = [...new Set(trashRows.map((row) => plmKeyText((row.data ?? {})[fieldId])).filter((key): key is string => key !== null))]
    if (keys.length === 0) continue
    const res = await query(
      'SELECT DISTINCT data ->> $2 AS plm_key FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = ANY($3::text[])',
      [sheetId, fieldId, keys],
    )
    const live = new Set((res.rows as Array<{ plm_key?: unknown }>).map((r) => r.plm_key).filter((k): k is string => typeof k === 'string'))
    for (const row of trashRows) {
      const key = plmKeyText((row.data ?? {})[fieldId])
      if (key !== null && live.has(key)) blocked.set(row.recordId, 'plm_key_active')
    }
  }
  return blocked
}

/**
 * Read paths (GET /view, GET /records/:id, form context): which of these rows are PLM rows the delete routes
 * refuse. Computed in memory from the rows' UNFILTERED data and the loaded fields, with one registry statement on
 * exact-stanza sheets only. A failed probe fails CLOSED to "every row blocked" (display only — the route decides).
 */
export async function resolvePlmRowDeleteBlockedIds(
  query: PlmRowGuardQueryFn,
  sheetId: string,
  fields: ReadonlyArray<FieldLike>,
  rows: ReadonlyArray<{ id: string; data: Record<string, unknown> | null | undefined }>,
  onProbeError?: (err: unknown) => void,
): Promise<Set<string>> {
  const blocked = new Set<string>()
  if (rows.length === 0 || !fieldsCarryExactStockPreparationStanza(fields)) return blocked
  let profile: PlmRowSheetProfile
  try {
    profile = await loadPlmRowSheetProfile(query, sheetId, fields)
  } catch (err) {
    onProbeError?.(err)
    for (const row of rows) blocked.add(row.id)
    return blocked
  }
  for (const row of rows) {
    if (plmRowDeleteRefusalReason(profile, row.data)) blocked.add(row.id)
  }
  return blocked
}

/** One row's actions with the PLM block applied — only when the actor could otherwise delete it. */
export function withPlmRowDeleteBlock(rowActions: MultitableRowActions, blocked: boolean): MultitableRowActions {
  if (!blocked || !rowActions.canDelete) return rowActions
  return { ...rowActions, canDelete: false, deleteBlockedReason: PLM_ROW_DELETE_BLOCKED_REASON }
}

/**
 * GET /view: merge the PLM blocks into the page's `rowActionOverrides` (`override ?? default` is what the web
 * resolves per row). Unchanged (same object, possibly undefined) when no row is blocked.
 */
export function applyPlmRowDeleteBlocks(
  overrides: Record<string, MultitableRowActions> | undefined,
  rows: ReadonlyArray<{ id: string }>,
  blockedIds: ReadonlySet<string>,
  defaultRowActions: MultitableRowActions,
): Record<string, MultitableRowActions> | undefined {
  if (blockedIds.size === 0) return overrides
  let merged: Record<string, MultitableRowActions> | null = null
  for (const row of rows) {
    if (!blockedIds.has(row.id)) continue
    const base = overrides?.[row.id] ?? defaultRowActions
    if (!base.canDelete) continue
    if (!merged) merged = { ...(overrides ?? {}) }
    merged[row.id] = withPlmRowDeleteBlock(base, true)
  }
  return merged ?? overrides
}
