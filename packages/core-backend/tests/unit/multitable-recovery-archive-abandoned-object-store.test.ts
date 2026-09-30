import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }))
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import { createGuardedRecoveryArchiveAbandonedObjectStore, recoveryArchiveDiscardReceipt } from '../../src/multitable/recovery-archive-abandoned-object-store'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function setup() {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-abandoned-store-'))
  roots.push(basePath)
  const options = { basePath, storeId: randomUUID(), maxObjectBytes: 1024, transactionDepth: { currentTransactionDepth: () => 0 } }
  await provisionRecoveryArchiveFileRoot(options)
  const provider = await createRecoveryArchiveFileStoreProvider(options)
  const bytes = Buffer.from('synthetic sealed object')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const object = { generationId: randomUUID(), objectId: sha256, version: sha256, sha256,
    size: String(bytes.length), expiresAt: '2099-01-01T00:00:00.000Z', pinned: false, bytes }
  const binding = { generationId: object.generationId, objectId: object.objectId, expectedVersion: object.version,
    expectedSha256: object.sha256, expectedSize: object.size, expectedExpiresAt: object.expiresAt }
  const request = { ...binding, operationId: randomUUID() }
  const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
  const file = path.join(basePath, `${object.generationId}-${object.objectId}.object`)
  return { options, provider, object, binding, request, store, file }
}

describe('operation-bound abandoned object discard (LOCAL synthetic)', () => {
  test.each([false, true])('discards before expiry, including never-uploaded=%s, and survives restart', async (uploaded) => {
    const { options, provider, object, binding, request, store, file } = await setup()
    if (uploaded) await provider.put(object)
    expect(await store.status(request)).toEqual({ outcome: 'unknown' })
    const expected = { outcome: 'absent', receiptSha256: recoveryArchiveDiscardReceipt(request) }
    expect(await store.discard(request)).toEqual(expected)
    const restarted = await createRecoveryArchiveFileStoreProvider(options)
    expect(await restarted.status(request)).toEqual(expected)
    expect(await restarted.head(binding)).toBeNull()
    await expect(restarted.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('operation UUID cannot be reused for another generation or binding', async () => {
    const { store, request } = await setup()
    await store.discard(request)
    for (const wrong of [{ ...request, generationId: randomUUID() }, { ...request, expectedSize: '999' }]) {
      await expect(store.status(wrong)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
      await expect(store.discard(wrong)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    }
  })

  test('wrong binding never deletes the exact live bytes', async () => {
    const { provider, object, binding, store, request } = await setup()
    await provider.put(object)
    await expect(store.discard({ ...request, expectedVersion: 'wrong' })).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    expect((await provider.get(binding)).bytes).toEqual(object.bytes)
  })

  test('pinned object is retained without a terminal receipt', async () => {
    const { provider, object, binding, store, request } = await setup()
    await provider.put(object)
    await provider.pin(binding)
    expect(await store.discard(request)).toEqual({ outcome: 'retained' })
    expect(await store.status(request)).toEqual({ outcome: 'retained' })
    expect((await provider.get(binding)).pinned).toBe(true)
  })

  test('independent pin/discard contenders cannot both succeed', async () => {
    const { options, provider, object, binding, request, store } = await setup()
    await provider.put(object)
    const other = await createRecoveryArchiveFileStoreProvider(options)
    const [pin, discarded] = await Promise.allSettled([other.pin(binding), store.discard(request)])
    expect(discarded.status).toBe('fulfilled')
    if (discarded.status !== 'fulfilled') return
    if (pin.status === 'fulfilled') expect(discarded.value).toEqual({ outcome: 'retained' })
    else expect(discarded.value.outcome).toBe('absent')
  })

  test('crash after tombstone before unlink stays ambiguous until status durably reconciles', async () => {
    const { options, provider, object, request, store, file } = await setup()
    await provider.put(object)
    const unlink = fs.unlink
    vi.spyOn(fs, 'unlink').mockImplementation(async (name) => {
      if (String(name).endsWith(path.basename(file))) throw new Error('SENSITIVE_PROVIDER_VALUE')
      return unlink(name)
    })
    await expect(store.discard(request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    expect((await fs.stat(file)).isFile()).toBe(true)
    vi.restoreAllMocks()
    const restarted = await createRecoveryArchiveFileStoreProvider(options)
    expect(await restarted.status(request)).toEqual({ outcome: 'absent', receiptSha256: recoveryArchiveDiscardReceipt(request) })
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('lost terminal response is recovered with the same operation, never with HEAD evidence', async () => {
    const { provider, object, request, options } = await setup()
    await provider.put(object)
    const lost = createGuardedRecoveryArchiveAbandonedObjectStore({ status: provider.status,
      discard: async (input) => { await provider.discard(input); throw new Error('SENSITIVE_RESPONSE') } }, options.transactionDepth)
    await expect(lost.discard(request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    expect(await lost.status(request)).toEqual({ outcome: 'absent', receiptSha256: recoveryArchiveDiscardReceipt(request) })
  })

  test('terminal status re-unlinks raw bytes from a late PUT crash and never permits resurrection', async () => {
    const { provider, object, request, store, file, binding } = await setup()
    await provider.put(object)
    const lateBytes = await fs.readFile(file)
    await store.discard(request)
    // Reproduce a PUT already past its first tombstone check, crashing after exclusive publication.
    await fs.writeFile(file, lateBytes, { flag: 'wx', mode: 0o600 })
    expect(await provider.head(binding)).toBeNull()
    expect(await store.status(request)).toEqual({ outcome: 'absent', receiptSha256: recoveryArchiveDiscardReceipt(request) })
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(provider.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
  })

  test.each([1, undefined, NaN])('every provider verb refuses transaction depth %s with zero IO', async (depth) => {
    const { request } = await setup()
    const provider = { discard: vi.fn(), status: vi.fn() }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, { currentTransactionDepth: () => depth as number })
    await expect(store.discard(request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    await expect(store.status(request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    expect(provider.discard).not.toHaveBeenCalled()
    expect(provider.status).not.toHaveBeenCalled()
  })

  test('foreign operation receipt and provider values never cross the boundary', async () => {
    const { request, options } = await setup()
    const provider = { discard: vi.fn(async () => ({ outcome: 'absent' as const, receiptSha256: 'a'.repeat(64) })),
      status: vi.fn(async () => { throw new Error('SENSITIVE_PROVIDER_VALUE') }) }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
    for (const verb of ['discard', 'status'] as const) await expect(store[verb](request)).rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/)
  })
  test('request is snapshotted before awaiting provider and accessor inputs never invoke IO', async () => {
    const { request, options } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalReceipt = recoveryArchiveDiscardReceipt(request)
    const provider = { status: vi.fn(async () => ({ outcome: 'unknown' as const })),
      discard: vi.fn(async (input) => { await gate; return { outcome: 'absent' as const, receiptSha256: recoveryArchiveDiscardReceipt(input) } }) }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
    const pending = store.discard(request)
    request.objectId = 'f'.repeat(64)
    release()
    expect(await pending).toEqual({ outcome: 'absent', receiptSha256: originalReceipt })
    const getter = { ...request }
    Object.defineProperty(getter, 'operationId', { get: () => { throw new Error('SENSITIVE_GETTER') } })
    await expect(store.status(getter)).rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/)
    expect(provider.status).not.toHaveBeenCalled()
  })

  test('snapshots result data descriptors without rereading changing provider Proxy values', async () => {
    const { request, options } = await setup()
    const expected = recoveryArchiveDiscardReceipt(request)
    let reads = 0
    const result = new Proxy({ outcome: 'absent' as const, receiptSha256: expected }, {
      get(target, property) {
        if (property === 'receiptSha256') return ++reads === 1 ? expected : 'f'.repeat(64)
        return Reflect.get(target, property)
      },
    })
    const provider = { discard: async () => result, status: async () => result }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
    expect(await store.discard(request)).toEqual({ outcome: 'absent', receiptSha256: expected })
    expect(reads).toBe(0)
    expect(await store.status(request)).toEqual({ outcome: 'absent', receiptSha256: expected })
    expect(reads).toBe(0)
  })

})
