import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import { createRecoveryArchiveObjectServer } from '../../src/multitable/recovery-archive-object-server'
import { createRecoveryArchiveRemoteObjectStore } from '../../src/multitable/recovery-archive-remote-object-store'
import { createRecoveryResourceHttps } from '../../src/multitable/recovery-resource-https'
import { recoveryArchiveDiscardReceipt } from '../../src/multitable/recovery-archive-abandoned-object-store'
import { recoveryResourceTestTls } from '../utils/recovery-resource-tls'

const token = 'synthetic-object-token-'.padEnd(48, 'x')
const expiry = '2026-09-15T00:00:00.000Z', now = '2026-10-11T00:00:00.000Z'
let tls: Awaited<ReturnType<typeof recoveryResourceTestTls>>, unrelatedTls: Awaited<ReturnType<typeof recoveryResourceTestTls>>
const roots: string[] = [], services: ReturnType<typeof createRecoveryArchiveObjectServer>[] = []
beforeAll(async () => { tls = await recoveryResourceTestTls(); unrelatedTls = await recoveryResourceTestTls() })
afterAll(() => { tls.key.fill(0); unrelatedTls.key.fill(0) })
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function object() {
  const bytes = Buffer.from('synthetic-ciphertext')
  return { generationId: randomUUID(), objectId: 'a'.repeat(64), version: 'immutable-1', sha256: createHash('sha256').update(bytes).digest('hex'),
    size: String(bytes.length), expiresAt: expiry, pinned: false, bytes }
}
function expected(o: ReturnType<typeof object>) {
  return { generationId: o.generationId, objectId: o.objectId, expectedVersion: o.version, expectedSha256: o.sha256, expectedSize: o.size, expectedExpiresAt: o.expiresAt }
}
type Provider = Awaited<ReturnType<typeof createRecoveryArchiveFileStoreProvider>>
async function setup(wrapProvider: (provider: Provider) => Provider = provider => provider, timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'tm-object-tls-')); roots.push(root)
  const options = { basePath: root, storeId: randomUUID(), maxObjectBytes: 1024, transactionDepth: { currentTransactionDepth: () => 0 } }
  await provisionRecoveryArchiveFileRoot(options)
  async function start() {
    const provider = wrapProvider(await createRecoveryArchiveFileStoreProvider(options))
    const service = createRecoveryArchiveObjectServer({ ...options, provider, token, ...tls, timeoutMs }); services.push(service)
    let requestCount = 0
    service.server.on('request', () => { requestCount++ })
    await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve))
    const url = `https://127.0.0.1:${(service.server.address() as AddressInfo).port}`
    let depth = 0
    const config = { url, token, ca: tls.cert, timeoutMs, storeId: options.storeId, maxObjectBytes: 1024, transactionDepth: { currentTransactionDepth: () => depth } }
    return { service, config, store: createRecoveryArchiveRemoteObjectStore(config), setDepth: (value: number) => { depth = value }, requestCount: () => requestCount }
  }
  return { ...(await start()), start, options }
}
describe('seven-operation object resource over TLS', () => {
  test('immutable replay and restart preserve bytes; wrong binding refuses', async () => {
    const { store, start, service } = await setup(), o = object(), { bytes, ...descriptor } = o
    expect(await store.put(o)).toEqual({ outcome: 'created', object: descriptor })
    expect(await store.put(o)).toEqual({ outcome: 'existing', object: descriptor })
    await expect(store.put({ ...o, version: 'changed' })).rejects.toThrow()
    await service.stop(); const next = await start()
    expect(await next.store.get(expected(o))).toEqual({ ...descriptor, bytes: new Uint8Array(bytes) })
    expect(await next.store.head(expected(o))).toEqual(descriptor)
  })
  test('pin and expired deletion cannot both win; permanence survives restart', async () => {
    const { store, start } = await setup(), o = object(); await store.put(o)
    const results = await Promise.allSettled([store.pin(expected(o)), store.deleteExpired({ ...expected(o), now })])
    const pin = results[0], deletion = results[1]
    expect(deletion.status).toBe('fulfilled')
    if (pin.status === 'fulfilled') {
      expect(deletion).toMatchObject({ value: { outcome: 'retained', object: { pinned: true } } })
      expect((await (await start()).store.get(expected(o))).pinned).toBe(true)
    } else {
      expect(deletion).toMatchObject({ value: { outcome: 'deleted' } })
      await expect((await start()).store.put(o)).rejects.toThrow()
    }
  })
  test('discard status binds operation and store across restart and blocks late PUT', async () => {
    const { store, start, options } = await setup(), o = object()
    const request = { ...expected(o), operationId: randomUUID(), storeId: options.storeId }
    expect(await store.status(request)).toEqual({ outcome: 'unknown' })
    const receipt = { outcome: 'absent', receiptSha256: recoveryArchiveDiscardReceipt(request) }
    expect(await store.discard(request)).toEqual(receipt)
    expect(await (await start()).store.status(request)).toEqual(receipt)
    await expect(store.put(o)).rejects.toThrow()
    await expect(store.status({ ...request, expectedVersion: 'different' })).rejects.toThrow()
    await expect(store.discard({ ...request, storeId: randomUUID() })).rejects.toThrow()
  })
  test('pinned object is retained by abandoned cleanup', async () => {
    const { store, options } = await setup(), o = object(); await store.put(o); await store.pin(expected(o))
    const request = { ...expected(o), operationId: randomUUID(), storeId: options.storeId }
    expect(await store.discard(request)).toEqual({ outcome: 'retained' })
    expect(await store.status(request)).toEqual({ outcome: 'retained' })
    expect((await store.get(expected(o))).bytes).toEqual(new Uint8Array(o.bytes))
  })
  test('all seven client operations refuse inside a transaction', async () => {
    const f = await setup(), o = object(), request = { ...expected(o), operationId: randomUUID(), storeId: f.options.storeId }
    const before = f.requestCount()
    f.setDepth(1)
    for (const run of [() => f.store.put(o), () => f.store.get(expected(o)), () => f.store.head(expected(o)), () => f.store.pin(expected(o)),
      () => f.store.deleteExpired({ ...expected(o), now }), () => f.store.discard(request), () => f.store.status(request)]) await expect(run()).rejects.toThrow()
    expect(f.requestCount()).toBe(before)
    f.setDepth(0); expect(await f.store.head(expected(o))).toBeNull()
  })
  test('wrong token and service namespace never become absent', async () => {
    const f = await setup(), o = object()
    for (const overrides of [{ token: token + 'wrong' }, { storeId: randomUUID() }, { ca: unrelatedTls.cert }]) {
      const other = createRecoveryArchiveRemoteObjectStore({ ...f.config, ...overrides })
      await expect(other.head(expected(o))).rejects.toThrow()
      await expect(other.status({ ...expected(o), operationId: randomUUID(), storeId: other.storeId! })).rejects.toThrow()
    }
  })
  test('unknown verb, extra fields, noncanonical base64 and oversized payload refuse', async () => {
    const f = await setup(), o = object(), post = createRecoveryResourceHttps({ ...f.config, maxRequestBytes: 65536 }, 'authorization')
    for (const [path, data] of [['/v1/unknown', {}], ['/v1/head', { ...expected(o), extra: true }],
      ['/v1/put', { ...o, bytes: o.bytes.toString('base64') + ' ' }], ['/v1/put', { ...o, bytes: Buffer.alloc(2000).toString('base64') }],
      ['/v1/put', { bytes: 'x'.repeat(20000) }]]) {
      await expect(post(path as string, data)).rejects.toThrow()
    }
    expect(await f.store.head(expected(o))).toBeNull()
  })
  test('timeout remains unknown and stopping drains a write before persisted restart', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(done => { enter = done }), gate = new Promise<void>(done => { release = done })
    const f = await setup(provider => ({ ...provider, async put(request) { enter(); await gate; return provider.put(request) } }), 500)
    try {
      const o = object(), pending = expect(f.store.put(o)).rejects.toThrow(/^RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED$/)
      await entered; await pending
      let stopped = false
      const stopping = f.service.stop().then(() => { stopped = true })
      await new Promise(done => setTimeout(done, 20)); expect(stopped).toBe(false)
      release(); await stopping
      const next = await f.start(), { bytes, ...descriptor } = o
      expect(await next.store.get(expected(o))).toEqual({ ...descriptor, bytes: new Uint8Array(bytes) })
    } finally { release() }
  })
  test('malformed server credentials and TLS material produce only a fixed error', async () => {
    const f = await setup(), provider = await createRecoveryArchiveFileStoreProvider(f.options)
    for (const invalid of [{ token: 'short' }, { cert: Buffer.from('invalid-cert') }, { key: Buffer.from('synthetic-secret-invalid-key') }]) {
      expect(() => createRecoveryArchiveObjectServer({ ...f.options, provider, token, ...tls, timeoutMs: 1000, ...invalid })).toThrow(/^RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED$/)
    }
  })
})
