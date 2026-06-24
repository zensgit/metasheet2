/**
 * T9-R1 — config/schema-change history recorder (FIELDS only in v1).
 *
 * `recordConfigRevision` appends one `meta_config_revisions` row using the MUTATION'S OWN transaction `query`, so a
 * config change and its history row commit or roll back together — the history can never diverge from live config
 * (T9-L4). It is append-only and never restores (T9-L1). The field-diff helpers below are diff-first (T9-L /D2):
 * create → after = the field's own config; delete → before = the config; update → the changed keys only (empty diff
 * → null, the caller records nothing — no rename-to-same spam).
 *
 * NOT in R1: read API, permissions, views, sheet-config, cascade recording. This module only RECORDS field changes.
 */

type QueryFn = (text: string, params: unknown[]) => Promise<unknown>

export type ConfigEntityType = 'field' | 'permission' | 'view' | 'sheet_config'
export type ConfigAction = 'create' | 'update' | 'delete'

export interface ConfigRevisionInput {
  sheetId: string
  entityType: ConfigEntityType
  entityId: string
  action: ConfigAction
  /** the diff endpoints (NOT a full snapshot, D2) — null on the create/delete side. */
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changedKeys: string[]
  /** groups a mutation with its cascaded derived changes (T9-L7); per-request. */
  batchId: string | null
  actorId: string | null
}

export async function recordConfigRevision(query: QueryFn, input: ConfigRevisionInput): Promise<void> {
  await query(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8, $9)`,
    [
      input.sheetId,
      input.entityType,
      input.entityId,
      input.action,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.changedKeys,
      input.batchId,
      input.actorId,
    ],
  )
}

/** The config-relevant keys of a field (identity keys id/sheet_id are excluded — they are not config changes). */
export interface FieldConfigSnapshot {
  name: string
  type: string
  property: unknown
  order: number
}
const FIELD_CONFIG_KEYS: ReadonlyArray<keyof FieldConfigSnapshot> = ['name', 'type', 'property', 'order']

// Stable equality for a config key (property is an object; name/type/order scalar). A field's property is written
// wholesale, so a serialized compare reliably detects a change.
function sameConfigValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export interface FieldDiff {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changedKeys: string[]
}

export function fieldCreateDiff(after: FieldConfigSnapshot): FieldDiff {
  return { before: null, after: { ...after }, changedKeys: [...FIELD_CONFIG_KEYS] }
}
export function fieldDeleteDiff(before: FieldConfigSnapshot): FieldDiff {
  return { before: { ...before }, after: null, changedKeys: [...FIELD_CONFIG_KEYS] }
}
/**
 * Record the order-only side-effect of a bulk reorder: a field mutation (insert-in-middle / reorder / delete)
 * shifts OTHER fields' `order`, and each of those is a real config change. The caller passes the rows the shift
 * `UPDATE … RETURNING id, "order"` returned (the NEW order) + the `delta` applied (+1 or -1), and the SHARED
 * per-request `batchId` so the whole reorder reads as one logical operation. Old order = newOrder − delta.
 */
export async function recordFieldOrderShifts(
  query: QueryFn,
  sheetId: string,
  shifted: Array<{ id: string; newOrder: number }>,
  delta: number,
  batchId: string,
  actorId: string | null,
): Promise<void> {
  for (const f of shifted) {
    await recordConfigRevision(query, {
      sheetId, entityType: 'field', entityId: f.id, action: 'update',
      before: { order: f.newOrder - delta }, after: { order: f.newOrder }, changedKeys: ['order'],
      batchId, actorId,
    })
  }
}

/** Update diff — only the changed config keys. Returns null on a no-op (caller records nothing). */
export function fieldUpdateDiff(before: FieldConfigSnapshot, after: FieldConfigSnapshot): FieldDiff | null {
  const changedKeys: string[] = []
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const k of FIELD_CONFIG_KEYS) {
    if (!sameConfigValue(before[k], after[k])) {
      changedKeys.push(k)
      b[k] = before[k]
      a[k] = after[k]
    }
  }
  if (changedKeys.length === 0) return null
  return { before: b, after: a, changedKeys }
}
