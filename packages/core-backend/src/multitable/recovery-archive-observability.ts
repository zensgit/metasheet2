import type {
  RecoveryArchiveRestoreWorkerRunKind,
  RecoveryArchiveRestoreWorkerRunResult,
} from './recovery-archive-restore-worker'

export const RECOVERY_ARCHIVE_WORKER_RUN_KINDS = Object.freeze([
  'idle',
  'completed',
  'paused_retryable',
  'abandoned',
  'claim_contended',
  'lease_lost',
  'yielded',
  'stopped',
  'sweep_failed',
  'selection_failed',
  'terminalization_failed',
  'tick_failed',
] as const satisfies readonly RecoveryArchiveRestoreWorkerRunKind[])

export type RecoveryArchiveWorkerLifecycle = 'started' | 'drained' | 'drain_failed'
export type RecoveryArchiveWorkerDrainOutcome = 'success' | 'failure'

export interface RecoveryArchiveObservabilitySink {
  incrementRun(outcome: RecoveryArchiveRestoreWorkerRunKind): void
  incrementSwept(count: number): void
  incrementChunks(count: number): void
  setRunning(value: 0 | 1): void
  incrementDrain(outcome: RecoveryArchiveWorkerDrainOutcome): void
}

export interface RecoveryArchiveObservability {
  recordRun(result: RecoveryArchiveRestoreWorkerRunResult): void
  recordLifecycle(event: RecoveryArchiveWorkerLifecycle): void
}

const INVALID_RUN_RESULT = 'RECOVERY_ARCHIVE_OBSERVABILITY_INVALID_RUN_RESULT'
const INVALID_LIFECYCLE = 'RECOVERY_ARCHIVE_OBSERVABILITY_INVALID_LIFECYCLE'
const RUN_RESULT_KEYS = Object.freeze(['chunks', 'kind', 'swept'])
const RUN_KIND_SET = new Set<string>(RECOVERY_ARCHIVE_WORKER_RUN_KINDS)

export function createRecoveryArchiveObservability(
  sink: RecoveryArchiveObservabilitySink,
): RecoveryArchiveObservability {
  const canonicalSink = snapshotSink(sink)
  return Object.freeze({
    recordRun(result) {
      assertRunResult(result)
      canonicalSink.incrementRun(result.kind)
      if (result.swept > 0) canonicalSink.incrementSwept(result.swept)
      if (result.chunks > 0) canonicalSink.incrementChunks(result.chunks)
    },
    recordLifecycle(event) {
      if (event === 'started') {
        canonicalSink.setRunning(1)
        return
      }
      if (event === 'drained') {
        canonicalSink.setRunning(0)
        canonicalSink.incrementDrain('success')
        return
      }
      if (event === 'drain_failed') {
        canonicalSink.incrementDrain('failure')
        return
      }
      throw new Error(INVALID_LIFECYCLE)
    },
  })
}

function snapshotSink(source: RecoveryArchiveObservabilitySink): RecoveryArchiveObservabilitySink {
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.incrementRun !== 'function' ||
    typeof source.incrementSwept !== 'function' ||
    typeof source.incrementChunks !== 'function' ||
    typeof source.setRunning !== 'function' ||
    typeof source.incrementDrain !== 'function'
  ) {
    throw new Error('RECOVERY_ARCHIVE_OBSERVABILITY_INVALID_SINK')
  }
  return Object.freeze({
    incrementRun: source.incrementRun.bind(source),
    incrementSwept: source.incrementSwept.bind(source),
    incrementChunks: source.incrementChunks.bind(source),
    setRunning: source.setRunning.bind(source),
    incrementDrain: source.incrementDrain.bind(source),
  })
}

function assertRunResult(result: RecoveryArchiveRestoreWorkerRunResult): void {
  if (!result || typeof result !== 'object') throw new Error(INVALID_RUN_RESULT)
  const keys = Object.keys(result).sort()
  if (
    keys.length !== RUN_RESULT_KEYS.length ||
    keys.some((key, index) => key !== RUN_RESULT_KEYS[index]) ||
    !RUN_KIND_SET.has(result.kind) ||
    !Number.isSafeInteger(result.swept) ||
    result.swept < 0 ||
    !Number.isSafeInteger(result.chunks) ||
    result.chunks < 0
  ) {
    throw new Error(INVALID_RUN_RESULT)
  }
}
