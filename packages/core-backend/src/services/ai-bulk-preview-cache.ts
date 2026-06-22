/**
 * Multitable AI bulk-preview run cache (B-1) — the PERSISTENT store of one
 * generated proposed value per (runId, recordId).
 *
 * Design lock §3/§4:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 *
 *  - NOT in-memory: a later confirm-write (B-2) reads the cached value, so a
 *    confirm survives a process restart and is always explainable.
 *  - One row per GENERATED output (provider-called row). The CHARGE itself is
 *    booked in multitable_ai_usage_ledger at preview time, INDEPENDENT of this
 *    cache — a TTL sweep over expires_at GC's abandoned runs but NEVER
 *    un-charges them (charge-on-generation, never released).
 *  - Stores only the single proposed TARGET value (`proposed_value`), the
 *    `preview_version` it was generated against (anti-TOCTOU: B-2 rides this
 *    into patchRecords as expectedVersion), and the per-row usage/cost actually
 *    settled. NEVER stores prompt or source text.
 */


export const AI_BULK_PREVIEW_CACHE_TABLE = 'multitable_ai_bulk_preview_cache'

/** Default cache TTL (ms) — a short window GC's abandoned runs cheaply (§3). */
export const AI_BULK_PREVIEW_CACHE_TTL_MS = 30 * 60_000

export type AiBulkPreviewCacheQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface BulkPreviewCacheRow {
  runId: string
  actorId: string
  sheetId: string
  fieldId: string
  recordId: string
  /** The record `version` the proposal was generated against (B-2 expectedVersion). */
  previewVersion: number
  /** The AI-generated proposed value for the target field. */
  proposedValue: string
  /** prompt + completion tokens actually settled for this row. */
  usageTokens: number
  /** 估算 cost actually settled for this row. */
  costUsd: number
  /** Absolute expiry; defaults to now + AI_BULK_PREVIEW_CACHE_TTL_MS. */
  expiresAt?: Date
}

/**
 * Insert one cached output row (PK = (run_id, record_id)). `proposed_value` is
 * stored EXACTLY as previewed — NO redaction. The cache is the value B-2 commits,
 * and it MUST equal what the user reviewed ("confirm what you see = what's written");
 * it also matches the per-record run, which writes the raw model text to the field
 * (multitable-ai.ts shortcut/run, `value: result.text`). Redacting here would commit
 * a different value than the user confirmed. (The cache is short-lived + TTL'd, and
 * the same raw text reaches the field on commit regardless, so there is nothing to
 * "defend" by diverging the stored value from the previewed one.)
 */
export async function insertBulkPreviewCacheRow(
  query: AiBulkPreviewCacheQueryFn,
  row: BulkPreviewCacheRow,
): Promise<void> {
  const expiresAt = row.expiresAt ?? new Date(Date.now() + AI_BULK_PREVIEW_CACHE_TTL_MS)
  await query(
    `INSERT INTO ${AI_BULK_PREVIEW_CACHE_TABLE}
       (run_id, record_id, actor_id, sheet_id, field_id, preview_version,
        proposed_value, usage_tokens, cost_usd, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (run_id, record_id) DO NOTHING`,
    [
      row.runId,
      row.recordId,
      row.actorId,
      row.sheetId,
      row.fieldId,
      Math.max(0, Math.round(row.previewVersion)),
      row.proposedValue,
      Math.max(0, Math.round(row.usageTokens)),
      row.costUsd,
      expiresAt.toISOString(),
    ],
  )
}

/** Read all cached rows for a run (B-2 commit reads this). Exported for tests + the future commit ring. */
export async function readBulkPreviewCacheRows(
  query: AiBulkPreviewCacheQueryFn,
  runId: string,
): Promise<Array<{
  runId: string
  recordId: string
  actorId: string
  sheetId: string
  fieldId: string
  previewVersion: number
  proposedValue: string
  usageTokens: number
  costUsd: number
  expiresAt: string
}>> {
  const result = await query(
    `SELECT run_id, record_id, actor_id, sheet_id, field_id, preview_version,
            proposed_value, usage_tokens, cost_usd, expires_at
       FROM ${AI_BULK_PREVIEW_CACHE_TABLE}
      WHERE run_id = $1
      ORDER BY created_at ASC`,
    [runId],
  )
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    runId: String(r.run_id),
    recordId: String(r.record_id),
    actorId: String(r.actor_id),
    sheetId: String(r.sheet_id),
    fieldId: String(r.field_id),
    previewVersion: Number(r.preview_version ?? 0),
    proposedValue: String(r.proposed_value ?? ''),
    usageTokens: Number(r.usage_tokens ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    expiresAt: String(r.expires_at),
  }))
}
