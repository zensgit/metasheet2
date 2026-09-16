import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

import {
  createRecoveryArchiveFileStoreProvider,
  provisionRecoveryArchiveFileRoot,
} from '../../src/multitable/recovery-archive-file-store'
import { createTransactionGuardedRecoveryArchiveObjectStore, type RecoveryArchiveObjectPutRequest } from '../../src/multitable/recovery-archive-object-store'
import type { RecoveryArchiveFileStoreOptions } from '../../src/multitable/recovery-archive-file-store'

const roots: string[] = []
const NOW = '2026-09-16T00:00:00.000Z'
const EXPIRES = '2026-09-15T00:00:00.000Z'
const require = createRequire(import.meta.url)

async function openStore(options: RecoveryArchiveFileStoreOptions) {
  return createTransactionGuardedRecoveryArchiveObjectStore(await createRecoveryArchiveFileStoreProvider(options), options.transactionDepth)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function request(): RecoveryArchiveObjectPutRequest {
  const bytes = Buffer.from('synthetic-encrypted-archive')
  return {
    generationId: randomUUID(), objectId: 'a'.repeat(64), version: '1',
    sha256: createHash('sha256').update(bytes).digest('hex'), size: String(bytes.length),
    expiresAt: EXPIRES, pinned: false, bytes,
  }
}

function expected(object: RecoveryArchiveObjectPutRequest) {
  return {
    generationId: object.generationId, objectId: object.objectId, expectedVersion: object.version,
    expectedSha256: object.sha256, expectedSize: object.size, expectedExpiresAt: object.expiresAt,
  }
}

async function setup() {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-file-store-'))
  roots.push(basePath)
  const options = { basePath, storeId: randomUUID(), maxObjectBytes: 1024, transactionDepth: { currentTransactionDepth: () => 0 } }
  await provisionRecoveryArchiveFileRoot(options)
  const store = await openStore(options)
  const object = request()
  const files = {
    object: path.join(basePath, `${object.generationId}-${object.objectId}.object`),
    retention: path.join(basePath, `${object.generationId}-${object.objectId}.retention`),
  }
  return { options, store, object, files }
}

describe('persistent local archive object store', () => {
  test('rediscovers exact bytes and immutable descriptor from a fresh provider', async () => {
    const { options, store, object } = await setup()
    const { bytes, ...descriptor } = object
    expect(await store.put(object)).toEqual({ outcome: 'created', object: descriptor })
    const restarted = await openStore(options)
    expect(await restarted.get(expected(object))).toEqual({ ...descriptor, bytes: new Uint8Array(bytes) })
    expect(await restarted.put(object)).toEqual({ outcome: 'existing', object: descriptor })
    expect(await fs.readdir(options.basePath)).toHaveLength(2)
  })

  test('concurrent put creates exactly once; different binding cannot replace bytes', async () => {
    const { options, store, object } = await setup()
    const other = await openStore(options)
    const results = await Promise.all([store.put(object), other.put(object)])
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'existing'])
    await expect(other.put({ ...object, version: '2' })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH' })
    expect((await store.get(expected(object))).bytes).toEqual(new Uint8Array(object.bytes))
  })

  test('pin survives restart and blocks expired deletion', async () => {
    const { options, store, object } = await setup()
    await store.put(object)
    await store.pin(expected(object))
    const restarted = await openStore(options)
    const { bytes: _bytes, ...descriptor } = object
    expect(await restarted.deleteExpired({ ...expected(object), now: NOW })).toEqual({ outcome: 'retained', object: { ...descriptor, pinned: true } })
    expect((await restarted.get(expected(object))).pinned).toBe(true)
    expect((await restarted.put(object)).object.pinned).toBe(true)
  })

  test('permanent delete marker prevents put resurrection after restart', async () => {
    const { options, store, object, files } = await setup()
    await store.put(object)
    expect((await store.deleteExpired({ ...expected(object), now: NOW })).outcome).toBe('deleted')
    await expect(fs.stat(files.object)).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = await openStore(options)
    expect(await restarted.head(expected(object))).toBeNull()
    await expect(restarted.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(fs.stat(files.object)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(restarted.pin(expected(object))).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect((await restarted.deleteExpired({ ...expected(object), now: NOW })).outcome).toBe('deleted')
  })

  test('independent pin/delete contenders cannot both win', async () => {
    const { options, store } = await setup()
    const other = await openStore(options)
    for (let i = 0; i < 8; i += 1) {
      const object = request()
      await store.put(object)
      const [pin, deletion] = await Promise.allSettled([
        store.pin(expected(object)), other.deleteExpired({ ...expected(object), now: NOW }),
      ])
      if (pin.status === 'fulfilled') {
        expect(deletion.status).toBe('fulfilled')
        if (deletion.status === 'fulfilled') expect(deletion.value.outcome).toBe('retained')
        expect((await other.get(expected(object))).pinned).toBe(true)
      } else {
        expect(deletion.status).toBe('fulfilled')
        if (deletion.status === 'fulfilled') expect(deletion.value.outcome).toBe('deleted')
        expect(await store.head(expected(object))).toBeNull()
      }
    }
  })

  test('a separate Node process reads persisted bytes and pin authority', async () => {
    const { options, store, object } = await setup()
    await store.put(object)
    await store.pin(expected(object))
    const source = path.resolve('src/multitable/recovery-archive-file-store.ts')
    const script = `
      const { createRecoveryArchiveFileStoreProvider } = require(${JSON.stringify(source)});
      (async () => {
        const store = await createRecoveryArchiveFileStoreProvider({
          ...JSON.parse(process.env.TM_FILE_OPTIONS), transactionDepth: { currentTransactionDepth: () => 0 }
        });
        const object = await store.get(JSON.parse(process.env.TM_FILE_EXPECTED));
        process.stdout.write(JSON.stringify({ pinned: object.pinned, sha256: object.sha256, size: object.size }));
      })().catch(() => process.exit(1));`
    const { stdout } = await promisify(execFile)(process.execPath, [require.resolve('tsx/cli'), '-e', script], {
      env: { ...process.env, TM_FILE_OPTIONS: JSON.stringify(options), TM_FILE_EXPECTED: JSON.stringify(expected(object)) },
      timeout: 15_000,
    })
    expect(JSON.parse(stdout)).toEqual({ pinned: true, sha256: object.sha256, size: object.size })
  })

  test('failed publication directory flush does not report success and replay recovers', async () => {
    const { options, store, object } = await setup()
    const open = fs.open
    const realRoot = await fs.realpath(options.basePath)
    let injected = false
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === realRoot && !injected) {
        injected = true
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('synthetic-private-flush-error'))
      }
      return handle
    })
    await expect(store.put(object)).rejects.toMatchObject({ message: 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED' })
    expect(injected).toBe(true)
    fault.mockRestore()
    const restarted = await openStore(options)
    expect((await restarted.put(object)).outcome).toBe('existing')
    expect((await restarted.get(expected(object))).sha256).toBe(object.sha256)
  })

  test('interrupted unlink keeps a durable deletion decision; retry finishes it', async () => {
    const { options, store, object, files } = await setup()
    await store.put(object)
    const realObject = await fs.realpath(files.object)
    const unlink = fs.unlink
    const fault = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (target === realObject) throw new Error('synthetic-private-path-must-not-leak')
      return unlink(target)
    })
    await expect(store.deleteExpired({ ...expected(object), now: NOW })).rejects.toMatchObject({ message: 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED' })
    fault.mockRestore()
    expect((JSON.parse(await fs.readFile(files.retention, 'utf8')) as { kind: string }).kind).toBe('deleted')
    const restarted = await openStore(options)
    await expect(restarted.pin(expected(object))).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect((await restarted.deleteExpired({ ...expected(object), now: NOW })).outcome).toBe('deleted')
    await expect(fs.stat(files.object)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('future expiry and initial pin are retained without a delete decision', async () => {
    const { store, object, files } = await setup()
    await store.put({ ...object, pinned: true })
    expect((await store.deleteExpired({ ...expected(object), now: NOW })).outcome).toBe('retained')
    await expect(fs.stat(files.retention)).rejects.toMatchObject({ code: 'ENOENT' })
    const future = { ...request(), expiresAt: '2099-01-01T00:00:00.000Z' }
    await store.put(future)
    expect((await store.deleteExpired({ ...expected(future), now: NOW })).outcome).toBe('retained')
  })

  test('wrong binding cannot pin or delete', async () => {
    const { store, object } = await setup()
    await store.put(object)
    const wrong = { ...expected(object), expectedVersion: '2' }
    await expect(store.pin(wrong)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(store.deleteExpired({ ...wrong, now: NOW })).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect((await store.head(expected(object)))?.pinned).toBe(false)
  })

  test.each(['bytes', 'metadata', 'retention'])('corrupt %s fails closed without deleting the object', async (kind) => {
    const { store, object, files } = await setup()
    await store.put(object)
    if (kind === 'retention') {
      await fs.writeFile(files.retention, JSON.stringify({ kind: 'deleted', object: { ...object, bytes: undefined, version: '2' } }), { mode: 0o600 })
    } else {
      const bytes = await fs.readFile(files.object)
      if (kind === 'bytes') bytes[bytes.length - 1] ^= 1
      else bytes.writeUInt32BE(0xffffffff)
      await fs.writeFile(files.object, bytes)
    }
    await expect(store.get(expected(object))).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(store.deleteExpired({ ...expected(object), now: NOW })).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect((await fs.stat(files.object)).isFile()).toBe(true)
  })

  test('provisioning never creates a missing root or replaces another store identity', async () => {
    const { options } = await setup()
    await expect(provisionRecoveryArchiveFileRoot({ ...options, basePath: path.join(options.basePath, 'absent') })).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(fs.stat(path.join(options.basePath, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(provisionRecoveryArchiveFileRoot({ ...options, storeId: randomUUID() })).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect(await fs.readFile(path.join(options.basePath, '.metasheet-archive-root'), 'utf8')).toBe(options.storeId)
  })

  test('root replacement refuses instead of writing to a fallback directory', async () => {
    const { options, store, object } = await setup()
    const moved = `${options.basePath}-original`
    roots.push(moved)
    await fs.rename(options.basePath, moved)
    await fs.mkdir(options.basePath, { mode: 0o700 })
    await fs.writeFile(path.join(options.basePath, '.metasheet-archive-root'), options.storeId, { mode: 0o600 })
    await expect(store.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect(await fs.readdir(options.basePath)).toEqual(['.metasheet-archive-root'])
  })

  test('root identity mismatch and permissive directory mode are refused', async () => {
    const { options, store, object } = await setup()
    await fs.writeFile(path.join(options.basePath, '.metasheet-archive-root'), randomUUID())
    await expect(store.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(createRecoveryArchiveFileStoreProvider(options)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await fs.chmod(options.basePath, 0o755)
    await expect(provisionRecoveryArchiveFileRoot(options)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
  })

  test('root identity preserves adjacent inode values beyond Number safe precision', async () => {
    const { options, object } = await setup()
    const lstat = fs.lstat
    let inode = 9007199254740992n
    vi.spyOn(fs, 'lstat').mockImplementation(async (target, statOptions) => {
      const stat = await lstat(target, statOptions)
      if (target === options.basePath) {
        Object.defineProperty(stat, 'ino', { value: typeof stat.ino === 'bigint' ? inode : Number(inode) })
      }
      return stat
    })
    const store = await openStore(options)
    inode += 1n
    await expect(store.put(object)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED' })
    expect(await fs.readdir(options.basePath)).toEqual(['.metasheet-archive-root'])
  })

  test('raw provider refuses unsafe identity and mismatched bytes before publication', async () => {
    const { options, object } = await setup()
    const raw = await createRecoveryArchiveFileStoreProvider(options)
    await expect(raw.put({ ...object, generationId: '../outside' })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED' })
    await expect(raw.put({ ...object, sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH' })
    expect(await fs.readdir(options.basePath)).toEqual(['.metasheet-archive-root'])
  })

  test('symlink object is refused without reading or deleting its target', async () => {
    const { options, store, object, files } = await setup()
    await store.put(object)
    const target = path.join(options.basePath, 'target')
    await fs.rename(files.object, target)
    await fs.symlink(target, files.object)
    await expect(store.get(expected(object))).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    await expect(store.deleteExpired({ ...expected(object), now: NOW })).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect((await fs.stat(target)).isFile()).toBe(true)
  })

  test('transaction and unknown filesystem gates perform no publication', async () => {
    const { options, store, object } = await setup()
    const before = await fs.readdir(options.basePath)
    vi.spyOn(options.transactionDepth, 'currentTransactionDepth').mockReturnValue(1)
    await expect(store.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE_CALL_IN_TRANSACTION')
    vi.restoreAllMocks()
    const statfs = fs.statfs
    vi.spyOn(fs, 'statfs').mockImplementation(async (target) => ({ ...await statfs(target), type: 0x6969 }))
    await expect(store.put(object)).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect(await fs.readdir(options.basePath)).toEqual(before)
  })

  test('object size bound and byte hash are checked before publication', async () => {
    const { options, store, object } = await setup()
    await expect(store.put({ ...object, sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH' })
    const bytes = Buffer.alloc(1025)
    await expect(store.put({ ...object, bytes, size: String(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex') })).rejects.toThrow('RECOVERY_ARCHIVE_OBJECT_STORE')
    expect(await fs.readdir(options.basePath)).toEqual(['.metasheet-archive-root'])
  })
})
