import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  RecoveryArchiveObjectStoreError,
  createLocalRecoveryArchiveObjectStoreProvider,
  createTransactionGuardedRecoveryArchiveObjectStore,
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
    expectedExpiresAt: request.expiresAt,
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

async function objectStoreErrorOf(run: () => Promise<unknown>): Promise<RecoveryArchiveObjectStoreError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveObjectStoreError)
    return error as RecoveryArchiveObjectStoreError
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
    async deleteExpired() {
      calls.push('deleteExpired')
      return { outcome: 'retained', object }
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
    await expect(store.head(readRequest(first))).resolves.toEqual(descriptorFrom(first))
    await expect(store.get(readRequest(first))).resolves.toEqual({ ...descriptorFrom(first), bytes: new Uint8Array(first.bytes) })
    await expect(store.deleteExpired({ ...readRequest(first), now: '2026-08-27T00:00:00.000Z' })).resolves.toEqual({
      outcome: 'retained',
      object: descriptorFrom(first),
    })
    await expect(store.get(readRequest(first))).resolves.toEqual({ ...descriptorFrom(first), bytes: new Uint8Array(first.bytes) })
    await expect(store.deleteExpired({ ...readRequest(first), now: AFTER_EXPIRY })).resolves.toEqual({
      outcome: 'deleted',
      object: descriptorFrom(first),
    })
    await expect(store.head(readRequest(first))).resolves.toBeNull()

    await expect(store.put(second)).resolves.toMatchObject({ outcome: 'created' })
    await expect(store.pin(readRequest(second))).resolves.toEqual({ ...descriptorFrom(second), pinned: true })
    await expect(store.deleteExpired({ ...readRequest(second), now: AFTER_EXPIRY })).resolves.toEqual({
      outcome: 'retained',
      object: { ...descriptorFrom(second), pinned: true },
    })
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

  test('direct local provider returns existing only for the exact stored byte and metadata binding', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d2e-direct-put-'))
    temporaryRoots.push(root)
    const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root })
    const initial = putRequest(identity())
    const differentBytes = Buffer.from('different-direct-provider-ciphertext', 'utf8')

    await expect(provider.put(initial)).resolves.toEqual({ outcome: 'created', object: descriptorFrom(initial) })
    await expect(provider.put({ ...initial, bytes: new Uint8Array(initial.bytes) })).resolves.toEqual({
      outcome: 'existing',
      object: descriptorFrom(initial),
    })

    const mismatches: RecoveryArchiveObjectPutRequest[] = [
      { ...initial, version: '2' },
      { ...initial, sha256: 'b'.repeat(64) },
      { ...initial, size: String(initial.bytes.byteLength + 1) },
      { ...initial, expiresAt: '2028-08-28T00:00:00.000Z' },
      { ...initial, pinned: true },
      {
        ...initial,
        bytes: differentBytes,
        sha256: digest(differentBytes),
        size: String(differentBytes.byteLength),
      },
    ]
    for (const mismatch of mismatches) {
      await expect(asyncCodeOf(() => provider.put(mismatch))).resolves.toBe(
        'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH',
      )
    }
    await expect(provider.get(readRequest(initial))).resolves.toEqual({
      ...descriptorFrom(initial),
      bytes: new Uint8Array(initial.bytes),
    })
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
    const expected = readRequest(request)
    const deleteRequest: RecoveryArchiveObjectDeleteExpiredRequest = { ...expected, now: AFTER_EXPIRY }
    const calls: Array<(store: ReturnType<typeof createTransactionGuardedRecoveryArchiveObjectStore>) => Promise<unknown>> = [
      (store) => store.put(request),
      (store) => store.get(readRequest(request)),
      (store) => store.head(expected),
      (store) => store.deleteExpired(deleteRequest),
      (store) => store.pin(expected),
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
    await expect(asyncCodeOf(() => createTransactionGuardedRecoveryArchiveObjectStore(createCountingProvider(request), unknownDepth).head(readRequest(request)))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN')
  })

  test('rejects malformed closed request shapes before a provider receives them', async () => {
    const request = putRequest(identity())
    const provider = createCountingProvider(request)
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))
    const malformed = { ...request, unexpected: 'not-permitted' }

    await expect(asyncCodeOf(() => store.put(malformed as unknown as RecoveryArchiveObjectPutRequest))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
    expect(provider.calls).toEqual([])
  })

  test('normalizes caller and provider typed-array proxy traps without leaking values or causes', async () => {
    const request = putRequest(identity())
    const callerProvider = createCountingProvider(request)
    const callerStore = createTransactionGuardedRecoveryArchiveObjectStore(callerProvider, depthProbe(0))
    const callerBytes = new Proxy(new Uint8Array(request.bytes), {
      getPrototypeOf() {
        throw new Error('caller-typed-array-sensitive-value')
      },
    })

    const callerError = await objectStoreErrorOf(() => callerStore.put({ ...request, bytes: callerBytes }))
    expect(callerError).toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST',
      message: 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST',
    })
    expect(callerError.message).not.toContain('sensitive-value')
    expect(Object.prototype.hasOwnProperty.call(callerError, 'cause')).toBe(false)
    expect(callerProvider.calls).toEqual([])

    const provider = createCountingProvider(request)
    const providerBytes = new Proxy(new Uint8Array(request.bytes), {
      getPrototypeOf() {
        throw new Error('provider-typed-array-sensitive-value')
      },
    })
    provider.get = async () => ({ ...descriptorFrom(request), bytes: providerBytes })
    const providerStore = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))

    const providerError = await objectStoreErrorOf(() => providerStore.get(readRequest(request)))
    expect(providerError).toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
      message: 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
    })
    expect(providerError.message).not.toContain('sensitive-value')
    expect(Object.prototype.hasOwnProperty.call(providerError, 'cause')).toBe(false)
  })

  test('normalizes a provider-result reflection trap whose throwable is itself hostile', async () => {
    const request = putRequest(identity())
    const provider = createCountingProvider(request)
    const hostileThrowable = new Proxy(new Error('provider-result-sensitive-value'), {
      getPrototypeOf() {
        throw new Error('provider-result-secondary-sensitive-value')
      },
    })
    const hostileResult = new Proxy(
      { ...descriptorFrom(request), bytes: new Uint8Array(request.bytes) },
      {
        ownKeys() {
          throw hostileThrowable
        },
      },
    )
    provider.get = async () => hostileResult as unknown as RecoveryArchiveObjectReadResult
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))

    const error = await objectStoreErrorOf(() => store.get(readRequest(request)))
    expect(error).toMatchObject({
      code: 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
      message: 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
    })
    expect(error.message).not.toContain('sensitive-value')
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
  })

  test('local provider is explicit test-only and refuses a path escape through resolveWithinBase', async () => {
    expect(codeOf(() => createLocalRecoveryArchiveObjectStoreProvider({
      environment: 'production' as 'test',
      basePath: os.tmpdir(),
    }))).toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_ENVIRONMENT_REFUSED',
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

  test('local provider refuses a symlinked generations parent before any outside write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d2e-symlink-root-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d2e-symlink-outside-'))
    temporaryRoots.push(root, outside)
    await fs.symlink(outside, path.join(root, 'generations'), 'dir')
    const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root })
    const request = putRequest(identity())

    await expect(asyncCodeOf(() => provider.put(request))).resolves.toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED',
    )
    await expect(fs.readdir(outside)).resolves.toEqual([])
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

  test('snapshots caller bindings before a provider can mutate its request', async () => {
    const request = putRequest(identity())
    const foreign = putRequest(identity(), { bytes: Buffer.from('foreign-generation', 'utf8'), pinned: true })

    const provider = createCountingProvider(request)
    provider.get = async (providerRequest) => {
      Object.assign(providerRequest, readRequest(foreign))
      return { ...descriptorFrom(foreign), bytes: new Uint8Array(foreign.bytes) }
    }
    provider.head = async (providerRequest) => {
      Object.assign(providerRequest, readRequest(foreign))
      return descriptorFrom(foreign)
    }
    provider.pin = async (providerRequest) => {
      Object.assign(providerRequest, readRequest(foreign))
      return descriptorFrom(foreign)
    }
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))

    await expect(asyncCodeOf(() => store.get(readRequest(request)))).resolves.toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
    )
    await expect(asyncCodeOf(() => store.head(readRequest(request)))).resolves.toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
    )
    await expect(asyncCodeOf(() => store.pin(readRequest(request)))).resolves.toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
    )
  })

  test('binds expiry across stateless read, pin, and destructive provider verbs', async () => {
    const request = putRequest(identity())
    const drifted = { ...descriptorFrom(request), expiresAt: '2028-08-28T00:00:00.000Z' }
    const provider = createCountingProvider(request)
    provider.get = async () => ({ ...drifted, bytes: new Uint8Array(request.bytes) })
    provider.head = async () => drifted
    provider.pin = async () => ({ ...drifted, pinned: true })
    provider.deleteExpired = async () => ({ outcome: 'deleted', object: drifted })
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))
    const expected = readRequest(request)

    for (const call of [
      () => store.get(expected),
      () => store.head(expected),
      () => store.pin(expected),
      () => store.deleteExpired({ ...expected, now: AFTER_EXPIRY }),
    ]) {
      await expect(asyncCodeOf(call)).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
    }
  })

  test('rejects a provider that reports deleting an unexpired object', async () => {
    const request = putRequest(identity())
    const provider = createCountingProvider(request)
    provider.deleteExpired = async () => ({ outcome: 'deleted', object: descriptorFrom(request) })
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depthProbe(0))

    await expect(asyncCodeOf(() => store.deleteExpired({
      ...readRequest(request),
      now: BEFORE_EXPIRY,
    }))).resolves.toBe('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
  })

  test('requires a requested put pin and serializes local pin before conditional deletion', async () => {
    const pinnedRequest = putRequest(identity(), { pinned: true })
    const unpinnedProvider = createCountingProvider(pinnedRequest)
    unpinnedProvider.put = async () => ({
      outcome: 'created',
      object: { ...descriptorFrom(pinnedRequest), pinned: false },
    })
    const guarded = createTransactionGuardedRecoveryArchiveObjectStore(unpinnedProvider, depthProbe(0))
    await expect(asyncCodeOf(() => guarded.put(pinnedRequest))).resolves.toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH',
    )

    const store = await localStore()
    const expiring = putRequest(identity(), { expiresAt: BEFORE_EXPIRY })
    await store.put(expiring)
    const expected = readRequest(expiring)
    const pinPromise = store.pin(expected)
    const deletePromise = store.deleteExpired({ ...expected, now: AFTER_EXPIRY })
    const [pinResult, deleteResult] = await Promise.all([pinPromise, deletePromise])
    expect(pinResult.pinned).toBe(true)
    expect(deleteResult).toEqual({ outcome: 'retained', object: { ...descriptorFrom(expiring), pinned: true } })
  })

  test('local test provider verifies bytes on head and rejects every non-test runtime environment', async () => {
    for (const environment of ['staging', 'production', 'prod', 'development', '', undefined]) {
      expect(codeOf(() => createLocalRecoveryArchiveObjectStoreProvider({
        environment: environment as 'test',
        basePath: os.tmpdir(),
      }))).toBe('RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_ENVIRONMENT_REFUSED')
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-d2e-head-'))
    temporaryRoots.push(root)
    const store = createTransactionGuardedRecoveryArchiveObjectStore(
      createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root }),
      depthProbe(0),
    )
    const request = putRequest(identity())
    await store.put(request)
    await fs.writeFile(
      path.join(root, 'generations', request.generationId, request.objectId),
      Buffer.from('tampered-on-disk', 'utf8'),
    )
    await expect(asyncCodeOf(() => store.head(readRequest(request)))).resolves.toBe(
      'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED',
    )
  })
})
