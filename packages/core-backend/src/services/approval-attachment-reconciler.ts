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
 * WIRED: bindAttachmentsOnSubmit runs inside ApprovalProductService.createApproval's transaction
 * (flag-gated); reconcileBucket runs on the boot runtime's flag-gated timer (dedicated-root scope).
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { APPROVAL_ATTACHMENT_LIMITS } from './approval-attachment-validation'

export interface BindResult {
  bound: number
}

/**
 * Bind-time failure with the lock's HTTP status. Cap/count/total violations are 413; other
 * unbindable ids (foreign / missing / infected / already bound) stay 400 (fail-closed create).
 */
export class ApprovalAttachmentBindError extends Error {
  readonly httpStatus: 400 | 413
  constructor(message: string, httpStatus: 400 | 413 = 400) {
    super(message)
    this.name = 'ApprovalAttachmentBindError'
    this.httpStatus = httpStatus
  }
}

/**
 * Extract the attachment-id arrays from a submission's normalized form data, keyed by the schema's
 * `attachment`-typed field ids (§4.4: the frozen snapshot value IS the id array). Fail-closed on shape:
 * a present value that is not an array of non-blank strings throws (the whole create must fail — a
 * malformed value must never freeze into `form_snapshot` half-interpreted). Absent/empty values skip.
 */
export function collectAttachmentIdsByField(
  formSchema: { fields?: ReadonlyArray<{ id?: unknown; type?: unknown } | null | undefined> | null },
  formData: Readonly<Record<string, unknown>>,
): Record<string, string[]> {
  const byField: Record<string, string[]> = {}
  for (const field of formSchema.fields ?? []) {
    if (!field || field.type !== 'attachment' || typeof field.id !== 'string' || field.id.length === 0) continue
    const value = formData[field.id]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !/[!-~]/.test(id))) {
      throw new RangeError(`attachment field ${field.id}: value must be an array of attachment ids`)
    }
    if (value.length === 0) continue
    byField[field.id] = value as string[]
  }
  return byField
}

/** Form-freeze: bind the submitter's unbound uploads to the instance inside the submission transaction. */
export async function bindAttachmentsOnSubmit(
  trx: Queryable,
  submitterId: string,
  orgId: string,
  instanceId: string,
  attachmentIdsByField: Readonly<Record<string, readonly string[]>>,
): Promise<BindResult> {
  if (!/[!-~]/.test(orgId ?? '')) throw new RangeError('bindAttachmentsOnSubmit: orgId required')
  if (!/[!-~]/.test(instanceId ?? '')) throw new RangeError('bindAttachmentsOnSubmit: instanceId required')
  let bound = 0
  for (const [fieldId, ids] of Object.entries(attachmentIdsByField)) {
    if (ids.length === 0) continue
    if (ids.length > APPROVAL_ATTACHMENT_LIMITS.maxFilesPerField) {
      // bind-time per-field count cap → 413 (same semantics as upload-time too_many_files).
      throw new ApprovalAttachmentBindError(
        `field ${fieldId}: ${ids.length} attachments exceeds the ratified per-field cap`,
        413,
      )
    }
    // §4.4 / §6: only unbound, non-infected, submitter-owned, org-pinned, field-matched rows bind.
    // `scan_state <> 'infected'` is load-bearing — infected is never bindable even if still unbound.
    const res = await trx.query(
      `UPDATE approval_attachments
          SET status='bound', instance_id=$1, bound_at=now()
        WHERE id = ANY($2) AND field_id = $3 AND uploader_id = $4 AND org_id = $5
          AND status = 'unbound'
          AND scan_state <> 'infected'`,
      [instanceId, [...ids], fieldId, submitterId, orgId],
    )
    const n = Number(res.rowCount ?? 0)
    if (n !== ids.length) {
      // some id was missing / someone else's / already bound / deleted / infected → fail the WHOLE submission.
      throw new ApprovalAttachmentBindError(
        `field ${fieldId}: only ${n}/${ids.length} attachments bindable — submission rejected`,
        400,
      )
    }
    bound += n
  }
  // per-submission byte cap re-checked at bind (parallel uploads can each pass the upload-time check).
  const tot = await trx.query(
    `SELECT COALESCE(sum(size_bytes),0)::bigint::text AS t FROM approval_attachments WHERE instance_id=$1 AND status='bound'`,
    [instanceId],
  )
  if (Number(tot.rows[0].t) > APPROVAL_ATTACHMENT_LIMITS.maxSubmissionBytes) {
    throw new ApprovalAttachmentBindError('submission exceeds the ratified total-bytes cap — rejected', 413)
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
       ON CONFLICT (storage_key) DO NOTHING`,
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
