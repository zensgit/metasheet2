/**
 * Generic record duplicate on PLUGIN-MAINTAINED sheets — refused (customer feedback 2026-10-27).
 *
 * WHY THIS EXISTS. `POST /records/:recordId/duplicate` (routes/univer-meta.ts) copies every column the
 * actor can read and write into a NEW row. On a stock-preparation sheet whose PLM columns are not
 * human-write-locked (a project sheet created before the lock existed or never repaired, the
 * deployment's main / env table, a sheet whose locked columns are not `required`), that copy carries the
 * row's machine identity verbatim: the idempotency key, the PLM component / parent source ids, the BOM
 * path, the project number and `active = true`. The plugin's conflict planner then sees two rows with the
 * same key (`duplicate_existing_key`), drops that key from the plan, marks the plan invalid and the apply
 * is refused (409 TABLE_ACTION_MANUAL_CONFIRM_REQUIRED) — the original PLM row stops refreshing too — and
 * the copy falls inside the formal export scope. A copy that lost its key instead holds every pull as a
 * foreign keyless row. In the field the gesture that made such copies was a right-click on a grid row;
 * the web no longer duplicates on right-click, and this guard closes the explicit duplicate entry and any
 * older bundle still in a browser on the same sheets.
 *
 * THE PREDICATE — both halves must hold:
 *   (1) NAMESPACE (pure, in memory, over the fields the caller already loaded): some field's `property`
 *       carries an own key starting with `stockPreparation`. The plugin stamps four field namespaces —
 *       `stockPreparation` (main / project / env target template and the customer-pack columns),
 *       `stockPreparationMvp`, `stockPreparationConfirmationDecision`, `stockPreparationProjectOverview` —
 *       so the prefix, not an exact list, is the rule. An ordinary sheet fails here and the guard issues
 *       NO statement for it.
 *   (2) REGISTRY: the sheet has a row in `plugin_multitable_object_registry` (`isPluginManagedSheet`,
 *       sheet-delete-guard.ts). That row is server-owned and written only inside a plugin's
 *       `provisioning.ensureObject` transaction — the path every stock-preparation target takes (project
 *       sheets, the env / canonical target, the MVP tables, the confirmation ledger). It keeps out:
 *         - a user's「复制数据表」copy of a stock-preparation sheet: copies are never registered and the
 *           plugin never pulls into them, so duplicating a row there harms no pull;
 *         - an ordinary sheet's copy (fails (1) already);
 *         - other plugins' sheets (after-sales, …), whose rows people own (fail (1)).
 *
 * The namespace survives the read serializers: the scalar branches of both `sanitizeFieldProperty`
 * copies pass `property` through (`return obj`), and every stock-preparation template carries string
 * columns (project number, idempotency key). Pinned by tests/unit/multitable-record-duplicate-guard.test.ts.
 *
 * DIRECTION. Refuse-only: a YES only ever takes the duplicate away, never grants anything. A thrown
 * registry probe propagates from the duplicate route (500 — no copy is made) and fails `/context` closed
 * to `recordDuplicateBlocked: true` (the drawer action is shown disabled; the route still decides).
 *
 * VALUES-FREE. The refusal names no sheet, plugin, project, field or value. Its reader is a person who
 * can already read the sheet (the route checks it after the read gate), so "rows here are maintained by a
 * plugin" discloses nothing the sheet's own columns do not.
 */
import { isPluginManagedSheet, type SheetDeleteGuardQueryFn } from './sheet-delete-guard'

export const PLUGIN_MAINTAINED_ROW_FIELD_NAMESPACE_PREFIX = 'stockPreparation'

export const RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_CODE = 'RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET'
export const RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_STATUS = 409
/** zh: the web shows a failed duplicate's server message as-is (same precedent as MULTITABLE_GRID_EXPORT_CLOSED). */
export const RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_MESSAGE =
  '这张表的行由备料插件（PLM 拉取）维护，不能复制为新行。'

export const RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_BODY = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    code: RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_CODE,
    message: RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_MESSAGE,
  }),
})

/** Shared with plm-row-delete-guard.ts (same string-encoded-jsonb tolerance). */
export function normalizeProperty(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  // An old property stored as a JSON string inside jsonb arrives as a string scalar.
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

/** Half (1): does any field carry a `stockPreparation*` property key? Pure; key presence is enough (fail-closed). */
export function fieldsCarryPluginMaintainedRowNamespace(
  fields: ReadonlyArray<{ property?: unknown } | null | undefined>,
): boolean {
  for (const field of fields) {
    const property = normalizeProperty(field?.property)
    if (!property) continue
    for (const key of Object.keys(property)) {
      if (key.startsWith(PLUGIN_MAINTAINED_ROW_FIELD_NAMESPACE_PREFIX)) return true
    }
  }
  return false
}

/**
 * Both halves. The registry is consulted ONLY when the namespace check says yes, so an ordinary sheet
 * costs no statement. Errors propagate (the callers decide the fail-closed direction, see the module doc).
 */
export async function isPluginMaintainedRowSheet(
  query: SheetDeleteGuardQueryFn,
  sheetId: string,
  fields: ReadonlyArray<{ property?: unknown } | null | undefined>,
): Promise<boolean> {
  if (!fieldsCarryPluginMaintainedRowNamespace(fields)) return false
  return isPluginManagedSheet(query, sheetId)
}
