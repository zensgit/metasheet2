/**
 * E-learning M1 blob store: server-generated keys under a dedicated prefix.
 * Generic StorageService is local-only and is never production media storage.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

export const ELEARNING_MEDIA_STORAGE_PREFIX = 'elearning-media/'

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
