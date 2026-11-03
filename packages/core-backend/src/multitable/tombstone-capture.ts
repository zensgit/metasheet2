/**
 * 4c-2 forward tombstone-capture (design-lock 2026-07-07, #3809 + #3830 correction; owner-ratified
 * 2026-07-08). Shared capture helpers for the three ratified capture points:
 *   1. `dropFieldCascade` (univer-meta.ts) — column values + that field's link edges + auto-number
 *      sequence state, captured into `meta_field_value_tombstones` / `meta_link_tombstones`
 *      (reason='field_delete').
 *   2. `deleteRecord` (record-service.ts) — INBOUND link edges only, captured into
 *      `meta_link_tombstones` (reason='record_delete'). Outbound edges are already covered by
 *      `meta_records_trash` (the trashed row's `data` still carries the link-field arrays and
 *      `restoreRecord` replays them) — capturing them again here would be redundant.
 *   3. The point-in-time RESET route's inline per-candidate record delete (`univer-meta.ts`, added by
 *      4c-3 §7/D-3) — the second surface that can hard-delete a record and later resurrect it. Same
 *      shape as point 2 (INBOUND edges only, `reason='record_delete'`), anchored to its own
 *      pre-generated delete-revision id so a later resurrect of that candidate can name this
 *      deletion's tombstones the same way `deleteRecord`'s restore does.
 *
 * All three capture points are same-txn, placed BEFORE the destructive statement(s) they shadow, and use a
 * single batched `INSERT ... SELECT` (never a per-row round trip). Gated by
 * `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` (default OFF — off means today's behavior byte-for-byte,
 * §0/C1/C3). When on, a capture whose row count would exceed `MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS`
 * (default 50000) makes the CALLER refuse the destructive op itself (422) rather than silently skipping
 * capture and deleting anyway — "flag on ⇒ every destruction is already captured" must never be violated
 * (C3 fail-closed). A capture INSERT failing for any other reason propagates and rolls back the whole
 * transaction — never a partial capture + a completed destroy.
 *
 * IMPORTANT ORDERING NOTE (do not move the capture calls): `meta_links.field_id` and
 * `meta_field_auto_number_sequences.field_id` are BOTH `REFERENCES meta_fields(id) ON DELETE CASCADE`
 * (zzzz20260404153000 / zzzz20260505110000). `dropFieldCascade`'s very first statement,
 * `DELETE FROM meta_fields WHERE id = $1`, ALREADY destroys those two tables' rows for this field via
 * cascade — the cascade fires before dropFieldCascade's own later explicit
 * `DELETE FROM meta_field_auto_number_sequences ...` / `DELETE FROM meta_links WHERE field_id = ...`
 * statements even run (those are now redundant no-ops for this field). So every capture (values, links,
 * sequence, AND the cap count) must run before THAT first DELETE, not merely before the later
 * explicit deletes that look, textually, like "the" destructive statement for links/sequence.
 */

export type TombstoneQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export const TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS = 50000

export function isTombstoneCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED === 'true'
}

export function resolveTombstoneCaptureMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS
}

/**
 * Thrown when a flag-on capture would exceed the row cap. MUST be mapped to HTTP 422 by every route that
 * can trigger a capturing destructive op (DELETE /fields/:fieldId, the config-restore un-create execute,
 * DELETE /records/:recordId) — never silently swallowed, never downgraded to a partial/no-capture delete.
 */
export class TombstoneCaptureCapExceededError extends Error {
  constructor(
    message: string,
    public readonly totalRows: number,
    public readonly cap: number,
  ) {
    super(message)
    this.name = 'TombstoneCaptureCapExceededError'
  }
}

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : null
  const message = typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : ''
  if (code === '42P01') return message.includes(tableName)
  return message.includes(`relation "${tableName}" does not exist`)
}

/** Count of meta_links rows scoped to `field_id` — 0 (not an error) on a pre-migration DB missing meta_links. */
async function countMetaLinksByField(query: TombstoneQueryFn, fieldId: string): Promise<number> {
  try {
    const res = await query('SELECT COUNT(*)::int AS n FROM meta_links WHERE field_id = $1', [fieldId])
    return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0)
  } catch (err) {
    if (isUndefinedTableError(err, 'meta_links')) return 0
    throw err
  }
}

/**
 * Cap-check + count for a field-delete capture: column-value rows (meta_records with the key present) +
 * that field's link-edge rows. Does NOT count the auto-number sequence (at most one row; a definitional
 * side-payload, not a bulk tombstone insert) — the cap bounds bulk `INSERT ... SELECT` size, which the
 * sequence capture is not.
 */
export async function countFieldDeleteCaptureRows(
  query: TombstoneQueryFn,
  sheetId: string,
  fieldId: string,
): Promise<number> {
  const valueRes = await query('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1 AND data ? $2', [sheetId, fieldId])
  const valueCount = Number((valueRes.rows[0] as { n?: number } | undefined)?.n ?? 0)
  const linkCount = await countMetaLinksByField(query, fieldId)
  return valueCount + linkCount
}

/** Throws TombstoneCaptureCapExceededError if `totalRows` exceeds the resolved cap; no-op otherwise. */
export function assertWithinCaptureCap(totalRows: number, env: NodeJS.ProcessEnv = process.env): void {
  const cap = resolveTombstoneCaptureMaxRows(env)
  if (totalRows > cap) {
    throw new TombstoneCaptureCapExceededError(
      `This operation would capture ${totalRows} tombstone row(s), above the ${cap}-row capture ceiling ` +
        `(MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS). Raise the cap or disable capture to proceed; the destructive ` +
        `operation was refused so it can never run half-captured.`,
      totalRows,
      cap,
    )
  }
}

/**
 * Field-delete capture point 1/2: column values. Single batched `INSERT ... SELECT` — one row per
 * meta_records row that currently has the field's key present, BEFORE the `data - $fieldId` strip.
 * `value` stores the raw jsonb value under the key (preserves type: string/number/array/object/null).
 */
export async function insertFieldValueTombstones(
  query: TombstoneQueryFn,
  ctx: { sheetId: string; fieldId: string; configRevisionId: string },
): Promise<void> {
  await query(
    `INSERT INTO meta_field_value_tombstones (id, sheet_id, field_id, record_id, value, reason, config_revision_id, created_at)
     SELECT gen_random_uuid(), $1, $2, id, data -> $2, 'field_delete', $3, now()
     FROM meta_records WHERE sheet_id = $1 AND data ? $2`,
    [ctx.sheetId, ctx.fieldId, ctx.configRevisionId],
  )
}

/**
 * Field-delete capture point 2/2: this field's link edges. Single batched `INSERT ... SELECT`, BEFORE
 * `DELETE FROM meta_links WHERE field_id = $1` (which — see the module doc-comment — is in practice
 * already redundant with the `meta_fields` cascade delete, so this MUST run before that cascade-causing
 * delete, not merely before the textual `DELETE FROM meta_links` line).
 * Guarded for a pre-migration DB missing `meta_links` itself (degrades to "nothing to capture" — same
 * guard the existing forward cascade already applies to its own `DELETE FROM meta_links`). A MISSING
 * `meta_link_tombstones` table is NOT guarded — that must fail closed (roll back), per C3.
 */
export async function insertFieldLinkTombstones(
  query: TombstoneQueryFn,
  ctx: { sheetId: string; fieldId: string; configRevisionId: string },
): Promise<void> {
  try {
    await query(
      `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, created_at)
       SELECT gen_random_uuid(), $1, field_id, record_id, foreign_record_id, 'field_delete', $2, now()
       FROM meta_links WHERE field_id = $3`,
      [ctx.sheetId, ctx.configRevisionId, ctx.fieldId],
    )
  } catch (err) {
    if (!isUndefinedTableError(err, 'meta_links')) throw err
  }
}

/** Field-delete capture: read the auto-number sequence's CURRENT `next_value` before its cascade-delete. */
export async function readAutoNumberNextValue(query: TombstoneQueryFn, fieldId: string): Promise<number | null> {
  const res = await query('SELECT next_value FROM meta_field_auto_number_sequences WHERE field_id = $1', [fieldId])
  const row = res.rows[0] as { next_value?: unknown } | undefined
  if (!row || row.next_value === undefined || row.next_value === null) return null
  const n = Number(row.next_value)
  return Number.isFinite(n) ? n : null
}

/** Record-delete cap-check count: INBOUND link edges only (`foreign_record_id = $1`) — outbound edges are
 * already covered by `meta_records_trash`, see module doc-comment. 0 (not an error) if meta_links is missing. */
export async function countInboundLinkCaptureRows(query: TombstoneQueryFn, recordId: string): Promise<number> {
  try {
    const res = await query('SELECT COUNT(*)::int AS n FROM meta_links WHERE foreign_record_id = $1', [recordId])
    return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0)
  } catch (err) {
    if (isUndefinedTableError(err, 'meta_links')) return 0
    throw err
  }
}

/**
 * Record-delete capture: INBOUND link edges (`foreign_record_id = $1`) — must run BEFORE
 * `DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1` in `deleteRecord`. Outbound
 * edges (`record_id = $1`) are intentionally NOT captured here (see module doc-comment); a self-link
 * (`record_id = foreign_record_id`) is double-covered by both the outbound trash-replay and this inbound
 * capture, which is harmless. **4c-3 has since landed and DOES auto-replay inbound captures** (this
 * comment previously said they were "never auto-replayed / 4c-3 out of scope" — stale). What keeps the
 * self-link double from producing a duplicate edge is the replay's OWN `NOT EXISTS` guard
 * (`inbound-link-replay.ts:154`, "NOT EXISTS an identical meta_links row" — it explicitly kills the
 * self-link overlap), exactly as this comment once predicted 4c-3 would have to add. It is NOT the
 * outbound `ON CONFLICT DO NOTHING`, which only guards the random PK `id` (meta_links has no unique
 * constraint on the edge triple).
 */
export async function insertInboundLinkTombstones(
  query: TombstoneQueryFn,
  ctx: { sheetId: string; recordId: string; sourceRevisionId: string },
): Promise<void> {
  try {
    await query(
      `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, created_at)
       SELECT gen_random_uuid(), $1, field_id, record_id, foreign_record_id, 'record_delete', $2, now()
       FROM meta_links WHERE foreign_record_id = $3`,
      [ctx.sheetId, ctx.sourceRevisionId, ctx.recordId],
    )
  } catch (err) {
    if (!isUndefinedTableError(err, 'meta_links')) throw err
  }
}

/**
 * Capture point 3 (design-lock §2) — **WIRED AND LIVE** since 4c-1 landed. `applyLossyRetypeCellRewrite`
 * (`routes/univer-meta.ts:6407`) calls this BEFORE overwriting/dropping the pre-coerce cell values, passing
 * the rows it is about to lose (computed in JS during the coerce pass, since retype coercion is a per-row JS
 * transform, unlike the field-delete/record-delete points above which can select the pre-image straight out
 * of SQL). Anchors to the retype's OWN config revision id (§2 point 3 / §4 R2 — "the revision that triggered
 * the loss", not any later revert of it).
 * Batches via `jsonb_to_recordset` (the one existing bulk-insert-from-JS-array idiom in this module,
 * mirroring `record-subscription-service.ts`'s `insertRecordSubscriptionNotifications`) rather than a
 * per-row INSERT, consistent with the "single batched insert, no row-by-row round trip" discipline used
 * by the two other capture points. The caller is responsible for its own cap-check (this seam performs
 * none); the live caller satisfies that with `assertWithinCaptureCap(preImages.length)` immediately before
 * this call, inside the same `isTombstoneCaptureEnabled()` gate — so an over-cap capture THROWS and the
 * whole revert rolls back (fail-closed: "capture on ⇒ every destruction is already captured").
 */
export async function captureLossyRetypePreImageRows(
  query: TombstoneQueryFn,
  rows: ReadonlyArray<{ recordId: string; value: unknown }>,
  ctx: { sheetId: string; fieldId: string; configRevisionId: string },
): Promise<void> {
  if (rows.length === 0) return
  const payload = rows.map((r) => ({ record_id: r.recordId, value: r.value ?? null }))
  await query(
    `INSERT INTO meta_field_value_tombstones (id, sheet_id, field_id, record_id, value, reason, config_revision_id, created_at)
     SELECT gen_random_uuid(), $1, $2, item.record_id, item.value, 'lossy_retype', $3, now()
     FROM jsonb_to_recordset($4::jsonb) AS item(record_id text, value jsonb)`,
    [ctx.sheetId, ctx.fieldId, ctx.configRevisionId, JSON.stringify(payload)],
  )
}

// ── Field retype CONVERT pre-image (design-lock docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.2 / §3.6) ──
// The SIBLING of `captureLossyRetypePreImageRows` above, which is untouched. It differs in four ways, each locked:
//
//   1. UNCONDITIONAL. It is NOT gated by `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED`. A conversion with no pre-image has no
//      undo, so the conversion path never has a "skip the capture, rewrite anyway" branch: this function either writes
//      every row or throws, and a throw rolls the whole conversion back. The capture flag keeps meaning exactly what it
//      meant for field delete / record delete / lossy revert — this function neither reads nor changes it.
//   2. EVERY live row, not only the rows that change: empty cells and cells whose value is already the target value
//      are captured too. Undo compares the live record-id set against the pre-image set, so a row missing here would
//      read as "a record was added since the conversion".
//   3. ENVELOPE, not the raw cell. `value jsonb NOT NULL` cannot hold "the key was absent" or a JSON null, and undo
//      must restore the four empty states exactly (absent key / JSON null / '' / []). The stored value is
//      `{ "k": <the key was present>, "v": <the raw JSON value, null when absent>, "post": <the value written> }`.
//      Any reader of this table that meets `reason = 'retype_convert'` must read `value` as this envelope, never as a
//      cell value.
//   4. `operation_id` stays NULL (it is not in the column list). An operation that tags zero record events writes no
//      endpoint, so a tagged pre-image of an empty-sheet conversion would violate the endpoint FK at COMMIT; and
//      retention only prunes untagged groups, so a tag would make the pre-image immortal.
//
// The cap is checked HERE rather than by the caller, so no caller can forget it: above
// `MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS` the function throws `TombstoneCaptureCapExceededError` (HTTP 422) before
// writing anything.

export const RETYPE_CONVERT_TOMBSTONE_REASON = 'retype_convert'

/** The `value` of a `reason = 'retype_convert'` row. `k` false ⇒ the key was absent and `v` is null. */
export interface RetypeConvertPreImageEnvelope {
  k: boolean
  v: unknown
  post: unknown
}

export interface RetypeConvertPreImageRow {
  recordId: string
  /** `data ? fieldId` before the conversion. */
  hasKey: boolean
  /** `data -> fieldId` before the conversion; ignored (stored as null) when `hasKey` is false. */
  value: unknown
  /** The value the conversion writes (or, for an untouched cell, the value that is already there). */
  post: unknown
}

const RETYPE_CONVERT_CAPTURE_CHUNK_ROWS = 1000

export function toRetypeConvertPreImageEnvelope(row: Pick<RetypeConvertPreImageRow, 'hasKey' | 'value' | 'post'>): RetypeConvertPreImageEnvelope {
  return { k: row.hasKey === true, v: row.hasKey === true ? (row.value ?? null) : null, post: row.post ?? null }
}

/**
 * Write one pre-image row per live record. Returns the number of rows written, which always equals `rows.length`
 * (anything else throws). Runs on the caller's transaction `query`; must be called BEFORE the field or any cell is
 * rewritten.
 */
export async function captureRetypeConvertPreImageRows(
  query: TombstoneQueryFn,
  rows: ReadonlyArray<RetypeConvertPreImageRow>,
  ctx: { sheetId: string; fieldId: string; configRevisionId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const cap = resolveTombstoneCaptureMaxRows(env)
  if (rows.length > cap) {
    throw new TombstoneCaptureCapExceededError(
      `This conversion would capture ${rows.length} pre-image row(s), above the ${cap}-row capture ceiling ` +
        `(MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS). The conversion was refused; nothing was written.`,
      rows.length,
      cap,
    )
  }
  let written = 0
  for (let start = 0; start < rows.length; start += RETYPE_CONVERT_CAPTURE_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + RETYPE_CONVERT_CAPTURE_CHUNK_ROWS)
    const payload = chunk.map((row) => ({ record_id: row.recordId, value: toRetypeConvertPreImageEnvelope(row) }))
    const res = await query(
      `INSERT INTO meta_field_value_tombstones (id, sheet_id, field_id, record_id, value, reason, config_revision_id, created_at)
       SELECT gen_random_uuid(), $1, $2, item.record_id, item.value, 'retype_convert', $3::uuid, now()
       FROM jsonb_to_recordset($4::jsonb) AS item(record_id text, value jsonb)
       RETURNING record_id`,
      [ctx.sheetId, ctx.fieldId, ctx.configRevisionId, JSON.stringify(payload)],
    )
    if (res.rows.length !== chunk.length) {
      throw new Error(`retype-convert pre-image capture wrote ${res.rows.length} of ${chunk.length} rows; aborting`)
    }
    written += res.rows.length
  }
  return written
}
