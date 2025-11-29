// @ts-nocheck
/**
 * 存储服务实现
 * 支持本地文件系统、AWS S3、阿里云OSS等多种存储后端
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { Readable } from 'stream'
import { EventEmitter } from 'eventemitter3'
import type {
  StorageService,
  StorageFile,
  UploadOptions,
  GetUrlOptions,
  PresignedUploadOptions,
  PresignedUpload,
  ListOptions,
  StorageUsage
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * 存储提供者接口
 */
interface StorageProvider {
  upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile>
  download(fileId: string): Promise<Buffer>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
  getFileInfo(fileId: string): Promise<StorageFile | null>
  getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>
  getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>
  listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]>
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
          const fileId = this.generateFileId(currentRelativePath)

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
    const filename = options.filename || this.generateFilename()
    const filePath = options.path ? path.join(options.path, filename) : filename
    const fullPath = path.join(this.basePath, filePath)
    const fileId = options.overwrite ? this.generateFileId(filePath) : this.generateUniqueFileId()

    try {
      // 确保目录存在
      await fs.mkdir(path.dirname(fullPath), { recursive: true })

      // 检查是否覆盖
      if (!options.overwrite && await this.exists(fileId)) {
        throw new Error('File already exists and overwrite is not allowed')
      }

      // 写入文件
      let fileSize: number
      if (Buffer.isBuffer(file)) {
        await fs.writeFile(fullPath, file)
        fileSize = file.length
      } else {
        // 处理流
        const chunks: Buffer[] = []
        for await (const chunk of file) {
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        await fs.writeFile(fullPath, buffer)
        fileSize = buffer.length
      }

      const stats = await fs.stat(fullPath)
      const storageFile: StorageFile = {
        id: fileId,
        filename,
        size: fileSize,
        contentType: options.contentType || this.getContentType(filename),
        path: filePath,
        url: `${this.baseUrl}/${filePath}`,
        metadata: options.metadata || {},
        tags: options.tags || {},
        createdAt: stats.birthtime,
        updatedAt: stats.mtime
      }

      // 更新索引
      this.fileIndex.set(fileId, storageFile)

      return storageFile
    } catch (error) {
      this.logger.error(`Failed to upload file ${filename}`, error as Error)
      throw error
    }
  }

  async download(fileId: string): Promise<Buffer> {
    const fileInfo = this.fileIndex.get(fileId)
    if (!fileInfo) {
      throw new Error('File not found')
    }

    const fullPath = path.join(this.basePath, fileInfo.path)

    try {
      return await fs.readFile(fullPath)
    } catch (error) {
      this.logger.error(`Failed to download file ${fileId}`, error as Error)
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

    let url = fileInfo.url

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
    return {
      uploadUrl: `${this.baseUrl}${uploadPath}`,
      fileId,
      fields: {
        filename: options.filename,
        contentType: options.contentType,
        maxSize: options.maxSize?.toString() || '',
        expiresAt: (Date.now() + (options.expiresIn || 3600) * 1000).toString()
      }
    }
  }

  async listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]> {
    let files = Array.from(this.fileIndex.values())

    // 应用前缀过滤
    if (prefix) {
      files = files.filter(file => file.path.startsWith(prefix))
    }

    // 应用过滤器
    if (options?.filter) {
      const filter = options.filter
      files = files.filter(file => {
        if (filter.contentType && file.contentType !== filter.contentType) return false
        if (filter.sizeMin && file.size < filter.sizeMin) return false
        if (filter.sizeMax && file.size > filter.sizeMax) return false
        if (filter.createdAfter && file.createdAt < filter.createdAfter) return false
        if (filter.createdBefore && file.createdAt > filter.createdBefore) return false
        return true
      })
    }

    // 排序
    if (options?.sortBy) {
      const sortBy = options.sortBy
      const sortOrder = options.sortOrder || 'asc'
      files.sort((a, b) => {
        let aValue: any = a[sortBy]
        let bValue: any = b[sortBy]

        if (sortBy === 'createdAt' || sortBy === 'updatedAt') {
          aValue = aValue.getTime()
          bValue = bValue.getTime()
        }

        const comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0
        return sortOrder === 'asc' ? comparison : -comparison
      })
    }

    // 分页
    const offset = options?.offset || 0
    const limit = options?.limit || files.length
    return files.slice(offset, offset + limit)
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
        for (const [fileId, fileInfo] of this.fileIndex.entries()) {
          if (fileInfo.path.startsWith(dirPath)) {
            this.fileIndex.delete(fileId)
          }
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
 * AWS S3 存储提供者（示例实现）
 */
class S3StorageProvider implements StorageProvider {
  private s3Client: any
  private bucket: string
  private region: string
  private logger: Logger

  constructor(s3Client: any, bucket: string, region: string) {
    this.s3Client = s3Client
    this.bucket = bucket
    this.region = region
    this.logger = new Logger('S3StorageProvider')
  }

  async upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile> {
    const key = options.path ? `${options.path}/${options.filename}` : options.filename || this.generateKey()

    try {
      let body: Buffer
      if (Buffer.isBuffer(file)) {
        body = file
      } else {
        const chunks: Buffer[] = []
        for await (const chunk of file) {
          chunks.push(chunk)
        }
        body = Buffer.concat(chunks)
      }

      const uploadParams = {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType || this.getContentType(key),
        Metadata: options.metadata || {},
        TagSet: Object.entries(options.tags || {}).map(([Key, Value]) => ({ Key, Value }))
      }

      const result = await this.s3Client.upload(uploadParams).promise()

      const fileInfo: StorageFile = {
        id: key,
        filename: path.basename(key),
        size: body.length,
        contentType: uploadParams.ContentType,
        path: key,
        url: result.Location,
        metadata: options.metadata || {},
        tags: options.tags || {},
        createdAt: new Date(),
        updatedAt: new Date()
      }

      return fileInfo
    } catch (error) {
      this.logger.error(`Failed to upload file to S3: ${key}`, error as Error)
      throw error
    }
  }

  async download(fileId: string): Promise<Buffer> {
    try {
      const params = {
        Bucket: this.bucket,
        Key: fileId
      }

      const result = await this.s3Client.getObject(params).promise()
      return result.Body
    } catch (error) {
      this.logger.error(`Failed to download file from S3: ${fileId}`, error as Error)
      throw error
    }
  }

  async delete(fileId: string): Promise<void> {
    try {
      const params = {
        Bucket: this.bucket,
        Key: fileId
      }

      await this.s3Client.deleteObject(params).promise()
    } catch (error) {
      this.logger.error(`Failed to delete file from S3: ${fileId}`, error as Error)
      throw error
    }
  }

  async exists(fileId: string): Promise<boolean> {
    try {
      const params = {
        Bucket: this.bucket,
        Key: fileId
      }

      await this.s3Client.headObject(params).promise()
      return true
    } catch (error: any) {
      if (error.code === 'NotFound') {
        return false
      }
      throw error
    }
  }

  async getFileInfo(fileId: string): Promise<StorageFile | null> {
    try {
      const params = {
        Bucket: this.bucket,
        Key: fileId
      }

      const result = await this.s3Client.headObject(params).promise()

      return {
        id: fileId,
        filename: path.basename(fileId),
        size: result.ContentLength,
        contentType: result.ContentType,
        path: fileId,
        url: `https://${this.bucket}.s3.${this.region}.amazonaws.com/${fileId}`,
        metadata: result.Metadata || {},
        tags: {},
        createdAt: new Date(result.LastModified),
        updatedAt: new Date(result.LastModified)
      }
    } catch (error: any) {
      if (error.code === 'NotFound') {
        return null
      }
      throw error
    }
  }

  async getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string> {
    const params = {
      Bucket: this.bucket,
      Key: fileId,
      Expires: options?.expiresIn || 3600
    }

    return this.s3Client.getSignedUrl('getObject', params)
  }

  async getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload> {
    const key = options.filename
    const params = {
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
      Expires: options.expiresIn || 3600
    }

    if (options.maxSize) {
      params['ContentLengthRange'] = [0, options.maxSize]
    }

    const uploadUrl = await this.s3Client.getSignedUrl('putObject', params)

    return {
      uploadUrl,
      fileId: key,
      fields: {
        'Content-Type': options.contentType
      }
    }
  }

  async listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]> {
    try {
      const params: any = {
        Bucket: this.bucket,
        MaxKeys: options?.limit || 1000
      }

      if (prefix) {
        params.Prefix = prefix
      }

      if (options?.offset) {
        // S3 doesn't support offset directly, would need continuation token logic
        // This is a simplified implementation
      }

      const result = await this.s3Client.listObjectsV2(params).promise()

      const files: StorageFile[] = result.Contents.map((obj: any) => ({
        id: obj.Key,
        filename: path.basename(obj.Key),
        size: obj.Size,
        contentType: this.getContentType(obj.Key),
        path: obj.Key,
        url: `https://${this.bucket}.s3.${this.region}.amazonaws.com/${obj.Key}`,
        metadata: {},
        tags: {},
        createdAt: new Date(obj.LastModified),
        updatedAt: new Date(obj.LastModified)
      }))

      return files
    } catch (error) {
      this.logger.error('Failed to list files from S3', error as Error)
      throw error
    }
  }

  async createFolder(dirPath: string): Promise<void> {
    // S3 doesn't have real folders, but we can create a placeholder object
    const key = dirPath.endsWith('/') ? dirPath : `${dirPath}/`

    try {
      const params = {
        Bucket: this.bucket,
        Key: key,
        Body: '',
        ContentType: 'application/x-directory'
      }

      await this.s3Client.upload(params).promise()
    } catch (error) {
      this.logger.error(`Failed to create folder in S3: ${dirPath}`, error as Error)
      throw error
    }
  }

  async deleteFolder(dirPath: string, recursive?: boolean): Promise<void> {
    if (!recursive) {
      // Just delete the folder marker
      await this.delete(dirPath.endsWith('/') ? dirPath : `${dirPath}/`)
      return
    }

    try {
      // List all objects with the prefix
      const listParams = {
        Bucket: this.bucket,
        Prefix: dirPath.endsWith('/') ? dirPath : `${dirPath}/`
      }

      const objects = await this.s3Client.listObjectsV2(listParams).promise()

      if (objects.Contents.length === 0) return

      // Delete all objects
      const deleteParams = {
        Bucket: this.bucket,
        Delete: {
          Objects: objects.Contents.map((obj: any) => ({ Key: obj.Key }))
        }
      }

      await this.s3Client.deleteObjects(deleteParams).promise()
    } catch (error) {
      this.logger.error(`Failed to delete folder from S3: ${dirPath}`, error as Error)
      throw error
    }
  }

  async getStorageUsage(): Promise<StorageUsage> {
    try {
      // This would require CloudWatch metrics or iterating all objects
      // For now, return placeholder values
      return {
        totalFiles: 0,
        totalSize: 0,
        usedQuota: 0,
        availableQuota: -1 // S3 has virtually unlimited storage
      }
    } catch (error) {
      this.logger.error('Failed to get S3 storage usage', error as Error)
      throw error
    }
  }

  private generateKey(): string {
    const timestamp = Date.now()
    const random = crypto.randomBytes(8).toString('hex')
    return `files/${timestamp}/${random}`
  }

  private getContentType(key: string): string {
    const ext = path.extname(key).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif'
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

  async listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]> {
    return this.provider.listFiles(prefix, options)
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

  /**
   * 创建 S3 存储服务
   */
  static createS3Service(s3Client: any, bucket: string, region: string): StorageServiceImpl {
    return new StorageServiceImpl(new S3StorageProvider(s3Client, bucket, region))
  }
}

export { LocalStorageProvider, S3StorageProvider }