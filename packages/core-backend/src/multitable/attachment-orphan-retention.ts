import * as fs from 'fs/promises'
import * as path from 'path'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { resolveWithinBase } from '../services/StorageService'

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

// F10 design-lock (2026-07-11), GF10-1 — owner P1 finding: this base MUST be read lazily (call-time, not
// module-load-time) so `resolveWithinBase` below is exercised against whatever `ATTACHMENT_PATH` is
// active when the deleter actually runs (tests included) — a frozen module-load constant would silently
// re-introduce an untestable default. No production behavior change: `ATTACHMENT_PATH` is set before the
// process starts either way.
function getDefaultAttachmentPath(): string {
  return process.env.ATTACHMENT_PATH || path.join(process.cwd(), 'data', 'attachments')
}

// F10 design-lock (2026-07-11), GF10-1 — owner P1 root-escape fix: F9 introduced these default deleters
// with a bare `path.join(base, storagePath)`, which lets a `storagePath` containing `../` (malformed,
// corrupt, or legacy data) resolve OUTSIDE the attachment storage root before `fs.unlink` — deleting an
// arbitrary file on the host. `resolveWithinBase` (the same containment floor F3 already enforces for
// `files.ts`/`StorageService.ts`) throws instead of resolving once the escape is detected. Containment:
// NEVER unlink a path outside the storage base — no exceptions, no join fallback.
async function deleteLocalAttachment(_storageFileId: string, storagePath: string): Promise<void> {
  const fullPath = resolveWithinBase(getDefaultAttachmentPath(), storagePath)
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

      // F9 design-lock GF9-2 ⚠ connected change (owner CHANGES-REQUESTED P2-1②): also stamp
      // `blob_purged_at` here. This draft sweep already deletes the blob by `storage_path` (index-free,
      // no drift) before tombstoning the row, so the physical delete IS confirmed at this point — without
      // this stamp, the row would flip `deleted_at` NULL→NOT NULL and immediately become a fresh candidate
      // for `sweepMultitableAttachmentBlobPurge` (`deleted_at IS NOT NULL AND blob_purged_at IS NULL`),
      // re-attempting an already-done delete on every future tick.
      await queryFn(
        `UPDATE multitable_attachments
            SET deleted_at = now(),
                updated_at = now(),
                blob_purged_at = now()
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

// ---------------------------------------------------------------------------
// F9 design-lock GF9-2 (owner CHANGES-REQUESTED P2-1②, Option A — full F5 alignment): the compensating
// sweep for NORMALLY soft-deleted attachment rows whose blob-delete may have failed. Unlike the
// draft-orphan sweep above (which only ever covers rows NEVER attached to a record, `record_id IS NULL
// AND deleted_at IS NULL`), this covers rows already tombstoned by the interactive delete path
// (`multitable/attachment-service.ts`'s `deleteAttachmentBinary`, GF9-1/GF9-2) whose blob purge is still
// unconfirmed: `deleted_at IS NOT NULL AND blob_purged_at IS NULL`.
//
// Deliberately simpler than F5's `services/files-orphan-blob-retention.ts`: `storage_path` is NOT NULL on
// every `multitable_attachments` row (no null-key exclusion needed), multitable has no poison-quarantine
// concept (F3's collision handling is files-specific), and `storage_path` is a per-upload uuid path (no
// shared-key collision risk) — none of F5's three defensive layers (null-key filter, poison filter,
// shared-key COUNT) apply here, so the sweep is the plain form: select, delete-by-key (ENOENT-as-success
// via `isMissingStorageFile`, matching the draft sweep just above), stamp.
//
// Gated by its OWN env prefix (`MULTITABLE_ATTACHMENT_BLOB_RETENTION_*`), default OFF — the same explicit
// opt-in posture as F5 (GF5-6), deliberately NOT reusing `MULTITABLE_ATTACHMENT_CLEANUP_ENABLED` (which
// defaults ON in production for the pre-existing draft-orphan sweep above): this sweep performs a NEW
// physical-delete against rows that were already tombstoned through the normal interactive-delete path,
// and must not silently start deleting blobs on the next production deploy.
// ---------------------------------------------------------------------------

export type MultitableAttachmentBlobPurgeOptions = {
  graceHours?: number
  intervalMs?: number
  batchSize?: number
  logger?: Logger
  queryFn?: typeof query
  storage?: {
    deleteByKey(storagePath: string): Promise<void>
  }
}

type AttachmentBlobPurgeRow = {
  id: string
  storage_path: string
}

export type MultitableAttachmentBlobPurgeResult = {
  inspected: number
  purged: number
  skipped: number
}

// F10 design-lock (2026-07-11), GF10-1 — owner P1 root-escape fix (same containment floor as
// `deleteLocalAttachment` above): never unlink a path outside the storage base.
async function deleteLocalAttachmentByKey(storagePath: string): Promise<void> {
  const fullPath = resolveWithinBase(getDefaultAttachmentPath(), storagePath)
  await fs.unlink(fullPath)
}

function isBlobPurgeEnabled(): boolean {
  return process.env.MULTITABLE_ATTACHMENT_BLOB_RETENTION_ENABLED === 'true'
}

/**
 * Runs one compensating-purge pass. Exported standalone (not just via
 * `startMultitableAttachmentBlobPurge`) so tests can invoke a single pass deterministically.
 */
export async function sweepMultitableAttachmentBlobPurge(
  options: MultitableAttachmentBlobPurgeOptions = {},
): Promise<MultitableAttachmentBlobPurgeResult> {
  const logger = options.logger ?? new Logger('MultitableAttachmentBlobPurge')
  const queryFn = options.queryFn ?? query
  const storage = options.storage ?? { deleteByKey: deleteLocalAttachmentByKey }
  const graceHours = options.graceHours ?? parseRetentionHours(process.env.MULTITABLE_ATTACHMENT_BLOB_RETENTION_GRACE_HOURS)
  const batchSize = options.batchSize ?? parseBatchSize(process.env.MULTITABLE_ATTACHMENT_BLOB_RETENTION_BATCH_SIZE)

  try {
    // GF9-2 consume marker (`blob_purged_at IS NULL`) + grace (`deleted_at < now() - grace`). Active rows
    // (`deleted_at IS NULL`) are structurally excluded — the entry condition IS the tombstone, exactly
    // like F5's sweep for `files`.
    const rows = await queryFn<AttachmentBlobPurgeRow>(
      `SELECT id, storage_path
         FROM multitable_attachments
        WHERE deleted_at IS NOT NULL
          AND blob_purged_at IS NULL
          AND deleted_at < now() - make_interval(hours => $1)
        ORDER BY deleted_at ASC
        LIMIT $2`,
      [graceHours, batchSize],
    )

    let purged = 0
    let skipped = 0

    for (const row of rows.rows) {
      const id = String(row.id)
      const storagePath = String(row.storage_path)

      try {
        await storage.deleteByKey(storagePath)
      } catch (error) {
        if (!isMissingStorageFile(error)) {
          skipped += 1
          logger.warn(`Attachment blob purge sweep failed to delete blob for attachment ${id}; will retry next tick`, error as Error)
          continue
        }
        // ENOENT (blob already gone) is treated as success, same as the draft sweep and F5's deleteByKey.
      }

      await queryFn(
        `UPDATE multitable_attachments SET blob_purged_at = now() WHERE id = $1 AND blob_purged_at IS NULL`,
        [id],
      )
      purged += 1
    }

    if (purged > 0 || skipped > 0) {
      logger.info(`Multitable attachment blob purge sweep processed ${rows.rows.length} row(s), purged=${purged}, skipped=${skipped}`)
    }

    return { inspected: rows.rows.length, purged, skipped }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      logger.warn('Multitable attachment blob purge sweep skipped: multitable_attachments not ready', error as Error)
      return { inspected: 0, purged: 0, skipped: 0 }
    }
    logger.warn('Multitable attachment blob purge sweep failed', error as Error)
    return { inspected: 0, purged: 0, skipped: 0 }
  }
}

export function startMultitableAttachmentBlobPurge(options: MultitableAttachmentBlobPurgeOptions = {}): () => void {
  if (!isBlobPurgeEnabled()) return () => {}

  const logger = options.logger ?? new Logger('MultitableAttachmentBlobPurge')
  const intervalMs = options.intervalMs ?? parseIntervalMs(process.env.MULTITABLE_ATTACHMENT_BLOB_RETENTION_INTERVAL_MS)
  const graceHours = options.graceHours ?? parseRetentionHours(process.env.MULTITABLE_ATTACHMENT_BLOB_RETENTION_GRACE_HOURS)
  const batchSize = options.batchSize ?? parseBatchSize(process.env.MULTITABLE_ATTACHMENT_BLOB_RETENTION_BATCH_SIZE)

  let stopped = false

  async function runOnce(): Promise<void> {
    if (stopped) return
    await sweepMultitableAttachmentBlobPurge({
      ...options,
      logger,
      graceHours,
      batchSize,
    })
  }

  void runOnce()

  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)

  timer.unref?.()

  logger.info(`Multitable attachment blob purge sweep started (graceHours=${graceHours}, intervalMs=${intervalMs}, batchSize=${batchSize})`)

  return () => {
    stopped = true
    clearInterval(timer)
    logger.info('Multitable attachment blob purge sweep stopped')
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
