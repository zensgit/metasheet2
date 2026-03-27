export function resolveApprovalInboxActionStatusAfterRefresh(
  currentStatus: string,
  preserveActionStatus = false,
) {
  return preserveActionStatus ? currentStatus : ''
}

export function resolveApprovalInboxErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') {
    return fallback
  }

  const record = payload as Record<string, unknown>
  const nestedError = record.error
  if (nestedError && typeof nestedError === 'object') {
    const nestedMessage = (nestedError as Record<string, unknown>).message
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim()
    }
  }

  const topLevelMessage = record.message
  if (typeof topLevelMessage === 'string' && topLevelMessage.trim()) {
    return topLevelMessage.trim()
  }

  return fallback
}
