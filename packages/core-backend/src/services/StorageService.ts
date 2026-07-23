/**
 * 存储服务实现
 * 支持本地文件系统存储后端（S3 骨架代码已作为死码于 F6 移除，refs #3925）
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import type { Readable } from 'stream'
import { EventEmitter } from 'eventemitter3'
import type {
  StorageService,
  StorageFile,
  UploadOptions,
  GetUrlOptions,
  PresignedUploadOptions,
  PresignedUpload,
  StorageUsage
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * F3 files-storage-integrity design-lock (2026-07-10), G1/G2: derive a display-only safe basename from
 * a client-supplied filename. Normalizes `\` → `/` first so a Windows-style separator can't survive
 * `path.basename`, strips any directory component, then removes control chars and leading dots (which
 * would otherwise produce a hidden file that `scanDirectory` skips, or a `.`/`..` traversal segment).
 * The result is used ONLY as the last segment of the server-generated `<uuid>/<safeBasename>` key — it
 * can never widen the physical write location (the uuid dir is server-owned and containment-checked).
 */
export function toSafeStorageBasename(rawName: string): string {
  const base = path.basename(String(rawName).replace(/\\/g, '/'))
  // eslint-disable-next-line no-control-regex
  const stripped = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '')
  return stripped.length > 0 ? stripped : 'file'
}

/**
 * F3 design-lock G2: containment hard floor. Resolves `key` against `basePath` and throws unless the
 * result stays strictly inside `basePath` (and is not `basePath` itself). Applied on BOTH write and
 * read — even though F3 server-generates the key, a corrupt/legacy/url-derived key must never let a
 * read or write escape the storage root.
 */
export function resolveWithinBase(basePath: string, key: string): string {
  const base = path.resolve(basePath)
  const resolved = path.resolve(base, key)
  if (resolved !== base && resolved.startsWith(base + path.sep)) {
    return resolved
  }
  throw new Error('Storage key resolves outside the storage base path')
}

/**
 * 存储提供者接口
 *
 * EXPORTED (B3-07 #4195 §0-bis): the approval-attachment pipeline's production storage prerequisite is
 * "an object-store provider behind THIS interface" — which was impossible while the interface was
 * module-private. Exporting it is the named prerequisite, not a new capability: no implementation
 * changes, and the only in-repo implementation remains `LocalStorageProvider` below.
 */
export interface StorageProvider {
  upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile>
  /** B3-07 §7: write a physical object AT a caller-chosen deterministic storage key — the symmetric
   * write-side counterpart to `downloadByKey`/`deleteByKey`, completing the by-key triple. Unlike
   * `upload` (which server-generates `<uuid>/<safeBasename>` and lets the client's display filename
   * survive as the last path segment), the caller owns the whole key, so a caller that derives its key
   * from validated server-side data alone — as the approval pipeline's `deriveStorageKey` does — can
   * guarantee no client string ever reaches the physical path, and can pin every object under its own
   * scope prefix. Containment is re-asserted by the implementation. Exclusive-create: writing an
   * already-existing key MUST reject rather than silently overwrite. */
  uploadByKey(storageKey: string, content: Buffer, contentType?: string): Promise<void>
  download(fileId: string): Promise<Buffer>
  /** F3 design-lock G3: read a physical object by its deterministic storage key, bypassing the
   * in-memory disk-scan index entirely (no warmup window, no id-drift). */
  downloadByKey(storageKey: string): Promise<Buffer>
  /** F5 files-orphan-blob-retention design-lock (2026-07-10), GF5-2: delete a physical object by its
   * deterministic storage key — the symmetric write-side counterpart to `downloadByKey`, and the ONLY
   * safe way to physically delete an object outside the process that uploaded it (the in-memory
   * disk-scan index a bare `delete(fileId)` depends on is keyed by `md5(relpath)` after a rebuild, not
   * the uuid `fileId`, so it silently fails to locate the object in any other process — see F3's root-
   * cause note on `files.ts`'s DELETE route). Idempotent: deleting an already-gone key (ENOENT) resolves
   * successfully rather than throwing, so both the delete route and the F5 sweep can treat "delete" and
   * "confirm already deleted" as the same outcome. */
  deleteByKey(storageKey: string): Promise<void>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
  getFileInfo(fileId: string): Promise<StorageFile | null>
  getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>
  getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>
  createFolder(path: string): Promise<void>
  deleteFolder(path: string, recursive?: boolean): Promise<void>
  getStorageUsage(): Promise<StorageUsage>
}

/**
 * 本地文件系统存储提供者
 */
class LocalStorageProvider implements StorageProvider {
  private basePath: string
  private baseUrl: string
  private logger: Logger
  private fileIndex = new Map<string, StorageFile>() // 文件索引

  constructor(basePath: string, baseUrl: string = 'http://localhost:8900/files') {
    this.basePath = path.resolve(basePath)
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.logger = new Logger('LocalStorageProvider')

    // 确保基础目录存在
    this.ensureBaseDir()

    // 初始化时扫描现有文件建立索引
    this.buildFileIndex()
  }

  private async ensureBaseDir(): Promise<void> {
    try {
      await fs.mkdir(this.basePath, { recursive: true })
    } catch (error) {
      this.logger.error('Failed to create base directory', error as Error)
    }
  }

  private async buildFileIndex(): Promise<void> {
    try {
      const files = await this.scanDirectory(this.basePath)
      for (const file of files) {
        this.fileIndex.set(file.id, file)
      }
      this.logger.info(`Built file index with ${files.length} files`)
    } catch (error) {
      this.logger.error('Failed to build file index', error as Error)
    }
  }

  private async scanDirectory(dirPath: string, relativePath: string = ''): Promise<StorageFile[]> {
    const files: StorageFile[] = []

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        const currentRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name

        if (entry.isDirectory()) {
          // 递归扫描子目录
          const subFiles = await this.scanDirectory(fullPath, currentRelativePath)
          files.push(...subFiles)
        } else if (entry.isFile() && !entry.name.startsWith('.')) {
          // 跳过隐藏文件，添加普通文件
          const stats = await fs.stat(fullPath)
          // F3 design-lock G4: for the F3 layout `<uuid>/<safeBasename>` the id is the uuid directory
          // segment (deterministic — matches the id returned at upload time), so a rebuild no longer
          // drifts to `md5(relpath)` for those files. Legacy flat files fall back to the historical
          // md5 (vestigial — id lookups now go through the DB `storage_key`, not this index).
          const fileId = this.deriveIdFromRelativePath(currentRelativePath)

          files.push({
            id: fileId,
            filename: entry.name,
            size: stats.size,
            contentType: this.getContentType(entry.name),
            path: currentRelativePath,
            url: `${this.baseUrl}/${currentRelativePath}`,
            metadata: {},
            tags: {},
            createdAt: stats.birthtime,
            updatedAt: stats.mtime
          })
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to scan directory ${dirPath}`, error as Error)
    }

    return files
  }

  async upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile> {
    // F3 design-lock G1: the physical key is SERVER-generated. The client-supplied `options.path` NEVER
    // decides the physical layout (that was F3-1: `../` traversal + same-name overwrite via a client
    // path/filename); `options.filename` survives only as a display-only safe basename and in `url`.
    // key = `<uuid>/<safeBasename>` — the uuid directory is unique so two uploads of the same name can
    // never collide, and the id IS that uuid (deterministically recoverable from the key's parent
    // segment), which is what lets a restart / new instance re-locate the object by DB `storage_key`
    // without the drifting md5 disk-scan index (F3-2).
    const displayName = options.filename || this.generateFilename()
    const safeBasename = toSafeStorageBasename(displayName)
    const uuid = this.generateUniqueFileId()
    const storageKey = `${uuid}/${safeBasename}`
    // G2: containment hard floor even though the key is server-generated (defense in depth).
    const fullPath = resolveWithinBase(this.basePath, storageKey)
    const fileId = uuid

    try {
      // 确保目录存在
      await fs.mkdir(path.dirname(fullPath), { recursive: true })

      // 写入文件 — G2: exclusive create (`wx`) on BOTH the Buffer and the stream-concat branch. The
      // uuid directory makes a collision impossible in practice; `wx` is the belt-and-suspenders that
      // turns any theoretical collision into a hard error instead of a silent overwrite.
      let fileSize: number
      if (Buffer.isBuffer(file)) {
        await fs.writeFile(fullPath, file, { flag: 'wx' })
        fileSize = file.length
      } else {
        // 处理流
        const chunks: Buffer[] = []
        for await (const chunk of file) {
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        await fs.writeFile(fullPath, buffer, { flag: 'wx' })
        fileSize = buffer.length
      }

      const stats = await fs.stat(fullPath)
      const storageFile: StorageFile = {
        id: fileId,
        filename: displayName,
        size: fileSize,
        contentType: options.contentType || this.getContentType(displayName),
        path: storageKey,
        storageKey,
        url: `${this.baseUrl}/${storageKey}`,
        metadata: options.metadata || {},
        tags: options.tags || {},
        createdAt: stats.birthtime,
        updatedAt: stats.mtime
      }

      // 更新索引（进程内即时可用；重启后 id 查询走 DB storage_key，不依赖此索引 rebuild）
      this.fileIndex.set(fileId, storageFile)

      return storageFile
    } catch (error) {
      this.logger.error(`Failed to upload file ${displayName}`, error as Error)
      throw error
    }
  }

  // B3-07 §7: key-addressed write. Containment (G2) is asserted exactly as `downloadByKey`/`deleteByKey`
  // do, and the write is exclusive-create (`wx`) so a key collision is a hard error, never a silent
  // overwrite of another object. No index bookkeeping: by-key objects are located by their DB-recorded
  // key on every read/delete, which is the only cross-process-reliable addressing (see the interface note).
  async uploadByKey(storageKey: string, content: Buffer, _contentType?: string): Promise<void> {
    const fullPath = resolveWithinBase(this.basePath, storageKey)
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content, { flag: 'wx' })
    } catch (error) {
      this.logger.error(`Failed to upload file by key ${storageKey}`, error as Error)
      throw error
    }
  }

  async download(fileId: string): Promise<Buffer> {
    const fileInfo = this.fileIndex.get(fileId)
    if (!fileInfo) {
      throw new Error('File not found')
    }

    const fullPath = resolveWithinBase(this.basePath, fileInfo.path)

    try {
      return await fs.readFile(fullPath)
    } catch (error) {
      this.logger.error(`Failed to download file ${fileId}`, error as Error)
      throw error
    }
  }

  // F3 design-lock G3: read a physical object by its deterministic storage key (from the DB
  // `storage_key`/`storage_path` column), bypassing the in-memory `fileIndex` entirely. This is the
  // read path that has no warmup window — a freshly constructed provider whose `buildFileIndex()` has
  // not populated (or will never populate) this id still serves the object, because the key alone
  // deterministically locates it. Containment is re-asserted (G2) so a corrupt/legacy/url-derived key
  // can never escape the base path.
  async downloadByKey(storageKey: string): Promise<Buffer> {
    const fullPath = resolveWithinBase(this.basePath, storageKey)
    try {
      return await fs.readFile(fullPath)
    } catch (error) {
      this.logger.error(`Failed to download file by key ${storageKey}`, error as Error)
      throw error
    }
  }

  // F5 files-orphan-blob-retention design-lock (2026-07-10), GF5-2: delete a physical object by its
  // deterministic storage key. Containment (G2) is re-asserted first, exactly like `downloadByKey` —
  // a corrupt/legacy/derived key can never unlink outside the base path. ENOENT is swallowed (the
  // object is already gone, which IS the target state) so both the delete route (GF5-7) and the sweep
  // (GF5-6) can treat "deleted" and "confirmed already deleted" as one successful outcome and stamp
  // `blob_purged_at` either way — this is the ONLY place that ENOENT-as-success decision is made; every
  // caller of `deleteByKey` sees a plain resolve/reject and does not need to re-inspect the error code.
  // Any OTHER error (EACCES/EIO/etc.) is rethrown so callers leave `blob_purged_at` unset and retry.
  async deleteByKey(storageKey: string): Promise<void> {
    const fullPath = resolveWithinBase(this.basePath, storageKey)
    try {
      await fs.unlink(fullPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return
      }
      this.logger.error(`Failed to delete file by key ${storageKey}`, error as Error)
      throw error
    }
  }

  async delete(fileId: string): Promise<void> {
    const fileInfo = this.fileIndex.get(fileId)
    if (!fileInfo) {
      throw new Error('File not found')
    }

    const fullPath = path.join(this.basePath, fileInfo.path)

    try {
      await fs.unlink(fullPath)
      this.fileIndex.delete(fileId)
    } catch (error) {
      this.logger.error(`Failed to delete file ${fileId}`, error as Error)
      throw error
    }
  }

  async exists(fileId: string): Promise<boolean> {
    return this.fileIndex.has(fileId)
  }

  async getFileInfo(fileId: string): Promise<StorageFile | null> {
    return this.fileIndex.get(fileId) || null
  }

  async getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string> {
    const fileInfo = this.fileIndex.get(fileId)
    if (!fileInfo) {
      throw new Error('File not found')
    }

    let url = fileInfo.url || `${this.baseUrl}/files/${fileId}`

    if (options) {
      const params = new URLSearchParams()
      if (options.download) params.append('download', '1')
      if (options.inline) params.append('inline', '1')
      if (options.expiresIn) params.append('expires', (Date.now() + options.expiresIn * 1000).toString())

      if (params.toString()) {
        url += '?' + params.toString()
      }
    }

    return url
  }

  async getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload> {
    const fileId = this.generateUniqueFileId()
    const uploadPath = `/upload/${fileId}`

    // 对于本地存储，我们返回一个上传端点
    const fields: Record<string, string> = {
      filename: options.filename,
      maxSize: options.maxSize?.toString() || '',
      expiresAt: (Date.now() + (options.expiresIn || 3600) * 1000).toString()
    }
    if (options.contentType) {
      fields.contentType = options.contentType
    }
    return {
      uploadUrl: `${this.baseUrl}${uploadPath}`,
      fileId,
      fields
    }
  }

  async createFolder(dirPath: string): Promise<void> {
    const fullPath = path.join(this.basePath, dirPath)
    try {
      await fs.mkdir(fullPath, { recursive: true })
    } catch (error) {
      this.logger.error(`Failed to create folder ${dirPath}`, error as Error)
      throw error
    }
  }

  async deleteFolder(dirPath: string, recursive?: boolean): Promise<void> {
    const fullPath = path.join(this.basePath, dirPath)

    try {
      if (recursive) {
        await fs.rm(fullPath, { recursive: true, force: true })
        // 从索引中移除相关文件
        const entriesToDelete: string[] = []
        for (const [fileId, fileInfo] of this.fileIndex.entries()) {
          if (fileInfo.path.startsWith(dirPath)) {
            entriesToDelete.push(fileId)
          }
        }
        for (const fileId of entriesToDelete) {
          this.fileIndex.delete(fileId)
        }
      } else {
        await fs.rmdir(fullPath)
      }
    } catch (error) {
      this.logger.error(`Failed to delete folder ${dirPath}`, error as Error)
      throw error
    }
  }

  async getStorageUsage(): Promise<StorageUsage> {
    const files = Array.from(this.fileIndex.values())
    const totalSize = files.reduce((sum, file) => sum + file.size, 0)

    return {
      totalFiles: files.length,
      totalSize,
      usedQuota: totalSize,
      availableQuota: -1 // 本地存储没有配额限制
    }
  }

  private generateFileId(filePath: string): string {
    return crypto.createHash('md5').update(filePath).digest('hex')
  }

  private generateUniqueFileId(): string {
    return crypto.randomUUID()
  }

  /**
   * F3 design-lock G4: recover the stable id from a relative path. The F3 layout is
   * `<uuid>/<safeBasename>`, so the first segment — when it is a well-formed uuid AND a subdirectory
   * exists — is the id assigned at upload time (deterministic, no md5 drift). Legacy flat files keep
   * the historical `md5(relpath)`.
   */
  private deriveIdFromRelativePath(relativePath: string): string {
    const normalized = relativePath.split(path.sep).join('/')
    const slash = normalized.indexOf('/')
    if (slash > 0) {
      const first = normalized.slice(0, slash)
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first)) {
        return first
      }
    }
    return this.generateFileId(relativePath)
  }

  private generateFilename(): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    return `file_${timestamp}_${random}`
  }

  private getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }

    return mimeTypes[ext] || 'application/octet-stream'
  }
}

/**
 * 统一存储服务实现
 */
export class StorageServiceImpl extends EventEmitter implements StorageService {
  private provider: StorageProvider
  private logger: Logger
  private uploadLimit: number = 100 * 1024 * 1024 // 100MB 默认限制

  constructor(provider: StorageProvider, uploadLimit?: number) {
    super()
    this.provider = provider
    this.logger = new Logger('StorageService')
    if (uploadLimit) {
      this.uploadLimit = uploadLimit
    }
  }

  async upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile> {
    try {
      // 检查文件大小（如果是 Buffer）
      if (Buffer.isBuffer(file) && file.length > this.uploadLimit) {
        throw new Error(`File size exceeds limit of ${this.uploadLimit} bytes`)
      }

      const result = await this.provider.upload(file, options)
      this.emit('file:uploaded', result)
      return result
    } catch (error) {
      this.logger.error('Failed to upload file', error as Error)
      this.emit('file:error', { operation: 'upload', error })
      throw error
    }
  }

  async download(fileId: string): Promise<Buffer> {
    try {
      const result = await this.provider.download(fileId)
      this.emit('file:downloaded', { fileId, size: result.length })
      return result
    } catch (error) {
      this.logger.error(`Failed to download file: ${fileId}`, error as Error)
      this.emit('file:error', { operation: 'download', fileId, error })
      throw error
    }
  }

  // B3-07 §7: key-addressed write (the write-side counterpart of `downloadByKey`). Size-limited like
  // `upload`, so a by-key caller cannot bypass the service's upload cap.
  async uploadByKey(storageKey: string, content: Buffer, contentType?: string): Promise<void> {
    if (content.length > this.uploadLimit) {
      throw new Error(`File size exceeds limit of ${this.uploadLimit} bytes`)
    }
    try {
      await this.provider.uploadByKey(storageKey, content, contentType)
      this.emit('file:uploaded', { fileId: storageKey, size: content.length })
    } catch (error) {
      this.logger.error(`Failed to upload file by key: ${storageKey}`, error as Error)
      this.emit('file:error', { operation: 'upload', fileId: storageKey, error })
      throw error
    }
  }

  // F3 design-lock G3: read a physical object by its deterministic storage key (DB `storage_key` /
  // `storage_path`), bypassing the provider's in-memory index. Used by files.ts + multitable download
  // so a restart / cold index never 404s a still-present object.
  async downloadByKey(storageKey: string): Promise<Buffer> {
    try {
      const result = await this.provider.downloadByKey(storageKey)
      this.emit('file:downloaded', { fileId: storageKey, size: result.length })
      return result
    } catch (error) {
      this.logger.error(`Failed to download file by key: ${storageKey}`, error as Error)
      this.emit('file:error', { operation: 'download', fileId: storageKey, error })
      throw error
    }
  }

  async delete(fileId: string): Promise<void> {
    try {
      await this.provider.delete(fileId)
      this.emit('file:deleted', { fileId })
    } catch (error) {
      this.logger.error(`Failed to delete file: ${fileId}`, error as Error)
      this.emit('file:error', { operation: 'delete', fileId, error })
      throw error
    }
  }

  // F5 design-lock GF5-2: delete a physical object by its deterministic storage key (DB `storage_key`),
  // bypassing the provider's in-memory index. Used by files.ts's delete route (GF5-7, the root-cause fix
  // for the id-drift `storage.delete(id)` had) and the orphan-blob sweep (GF5-6).
  async deleteByKey(storageKey: string): Promise<void> {
    try {
      await this.provider.deleteByKey(storageKey)
      // F6 note (refs #3925): on this byKey path `fileId` actually carries the storage key, not a uuid
      // (the caller never resolved one). `file:deleted` has zero listeners in-repo today (only
      // `file:uploaded` is consumed, by plugin-service-factory.ts), so this is currently inert either way.
      this.emit('file:deleted', { fileId: storageKey })
    } catch (error) {
      this.logger.error(`Failed to delete file by key: ${storageKey}`, error as Error)
      this.emit('file:error', { operation: 'delete', fileId: storageKey, error })
      throw error
    }
  }

  async exists(fileId: string): Promise<boolean> {
    return this.provider.exists(fileId)
  }

  async getFileInfo(fileId: string): Promise<StorageFile | null> {
    return this.provider.getFileInfo(fileId)
  }

  async getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string> {
    return this.provider.getFileUrl(fileId, options)
  }

  async getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload> {
    return this.provider.getPresignedUploadUrl(options)
  }

  async uploadMultiple(files: Array<{file: Buffer | Readable, options: UploadOptions}>): Promise<StorageFile[]> {
    try {
      const results = await Promise.all(
        files.map(({ file, options }) => this.upload(file, options))
      )
      this.emit('files:uploaded:bulk', { count: results.length })
      return results
    } catch (error) {
      this.logger.error('Failed to upload multiple files', error as Error)
      throw error
    }
  }

  async deleteMultiple(fileIds: string[]): Promise<void> {
    try {
      await Promise.all(fileIds.map(fileId => this.delete(fileId)))
      this.emit('files:deleted:bulk', { count: fileIds.length })
    } catch (error) {
      this.logger.error('Failed to delete multiple files', error as Error)
      throw error
    }
  }

  async createFolder(path: string): Promise<void> {
    try {
      await this.provider.createFolder(path)
      this.emit('folder:created', { path })
    } catch (error) {
      this.logger.error(`Failed to create folder: ${path}`, error as Error)
      this.emit('folder:error', { operation: 'create', path, error })
      throw error
    }
  }

  async deleteFolder(path: string, recursive?: boolean): Promise<void> {
    try {
      await this.provider.deleteFolder(path, recursive)
      this.emit('folder:deleted', { path, recursive })
    } catch (error) {
      this.logger.error(`Failed to delete folder: ${path}`, error as Error)
      this.emit('folder:error', { operation: 'delete', path, error })
      throw error
    }
  }

  async getStorageUsage(): Promise<StorageUsage> {
    return this.provider.getStorageUsage()
  }

  /**
   * 设置上传大小限制
   */
  setUploadLimit(limit: number): void {
    this.uploadLimit = limit
  }

  /**
   * 获取上传大小限制
   */
  getUploadLimit(): number {
    return this.uploadLimit
  }

  /**
   * 创建本地存储服务
   */
  static createLocalService(basePath: string, baseUrl?: string): StorageServiceImpl {
    return new StorageServiceImpl(new LocalStorageProvider(basePath, baseUrl))
  }
}

export { LocalStorageProvider }
