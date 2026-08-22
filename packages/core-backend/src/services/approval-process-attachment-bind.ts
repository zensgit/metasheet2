/**
 * Lock-9 (approver process attachments) — the process-bind module (OD-L9-7(a), G-6, G-8).
 *
 * A NEW module, deliberately NOT calling `bindAttachmentsOnSubmit` (OD-L9-7 rejected arm (b)):
 * that function's WHERE keys on `field_id = $3`, which a process (fieldless) row can never match.
 * This module mirrors its SHAPE — the rowCount-equality → throw → whole-action-rollback contract
 * (`approval-attachment-reconciler.ts:bindAttachmentsOnSubmit`) — without sharing its code path.
 *
 * Caps are process-scoped (OD-L9-8(a)): a SEPARATE per-action budget over `bind_kind='process'`
 * rows only, independent of the requester's `maxSubmissionBytes` form envelope
 * (`approval-attachment-validation.ts`). The exact numbers below are RECOMMENDED, not locked — OD-
 * L9-8: "the exact numbers are the owner's to set; the process-scoped SHAPE is what is locked."
 * Single-sourced here as named, frozen constants so the owner can change them without a code hunt.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'

/** OD-L9-8: RECOMMENDED, NOT locked — the process-scoped SHAPE (separate budget) is what is locked. */
export const APPROVAL_PROCESS_ATTACHMENT_LIMITS = Object.freeze({
  maxFilesPerAction: 5,
  maxBytesPerAction: 25 * 1024 * 1024,
})

export interface ProcessBindResult {
  bound: number
}

/** Bind-time failure with the lock's HTTP status. Mirrors `ApprovalAttachmentBindError`'s shape
 *  (own class, not reused — this module is a NEW independent code path, OD-L9-7(a)). */
export class ApprovalProcessAttachmentBindError extends Error {
  readonly httpStatus: 400 | 413
  constructor(message: string, httpStatus: 400 | 413 = 400) {
    super(message)
    this.name = 'ApprovalProcessAttachmentBindError'
    this.httpStatus = httpStatus
  }
}

/**
 * Upload-time fail-fast budget check (NEW CODE, not authoritative — the bind-time re-check below
 * is). Counts the uploader's own STILL-STAGED (`unbound`, `bind_kind='process'`) rows for this
 * staged instance, so an uploader cannot accumulate more than an action could ever bind. Values-
 * free: throws carry no filename/uploader/size (OD-L9-12).
 *
 * DISCLOSED SHAPE NOTE (caught in review): this scope is per STAGED INSTANCE (cumulative across
 * every never-bound upload against that instance, however old), while the bind-time check below is
 * per ACTION (scoped to only the ids named in one `bindProcessAttachmentsOnAction` call) — two
 * different meanings of "per action" under the OD-L9-8 budget name, which do not compose. Concrete
 * consequence: an approver who stages 5 files, binds 3 via one comment, and then wants to stage 3
 * MORE for a second comment on the same instance hits this upload-time 413 immediately — the 2
 * abandoned unbound rows from the first round still count here until the uploader DELETEs them or
 * the 168h TTL sweep reclaims them. This is not a security hole (bind-time is the authority,
 * OD-L9-7), but it is a real shape gap against OD-L9-8's "the process-scoped SHAPE is what is
 * locked" — recorded here and in the PR body rather than left silently mismatched.
 */
export async function assertProcessUploadBudget(
  trx: Queryable,
  opts: { uploaderId: string; orgId: string; stagedInstanceId: string; incomingBytes: number },
): Promise<void> {
  const { rows } = await trx.query(
    `SELECT count(*)::int AS n, COALESCE(sum(size_bytes),0)::bigint::text AS bytes
       FROM approval_attachments
      WHERE staged_instance_id = $1 AND uploader_id = $2 AND org_id = $3
        AND bind_kind = 'process' AND status = 'unbound'`,
    [opts.stagedInstanceId, opts.uploaderId, opts.orgId],
  )
  const row = rows[0] as { n: number; bytes: string } | undefined
  const existingCount = Number(row?.n ?? 0)
  const existingBytes = Number(row?.bytes ?? 0)
  if (existingCount + 1 > APPROVAL_PROCESS_ATTACHMENT_LIMITS.maxFilesPerAction) {
    throw new ApprovalProcessAttachmentBindError('too many staged process attachments for this action', 413)
  }
  if (existingBytes + opts.incomingBytes > APPROVAL_PROCESS_ATTACHMENT_LIMITS.maxBytesPerAction) {
    throw new ApprovalProcessAttachmentBindError('staged process attachments exceed the per-action byte cap', 413)
  }
}

/**
 * Bind-at-action-commit (OD-L9-7(a)): a single UPDATE claiming the uploader's own STAGED
 * (`unbound`, `bind_kind='process'`) rows targeting THIS instance (`staged_instance_id = $1` — an
 * approver who staged against instance A cannot bind to instance B, OD-L9-5), stamping
 * `instance_id`, `node_key` and `action_record_id` all at once. The rowCount-equality → throw
 * contract (copied from `bindAttachmentsOnSubmit`, `reconciler.ts:93-100`) makes a partial bind
 * impossible: any missing/foreign/already-bound/infected id throws and the caller's transaction
 * rolls back the WHOLE action (dispatchAction's existing catch/finally), never a half-bound state.
 *
 * Runs INSIDE the caller's action transaction — `trx` must be the same client dispatchAction holds
 * across `BEGIN`/`COMMIT`.
 */
export async function bindProcessAttachmentsOnAction(
  trx: Queryable,
  opts: {
    attachmentIds: readonly string[]
    instanceId: string
    nodeKey: string | null
    actionRecordId: string
    actorId: string
    orgId: string
  },
): Promise<ProcessBindResult> {
  const ids = [...new Set(opts.attachmentIds)]
  if (ids.length === 0) return { bound: 0 }
  if (!/[!-~]/.test(opts.instanceId ?? '')) throw new RangeError('bindProcessAttachmentsOnAction: instanceId required')
  if (!/[!-~]/.test(opts.orgId ?? '')) throw new RangeError('bindProcessAttachmentsOnAction: orgId required')
  if (ids.length > APPROVAL_PROCESS_ATTACHMENT_LIMITS.maxFilesPerAction) {
    throw new ApprovalProcessAttachmentBindError(
      `${ids.length} process attachments exceeds the ratified per-action cap`,
      413,
    )
  }
  const res = await trx.query(
    `UPDATE approval_attachments
        SET status = 'bound', instance_id = $1, node_key = $2, action_record_id = $3, bound_at = now()
      WHERE id = ANY($4) AND uploader_id = $5 AND org_id = $6
        AND bind_kind = 'process' AND status = 'unbound'
        AND staged_instance_id = $1 AND scan_state <> 'infected'`,
    [opts.instanceId, opts.nodeKey, opts.actionRecordId, ids, opts.actorId, opts.orgId],
  )
  const n = Number(res.rowCount ?? 0)
  if (n !== ids.length) {
    // some id was missing / someone else's / staged against a different instance / already bound /
    // deleted / infected → fail the WHOLE action (OD-L9-7 fail-closed rollback).
    throw new ApprovalProcessAttachmentBindError(
      `only ${n}/${ids.length} process attachments bindable — action rejected`,
      400,
    )
  }
  // per-action byte cap re-checked AFTER bind, over the just-bound rows only (defense in depth —
  // mirrors bindAttachmentsOnSubmit's post-UPDATE total-bytes re-check; a parallel stage could have
  // grown past the upload-time fail-fast between check and bind).
  const tot = await trx.query(
    `SELECT COALESCE(sum(size_bytes),0)::bigint::text AS t
       FROM approval_attachments
      WHERE id = ANY($1) AND bind_kind = 'process' AND status = 'bound'`,
    [ids],
  )
  if (Number(tot.rows[0].t) > APPROVAL_PROCESS_ATTACHMENT_LIMITS.maxBytesPerAction) {
    throw new ApprovalProcessAttachmentBindError('process attachments exceed the ratified per-action byte cap', 413)
  }
  return { bound: n }
}
