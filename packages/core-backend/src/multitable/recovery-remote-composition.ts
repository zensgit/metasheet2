import { randomUUID } from 'node:crypto'
import { createRecoveryArchiveWorkerCallbacks } from '../routes/univer-meta'
import type { RecoveryArchiveApplicationComposition, RecoveryArchiveApplicationDatabaseRuntime, RecoveryArchiveApplicationWorkerDependencies } from './recovery-archive-application'
import { isRecoveryArchiveRestoreWorkerEnabled } from './recovery-archive-restore-worker'
import { createRecoveryArchiveRemoteObjectStore, type RecoveryArchiveRemoteObjectOptions } from './recovery-archive-remote-object-store'
import { createRecoveryOpenBaoCustody, type RecoveryOpenBaoCustodyOptions } from './recovery-openbao-custody'

export interface RecoveryRemoteResourceCompositionConfig {
  objectStore: Omit<RecoveryArchiveRemoteObjectOptions, 'transactionDepth'>
  keyCustody: Omit<RecoveryOpenBaoCustodyOptions, 'transactionDepth'>
  policy: Pick<RecoveryArchiveApplicationComposition, 'auditedReplayHorizonMs' | 'asyncResumeHorizonMs' | 'workerIntervalMs' | 'manualCapture' | 'manualCaptureLimits'>
  worker: Pick<RecoveryArchiveApplicationWorkerDependencies, 'leaseMs' | 'replayHorizonMs' | 'sweepLimit' | 'maxChunksPerRun'>
}

/** Explicit resource construction; OFF resolves no config, credentials, database or storage. */
export function prepareRecoveryRemoteComposition(input: {
  env: Readonly<Record<string, string | undefined>>
  resolveResources: () => RecoveryRemoteResourceCompositionConfig
  resolveDatabase: () => RecoveryArchiveApplicationDatabaseRuntime
  resolveAttachmentStorage: () => NonNullable<RecoveryArchiveApplicationComposition['attachmentStorage']>
  resolveAttachmentCleanupStorage?: (storage: NonNullable<RecoveryArchiveApplicationComposition['attachmentStorage']>) => RecoveryArchiveApplicationComposition['attachmentCleanupStorage']
}): RecoveryArchiveApplicationComposition | undefined {
  if (!isRecoveryArchiveRestoreWorkerEnabled(input.env)) return undefined
  try {
    const config = input.resolveResources()
    if (config.objectStore.token === config.keyCustody.token) throw new Error('RESOURCE_IDENTITIES_NOT_SEPARATE')
    const database = input.resolveDatabase(), transactionDepth = database.transactionDepthProbe
    const objectStore = createRecoveryArchiveRemoteObjectStore({ ...config.objectStore, transactionDepth })
    const keyCustody = createRecoveryOpenBaoCustody({ ...config.keyCustody, transactionDepth })
    const attachmentStorage = input.resolveAttachmentStorage()
    const attachmentCleanupStorage = input.resolveAttachmentCleanupStorage?.(attachmentStorage)
    return Object.freeze({ ...config.policy, keyCustody, objectStore, attachmentStorage,
      ...(attachmentCleanupStorage ? { attachmentCleanupStorage } : {}),
      worker: Object.freeze({ ...createRecoveryArchiveWorkerCallbacks(database),
        leaseMs: config.worker.leaseMs, replayHorizonMs: config.worker.replayHorizonMs,
        sweepLimit: config.worker.sweepLimit, maxChunksPerRun: config.worker.maxChunksPerRun,
        workerOwnerId: `remote-${randomUUID()}` }),
    })
  } catch { throw new Error('RECOVERY_ARCHIVE_REMOTE_COMPOSITION_REFUSED') }
}
