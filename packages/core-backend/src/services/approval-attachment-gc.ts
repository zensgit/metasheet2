/**
 * Approval attachments — slice ③: durable-purge GC worker + unbound-TTL sweep (#4195 §3/§7/O2).
 *
 *   - `sweepUnboundAttachments(db, ttlHours)` — rows still `unbound` past the ratified TTL (O2 = 168 h)
 *     transition to `deleted` AND write their purge intent in the SAME statement-transaction (CTE), so the
 *     blob can never be orphaned by a crash between the row transition and the intent write (§7 bind↔GC
 *     symmetry by construction). Bound rows are NEVER swept.
 *   - `drainPurgeIntents(db, deleteBlob, opts)` — claims pending intents and calls the injected blob
 *     deleter. Blob-delete SUCCEEDS → intent `done`. Blob-delete THROWS → intent stays `pending` for the
 *     next drain (at-least-once purge; the blob store treats delete as idempotent / missing-is-ok, so
 *     double-delete is harmless). A missing blob (`false` from the deleter) also completes the intent —
 *     purge is about convergence, not bookkeeping.
 *   - Safety invariant enforced here (defense in depth): an intent is NEVER drained while a NON-deleted
 *     `approval_attachments` row still references its storage_key — a still-referenced blob is skipped and
 *     surfaced via the result for the reconciler to inspect (never silently deleted).
 *
 * No callers yet — the worker is wired behind the attachment flag with the provider/routes slice.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export const UNBOUND_ATTACHMENT_TTL_HOURS = 168 // ratified O2

export interface UnboundSweepResult {
  swept: number
}

/** TTL-sweep unbound rows → deleted + purge intent, one atomic statement (CTE). */
export async function sweepUnboundAttachments(db: Queryable, ttlHours: number = UNBOUND_ATTACHMENT_TTL_HOURS): Promise<UnboundSweepResult> {
  if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > 8760) {
    throw new RangeError(`ttlHours must be a safe integer in [1, 8760] (got ${ttlHours})`)
  }
  const res = await db.query(
    `WITH expired AS (
       SELECT id, storage_key FROM approval_attachments
        WHERE status = 'unbound' AND created_at <= now() - ($1::int * interval '1 hour')
        FOR UPDATE SKIP LOCKED
     ),
     flipped AS (
       UPDATE approval_attachments a SET status = 'deleted'
         FROM expired e WHERE a.id = e.id
       RETURNING e.id, e.storage_key
     )
     INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
     SELECT 'pi_' || f.id, f.storage_key, 'unbound_ttl' FROM flipped f
     ON CONFLICT (id) DO NOTHING`,
    [ttlHours],
  )
  return { swept: Number(res.rowCount ?? 0) }
}

export interface PurgeDrainResult {
  purged: number
  /** intents whose storage_key is STILL referenced by a live row — skipped, for the reconciler. */
  skippedStillReferenced: string[]
  /** deleter threw — intent left pending for the next drain. */
  failed: number
}

/**
 * Drain pending purge intents through the injected blob deleter. Returns per-category counts; never throws
 * for a single blob's failure.
 */
export async function drainPurgeIntents(
  db: Queryable,
  deleteBlob: (storageKey: string) => Promise<boolean>,
  opts: { batchSize?: number } = {},
): Promise<PurgeDrainResult> {
  const batchSize = opts.batchSize ?? 100
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError(`batchSize must be a safe integer in [1, 10000] (got ${batchSize})`)
  }
  const { rows } = await db.query(
    `SELECT i.id, i.storage_key,
            EXISTS (SELECT 1 FROM approval_attachments a
                     WHERE a.storage_key = i.storage_key AND a.status <> 'deleted') AS still_referenced
       FROM approval_attachment_purge_intents i
      WHERE i.status = 'pending'
      ORDER BY i.created_at ASC
      LIMIT $1::int
      FOR UPDATE OF i SKIP LOCKED`,
    [batchSize],
  )
  const result: PurgeDrainResult = { purged: 0, skippedStillReferenced: [], failed: 0 }
  for (const r of rows as Array<{ id: string; storage_key: string; still_referenced: boolean }>) {
    if (r.still_referenced) {
      // safety: NEVER delete a blob a live row still points at — reconciler's problem, not ours.
      result.skippedStillReferenced.push(r.storage_key)
      continue
    }
    try {
      await deleteBlob(r.storage_key)
      await db.query(`UPDATE approval_attachment_purge_intents SET status='done', purged_at=now() WHERE id=$1 AND status='pending'`, [r.id])
      result.purged += 1
    } catch {
      result.failed += 1 // stays pending; next drain retries (blob delete is idempotent)
    }
  }
  return result
}
