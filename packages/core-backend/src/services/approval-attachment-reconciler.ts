/**
 * Approval attachments — slice ⑥: submit-time bind (form-freeze) + bucket reconciler (#4195 §7).
 *
 *   - `bindAttachmentsOnSubmit(trx, ...)` — the FORM-FREEZE step: on approval submission, flip the filler's
 *     `unbound` rows for the submitted field set to `bound` (stamping the instance) in the SUBMISSION
 *     transaction. Fail-closed guards: only rows uploaded BY the submitter bind (no cross-user capture);
 *     the ratified per-field count and per-submission byte caps are re-checked AT BIND (defense in depth —
 *     upload-time checks can be raced by parallel uploads); any violation throws → the whole submission
 *     rolls back. Once bound, rows are frozen (the GC never touches bound rows; slice ③).
 *   - `reconcileBucket(db, listBlobs)` — the BIDIRECTIONAL drift sweep:
 *       (a) blob WITHOUT a live row (upload crashed between blob-put and row-insert, slice ⑤ ordering) →
 *           enqueue a `reconciler_orphan` purge intent (idempotent by intent id), drained by slice ③;
 *       (b) live row WITHOUT a blob (store lost data) → surfaced values-free for alerting, NEVER auto-deleted
 *           (losing the row too would destroy the evidence that data was lost).
 *
 * Wired by createApproval (same-txn bind) + lifecycle workers (reconciler) when the flag is ON.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { APPROVAL_ATTACHMENT_LIMITS } from './approval-attachment-validation'

export interface BindResult {
  bound: number
}

/** Form-freeze: bind the submitter's unbound uploads to the instance inside the submission transaction. */
export async function bindAttachmentsOnSubmit(
  trx: Queryable,
  submitterId: string,
  instanceId: string,
  attachmentIdsByField: Readonly<Record<string, readonly string[]>>,
): Promise<BindResult> {
  if (!/[!-~]/.test(instanceId ?? '')) throw new RangeError('bindAttachmentsOnSubmit: instanceId required')
  let bound = 0
  for (const [fieldId, ids] of Object.entries(attachmentIdsByField)) {
    if (ids.length === 0) continue
    if (ids.length > APPROVAL_ATTACHMENT_LIMITS.maxFilesPerField) {
      throw new RangeError(`field ${fieldId}: ${ids.length} attachments exceeds the ratified per-field cap`)
    }
    // G4 / §4.4: unbound + owned + field-matched + NOT infected. Infected rows never bind.
    const res = await trx.query(
      `UPDATE approval_attachments
          SET status='bound', instance_id=$1, bound_at=now()
        WHERE id = ANY($2)
          AND field_id = $3
          AND uploader_id = $4
          AND status = 'unbound'
          AND COALESCE(scan_state, 'unscanned') <> 'infected'`,
      [instanceId, [...ids], fieldId, submitterId],
    )
    const n = Number(res.rowCount ?? 0)
    if (n !== ids.length) {
      // some id was missing / someone else's / already bound or deleted → fail the WHOLE submission.
      throw new RangeError(`field ${fieldId}: only ${n}/${ids.length} attachments bindable — submission rejected`)
    }
    bound += n
  }
  // per-submission byte cap re-checked at bind (parallel uploads can each pass the upload-time check).
  const tot = await trx.query(
    `SELECT COALESCE(sum(size_bytes),0)::bigint::text AS t FROM approval_attachments WHERE instance_id=$1 AND status='bound'`,
    [instanceId],
  )
  if (Number(tot.rows[0].t) > APPROVAL_ATTACHMENT_LIMITS.maxSubmissionBytes) {
    throw new RangeError('submission exceeds the ratified total-bytes cap — rejected')
  }
  return { bound }
}

export interface ReconcileResult {
  orphanBlobsQueued: number
  /** live rows whose blob is missing — values-free storage keys, for alerting. NEVER auto-deleted. */
  missingBlobs: string[]
}

/**
 * Default orphan grace window (§7/G15). The upload path is `store.put(blob)` THEN `INSERT row`, so a
 * blob briefly exists with NO row on the NORMAL happy path (the window between put and commit). The
 * reconciler MUST NOT mistake that in-flight object for an upload-crash orphan, so it only enqueues a
 * blob with no row once it is OLDER than this window — which MUST exceed the max plausible
 * upload→row-commit latency. Overridable via `reconcileBucket(..., { graceMs })` for ops tuning.
 */
export const RECONCILER_ORPHAN_GRACE_MS = 60 * 60 * 1000 // 1h ≫ any single synchronous multipart upload→commit

/** One object in the bucket, carrying its age so the reconciler can apply the grace window (G15). */
export interface ReconcilerBlob {
  key: string
  /** age of the object in the store: `now - written_at`, in ms (never negative in practice). */
  ageMs: number
}

/**
 * Bidirectional bucket⇄table reconciliation. `listBlobs` yields every object currently in the approval
 * bucket WITH its age. An orphan is enqueued ONLY when it has no row AND is older than the grace window
 * (G15): a row-less object younger than the grace is treated as a possibly-mid-upload/commit object and
 * is NEVER purged — the load-bearing guard against deleting a live upload's blob on the happy path.
 */
export async function reconcileBucket(
  db: Queryable,
  listBlobs: () => Promise<ReconcilerBlob[]>,
  opts: { graceMs?: number } = {},
): Promise<ReconcileResult> {
  const graceMs = opts.graceMs ?? RECONCILER_ORPHAN_GRACE_MS
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new RangeError(`graceMs must be a non-negative safe integer (got ${graceMs})`)
  }
  const blobs = await listBlobs()
  const { rows } = await db.query(`SELECT storage_key, status FROM approval_attachments`)
  const rowByKey = new Map((rows as Array<{ storage_key: string; status: string }>).map((r) => [r.storage_key, r.status]))
  const result: ReconcileResult = { orphanBlobsQueued: 0, missingBlobs: [] }
  // (a) blob with NO row at all AND older than the grace window → orphan (crashed upload); queue
  //     an idempotent purge intent. A row-less object younger than the grace is skipped: it may be a
  //     normal upload still between store.put and the row INSERT — purging it would be silent data loss.
  for (const { key, ageMs } of blobs) {
    if (rowByKey.has(key)) continue
    if (ageMs < graceMs) continue // younger than grace ⇒ possibly mid-upload/commit; NEVER an orphan (G15)
    const res = await db.query(
      `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
       VALUES ('pi_rec_' || md5($1), $1, 'reconciler_orphan')
       ON CONFLICT (id) DO NOTHING`,
      [key],
    )
    result.orphanBlobsQueued += Number(res.rowCount ?? 0)
  }
  // (b) live row whose blob vanished → surface, never delete.
  const blobSet = new Set(blobs.map((b) => b.key))
  for (const [key, status] of rowByKey) {
    if (status !== 'deleted' && !blobSet.has(key)) result.missingBlobs.push(key)
  }
  return result
}
