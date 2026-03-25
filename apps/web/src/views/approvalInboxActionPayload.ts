export type ApprovalInboxAction = 'approve' | 'reject'

export function normalizeApprovalInboxComment(value: string): string {
  return value.trim()
}

export function canSubmitApprovalInboxAction(
  action: ApprovalInboxAction,
  comment: string,
): boolean {
  if (action === 'approve') {
    return true
  }

  return Boolean(normalizeApprovalInboxComment(comment))
}

export function buildApprovalInboxActionPayload(
  action: ApprovalInboxAction,
  comment: string,
): Record<string, string> {
  const normalizedComment = normalizeApprovalInboxComment(comment)

  if (action === 'approve') {
    return normalizedComment ? { comment: normalizedComment } : {}
  }

  if (!normalizedComment) {
    return {}
  }

  return {
    reason: normalizedComment,
    comment: normalizedComment,
  }
}
