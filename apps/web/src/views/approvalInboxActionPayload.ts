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
  version: number,
): Record<string, string | number> {
  const normalizedComment = normalizeApprovalInboxComment(comment)
  const payload: Record<string, string | number> = { version }

  if (action === 'approve') {
    if (normalizedComment) {
      payload.comment = normalizedComment
    }
    return payload
  }

  if (!normalizedComment) {
    return payload
  }

  payload.reason = normalizedComment
  payload.comment = normalizedComment
  return payload
}
