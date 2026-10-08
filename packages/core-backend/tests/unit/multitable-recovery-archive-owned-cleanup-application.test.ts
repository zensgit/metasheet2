import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createRecoveryArchiveApplication, type RecoveryArchiveApplicationComposition, type RecoveryArchiveApplicationDatabaseRuntime } from '../../src/multitable/recovery-archive-application'

afterEach(() => vi.useRealTimers())
const factory = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../src/routes/univer-meta', () => ({ createRecoveryArchiveOwnedCleanup: factory.create }))
const enabled = { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' }
const identity = { actorId: randomUUID(), workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' }

function composition() {
  const provider = { storeId: randomUUID(), put: vi.fn(), get: vi.fn(), head: vi.fn(), pin: vi.fn(), deleteExpired: vi.fn(), discard: vi.fn(), status: vi.fn() }
  const value = { objectStore: provider, keyCustody: { produceGenerationDek: vi.fn(), unwrapGenerationDek: vi.fn(), deriveDekFingerprint: vi.fn(), macManifestRoot: vi.fn(), verifyManifestRootMac: vi.fn() },
    auditedReplayHorizonMs: 1000, asyncResumeHorizonMs: 1000, workerIntervalMs: 1000,
    worker: { recheckAuthority: vi.fn(), processDerivedWork: vi.fn(), leaseMs: 1000, replayHorizonMs: 1000,
      apply: { preliminaryFullRead: vi.fn(), finalLockedFullRead: vi.fn(), stabilizeAuthorization: vi.fn(), evaluatePlanAuthorization: vi.fn() } },
    manualCaptureLimits: { maxBytes: 65536, timeoutMs: 1000 }, manualCapture: { keyId: 'key', keyRowVersion: '1', leaseSeconds: 30, expiresAfterSeconds: 60 } }
  const database = { query: vi.fn(), transaction: vi.fn(), transactionDepthProbe: { currentTransactionDepth: () => 0 },
    nativePool: { connect: vi.fn(), options: { connectionTimeoutMillis: 10 } } }
  return { provider, value: value as RecoveryArchiveApplicationComposition, database: database as unknown as RecoveryArchiveApplicationDatabaseRuntime }
}

it('disabled construction and entry do not resolve cleanup dependencies', async () => {
  factory.create.mockReset()
  const make = vi.fn(), database = vi.fn()
  const app = createRecoveryArchiveApplication(make, database, {})
  await expect(app.cleanupExpiredBuilder(identity, randomUUID())).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
  expect(make).not.toHaveBeenCalled(); expect(database).not.toHaveBeenCalled(); expect(factory.create).not.toHaveBeenCalled()
})

it('actual composition binds original provider/policy once, drains admitted command, and rejects shutdown entry', async () => {
  const f = composition()
  let finish!: (result: { outcome: 'complete'; confirmed: number }) => void
  const command = vi.fn(() => new Promise<{ outcome: 'complete'; confirmed: number }>(resolve => { finish = resolve }))
  Object.assign(command, { drain: vi.fn(async () => {}) })
  factory.create.mockReset().mockReturnValue(command)
  const app = createRecoveryArchiveApplication(() => f.value, () => f.database, enabled)
  expect(factory.create).toHaveBeenCalledOnce()
  expect(factory.create).toHaveBeenCalledWith({ provider: f.provider, pool: f.database.nativePool, policy: f.value.manualCapture,
    limits: f.value.manualCaptureLimits, transactionDepth: f.database.transactionDepthProbe })
  const generationId = randomUUID(), pending = app.cleanupExpiredBuilder(identity, generationId)
  expect(command).toHaveBeenCalledWith({ identity, generationId })
  let drained = false; const stop = app.stopWorker().then(() => { drained = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(drained).toBe(false)
  expect(() => app.releaseCustody()).toThrow('RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED')
  await expect(app.cleanupExpiredBuilder(identity, generationId)).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
  finish({ outcome: 'complete', confirmed: 2 })
  expect(await pending).toEqual({ outcome: 'complete', confirmed: 2 }); await stop
  expect(drained).toBe(true); expect(() => app.releaseCustody()).not.toThrow()
})

it('missing policies/native pool and failed capability construction refuse without command dispatch', async () => {
  for (const missing of ['manualCapture', 'manualCaptureLimits', 'nativePool'] as const) {
    const f = composition(); factory.create.mockReset()
    if (missing === 'nativePool') delete f.database.nativePool
    else delete (f.value as Partial<RecoveryArchiveApplicationComposition>)[missing]
    const app = createRecoveryArchiveApplication(() => f.value, () => f.database, enabled)
    await expect(app.cleanupExpiredBuilder(identity, randomUUID())).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
    expect(factory.create).not.toHaveBeenCalled(); await app.stopWorker()
  }
  const f = composition(); factory.create.mockImplementation(() => { throw new Error('private-adapter-value') })
  const app = createRecoveryArchiveApplication(() => f.value, () => f.database, enabled)
  await expect(app.cleanupExpiredBuilder(identity, randomUUID())).rejects.toThrow(/^RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED$/)
  await app.stopWorker()
})

it('existing shutdown deadline refuses custody release while full execution remains pending, even after it later settles', async () => {
  vi.useFakeTimers()
  const f = composition()
  let finish!: () => void
  const originalExecution = new Promise<void>(resolve => { finish = resolve })
  const command = Object.assign(vi.fn(), { drain: vi.fn(() => originalExecution) })
  factory.create.mockReset().mockReturnValue(command)
  const app = createRecoveryArchiveApplication(() => f.value, () => f.database, enabled)
  const stop = app.stopWorker()
  const refusal = expect(stop).rejects.toThrow('RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED')
  await vi.advanceTimersByTimeAsync(10000); await refusal
  expect(command.drain).toHaveBeenCalledOnce()
  expect(() => app.releaseCustody()).toThrow('RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED')
  finish(); await vi.advanceTimersByTimeAsync(1)
  expect(() => app.releaseCustody()).toThrow('RECOVERY_ARCHIVE_APPLICATION_WORKER_STOP_FAILED')
})
