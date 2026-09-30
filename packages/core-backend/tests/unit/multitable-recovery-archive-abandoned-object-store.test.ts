import { createHash, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }))
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import { createGuardedRecoveryArchiveAbandonedObjectStore, recoveryArchiveDiscardReceipt } from '../../src/multitable/recovery-archive-abandoned-object-store'
import { createTransactionGuardedRecoveryArchiveObjectStore } from '../../src/multitable/recovery-archive-object-store'

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
  const request = { ...binding, operationId: randomUUID(), storeId: options.storeId }
  const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
  const file = path.join(basePath, `${object.generationId}-${object.objectId}.object`)
  return { options, provider, object, binding, request, store, file }
}

describe('operation-bound abandoned object discard (LOCAL synthetic)', () => {
  test('a different initialized store cannot confirm the original store operation', async () => {
    const original = await setup()
    const foreign = await setup()
    await original.provider.put(original.object)
    await expect(foreign.store.discard(original.request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    const read = vi.spyOn(fs, 'readFile')
    const write = vi.spyOn(fs, 'open')
    await expect(foreign.provider.discard(original.request)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
    await expect(foreign.provider.status(original.request)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(await original.store.status(original.request)).toEqual({ outcome: 'unknown' })
    expect((await original.provider.get(original.binding)).bytes).toEqual(original.object.bytes)
    expect((await fs.readdir(foreign.options.basePath)).sort()).toEqual(['.metasheet-archive-root'])
  })

  test('immutable own namespace metadata survives the ordinary transaction guard', async () => {
    const { provider, options, object, binding } = await setup()
    const wrapped = createTransactionGuardedRecoveryArchiveObjectStore(provider, options.transactionDepth)
    for (const store of [provider, wrapped]) {
      expect(Object.getOwnPropertyDescriptor(store, 'storeId')).toEqual({
        value: options.storeId, writable: false, configurable: false, enumerable: true,
      })
    }
    // Existing ordinary verbs still work for a legacy provider without namespace metadata.
    const { storeId: _storeId, ...legacy } = provider
    const legacyStore = createTransactionGuardedRecoveryArchiveObjectStore(legacy, options.transactionDepth)
    expect(Object.hasOwn(legacyStore, 'storeId')).toBe(false)
    await legacyStore.put(object)
    expect(Buffer.from((await legacyStore.get(binding)).bytes)).toEqual(object.bytes)
  })

  test.each([undefined, 'invalid', null, randomUUID()])('unknown or foreign namespace %s refuses before provider IO', async (storeId) => {
    const { request, options } = await setup()
    const provider = { storeId, discard: vi.fn(), status: vi.fn() }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
    for (const verb of ['discard', 'status'] as const) {
      await expect(store[verb](request)).rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/)
    }
    expect(provider.discard).not.toHaveBeenCalled()
    expect(provider.status).not.toHaveBeenCalled()
  })

  test('namespace accessors are never invoked and a foreign-store receipt is rejected', async () => {
    const { request, options } = await setup()
    const getter = vi.fn(() => { throw new Error('SENSITIVE_NAMESPACE') })
    const provider = { discard: vi.fn(), status: vi.fn() }
    Object.defineProperty(provider, 'storeId', { get: getter })
    await expect(createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth).status(request))
      .rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/)
    expect(getter).not.toHaveBeenCalled()
    expect(provider.status).not.toHaveBeenCalled()
    const foreignReceipt = recoveryArchiveDiscardReceipt({ ...request, storeId: randomUUID() })
    expect(foreignReceipt).not.toBe(recoveryArchiveDiscardReceipt(request))
    const foreign = { storeId: request.storeId, status: async () => ({ outcome: 'absent' as const, receiptSha256: foreignReceipt }), discard: vi.fn() }
    await expect(createGuardedRecoveryArchiveAbandonedObjectStore(foreign, options.transactionDepth).status(request))
      .rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/)
  })

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

  test.each(['race', 'pin-first'] as const)('two child processes %s pin/discard on one LOCAL root without both succeeding', async (order) => {
    const { options, provider, object, binding, request, file } = await setup()
    await provider.put(object)
    const contenders = (['pin', 'discard'] as const).map((action) => {
      const child = fork(path.resolve('tests/fixtures/recovery-abandoned-store-contender.mts'), [], {
        execArgv: ['--import', 'tsx'], silent: true,
        env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: '1', NODE_ENV: 'test' },
      })
      let result: unknown
      let output = ''
      child.stdout!.on('data', (chunk) => { output += chunk })
      child.stderr!.on('data', (chunk) => { output += chunk })
      const ready = new Promise<unknown>((resolve) => {
        child.on('message', (message) => {
          if (typeof message === 'object' && message !== null && 'ready' in message) resolve(message)
          else result = message
        })
      })
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on('error', () => { output += 'CHILD_PROCESS_FAILED' })
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      const { transactionDepth: _transactionDepth, ...serializableOptions } = options
      child.send({ action, options: serializableOptions, request })
      return { child, ready, closed, result: () => result, output: () => output }
    })
    let timer: ReturnType<typeof setTimeout>
    try {
      await Promise.race([
        (async () => {
          const ready = await Promise.all(contenders.map((item) => Promise.race([
            item.ready, item.closed.then(() => { throw new Error('CONTENDER_EXIT_BEFORE_READY') }),
          ])))
          expect(ready).toEqual(contenders.map(({ child }) => ({ ready: true, pid: child.pid })))
          expect(new Set(contenders.map(({ child }) => child.pid)).size).toBe(2)
          expect(contenders.every(({ child }) => child.pid !== process.pid)).toBe(true)
          // Neither child starts provider IO until both independent providers report ready.
          contenders[0].child.send({ start: true })
          if (order === 'pin-first') await contenders[0].closed
          contenders[1].child.send({ start: true })
          expect(await Promise.all(contenders.map((item) => item.closed))).toEqual([
            { code: 0, signal: null }, { code: 0, signal: null },
          ])
          expect(contenders.map((item) => item.output())).toEqual(['', ''])
          const pin = contenders[0].result()
          const discarded = contenders[1].result()
          const { bytes: _bytes, ...descriptor } = object
          if (order === 'pin-first') expect(pin).toEqual({ pin: 'succeeded', object: { ...descriptor, pinned: true } })
          if (typeof pin === 'object' && pin !== null && 'pin' in pin && pin.pin === 'succeeded') {
            expect(pin).toEqual({ pin: 'succeeded', object: { ...descriptor, pinned: true } })
            expect(discarded).toEqual({ discard: { outcome: 'retained' } })
            expect(await provider.status(request)).toEqual({ outcome: 'retained' })
            expect(await provider.get(binding)).toEqual({ ...object, pinned: true })
          } else {
            expect(pin).toEqual({ pin: 'refused', code: 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED' })
            const absent = { outcome: 'absent', receiptSha256: recoveryArchiveDiscardReceipt(request) }
            expect(discarded).toEqual({ discard: absent })
            expect(await provider.status(request)).toEqual(absent)
            expect(await provider.head(binding)).toBeNull()
            await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(provider.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CONTENDER_TIMEOUT')), 10_000)
        }),
      ])
    } finally {
      clearTimeout(timer!)
      for (const { child } of contenders) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      // afterEach may remove only this test's root, and only after both children exit.
      await Promise.all(contenders.map((item) => item.closed))
    }
  }, 15_000)

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
    const lost = createGuardedRecoveryArchiveAbandonedObjectStore({ storeId: provider.storeId, status: provider.status,
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
    const provider = { storeId: request.storeId, discard: vi.fn(), status: vi.fn() }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, { currentTransactionDepth: () => depth as number })
    await expect(store.discard(request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    await expect(store.status(request)).rejects.toThrow('RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED')
    expect(provider.discard).not.toHaveBeenCalled()
    expect(provider.status).not.toHaveBeenCalled()
  })

  test('foreign operation receipt and provider values never cross the boundary', async () => {
    const { request, options } = await setup()
    const provider = { storeId: options.storeId, discard: vi.fn(async () => ({ outcome: 'absent' as const, receiptSha256: 'a'.repeat(64) })),
      status: vi.fn(async () => { throw new Error('SENSITIVE_PROVIDER_VALUE') }) }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
    for (const verb of ['discard', 'status'] as const) await expect(store[verb](request)).rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/)
  })
  test('request is snapshotted before awaiting provider and accessor inputs never invoke IO', async () => {
    const { request, options } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalReceipt = recoveryArchiveDiscardReceipt(request)
    const provider = { storeId: options.storeId, status: vi.fn(async () => ({ outcome: 'unknown' as const })),
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
    const provider = { storeId: options.storeId, discard: async () => result, status: async () => result }
    const store = createGuardedRecoveryArchiveAbandonedObjectStore(provider, options.transactionDepth)
    expect(await store.discard(request)).toEqual({ outcome: 'absent', receiptSha256: expected })
    expect(reads).toBe(0)
    expect(await store.status(request)).toEqual({ outcome: 'absent', receiptSha256: expected })
    expect(reads).toBe(0)
  })

})
