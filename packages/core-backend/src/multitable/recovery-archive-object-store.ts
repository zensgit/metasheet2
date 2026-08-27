/**
 * Time Machine Phase D2e only: backend-neutral archive object-store boundary.
 *
 * This module has no production caller. It owns neither an archive catalog nor a lifecycle worker;
 * callers must persist the returned bindings in their own authoritative transaction. The only
 * promise made here is that external object-store I/O is impossible while the supplied database
 * transaction-depth probe reports an open or unknown transaction.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  assertCanonicalNonnegativeDecimalString,
  assertLowercaseSha256Hex,
} from './recovery-archive-contract'
import {
  isRecoveryArchiveUtcTimestamp,
  type RecoveryArchiveTransactionDepthProbe,
} from './recovery-archive-crypto'
import { resolveWithinBase } from '../services/StorageService'

const RECOVERY_ARCHIVE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/
const RECOVERY_ARCHIVE_GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type RecoveryArchiveObjectStoreErrorCode =
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_CALL_IN_TRANSACTION'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_PRODUCTION_REFUSED'
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED'

/** Values-free object-store failure surface. It deliberately carries no provider cause. */
export class RecoveryArchiveObjectStoreError extends Error {
  readonly code: RecoveryArchiveObjectStoreErrorCode

  constructor(code: RecoveryArchiveObjectStoreErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveObjectStoreError'
    this.code = code
  }
}

export interface RecoveryArchiveObjectIdentity {
  /** Canonical lowercase UUID, never a URI or provider key. */
  generationId: string
  /** Canonical SHA-256-derived logical object id, scoped by generationId. */
  objectId: string
}

export interface RecoveryArchiveObjectDescriptor extends RecoveryArchiveObjectIdentity {
  version: string
  sha256: string
  size: string
  expiresAt: string
  pinned: boolean
}

export interface RecoveryArchiveObjectPutRequest extends RecoveryArchiveObjectDescriptor {
  bytes: Uint8Array
}

export interface RecoveryArchiveObjectReadRequest extends RecoveryArchiveObjectIdentity {
  expectedVersion: string
  expectedSha256: string
  expectedSize: string
}

export interface RecoveryArchiveObjectDeleteExpiredRequest extends RecoveryArchiveObjectIdentity {
  now: string
}

export type RecoveryArchiveObjectPutOutcome = 'created' | 'existing'
export type RecoveryArchiveObjectDeleteExpiredOutcome = 'deleted' | 'retained'

export interface RecoveryArchiveObjectReadResult extends RecoveryArchiveObjectDescriptor {
  bytes: Uint8Array
}

export interface RecoveryArchiveObjectPutResult {
  outcome: RecoveryArchiveObjectPutOutcome
  object: RecoveryArchiveObjectDescriptor
}

/**
 * Closed public boundary used by future D-H2 capture/finalize code. Every method performs a fresh
 * transaction-depth check before it can reach its provider.
 */
export interface RecoveryArchiveObjectStore {
  put(request: RecoveryArchiveObjectPutRequest): Promise<RecoveryArchiveObjectPutResult>
  get(request: RecoveryArchiveObjectReadRequest): Promise<RecoveryArchiveObjectReadResult>
  head(identity: RecoveryArchiveObjectIdentity): Promise<RecoveryArchiveObjectDescriptor | null>
  deleteExpired(request: RecoveryArchiveObjectDeleteExpiredRequest): Promise<RecoveryArchiveObjectDeleteExpiredOutcome>
  pin(identity: RecoveryArchiveObjectIdentity): Promise<RecoveryArchiveObjectDescriptor>
}

/**
 * Provider seam. Implementations must use exclusive-create semantics: a repeated put returns
 * `existing` only when the immutable descriptor is exact; it may never replace existing bytes.
 */
export interface RecoveryArchiveObjectStoreProvider {
  put(request: RecoveryArchiveObjectPutRequest): Promise<RecoveryArchiveObjectPutResult>
  get(request: RecoveryArchiveObjectReadRequest): Promise<RecoveryArchiveObjectReadResult>
  head(identity: RecoveryArchiveObjectIdentity): Promise<RecoveryArchiveObjectDescriptor | null>
  deleteExpired(request: RecoveryArchiveObjectDeleteExpiredRequest): Promise<RecoveryArchiveObjectDeleteExpiredOutcome>
  pin(identity: RecoveryArchiveObjectIdentity): Promise<RecoveryArchiveObjectDescriptor>
}

export type RecoveryArchiveLocalObjectStoreEnvironment = 'test' | 'staging' | 'production'

interface BoundObject {
  version: string
  sha256: string
  size: string
  expiresAt: string
}

function fail(code: RecoveryArchiveObjectStoreErrorCode): never {
  throw new RecoveryArchiveObjectStoreError(code)
}

function identityKey(identity: RecoveryArchiveObjectIdentity): string {
  return `${identity.generationId}/${identity.objectId}`
}

function objectStorageKey(identity: RecoveryArchiveObjectIdentity): string {
  return `generations/${identity.generationId}/${identity.objectId}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

function readExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  let descriptors: Record<string, PropertyDescriptor>
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  const actualKeys = Object.keys(descriptors).sort()
  const expectedKeys = [...keys].sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  const result: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
    result[key] = descriptor.value
  }
  return result
}

function readProviderExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!isPlainRecord(value)) fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actualKeys = Object.keys(descriptors).sort()
    const expectedKeys = [...keys].sort()
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
    }
    const result: Record<string, unknown> = {}
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor)) fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof RecoveryArchiveObjectStoreError) throw error
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
  }
}

function assertIdentity(identity: unknown, result = false): asserts identity is RecoveryArchiveObjectIdentity {
  const read = result
    ? readProviderExactRecord(identity, ['generationId', 'objectId'])
    : readExactRecord(identity, ['generationId', 'objectId'])
  if (
    typeof read.generationId !== 'string' ||
    typeof read.objectId !== 'string' ||
    !RECOVERY_ARCHIVE_GENERATION_ID_PATTERN.test(read.generationId) ||
    !RECOVERY_ARCHIVE_OBJECT_ID_PATTERN.test(read.objectId)
  ) {
    fail(result ? 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT' : 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
}

function parseDescriptor(value: unknown, result = false): RecoveryArchiveObjectDescriptor {
  const read = result
    ? readProviderExactRecord(value, ['expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
    : readExactRecord(value, ['expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
  try {
    assertIdentity({ generationId: read.generationId, objectId: read.objectId }, result)
    assertLowercaseSha256Hex(read.sha256)
    assertCanonicalNonnegativeDecimalString(read.size)
  } catch {
    fail(result ? 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT' : 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  if (
    typeof read.version !== 'string' ||
    read.version.trim().length === 0 ||
    typeof read.expiresAt !== 'string' ||
    !isRecoveryArchiveUtcTimestamp(read.expiresAt) ||
    typeof read.pinned !== 'boolean'
  ) {
    fail(result ? 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT' : 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  return {
    generationId: read.generationId as string,
    objectId: read.objectId as string,
    version: read.version as string,
    sha256: read.sha256 as string,
    size: read.size as string,
    expiresAt: read.expiresAt,
    pinned: read.pinned,
  }
}

function assertDescriptor(value: unknown, result = false): asserts value is RecoveryArchiveObjectDescriptor {
  parseDescriptor(value, result)
}

function assertPutRequest(value: unknown): asserts value is RecoveryArchiveObjectPutRequest {
  const read = readExactRecord(value, ['bytes', 'expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
  assertDescriptor({
    expiresAt: read.expiresAt,
    generationId: read.generationId,
    objectId: read.objectId,
    pinned: read.pinned,
    sha256: read.sha256,
    size: read.size,
    version: read.version,
  })
  if (!(read.bytes instanceof Uint8Array)) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
}

function assertReadRequest(value: unknown): asserts value is RecoveryArchiveObjectReadRequest {
  const read = readExactRecord(value, ['expectedSha256', 'expectedSize', 'expectedVersion', 'generationId', 'objectId'])
  assertIdentity({ generationId: read.generationId, objectId: read.objectId })
  try {
    assertLowercaseSha256Hex(read.expectedSha256)
    assertCanonicalNonnegativeDecimalString(read.expectedSize)
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  if (typeof read.expectedVersion !== 'string' || read.expectedVersion.trim().length === 0) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
}

function assertDeleteExpiredRequest(value: unknown): asserts value is RecoveryArchiveObjectDeleteExpiredRequest {
  const read = readExactRecord(value, ['generationId', 'now', 'objectId'])
  assertIdentity({ generationId: read.generationId, objectId: read.objectId })
  if (typeof read.now !== 'string' || !isRecoveryArchiveUtcTimestamp(read.now)) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
}

function byteBinding(bytes: Uint8Array): { sha256: string; size: string } {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: String(bytes.byteLength),
  }
}

function sameBinding(left: BoundObject, right: BoundObject): boolean {
  return left.version === right.version && left.sha256 === right.sha256 && left.size === right.size && left.expiresAt === right.expiresAt
}

function bindingOf(object: RecoveryArchiveObjectDescriptor): BoundObject {
  return {
    version: object.version,
    sha256: object.sha256,
    size: object.size,
    expiresAt: object.expiresAt,
  }
}

function assertSameIdentity(left: RecoveryArchiveObjectIdentity, right: RecoveryArchiveObjectIdentity, result = true): void {
  if (left.generationId !== right.generationId || left.objectId !== right.objectId) {
    fail(result ? 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT' : 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
}

function assertOutsideTransaction(probe: RecoveryArchiveTransactionDepthProbe): void {
  let depth: unknown
  try {
    depth = probe.currentTransactionDepth()
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN')
  }
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN')
  }
  if (depth !== 0) fail('RECOVERY_ARCHIVE_OBJECT_STORE_CALL_IN_TRANSACTION')
}

async function callProvider<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
  }
}

function copyDescriptor(object: RecoveryArchiveObjectDescriptor): RecoveryArchiveObjectDescriptor {
  return {
    generationId: object.generationId,
    objectId: object.objectId,
    version: object.version,
    sha256: object.sha256,
    size: object.size,
    expiresAt: object.expiresAt,
    pinned: object.pinned,
  }
}

/** Harden a provider with closed-shape/result checks and a depth assertion before every verb. */
export function createTransactionGuardedRecoveryArchiveObjectStore(
  provider: RecoveryArchiveObjectStoreProvider,
  transactionDepth: RecoveryArchiveTransactionDepthProbe,
): RecoveryArchiveObjectStore {
  const bindings = new Map<string, BoundObject>()
  const pinned = new Set<string>()

  function remember(object: RecoveryArchiveObjectDescriptor): void {
    const key = identityKey(object)
    const binding = bindingOf(object)
    const previous = bindings.get(key)
    if (previous && !sameBinding(previous, binding)) {
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
    }
    bindings.set(key, binding)
    if (object.pinned) pinned.add(key)
  }

  return {
    async put(request) {
      assertOutsideTransaction(transactionDepth)
      assertPutRequest(request)
      const bytes = new Uint8Array(request.bytes)
      const actual = byteBinding(bytes)
      if (actual.sha256 !== request.sha256 || actual.size !== request.size) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      const key = identityKey(request)
      const previous = bindings.get(key)
      if (previous && !sameBinding(previous, bindingOf(request))) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      const result = await callProvider(() => provider.put({ ...request, bytes }))
      const read = readProviderExactRecord(result, ['object', 'outcome'])
      if (read.outcome !== 'created' && read.outcome !== 'existing') {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      }
      const object = parseDescriptor(read.object, true)
      assertSameIdentity(request, object)
      if (!sameBinding(bindingOf(request), bindingOf(object)) || (previous && read.outcome !== 'existing')) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      remember(object)
      return { outcome: read.outcome, object: copyDescriptor(object) }
    },

    async get(request) {
      assertOutsideTransaction(transactionDepth)
      assertReadRequest(request)
      const result = await callProvider(() => provider.get(request))
      const read = readProviderExactRecord(result, ['bytes', 'expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
      const object = parseDescriptor({
        generationId: read.generationId,
        objectId: read.objectId,
        version: read.version,
        sha256: read.sha256,
        size: read.size,
        expiresAt: read.expiresAt,
        pinned: read.pinned,
      }, true)
      if (!(read.bytes instanceof Uint8Array)) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      }
      assertSameIdentity(request, object)
      if (object.version !== request.expectedVersion || object.sha256 !== request.expectedSha256 || object.size !== request.expectedSize) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      const actual = byteBinding(read.bytes)
      if (actual.sha256 !== object.sha256 || actual.size !== object.size) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      remember(object)
      return { ...copyDescriptor(object), bytes: new Uint8Array(read.bytes) }
    },

    async head(identity) {
      assertOutsideTransaction(transactionDepth)
      assertIdentity(identity)
      const object = await callProvider(() => provider.head(identity))
      if (object === null) return null
      assertDescriptor(object, true)
      assertSameIdentity(identity, object)
      remember(object)
      return copyDescriptor(object)
    },

    async deleteExpired(request) {
      assertOutsideTransaction(transactionDepth)
      assertDeleteExpiredRequest(request)
      const key = identityKey(request)
      if (pinned.has(key)) return 'retained'
      const outcome = await callProvider(() => provider.deleteExpired(request))
      if (outcome !== 'deleted' && outcome !== 'retained') {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      }
      if (outcome === 'deleted') bindings.delete(key)
      return outcome
    },

    async pin(identity) {
      assertOutsideTransaction(transactionDepth)
      assertIdentity(identity)
      const object = await callProvider(() => provider.pin(identity))
      assertDescriptor(object, true)
      assertSameIdentity(identity, object)
      if (!object.pinned) fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      remember(object)
      return copyDescriptor(object)
    },
  }
}

/**
 * Test/staging-only local implementation. It exists to exercise the adapter boundary, never to
 * satisfy production durability requirements. Its in-memory metadata is intentionally not a D3
 * catalog substitute.
 */
export function createLocalRecoveryArchiveObjectStoreProvider(options: {
  environment: RecoveryArchiveLocalObjectStoreEnvironment
  basePath: string
}): RecoveryArchiveObjectStoreProvider {
  if (options.environment === 'production') {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_PRODUCTION_REFUSED')
  }
  const basePath = path.resolve(options.basePath)
  const objects = new Map<string, RecoveryArchiveObjectDescriptor>()

  function containedPath(identity: RecoveryArchiveObjectIdentity): string {
    try {
      return resolveWithinBase(basePath, objectStorageKey(identity))
    } catch {
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED')
    }
  }

  return {
    async put(request) {
      const key = identityKey(request)
      const existing = objects.get(key)
      if (existing) {
        return { outcome: 'existing', object: copyDescriptor(existing) }
      }
      const fullPath = containedPath(request)
      try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true })
        await fs.writeFile(fullPath, request.bytes, { flag: 'wx' })
      } catch {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
      }
      const object = copyDescriptor(request)
      objects.set(key, object)
      return { outcome: 'created', object: copyDescriptor(object) }
    },

    async get(request) {
      const object = objects.get(identityKey(request))
      if (!object) fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
      const fullPath = containedPath(object)
      try {
        return { ...copyDescriptor(object), bytes: new Uint8Array(await fs.readFile(fullPath)) }
      } catch {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
      }
    },

    async head(identity) {
      const object = objects.get(identityKey(identity))
      return object ? copyDescriptor(object) : null
    },

    async deleteExpired(request) {
      const key = identityKey(request)
      const object = objects.get(key)
      if (!object || object.pinned || object.expiresAt > request.now) return 'retained'
      const fullPath = containedPath(object)
      try {
        await fs.unlink(fullPath)
      } catch {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
      }
      objects.delete(key)
      return 'deleted'
    },

    async pin(identity) {
      const object = objects.get(identityKey(identity))
      if (!object) fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
      const pinnedObject = { ...object, pinned: true }
      objects.set(identityKey(identity), pinnedObject)
      return copyDescriptor(pinnedObject)
    },
  }
}
