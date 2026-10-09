export interface RecoveryArchiveCaptureStatus {
  requestId: string
  generationId: string
  state: 'pending' | 'incomplete' | 'recoverable'
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export function requireRecoveryArchiveRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || !UUID.test(requestId)) {
    throw new Error('Invalid recovery archive request identity')
  }
}

export function requireRecoveryArchiveCaptureStatus(value: unknown, requestId: string): RecoveryArchiveCaptureStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid recovery archive capture response')
  }
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'generationId,requestId,state'
    || row.requestId !== requestId
    || typeof row.generationId !== 'string' || !UUID.test(row.generationId)
    || typeof row.state !== 'string' || !['pending', 'incomplete', 'recoverable'].includes(row.state)) {
    throw new Error('Invalid recovery archive capture response')
  }
  return { requestId, generationId: row.generationId, state: row.state as RecoveryArchiveCaptureStatus['state'] }
}
