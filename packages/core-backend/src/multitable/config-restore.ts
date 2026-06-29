/**
 * T9-W — config/schema-change RESTORE engine (write half of T9). Reverts a recorded `meta_config_revisions` change
 * FORWARD (re-applies its `before` state as a new change), drift-guarded (T9-W-L5) and forward-only (T9-W-L1).
 *
 * v1 SAFE subset (T9-W-L6): field `name`/`order` reverts + all view config reverts (display-only, non-lossy).
 * Everything else — field `type`/`property` (schema-only revert; gated at classify, route opens a scalar-safe Tier-2 subset), create/delete (undelete), permission — is GATED in
 * this slice and refused fail-closed. sheet_config is also `gated` at the classify layer (classifyRevert); the ROUTE
 * opens only a narrow Tier-1 subset (an `update` whose changed keys ⊆ {conditionalReadRules,
 * rowLevelReadPermissionsEnabled}, per isSupportedSheetConfigRevert) behind MULTITABLE_ENABLE_SHEET_CONFIG_REVERT —
 * a sheet_config create/delete/unknown-key stays gated. No record-data is ever touched (T9-W-L2).
 */
import { createHash } from 'node:crypto'

type QueryFn = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>

export interface ConfigRevisionRow {
  id: string
  sheet_id: string
  entity_type: 'field' | 'permission' | 'view' | 'sheet_config'
  entity_id: string
  action: 'create' | 'update' | 'delete'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changed_keys: string[]
}

export type RevertOpKind = 'safe' | 'gated'

const SAFE_FIELD_KEYS = new Set(['name', 'order'])

/** T9-W-L6: which reverts this slice supports. Everything not provably non-lossy is gated. */
export function classifyRevert(rev: Pick<ConfigRevisionRow, 'entity_type' | 'action' | 'changed_keys'>): { kind: RevertOpKind; reason?: string } {
  if (rev.action !== 'update') return { kind: 'gated', reason: 'only update reverts are supported in this slice (create/delete = undelete, gated)' }
  if (rev.entity_type === 'view') return { kind: 'safe' } // view config is display-only, non-lossy
  if (rev.entity_type === 'field') {
    const unsafe = rev.changed_keys.filter((k) => !SAFE_FIELD_KEYS.has(k))
    if (unsafe.length > 0) return { kind: 'gated', reason: `field ${unsafe.join('/')} reverts are gated at the classify layer (type/property is route-gated to a scalar schema-only subset; see isSupportedFieldRetypeRevert)` }
    return { kind: 'safe' }
  }
  return { kind: 'gated', reason: `${rev.entity_type} reverts are not supported in this slice` }
}

/**
 * T9-W Tier 1 scope — the ONLY sheet_config reverts the flag opens: an `update` whose changed keys are ALL Tier-1
 * keys (the row-deny toggle + conditional-read rules). classifyRevert returns `gated` for EVERY sheet_config
 * (intrinsically gated), so preview/execute must use THIS predicate — NOT `entity_type === 'sheet_config'` — to
 * decide what the flag actually permits. A `create`/`delete` (un-create / undelete = Tier 3/4, #3254 HOLD) or an
 * unknown changed_key stays gated (preview not confirmable, execute 422). These keys MUST stay equal to
 * SHEET_CONFIG_COLUMN's (the columns applyConfigRevert can actually write).
 */
export const SUPPORTED_SHEET_CONFIG_REVERT_KEYS: ReadonlySet<string> = new Set(['conditionalReadRules', 'rowLevelReadPermissionsEnabled'])
export function isSupportedSheetConfigRevert(rev: Pick<ConfigRevisionRow, 'entity_type' | 'action' | 'changed_keys'>): boolean {
  return (
    rev.entity_type === 'sheet_config' &&
    rev.action === 'update' &&
    Array.isArray(rev.changed_keys) &&
    rev.changed_keys.length > 0 &&
    rev.changed_keys.every((k) => SUPPORTED_SHEET_CONFIG_REVERT_KEYS.has(k))
  )
}

/**
 * T9-W Tier 2 (U-2) — field retype revert. The forward PATCH /fields route changes type/property with NO cell-value
 * migration (stored values are kept raw, and the read path tolerates type-mismatched values), so a SCHEMA-ONLY revert
 * of type/property is symmetric with the forward op and LOSSLESS — it does NOT coerce or drop stored values. (A
 * value-transforming/dropping retype would be a separate, destructive decision — explicitly NOT this slice.)
 *
 * classifyRevert returns `gated` for a field revert touching type/property, so the route opens the supported subset
 * behind MULTITABLE_ENABLE_FIELD_RETYPE_REVERT via these predicates (mirrors the Tier-1 sheet_config pattern).
 *
 * SCALAR-SAFE ONLY: applyConfigRevert does a raw meta_fields UPDATE, but the forward route ALSO runs type-transition
 * side effects (autoNumber sequence, formula deps, link join-table) that a raw UPDATE skips. So BOTH the reverted-from
 * (`after`) and reverted-to (`before`) types MUST be plain scalars (not in FIELD_RETYPE_EXCLUDED_TYPES); a retype
 * touching computed/link/attachment/autoNumber/system types stays gated (it needs those handlers — a separate slice).
 * v1 also requires a `type` change so the predicate stays pure on `rev` (property-only reverts are deferred).
 */
const FIELD_RETYPE_KEYS: ReadonlySet<string> = new Set(['name', 'order', 'type', 'property'])
const FIELD_RETYPE_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
])
/** Structural gate (drives the per-tier flag): a field `update` revert that touches type and/or property. */
export function isFieldRetypeRevert(rev: Pick<ConfigRevisionRow, 'entity_type' | 'action' | 'changed_keys'>): boolean {
  return (
    rev.entity_type === 'field' &&
    rev.action === 'update' &&
    Array.isArray(rev.changed_keys) &&
    rev.changed_keys.length > 0 &&
    rev.changed_keys.every((k) => FIELD_RETYPE_KEYS.has(k)) &&
    rev.changed_keys.some((k) => k === 'type' || k === 'property')
  )
}
/** Confirmable/executable subset: a type-changing field retype where BOTH endpoints are plain scalars (raw UPDATE safe). */
export function isSupportedFieldRetypeRevert(rev: ConfigRevisionRow): boolean {
  if (!isFieldRetypeRevert(rev)) return false
  if (!rev.changed_keys.includes('type')) return false // v1: type-changing reverts only (property-only deferred)
  const beforeType = rev.before?.type
  const afterType = rev.after?.type
  if (typeof beforeType !== 'string' || typeof afterType !== 'string') return false // need both to verify scalar-safety
  return !FIELD_RETYPE_EXCLUDED_TYPES.has(beforeType) && !FIELD_RETYPE_EXCLUDED_TYPES.has(afterType)
}

/**
 * T9-W Tier 3 (U-3) — un-create. Reverting a `create` revision forward-only = DROPPING the entity that revision
 * created (a create's `before` is null, so the reverted-to state is non-existence). v1 (design-lock U3-L1) opens ONLY
 * field/view create-reverts — the two entity types a forward create-route records. sheet_config create (1-row,
 * nonsensical to un-create), permission (permission-revert, held), and `delete`-reverts (undelete = Tier 4) stay
 * gated. classifyRevert returns `gated` for every create (action !== 'update'), so the route opens THIS subset behind
 * MULTITABLE_ENABLE_CONFIG_UNCREATE via this predicate (mirrors the Tier-1/2 predicate pattern).
 *
 * Pure & structural ONLY: the destructive cascade (drop + column-data loss), the no-oracle preview (U3-L5), and the
 * opaque HMAC plan-hash drift control (U3-L4) live at the route (config-restore-execute), NOT here. This decides only
 * "is this revision an un-create the flag may open".
 */
export const UNCREATE_ENTITY_TYPES: ReadonlySet<string> = new Set(['field', 'view'])
export function isSupportedUncreate(rev: Pick<ConfigRevisionRow, 'entity_type' | 'action'>): boolean {
  return rev.action === 'create' && UNCREATE_ENTITY_TYPES.has(rev.entity_type)
}

/**
 * T9-W Tier 4 (U-4) — undelete. Reverting a `delete` revision forward-only = RECREATING the entity it removed (a
 * delete's `before` is the full config, `after` is null). v1 (design-lock U4-L1) opens ONLY field/view delete-reverts.
 * DEFINITION-ONLY: a field's dropped column values, meta_links, and auto-number counter are gone (no soft-delete), so
 * undelete restores the field DEFINITION (recreated at its original order) but NOT its data — the route states this.
 * sheet_config and permission (= permission-revert, held) stay gated. classifyRevert returns `gated` for every delete
 * (action !== 'update'), so the route opens THIS subset behind MULTITABLE_ENABLE_CONFIG_UNDELETE via this predicate.
 *
 * Pure & structural ONLY: the recreate, the id-collision/plan-drift guards (U4-L5), and the no-oracle preview live at
 * the route (config-restore-execute), NOT here.
 */
export function isSupportedUndelete(rev: Pick<ConfigRevisionRow, 'entity_type' | 'action'>): boolean {
  return rev.action === 'delete' && UNCREATE_ENTITY_TYPES.has(rev.entity_type)
}

/**
 * T9-W permission-revert (design-lock #3342, owner-ratified DE-ESCALATION-ONLY v1). Reverting a `permission`
 * revision re-applies its `before` grant. The route opens a revert ONLY when restoring `before` would REDUCE the
 * subject's access on the entity's single total-order access rank (it can NEVER increase access). Escalation
 * (re-grant / raise) stays gated → 422. classifyRevert stays pure; this is structural + a pure direction oracle.
 */
export type PermissionScope = 'field' | 'view' | 'sheet'
export type PermissionRevertDirection = 'de-escalation' | 'escalation' | 'noop'

// Sheet/view enums are total orders (univer-meta route z.enums). Field is a derived single rank: hidden(0) <
// read-only(1) < read-write(2) — visible=false dominates (no access), else readOnly distinguishes read vs write.
export const SHEET_ACCESS_RANK: Readonly<Record<string, number>> = { none: 0, read: 1, 'write-own': 2, write: 3, admin: 4 }
export const VIEW_PERMISSION_RANK: Readonly<Record<string, number>> = { none: 0, read: 1, write: 2, admin: 3 }

/** Single total-order access rank for a grant snapshot (null/absent = 0 = no access). Higher = more access. */
export function permissionAccessRank(scope: PermissionScope, grant: Record<string, unknown> | null | undefined): number {
  if (!grant) return 0
  if (scope === 'field') {
    if (grant.visible === false) return 0 // hidden dominates
    return grant.readOnly === true ? 1 : 2 // read-only < read-write
  }
  if (scope === 'view') { const v = grant.permission; return typeof v === 'string' && v in VIEW_PERMISSION_RANK ? VIEW_PERMISSION_RANK[v] : 0 }
  const a = grant.accessLevel; return typeof a === 'string' && a in SHEET_ACCESS_RANK ? SHEET_ACCESS_RANK[a] : 0
}

/** Direction of restoring `before` against the CURRENT live grant. Single total order ⇒ no 'mixed'. */
export function permissionRevertDirection(scope: PermissionScope, before: Record<string, unknown> | null | undefined, live: Record<string, unknown> | null | undefined): PermissionRevertDirection {
  const b = permissionAccessRank(scope, before)
  const l = permissionAccessRank(scope, live)
  if (b < l) return 'de-escalation'
  if (b > l) return 'escalation'
  return 'noop'
}

export function isPermissionRevert(rev: Pick<ConfigRevisionRow, 'entity_type'>): boolean {
  return rev.entity_type === 'permission'
}

/** Parse a permission entity_id `${scope}:${JSON.stringify(parts)}` (field/view/sheet). */
export function parsePermissionEntityId(entityId: string): { scope: PermissionScope; parts: string[] } | null {
  const i = entityId.indexOf(':')
  if (i < 0) return null
  const scope = entityId.slice(0, i)
  if (scope !== 'field' && scope !== 'view' && scope !== 'sheet') return null
  try {
    const parts = JSON.parse(entityId.slice(i + 1)) as unknown
    if (Array.isArray(parts)) return { scope, parts: parts.map((p) => String(p)) }
  } catch { /* fall through */ }
  return null
}

const stable = (v: unknown): string => JSON.stringify(v ?? null)
function pick(snapshot: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = snapshot[k]
  return out
}

/** A short stable hash of the entity's current config over the changed keys — binds execute to the previewed state. */
export function configBaselineHash(snapshot: Record<string, unknown>, keys: string[]): string {
  const picked: Record<string, unknown> = {}
  for (const k of [...keys].sort()) picked[k] = snapshot[k] ?? null
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 32)
}

export interface RevertPreview {
  revisionId: string
  entityType: string
  entityId: string
  changedKeys: string[]
  current: Record<string, unknown>
  /** the `before` state this revert would restore the changed keys to. */
  target: Record<string, unknown>
  /** T9-W-L5: the live config for the changed keys no longer matches what this change produced (`after`). */
  driftConflict: boolean
  opKind: RevertOpKind
  gatedReason?: string
  baselineHash: string
}

export function computeRevertPreview(rev: ConfigRevisionRow, currentSnapshot: Record<string, unknown>): RevertPreview {
  const keys = rev.changed_keys
  const before = rev.before ?? {}
  const after = rev.after ?? {}
  const current = pick(currentSnapshot, keys)
  const driftConflict = keys.some((k) => stable(current[k]) !== stable(after[k]))
  const { kind, reason } = classifyRevert(rev)
  return {
    revisionId: rev.id,
    entityType: rev.entity_type,
    entityId: rev.entity_id,
    changedKeys: keys,
    current,
    target: pick(before, keys),
    driftConflict,
    opKind: kind,
    ...(reason ? { gatedReason: reason } : {}),
    baselineHash: configBaselineHash(currentSnapshot, keys),
  }
}

// --- entity config snapshot loaders (current live config) ---

export async function loadFieldConfigSnapshot(query: QueryFn, fieldId: string): Promise<Record<string, unknown> | null> {
  const res = await query('SELECT name, type, property, "order" FROM meta_fields WHERE id = $1', [fieldId])
  const row = res.rows[0] as { name: string; type: string; property: unknown; order: number } | undefined
  if (!row) return null
  return { name: row.name, type: row.type, property: row.property, order: row.order }
}

export async function loadViewConfigSnapshot(query: QueryFn, viewId: string): Promise<Record<string, unknown> | null> {
  const res = await query('SELECT name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1', [viewId])
  const row = res.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    name: String(row.name),
    type: String(row.type ?? 'grid'),
    filterInfo: row.filter_info ?? null,
    sortInfo: row.sort_info ?? null,
    groupInfo: row.group_info ?? null,
    hiddenFieldIds: row.hidden_field_ids ?? [],
    config: row.config ?? null,
  }
}

export async function loadSheetConfigSnapshot(query: QueryFn, sheetId: string): Promise<Record<string, unknown> | null> {
  const res = await query('SELECT conditional_read_rules, row_level_read_permissions_enabled FROM meta_sheets WHERE id = $1', [sheetId])
  const row = res.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  // Return the RAW jsonb value (NOT re-parsed): the recorder stored before/after as jsonb too, so both go through the
  // same Postgres key-ordering. stable() is a plain JSON.stringify (no key-sort), so re-parsing here (which rebuilds
  // objects in JS key order) would mismatch the recorded `after` and trip a FALSE drift. `?? []` matches the recorder's
  // empty shape.
  return {
    conditionalReadRules: row.conditional_read_rules ?? [],
    rowLevelReadPermissionsEnabled: row.row_level_read_permissions_enabled === true,
  }
}

export async function loadEntityConfigSnapshot(query: QueryFn, rev: ConfigRevisionRow): Promise<Record<string, unknown> | null> {
  if (rev.entity_type === 'field') return loadFieldConfigSnapshot(query, rev.entity_id)
  if (rev.entity_type === 'view') return loadViewConfigSnapshot(query, rev.entity_id)
  if (rev.entity_type === 'sheet_config') return loadSheetConfigSnapshot(query, rev.entity_id)
  return null
}

// --- the revert WRITE (forward-only): set the changed keys back to `before` ---

interface ColumnMap { col: string; jsonb?: boolean }
// T9-W Tier 2 adds type/property (schema-only revert; gated to scalar-safe retypes by isSupportedFieldRetypeRevert).
const FIELD_COLUMN: Record<string, ColumnMap> = { name: { col: 'name' }, order: { col: '"order"' }, type: { col: 'type' }, property: { col: 'property', jsonb: true } }
const VIEW_COLUMN: Record<string, ColumnMap> = {
  name: { col: 'name' }, type: { col: 'type' },
  filterInfo: { col: 'filter_info', jsonb: true }, sortInfo: { col: 'sort_info', jsonb: true },
  groupInfo: { col: 'group_info', jsonb: true }, hiddenFieldIds: { col: 'hidden_field_ids', jsonb: true },
  config: { col: 'config', jsonb: true },
}
// T9-W Tier 1: sheet_config revert columns on meta_sheets (camelCase keys match the recorder's before/after shape).
const SHEET_CONFIG_COLUMN: Record<string, ColumnMap> = {
  conditionalReadRules: { col: 'conditional_read_rules', jsonb: true },
  rowLevelReadPermissionsEnabled: { col: 'row_level_read_permissions_enabled' },
}

/** Apply the revert: UPDATE the entity's changed columns to the revision's `before` values. Safe-op only (caller gates). */
export async function applyConfigRevert(query: QueryFn, rev: ConfigRevisionRow): Promise<void> {
  const map = rev.entity_type === 'field' ? FIELD_COLUMN : rev.entity_type === 'view' ? VIEW_COLUMN : rev.entity_type === 'sheet_config' ? SHEET_CONFIG_COLUMN : null
  const table = rev.entity_type === 'field' ? 'meta_fields' : rev.entity_type === 'view' ? 'meta_views' : rev.entity_type === 'sheet_config' ? 'meta_sheets' : null
  if (!map || !table) throw new Error(`config revert not supported for entity_type=${rev.entity_type}`)
  const before = rev.before ?? {}
  const sets: string[] = []
  const params: unknown[] = []
  for (const k of rev.changed_keys) {
    const m = map[k]
    if (!m) throw new Error(`config revert not supported for key=${k}`)
    params.push(m.jsonb ? JSON.stringify(before[k] ?? null) : before[k])
    sets.push(`${m.col} = $${params.length}${m.jsonb ? '::jsonb' : ''}`)
  }
  if (sets.length === 0) return
  params.push(rev.entity_id)
  await query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length}`, params)
}
