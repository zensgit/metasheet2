/**
 * 4c-2 forward tombstone-capture (design-lock 2026-07-07, #3809 + #3830 correction; owner-ratified
 * 2026-07-08). Shared capture helpers for the two ratified capture points:
 *   1. `dropFieldCascade` (univer-meta.ts) — column values + that field's link edges + auto-number
 *      sequence state, captured into `meta_field_value_tombstones` / `meta_link_tombstones`
 *      (reason='field_delete').
 *   2. `deleteRecord` (record-service.ts) — INBOUND link edges only, captured into
 *      `meta_link_tombstones` (reason='record_delete'). Outbound edges are already covered by
 *      `meta_records_trash` (the trashed row's `data` still carries the link-field arrays and
 *      `restoreRecord` replays them) — capturing them again here would be redundant.
 *
 * Both capture points are same-txn, placed BEFORE the destructive statement(s) they shadow, and use a
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
 * capture, which is harmless. The reason no duplicate row can result is that inbound captures are never
 * auto-replayed (4c-3 out of scope) — NOT the outbound `ON CONFLICT DO NOTHING`, which only guards the
 * random PK `id` (meta_links has no unique on the edge triple). When 4c-3 wires inbound replay, it must
 * carry its own NOT-EXISTS guard (as the field-undelete link rehydration already does).
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
 * RESERVED SEAM (design-lock §2 capture point 3) — NOT wired to any retype path in this PR. When the 4c-1
 * lossy-retype-revert lands, its coerce-write step should call this BEFORE overwriting/dropping the
 * pre-coerce cell values, passing the rows it is about to lose (already computed in JS during the coerce
 * pass, since retype coercion is a per-row JS transform, unlike the field-delete/record-delete points
 * above which can select the pre-image straight out of SQL). Anchors to the retype's OWN config revision
 * id (§2 point 3 / §4 R2 — "the revision that triggered the loss", not any later revert of it).
 * Batches via `jsonb_to_recordset` (the one existing bulk-insert-from-JS-array idiom in this module,
 * mirroring `record-subscription-service.ts`'s `insertRecordSubscriptionNotifications`) rather than a
 * per-row INSERT, consistent with the "single batched insert, no row-by-row round trip" discipline used
 * by the two wired capture points. The caller is responsible for its own cap-check (this seam performs
 * none) — 4c-1 must add one when it wires this in.
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
