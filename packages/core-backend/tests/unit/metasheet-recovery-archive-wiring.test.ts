import { readFileSync } from 'node:fs'

import { Router } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { pool as pgPool } from '../../src/db/pg'

const routeMocks = vi.hoisted(() => ({
  univerMetaRouter: vi.fn(),
}))

const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')

vi.mock('../../src/routes/univer-meta', () => ({
  univerMetaRouter: routeMocks.univerMetaRouter,
}))

import {
  coreBackendIsDirectEntry,
  isCoreBackendDirectEntry,
  MetaSheetServer,
} from '../../src/index'

describe('MetaSheetServer recovery archive wiring', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', '')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
    routeMocks.univerMetaRouter.mockReset()
    routeMocks.univerMetaRouter.mockImplementation(() => Router())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('keeps both router calls zero-argument and never invokes the factory with flags off', () => {
    const factory = vi.fn(() => {
      throw new Error('factory must remain unreachable')
    })
    const getMainPool = vi.spyOn(poolManager, 'get')

    new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
      createRecoveryArchiveComposition: factory,
    })

    expect(factory).not.toHaveBeenCalled()
    expect(getMainPool).not.toHaveBeenCalled()
    expect(routeMocks.univerMetaRouter).toHaveBeenCalledTimes(2)
    expect(routeMocks.univerMetaRouter.mock.calls).toEqual([[], []])
  })

  it('passes the exact same options and runtime identity to both mounts', () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const mainPool = poolManager.get()
    const getMainPool = vi.spyOn(poolManager, 'get').mockReturnValue(mainPool)
    const keyCustody = {
      produceGenerationDek: vi.fn(),
      unwrapGenerationDek: vi.fn(),
      deriveDekFingerprint: vi.fn(),
      macManifestRoot: vi.fn(),
      verifyManifestRootMac: vi.fn(),
    }
    const objectStore = {
      put: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      deleteExpired: vi.fn(),
      pin: vi.fn(),
    }
    const factory = vi.fn(() => ({
      keyCustody,
      objectStore,
      auditedReplayHorizonMs: 86_400_000,
      asyncResumeHorizonMs: 3_600_000,
      workerIntervalMs: 60_000,
      worker: {
        recheckAuthority: async () => true,
        apply: {
          preliminaryFullRead: async () => true,
          stabilizeAuthorization: async () => 'ready' as const,
          finalLockedFullRead: async () => true,
          evaluatePlanAuthorization: async () => true,
        },
        leaseMs: 60_000,
        replayHorizonMs: 0,
      },
    }))

    new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
      createRecoveryArchiveComposition: factory,
    })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(getMainPool).toHaveBeenCalledTimes(1)
    getMainPool.mockClear()
    getMainPool.mockImplementation(() => {
      throw new Error('main pool must not be re-resolved')
    })
    expect(routeMocks.univerMetaRouter).toHaveBeenCalledTimes(2)
    const firstOptions = routeMocks.univerMetaRouter.mock.calls[0]?.[0]
    const secondOptions = routeMocks.univerMetaRouter.mock.calls[1]?.[0]
    expect(firstOptions).toBe(secondOptions)
    expect(firstOptions?.recoveryArchiveRuntime).toBe(secondOptions?.recoveryArchiveRuntime)
    expect(firstOptions?.recoveryArchiveDatabaseRuntime).toBe(
      secondOptions?.recoveryArchiveDatabaseRuntime,
    )
    expect(firstOptions?.recoveryArchiveRuntime).toEqual({
      keyCustody,
      objectStore,
      transactionDepth: mainPool.transactionDepthProbe,
    })
    expect(firstOptions?.recoveryArchiveRuntime?.transactionDepth).toBe(
      mainPool.transactionDepthProbe,
    )
    expect(firstOptions?.recoveryArchiveDatabaseRuntime?.transactionDepthProbe).toBe(
      mainPool.transactionDepthProbe,
    )
    expect(firstOptions?.recoveryArchiveRuntime?.transactionDepth).toBe(
      firstOptions?.recoveryArchiveDatabaseRuntime?.transactionDepthProbe,
    )
    expect(Object.isFrozen(firstOptions?.recoveryArchiveDatabaseRuntime)).toBe(true)
    expect(firstOptions).toEqual({
      recoveryArchiveRuntime: firstOptions?.recoveryArchiveRuntime,
      recoveryArchiveDatabaseRuntime: firstOptions?.recoveryArchiveDatabaseRuntime,
      recoveryArchiveAuditedReplayHorizonMs: 86_400_000,
      recoveryArchiveAsyncResumeHorizonMs: 3_600_000,
    })
    expect(getMainPool).not.toHaveBeenCalled()
  })

  it('distinguishes direct execution from an injected launcher import', () => {
    const currentModule = {}

    expect(coreBackendIsDirectEntry).toBe(false)
    expect(isCoreBackendDirectEntry(currentModule, currentModule)).toBe(true)
    expect(isCoreBackendDirectEntry({}, currentModule)).toBe(false)
    expect(isCoreBackendDirectEntry(undefined, currentModule)).toBe(false)
  })

  it('keeps the database pool open when the restore worker cannot drain', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const stopWorker = vi.fn().mockRejectedValue(new Error('worker-stop-sentinel'))
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    ;(server as unknown as {
      recoveryArchiveApplication: { stopWorker(): Promise<void> }
    }).recoveryArchiveApplication = { stopWorker }

    const firstStop = server.stop('SIGTERM')
    const reentrantStop = server.stop('SIGINT')

    expect(reentrantStop).toBe(firstStop)
    await expect(firstStop).rejects.toThrow('RECOVERY_ARCHIVE_RESTORE_WORKER_STOP_FAILED')
    await expect(reentrantStop).rejects.toThrow('RECOVERY_ARCHIVE_RESTORE_WORKER_STOP_FAILED')

    expect(stopWorker).toHaveBeenCalledTimes(1)
    expect(poolEnd).not.toHaveBeenCalled()
  })

  it('closes the database pool after the restore worker drains', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const stopWorker = vi.fn().mockResolvedValue(undefined)
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    ;(server as unknown as {
      recoveryArchiveApplication: { stopWorker(): Promise<void> }
    }).recoveryArchiveApplication = { stopWorker }

    await server.stop()

    expect(stopWorker).toHaveBeenCalledTimes(1)
    expect(poolEnd).toHaveBeenCalledTimes(1)
  })

  it('reports a failed signal shutdown with a non-zero exit code', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const stop = vi.spyOn(server, 'stop').mockRejectedValue(
      new Error('RECOVERY_ARCHIVE_RESTORE_WORKER_STOP_FAILED'),
    )
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)

    ;(server as unknown as {
      stopForSignal(signal: 'SIGTERM' | 'SIGINT'): void
    }).stopForSignal('SIGTERM')

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stop).toHaveBeenCalledWith('SIGTERM')
  })

  it('registers both runtime signals through the non-zero failure mapper', () => {
    expect(indexSource).toContain("process.on('SIGTERM', () => this.stopForSignal('SIGTERM'))")
    expect(indexSource).toContain("process.on('SIGINT', () => this.stopForSignal('SIGINT'))")
  })
})
