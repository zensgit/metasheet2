import { createHash } from 'node:crypto'
import type { StorageProvider } from '../services/StorageService'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import type { RecoveryArchiveCompleteSectionState } from './recovery-archive-reconstructor'
import { readRecoveryArchiveAttachmentSource } from './recovery-archive-reader'

export interface ArchiveAttachmentStageIdentity {
  generationId: string
  workspaceId: string
  baseId: string
  sheetId: string
  recordId: string
  fieldId: string
  attachmentId: string
  sourceVersion: string
  plaintextSha256: string
  sizeBytes: string
}

export interface ArchiveAttachmentStageLedger {
  /** Must return only after the attempt-owned object identity is durably committed. */
  reserve(identity: Readonly<ArchiveAttachmentStageIdentity>): Promise<{ objectId: string; ownershipKey: string; state: 'reserved' | 'verified' }>
  /** Must compare the complete reserved identity; never adopt an unreserved object. */
  verified(objectId: string, identity: Readonly<ArchiveAttachmentStageIdentity>): Promise<void>
}

/** Internal file preparation only. No attachment metadata or record reference is made visible here. */
export async function stageRecoveryArchiveAttachment(input: {
  state: RecoveryArchiveCompleteSectionState
  attachmentId: string
  original: { generationId: string; workspaceId: string; baseId: string; sheetId: string; recordId: string; fieldId: string }
  transactionDepth: RecoveryArchiveTransactionDepthProbe
  authorize: () => Promise<boolean>
  ledger: ArchiveAttachmentStageLedger
  storage: Pick<StorageProvider, 'uploadByKey' | 'readRecoveryAttachment' | 'reserveRecoveryAttachment'>
}): Promise<Readonly<ArchiveAttachmentStageIdentity & { objectId: string; storageKey: string }>> {
  const original = { generationId: input.original.generationId, workspaceId: input.original.workspaceId,
    baseId: input.original.baseId, sheetId: input.original.sheetId,
    recordId: input.original.recordId, fieldId: input.original.fieldId }
  const attachmentId = input.attachmentId
  const { storage, ledger, transactionDepth, authorize, state: archiveState } = input
  outsideTransaction(transactionDepth)
  if (!(await authorize()) || typeof storage.readRecoveryAttachment !== 'function'
    || typeof storage.reserveRecoveryAttachment !== 'function') refused()
  outsideTransaction(transactionDepth)
  const source = readRecoveryArchiveAttachmentSource(archiveState, attachmentId, original)
  try {
    const identity = Object.freeze({ ...original, attachmentId, sourceVersion: source.sourceVersion,
      plaintextSha256: source.plaintextSha256, sizeBytes: source.sizeBytes })
    if (createHash('sha256').update(source.bytes).digest('hex') !== identity.plaintextSha256
      || String(source.bytes.length) !== identity.sizeBytes) refused()
    const reserved = await ledger.reserve(identity)
    const objectId = reserved.objectId
    const ownershipKey = reserved.ownershipKey
    const state = reserved.state
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(objectId)
      || !/^[0-9a-f]{64}$/.test(ownershipKey)
      || (state !== 'reserved' && state !== 'verified')) refused()
    const storageKey = `${objectId}/sha256-${identity.plaintextSha256}`
    outsideTransaction(transactionDepth)
    await storage.reserveRecoveryAttachment(storageKey, ownershipKey)
    outsideTransaction(transactionDepth)
    if (state === 'reserved') {
      try {
        await storage.uploadByKey(storageKey, Buffer.from(source.bytes), source.mediaType ?? undefined)
      } catch (error) {
        // A crash after exclusive creation can leave the reserved object ahead of its receipt.
        // Never delete on failure: a collision is acceptable only after an exact readback below.
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') refused()
      }
    }
    outsideTransaction(transactionDepth)
    const read = await storage.readRecoveryAttachment(storageKey, ownershipKey)
    if (!Buffer.isBuffer(read.bytes) || read.immutableVersion !== `sha256:${identity.plaintextSha256}`
      || read.contentSha256 !== identity.plaintextSha256 || String(read.sizeBytes) !== identity.sizeBytes
      || String(read.bytes.length) !== identity.sizeBytes
      || createHash('sha256').update(read.bytes).digest('hex') !== identity.plaintextSha256) refused()
    outsideTransaction(transactionDepth)
    await ledger.verified(objectId, identity)
    return Object.freeze({ ...identity, objectId, storageKey })
  } catch {
    refused()
  } finally {
    source.bytes.fill(0)
  }
}

function outsideTransaction(probe: RecoveryArchiveTransactionDepthProbe): void {
  try { if (probe.currentTransactionDepth() === 0) return } catch { /* fail closed */ }
  refused()
}

function refused(): never {
  throw new Error('RECOVERY_ARCHIVE_ATTACHMENT_STAGE_REFUSED')
}
