/**
 * 批次标识 BI-5 — two host primitives over ONE provisioned object's sheet:
 *
 *   promoteObjectViewToFirst   (write) make one of the object's provisioned views `views[0]` — the view a person lands on
 *                              when they click the sheet in the base rail — by moving ONLY that view's
 *                              `meta_views.created_at` strictly before every other view of the sheet.
 *   describeObjectSheetLayout  (read)  a VALUES-FREE description of the sheet's views: counts and logical ids only.
 *
 * Why a host primitive. The context route and GET /views order a sheet's views `ORDER BY created_at ASC` with NO
 * tie-break (routes/univer-meta.ts, pinned by tests/unit/multitable-context-view-order.test.ts, which this change leaves
 * byte-identical). `ensureView`'s upsert never touches `created_at` and `createView` counts from `now()`, so no existing
 * plugin primitive can put a plugin view in front of the host default view on a sheet that already exists. And a plugin
 * has no view-list read at all, so it cannot see how many views it would push aside or which of them freeze columns.
 *
 * What is written: `meta_views.created_at` of the ONE view whose id is derived for (projectId, objectId, viewLogicalId),
 * nothing else — no other column (not `updated_at`), no other view, no field, no record, no personal config. No view
 * is ever created. The writer runs `fenceWriterEntry` first (flag-gated canonical sheet fence + durable-block check),
 * then locks the sheet's view rows in id order so two promotions on one sheet cannot interleave their reads of the
 * minimum when the fence flag is off.
 *
 * The tie rule (deviation from the literal SQL of the design, on purpose). The design's guard
 * `created_at > (SELECT min(created_at) ... WHERE sheet_id = $s)` is FALSE for a view that is tied AT the minimum — the
 * state of every view of a base installed from a template before #6091 (one shared `now()`). There the target would not
 * move and the call would report `alreadyFirst` while the screen shows whichever tied row the heap returns first. The
 * statement below compares against the minimum of the OTHER views and moves the target when it is not strictly earlier
 * than all of them; the new value is that minimum minus one microsecond — strictly earlier than the sheet's minimum,
 * exactly the design's intent. `created_at` is nullable: NULLs sort LAST under `ASC`, so a NULL target is never first
 * while another view exists; when every other view is NULL too the target gets `now()` (any value precedes the NULLs).
 */
import { fenceWriterEntry } from './canonical-sheet-fence'
import {
  DEFAULT_OBJECT_VIEW_LOGICAL_ID,
  getObjectSheetId,
  getObjectViewId,
  type MultitableProvisioningQueryFn,
} from './provisioning'
import { normalizeJsonArray } from './field-codecs'
import { countFrozenPrefix, isFieldPropertyHidden, parseFrozenLeftColumnIds } from './frozen-prefix'

export const VIEW_LANDING_INPUT_INVALID_CODE = 'MULTITABLE_VIEW_LANDING_INPUT_INVALID'

/** Refusal reasons, values-free (no id, no name in the message). */
export type ViewLandingInputReason =
  | 'view_logical_id'
  | 'default_view'
  | 'candidates'
  | 'left_insert_count'

export class MultitableViewLandingInputError extends Error {
  code = VIEW_LANDING_INPUT_INVALID_CODE
  statusCode = 422
  reason: ViewLandingInputReason

  constructor(reason: ViewLandingInputReason) {
    super(`Multitable view landing input refused: ${reason}`)
    this.name = 'MultitableViewLandingInputError'
    this.reason = reason
  }
}

/** Caps on the read's inputs — a layout read is a small, bounded question. */
export const DESCRIBE_LAYOUT_MAX_CANDIDATES = 32
export const DESCRIBE_LAYOUT_MAX_LEFT_INSERT = 64
const MAX_LOGICAL_ID_LENGTH = 128

function assertLogicalId(value: unknown, reason: ViewLandingInputReason): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value.length > MAX_LOGICAL_ID_LENGTH) {
    throw new MultitableViewLandingInputError(reason)
  }
  return value
}

// ---------------------------------------------------------------------------------------------------------------------
// promoteObjectViewToFirst
// ---------------------------------------------------------------------------------------------------------------------

export type PromoteObjectViewToFirstInput = {
  query: MultitableProvisioningQueryFn
  projectId: string
  objectId: string
  viewLogicalId: string
}

export type PromoteObjectViewToFirstResult = {
  /** true iff this call moved the view's created_at (it was not strictly first before). */
  promoted: boolean
  /** true iff the view exists and was already strictly first (or is the sheet's only view); nothing written. */
  alreadyFirst: boolean
  /** true iff no view with the derived id exists on the derived sheet; nothing written, nothing created. */
  missing: boolean
}

/** Locks the sheet's view rows in a stable order (no write). */
export const PROMOTE_VIEW_LOCK_SQL =
  'SELECT id FROM meta_views WHERE sheet_id = $1 ORDER BY id FOR UPDATE'

/** THE one write of BI-5: `meta_views.created_at` of one view, by (id, sheet_id). */
export const PROMOTE_VIEW_UPDATE_SQL = `WITH others AS (
  SELECT min(o.created_at) AS min_created_at, count(*)::int AS other_count
    FROM meta_views o
   WHERE o.sheet_id = $2 AND o.id <> $1
)
UPDATE meta_views AS v
   SET created_at = COALESCE(others.min_created_at - interval '1 microsecond', now())
  FROM others
 WHERE v.id = $1
   AND v.sheet_id = $2
   AND others.other_count > 0
   AND (
     (others.min_created_at IS NULL AND v.created_at IS NULL)
     OR (others.min_created_at IS NOT NULL AND (v.created_at IS NULL OR v.created_at >= others.min_created_at))
   )
RETURNING v.id`

export const PROMOTE_VIEW_EXISTS_SQL = 'SELECT id FROM meta_views WHERE id = $1 AND sheet_id = $2'

export async function promoteObjectViewToFirst(
  input: PromoteObjectViewToFirstInput,
): Promise<PromoteObjectViewToFirstResult> {
  const viewLogicalId = assertLogicalId(input.viewLogicalId, 'view_logical_id')
  if (viewLogicalId === DEFAULT_OBJECT_VIEW_LOGICAL_ID) {
    // The host default view (全部记录) is the landing the promotion is meant to replace, and it is the host's, not a
    // plugin view: promoting it is refused rather than silently treated as "already first".
    throw new MultitableViewLandingInputError('default_view')
  }
  const sheetId = getObjectSheetId(input.projectId, input.objectId)
  const viewId = getObjectViewId(input.projectId, input.objectId, viewLogicalId)

  await fenceWriterEntry(input.query, sheetId)
  await input.query(PROMOTE_VIEW_LOCK_SQL, [sheetId])
  const updated = await input.query(PROMOTE_VIEW_UPDATE_SQL, [viewId, sheetId])
  const moved = typeof updated.rowCount === 'number' ? updated.rowCount : (updated.rows as unknown[]).length
  if (moved > 0) return { promoted: true, alreadyFirst: false, missing: false }

  const exists = await input.query(PROMOTE_VIEW_EXISTS_SQL, [viewId, sheetId])
  if ((exists.rows as unknown[]).length > 0) return { promoted: false, alreadyFirst: true, missing: false }
  return { promoted: false, alreadyFirst: false, missing: true }
}

// ---------------------------------------------------------------------------------------------------------------------
// describeObjectSheetLayout
// ---------------------------------------------------------------------------------------------------------------------

export type DescribeObjectSheetLayoutInput = {
  query: MultitableProvisioningQueryFn
  projectId: string
  objectId: string
  /** Logical ids (the plugin's own, e.g. 'prep-fill') that `firstView` may name; any other first view is 'other'. */
  candidateViewLogicalIds: string[]
  /** How many new fields would be inserted LEFT of every existing field (0 = none). */
  leftInsertCount: number
}

/**
 * The VALUES-FREE answer: counts and logical ids only. Never a view name, never a physical id, never a field id of a
 * user's view, never a cell value. The key set is fixed (`DESCRIBE_LAYOUT_RESULT_KEYS`).
 */
export type DescribeObjectSheetLayoutResult = {
  viewCount: number
  /** The view the context route lists first: 'default' (the host default view), one candidate logical id, 'other',
   *  or null when the sheet has no view. Same `ORDER BY created_at ASC` as the route, so a tie answers like the route. */
  firstView: string | null
  /** Views whose CURRENT frozen prefix (the web rule, see frozen-prefix.ts) is > 0 over the shared sheet order. */
  viewsWithFrozenColumns: number
  /** Views whose current frozen prefix is > 0 and would be 0 after `leftInsertCount` fields were inserted leftmost. */
  viewsLosingFrozen: number
  /** Personal view configs (any user) on this sheet's views whose `fieldOrder` is a non-empty array. */
  personalOrderOverrides: number
  /** Rows of this sheet in `meta_records_trash`. */
  trashedRecordCount: number
}

export const DESCRIBE_LAYOUT_RESULT_KEYS = Object.freeze([
  'firstView',
  'personalOrderOverrides',
  'trashedRecordCount',
  'viewCount',
  'viewsLosingFrozen',
  'viewsWithFrozenColumns',
] as const)

/** Same ordering as the context route and GET /views (`ORDER BY created_at ASC`, no tie-break). */
export const DESCRIBE_LAYOUT_VIEWS_SQL =
  'SELECT id, type, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC'
/**
 * View types the web never renders as a grid: MultitableWorkbench.vue renders MetaGridTable — the only component that
 * applies `frozenLeftColumnIds` — in the v-else after exactly these branches (form, kanban, gallery, calendar,
 * timeline, gantt, hierarchy; exact, case-sensitive match on `view.type ?? 'grid'`). Any other type, a missing type
 * included, renders the grid and is counted.
 */
export const DESCRIBE_LAYOUT_NON_GRID_VIEW_TYPES: ReadonlySet<string> = new Set([
  'form',
  'kanban',
  'gallery',
  'calendar',
  'timeline',
  'gantt',
  'hierarchy',
])
/** The shared sheet order the grid renders (multitable/loaders.ts loadFieldsForSheet). */
export const DESCRIBE_LAYOUT_FIELDS_SQL =
  'SELECT id, property FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC'
export const DESCRIBE_LAYOUT_PERSONAL_SQL = `SELECT count(*)::int AS n
  FROM meta_view_personal_configs p
  JOIN meta_views v ON v.id = p.view_id
 WHERE v.sheet_id = $1
   AND (CASE WHEN jsonb_typeof(p.config -> 'fieldOrder') = 'array' THEN jsonb_array_length(p.config -> 'fieldOrder') ELSE 0 END) > 0`
export const DESCRIBE_LAYOUT_TRASH_SQL = 'SELECT count(*)::int AS n FROM meta_records_trash WHERE sheet_id = $1'

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonish(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

function countOf(result: { rows: unknown[] }): number {
  const n = Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
  return Number.isFinite(n) ? n : 0
}

export async function describeObjectSheetLayout(
  input: DescribeObjectSheetLayoutInput,
): Promise<DescribeObjectSheetLayoutResult> {
  const candidatesInput = input.candidateViewLogicalIds
  if (!Array.isArray(candidatesInput) || candidatesInput.length > DESCRIBE_LAYOUT_MAX_CANDIDATES) {
    throw new MultitableViewLandingInputError('candidates')
  }
  const candidates = candidatesInput.map((id) => assertLogicalId(id, 'candidates'))
  const leftInsertCount = input.leftInsertCount
  if (!Number.isInteger(leftInsertCount) || leftInsertCount < 0 || leftInsertCount > DESCRIBE_LAYOUT_MAX_LEFT_INSERT) {
    throw new MultitableViewLandingInputError('left_insert_count')
  }

  const sheetId = getObjectSheetId(input.projectId, input.objectId)
  const viewsResult = await input.query(DESCRIBE_LAYOUT_VIEWS_SQL, [sheetId])
  const fieldsResult = await input.query(DESCRIBE_LAYOUT_FIELDS_SQL, [sheetId])
  const personalResult = await input.query(DESCRIBE_LAYOUT_PERSONAL_SQL, [sheetId])
  const trashResult = await input.query(DESCRIBE_LAYOUT_TRASH_SQL, [sheetId])

  const views = viewsResult.rows as Array<{ id?: unknown; type?: unknown; hidden_field_ids?: unknown; config?: unknown }>
  const fields = (fieldsResult.rows as Array<{ id?: unknown; property?: unknown }>)
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({ id: row.id as string, propertyHidden: isFieldPropertyHidden(asPlainObject(row.property)) }))

  // Logical id ↔ physical id: the physical id is derived, never returned.
  const logicalByPhysical = new Map<string, string>()
  logicalByPhysical.set(getObjectViewId(input.projectId, input.objectId, DEFAULT_OBJECT_VIEW_LOGICAL_ID), DEFAULT_OBJECT_VIEW_LOGICAL_ID)
  for (const logical of candidates) {
    const physical = getObjectViewId(input.projectId, input.objectId, logical)
    if (!logicalByPhysical.has(physical)) logicalByPhysical.set(physical, logical)
  }
  const firstId = views.length > 0 ? String(views[0].id ?? '') : null
  const firstView = firstId === null ? null : (logicalByPhysical.get(firstId) ?? 'other')

  // Synthetic ids for the inserted fields: never equal to a stored field id, never in a frozen list.
  const inserted = Array.from({ length: leftInsertCount }, (_unused, index) => `\u0000bi5-left-insert-${index}`)
  let viewsWithFrozenColumns = 0
  let viewsLosingFrozen = 0
  for (const view of views) {
    if (DESCRIBE_LAYOUT_NON_GRID_VIEW_TYPES.has(String(view.type ?? 'grid'))) continue
    const frozenIds = parseFrozenLeftColumnIds(asPlainObject(view.config))
    if (frozenIds.length === 0) continue
    // The hidden ids exactly as every host view read ships them to the grid (GET /view's tryResolveView, /context and
    // the meta_views serializers all use normalizeJsonArray: trimmed, finite numbers stringified); the grid then
    // hides by exact id.
    const hidden = new Set(normalizeJsonArray(view.hidden_field_ids))
    const ordered = fields.filter((field) => !field.propertyHidden && !hidden.has(field.id)).map((field) => field.id)
    const current = countFrozenPrefix(ordered, frozenIds)
    if (current === 0) continue
    viewsWithFrozenColumns += 1
    if (countFrozenPrefix([...inserted, ...ordered], frozenIds) === 0) viewsLosingFrozen += 1
  }

  return {
    viewCount: views.length,
    firstView,
    viewsWithFrozenColumns,
    viewsLosingFrozen,
    personalOrderOverrides: countOf(personalResult),
    trashedRecordCount: countOf(trashResult),
  }
}
