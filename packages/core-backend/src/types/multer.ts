/**
 * Multer type definitions
 * Shared types for optional multer dependency
 */

import type { Request, Response, RequestHandler } from 'express'

/**
 * Multer file interface for uploaded files
 */
export interface MulterFile {
  buffer: Buffer
  fieldname: string
  originalname: string
  encoding: string
  mimetype: string
  size: number
}

/**
 * Express request with optional multer file (single upload)
 */
export interface RequestWithFile extends Request {
  file?: MulterFile
}

/**
 * Express request with optional multer files (multiple uploads)
 */
export interface RequestWithFiles extends Request {
  file?: MulterFile
  files?: MulterFile[] | Record<string, MulterFile[]>
}

/**
 * Multer storage options
 */
export interface MulterOptions {
  storage: unknown
  limits?: {
    fileSize?: number
  }
}

/**
 * Multer instance with file middleware methods
 */
export interface MulterInstance {
  single: (fieldName: string) => RequestHandler
  array: (fieldName: string, maxCount?: number) => RequestHandler
}

/**
 * Multer constructor type
 */
export type MulterConstructor = {
  (options: MulterOptions): MulterInstance
  memoryStorage: () => unknown
}

/**
 * Load multer or return null if not installed
 */
export function loadMulter(): MulterConstructor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    return require('multer') as MulterConstructor
  } catch {
    // multer not installed
    return null
  }
}

/**
 * Create upload middleware (or no-op if multer not installed)
 */
export function createUploadMiddleware(
  multer: MulterConstructor | null,
  options: { fileSize?: number } = {}
): MulterInstance | null {
  if (!multer) return null
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.fileSize || 5 * 1024 * 1024 } // 5MB default
  })
}

/**
 * Create optional file upload middleware
 */
export function createOptionalUpload(
  upload: MulterInstance | null,
  fieldName: string = 'file'
): RequestHandler {
  if (upload) {
    return upload.single(fieldName)
  }
  return (_req: Request, _res: Response, next: () => void) => next()
}
