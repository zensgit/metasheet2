import type { ApprovalAssigneeResolutionMetadata } from '../types/approval-product'

/** Lock-4 F4-D / OD-L4-7(a): K3 seats are exempt from history-derived dedup only. */
export function isPriorNodeApproverHistoryDedupExempt(
  metadata: ApprovalAssigneeResolutionMetadata | undefined,
): boolean {
  return metadata?.resolvedFrom?.kind === 'prior_node_approver'
}
