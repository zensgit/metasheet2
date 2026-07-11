/**
 * T9 — config/schema-change history recorder.
 *
 * `recordConfigRevision` appends one `meta_config_revisions` row using the MUTATION'S OWN transaction `query`, so a
 * config change and its history row commit or roll back together — the history can never diverge from live config
 * (T9-L4). It is append-only and never restores (T9-L1). The diff helpers below are diff-first (T9-L /D2):
 * create → after = the field's own config; delete → before = the config; update → the changed keys only (empty diff
 * → null, the caller records nothing — no rename-to-same spam).
 */

import { randomUUID } from 'crypto'

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
  /** T9-W-L1: 'restore' marks a forward-only config-restore (default 'mutation' = an ordinary edit). */
  source?: 'mutation' | 'restore'
  /** T9-W-L1: when source='restore', the id of the meta_config_revisions row that was reverted (back-reference). */
  restoredFromId?: string | null
  /**
   * 4c-2: pre-generate the row's own id when a caller needs to know it BEFORE this INSERT runs (e.g. a
   * tombstone capture that anchors `config_revision_id` to the field-delete revision it's about to create,
   * written earlier in the same transaction than this call). Omitted → random uuid, as before (identical
   * behavior to every pre-existing call site).
   */
  id?: string
}

export async function recordConfigRevision(query: QueryFn, input: ConfigRevisionInput): Promise<string> {
  const id = input.id ?? randomUUID()
  await query(
    `INSERT INTO meta_config_revisions (id, sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source, restored_from_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9, $10, $11, $12)`,
    [
      id,
      input.sheetId,
      input.entityType,
      input.entityId,
      input.action,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.changedKeys,
      input.batchId,
      input.actorId,
      input.source ?? 'mutation',
      input.restoredFromId ?? null,
    ],
  )
  return id
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

export interface ConfigDiff {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changedKeys: string[]
}

function pickConfigKeys(snapshot: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) picked[key] = snapshot[key]
  return picked
}

export function configCreateDiff(after: Record<string, unknown>, changedKeys: ReadonlyArray<string>): ConfigDiff {
  return { before: null, after: pickConfigKeys(after, changedKeys), changedKeys: [...changedKeys] }
}

export function configDeleteDiff(before: Record<string, unknown>, changedKeys: ReadonlyArray<string>): ConfigDiff {
  return { before: pickConfigKeys(before, changedKeys), after: null, changedKeys: [...changedKeys] }
}

export function configUpdateDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): ConfigDiff | null {
  const changedKeys: string[] = []
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const k of keys) {
    if (!sameConfigValue(before[k], after[k])) {
      changedKeys.push(k)
      b[k] = before[k]
      a[k] = after[k]
    }
  }
  if (changedKeys.length === 0) return null
  return { before: b, after: a, changedKeys }
}

export type FieldDiff = ConfigDiff

export function fieldCreateDiff(after: FieldConfigSnapshot): FieldDiff {
  return configCreateDiff(after as unknown as Record<string, unknown>, FIELD_CONFIG_KEYS as ReadonlyArray<string>)
}
export function fieldDeleteDiff(before: FieldConfigSnapshot): FieldDiff {
  return configDeleteDiff(before as unknown as Record<string, unknown>, FIELD_CONFIG_KEYS as ReadonlyArray<string>)
}

/**
 * 4c-2: the field-delete diff, extended to carry the auto-number sequence's `next_value` (the design-lock's
 * "序列 last_value") in `before` — the ONE piece of destroyed state this feature does NOT put in a tombstone
 * table (§2: "定义级小数据", piggybacked on the field's own delete revision instead). `lastValue` is
 * DELIBERATELY excluded from `changedKeys`: it must not perturb any existing consumer that keys off
 * `changed_keys` to know which of `before`/`after` to read per field (config-restore.ts's
 * `applyConfigRevert`, `MetaConfigHistoryModal.vue`'s `renderedChanges`) — those iterate `changedKeys` and
 * would never touch an unlisted key anyway, so adding it to `before` only (not `changedKeys`) is invisible
 * to every existing reader and additive-only for the new one (`recreateFieldFromConfig`'s R1 rehydration,
 * which reads `before.lastValue` directly, not via changedKeys).
 * `lastValue === null` (no auto-number sequence row existed, or capture is off) leaves `before` IDENTICAL
 * to the plain `fieldDeleteDiff` — so a non-autoNumber field's delete revision is byte-for-byte unaffected.
 */
export function fieldDeleteDiffWithSequence(before: FieldConfigSnapshot, lastValue: number | null): FieldDiff {
  const diff = configDeleteDiff(before as unknown as Record<string, unknown>, FIELD_CONFIG_KEYS as ReadonlyArray<string>)
  if (lastValue === null) return diff
  return { ...diff, before: { ...(diff.before ?? {}), lastValue } }
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
  return configUpdateDiff(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    FIELD_CONFIG_KEYS as ReadonlyArray<string>,
  )
}
