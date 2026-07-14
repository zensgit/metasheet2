import { randomUUID } from 'crypto'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

// W0-1 (corrected) §3 — 'lock'/'unlock' are the marker actions emitted in the SAME txn as a record
// lock/unlock's `version + 1` bump (HTTP `univer-meta.ts` lock route + automation `lock_record`), so the
// version chain stays +1-dense across a lock/unlock exactly like any other version-consuming step
// (`snapshot=NULL`, `patch={}`, `changed_field_ids=[]` — content-neutral, per the design-lock). Forward-
// only: no backfill of historical lock/unlock (unreconstructable, OD-5 forbids fabricating history).
export type RecordRevisionAction = 'create' | 'update' | 'delete' | 'lock' | 'unlock'

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
     -- W0-1 (corrected) §10.4 (recommended, owner-flagged for confirmation in the PR): the History
     -- Center timeline is the sole production caller of this function — filter out the lock/unlock
     -- MARKER rows so the visible timeline stays byte-identical to before markers shipped (a lock/
     -- unlock is metadata, not a user-content edit; markers exist purely to keep the internal version
     -- chain dense for contiguity reasoning, not to be surfaced as history events).
     WHERE sheet_id = $1 AND record_id = $2 AND action NOT IN ('lock', 'unlock')
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
  if (value === 'create' || value === 'delete' || value === 'lock' || value === 'unlock') return value
  return 'update'
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
