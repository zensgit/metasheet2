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
 * No callers yet — wired behind the attachment flag with the boot slice.
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
    const res = await trx.query(
      `UPDATE approval_attachments
          SET status='bound', instance_id=$1, bound_at=now()
        WHERE id = ANY($2) AND field_id = $3 AND uploader_id = $4 AND status = 'unbound'`,
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

/** Bidirectional bucket⇄table reconciliation. `listBlobs` yields every storage key currently in the bucket. */
export async function reconcileBucket(db: Queryable, listBlobs: () => Promise<string[]>): Promise<ReconcileResult> {
  const blobKeys = await listBlobs()
  const { rows } = await db.query(`SELECT storage_key, status FROM approval_attachments`)
  const rowByKey = new Map((rows as Array<{ storage_key: string; status: string }>).map((r) => [r.storage_key, r.status]))
  const result: ReconcileResult = { orphanBlobsQueued: 0, missingBlobs: [] }
  // (a) blob with NO row at all → orphan (crashed upload); queue idempotent purge intent.
  for (const key of blobKeys) {
    if (!rowByKey.has(key)) {
      const res = await db.query(
        `INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
         VALUES ('pi_rec_' || md5($1), $1, 'reconciler_orphan')
         ON CONFLICT (id) DO NOTHING`,
        [key],
      )
      result.orphanBlobsQueued += Number(res.rowCount ?? 0)
    }
  }
  // (b) live row whose blob vanished → surface, never delete.
  const blobSet = new Set(blobKeys)
  for (const [key, status] of rowByKey) {
    if (status !== 'deleted' && !blobSet.has(key)) result.missingBlobs.push(key)
  }
  return result
}
