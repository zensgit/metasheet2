import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import {
  RecoveryArchiveObjectStoreError,
  RecoveryArchiveLocalBindingMismatchError,
  validateRecoveryArchiveObjectPutRequest,
  validateRecoveryArchiveObjectExpectedBinding,
  validateRecoveryArchiveObjectDeleteExpiredRequest,
  type RecoveryArchiveObjectDescriptor,
  type RecoveryArchiveObjectExpectedBinding,
  type RecoveryArchiveObjectPutRequest,
  type RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'

const ROOT_FILE = '.metasheet-archive-root'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEADER_LIMIT = 4096
const HEADER_KEYS = ['expiresAt', 'generationId', 'objectId', 'pinned', 'sha256', 'size', 'version']

interface Root {
  configuredPath: string
  realPath: string
  dev: bigint
  ino: bigint
}

export interface RecoveryArchiveFileStoreOptions {
  basePath: string
  storeId: string
  maxObjectBytes: number
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}

function refuse(): never {
  throw new RecoveryArchiveObjectStoreError('RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED')
}

function mismatch(): never {
  throw new RecoveryArchiveLocalBindingMismatchError()
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function checkedDirectory(configuredPath: string): Promise<Root> {
  if (!path.isAbsolute(configuredPath) || !process.getuid) refuse()
  const stat = await fs.lstat(configuredPath, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n) refuse()
  const realPath = await fs.realpath(configuredPath)
  const filesystem = await fs.statfs(realPath)
  // Network/unknown filesystems need a separate durability and mount-loss acceptance contract.
  const supported = process.platform === 'linux'
    ? [0xef53, 0x58465342, 0x9123683e]
    : process.platform === 'darwin' ? [25] : []
  if (!supported.includes(filesystem.type)) refuse()
  return { configuredPath, realPath, dev: stat.dev, ino: stat.ino }
}

async function assertRoot(root: Root): Promise<void> {
  const current = await checkedDirectory(root.configuredPath)
  if (current.realPath !== root.realPath || current.dev !== root.dev || current.ino !== root.ino) refuse()
}

async function syncDirectory(root: Root): Promise<void> {
  await assertRoot(root)
  const handle = await fs.open(root.realPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat({ bigint: true })
    if (stat.dev !== root.dev || stat.ino !== root.ino) refuse()
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readFile(root: Root, name: string, limit: number): Promise<Buffer | null> {
  await assertRoot(root)
  let handle: fs.FileHandle
  try {
    handle = await fs.open(path.join(root.realPath, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) refuse()
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size || bytes.length > limit) refuse()
    await assertRoot(root)
    return bytes
  } finally {
    await handle.close()
  }
}

// link() is exclusive publication: pin/delete contenders never replace an existing decision.
async function publish(root: Root, name: string, bytes: Buffer): Promise<boolean> {
  await assertRoot(root)
  const temporaryPath = path.join(root.realPath, `.pending-${randomUUID()}`)
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await assertRoot(root)
    try {
      await fs.link(temporaryPath, path.join(root.realPath, name))
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
      await syncDirectory(root)
      return false
    }
    await syncDirectory(root)
    return true
  } finally {
    await assertRoot(root)
    await fs.unlink(temporaryPath)
  }
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof RecoveryArchiveLocalBindingMismatchError) throw new RecoveryArchiveLocalBindingMismatchError()
    refuse()
  }
}

/** Explicit preparation only. It does not create directories or select a storage location. */
export async function provisionRecoveryArchiveFileRoot(options: Pick<RecoveryArchiveFileStoreOptions, 'basePath' | 'storeId' | 'transactionDepth'>): Promise<void> {
  await guarded(async () => {
    if (options.transactionDepth.currentTransactionDepth() !== 0) refuse()
    if (!UUID.test(options.storeId)) refuse()
    const root = await checkedDirectory(options.basePath)
    await publish(root, ROOT_FILE, Buffer.from(options.storeId))
    if ((await readFile(root, ROOT_FILE, 36))?.toString() !== options.storeId) refuse()
  })
}

function binding(object: RecoveryArchiveObjectDescriptor): RecoveryArchiveObjectExpectedBinding {
  return {
    generationId: object.generationId,
    objectId: object.objectId,
    expectedVersion: object.version,
    expectedSha256: object.sha256,
    expectedSize: object.size,
    expectedExpiresAt: object.expiresAt,
  }
}

function assertBinding(expected: RecoveryArchiveObjectExpectedBinding, object: RecoveryArchiveObjectDescriptor): void {
  const actual = binding(object)
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
    if (actual[key] !== expected[key]) mismatch()
  }
}

function descriptor(value: unknown, expected: RecoveryArchiveObjectExpectedBinding): RecoveryArchiveObjectDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) mismatch()
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== HEADER_KEYS.join(',')) mismatch()
  if (typeof record.pinned !== 'boolean') mismatch()
  const object = record as unknown as RecoveryArchiveObjectDescriptor
  assertBinding(expected, object)
  return object
}

function encode(request: RecoveryArchiveObjectPutRequest): Buffer {
  const { bytes, ...object } = request
  const header = Buffer.from(JSON.stringify(object))
  if (header.length > HEADER_LIMIT) refuse()
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(header.length)
  return Buffer.concat([prefix, header, bytes])
}

/** Persistent local POSIX provider; deliberately not automatically wired to application startup. */
export async function createRecoveryArchiveFileStoreProvider(options: RecoveryArchiveFileStoreOptions): Promise<RecoveryArchiveObjectStoreProvider> {
  return guarded(async () => {
    options = { ...options }
    if (!UUID.test(options.storeId) || !Number.isSafeInteger(options.maxObjectBytes) || options.maxObjectBytes <= 0 || options.maxObjectBytes > 256 * 1024 * 1024) refuse()
    if (options.transactionDepth.currentTransactionDepth() !== 0) refuse()
    const root = await checkedDirectory(options.basePath)
    const checkRoot = async () => {
      if ((await readFile(root, ROOT_FILE, 36))?.toString() !== options.storeId) refuse()
    }
    await checkRoot()
    const names = (request: RecoveryArchiveObjectExpectedBinding) => {
      const prefix = `${request.generationId}-${request.objectId}`
      return { object: `${prefix}.object`, retention: `${prefix}.retention` }
    }
    const readRetention = async (expected: RecoveryArchiveObjectExpectedBinding) => {
      const bytes = await readFile(root, names(expected).retention, HEADER_LIMIT)
      if (!bytes) return null
      const value: unknown = JSON.parse(bytes.toString())
      if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse()
      const record = value as Record<string, unknown>
      if (Object.keys(record).sort().join(',') !== 'kind,object' || !['pinned', 'deleted'].includes(String(record.kind))) refuse()
      const object = descriptor(record.object, expected)
      if (object.pinned !== (record.kind === 'pinned')) mismatch()
      return { kind: record.kind as 'pinned' | 'deleted', object }
    }
    const readObject = async (expected: RecoveryArchiveObjectExpectedBinding) => {
      const encoded = await readFile(root, names(expected).object, options.maxObjectBytes + HEADER_LIMIT + 4)
      if (!encoded) return null
      if (encoded.length < 4) mismatch()
      const length = encoded.readUInt32BE()
      if (length > HEADER_LIMIT || length + 4 > encoded.length) mismatch()
      const object = descriptor(JSON.parse(encoded.subarray(4, 4 + length).toString()), expected)
      const bytes = encoded.subarray(4 + length)
      if (bytes.length > options.maxObjectBytes || String(bytes.length) !== object.size || createHash('sha256').update(bytes).digest('hex') !== object.sha256) mismatch()
      return { object, bytes }
    }
    const unlinkDeleted = async (expected: RecoveryArchiveObjectExpectedBinding) => {
      await checkRoot()
      try {
        await fs.unlink(path.join(root.realPath, names(expected).object))
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error
      }
      await syncDirectory(root)
    }
    const effective = async (expected: RecoveryArchiveObjectExpectedBinding) => {
      await checkRoot()
      const retention = await readRetention(expected)
      if (retention?.kind === 'deleted') return null
      const result = await readObject(expected)
      if (!result && retention) refuse()
      return result && { ...result, object: retention?.object ?? result.object }
    }
    const provider: RecoveryArchiveObjectStoreProvider = {
      async put(request) {
        await checkRoot()
        if (request.bytes.length > options.maxObjectBytes || String(request.bytes.length) !== request.size || createHash('sha256').update(request.bytes).digest('hex') !== request.sha256) mismatch()
        const expected = binding(request)
        if ((await readRetention(expected))?.kind === 'deleted') mismatch()
        const created = await publish(root, names(expected).object, encode(request))
        const retention = await readRetention(expected)
        if (retention?.kind === 'deleted') {
          await unlinkDeleted(expected)
          mismatch()
        }
        const result = await effective(expected)
        if (!result || (request.pinned && !result.object.pinned)) mismatch()
        return { outcome: created ? 'created' : 'existing', object: result.object }
      },
      async get(request) {
        const result = await effective(request)
        if (!result) refuse()
        return { ...result.object, bytes: result.bytes }
      },
      async head(request) {
        return (await effective(request))?.object ?? null
      },
      async pin(request) {
        const result = await effective(request)
        if (!result) refuse()
        await publish(root, names(request).retention, Buffer.from(JSON.stringify({ kind: 'pinned', object: { ...result.object, pinned: true } })))
        const retained = await readRetention(request)
        if (!retained || retained.kind !== 'pinned') refuse()
        return retained.object
      },
      async deleteExpired(request) {
        await checkRoot()
        const prior = await readRetention(request)
        if (prior?.kind === 'deleted') {
          await syncDirectory(root)
          await unlinkDeleted(request)
          return { outcome: 'deleted', object: prior.object }
        }
        const result = await effective(request)
        if (!result) return { outcome: 'retained', object: null }
        if (result.object.pinned || result.object.expiresAt > request.now) return { outcome: 'retained', object: result.object }
        await publish(root, names(request).retention, Buffer.from(JSON.stringify({ kind: 'deleted', object: result.object })))
        const retained = await readRetention(request)
        if (!retained) refuse()
        if (retained.kind === 'pinned') return { outcome: 'retained', object: retained.object }
        await unlinkDeleted(request)
        return { outcome: 'deleted', object: retained.object }
      },
    }
    // Return the raw provider. Existing reader/application callers own the result wrapper.
    const run = <T>(work: () => Promise<T>) => guarded(async () => {
      if (options.transactionDepth.currentTransactionDepth() !== 0) refuse()
      return work()
    })
    return {
      put: (request) => run(() => provider.put(validateRecoveryArchiveObjectPutRequest(request))),
      get: (request) => run(() => provider.get(validateRecoveryArchiveObjectExpectedBinding(request))),
      head: (request) => run(() => provider.head(validateRecoveryArchiveObjectExpectedBinding(request))),
      pin: (request) => run(() => provider.pin(validateRecoveryArchiveObjectExpectedBinding(request))),
      deleteExpired: (request) => run(() => provider.deleteExpired(validateRecoveryArchiveObjectDeleteExpiredRequest(request))),
    }
  })
}
