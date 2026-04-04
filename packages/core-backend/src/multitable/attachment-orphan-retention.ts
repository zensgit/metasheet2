import * as fs from 'fs/promises'
import * as path from 'path'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type MultitableAttachmentCleanupOptions = {
  retentionHours?: number
  intervalMs?: number
  batchSize?: number
  logger?: Logger
  queryFn?: typeof query
  storage?: {
    delete(storageFileId: string, storagePath: string): Promise<void>
  }
}

type AttachmentCleanupRow = {
  id: string
  storage_file_id: string
  storage_path: string
}

type AttachmentCleanupResult = {
  inspected: number
  deleted: number
  skipped: number
}

const DEFAULT_ATTACHMENT_PATH = process.env.ATTACHMENT_PATH || path.join(process.cwd(), 'data', 'attachments')

async function deleteLocalAttachment(_storageFileId: string, storagePath: string): Promise<void> {
  const fullPath = path.join(DEFAULT_ATTACHMENT_PATH, storagePath)
  await fs.unlink(fullPath)
}

function parseRetentionHours(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 24
  return Math.min(Math.max(Math.floor(parsed), 1), 24 * 30)
}

function parseIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 60 * 60 * 1000
  return Math.min(Math.max(Math.floor(parsed), 10_000), 24 * 60 * 60 * 1000)
}

function parseBatchSize(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 100
  return Math.min(Math.max(Math.floor(parsed), 1), 1000)
}

function isEnabled(): boolean {
  if (process.env.MULTITABLE_ATTACHMENT_CLEANUP_ENABLED) {
    return process.env.MULTITABLE_ATTACHMENT_CLEANUP_ENABLED === 'true'
  }
  return process.env.NODE_ENV === 'production'
}

function isMissingStorageFile(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message.includes('file not found') || message.includes('enoent')
}

export async function cleanupOrphanMultitableAttachments(
  options: MultitableAttachmentCleanupOptions = {},
): Promise<AttachmentCleanupResult> {
  const logger = options.logger ?? new Logger('MultitableAttachmentCleanup')
  const queryFn = options.queryFn ?? query
  const storage = options.storage ?? { delete: deleteLocalAttachment }
  const retentionHours = options.retentionHours ?? parseRetentionHours(process.env.MULTITABLE_ATTACHMENT_RETENTION_HOURS)
  const batchSize = options.batchSize ?? parseBatchSize(process.env.MULTITABLE_ATTACHMENT_CLEANUP_BATCH_SIZE)

  try {
    const rows = await queryFn<AttachmentCleanupRow>(
      `SELECT id, storage_file_id, storage_path
         FROM multitable_attachments
        WHERE record_id IS NULL
          AND deleted_at IS NULL
          AND created_at < now() - make_interval(hours => $1)
        ORDER BY created_at ASC
        LIMIT $2`,
      [retentionHours, batchSize],
    )

    let deleted = 0
    let skipped = 0

    for (const row of rows.rows) {
      try {
        await storage.delete(String(row.storage_file_id), String(row.storage_path))
      } catch (error) {
        if (!isMissingStorageFile(error)) {
          skipped += 1
          logger.warn(`Failed to delete orphan attachment storage ${row.storage_file_id}`, error as Error)
          continue
        }
      }

      await queryFn(
        `UPDATE multitable_attachments
            SET deleted_at = now(),
                updated_at = now()
          WHERE id = $1
            AND deleted_at IS NULL`,
        [row.id],
      )
      deleted += 1
    }

    if (deleted > 0 || skipped > 0) {
      logger.info(`Multitable attachment cleanup processed ${rows.rows.length} row(s), deleted=${deleted}, skipped=${skipped}`)
    }

    return {
      inspected: rows.rows.length,
      deleted,
      skipped,
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      logger.warn('Multitable attachment cleanup skipped: multitable_attachments not ready', error as Error)
      return { inspected: 0, deleted: 0, skipped: 0 }
    }
    logger.warn('Multitable attachment cleanup failed', error as Error)
    return { inspected: 0, deleted: 0, skipped: 0 }
  }
}

export function startMultitableAttachmentCleanup(options: MultitableAttachmentCleanupOptions = {}): () => void {
  if (!isEnabled()) return () => {}

  const logger = options.logger ?? new Logger('MultitableAttachmentCleanup')
  const intervalMs = options.intervalMs ?? parseIntervalMs(process.env.MULTITABLE_ATTACHMENT_CLEANUP_INTERVAL_MS)
  const retentionHours = options.retentionHours ?? parseRetentionHours(process.env.MULTITABLE_ATTACHMENT_RETENTION_HOURS)
  const batchSize = options.batchSize ?? parseBatchSize(process.env.MULTITABLE_ATTACHMENT_CLEANUP_BATCH_SIZE)

  let stopped = false

  async function runOnce(): Promise<void> {
    if (stopped) return
    await cleanupOrphanMultitableAttachments({
      ...options,
      logger,
      retentionHours,
      batchSize,
    })
  }

  void runOnce()

  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)

  timer.unref?.()

  logger.info(`Multitable attachment cleanup started (retentionHours=${retentionHours}, intervalMs=${intervalMs}, batchSize=${batchSize})`)

  return () => {
    stopped = true
    clearInterval(timer)
    logger.info('Multitable attachment cleanup stopped')
  }
}
