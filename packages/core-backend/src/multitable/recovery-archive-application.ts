import type {
  RecoveryArchiveRouterDatabaseRuntime,
  UniverMetaRouterOptions,
} from '../routes/univer-meta'
import type { RecoveryArchiveKeyCustodyAdapter } from './recovery-archive-crypto'
import type { RecoveryArchiveObjectStoreProvider } from './recovery-archive-object-store'
import type { RecoveryArchivePreviewRuntime } from './recovery-archive-preview'
import {
  bootRecoveryArchiveRestoreWorker,
  createRecoveryArchiveRestoreWorker,
  isRecoveryArchiveRestoreWorkerEnabled,
  type CreateRecoveryArchiveRestoreWorkerInput,
  type RecoveryArchiveRestoreWorkerLoop,
} from './recovery-archive-restore-worker'

export type RecoveryArchiveApplicationDatabaseRuntime = RecoveryArchiveRouterDatabaseRuntime

export type RecoveryArchiveApplicationWorkerDependencies = Pick<
  CreateRecoveryArchiveRestoreWorkerInput,
  | 'recheckAuthority'
  | 'apply'
  | 'leaseMs'
  | 'replayHorizonMs'
  | 'sweepLimit'
  | 'maxChunksPerRun'
  | 'workerOwnerId'
  | 'now'
>

export interface RecoveryArchiveApplicationComposition {
  readonly keyCustody: RecoveryArchiveKeyCustodyAdapter
  readonly objectStore: RecoveryArchiveObjectStoreProvider
  readonly auditedReplayHorizonMs: number
  readonly asyncResumeHorizonMs: number
  readonly workerIntervalMs: number
  readonly worker: RecoveryArchiveApplicationWorkerDependencies
}

export type RecoveryArchiveApplicationCompositionFactory = () => RecoveryArchiveApplicationComposition

export interface RecoveryArchiveApplication {
  readonly routerOptions: UniverMetaRouterOptions | undefined
  startWorker(): void
  stopWorker(): Promise<void>
}

const COMPOSITION_INVALID = 'RECOVERY_ARCHIVE_APPLICATION_COMPOSITION_INVALID'
const COMPOSITION_FACTORY_FAILED = 'RECOVERY_ARCHIVE_APPLICATION_COMPOSITION_FACTORY_FAILED'
const DATABASE_RUNTIME_FAILED = 'RECOVERY_ARCHIVE_APPLICATION_DATABASE_RUNTIME_FAILED'
const WORKER_BOOT_FAILED = 'RECOVERY_ARCHIVE_APPLICATION_WORKER_BOOT_FAILED'
const WORKER_STOP_FAILED = 'RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED'
const WORKER_STOP_TIMEOUT_MS = 10_000

export function createRecoveryArchiveApplication(
  factory: RecoveryArchiveApplicationCompositionFactory | undefined,
  resolveDatabaseRuntime: () => RecoveryArchiveApplicationDatabaseRuntime,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RecoveryArchiveApplication {
  const activationEnv = Object.freeze({
    MULTITABLE_RECOVERY_ARCHIVE_ENABLED: env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED,
    MULTITABLE_ENABLE_WRITER_FENCE: env.MULTITABLE_ENABLE_WRITER_FENCE,
  })
  if (!isRecoveryArchiveRestoreWorkerEnabled(activationEnv)) {
    return Object.freeze({
      routerOptions: undefined,
      startWorker() {},
      async stopWorker() {},
    })
  }
  if (!factory) throw new Error(COMPOSITION_INVALID)

  let composition: Readonly<RecoveryArchiveApplicationComposition>
  try {
    composition = snapshotComposition(factory())
  } catch {
    throw new Error(COMPOSITION_FACTORY_FAILED)
  }

  let database: Readonly<RecoveryArchiveApplicationDatabaseRuntime>
  try {
    database = snapshotDatabaseRuntime(resolveDatabaseRuntime())
  } catch {
    throw new Error(DATABASE_RUNTIME_FAILED)
  }

  const runtime: RecoveryArchivePreviewRuntime = Object.freeze({
    keyCustody: composition.keyCustody,
    objectStore: composition.objectStore,
    transactionDepth: database.transactionDepthProbe,
  })
  const workerInput: Readonly<CreateRecoveryArchiveRestoreWorkerInput> = Object.freeze({
    transaction: database.transaction,
    query: database.query,
    runtime,
    recheckAuthority: composition.worker.recheckAuthority,
    apply: composition.worker.apply,
    leaseMs: composition.worker.leaseMs,
    replayHorizonMs: composition.worker.replayHorizonMs,
    sweepLimit: composition.worker.sweepLimit,
    maxChunksPerRun: composition.worker.maxChunksPerRun,
    workerOwnerId: composition.worker.workerOwnerId,
    now: composition.worker.now,
  })
  const routerOptions: UniverMetaRouterOptions = Object.freeze({
    recoveryArchiveRuntime: runtime,
    recoveryArchiveDatabaseRuntime: database,
    recoveryArchiveAuditedReplayHorizonMs: composition.auditedReplayHorizonMs,
    recoveryArchiveAsyncResumeHorizonMs: composition.asyncResumeHorizonMs,
  })
  let workerStarted = false
  let workerLoop: RecoveryArchiveRestoreWorkerLoop | null = null
  let workerStop: Promise<void> | null = null

  return Object.freeze({
    routerOptions,
    startWorker() {
      if (workerStarted) return
      workerStarted = true
      try {
        workerLoop = bootRecoveryArchiveRestoreWorker({
          env: activationEnv,
          intervalMs: composition.workerIntervalMs,
          createWorker: () => createRecoveryArchiveRestoreWorker(workerInput),
        })
      } catch {
        throw new Error(WORKER_BOOT_FAILED)
      }
      if (!workerLoop) throw new Error(WORKER_BOOT_FAILED)
    },
    async stopWorker() {
      if (workerStop) return workerStop
      if (!workerLoop) return
      const loop = workerLoop
      workerStop = stopRecoveryArchiveWorkerLoop(loop)
      try {
        await workerStop
      } finally {
        workerLoop = null
      }
    },
  })
}

function stopRecoveryArchiveWorkerLoop(loop: RecoveryArchiveRestoreWorkerLoop): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(WORKER_STOP_FAILED))
    }, WORKER_STOP_TIMEOUT_MS)
    void loop.stop().then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        reject(new Error(WORKER_STOP_FAILED))
      },
    )
  })
}

function snapshotComposition(
  source: RecoveryArchiveApplicationComposition,
): Readonly<RecoveryArchiveApplicationComposition> {
  if (!source || typeof source !== 'object') throw new Error(COMPOSITION_INVALID)
  const composition: RecoveryArchiveApplicationComposition = {
    keyCustody: source.keyCustody,
    objectStore: source.objectStore,
    auditedReplayHorizonMs: source.auditedReplayHorizonMs,
    asyncResumeHorizonMs: source.asyncResumeHorizonMs,
    workerIntervalMs: source.workerIntervalMs,
    worker: snapshotWorkerDependencies(source.worker),
  }
  if (
    !composition.keyCustody ||
    typeof composition.keyCustody !== 'object' ||
    !composition.objectStore ||
    typeof composition.objectStore !== 'object' ||
    !Number.isSafeInteger(composition.auditedReplayHorizonMs) ||
    composition.auditedReplayHorizonMs < 0 ||
    !Number.isSafeInteger(composition.asyncResumeHorizonMs) ||
    composition.asyncResumeHorizonMs < 1 ||
    !Number.isSafeInteger(composition.workerIntervalMs) ||
    composition.workerIntervalMs < 1
  ) {
    throw new Error(COMPOSITION_INVALID)
  }
  return Object.freeze(composition)
}

function snapshotDatabaseRuntime(
  source: RecoveryArchiveApplicationDatabaseRuntime,
): Readonly<RecoveryArchiveApplicationDatabaseRuntime> {
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.transaction !== 'function' ||
    typeof source.query !== 'function' ||
    !source.transactionDepthProbe ||
    typeof source.transactionDepthProbe !== 'object' ||
    typeof source.transactionDepthProbe.currentTransactionDepth !== 'function'
  ) {
    throw new Error(DATABASE_RUNTIME_FAILED)
  }
  return Object.freeze({
    transaction: source.transaction,
    query: source.query,
    transactionDepthProbe: source.transactionDepthProbe,
  })
}

function snapshotWorkerDependencies(
  source: RecoveryArchiveApplicationWorkerDependencies,
): Readonly<RecoveryArchiveApplicationWorkerDependencies> {
  if (!source || typeof source !== 'object') throw new Error(COMPOSITION_INVALID)
  const apply = snapshotApplyDependencies(source.apply)
  const worker: RecoveryArchiveApplicationWorkerDependencies = {
    recheckAuthority: source.recheckAuthority,
    apply,
    leaseMs: source.leaseMs,
    replayHorizonMs: source.replayHorizonMs,
    sweepLimit: source.sweepLimit,
    maxChunksPerRun: source.maxChunksPerRun,
    workerOwnerId: source.workerOwnerId,
    now: source.now,
  }
  if (
    typeof worker.recheckAuthority !== 'function' ||
    !Number.isSafeInteger(worker.leaseMs) || worker.leaseMs < 1 ||
    !Number.isSafeInteger(worker.replayHorizonMs) || worker.replayHorizonMs < 0 ||
    (worker.sweepLimit !== undefined &&
      (!Number.isSafeInteger(worker.sweepLimit) || worker.sweepLimit < 1)) ||
    (worker.maxChunksPerRun !== undefined &&
      (!Number.isSafeInteger(worker.maxChunksPerRun) || worker.maxChunksPerRun < 1)) ||
    (worker.workerOwnerId !== undefined && typeof worker.workerOwnerId !== 'string') ||
    (worker.now !== undefined && typeof worker.now !== 'function')
  ) {
    throw new Error(COMPOSITION_INVALID)
  }
  return Object.freeze(worker)
}

function snapshotApplyDependencies(
  source: RecoveryArchiveApplicationWorkerDependencies['apply'],
): RecoveryArchiveApplicationWorkerDependencies['apply'] {
  if (!source || typeof source !== 'object') throw new Error(COMPOSITION_INVALID)
  const onMutationApplied = source.onMutationApplied
  const apply: RecoveryArchiveApplicationWorkerDependencies['apply'] = {
    preliminaryFullRead: source.preliminaryFullRead,
    stabilizeAuthorization: source.stabilizeAuthorization,
    finalLockedFullRead: source.finalLockedFullRead,
    evaluatePlanAuthorization: source.evaluatePlanAuthorization,
    ...(onMutationApplied
      ? { onMutationApplied }
      : {}),
  }
  if (
    typeof apply.preliminaryFullRead !== 'function' ||
    typeof apply.stabilizeAuthorization !== 'function' ||
    typeof apply.finalLockedFullRead !== 'function' ||
    typeof apply.evaluatePlanAuthorization !== 'function' ||
    (apply.onMutationApplied !== undefined && typeof apply.onMutationApplied !== 'function')
  ) {
    throw new Error(COMPOSITION_INVALID)
  }
  return Object.freeze(apply)
}
