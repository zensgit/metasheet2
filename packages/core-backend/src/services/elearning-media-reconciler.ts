/**
 * E-learning media stale-row claim + bounded orphan blob reconciliation.
 * Row is inserted before blob put. Closed statuses: uploading|probing|ready|rejected.
 * Stale uploading/probing rows are claimed to rejected in one CTE UPDATE … FOR UPDATE SKIP LOCKED.
 * Orphan cleanup deletes blobs older than grace only when the matching row is absent or rejected.
 * Missing ready blobs are counted only — keys are never returned or logged.
 */
import type { ElearningMediaQueryable } from './elearning-media-quota'
import {
  assertElearningMediaStorageKey,
  type ElearningMediaBlobPage,
  type ElearningMediaStore,
} from './elearning-media-storage'

export type { ElearningMediaBlobPage, ElearningMediaBlobRef } from './elearning-media-storage'

export const ELEARNING_MEDIA_STALE_MS = 60 * 60 * 1000
export const ELEARNING_MEDIA_ORPHAN_GRACE_MS = 60 * 60 * 1000
export const ELEARNING_MEDIA_RECONCILE_BATCH_SIZE = 250
export const ELEARNING_MEDIA_RECONCILE_MAX_BATCH_SIZE = 1_000

const LIVE_STATUSES = new Set(['uploading', 'probing', 'ready'])
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export interface ElearningMediaBlobSource {
  listPage(cursor: string | undefined, limit: number, now?: Date): Promise<ElearningMediaBlobPage>
  hasBlob(storageKey: string): Promise<boolean>
}

export interface ElearningMediaReconcileCursor {
  blobCursor?: string
  rowCursor?: string
  blobComplete?: boolean
  rowComplete?: boolean
}

export interface ElearningMediaStaleCleanupResult {
  claimed: number
  deleted: number
  deleteFailed: number
}

export interface ElearningMediaReconcileResult {
  scannedBlobs: number
  deletedBlobs: number
  deleteFailed: number
  scannedRows: number
  missingReadyBlobs: number
  nextCursor?: ElearningMediaReconcileCursor
}

export interface ElearningMediaStaleCleanupOptions {
  now?: () => Date
  staleMs?: number
  batchSize?: number
}

export interface ElearningMediaReconcileOptions {
  now?: () => Date
  graceMs?: number
  maxBlobsPerPass?: number
  maxRowsPerPass?: number
  cursor?: ElearningMediaReconcileCursor
}

function readBatchSize(value: number | undefined, name: string): number {
  const resolved = value ?? ELEARNING_MEDIA_RECONCILE_BATCH_SIZE
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ELEARNING_MEDIA_RECONCILE_MAX_BATCH_SIZE) {
    throw new RangeError(`${name} must be a safe integer in [1, ${ELEARNING_MEDIA_RECONCILE_MAX_BATCH_SIZE}]`)
  }
  return resolved
}

function readNonNegativeMs(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return resolved
}

function resolveNow(now?: () => Date): Date {
  const value = (now ?? (() => new Date()))()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError('now must return a valid Date')
  }
  return value
}

function asStorageKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError('elearning media storage key is missing')
  }
  return assertElearningMediaStorageKey(value)
}

async function deleteQuietly(
  store: ElearningMediaStore,
  storageKey: string,
): Promise<'deleted' | 'failed'> {
  try {
    await store.delete(storageKey)
    return 'deleted'
  } catch {
    return 'failed'
  }
}

function keepBlob(statuses: Set<string> | undefined): boolean {
  if (!statuses || statuses.size === 0) return false
  for (const status of statuses) {
    if (LIVE_STATUSES.has(status)) return true
    if (status !== 'rejected') return true
  }
  return false
}

/**
 * Claim stale uploading/probing rows to rejected (one bounded CTE UPDATE with FOR UPDATE SKIP LOCKED),
 * then attempt idempotent blob deletes. Reports counts only; a delete failure stays recoverable.
 */
export async function reconcileStaleElearningMediaRows(
  db: ElearningMediaQueryable,
  store: ElearningMediaStore,
  opts: ElearningMediaStaleCleanupOptions = {},
): Promise<ElearningMediaStaleCleanupResult> {
  const now = resolveNow(opts.now)
  const staleMs = readNonNegativeMs(opts.staleMs, ELEARNING_MEDIA_STALE_MS, 'staleMs')
  const batchSize = readBatchSize(opts.batchSize, 'batchSize')
  const cutoff = new Date(now.getTime() - staleMs)

  const claimed = await db.query(
    `WITH stale AS MATERIALIZED (
       SELECT id, storage_key
         FROM elearning_media
        WHERE status IN ('uploading', 'probing')
          AND updated_at <= $1::timestamptz
        ORDER BY updated_at ASC, id ASC
        LIMIT $2::int
        FOR UPDATE SKIP LOCKED
     )
     UPDATE elearning_media AS media
        SET status = 'rejected',
            updated_at = $3::timestamptz
       FROM stale
      WHERE media.id = stale.id
        AND media.status IN ('uploading', 'probing')
     RETURNING stale.storage_key`,
    [cutoff.toISOString(), batchSize, now.toISOString()],
  )

  const result: ElearningMediaStaleCleanupResult = {
    claimed: claimed.rows.length,
    deleted: 0,
    deleteFailed: 0,
  }
  for (const row of claimed.rows) {
    try {
      const storageKey = asStorageKey(row.storage_key)
      await store.delete(storageKey)
      result.deleted += 1
    } catch {
      result.deleteFailed += 1
    }
  }
  return result
}

/**
 * Bounded cursor pass over the blob source (and ready rows). Each call advances at most one
 * source page and one DB keyset page. Callers persist nextCursor until it is absent.
 */
export async function reconcileElearningMediaBlobs(
  db: ElearningMediaQueryable,
  source: ElearningMediaBlobSource,
  store: ElearningMediaStore,
  opts: ElearningMediaReconcileOptions = {},
): Promise<ElearningMediaReconcileResult> {
  const now = resolveNow(opts.now)
  const graceMs = readNonNegativeMs(opts.graceMs, ELEARNING_MEDIA_ORPHAN_GRACE_MS, 'graceMs')
  const maxBlobs = readBatchSize(opts.maxBlobsPerPass, 'maxBlobsPerPass')
  const maxRows = readBatchSize(opts.maxRowsPerPass, 'maxRowsPerPass')
  const cursor = opts.cursor ?? {}
  const result: ElearningMediaReconcileResult = {
    scannedBlobs: 0,
    deletedBlobs: 0,
    deleteFailed: 0,
    scannedRows: 0,
    missingReadyBlobs: 0,
  }
  let blobComplete = cursor.blobComplete === true
  let rowComplete = cursor.rowComplete === true
  let nextBlobCursor = cursor.blobCursor
  let nextRowCursor = cursor.rowCursor

  if (!blobComplete) {
    const page = await source.listPage(cursor.blobCursor, maxBlobs, now)
    if (!page || !Array.isArray(page.blobs)) {
      throw new RangeError('elearning media blob source returned an invalid page')
    }
    if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') {
      throw new RangeError('elearning media blob source returned an invalid cursor')
    }
    if (page.blobs.length > maxBlobs) {
      throw new RangeError('elearning media blob source exceeded the requested page bound')
    }
    result.scannedBlobs = page.blobs.length

    const ages = new Map<string, number>()
    for (const blob of page.blobs) {
      if (!blob || typeof blob.key !== 'string' || blob.key.length === 0) {
        throw new RangeError('elearning media blob source returned an invalid key')
      }
      if (!Number.isSafeInteger(blob.ageMs) || blob.ageMs < 0) {
        throw new RangeError('elearning media blob source returned an invalid age')
      }
      const key = assertElearningMediaStorageKey(blob.key)
      const prev = ages.get(key)
      if (prev === undefined || blob.ageMs > prev) ages.set(key, blob.ageMs)
    }

    const keys = [...ages.keys()]
    const statusesByKey = new Map<string, Set<string>>()
    if (keys.length > 0) {
      const found = await db.query(
        `SELECT storage_key, status
           FROM elearning_media
          WHERE storage_key = ANY($1::text[])`,
        [keys],
      )
      for (const row of found.rows) {
        const key = String(row.storage_key ?? '')
        const status = String(row.status ?? '')
        let set = statusesByKey.get(key)
        if (!set) {
          set = new Set()
          statusesByKey.set(key, set)
        }
        set.add(status)
      }
    }

    for (const [key, ageMs] of ages) {
      if (ageMs < graceMs) continue
      if (keepBlob(statusesByKey.get(key))) continue
      const outcome = await deleteQuietly(store, key)
      if (outcome === 'deleted') result.deletedBlobs += 1
      else result.deleteFailed += 1
    }

    nextBlobCursor = page.nextCursor
    blobComplete = page.nextCursor === undefined
  }

  if (!rowComplete) {
    const { rows } = await db.query(
      `SELECT id, storage_key, status
         FROM elearning_media
        WHERE id > $1::uuid
          AND status = 'ready'
        ORDER BY id ASC
        LIMIT $2::int`,
      [cursor.rowCursor ?? NIL_UUID, maxRows],
    )
    if (rows.length > maxRows) {
      throw new RangeError('elearning media row page exceeded the requested bound')
    }
    result.scannedRows = rows.length
    for (const row of rows) {
      if (String(row.status ?? '') !== 'ready') continue
      const storageKey = asStorageKey(row.storage_key)
      if (!(await source.hasBlob(storageKey))) result.missingReadyBlobs += 1
    }
    rowComplete = rows.length < maxRows
    if (!rowComplete) {
      const lastId = rows[rows.length - 1]?.id
      if (typeof lastId !== 'string' || lastId.length === 0) {
        throw new RangeError('elearning media row page returned an invalid id')
      }
      nextRowCursor = lastId
    } else {
      nextRowCursor = undefined
    }
  }

  if (!(blobComplete && rowComplete)) {
    result.nextCursor = {
      ...(nextBlobCursor ? { blobCursor: nextBlobCursor } : {}),
      ...(nextRowCursor ? { rowCursor: nextRowCursor } : {}),
      ...(blobComplete ? { blobComplete: true } : {}),
      ...(rowComplete ? { rowComplete: true } : {}),
    }
  }
  return result
}
