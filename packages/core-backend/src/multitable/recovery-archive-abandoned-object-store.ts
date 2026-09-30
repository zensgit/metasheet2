import { createHash } from 'node:crypto'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import { validateRecoveryArchiveObjectExpectedBinding, type RecoveryArchiveObjectExpectedBinding } from './recovery-archive-object-store'

export interface RecoveryArchiveDiscardRequest extends RecoveryArchiveObjectExpectedBinding {
  operationId: string
}

export type RecoveryArchiveDiscardResult =
  | { outcome: 'unknown' | 'retained' }
  | { outcome: 'absent'; receiptSha256: string }

/** Separate from expiry deletion. Absence means permanent provider unavailability, not erasure. */
export interface RecoveryArchiveAbandonedObjectStore {
  discard(request: RecoveryArchiveDiscardRequest): Promise<RecoveryArchiveDiscardResult>
  status(request: RecoveryArchiveDiscardRequest): Promise<RecoveryArchiveDiscardResult>
}

export function refuseRecoveryArchiveDiscard(): never {
  throw new Error('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
}

export function validateRecoveryArchiveDiscardRequest(value: RecoveryArchiveDiscardRequest): RecoveryArchiveDiscardRequest {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['expectedExpiresAt', 'expectedSha256', 'expectedSize', 'expectedVersion', 'generationId', 'objectId', 'operationId']
    if (Object.keys(descriptors).sort().join(',') !== keys.join(',') || keys.some((key) => !('value' in descriptors[key]))) refuseRecoveryArchiveDiscard()
    const { operationId, ...binding } = value
    if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(operationId)) refuseRecoveryArchiveDiscard()
    return { ...validateRecoveryArchiveObjectExpectedBinding(binding), operationId }
  } catch { return refuseRecoveryArchiveDiscard() }
}

/** A checksum of operation-bound provider evidence; never a PUT/HEAD receipt or remote attestation. */
export function recoveryArchiveDiscardReceipt(request: RecoveryArchiveDiscardRequest): string {
  const value = validateRecoveryArchiveDiscardRequest(request)
  return createHash('sha256').update(JSON.stringify([
    'metasheet.archive-abandoned-discard/v1', value.operationId, value.generationId, value.objectId,
    value.expectedVersion, value.expectedSha256, value.expectedSize, value.expectedExpiresAt, 'absent',
  ])).digest('hex')
}

export function createGuardedRecoveryArchiveAbandonedObjectStore(
  provider: RecoveryArchiveAbandonedObjectStore, probe: RecoveryArchiveTransactionDepthProbe,
): RecoveryArchiveAbandonedObjectStore {
  const call = async (verb: 'discard' | 'status', input: RecoveryArchiveDiscardRequest): Promise<RecoveryArchiveDiscardResult> => {
    // Copy the complete binding synchronously; caller mutation cannot retarget a suspended operation.
    const request = validateRecoveryArchiveDiscardRequest(input)
    try {
      if (probe.currentTransactionDepth() !== 0) refuseRecoveryArchiveDiscard()
      const result = await provider[verb]({ ...request })
      const fields = Object.getOwnPropertyDescriptors(result)
      if (!fields.outcome || !('value' in fields.outcome)) refuseRecoveryArchiveDiscard()
      const outcome: unknown = fields.outcome.value
      if (outcome === 'unknown' || outcome === 'retained') {
        if (Object.keys(fields).join(',') !== 'outcome') refuseRecoveryArchiveDiscard()
        return { outcome }
      }
      if (outcome !== 'absent' || Object.keys(fields).sort().join(',') !== 'outcome,receiptSha256'
        || !('value' in fields.receiptSha256)) refuseRecoveryArchiveDiscard()
      const receiptSha256: unknown = fields.receiptSha256.value
      if (typeof receiptSha256 !== 'string' || receiptSha256 !== recoveryArchiveDiscardReceipt(request)) refuseRecoveryArchiveDiscard()
      return { outcome: 'absent', receiptSha256 }
    } catch { return refuseRecoveryArchiveDiscard() }
  }
  return { discard: (request) => call('discard', request), status: (request) => call('status', request) }
}
