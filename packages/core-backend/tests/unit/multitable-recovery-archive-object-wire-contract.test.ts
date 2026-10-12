import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const transport = vi.hoisted(() => ({ createServer: vi.fn(), request: vi.fn() }))
vi.mock('node:https', () => ({ createServer: transport.createServer, request: transport.request }))

import { recoveryArchiveDiscardReceipt, type RecoveryArchiveAbandonedObjectStore } from '../../src/multitable/recovery-archive-abandoned-object-store'
import type { RecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import { createRecoveryArchiveObjectServer } from '../../src/multitable/recovery-archive-object-server'
import { createRecoveryArchiveRemoteObjectStore } from '../../src/multitable/recovery-archive-remote-object-store'
import { decodeRecoveryResourceBase64 } from '../../src/multitable/recovery-resource-https'

const storeId = '11111111-1111-4111-8111-111111111111'
const otherStoreId = '22222222-2222-4222-8222-222222222222'
const generationId = '33333333-3333-4333-8333-333333333333'
const operationId = '44444444-4444-4444-8444-444444444444'
const token = 'synthetic-object-token-'.padEnd(48, 'x')
const expiry = '2026-09-15T00:00:00.000Z'
const now = '2026-10-11T00:00:00.000Z'
const depth = { currentTransactionDepth: () => 0 }
let listener: (req: IncomingMessage, res: ServerResponse) => void
let responseOverride: unknown
const sent: Array<{ path: string; input: unknown }> = []
const services: Array<ReturnType<typeof createRecoveryArchiveObjectServer>> = []

// The actual HTTP codecs run against in-memory streams. No listener, TLS, file
// provider, subprocess, database or remote service is created by this suite.
async function dispatch(path: string, input: unknown): Promise<{ status: number; body: string }> {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    method: 'POST', url: path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawHeaders: ['authorization', `Bearer ${token}`], aborted: false,
  })
  return new Promise(resolve => {
    const response = {
      destroyed: false, writableEnded: false, status: 200,
      writeHead(status: number) { this.status = status; return this },
      end(body: string) { this.writableEnded = true; resolve({ status: this.status, body }); return this },
      destroy() { this.destroyed = true; resolve({ status: 0, body: '' }); return this },
    }
    listener(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  responseOverride = undefined
  transport.createServer.mockImplementation((_options, handler) => {
    listener = handler
    return Object.assign(new EventEmitter(), {
      close(done: () => void) { done() }, closeIdleConnections() {},
    })
  })
  transport.request.mockImplementation((url: string, _options, callback: (res: IncomingMessage) => void) => {
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() { this.destroyed = true; return this },
      end(bytes: Uint8Array) {
        const path = new URL(url).pathname
        const input: unknown = JSON.parse(Buffer.from(bytes).toString())
        sent.push({ path, input })
        queueMicrotask(async () => {
          const wire = responseOverride === undefined ? await dispatch(path, input)
            : { status: 200, body: JSON.stringify(responseOverride) }
          if (request.destroyed) return
          const response = Object.assign(new EventEmitter(), {
            statusCode: wire.status, headers: { 'content-type': 'application/json' },
          })
          callback(response as unknown as IncomingMessage)
          response.emit('data', Buffer.from(wire.body))
          response.emit('end')
        })
        return this
      },
    })
    return request
  })
})
afterEach(async () => { for (const service of services.splice(0)) await service.stop() })

function fixture(bytes = Buffer.from('synthetic-object')) {
  const object = { generationId, objectId: 'a'.repeat(64), version: 'immutable-1',
    sha256: createHash('sha256').update(bytes).digest('hex'), size: String(bytes.length), expiresAt: expiry, pinned: false }
  const expected = { generationId, objectId: object.objectId, expectedVersion: object.version,
    expectedSha256: object.sha256, expectedSize: object.size, expectedExpiresAt: expiry }
  const discard = { ...expected, operationId, storeId }
  const provider = {
    storeId,
    put: vi.fn(async () => ({ outcome: 'created' as const, object })),
    get: vi.fn(async () => ({ ...object, bytes: new Uint8Array(bytes) })),
    head: vi.fn(async () => object),
    pin: vi.fn(async () => ({ ...object, pinned: true })),
    deleteExpired: vi.fn(async () => ({ outcome: 'deleted' as const, object })),
    discard: vi.fn(async () => ({ outcome: 'absent' as const, receiptSha256: recoveryArchiveDiscardReceipt(discard) })),
    status: vi.fn(async () => ({ outcome: 'unknown' as const })),
  } satisfies RecoveryArchiveObjectStoreProvider & RecoveryArchiveAbandonedObjectStore
  services.push(createRecoveryArchiveObjectServer({ provider, token, cert: Buffer.from('mock-cert'),
    key: Buffer.from('mock-key'), maxObjectBytes: 1024, timeoutMs: 1000, transactionDepth: depth }))
  const config = { url: 'https://synthetic.invalid', token, ca: Buffer.from('mock-ca'), storeId,
    maxObjectBytes: 1024, timeoutMs: 1000, transactionDepth: depth }
  return { object, bytes, expected, discard, provider, config, store: createRecoveryArchiveRemoteObjectStore(config) }
}

describe('object resource wire contract with mocked HTTPS', () => {
  test('reads a zero-byte provider object independently of PUT', async () => {
    const f = fixture(Buffer.alloc(0))
    expect(await f.store.get(f.expected)).toEqual({ ...f.object, bytes: new Uint8Array(0) })
    expect(f.provider.get).toHaveBeenCalledWith(f.expected)
  })
  test.each([Buffer.alloc(0), Buffer.from('synthetic-object')])('round trips the exact object bytes (%s)', async bytes => {
    const f = fixture(bytes)
    expect(await f.store.put({ ...f.object, bytes })).toEqual({ outcome: 'created', object: f.object })
    expect(await f.store.get(f.expected)).toEqual({ ...f.object, bytes: new Uint8Array(bytes) })
    expect(f.provider.put).toHaveBeenCalledWith({ ...f.object, bytes: new Uint8Array(bytes) })
    expect(sent).toEqual([
      { path: '/v1/put', input: { storeId, request: { ...f.object, bytes: bytes.toString('base64') } } },
      { path: '/v1/get', input: { storeId, request: f.expected } },
    ])
  })

  test('all seven operations send the closed store envelope', async () => {
    const f = fixture()
    const requests = [
      { ...f.object, bytes: f.bytes.toString('base64') }, f.expected, f.expected, f.expected,
      { ...f.expected, now }, f.discard, f.discard,
    ]
    await f.store.put({ ...f.object, bytes: f.bytes })
    await f.store.get(f.expected)
    await f.store.head(f.expected)
    await f.store.pin(f.expected)
    await f.store.deleteExpired({ ...f.expected, now })
    await f.store.discard(f.discard)
    await f.store.status(f.discard)
    expect(sent.map(entry => entry.input)).toEqual(requests.map(request => ({ storeId, request })))
  })

  test.each(['put', 'get', 'head', 'pin', 'deleteExpired', 'discard', 'status'] as const)('wrong store %s never reaches any provider', async verb => {
    const f = fixture()
    const other = createRecoveryArchiveRemoteObjectStore({ ...f.config, storeId: otherStoreId })
    const run = {
      put: () => other.put({ ...f.object, bytes: f.bytes }), get: () => other.get(f.expected),
      head: () => other.head(f.expected), pin: () => other.pin(f.expected),
      deleteExpired: () => other.deleteExpired({ ...f.expected, now }),
      discard: () => other.discard({ ...f.discard, storeId: otherStoreId }),
      status: () => other.status({ ...f.discard, storeId: otherStoreId }),
    }
    await expect(run[verb]()).rejects.toThrow()
    for (const method of ['put', 'get', 'head', 'pin', 'deleteExpired', 'discard', 'status'] as const) {
      expect(f.provider[method]).not.toHaveBeenCalled()
    }
  })

  test.each(['missing store', 'wrong store', 'extra key', 'missing request', 'null', 'array'])('server refuses %s envelope before provider dispatch', async kind => {
    const f = fixture()
    const input = {
      'missing store': f.expected, 'wrong store': { storeId: otherStoreId, request: f.expected },
      'extra key': { storeId, request: f.expected, extra: true }, 'missing request': { storeId },
      null: null, array: [{ storeId, request: f.expected }],
    }[kind]
    expect(await dispatch('/v1/head', input)).toEqual({ status: 422, body: '{"code":"RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED"}' })
    expect(f.provider.head).not.toHaveBeenCalled()
  })

  test.each(['YQ== ', 'YQ', 'YR==', '!!!!', null, 0])('malformed nonempty PUT base64 %s refuses without provider mutation', async bytes => {
    const f = fixture(Buffer.alloc(0))
    expect((await dispatch('/v1/put', { storeId, request: { ...f.object, bytes } })).status).toBe(422)
    expect(f.provider.put).not.toHaveBeenCalled()
  })

  test.each([{ size: '1' }, { sha256: 'b'.repeat(64) }])('empty PUT still enforces its exact byte binding %s', async changed => {
    const f = fixture(Buffer.alloc(0))
    expect((await dispatch('/v1/put', { storeId, request: { ...f.object, ...changed, bytes: '' } })).status).toBe(422)
    expect(f.provider.put).not.toHaveBeenCalled()
  })

  test.each(['YQ== ', 'YQ', 'YR==', '!!!!', null, 0])('malformed GET bytes %s refuse in the client', async bytes => {
    const f = fixture(Buffer.alloc(0))
    responseOverride = { storeId, result: { ...f.object, bytes } }
    await expect(f.store.get(f.expected)).rejects.toThrow()
  })

  test.each([{ size: '1' }, { sha256: 'b'.repeat(64) }])('empty GET still enforces its exact descriptor binding %s', async changed => {
    const f = fixture(Buffer.alloc(0))
    responseOverride = { storeId, result: { ...f.object, ...changed, bytes: '' } }
    await expect(f.store.get(f.expected)).rejects.toThrow()
  })

  test.each(['discard', 'status'])('matching envelope cannot bypass the existing inner %s store guard', async verb => {
    const f = fixture()
    expect((await dispatch(`/v1/${verb}`, { storeId, request: { ...f.discard, storeId: otherStoreId } })).status).toBe(422)
    expect(f.provider.discard).not.toHaveBeenCalled()
    expect(f.provider.status).not.toHaveBeenCalled()
  })

  test('empty object support does not admit empty shared custody/key base64', () => {
    expect(() => decodeRecoveryResourceBase64('', 1024)).toThrow('RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED')
    expect(decodeRecoveryResourceBase64('YQ==', 1024)).toEqual(Buffer.from('a'))
  })
})
