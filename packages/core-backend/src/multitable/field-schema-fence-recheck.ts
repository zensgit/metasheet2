/**
 * Field retype first batch, slice 3a — fenced writers re-check the field schema AFTER the canonical fence.
 *
 * Design lock: docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11 (the invariant, the
 * fence-holder census rows 1–35 and the structural guard) and §3.12 (why the automation writers are in scope).
 *
 * THE RACE. A fenced writer validates a write against a field snapshot it loaded BEFORE the canonical sheet
 * fence (`RecordWriteService.patchRecords` loads `fieldById` outside its transaction; REST / OAPI single-record
 * patch and form submit do the same; the plugin SDK reads through a request-scoped cache; the automation and
 * approval write-back paths read the field config outside their transaction). A field type conversion holds
 * that same fence while it rewrites the column. The queued writer parks on the fence, the conversion commits,
 * the writer wakes up and writes a value it validated against the OLD type — a plain string lands in a
 * select column. The fence serialises the two transactions; it does not make the writer look again.
 *
 * THE FIX. After the fence-acquisition branch and before the writer's first row lock / `meta_records` write,
 * re-read the touched fields `FOR SHARE` and compare `type` + option set with the snapshot the writer validated
 * against. Any difference (or a field that no longer exists) ⇒ `FieldSchemaChangedError` (409
 * `FIELD_SCHEMA_CHANGED`, values-free): the client reloads the schema and retries. `FOR SHARE` also holds the
 * field rows until the writer commits, so the conversion's own `FOR UPDATE` on the field row waits for the
 * writer instead of the other way round.
 *
 * INERT UNLESS THE CONVERT FLAG IS ON. Both helpers return before issuing any query unless
 * `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` is the exact string `'true'` (the ADR §5 flag; same byte-exact
 * comparison as the rest of the retype-convert family). Flag off ⇒ every wired writer issues exactly the
 * statements it issued before this module existed.
 *
 * Row 13 (non-scoped derived merge) uses the DERIVED variant: the merge computes `updates` outside the fence
 * from formula fields; after the fence it asserts every key is still a derived type. Its refusal must be a
 * `SheetWriterBlockedError` subclass, because the three callers route exactly that class to their skip branch
 * and re-throw everything else (ADR §3.11 row 13, r6 N2).
 */
import { SheetWriterBlockedError } from './canonical-sheet-fence'
import { serializeFieldRow, mapFieldType } from './field-codecs'

/** Minimal query shape shared by the writers' QueryFn / FenceQuery / AutomationQueryFn aliases. */
export type FieldSchemaRecheckQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** The env flag (ADR §5). Registered in scripts/ops/global-history-flag-manifest.mjs. */
export const FIELD_SCHEMA_FENCE_RECHECK_FLAG_ENV = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'

/**
 * Same predicate as the retype-convert endpoints' gate (`isFieldRetypeConvertEnabled`, slice 2): exact literal
 * `'true'`, no trim, no case folding.
 */
export function isFieldSchemaFenceRecheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT === 'true'
}

export const FIELD_SCHEMA_CHANGED_CODE = 'FIELD_SCHEMA_CHANGED'

/**
 * Thrown when a touched field changed type / options (or disappeared) between the writer's pre-fence snapshot
 * and the post-fence re-read. Values-free: no field id, no type, no option text in the message.
 */
export class FieldSchemaChangedError extends Error {
  readonly code = FIELD_SCHEMA_CHANGED_CODE
  readonly statusCode = 409 as const
  constructor() {
    super('A field this write touches changed type or options while the write was waiting; reload and retry')
    this.name = 'FieldSchemaChangedError'
  }
}

/** What a writer validated against, per field: the mapped type and, for select types, the option values. */
export type FieldSchemaSnapshotEntry = {
  type: string
  options?: readonly string[] | null
}
export type FieldSchemaSnapshot = ReadonlyMap<string, FieldSchemaSnapshotEntry>

/**
 * The post-fence re-read. Exported so the real-DB race cases can derive their `pg_stat_activity` pattern from
 * the production statement instead of copying it.
 */
export const FIELD_SCHEMA_FENCE_RECHECK_SQL =
  'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[]) FOR SHARE'

/** Pre-fence snapshot read for writers that validate nothing by type (automation). Same column set, no lock. */
export const FIELD_SCHEMA_SNAPSHOT_SQL =
  'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])'

function isSelectType(type: string): boolean {
  return type === 'select' || type === 'multiSelect'
}

function entryFromRow(row: Record<string, unknown>): FieldSchemaSnapshotEntry {
  const field = serializeFieldRow({ id: row.id, name: '', type: row.type, property: row.property, order: 0 })
  return isSelectType(field.type)
    ? { type: field.type, options: (field.options ?? []).map((option) => option.value) }
    : { type: field.type }
}

/** Snapshot from raw `meta_fields` rows (`id, type, property`), normalised exactly as the read path does. */
export function fieldSchemaSnapshotFromRows(rows: Iterable<unknown>): Map<string, FieldSchemaSnapshotEntry> {
  const out = new Map<string, FieldSchemaSnapshotEntry>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    if (!id) continue
    out.set(id, entryFromRow(row))
  }
  return out
}

/** Snapshot from already-serialised fields (`serializeFieldRow` output: mapped type + `{ value }` options). */
export function fieldSchemaSnapshotFromFields(
  fields: Iterable<{ id: string; type: string; options?: ReadonlyArray<{ value: string }> | null }>,
): Map<string, FieldSchemaSnapshotEntry> {
  const out = new Map<string, FieldSchemaSnapshotEntry>()
  for (const field of fields) {
    out.set(
      field.id,
      isSelectType(field.type)
        ? { type: field.type, options: (field.options ?? []).map((option) => option.value) }
        : { type: field.type },
    )
  }
  return out
}

function touchedIds(snapshot: FieldSchemaSnapshot | null, touchedFieldIds: Iterable<string>): string[] {
  const ids = new Set<string>()
  for (const id of touchedFieldIds) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (snapshot && !snapshot.has(id)) continue
    ids.add(id)
  }
  // Code-unit order: a deterministic lock order for the FOR SHARE rows, independent of the DB collation.
  return [...ids].sort()
}

/**
 * Flag-gated pre-fence snapshot for writers that do not otherwise keep one (automation `update_record` /
 * `create_record`). Flag off ⇒ `null` and NO query.
 */
export async function loadFieldSchemaSnapshot(
  query: FieldSchemaRecheckQuery,
  sheetId: string,
  fieldIds: Iterable<string>,
): Promise<Map<string, FieldSchemaSnapshotEntry> | null> {
  if (!isFieldSchemaFenceRecheckEnabled()) return null
  const ids = touchedIds(null, fieldIds)
  if (ids.length === 0) return new Map()
  const res = await query(FIELD_SCHEMA_SNAPSHOT_SQL, [sheetId, ids])
  return fieldSchemaSnapshotFromRows(res.rows)
}

function sameOptionSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function sameFieldSchema(before: FieldSchemaSnapshotEntry, now: FieldSchemaSnapshotEntry): boolean {
  if (before.type !== now.type) return false
  if (!isSelectType(now.type)) return true
  return sameOptionSet(before.options ?? [], now.options ?? [])
}

/**
 * THE helper (ADR §3.11). Call it with the WRITER'S OWN transactional query, after the fence-acquisition
 * branch and before the first row lock / `meta_records` write.
 *
 * - `fieldById`: what the writer validated against (only its `type` / `options` are read). `null` ⇒ the
 *   writer took no snapshot (flag was off when it would have) ⇒ nothing to compare.
 * - `touchedFieldIds`: the fields this write sets. Ids the snapshot does not carry are skipped — the writer
 *   validated nothing about them, so nothing about them can be stale.
 * - A touched field that no longer exists counts as changed.
 */
export async function assertFieldSchemaUnchangedAfterFence(
  query: FieldSchemaRecheckQuery,
  sheetId: string,
  fieldById: FieldSchemaSnapshot | null | undefined,
  touchedFieldIds: Iterable<string>,
): Promise<void> {
  if (!isFieldSchemaFenceRecheckEnabled()) return
  if (!fieldById) return
  const ids = touchedIds(fieldById, touchedFieldIds)
  if (ids.length === 0) return
  const res = await query(FIELD_SCHEMA_FENCE_RECHECK_SQL, [sheetId, ids])
  const current = fieldSchemaSnapshotFromRows(res.rows)
  for (const id of ids) {
    const before = fieldById.get(id)
    const now = current.get(id)
    if (!before || !now || !sameFieldSchema(before, now)) throw new FieldSchemaChangedError()
  }
}

// ── Row 13: the derived-merge variant ─────────────────────────────────────────────────────────────────

export const DERIVED_MERGE_TARGET_RECHECK_SQL =
  'SELECT id, type FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[]) FOR SHARE'

const DERIVED_FIELD_TYPES: ReadonlySet<string> = new Set(['formula', 'lookup', 'rollup'])

/**
 * The derived merge's refusal. A `SheetWriterBlockedError` so the three callers' existing
 * `instanceof SheetWriterBlockedError` branch skips the materialisation AND its echo (a silent return would
 * echo a value the DB refused). `state` is null: no durable block is involved.
 */
export class DerivedMergeTargetRetypedError extends SheetWriterBlockedError {
  readonly reason = 'derived_target_retyped' as const
  constructor(sheetId: string) {
    super(sheetId, null, 'A derived value target field is no longer a derived field; the materialization was skipped')
    this.name = 'DerivedMergeTargetRetypedError'
  }
}

/**
 * After the fence and before the merge UPDATE: every key of `updates` must still be a formula / lookup /
 * rollup field of `sheetId`. Otherwise (retyped or deleted) ⇒ `DerivedMergeTargetRetypedError`, zero writes.
 * Flag off ⇒ no query.
 */
export async function assertDerivedMergeTargetsStillDerived(
  query: FieldSchemaRecheckQuery,
  sheetId: string,
  fieldIds: Iterable<string>,
): Promise<void> {
  if (!isFieldSchemaFenceRecheckEnabled()) return
  const ids = touchedIds(null, fieldIds)
  if (ids.length === 0) return
  const res = await query(DERIVED_MERGE_TARGET_RECHECK_SQL, [sheetId, ids])
  const typeById = new Map<string, string>()
  for (const raw of res.rows) {
    const row = raw as Record<string, unknown>
    if (typeof row.id === 'string') typeById.set(row.id, String(mapFieldType(String(row.type ?? ''))))
  }
  for (const id of ids) {
    const type = typeById.get(id)
    if (!type || !DERIVED_FIELD_TYPES.has(type)) throw new DerivedMergeTargetRetypedError(sheetId)
  }
}
