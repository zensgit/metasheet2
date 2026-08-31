import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const workerMocks = vi.hoisted(() => ({
  createRecoveryArchiveRestoreWorker: vi.fn(),
}))

vi.mock('../../src/multitable/recovery-archive-restore-worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/recovery-archive-restore-worker')>()),
  createRecoveryArchiveRestoreWorker: workerMocks.createRecoveryArchiveRestoreWorker,
}))

import {
  createRecoveryArchiveApplication,
  type RecoveryArchiveApplicationComposition,
  type RecoveryArchiveApplicationDatabaseRuntime,
  type RecoveryArchiveApplicationWorkerDependencies,
} from '../../src/multitable/recovery-archive-application'
import type {
  RecoveryArchiveKeyCustodyAdapter,
  RecoveryArchiveTransactionDepthProbe,
} from '../../src/multitable/recovery-archive-crypto'
import type { RecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import type { RecoveryArchiveObservability } from '../../src/multitable/recovery-archive-observability'
import type {
  CreateRecoveryArchiveRestoreWorkerInput,
  RecoveryArchiveRestoreWorker,
  RecoveryArchiveRestoreWorkerRunResult,
} from '../../src/multitable/recovery-archive-restore-worker'

const ENABLED_ENV = Object.freeze({
  MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
  MULTITABLE_ENABLE_WRITER_FENCE: 'true',
})

beforeEach(() => {
  workerMocks.createRecoveryArchiveRestoreWorker.mockReset()
  workerMocks.createRecoveryArchiveRestoreWorker.mockImplementation(() => idleWorker())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('recovery archive application composition', () => {
  it.each([
    [{}, 'both absent'],
    [{ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' }, 'writer fence absent'],
    [{ MULTITABLE_ENABLE_WRITER_FENCE: 'true' }, 'archive flag absent'],
    [{ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'TRUE', MULTITABLE_ENABLE_WRITER_FENCE: 'true' }, 'archive flag non-exact'],
    [{ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'TRUE' }, 'writer fence non-exact'],
  ])('is inert with %s (%s)', async (env) => {
    const factory = vi.fn(() => {
      throw new Error('factory must remain unreachable')
    })
    const resolveDatabaseRuntime = vi.fn(() => {
      throw new Error('database resolver must remain unreachable')
    })
    const observability: RecoveryArchiveObservability = {
      recordRun: vi.fn(),
      recordLifecycle: vi.fn(),
    }
    const interval = vi.spyOn(globalThis, 'setInterval')

    const application = createRecoveryArchiveApplication(
      factory,
      resolveDatabaseRuntime,
      env,
      observability,
    )
    application.startWorker()
    await application.stopWorker()

    expect(factory).not.toHaveBeenCalled()
    expect(resolveDatabaseRuntime).not.toHaveBeenCalled()
    expect(workerMocks.createRecoveryArchiveRestoreWorker).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
    expect(observability.recordRun).not.toHaveBeenCalled()
    expect(observability.recordLifecycle).not.toHaveBeenCalled()
    expect(application.routerOptions).toBeUndefined()
  })

  it('ignores hostile worker and database extras and exercises only canonical adapters', async () => {
    vi.useFakeTimers()
    const providers = fakeProviders()
    const canonical = fakeDatabaseRuntime()
    const attackerProbe = fakeProbe()
    const hostileCreateWorker = vi.fn(() => {
      throw new Error('hostile createWorker reached')
    })
    const hostileTransaction = vi.fn(() => {
      throw new Error('hostile transaction reached')
    })
    const hostileQuery = vi.fn(() => {
      throw new Error('hostile query reached')
    })
    const trustedComposition = fakeComposition(providers)
    const composition = {
      ...trustedComposition,
      worker: {
        ...trustedComposition.worker,
        createWorker: hostileCreateWorker,
        runtime: { ...providers, transactionDepth: attackerProbe },
        transaction: hostileTransaction,
        query: hostileQuery,
        transactionDepth: attackerProbe,
      },
      createWorker: hostileCreateWorker,
      runtime: { ...providers, transactionDepth: attackerProbe },
      transaction: hostileTransaction,
      query: hostileQuery,
      transactionDepth: attackerProbe,
    }
    workerMocks.createRecoveryArchiveRestoreWorker.mockImplementation(
      (input: CreateRecoveryArchiveRestoreWorkerInput): RecoveryArchiveRestoreWorker => ({
        async runOnce() {
          await input.transaction(async (query) => {
            await query('CANONICAL_TRANSACTION_QUERY')
          })
          await input.query('CANONICAL_AUTOCOMMIT_QUERY')
          input.runtime.transactionDepth.currentTransactionDepth()
          return { kind: 'idle', swept: 0, chunks: 0 }
        },
      }),
    )

    const application = createRecoveryArchiveApplication(
      () => composition,
      () => canonical.runtime,
      ENABLED_ENV,
    )
    const runtime = application.routerOptions?.recoveryArchiveRuntime
    const database = application.routerOptions?.recoveryArchiveDatabaseRuntime
    const canonicalDatabase = { ...canonical.runtime }

    Object.assign(canonical.runtime as unknown as Record<string, unknown>, {
      transaction: hostileTransaction,
      query: hostileQuery,
      transactionDepthProbe: attackerProbe,
    })

    application.startWorker()
    await application.stopWorker()

    expect(workerMocks.createRecoveryArchiveRestoreWorker).toHaveBeenCalledTimes(1)
    const workerInput = workerMocks.createRecoveryArchiveRestoreWorker.mock.calls[0]?.[0]
    expect(workerInput?.transaction).toBe(canonicalDatabase.transaction)
    expect(workerInput?.query).toBe(canonicalDatabase.query)
    expect(workerInput?.runtime).toBe(runtime)
    expect(database).toEqual(canonicalDatabase)
    expect(database?.transaction).toBe(canonicalDatabase.transaction)
    expect(database?.query).toBe(canonicalDatabase.query)
    expect(database?.transactionDepthProbe).toBe(canonicalDatabase.transactionDepthProbe)
    expect(Object.isFrozen(database)).toBe(true)
    expect(workerInput).not.toHaveProperty('createWorker')
    expect(workerInput).not.toHaveProperty('transactionDepth')
    expect(runtime).toEqual({
      keyCustody: providers.keyCustody,
      objectStore: providers.objectStore,
      transactionDepth: canonicalDatabase.transactionDepthProbe,
    })
    expect(Object.isFrozen(workerInput)).toBe(true)
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(canonical.calls.transaction).toBe(1)
    expect(canonical.calls.transactionQuery).toBe(1)
    expect(canonical.calls.query).toBe(1)
    expect(canonical.calls.depth).toBe(1)
    expect(hostileCreateWorker).not.toHaveBeenCalled()
    expect(hostileTransaction).not.toHaveBeenCalled()
    expect(hostileQuery).not.toHaveBeenCalled()
  })

  it('snapshots providers, horizons, interval, and worker dependencies at factory return', async () => {
    vi.useFakeTimers()
    const providers = fakeProviders()
    const replacementProviders = fakeProviders()
    const canonical = fakeDatabaseRuntime()
    const composition = fakeComposition(providers)
    const originalWorker = composition.worker
    const originalApply = originalWorker.apply
    const expectedWorker = {
      recheckAuthority: originalWorker.recheckAuthority,
      now: originalWorker.now,
      preliminaryFullRead: originalApply.preliminaryFullRead,
      stabilizeAuthorization: originalApply.stabilizeAuthorization,
      finalLockedFullRead: originalApply.finalLockedFullRead,
      evaluatePlanAuthorization: originalApply.evaluatePlanAuthorization,
    }
    const replacementWorker = fakeWorkerDependencies()
    const application = createRecoveryArchiveApplication(
      () => composition,
      () => canonical.runtime,
      ENABLED_ENV,
    )
    const runtime = application.routerOptions?.recoveryArchiveRuntime

    Object.assign(composition as unknown as Record<string, unknown>, {
      keyCustody: replacementProviders.keyCustody,
      objectStore: replacementProviders.objectStore,
      auditedReplayHorizonMs: 1,
      asyncResumeHorizonMs: 2,
      workerIntervalMs: 3,
      worker: replacementWorker,
    })
    Object.assign(originalWorker as unknown as Record<string, unknown>, {
      recheckAuthority: replacementWorker.recheckAuthority,
      leaseMs: 4,
      replayHorizonMs: 5,
      sweepLimit: 6,
      maxChunksPerRun: 7,
      workerOwnerId: 'replacement-owner',
      now: replacementWorker.now,
      apply: replacementWorker.apply,
    })
    Object.assign(originalApply as unknown as Record<string, unknown>, replacementWorker.apply)
    const schedule = vi.spyOn(globalThis, 'setInterval')

    application.startWorker()
    await application.stopWorker()

    const workerInput = workerMocks.createRecoveryArchiveRestoreWorker.mock.calls[0]?.[0]
    expect(runtime).toEqual({
      keyCustody: providers.keyCustody,
      objectStore: providers.objectStore,
      transactionDepth: canonical.runtime.transactionDepthProbe,
    })
    expect(application.routerOptions).toEqual({
      recoveryArchiveRuntime: runtime,
      recoveryArchiveDatabaseRuntime: expect.objectContaining({
        transaction: canonical.runtime.transaction,
        query: canonical.runtime.query,
        transactionDepthProbe: canonical.runtime.transactionDepthProbe,
      }),
      recoveryArchiveAuditedReplayHorizonMs: 86_400_000,
      recoveryArchiveAsyncResumeHorizonMs: 3_600_000,
    })
    expect(workerInput).toMatchObject({
      transaction: canonical.runtime.transaction,
      query: canonical.runtime.query,
      runtime,
      recheckAuthority: expectedWorker.recheckAuthority,
      leaseMs: 60_000,
      replayHorizonMs: 0,
      sweepLimit: 100,
      maxChunksPerRun: 1_000,
      workerOwnerId: 'canonical-worker',
      now: expectedWorker.now,
    })
    expect(workerInput?.apply.preliminaryFullRead).toBe(expectedWorker.preliminaryFullRead)
    expect(workerInput?.apply.stabilizeAuthorization).toBe(expectedWorker.stabilizeAuthorization)
    expect(workerInput?.apply.finalLockedFullRead).toBe(expectedWorker.finalLockedFullRead)
    expect(workerInput?.apply.evaluatePlanAuthorization).toBe(expectedWorker.evaluatePlanAuthorization)
    expect(Object.isFrozen(workerInput?.apply)).toBe(true)
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60_000)
  })

  it('starts the canonical worker once and every stop caller waits for it', async () => {
    vi.useFakeTimers()
    const chunk = deferred<RecoveryArchiveRestoreWorkerRunResult>()
    const runOnce = vi.fn(() => chunk.promise)
    workerMocks.createRecoveryArchiveRestoreWorker.mockReturnValue({ runOnce })
    const canonical = fakeDatabaseRuntime()
    const application = createRecoveryArchiveApplication(
      () => fakeComposition(fakeProviders()),
      () => canonical.runtime,
      ENABLED_ENV,
    )

    application.startWorker()
    application.startWorker()

    expect(workerMocks.createRecoveryArchiveRestoreWorker).toHaveBeenCalledTimes(1)
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    let firstStopped = false
    let secondStopped = false
    const firstStop = application.stopWorker().then(() => {
      firstStopped = true
    })
    const secondStop = application.stopWorker().then(() => {
      secondStopped = true
    })
    await Promise.resolve()

    expect(firstStopped).toBe(false)
    expect(secondStopped).toBe(false)

    chunk.resolve({ kind: 'idle', swept: 0, chunks: 0 })
    await Promise.all([firstStop, secondStop])

    expect(firstStopped).toBe(true)
    expect(secondStopped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forwards closed worker results and lifecycle events without changing worker state', async () => {
    vi.useFakeTimers()
    const runResult = { kind: 'completed', swept: 2, chunks: 3 } as const
    workerMocks.createRecoveryArchiveRestoreWorker.mockReturnValue({
      runOnce: vi.fn().mockResolvedValue(runResult),
    })
    const observability: RecoveryArchiveObservability = {
      recordRun: vi.fn(),
      recordLifecycle: vi.fn(),
    }
    const application = createRecoveryArchiveApplication(
      () => fakeComposition(fakeProviders()),
      () => fakeDatabaseRuntime().runtime,
      ENABLED_ENV,
      observability,
    )

    application.startWorker()
    await application.stopWorker()

    expect(observability.recordRun).toHaveBeenCalledTimes(1)
    expect(observability.recordRun).toHaveBeenCalledWith(runResult)
    expect(observability.recordLifecycle).toHaveBeenNthCalledWith(1, 'started')
    expect(observability.recordLifecycle).toHaveBeenNthCalledWith(2, 'drained')
  })

  it('fails closed after a bounded wait when an in-flight worker never drains', async () => {
    vi.useFakeTimers()
    const chunk = deferred<RecoveryArchiveRestoreWorkerRunResult>()
    workerMocks.createRecoveryArchiveRestoreWorker.mockReturnValue({ runOnce: () => chunk.promise })
    const observability: RecoveryArchiveObservability = {
      recordRun: vi.fn(),
      recordLifecycle: vi.fn(),
    }
    const application = createRecoveryArchiveApplication(
      () => fakeComposition(fakeProviders()),
      () => fakeDatabaseRuntime().runtime,
      ENABLED_ENV,
      observability,
    )
    application.startWorker()

    let stopError: unknown
    const stopped = application.stopWorker().catch((error: unknown) => {
      stopError = error
    })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopError).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    try {
      expect(stopError).toEqual(new Error('RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED'))
    } finally {
      chunk.resolve({ kind: 'stopped', swept: 0, chunks: 0 })
      await stopped
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(observability.recordLifecycle).toHaveBeenNthCalledWith(1, 'started')
    expect(observability.recordLifecycle).toHaveBeenNthCalledWith(2, 'drain_failed')
  })

  it('fails closed when both flags are on without a composition factory', () => {
    expect(() => createRecoveryArchiveApplication(
      undefined,
      () => fakeDatabaseRuntime().runtime,
      ENABLED_ENV,
    )).toThrow('RECOVERY_ARCHIVE_APPLICATION_COMPOSITION_INVALID')
  })
})

function fakeProviders(): Pick<
  RecoveryArchiveApplicationComposition,
  'keyCustody' | 'objectStore'
> {
  return {
    keyCustody: {
      produceGenerationDek: vi.fn(),
      unwrapGenerationDek: vi.fn(),
      deriveDekFingerprint: vi.fn(),
      macManifestRoot: vi.fn(),
      verifyManifestRootMac: vi.fn(),
    },
    objectStore: {
      put: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      deleteExpired: vi.fn(),
      pin: vi.fn(),
    },
  }
}

function fakeProbe(onRead?: () => void): RecoveryArchiveTransactionDepthProbe {
  return Object.freeze({
    currentTransactionDepth: () => {
      onRead?.()
      return 0
    },
  })
}

function fakeDatabaseRuntime(): {
  runtime: RecoveryArchiveApplicationDatabaseRuntime
  calls: { transaction: number; transactionQuery: number; query: number; depth: number }
} {
  const calls = { transaction: 0, transactionQuery: 0, query: 0, depth: 0 }
  const transactionQuery: RecoveryArchiveApplicationDatabaseRuntime['query'] = async () => {
    calls.transactionQuery += 1
    return { rows: [], rowCount: 0 }
  }
  const transaction: RecoveryArchiveApplicationDatabaseRuntime['transaction'] = async (work) => {
    calls.transaction += 1
    return work(transactionQuery)
  }
  const query: RecoveryArchiveApplicationDatabaseRuntime['query'] = async () => {
    calls.query += 1
    return { rows: [], rowCount: 0 }
  }
  return {
    runtime: {
      transaction,
      query,
      transactionDepthProbe: fakeProbe(() => {
        calls.depth += 1
      }),
    },
    calls,
  }
}

function fakeWorkerDependencies(): RecoveryArchiveApplicationWorkerDependencies {
  return {
    recheckAuthority: vi.fn(async () => true),
    apply: {
      preliminaryFullRead: vi.fn(async () => true),
      stabilizeAuthorization: vi.fn(async () => 'ready' as const),
      finalLockedFullRead: vi.fn(async () => true),
      evaluatePlanAuthorization: vi.fn(async () => true),
      onMutationApplied: vi.fn(async () => undefined),
    },
    leaseMs: 60_000,
    replayHorizonMs: 0,
    sweepLimit: 100,
    maxChunksPerRun: 1_000,
    workerOwnerId: 'canonical-worker',
    now: vi.fn(() => new Date('2026-08-29T00:00:00.000Z')),
  }
}

function fakeComposition(
  providers: {
    keyCustody: RecoveryArchiveKeyCustodyAdapter
    objectStore: RecoveryArchiveObjectStoreProvider
  },
): RecoveryArchiveApplicationComposition {
  return {
    keyCustody: providers.keyCustody,
    objectStore: providers.objectStore,
    auditedReplayHorizonMs: 86_400_000,
    asyncResumeHorizonMs: 3_600_000,
    workerIntervalMs: 60_000,
    worker: fakeWorkerDependencies(),
  }
}

function idleWorker(): RecoveryArchiveRestoreWorker {
  return {
    async runOnce() {
      return { kind: 'idle', swept: 0, chunks: 0 }
    },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
