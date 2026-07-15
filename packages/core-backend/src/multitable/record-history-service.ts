import { randomUUID } from 'crypto'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecordRevisionAction = 'create' | 'update' | 'delete'

// D-1c OD-2 (W0 slice ④): 'approval' names the approval `resultWriteback` write entry point
// (automation-service.ts's applyResultWritebackPatch, both same-base and cross-base) — the write
// entry point, not the auth identity. Union stays `| string` (non-blocking) per the design-lock; named
// explicitly here for type-safety at the slice's call site.
// D-1c OD-2 (W0 slice ⑤, FINAL): 'attachment' names the attachment-delete cell-strip write entry point
// (univer-meta.ts's `DELETE /attachments/:attachmentId`) — the owner ruled attachment gets its OWN
// source, distinct from 'rest'/'public-form', because the write entry point is the attachment endpoint
// itself, not a generic record write.
export type RecordRevisionSource = 'rest' | 'yjs-bridge' | 'automation' | 'public-form' | 'plugin' | 'approval' | 'attachment' | string

export interface RecordRevisionInput {
  sheetId: string
  recordId: string
  version: number
  action: RecordRevisionAction
  source?: RecordRevisionSource
  actorId?: string | null
  changedFieldIds?: string[]
  patch?: Record<string, unknown>
  snapshot?: Record<string, unknown> | null
  /**
   * Global-history T1: deterministic batch grouping key (LOCK-12 — one user action = one batch).
   * Defaults to the revision's own id (a single-record action = its own batch); a bulk action passes
   * one shared id across all its rows so they group as one batch. NOT a parallel write store (LOCK-1).
   */
  batchId?: string | null
  /**
   * R11 restore back-reference (OD-0=(a)): the SOURCE record-version this write restored from. Set ONLY by
   * the three record-version restore routes (via patchRecords) — every other caller (create/update/delete,
   * automation, plugin, and the non-version-restore `source='restore'` emitters: PIT-resurrect, PIT-reset,
   * lossy-retype-revert) omits it ⇒ column stays NULL. The History Center badge keys on NON-NULL, never on
   * `source='restore'`. Column added by migration zzzz20260711000000_add_meta_record_revisions_restored_from_version;
   * a pre-migration deploy window degrades to the base
   * INSERT (value silently NULL), never failing the write.
   */
  restoredFromVersion?: number | null
  /**
   * 4c-2: pre-generate the row's own id when a caller needs to know it BEFORE this INSERT runs — e.g.
   * `deleteRecord` anchors an inbound-link tombstone's `source_revision_id` to this delete's OWN revision
   * id, captured earlier in the same transaction than this call. Omitted → random uuid (identical to
   * every pre-existing call site's behavior).
   */
  id?: string
}

export interface RecordRevisionEntry {
  id: string
  sheetId: string
  recordId: string
  version: number
  action: RecordRevisionAction
  source: string
  actorId: string | null
  changedFieldIds: string[]
  patch: Record<string, unknown>
  snapshot: Record<string, unknown> | null
  batchId?: string | null
  createdAt: string
}

// R11 deploy-window guard for restored_from_version (migration zzzz20260711000000_add_meta_record_revisions_restored_from_version). recordRecordRevision runs INSIDE
// patchRecords' transaction, so a 42703 from an extended INSERT would POISON the txn (a try/catch fallback
// then fails with "current transaction is aborted"). Instead, probe the column's existence with a SELECT
// (never poisons) and pick the INSERT shape. Cache only the POSITIVE result: once the column exists it never
// disappears, so we stop probing; a negative is re-checked (the migration may land mid-process in a rolling
// deploy). Only reached when restoredFromVersion is non-null (the three record-version restore routes).
let restoredFromVersionColumnPresent = false
async function hasRestoredFromVersionColumn(query: QueryFn): Promise<boolean> {
  if (restoredFromVersionColumnPresent) return true
  // Scope to the active search-path schemas (current_schemas(false) = effective search_path, resolution order) so a
  // meta_record_revisions in ANOTHER schema that HAS the column can't false-positive us into an extended INSERT
  // against a search-path table that lacks it — which would 42703-poison the txn the guard exists to protect (the
  // module-level positive cache would make such a mismatch sticky across a shared-bundle process). Single-schema
  // prod is unaffected (public is on the path). Defense-in-depth (PR #4124 review NIT).
  const res = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'meta_record_revisions' AND column_name = 'restored_from_version' AND table_schema = ANY(current_schemas(false)) LIMIT 1`,
  )
  if ((res.rows as unknown[]).length > 0) {
    restoredFromVersionColumnPresent = true
    return true
  }
  return false
}

export async function recordRecordRevision(query: QueryFn, input: RecordRevisionInput): Promise<string> {
  const id = input.id ?? randomUUID()
  const changedFieldIds = Array.from(new Set((input.changedFieldIds ?? []).filter(Boolean)))
  const baseCols = [
    id,
    input.sheetId,
    input.recordId,
    input.version,
    input.action,
    input.source ?? 'rest',
    input.actorId ?? null,
    changedFieldIds,
    JSON.stringify(input.patch ?? {}),
    input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
    input.batchId ?? id,
  ]
  const baseInsert = () =>
    query(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id
      )
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10::jsonb, $11)`,
      baseCols,
    )
  // Base INSERT is the default for every write (zero deploy-window risk). Only a record-version restore
  // (restoredFromVersion non-null) uses the extended INSERT, gated by a txn-safe column-existence probe so a
  // pre-migration deploy window degrades to the base shape (restored_from_version silently NULL) rather than
  // poisoning the enclosing transaction.
  const restoredFromVersion = input.restoredFromVersion ?? null
  if (restoredFromVersion === null || !(await hasRestoredFromVersionColumn(query))) {
    await baseInsert()
    return id
  }
  await query(
    `INSERT INTO meta_record_revisions (
       id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id, restored_from_version
    )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10::jsonb, $11, $12)`,
    [...baseCols, restoredFromVersion],
  )
  return id
}

// W0 enablement gate (owner ruling, post-merge review of #4279/#4286): the field-undelete rehydration site
// (`recreateFieldFromConfig` in univer-meta.ts) previously called `recordRecordRevision` once PER rehydrated
// record, serially, inside the same transaction — an O(N) round-trip chain that the owner ruled must become a
// single batch write before the field-undelete flag can ever be enabled (the tombstone cap default allows up
// to 50,000 rows per undelete). `recordRecordRevisionsBatch` is that batch path: one multi-row INSERT per
// chunk, with EXACTLY the same column semantics/defaults as `recordRecordRevision` above (same id generation
// via `randomUUID()` when omitted, same `changedFieldIds` de-dup, same `source`/`batchId` defaults, same
// `snapshot`/`patch` JSON handling, same deploy-window-safe `restoredFromVersion` column probe — reusing
// `hasRestoredFromVersionColumn` so the two helpers can never disagree about whether the column exists).
const BATCH_CHUNK_ROWS = 1000

/**
 * Batch counterpart to `recordRecordRevision`: inserts `inputs.length` rows with as few statements as
 * possible instead of one `recordRecordRevision` call per row. Runs on the caller's own `QueryFn` (so it
 * participates in the caller's transaction exactly like the single-row helper), and returns the ids in the
 * same order as `inputs` (mirroring `recordRecordRevision`'s single-id return).
 *
 * Chunking math: each row binds 11 params in the base shape (12 if any row in the whole batch carries a
 * non-null `restoredFromVersion` AND the column exists — see below), so `BATCH_CHUNK_ROWS = 1000` keeps a
 * full chunk at ≤12,000 bound parameters, comfortably under PostgreSQL's 65,535-parameter-per-statement
 * ceiling (drivers/pgbouncer add their own lower practical ceilings too — 1000 rows/statement stays well
 * clear of those as well). A tombstone-cap-sized undelete (50,000 rows) becomes 50 statements instead of
 * 50,000 — the exact O(N)→O(N/1000) shape the owner's enablement gate asked for.
 *
 * `restoredFromVersion` handling mirrors the single-row helper's deploy-window guard, but decided ONCE for
 * the whole batch (not per chunk, not per row) so every chunk of a single call uses the SAME column list —
 * required for a well-formed multi-row `INSERT ... VALUES (...), (...), ...` (every tuple must have the same
 * arity). If ANY input in the batch sets a non-null `restoredFromVersion` AND the column exists, EVERY row
 * in EVERY chunk is inserted with the extended (12-column) shape — rows that didn't set it get an explicit
 * SQL `NULL` for that column, which is byte-identical in the stored row to the base shape omitting it
 * entirely. If the column does not exist (pre-migration deploy window), every row degrades to the base shape
 * and any `restoredFromVersion` values are silently dropped — identical to the single-row helper's own
 * degrade behavior.
 */
export async function recordRecordRevisionsBatch(query: QueryFn, inputs: RecordRevisionInput[]): Promise<string[]> {
  if (inputs.length === 0) return []

  const prepared = inputs.map((input) => {
    const id = input.id ?? randomUUID()
    return {
      id,
      sheetId: input.sheetId,
      recordId: input.recordId,
      version: input.version,
      action: input.action,
      source: input.source ?? 'rest',
      actorId: input.actorId ?? null,
      changedFieldIds: Array.from(new Set((input.changedFieldIds ?? []).filter(Boolean))),
      patch: JSON.stringify(input.patch ?? {}),
      snapshot: input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
      batchId: input.batchId ?? id,
      restoredFromVersion: input.restoredFromVersion ?? null,
    }
  })

  const anyRestoredFromVersion = prepared.some((row) => row.restoredFromVersion !== null)
  const useExtendedShape = anyRestoredFromVersion && (await hasRestoredFromVersionColumn(query))
  const columns = useExtendedShape
    ? ['id', 'sheet_id', 'record_id', 'version', 'action', 'source', 'actor_id', 'changed_field_ids', 'patch', 'snapshot', 'batch_id', 'restored_from_version']
    : ['id', 'sheet_id', 'record_id', 'version', 'action', 'source', 'actor_id', 'changed_field_ids', 'patch', 'snapshot', 'batch_id']
  const paramsPerRow = columns.length

  for (let start = 0; start < prepared.length; start += BATCH_CHUNK_ROWS) {
    const chunk = prepared.slice(start, start + BATCH_CHUNK_ROWS)
    const params: unknown[] = []
    const valueTuples: string[] = []
    chunk.forEach((row, i) => {
      const base = i * paramsPerRow
      const placeholders = [
        `$${base + 1}::uuid`,
        `$${base + 2}`,
        `$${base + 3}`,
        `$${base + 4}`,
        `$${base + 5}`,
        `$${base + 6}`,
        `$${base + 7}`,
        `$${base + 8}::text[]`,
        `$${base + 9}::jsonb`,
        `$${base + 10}::jsonb`,
        `$${base + 11}`,
      ]
      params.push(row.id, row.sheetId, row.recordId, row.version, row.action, row.source, row.actorId, row.changedFieldIds, row.patch, row.snapshot, row.batchId)
      if (useExtendedShape) {
        placeholders.push(`$${base + 12}`)
        params.push(row.restoredFromVersion)
      }
      valueTuples.push(`(${placeholders.join(', ')})`)
    })
    await query(`INSERT INTO meta_record_revisions (${columns.join(', ')}) VALUES ${valueTuples.join(', ')}`, params)
  }

  return prepared.map((row) => row.id)
}

/**
 * W0-1 (OD-W0-1 mechanism (b)) — record a lock/unlock version bump as a chain marker in the independent
 * `meta_record_version_markers` table, so the generation-aware contiguity precheck does not read the bump
 * as an uncaptured-data-write HOLE. `kind` is 'lock' | 'unlock'.
 *
 * LOUD BY DESIGN (W0-1 v3.5 §1 P1-1, correcting the landed #4269 shape): this INSERT NO LONGER carries
 * `ON CONFLICT ... DO NOTHING`. The cross-generation `UNIQUE (sheet_id, record_id, version)` constraint it
 * used to target is DROPPED by the `zzzz20260715120000_add_meta_record_chain_seq` migration — a resurrected
 * record resets `version` to 1, so a new generation's lock/unlock can legitimately land at a version the
 * FIRST generation also marked, and the old `DO NOTHING` SILENTLY SWALLOWED that new marker: the lock/unlock
 * version bump committed while its marker vanished, leaving an unexplained hole the contiguity walk would
 * later (falsely) refuse as `chain_hole` on a perfectly healthy record. Any conflict on this INSERT is now a
 * genuine anomaly (a true within-generation duplicate — the seq-ordered precheck's job to catch as
 * `chain_corrupt`, never this write's job to paper over), so a conflict (or any other error) THROWS and
 * fails the enclosing lock/unlock transaction — no silent divergence between "the version bump happened"
 * and "its marker was recorded" is possible: they now commit or roll back together.
 *
 * Deploy-window safe (mirrors `hasRestoredFromVersionColumn`): the marker table may not exist yet in a
 * rolling deploy (the zzzz migration lands mid-process). A missing table is probed via a txn-safe
 * information_schema SELECT (never poisons the enclosing transaction with a 42P01) — if absent, the marker
 * write is SKIPPED and the lock/unlock version bump still commits. That leaves a transient pre-migration
 * hole for that record; per the design lock (§1.4) the durable trusted-since watermark that grandfathers
 * pre-marker holes is C6, explicitly DEFERRED — until then such a record fails CLOSED (refused), never a
 * silent destructive write.
 */
let versionMarkerTablePresent = false
/**
 * Txn-safe existence probe for `meta_record_version_markers`. Uses `information_schema.tables`, which
 * returns zero rows (never throws `42P01`) when the table is absent — so callers inside a transaction
 * can gate a direct marker SELECT/INSERT without poisoning the enclosing txn during the pre-migration
 * rolling-deploy window. Shared by the WRITE path (recordVersionMarker) and the READ path
 * (history-integrity-precheck) so both avoid the 42P01-abort trap identically.
 */
export async function hasVersionMarkerTable(query: QueryFn): Promise<boolean> {
  if (versionMarkerTablePresent) return true
  const res = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'meta_record_version_markers' AND table_schema = ANY(current_schemas(false)) LIMIT 1`,
  )
  if ((res.rows as unknown[]).length > 0) {
    versionMarkerTablePresent = true
    return true
  }
  return false
}

// W0-1 v3.5 (design lock #4262 §2) deploy-window guard for the `seq` column added to BOTH
// `meta_record_revisions` and `meta_record_version_markers` by `zzzz20260715120000_add_meta_record_chain_seq`.
// Mirrors `hasVersionMarkerTable`/`hasRestoredFromVersionColumn`: an information_schema probe (never a raw
// SELECT that could 42703-abort a caller's transaction), cached only on the POSITIVE result. Consumed
// EXCLUSIVELY by the strict (`MULTITABLE_HISTORY_CONTIGUITY_STRICT`) precheck path — the default path never
// references `seq` and is unaffected by a pre-migration deploy window.
let chainSeqColumnsPresent = false
export async function hasChainSeqColumns(query: QueryFn): Promise<boolean> {
  if (chainSeqColumnsPresent) return true
  const res = await query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'meta_record_revisions' AND column_name = 'seq' AND table_schema = ANY(current_schemas(false))
     LIMIT 1`,
  )
  if ((res.rows as unknown[]).length > 0) {
    chainSeqColumnsPresent = true
    return true
  }
  return false
}

export async function recordVersionMarker(
  query: QueryFn,
  input: { sheetId: string; recordId: string; version: number; kind: 'lock' | 'unlock'; actorId?: string | null },
): Promise<void> {
  if (!(await hasVersionMarkerTable(query))) return
  // No ON CONFLICT: the unique constraint this used to target is dropped (see doc comment above). A
  // conflict/error here MUST propagate and fail the enclosing lock/unlock transaction loudly.
  await query(
    `INSERT INTO meta_record_version_markers (id, sheet_id, record_id, version, kind, actor_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [input.sheetId, input.recordId, input.version, input.kind, input.actorId ?? null],
  )
}

export async function listRecordRevisions(
  query: QueryFn,
  input: { sheetId: string; recordId: string; limit?: number; offset?: number },
): Promise<RecordRevisionEntry[]> {
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 100)
  const offset = Math.max(Number(input.offset ?? 0), 0)
  const result = await query(
    `SELECT
       id,
       sheet_id,
       record_id,
       version,
       action,
       source,
       actor_id,
       changed_field_ids,
       patch,
       snapshot,
       batch_id,
       created_at
     FROM meta_record_revisions
     WHERE sheet_id = $1 AND record_id = $2
     ORDER BY version DESC, created_at DESC
     LIMIT $3 OFFSET $4`,
    [input.sheetId, input.recordId, limit, offset],
  )
  return (result.rows as Array<Record<string, unknown>>).map(serializeRecordRevision)
}

function serializeRecordRevision(row: Record<string, unknown>): RecordRevisionEntry {
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    recordId: String(row.record_id),
    version: Number(row.version ?? 0),
    action: normalizeAction(row.action),
    source: typeof row.source === 'string' ? row.source : 'rest',
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    changedFieldIds: Array.isArray(row.changed_field_ids) ? row.changed_field_ids.map(String) : [],
    patch: normalizeJsonObject(row.patch),
    snapshot: row.snapshot === null || row.snapshot === undefined ? null : normalizeJsonObject(row.snapshot),
    batchId: typeof row.batch_id === 'string' ? row.batch_id : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  }
}

function normalizeAction(value: unknown): RecordRevisionAction {
  return value === 'create' || value === 'delete' ? value : 'update'
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}
