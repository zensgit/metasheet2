/**
 * Files Router
 * Handles file upload and download endpoints
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { Logger } from '../core/logger'
import { StorageServiceImpl } from '../services/StorageService'
import * as path from 'path'
import { loadMulter, createUploadMiddleware } from '../types/multer'
import type { RequestWithFiles } from '../types/multer'

const logger = new Logger('FilesRouter')

// Storage service singleton - initialized lazily
let storageService: StorageServiceImpl | null = null

function getStorageService(): StorageServiceImpl {
  if (!storageService) {
    const storagePath = process.env.STORAGE_PATH || path.join(process.cwd(), 'uploads')
    const baseUrl = process.env.STORAGE_BASE_URL || 'http://localhost:8900/files'
    storageService = StorageServiceImpl.createLocalService(storagePath, baseUrl)
    logger.info(`Storage service initialized with path: ${storagePath}`)
  }
  return storageService
}

// Load multer and create upload middleware
const multer = loadMulter()
const upload = createUploadMiddleware(multer, { fileSize: 100 * 1024 * 1024 }) // 100MB limit

export function filesRouter(): Router {
  const r = Router()

  // Upload file
  r.post('/api/files/upload', authenticate, async (req: Request, res: Response) => {
    try {
      if (!upload) {
        return res.status(500).json({ error: 'File upload not available - multer not installed' })
      }

      // Handle multipart upload with multer middleware
      upload.single('file')(req, res, async (uploadErr: unknown) => {
        if (uploadErr) {
          logger.error('File upload middleware error', uploadErr instanceof Error ? uploadErr : undefined)
          return res.status(400).json({ error: 'File upload failed', details: String(uploadErr) })
        }

        try {
          const multerReq = req as RequestWithFiles
          const file = multerReq.file

          if (!file) {
            return res.status(400).json({ error: 'No file provided. Use "file" as the form field name.' })
          }

          const storage = getStorageService()
          const uploadPath = (req.body.path as string) || ''
          const userId = req.user?.sub || req.user?.userId || 'anonymous'

          const result = await storage.upload(file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
            path: uploadPath,
            metadata: {
              uploadedBy: userId,
              originalName: file.originalname
            }
          })

          logger.info(`File uploaded: ${result.id} by user ${userId}`)
          res.json({
            success: true,
            file: {
              id: result.id,
              filename: result.filename,
              size: result.size,
              contentType: result.contentType,
              url: result.url,
              createdAt: result.createdAt
            }
          })
        } catch (error) {
          logger.error('Failed to process uploaded file', error instanceof Error ? error : undefined)
          res.status(500).json({ error: 'Failed to process uploaded file' })
        }
      })
    } catch (error) {
      logger.error('Failed to upload file', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to upload file' })
    }
  })

  // Download file
  r.get('/api/files/:id/download', authenticate, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const storage = getStorageService()

      // Check if file exists
      const fileInfo = await storage.getFileInfo(id)
      if (!fileInfo) {
        return res.status(404).json({ error: 'File not found' })
      }

      // Download file content
      const buffer = await storage.download(id)

      // Set headers for download
      res.setHeader('Content-Type', fileInfo.contentType || 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileInfo.filename || 'download')}"`)
      res.setHeader('Content-Length', buffer.length)

      logger.info(`File downloaded: ${id}`)
      res.send(buffer)
    } catch (error) {
      logger.error('Failed to download file', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to download file' })
    }
  })

  // Get file info
  r.get('/api/files/:id', authenticate, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const storage = getStorageService()

      const fileInfo = await storage.getFileInfo(id)
      if (!fileInfo) {
        return res.status(404).json({ error: 'File not found' })
      }

      // Get download URL
      const url = await storage.getFileUrl(id, { expiresIn: 3600 })

      res.json({
        id: fileInfo.id,
        filename: fileInfo.filename,
        size: fileInfo.size,
        contentType: fileInfo.contentType,
        path: fileInfo.path,
        url,
        metadata: fileInfo.metadata,
        createdAt: fileInfo.createdAt,
        updatedAt: fileInfo.updatedAt
      })
    } catch (error) {
      logger.error('Failed to get file info', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get file info' })
    }
  })

  // Delete file
  r.delete('/api/files/:id', authenticate, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const storage = getStorageService()

      // Check if file exists
      const exists = await storage.exists(id)
      if (!exists) {
        return res.status(404).json({ error: 'File not found' })
      }

      await storage.delete(id)
      const userId = req.user?.sub || req.user?.userId || 'anonymous'

      logger.info(`File deleted: ${id} by user ${userId}`)
      res.json({ success: true, id })
    } catch (error) {
      logger.error('Failed to delete file', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to delete file' })
    }
  })

  // List files (optional prefix filter)
  r.get('/api/files', authenticate, async (req: Request, res: Response) => {
    try {
      const storage = getStorageService()
      const prefix = req.query.prefix as string | undefined
      const limit = parseInt(req.query.limit as string) || 100
      const offset = parseInt(req.query.offset as string) || 0

      const files = await storage.listFiles(prefix, { limit, offset })

      res.json({
        data: files.map(f => ({
          id: f.id,
          filename: f.filename,
          size: f.size,
          contentType: f.contentType,
          path: f.path,
          createdAt: f.createdAt
        })),
        total: files.length,
        limit,
        offset
      })
    } catch (error) {
      logger.error('Failed to list files', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to list files' })
    }
  })

  // Get presigned upload URL (for direct client uploads)
  r.post('/api/files/presign', authenticate, async (req: Request, res: Response) => {
    try {
      const { filename, contentType, maxSize } = req.body

      if (!filename) {
        return res.status(400).json({ error: 'filename is required' })
      }

      const storage = getStorageService()
      const presigned = await storage.getPresignedUploadUrl({
        filename,
        contentType,
        maxSize,
        expiresIn: 3600
      })

      res.json({
        uploadUrl: presigned.uploadUrl,
        fileId: presigned.fileId,
        fields: presigned.fields
      })
    } catch (error) {
      logger.error('Failed to get presigned URL', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get presigned URL' })
    }
  })

  return r
}
