import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
const callbacks = vi.hoisted(() => vi.fn(() => ({ recheckAuthority: vi.fn(), apply: vi.fn(), processDerivedWork: vi.fn() })))
vi.mock('../../src/routes/univer-meta', () => ({ createRecoveryArchiveWorkerCallbacks: callbacks }))
import { prepareRecoveryRemoteComposition, type RecoveryRemoteResourceCompositionConfig } from '../../src/multitable/recovery-remote-composition'
import type { RecoveryArchiveApplicationDatabaseRuntime } from '../../src/multitable/recovery-archive-application'

function input(env: Record<string, string | undefined>) {
  const common = { url: 'https://synthetic.invalid', ca: Buffer.from('not-used-before-IO'), timeoutMs: 1000 }
  const config: RecoveryRemoteResourceCompositionConfig = {
    objectStore: { ...common, token: 'synthetic-object-token'.padEnd(48, 'a'), storeId: randomUUID(), maxObjectBytes: 1024 },
    keyCustody: { ...common, token: 'synthetic-custody-token'.padEnd(48, 'b'), keyId: 'synthetic-key', wrappingKey: 'wrap',
      fingerprintKey: 'fingerprint', fingerprintKeyVersion: 1, manifestKey: 'manifest', manifestKeyVersion: 1 },
    policy: { auditedReplayHorizonMs: 1000, asyncResumeHorizonMs: 1000, workerIntervalMs: 1000 },
    worker: { leaseMs: 1000, replayHorizonMs: 1000, sweepLimit: 1, maxChunksPerRun: 1 },
  }
  const database = { transactionDepthProbe: { currentTransactionDepth: () => 0 } } as RecoveryArchiveApplicationDatabaseRuntime
  return { env, config, resolveResources: vi.fn(() => config), resolveDatabase: vi.fn(() => database), resolveAttachmentStorage: vi.fn(() => ({
    uploadByKey: vi.fn(), readRecoveryAttachment: vi.fn(), reserveRecoveryAttachment: vi.fn(),
  })) }
}
describe('explicit remote resource composition', () => {
  test.each([{}, { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' }, { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'TRUE', MULTITABLE_ENABLE_WRITER_FENCE: 'true' },
    { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'TRUE' }])('OFF resolves no private resource or database', env => {
    const f = input(env); expect(prepareRecoveryRemoteComposition(f)).toBeUndefined()
    expect(f.resolveResources).not.toHaveBeenCalled(); expect(f.resolveDatabase).not.toHaveBeenCalled(); expect(f.resolveAttachmentStorage).not.toHaveBeenCalled()
  })
  test('exact ON wires canonical callbacks and all seven store verbs without connecting', () => {
    const f = input({ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' })
    const result = prepareRecoveryRemoteComposition(f)!
    expect(f.resolveResources).toHaveBeenCalledOnce(); expect(f.resolveDatabase).toHaveBeenCalledOnce(); expect(callbacks).toHaveBeenCalledWith(f.resolveDatabase())
    expect(result.objectStore.storeId).toBe(f.config.objectStore.storeId)
    expect(result.attachmentStorage).toBe(f.resolveAttachmentStorage.mock.results[0]!.value)
    for (const verb of ['put', 'get', 'head', 'pin', 'deleteExpired', 'discard', 'status']) expect(typeof (result.objectStore as unknown as Record<string, unknown>)[verb]).toBe('function')
    expect(result.worker.workerOwnerId).toMatch(/^remote-[0-9a-f-]{36}$/)
  })
  test('one credential cannot stand in for both service identities', () => {
    const f = input({ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' }); f.config.keyCustody.token = f.config.objectStore.token
    expect(() => prepareRecoveryRemoteComposition(f)).toThrow('RECOVERY_ARCHIVE_REMOTE_COMPOSITION_REFUSED')
    expect(f.resolveDatabase).not.toHaveBeenCalled()
  })
})
