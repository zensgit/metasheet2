import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  RecoveryArchiveObjectStoreError,
  createLocalRecoveryArchiveObjectStoreProvider,
  createTransactionGuardedRecoveryArchiveObjectStore,
  type RecoveryArchiveObjectDeleteExpiredOutcome,
  type RecoveryArchiveObjectDeleteExpiredRequest,
  type RecoveryArchiveObjectDescriptor,
  type RecoveryArchiveObjectIdentity,
  type RecoveryArchiveObjectPutRequest,
  type RecoveryArchiveObjectReadRequest,
  type RecoveryArchiveObjectReadResult,
  type RecoveryArchiveObjectStoreProvider,
} from '../../src/multitable/recovery-archive-object-store'
import type { RecoveryArchiveTransactionDepthProbe } from '../../src/multitable/recovery-archive-crypto'

const BEFORE_EXPIRY = '2026-08-28T00:00:00.000Z'
const AFTER_EXPIRY = '2026-08-30T00:00:00.000Z'
const FUTURE_EXPIRY = '2027-08-28T00:00:00.000Z'
const OBJECT_ID = 'a'.repeat(64)
const BYTES = Buffer.from('sealed-generation-scoped-object', 'utf8')

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function identity(generationId = randomUUID(), objectId = OBJECT_ID): RecoveryArchiveObjectIdentity {
  return { generationId, objectId }
}

function putRequest(
  objectIdentity = identity(),
  overrides: Partial<RecoveryArchiveObjectPutRequest> = {},
): RecoveryArchiveObjectPutRequest {
  const bytes = overrides.bytes ?? BYTES
  return {
    generationId: objectIdentity.generationId,
    objectId: objectIdentity.objectId,
    version: '1',
    sha256: digest(bytes),
    size: String(bytes.byteLength),
    expiresAt: FUTURE_EXPIRY,
    pinned: false,
    bytes,
    ...overrides,
  }
}

function readRequest(request: RecoveryArchiveObjectPutRequest): RecoveryArchiveObjectReadRequest {
  return {
    generationId: request.generationId,
    objectId: request.objectId,
    expectedVersion: request.version,
    expectedSha256: request.sha256,
    expectedSize: request.size,
  }
}

function depthProbe(...depths: number[]): RecoveryArchiveTransactionDepthProbe & { calls: number } {
  let index = 0
  return {
    get calls() {
      return index
    },
    currentTransactionDepth() {
      const depth = depths[Math.min(index, depths.length - 1)]
      index += 1
      return depth
    },
  }
}

async function localStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d2e-object-store-'))
  temporaryRoots.push(root)
  return createTransactionGuardedRecoveryArchiveObjectStore(
    createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root }),
    depthProbe(0),
  )
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveObjectStoreError)
    return (error as RecoveryArchiveObjectStoreError).code
  }
  throw new Error('expected_recovery_archive_object_store_refusal')
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveObjectStoreError)
    return (error as RecoveryArchiveObjectStoreError).code
  }
  throw new Error('expected_recovery_archive_object_store_refusal')
}

function descriptorFrom(request: RecoveryArchiveObjectPutRequest): RecoveryArchiveObjectDescriptor {
  const { bytes: _, ...descriptor } = request
  return descriptor
}

function createCountingProvider(request: RecoveryArchiveObjectPutRequest): RecoveryArchiveObjectStoreProvider & { calls: string[] } {
  const object = descriptorFrom(request)
  const calls: string[] = []
  return {
    calls,
    async put() {
      calls.push('put')
      return { outcome: 'created', object }
    },
    async get() {
      calls.push('get')
      return { ...object, bytes: new Uint8Array(request.bytes) }
    },
    async head() {
      calls.push('head')
      return object
    },
    async deleteExpired(): Promise<RecoveryArchiveObjectDeleteExpiredOutcome> {
      calls.push('deleteExpired')
      return 'retained'
    },
    async pin() {
      calls.push('pin')
      return { ...object, pinned: true }
    },
  }
}

describe('Phase D2e RecoveryArchiveObjectStore', () => {
  test('covers put/get/head/deleteExpired/pin with generation-scoped, immutable objects', async () => {
    const store = await localStore()
    const first = putRequest(identity(), { expiresAt: BEFORE_EXPIRY })
    const second = putRequest(identity(), { expiresAt: BEFORE_EXPIRY })

    await expect(store.put(first)).resolves.toMatchObject({ outcome: 'created', object: descriptorFrom(first) })
    await expect(store.put(first)).resolves.toMatchObject({ outcome: 'existing', object: descriptorFrom(first) })
    await expect(store.head(identity(first.generationId, first.objectId))).resolves.toEqual(descriptorFrom(first))
    await expect(store.get(readRequest(first))).resolves.toEqual({ ...descriptorFrom(first), bytes: new Uint8Array(first.bytes) })
    await expect(store.deleteExpired({ generationId: first.generationId, objectId: first.objectId, now: AFTER_EXPIRY })).resolves.toBe('deleted')
    await expect(store.head(identity(first.generationId, first.objectId))).resolves.toBeNull()

    await expect(store.put(second)).resolves.toMatchObject({ outcome: 'created' })
    await expect(store.pin(identity(second.generationId, second.objectId))).resolves.toEqual({ ...descriptorFrom(second), pinned: true })
    await expect(store.deleteExpired({ generationId: second.generationId, objectId: second.objectId, now: AFTER_EXPIRY })).resolves.toBe('retained')
    await expect(store.get(readRequest(second))).resolves.toEqual({ ...descriptorFrom(second), pinned: true, bytes: new Uint8Array(second.bytes) })
  })

  test('isolates the same logical object id across different archive generations', async () => {
    const store = await localStore()
    const first = putRequest(identity(randomUUID(), OBJECT_ID))
    const second = putRequest(identity(randomUUID(), OBJECT_ID), { bytes: Buffer.from('independent-generation', 'utf8') })

    await expect(store.put(first)).resolves.toMatchObject({ outcome: 'created' })
    await expect(store.put(second)).resolves.toMatchObject({ outcome: 'created' })
    await expect(store.get(readRequest(first))).resolves.toMatchObject({ bytes: new Uint8Array(first.bytes) })
    await expect(store.get(readRequest(second))).resolves.toMatchObject({ bytes: new Uint8Array(second.bytes) })
  })

  test('accepts zero-byte objects and opaque immutable provider versions', async () => {
    const store = await localStore()
    const empty = Buffer.alloc(0)
    const request = putRequest(identity(), {
      bytes: empty,
      version: 'opaque-version+/=',
      sha256: digest(empty),
      size: '0',
    })

    await expect(store.put(request)).resolves.toEqual({ outcome: 'created', object: descriptorFrom(request) })
    await expect(store.get(readRequest(request))).resolves.toEqual({
      ...descriptorFrom(request),
      bytes: new Uint8Array(empty),
    })
  })

  test('refuses an immutable version or byte/hash replacement for one identity', async () => {
    const store = await localStore()
    const initial = putRequest(identity())
    const changedBytes = putRequest({ generationId: initial.generationId, objectId: initial.objectId }, {
      bytes: Buffer.from('different-ciphertext', 'utf8'),
    })
    const changedVersion = putRequest({ generationId: initial.generationId, objectId: initial.objectId }, {
      version: '2',
    })

    await store.put(initial)
    await expect(asyncCodeOf(() => store.put(changedBytes))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
    await expect(asyncCodeOf(() => store.put(changedVersion))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
  })

  test('rejects provider result drift and normalizes provider text into a values-free code', async () => {
    const request = putRequest(identity())
    const driftProvider = createCountingProvider(request)
    driftProvider.put = async () => ({ outcome: 'created', object: { ...descriptorFrom(request), version: '2' } })
    const driftStore = createTransactionGuardedRecoveryArchiveObjectStore(driftProvider, depthProbe(0))
    await expect(asyncCodeOf(() => driftStore.put(request))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')

    const throwingProvider = createCountingProvider(request)
    throwingProvider.get = async () => {
      throw new Error('provider://host/internal/path/secret')
    }
    const throwingStore = createTransactionGuardedRecoveryArchiveObjectStore(throwingProvider, depthProbe(0))
    try {
      await throwingStore.get(readRequest(request))
      throw new Error('expected_provider_refusal')
    } catch (error) {
      expect(error).toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED' })
      expect((error as Error).message).not.toContain('provider://')
      expect((error as Error).message).not.toContain('secret')
      expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
    }
  })

  test('refuses each provider verb before it is reached whenever a transaction is open', async () => {
    const request = putRequest(identity())
    const objectIdentity = identity(request.generationId, request.objectId)
    const deleteRequest: RecoveryArchiveObjectDeleteExpiredRequest = { ...objectIdentity, now: AFTER_EXPIRY }
    const calls: Array<(store: ReturnType<typeof createTransactionGuardedRecoveryArchiveObjectStore>) => Promise<unknown>> = [
      (store) => store.put(request),
      (store) => store.get(readRequest(request)),
      (store) => store.head(objectIdentity),
      (store) => store.deleteExpired(deleteRequest),
      (store) => store.pin(objectIdentity),
    ]

    for (const call of calls) {
      const provider = createCountingProvider(request)
      const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(1))
      await expect(asyncCodeOf(() => call(store))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_CALL_IN_TRANSACTION')
      expect(provider.calls).toEqual([])
    }

    const unknownDepth = {
      currentTransactionDepth() {
        throw new Error('unreadable')
      },
    }
    await expect(asyncCodeOf(() => createTransactionGuardedRecoveryArchiveObjectStore(createCountingProvider(request), unknownDepth).head(request))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN')
  })

  test('rejects malformed closed request shapes before a provider receives them', async () => {
    const request = putRequest(identity())
    const provider = createCountingProvider(request)
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))
    const malformed = { ...request, unexpected: 'not-permitted' }

    await expect(asyncCodeOf(() => store.put(malformed as unknown as RecoveryArchiveObjectPutRequest))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
    expect(provider.calls).toEqual([])
  })

  test('local provider is explicit test/staging only and refuses a path escape through resolveWithinBase', async () => {
    expect(codeOf(() => createLocalRecoveryArchiveObjectStoreProvider({ environment: 'production', basePath: os.tmpdir() }))).toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_PRODUCTION_REFUSED',
    )

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d2e-path-'))
    temporaryRoots.push(root)
    const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root })
    const escapedDirectory = `tm-d2e-escape-${randomUUID()}`
    const escapedPath = path.join(os.tmpdir(), escapedDirectory, OBJECT_ID)
    const escaped = putRequest({ generationId: `../../${escapedDirectory}`, objectId: OBJECT_ID })
    try {
      await expect(asyncCodeOf(() => provider.put(escaped))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED')
      await expect(fs.access(escapedPath)).rejects.toThrow()
    } finally {
      await fs.rm(path.join(os.tmpdir(), escapedDirectory), { recursive: true, force: true })
    }
  })

  test('provider output must keep the exact bound identity and bytes', async () => {
    const request = putRequest(identity())
    const provider = createCountingProvider(request)
    provider.get = async (): Promise<RecoveryArchiveObjectReadResult> => ({
      ...descriptorFrom(request),
      bytes: Buffer.from('tampered-provider-bytes', 'utf8'),
    })
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))

    await expect(asyncCodeOf(() => store.get(readRequest(request)))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
  })
})
