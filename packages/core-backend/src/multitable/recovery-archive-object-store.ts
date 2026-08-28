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
  | 'RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_ENVIRONMENT_REFUSED'
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

class RecoveryArchiveLocalBindingMismatchError extends RecoveryArchiveObjectStoreError {
  constructor() {
    super('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
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

export interface RecoveryArchiveObjectExpectedBinding extends RecoveryArchiveObjectIdentity {
  expectedVersion: string
  expectedSha256: string
  expectedSize: string
  expectedExpiresAt: string
}

export type RecoveryArchiveObjectReadRequest = RecoveryArchiveObjectExpectedBinding
export type RecoveryArchiveObjectHeadRequest = RecoveryArchiveObjectExpectedBinding
export type RecoveryArchiveObjectPinRequest = RecoveryArchiveObjectExpectedBinding

export interface RecoveryArchiveObjectDeleteExpiredRequest extends RecoveryArchiveObjectExpectedBinding {
  now: string
}

export type RecoveryArchiveObjectPutOutcome = 'created' | 'existing'
export interface RecoveryArchiveObjectReadResult extends RecoveryArchiveObjectDescriptor {
  bytes: Uint8Array
}

export interface RecoveryArchiveObjectPutResult {
  outcome: RecoveryArchiveObjectPutOutcome
  object: RecoveryArchiveObjectDescriptor
}

export type RecoveryArchiveObjectDeleteExpiredResult =
  | { outcome: 'deleted'; object: RecoveryArchiveObjectDescriptor }
  | { outcome: 'retained'; object: RecoveryArchiveObjectDescriptor | null }

/**
 * Closed public boundary used by future D-H2 capture/finalize code. Every method performs a fresh
 * transaction-depth check before it can reach its provider.
 */
export interface RecoveryArchiveObjectStore {
  put(request: RecoveryArchiveObjectPutRequest): Promise<RecoveryArchiveObjectPutResult>
  get(request: RecoveryArchiveObjectReadRequest): Promise<RecoveryArchiveObjectReadResult>
  head(request: RecoveryArchiveObjectHeadRequest): Promise<RecoveryArchiveObjectDescriptor | null>
  deleteExpired(request: RecoveryArchiveObjectDeleteExpiredRequest): Promise<RecoveryArchiveObjectDeleteExpiredResult>
  pin(request: RecoveryArchiveObjectPinRequest): Promise<RecoveryArchiveObjectDescriptor>
}

/**
 * Provider seam. Implementations must use exclusive-create semantics: a repeated put returns
 * `existing` only when the immutable descriptor is exact; it may never replace existing bytes.
 * Pin and conditional delete are atomic provider operations over the same exact binding. Every
 * concrete provider needs its own concurrency acceptance gate; process-local wrapper state is not
 * authority for a multi-process store.
 */
export interface RecoveryArchiveObjectStoreProvider {
  put(request: RecoveryArchiveObjectPutRequest): Promise<RecoveryArchiveObjectPutResult>
  get(request: RecoveryArchiveObjectReadRequest): Promise<RecoveryArchiveObjectReadResult>
  head(request: RecoveryArchiveObjectHeadRequest): Promise<RecoveryArchiveObjectDescriptor | null>
  /** Atomically delete only the exact expected binding when it is both expired and unpinned. */
  deleteExpired(request: RecoveryArchiveObjectDeleteExpiredRequest): Promise<RecoveryArchiveObjectDeleteExpiredResult>
  /** Atomically pin only the exact expected binding. A successful pin and delete may never both win. */
  pin(request: RecoveryArchiveObjectPinRequest): Promise<RecoveryArchiveObjectDescriptor>
}

export type RecoveryArchiveLocalObjectStoreEnvironment = 'test'

interface BoundObject {
  version: string
  sha256: string
  size: string
  expiresAt: string
}

function fail(code: RecoveryArchiveObjectStoreErrorCode): never {
  throw new RecoveryArchiveObjectStoreError(code)
}

function failLocalBindingMismatch(): never {
  throw new RecoveryArchiveLocalBindingMismatchError()
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
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
  }
}

function copyUint8Array(value: unknown, result = false): Uint8Array {
  try {
    if (value instanceof Uint8Array) return new Uint8Array(value)
  } catch {
    // Normalize hostile typed-array proxies below.
  }
  fail(result ? 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT' : 'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
}

function parseIdentity(identity: unknown, result = false): RecoveryArchiveObjectIdentity {
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
  return { generationId: read.generationId, objectId: read.objectId }
}

function parseDescriptor(value: unknown, result = false): RecoveryArchiveObjectDescriptor {
  const read = result
    ? readProviderExactRecord(value, ['expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
    : readExactRecord(value, ['expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
  const identity = parseIdentity({ generationId: read.generationId, objectId: read.objectId }, result)
  try {
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
    ...identity,
    version: read.version as string,
    sha256: read.sha256 as string,
    size: read.size as string,
    expiresAt: read.expiresAt,
    pinned: read.pinned,
  }
}

function parsePutRequest(value: unknown): RecoveryArchiveObjectPutRequest {
  const read = readExactRecord(value, ['bytes', 'expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version'])
  const descriptor = parseDescriptor({
    expiresAt: read.expiresAt,
    generationId: read.generationId,
    objectId: read.objectId,
    pinned: read.pinned,
    sha256: read.sha256,
    size: read.size,
    version: read.version,
  })
  return { ...descriptor, bytes: copyUint8Array(read.bytes) }
}

function parseExpectedBinding(value: unknown): RecoveryArchiveObjectExpectedBinding {
  const read = readExactRecord(value, [
    'expectedExpiresAt',
    'expectedSha256',
    'expectedSize',
    'expectedVersion',
    'generationId',
    'objectId',
  ])
  const identity = parseIdentity({ generationId: read.generationId, objectId: read.objectId })
  try {
    assertLowercaseSha256Hex(read.expectedSha256)
    assertCanonicalNonnegativeDecimalString(read.expectedSize)
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  if (
    typeof read.expectedVersion !== 'string' ||
    read.expectedVersion.trim().length === 0 ||
    typeof read.expectedExpiresAt !== 'string' ||
    !isRecoveryArchiveUtcTimestamp(read.expectedExpiresAt)
  ) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  return {
    ...identity,
    expectedVersion: read.expectedVersion,
    expectedSha256: read.expectedSha256 as string,
    expectedSize: read.expectedSize as string,
    expectedExpiresAt: read.expectedExpiresAt,
  }
}

function parseDeleteExpiredRequest(value: unknown): RecoveryArchiveObjectDeleteExpiredRequest {
  const read = readExactRecord(value, [
    'expectedExpiresAt',
    'expectedSha256',
    'expectedSize',
    'expectedVersion',
    'generationId',
    'now',
    'objectId',
  ])
  const expected = parseExpectedBinding({
    generationId: read.generationId,
    objectId: read.objectId,
    expectedVersion: read.expectedVersion,
    expectedSha256: read.expectedSha256,
    expectedSize: read.expectedSize,
    expectedExpiresAt: read.expectedExpiresAt,
  })
  if (typeof read.now !== 'string' || !isRecoveryArchiveUtcTimestamp(read.now)) {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST')
  }
  return { ...expected, now: read.now }
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

function expectedBindingMatches(
  expected: RecoveryArchiveObjectExpectedBinding,
  object: RecoveryArchiveObjectDescriptor,
): boolean {
  return (
    object.version === expected.expectedVersion &&
    object.sha256 === expected.expectedSha256 &&
    object.size === expected.expectedSize &&
    object.expiresAt === expected.expectedExpiresAt
  )
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
  } catch (error) {
    let localBindingMismatch = false
    try {
      localBindingMismatch = error instanceof RecoveryArchiveLocalBindingMismatchError
    } catch {
      // Normalize hostile provider throws below.
    }
    if (localBindingMismatch) fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
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
  return {
    async put(request) {
      assertOutsideTransaction(transactionDepth)
      const expected = parsePutRequest(request)
      const actual = byteBinding(expected.bytes)
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      const result = await callProvider(() => provider.put({ ...expected, bytes: new Uint8Array(expected.bytes) }))
      const read = readProviderExactRecord(result, ['object', 'outcome'])
      if (read.outcome !== 'created' && read.outcome !== 'existing') {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      }
      const object = parseDescriptor(read.object, true)
      assertSameIdentity(expected, object)
      if (!sameBinding(bindingOf(expected), bindingOf(object)) || (expected.pinned && !object.pinned)) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      return { outcome: read.outcome, object: copyDescriptor(object) }
    },

    async get(request) {
      assertOutsideTransaction(transactionDepth)
      const expected = parseExpectedBinding(request)
      const result = await callProvider(() => provider.get({ ...expected }))
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
      const bytes = copyUint8Array(read.bytes, true)
      assertSameIdentity(expected, object)
      if (!expectedBindingMatches(expected, object)) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      const actual = byteBinding(bytes)
      if (actual.sha256 !== object.sha256 || actual.size !== object.size) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      return { ...copyDescriptor(object), bytes }
    },

    async head(request) {
      assertOutsideTransaction(transactionDepth)
      const expected = parseExpectedBinding(request)
      const object = await callProvider(() => provider.head({ ...expected }))
      if (object === null) return null
      const descriptor = parseDescriptor(object, true)
      assertSameIdentity(expected, descriptor)
      if (!expectedBindingMatches(expected, descriptor)) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      return copyDescriptor(descriptor)
    },

    async deleteExpired(request) {
      assertOutsideTransaction(transactionDepth)
      const expected = parseDeleteExpiredRequest(request)
      const result = await callProvider(() => provider.deleteExpired({ ...expected }))
      const read = readProviderExactRecord(result, ['object', 'outcome'])
      if (read.outcome !== 'deleted' && read.outcome !== 'retained') {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      }
      if (read.object === null) {
        if (read.outcome !== 'retained') fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
        return { outcome: 'retained', object: null }
      }
      const object = parseDescriptor(read.object, true)
      assertSameIdentity(expected, object)
      if (
        !expectedBindingMatches(expected, object) ||
        (read.outcome === 'deleted' && (object.pinned || object.expiresAt > expected.now))
      ) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      return { outcome: read.outcome, object: copyDescriptor(object) }
    },

    async pin(request) {
      assertOutsideTransaction(transactionDepth)
      const expected = parseExpectedBinding(request)
      const object = parseDescriptor(await callProvider(() => provider.pin({ ...expected })), true)
      assertSameIdentity(expected, object)
      if (!expectedBindingMatches(expected, object)) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      if (!object.pinned) fail('RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT')
      return copyDescriptor(object)
    },
  }
}

/** Test-only local implementation. Its process-local metadata is not staging or D3 authority. */
export function createLocalRecoveryArchiveObjectStoreProvider(options: {
  environment: RecoveryArchiveLocalObjectStoreEnvironment
  basePath: string
}): RecoveryArchiveObjectStoreProvider {
  if ((options as { environment?: unknown }).environment !== 'test') {
    fail('RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_ENVIRONMENT_REFUSED')
  }
  const basePath = path.resolve(options.basePath)
  const objects = new Map<string, RecoveryArchiveObjectDescriptor>()
  const locks = new Map<string, Promise<void>>()

  function containedPath(identity: RecoveryArchiveObjectIdentity): string {
    try {
      return resolveWithinBase(basePath, objectStorageKey(identity))
    } catch {
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED')
    }
  }

  async function containedFilesystemPath(
    identity: RecoveryArchiveObjectIdentity,
    options: { createParents?: boolean; requireFile?: boolean } = {},
  ): Promise<string> {
    const fullPath = containedPath(identity)
    try {
      if (options.createParents) await fs.mkdir(basePath, { recursive: true })
      const realBasePath = await fs.realpath(basePath)
      const parentPath = path.dirname(fullPath)
      const relativeParent = path.relative(basePath, parentPath)
      let currentPath = basePath
      let realParentPath = realBasePath

      for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment)
        if (options.createParents) {
          try {
            await fs.mkdir(currentPath)
          } catch {
            // lstat below distinguishes an existing directory from a refused component.
          }
        }
        const stats = await fs.lstat(currentPath)
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error()
        const realCurrentPath = await fs.realpath(currentPath)
        if (realCurrentPath !== realBasePath && !realCurrentPath.startsWith(realBasePath + path.sep)) {
          throw new Error()
        }
        realParentPath = realCurrentPath
      }

      const realFullPath = path.join(realParentPath, path.basename(fullPath))
      if (options.requireFile) {
        const stats = await fs.lstat(realFullPath)
        if (stats.isSymbolicLink() || !stats.isFile()) throw new Error()
        const resolvedFullPath = await fs.realpath(realFullPath)
        if (!resolvedFullPath.startsWith(realBasePath + path.sep)) throw new Error()
      }
      return realFullPath
    } catch {
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED')
    }
  }

  async function withObjectLock<T>(identity: RecoveryArchiveObjectIdentity, work: () => Promise<T>): Promise<T> {
    const key = identityKey(identity)
    const previous = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    locks.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (locks.get(key) === tail) locks.delete(key)
    }
  }

  function requireExpected(
    request: RecoveryArchiveObjectExpectedBinding,
    object: RecoveryArchiveObjectDescriptor,
  ): void {
    if (!expectedBindingMatches(request, object)) {
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
    }
  }

  async function readVerifiedBytes(object: RecoveryArchiveObjectDescriptor): Promise<Uint8Array> {
    const fullPath = await containedFilesystemPath(object, { requireFile: true })
    try {
      const bytes = new Uint8Array(await fs.readFile(fullPath))
      const actual = byteBinding(bytes)
      if (actual.sha256 !== object.sha256 || actual.size !== object.size) {
        fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
      }
      return bytes
    } catch (error) {
      if (error instanceof RecoveryArchiveObjectStoreError) throw error
      fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
    }
  }

  return {
    async put(request) {
      return withObjectLock(request, async () => {
        const bytes = copyUint8Array(request.bytes)
        const actual = byteBinding(bytes)
        if (actual.sha256 !== request.sha256 || actual.size !== request.size) {
          fail('RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH')
        }
        const key = identityKey(request)
        const existing = objects.get(key)
        if (existing) {
          await readVerifiedBytes(existing)
          if (!sameBinding(bindingOf(request), bindingOf(existing)) || request.pinned !== existing.pinned) {
            failLocalBindingMismatch()
          }
          return { outcome: 'existing', object: copyDescriptor(existing) }
        }
        const fullPath = await containedFilesystemPath(request, { createParents: true })
        try {
          await fs.writeFile(fullPath, bytes, { flag: 'wx' })
        } catch {
          fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
        }
        const object = copyDescriptor(request)
        objects.set(key, object)
        return { outcome: 'created', object: copyDescriptor(object) }
      })
    },

    async get(request) {
      return withObjectLock(request, async () => {
        const object = objects.get(identityKey(request))
        if (!object) fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
        requireExpected(request, object)
        return { ...copyDescriptor(object), bytes: await readVerifiedBytes(object) }
      })
    },

    async head(request) {
      return withObjectLock(request, async () => {
        const object = objects.get(identityKey(request))
        if (!object) return null
        requireExpected(request, object)
        await readVerifiedBytes(object)
        return copyDescriptor(object)
      })
    },

    async deleteExpired(request) {
      return withObjectLock(request, async () => {
        const key = identityKey(request)
        const object = objects.get(key)
        if (!object) return { outcome: 'retained', object: null }
        requireExpected(request, object)
        if (object.pinned || object.expiresAt > request.now) {
          return { outcome: 'retained', object: copyDescriptor(object) }
        }
        await readVerifiedBytes(object)
        const fullPath = await containedFilesystemPath(object, { requireFile: true })
        try {
          await fs.unlink(fullPath)
        } catch {
          fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
        }
        objects.delete(key)
        return { outcome: 'deleted', object: copyDescriptor(object) }
      })
    },

    async pin(request) {
      return withObjectLock(request, async () => {
        const object = objects.get(identityKey(request))
        if (!object) fail('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
        requireExpected(request, object)
        await readVerifiedBytes(object)
        const pinnedObject = { ...object, pinned: true }
        objects.set(identityKey(request), pinnedObject)
        return copyDescriptor(pinnedObject)
      })
    },
  }
}
