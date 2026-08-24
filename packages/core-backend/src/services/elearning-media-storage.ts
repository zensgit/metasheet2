/**
 * E-learning M1 blob store: server-generated keys under a dedicated prefix.
 * Generic StorageService is local-only and is never production media storage.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

export const ELEARNING_MEDIA_STORAGE_PREFIX = 'elearning-media/'
export const ELEARNING_MEDIA_LIST_LIMIT_MIN = 1
export const ELEARNING_MEDIA_LIST_LIMIT_MAX = 1000

export interface ElearningMediaBlobRef {
  key: string
  /** Nonnegative age in milliseconds relative to the supplied (or current) time. */
  ageMs: number
}

export interface ElearningMediaBlobPage {
  blobs: ElearningMediaBlobRef[]
  nextCursor?: string
}

export interface ElearningMediaStore {
  put(storageKey: string, content: Buffer, contentType?: string): Promise<void>
  get(storageKey: string): Promise<Buffer>
  /** idempotent: missing blob returns false, never throws ENOENT. */
  delete(storageKey: string): Promise<boolean>
}

/** Server-generated key. Client filenames never become path segments. */
export function deriveElearningMediaStorageKey(now: () => Date = () => new Date()): string {
  const d = now()
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `${ELEARNING_MEDIA_STORAGE_PREFIX}${ym}/${randomUUID()}.mp4`
}

export function assertElearningMediaStorageKey(storageKey: string): string {
  if (typeof storageKey !== 'string' || storageKey.includes('\0') || storageKey.includes('\\')) {
    throw new RangeError('storage key is outside the elearning media scope — refused')
  }
  if (!storageKey.startsWith(ELEARNING_MEDIA_STORAGE_PREFIX) || storageKey.includes('..')) {
    throw new RangeError('storage key is outside the elearning media scope — refused')
  }
  return storageKey
}

export function assertElearningMediaListLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < ELEARNING_MEDIA_LIST_LIMIT_MIN || limit > ELEARNING_MEDIA_LIST_LIMIT_MAX) {
    throw new RangeError('elearning media list limit is out of range — refused')
  }
  return limit
}

export function nonnegativeAgeMs(lastModifiedMs: number, now: Date): number {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('elearning media age clock is invalid')
  }
  if (typeof lastModifiedMs !== 'number' || !Number.isFinite(lastModifiedMs)) {
    throw new RangeError('elearning media last-modified time is invalid')
  }
  const ageMs = Math.max(0, Math.floor(now.getTime() - lastModifiedMs))
  if (!Number.isSafeInteger(ageMs)) {
    throw new RangeError('elearning media age is invalid')
  }
  return ageMs
}

export class LocalFsElearningMediaStore implements ElearningMediaStore {
  constructor(private readonly rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') throw new RangeError('rootDir required')
  }

  private contain(storageKey: string): string {
    assertElearningMediaStorageKey(storageKey)
    if (storageKey.trim() === '') throw new RangeError('invalid storage key')
    const root = path.resolve(this.rootDir)
    const resolved = path.resolve(root, storageKey)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new RangeError('storage key escapes the elearning media root — refused')
    }
    return resolved
  }

  async put(storageKey: string, content: Buffer): Promise<void> {
    const p = this.contain(storageKey)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, content, { flag: 'wx' })
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(this.contain(storageKey))
  }

  async delete(storageKey: string): Promise<boolean> {
    try {
      await rm(this.contain(storageKey))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  async hasBlob(storageKey: string): Promise<boolean> {
    try {
      const st = await stat(this.contain(storageKey))
      return st.isFile()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  async listPage(
    cursor: string | undefined,
    limit: number,
    now: Date = new Date(),
  ): Promise<ElearningMediaBlobPage> {
    assertElearningMediaListLimit(limit)
    const after = this.normalizeListCursor(cursor)
    const keys = await this.collectPrefixedKeys()
    const from = after === undefined ? keys : keys.filter((key) => key > after)
    const pageKeys = from.slice(0, limit)
    const blobs: ElearningMediaBlobRef[] = []
    for (const key of pageKeys) {
      const st = await stat(this.contain(key))
      blobs.push({ key, ageMs: nonnegativeAgeMs(st.mtimeMs, now) })
    }
    if (from.length > limit) {
      return { blobs, nextCursor: pageKeys[pageKeys.length - 1] }
    }
    return { blobs }
  }

  private normalizeListCursor(cursor: string | undefined): string | undefined {
    if (cursor === undefined || cursor === '') return undefined
    this.contain(cursor)
    return cursor
  }

  private async collectPrefixedKeys(): Promise<string[]> {
    const root = path.resolve(this.rootDir)
    const prefixDir = path.resolve(root, ELEARNING_MEDIA_STORAGE_PREFIX)
    if (prefixDir !== root && !prefixDir.startsWith(root + path.sep)) {
      throw new RangeError('storage key escapes the elearning media root — refused')
    }
    const keys: string[] = []
    await this.walkPrefixedFiles(prefixDir, root, keys)
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return keys
  }

  private async walkPrefixedFiles(dir: string, root: string, keys: string[]): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const resolved = path.resolve(dir, entry.name)
      if (resolved === root || !resolved.startsWith(root + path.sep)) {
        throw new RangeError('storage key escapes the elearning media root — refused')
      }
      if (entry.isDirectory()) {
        await this.walkPrefixedFiles(resolved, root, keys)
        continue
      }
      if (!entry.isFile()) continue
      const rel = path.relative(root, resolved).split(path.sep).join('/')
      assertElearningMediaStorageKey(rel)
      keys.push(rel)
    }
  }
}

export interface KeyAddressedElearningObjectStore {
  uploadByKey(storageKey: string, content: Buffer, contentType?: string): Promise<void>
  downloadByKey(storageKey: string): Promise<Buffer>
  deleteByKey(storageKey: string): Promise<void>
}

export class ObjectStoreElearningMediaStore implements ElearningMediaStore {
  constructor(
    private readonly provider: KeyAddressedElearningObjectStore,
    private readonly prefix: string = ELEARNING_MEDIA_STORAGE_PREFIX,
  ) {
    if (typeof prefix !== 'string' || !prefix.endsWith('/')) throw new RangeError('prefix must end with "/"')
  }

  private scoped(storageKey: string): string {
    assertElearningMediaStorageKey(storageKey)
    if (!storageKey.startsWith(this.prefix)) {
      throw new RangeError('storage key is outside the elearning media scope — refused')
    }
    return storageKey
  }

  async put(storageKey: string, content: Buffer, contentType?: string): Promise<void> {
    await this.provider.uploadByKey(this.scoped(storageKey), content, contentType)
  }

  async get(storageKey: string): Promise<Buffer> {
    return this.provider.downloadByKey(this.scoped(storageKey))
  }

  async delete(storageKey: string): Promise<boolean> {
    await this.provider.deleteByKey(this.scoped(storageKey))
    return true
  }
}

/** Boot probe: put → get exact bytes → delete. Values-free on failure. */
export async function probeElearningMediaStore(store: ElearningMediaStore): Promise<void> {
  const payload = Buffer.from('elearning-media boot probe')
  const probeKey = `${ELEARNING_MEDIA_STORAGE_PREFIX}boot-probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}.mp4`
  try {
    await store.put(probeKey, payload, 'video/mp4')
    const got = await store.get(probeKey)
    if (!Buffer.isBuffer(got) || !got.equals(payload)) {
      throw new Error('probe get mismatch')
    }
    await store.delete(probeKey)
  } catch {
    await store.delete(probeKey).catch(() => false)
    throw new Error('E-learning media storage probe failed')
  }
}
