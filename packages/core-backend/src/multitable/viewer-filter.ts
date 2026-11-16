/**
 * VIEWER FILTER — a read-only, per-request narrowing of GET /view and GET /sheets/:sheetId/view-aggregate that
 * is NEVER stored (stock-prep 「查看子件」 / 「查看所有使用位置」, owner question 2026-11-07).
 *
 * WHY THIS EXISTS. The grid's own filter lives in the view config: the toolbar's 应用 PATCHes the shared view
 * (or PUTs the actor's personal overlay), and GET /view only ever applies what is stored. A drawer button that
 * "shows this part's children" through that path would rewrite the view everyone else opens. So the web sends
 * the narrowing as a query parameter instead, and the route ANDs it onto the stored filter for this one read.
 *
 * WHAT IT ACCEPTS — deliberately small:
 *   `viewerFilter` = JSON `{ "conditions": [ { "fieldId": "...", "operator": "is", "value": <v> } ] }`
 *   - 1..VIEWER_FILTER_MAX_CONDITIONS leaf conditions, combined with AND; no groups, no other operator;
 *   - `value` is a NON-BLANK string (≤ VIEWER_FILTER_MAX_VALUE_LENGTH) or a boolean. A blank string is refused
 *     because the string `is` branch compares trimmed text, so `is ''` would match every empty cell.
 *   Anything else is a 400 with one fixed, values-free message. Absent (or empty) ⇒ the route is byte-identical.
 *
 * SELECTION GATE. Each condition's field must be one the caller may filter on — the route passes the same
 * layer-2 ∧ layer-3 set it already gates the stored filter / search with (view-hidden columns are included,
 * the layer-1 hidden list is display-only there). A field outside it is the same generic 400 GET /records
 * answers, naming no field, so the parameter is no field-existence or value oracle.
 *
 * NEVER STORED. Nothing here writes; the composed filter is used for the row selection only and the response's
 * `view` keeps the stored config (GET /view serialises `viewConfig`, not the composed filter).
 */

export const VIEWER_FILTER_QUERY_PARAM = 'viewerFilter' as const
export const VIEWER_FILTER_MAX_CONDITIONS = 3
export const VIEWER_FILTER_MAX_VALUE_LENGTH = 512
/** Raw parameter bound (before JSON.parse) — three short conditions fit comfortably. */
export const VIEWER_FILTER_MAX_RAW_LENGTH = 4096

export const VIEWER_FILTER_INVALID_MESSAGE = 'Invalid viewer filter'
export const VIEWER_FILTER_FIELD_NOT_PERMITTED_MESSAGE = 'Field not permitted for filter/sort'

export type ViewerFilterCondition = Readonly<{ fieldId: string; operator: 'is'; value: string | boolean }>

export type ViewerFilterParse =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'present'; conditions: readonly ViewerFilterCondition[] }>

type FilterGroupLike = { conjunction: 'and' | 'or'; conditions: unknown[] }

const ABSENT: ViewerFilterParse = Object.freeze({ kind: 'absent' as const })
const INVALID: ViewerFilterParse = Object.freeze({ kind: 'invalid' as const })

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Pure. Parses the raw query value (Express gives a string, an array for a repeated key, or an object). */
export function parseViewerFilterParam(raw: unknown): ViewerFilterParse {
  if (raw === undefined || raw === null || raw === '') return ABSENT
  if (typeof raw !== 'string') return INVALID
  if (raw.length > VIEWER_FILTER_MAX_RAW_LENGTH) return INVALID
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return INVALID
  }
  if (!isPlainObject(parsed)) return INVALID
  const list = parsed.conditions
  if (!Array.isArray(list) || list.length === 0 || list.length > VIEWER_FILTER_MAX_CONDITIONS) return INVALID
  const conditions: ViewerFilterCondition[] = []
  for (const item of list) {
    if (!isPlainObject(item)) return INVALID
    const { fieldId, operator, value } = item
    if (typeof fieldId !== 'string' || fieldId.trim() === '' || fieldId.length > 200) return INVALID
    if (operator !== 'is') return INVALID
    if (typeof value === 'boolean') {
      conditions.push(Object.freeze({ fieldId, operator: 'is' as const, value }))
      continue
    }
    if (typeof value !== 'string' || value.trim() === '' || value.length > VIEWER_FILTER_MAX_VALUE_LENGTH) return INVALID
    conditions.push(Object.freeze({ fieldId, operator: 'is' as const, value }))
  }
  return Object.freeze({ kind: 'present' as const, conditions: Object.freeze(conditions) })
}

/** Pure. Every condition names a field the caller may filter on (`selectable`) that exists on the sheet (`known`). */
export function viewerFilterFieldsPermitted(
  conditions: readonly ViewerFilterCondition[],
  selectable: ReadonlySet<string>,
  known: { has(fieldId: string): boolean },
): boolean {
  return conditions.every((condition) => selectable.has(condition.fieldId) && known.has(condition.fieldId))
}

/**
 * Pure. The stored filter AND the viewer conditions. A stored AND group gets the leaves appended (no extra depth);
 * any other stored node (an OR group, a lone leaf) is wrapped, so its own semantics are kept intact. Never mutates
 * `stored`. `null` (no stored filter) gives an AND of the viewer leaves alone.
 */
export function composeViewerFilter(stored: unknown, conditions: readonly ViewerFilterCondition[]): FilterGroupLike {
  const leaves = conditions.map((condition) => ({ fieldId: condition.fieldId, operator: condition.operator, value: condition.value }))
  if (stored === null || stored === undefined) return { conjunction: 'and', conditions: leaves }
  if (isPlainObject(stored) && Array.isArray(stored.conditions) && stored.conjunction !== 'or') {
    return { ...(stored as FilterGroupLike), conjunction: 'and', conditions: [...stored.conditions, ...leaves] }
  }
  return { conjunction: 'and', conditions: [stored, ...leaves] }
}
