/**
 * Files Router
 * Handles file upload and download endpoints
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { sql } from 'kysely'
import { authenticate } from '../middleware/auth'
import { Logger } from '../core/logger'
import { StorageServiceImpl } from '../services/StorageService'
import { db } from '../db/db'
import { sniffImageContentType } from '../services/imageMagicBytes'
import { getFilesRequestUserId, isFilesRequestAdmin, filesAclAllowsAccess, type FilesAclRow } from '../services/filesAcl'
import * as path from 'path'
import { loadMulter, createUploadMiddleware } from '../types/multer'
import type { RequestWithFiles } from '../types/multer'

const logger = new Logger('FilesRouter')

interface FilesOwnerRow {
  owner_id: string | null
}

interface FilesListRow {
  id: string
  url: string | null
  owner_id: string | null
  meta: Record<string, unknown> | null
  created_at: Date
}

/**
 * F1 files-acl-tombstone design-lock (2026-07-10): the single row lookup every ACL-gated endpoint
 * (list/info/download/delete) uses to decide ownership. `deleted_at IS NULL` makes a tombstoned row
 * (F2) read as "no active row" here too — the same filter list/info/download/delete's own
 * consumption paths apply, so a deleted file is uniformly invisible everywhere, not just to G2.
 */
async function loadActiveFileOwner(id: string): Promise<FilesAclRow | null> {
  const result = await sql<FilesOwnerRow>`
    SELECT owner_id FROM files WHERE id = ${id} AND deleted_at IS NULL
  `.execute(db)
  const row = result.rows[0]
  return row ? { ownerId: row.owner_id } : null
}

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
          const userId = getFilesRequestUserId(req)

          const result = await storage.upload(file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
            path: uploadPath,
            metadata: {
              uploadedBy: userId,
              originalName: file.originalname
            }
          })

          // S2 outdoor-punch-photo design-lock (2026-07-10), G2 substrate: the `files` table
          // (migration 035) previously had no writer anywhere — this INSERT is what makes a
          // fileId server-verifiable (owner + content-type) instead of a client-trusted string.
          // A row MUST exist for every successful upload response: if the INSERT fails, the
          // upload as a whole fails (storage object is rolled back) rather than returning
          // success with no corresponding row, which would make every downstream fileId
          // ownership/content-type check either wrongly reject a real upload or be unable to
          // tell a real id from a forged one.
          //
          // H2 photo-evidence-hardening design-lock (2026-07-10), P3-1: `contentType` above is
          // client-asserted (the multipart part's Content-Type header, trusted as-is by multer).
          // `sniffed: true` is written unconditionally on this path — it is a PATH MARKER, not a
          // content-type value: it tells a consumer "this row went through magic-byte sniffing",
          // distinguishing it from rows written before this slice (which never carry the key).
          // `sniffedContentType` is written ONLY when a magic-byte signature actually matched —
          // its own presence/absence still means exactly "did we detect an image", kept pure.
          // Never rejects the upload on a miss (this route is general-purpose; a resume PDF or a
          // CSV export is a legitimate non-image upload) — sniffing is advisory for downstream
          // consumers (attendance G2) to decide what a miss means in their own domain.
          const sniffedContentType = sniffImageContentType(file.buffer)
          try {
            await sql`
              INSERT INTO files (id, url, owner_id, meta, created_at)
              VALUES (
                ${result.id},
                ${result.url},
                ${userId},
                ${JSON.stringify({
                  contentType: result.contentType,
                  filename: result.filename,
                  size: result.size,
                  sniffed: true,
                  ...(sniffedContentType ? { sniffedContentType } : {})
                })}::jsonb,
                now()
              )
            `.execute(db)
          } catch (dbErr) {
            logger.error(`Failed to persist files row for uploaded file ${result.id}; rolling back upload`, dbErr instanceof Error ? dbErr : undefined)
            try {
              await storage.delete(result.id)
            } catch (cleanupErr) {
              logger.error(`Failed to clean up orphaned upload ${result.id} after files-row insert failure`, cleanupErr instanceof Error ? cleanupErr : undefined)
            }
            return res.status(500).json({ error: 'Failed to record uploaded file' })
          }

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

      // F1 files-acl-tombstone design-lock (2026-07-10): owner-or-admin, else 404 (not 403 — a 403
      // would confirm the id exists to a caller who isn't allowed to see it; 404 is indistinguishable
      // from a genuinely nonexistent id).
      const callerId = getFilesRequestUserId(req)
      const admin = await isFilesRequestAdmin(req)
      const row = await loadActiveFileOwner(id)
      if (!filesAclAllowsAccess({ admin, callerId, row })) {
        return res.status(404).json({ error: 'File not found' })
      }

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

      // F1 files-acl-tombstone design-lock (2026-07-10): owner-or-admin, else 404 (see rationale on
      // the download route above — same predicate, same anti-enumeration reasoning).
      const callerId = getFilesRequestUserId(req)
      const admin = await isFilesRequestAdmin(req)
      const row = await loadActiveFileOwner(id)
      if (!filesAclAllowsAccess({ admin, callerId, row })) {
        return res.status(404).json({ error: 'File not found' })
      }

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
      const callerId = getFilesRequestUserId(req)

      // F1 files-acl-tombstone design-lock (2026-07-10): owner-or-admin, else 404 (see rationale on
      // the download route above). This lookup also doubles as F2's "does an active row exist"
      // branch decision below — a caller who fails this gate never reaches storage either way.
      const admin = await isFilesRequestAdmin(req)
      const row = await loadActiveFileOwner(id)
      if (!filesAclAllowsAccess({ admin, callerId, row })) {
        return res.status(404).json({ error: 'File not found' })
      }

      const storage = getStorageService()

      if (row) {
        // F2 files-acl-tombstone design-lock (2026-07-10): tombstone-first delete order. The
        // previous order (storage.delete → `DELETE FROM files`) could split on a mid-operation
        // failure: storage succeeds, the row delete fails → the binary is gone but the row still
        // reads as valid evidence (exactly the dangling state H2 #4044 P3-2 was meant to close).
        // Tombstoning BEFORE touching storage means a DB failure here leaves storage completely
        // untouched (caught below, 5xx, nothing else runs), and once this succeeds every consumer
        // (G2's `deleted_at IS NULL` filter, this file's own list/info/download filters) treats the
        // id as gone regardless of what happens to the storage object next — there is no window
        // where the row still looks valid but the blob is gone.
        try {
          await sql`
            UPDATE files SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL
          `.execute(db)
        } catch (updateErr) {
          logger.error(`Failed to tombstone files row ${id}; storage object left untouched`, updateErr instanceof Error ? updateErr : undefined)
          return res.status(500).json({ error: 'Failed to delete file' })
        }

        try {
          await storage.delete(id)
        } catch (storageErr) {
          // The row is already tombstoned — evidence integrity holds (no consumer will ever see this
          // id as valid again) even if the underlying blob is still sitting in storage. That blob's
          // removal is a compensating cleanup (retry / manual sweep), deliberately not retried inline
          // here and not surfaced as a client-facing failure: from the caller's perspective the file
          // is gone, which is true from every consumer's point of view.
          logger.warn(`Storage delete failed for tombstoned file ${id}; blob left for compensating cleanup`, storageErr instanceof Error ? storageErr : undefined)
        }

        logger.info(`File deleted: ${id} by user ${callerId}`)
        return res.json({ success: true, id })
      }

      // No active `files` row for this id — a legacy object that predates the S2 writer (migration
      // 035 never had one either) or an id that was already fully processed by the branch above.
      // Unaffected by the tombstone change: unchanged pre-F2 behavior (storage-existence-gated
      // delete, no row to tombstone). Reaching this branch already required admin (a non-admin with
      // no matching row was rejected by the ACL gate above).
      const exists = await storage.exists(id)
      if (!exists) {
        return res.status(404).json({ error: 'File not found' })
      }
      await storage.delete(id)

      logger.info(`File deleted: ${id} by user ${callerId}`)
      res.json({ success: true, id })
    } catch (error) {
      logger.error('Failed to delete file', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to delete file' })
    }
  })

  // List files
  //
  // F1 files-acl-tombstone design-lock (2026-07-10): previously sourced from the storage provider's
  // own disk-scan index (`storage.listFiles`), which carries no owner attribution at all (a
  // filesystem scan has no concept of "who uploaded this"). Resource-level ACL requires an
  // owner-attributed source, so this now queries the `files` DB table (the row storage.listFiles
  // could never have provided) — non-admin callers see only their own active rows, admin sees all
  // active rows. `deleted_at IS NULL` for both (tombstoned rows are invisible here too, same as
  // info/download/delete). No known caller of this endpoint exists in this codebase today (grepped
  // frontend + backend + plugins — zero references outside this file and its own tests), so this
  // response-shape change (DB-row-derived, not disk-scan-derived; the old `path`/prefix-filter
  // concept doesn't carry over — `files` rows have no `path` column) carries no compatibility risk.
  r.get('/api/files', authenticate, async (req: Request, res: Response) => {
    try {
      const callerId = getFilesRequestUserId(req)
      const admin = await isFilesRequestAdmin(req)
      const limit = parseInt(req.query.limit as string) || 100
      const offset = parseInt(req.query.offset as string) || 0

      const result = admin
        ? await sql<FilesListRow>`
            SELECT id, url, owner_id, meta, created_at
            FROM files
            WHERE deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `.execute(db)
        : await sql<FilesListRow>`
            SELECT id, url, owner_id, meta, created_at
            FROM files
            WHERE deleted_at IS NULL AND owner_id = ${callerId} AND owner_id <> 'anonymous'
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `.execute(db)

      res.json({
        data: result.rows.map((row) => {
          const meta = (row.meta ?? {}) as Record<string, unknown>
          return {
            id: row.id,
            filename: typeof meta.filename === 'string' ? meta.filename : null,
            size: typeof meta.size === 'number' ? meta.size : null,
            contentType: typeof meta.contentType === 'string' ? meta.contentType : null,
            url: row.url,
            ownerId: row.owner_id,
            createdAt: row.created_at
          }
        }),
        total: result.rows.length,
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
