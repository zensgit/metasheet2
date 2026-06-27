/**
 * T9-W — config/schema-change RESTORE engine (write half of T9). Reverts a recorded `meta_config_revisions` change
 * FORWARD (re-applies its `before` state as a new change), drift-guarded (T9-W-L5) and forward-only (T9-W-L1).
 *
 * v1 SAFE subset (T9-W-L6): field `name`/`order` reverts + all view config reverts (display-only, non-lossy).
 * Everything else — field `type`/`property` (potentially lossy), create/delete (undelete), permission, sheet_config —
 * is GATED in this slice and refused fail-closed. No record-data is ever touched (T9-W-L2).
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
    if (unsafe.length > 0) return { kind: 'gated', reason: `field ${unsafe.join('/')} reverts are not supported in this slice (potentially lossy)` }
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
const FIELD_COLUMN: Record<string, ColumnMap> = { name: { col: 'name' }, order: { col: '"order"' } }
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
