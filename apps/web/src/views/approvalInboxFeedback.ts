export function resolveApprovalInboxActionStatusAfterRefresh(
  currentStatus: string,
  preserveActionStatus = false,
) {
  return preserveActionStatus ? currentStatus : ''
}

interface ApprovalInboxErrorResponse {
  status: number
  statusText: string
  json: () => Promise<unknown>
}

interface ApprovalInboxErrorRecord {
  code: string | null
  currentVersion: number | null
  message: string
}

interface ApprovalInboxVersionedEntry {
  id: string
  version: number
}

export function resolveApprovalInboxErrorMessage(payload: unknown, fallback: string) {
  return resolveApprovalInboxErrorRecord(payload, fallback).message
}

export function resolveApprovalInboxErrorRecord(
  payload: unknown,
  fallback: string,
): ApprovalInboxErrorRecord {
  if (!payload || typeof payload !== 'object') {
    return {
      code: null,
      currentVersion: null,
      message: fallback,
    }
  }

  const record = payload as Record<string, unknown>
  const nestedError = record.error
  if (nestedError && typeof nestedError === 'object') {
    const nestedRecord = nestedError as Record<string, unknown>
    const nestedMessage = nestedRecord.message
    const nestedCode = typeof nestedRecord.code === 'string' && nestedRecord.code.trim() ? nestedRecord.code : null
    const nestedCurrentVersion =
      typeof nestedRecord.currentVersion === 'number' && Number.isInteger(nestedRecord.currentVersion)
        ? nestedRecord.currentVersion
        : null
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return {
        code: nestedCode,
        currentVersion: nestedCurrentVersion,
        message: nestedMessage.trim(),
      }
    }
  }

  const topLevelMessage = record.message
  if (typeof topLevelMessage === 'string' && topLevelMessage.trim()) {
    return {
      code: null,
      currentVersion: null,
      message: topLevelMessage.trim(),
    }
  }

  return {
    code: null,
    currentVersion: null,
    message: fallback,
  }
}

export async function readApprovalInboxError(response: ApprovalInboxErrorResponse) {
  return (await readApprovalInboxErrorRecord(response)).message
}

export async function readApprovalInboxErrorRecord(
  response: ApprovalInboxErrorResponse,
): Promise<ApprovalInboxErrorRecord> {
  const fallback = `${response.status} ${response.statusText}`
  try {
    const payload = await response.json()
    return resolveApprovalInboxErrorRecord(payload, fallback)
  } catch {
    return {
      code: null,
      currentVersion: null,
      message: fallback,
    }
  }
}

export function reconcileApprovalInboxConflictVersion<T extends ApprovalInboxVersionedEntry>(
  approvals: readonly T[],
  approvalId: string,
  currentVersion: number | null,
) {
  if (currentVersion === null) {
    return approvals.slice()
  }

  return approvals.map((entry) =>
    entry.id === approvalId && entry.version !== currentVersion
      ? {
          ...entry,
          version: currentVersion,
        }
      : entry,
  )
}
