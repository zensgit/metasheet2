/**
 * P1b slice 3 — pure helpers for the admin 批量转交 page.
 *
 * Kept out of the view so the two things that are easy to get wrong can be
 * tested directly: joining the server's `{succeeded, skipped}` answer back onto
 * the rows the operator selected, and naming every skip code the server can
 * actually return.
 *
 * No API calls, no Element Plus, no store.
 */
import type { ApprovalBulkReassignResultDTO } from './api'

export type ApprovalBatchTransferOutcomeKind = 'transferred' | 'skipped' | 'unreported'

export interface ApprovalBatchTransferRowOutcome {
  id: string
  kind: ApprovalBatchTransferOutcomeKind
  /** Present only for `skipped`; the raw server code, unmapped. */
  reason?: string
}

/**
 * Every skip code `ApprovalBulkReassignSkipReason` declares, in the server's own
 * order. Kept as a literal map (not a lookup with a generic default) so a code
 * added server-side shows up as an unmapped value in `describeSkipReason`
 * instead of being folded into a neighbouring label.
 */
export const APPROVAL_BATCH_TRANSFER_SKIP_LABELS: Record<string, { zh: string; en: string }> = {
  'not-found': { zh: '未找到该审批', en: 'Approval not found' },
  'not-pending': { zh: '该审批已不在待办中', en: 'No longer pending' },
  'not-assigned': { zh: '原审批人已不在该审批的处理人中', en: 'Source approver no longer holds a seat' },
  'target-is-requester': { zh: '目标用户是该审批的发起人', en: 'Target user is the requester' },
  'target-already-assignee': { zh: '目标用户已是该审批的处理人', en: 'Target user already holds a seat' },
  'target-user-invalid': { zh: '目标用户在该审批的范围内不可用', en: 'Target user is not valid for this approval' },
  error: { zh: '该审批处理未成功', en: 'This approval was not processed' },
}

const UNKNOWN_SKIP_LABEL = { zh: '未转交（原因未知）', en: 'Not transferred (unrecognised reason)' }

/**
 * Values-free by construction: the returned text names the outcome, never the
 * approval's content and never the raw code. The raw code is returned alongside
 * so a caller can surface it in a machine-readable attribute if it wants to.
 */
export function describeSkipReason(reason: string | undefined, isZh: boolean): string {
  const entry = reason ? APPROVAL_BATCH_TRANSFER_SKIP_LABELS[reason] : undefined
  const chosen = entry ?? UNKNOWN_SKIP_LABEL
  return isZh ? chosen.zh : chosen.en
}

export function isKnownSkipReason(reason: string | undefined): boolean {
  return Boolean(reason && Object.prototype.hasOwnProperty.call(APPROVAL_BATCH_TRANSFER_SKIP_LABELS, reason))
}

/**
 * Joins the server's answer back onto the ids the operator submitted.
 *
 * `succeeded` carries ids only, and `skipped` carries `{id, reason}` — neither
 * is ordered against the submitted list, so the row report is built by lookup,
 * in the operator's own row order. An id the server mentioned in NEITHER array
 * is reported as `unreported` rather than being silently shown as transferred:
 * "the server did not say" and "the server said yes" must not render the same.
 */
export function buildTransferOutcomes(
  submittedIds: readonly string[],
  result: ApprovalBulkReassignResultDTO,
): ApprovalBatchTransferRowOutcome[] {
  const succeeded = new Set(result.succeeded)
  const skipped = new Map(result.skipped.map((entry) => [entry.id, entry.reason]))
  return submittedIds.map((id) => {
    if (succeeded.has(id)) return { id, kind: 'transferred' as const }
    const reason = skipped.get(id)
    if (reason !== undefined) return { id, kind: 'skipped' as const, reason }
    return { id, kind: 'unreported' as const }
  })
}

export interface ApprovalBatchTransferSummary {
  submitted: number
  transferred: number
  skipped: number
  unreported: number
}

export function summarizeTransferOutcomes(
  outcomes: readonly ApprovalBatchTransferRowOutcome[],
): ApprovalBatchTransferSummary {
  return {
    submitted: outcomes.length,
    transferred: outcomes.filter((outcome) => outcome.kind === 'transferred').length,
    skipped: outcomes.filter((outcome) => outcome.kind === 'skipped').length,
    unreported: outcomes.filter((outcome) => outcome.kind === 'unreported').length,
  }
}

export type ApprovalBatchTransferBlockReason =
  | 'no-source'
  | 'no-target'
  | 'same-user'
  | 'no-selection'
  | 'no-reason'
  | 'over-limit'

/**
 * Client-side preflight. Every arm mirrors a refusal the endpoint already
 * makes (`fromUserId`/`toUserId`/`reason` required, the two ids must differ,
 * at most 200 instances) — this is an affordance, not a second authority: the
 * server still decides.
 */
export function blockReasonForTransfer(input: {
  fromUserId: string
  toUserId: string
  reason: string
  selectedIds: readonly string[]
  limit?: number
}): ApprovalBatchTransferBlockReason | null {
  const limit = input.limit ?? 200
  if (!input.fromUserId.trim()) return 'no-source'
  if (!input.toUserId.trim()) return 'no-target'
  if (input.fromUserId.trim() === input.toUserId.trim()) return 'same-user'
  if (input.selectedIds.length === 0) return 'no-selection'
  if (!input.reason.trim()) return 'no-reason'
  if (input.selectedIds.length > limit) return 'over-limit'
  return null
}
