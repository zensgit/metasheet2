import * as path from 'path'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { FILES_POISON_KEY_PREFIX, isPoisonedStorageKey } from './filesStorageKey'
import { StorageServiceImpl } from './StorageService'

/**
 * F5 files-orphan-blob-retention design-lock (2026-07-10).
 *
 * F2's tombstone-first `DELETE /api/files/:id` (`files.ts`) can leave a row `deleted_at`-tombstoned with
 * its physical blob still on disk — a genuine storage failure warns and moves on rather than retrying
 * inline (evidence integrity holds either way: the row is already invalidated for every consumer). This
 * module is the background compensating sweep that reconciles those class-(a) orphans: `deleted_at IS
 * NOT NULL` rows whose blob has not been confirmed physically purged.
 *
 * GF5-7 (the files.ts delete-route root-cause fix, `deleteByKey` instead of the index-keyed
 * `storage.delete(id)`) means the row-level `blob_purged_at` stamp already happens synchronously on the
 * common path — this sweep exists for the residual real-failure tail (permission errors, transient I/O)
 * and is deliberately NOT the primary mechanism.
 *
 * Skeleton copied from `multitable/attachment-orphan-retention.ts` (setInterval + unref, env-gated,
 * batch + clamp, schema-not-ready tolerant, no leader lock — see that file's header for the at-least-once
 * rationale, which applies identically here: `deleteByKey`'s ENOENT-as-success + the `blob_purged_at`
 * consume marker make a duplicate concurrent sweep harmless). The QUERY and the CONSUME MARKER are
 * intentionally NOT reused from that module — see GF5-1: `deleted_at` cannot double as this sweep's
 * "already processed" flag the way it does for attachment-orphan-retention, because F5's entry condition
 * IS `deleted_at IS NOT NULL` (a tombstone that, unlike an attachment row, is never cleared). Hence the
 * dedicated `blob_purged_at` column (`zzzz20260710150000_add_files_blob_purged_at.ts`).
 */

export type FilesOrphanBlobRetentionOptions = {
  graceHours?: number
  intervalMs?: number
  batchSize?: number
  logger?: Logger
  queryFn?: typeof query
  storage?: { deleteByKey(storageKey: string): Promise<void> }
}

type OrphanBlobRow = {
  id: string
  storage_key: string
}

type SharedKeyCountRow = {
  n: string | number
}

export type FilesOrphanBlobSweepResult = {
  inspected: number
  purged: number
  skipped: number
}

let defaultStorage: StorageServiceImpl | null = null

/** Mirrors `files.ts`'s `getStorageService()` construction exactly (same env vars, same defaults) so the
 * sweep's default storage points at the SAME physical root the upload/delete routes use. Lazy + memoized
 * like that singleton; overridable per-call via `options.storage` for tests. */
function getDefaultStorage(): StorageServiceImpl {
  if (!defaultStorage) {
    const storagePath = process.env.STORAGE_PATH || path.join(process.cwd(), 'uploads')
    const baseUrl = process.env.STORAGE_BASE_URL || 'http://localhost:8900/files'
    defaultStorage = StorageServiceImpl.createLocalService(storagePath, baseUrl)
  }
  return defaultStorage
}

function parseGraceHours(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 24
  // GF5-4: clamp [1h, 30d].
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

/** GF5-6: default OFF regardless of NODE_ENV — unlike attachment-orphan-retention (which defaults on in
 * production), F5 requires an explicit opt-in until it has run against real traffic. */
function isEnabled(): boolean {
  return process.env.FILES_ORPHAN_BLOB_RETENTION_ENABLED === 'true'
}

/**
 * Runs one sweep pass. DB-driven (never scans disk — see the design-lock's OUT section: class-(b)
 * no-DB-row orphans are explicitly not this sweep's job). Exported standalone (not just via
 * `startFilesOrphanBlobRetention`) so tests and an eventual manual-trigger admin endpoint can invoke a
 * single pass deterministically.
 */
export async function sweepOrphanFileBlobs(
  options: FilesOrphanBlobRetentionOptions = {},
): Promise<FilesOrphanBlobSweepResult> {
  const logger = options.logger ?? new Logger('FilesOrphanBlobRetention')
  const queryFn = options.queryFn ?? query
  const storage = options.storage ?? getDefaultStorage()
  const graceHours = options.graceHours ?? parseGraceHours(process.env.FILES_ORPHAN_BLOB_RETENTION_GRACE_HOURS)
  const batchSize = options.batchSize ?? parseBatchSize(process.env.FILES_ORPHAN_BLOB_RETENTION_BATCH_SIZE)

  try {
    // GF5-1 consume marker (`blob_purged_at IS NULL`) + GF5-4 grace (`deleted_at < now() - grace`) +
    // `storage_key IS NOT NULL` (GF5-3: a NULL key is never guessed at here — the files.ts delete route's
    // own url-fallback already had its one chance at resolution time; the sweep does not repeat that
    // fallback, it only acts on a persisted key). Active rows (`deleted_at IS NULL`) are structurally
    // excluded — GF5-5's entry condition IS the tombstone.
    //
    // F9 design-lock GF9-4 (owner CHANGES-REQUESTED P2-3): `NOT starts_with(storage_key, $3)` excludes
    // poisoned (`!f3-collision:`) rows at the SQL candidate stage, not just inside the loop below. Without
    // this, `ORDER BY deleted_at ASC LIMIT batchSize` can select a full batch of nothing but poison rows
    // (they satisfy every other predicate — non-null key, tombstoned, blob_purged_at forever NULL) and
    // starve out older-but-still-purgeable rows behind them (head-of-line blocking). `starts_with` (not
    // LIKE) needs no wildcard escaping and reads the prefix from the SAME constant `filesStorageKey.ts`
    // exports (`FILES_POISON_KEY_PREFIX`), not a literal, so the two can never drift apart. The in-loop
    // `isPoisonedStorageKey` skip below is KEPT as belt-and-suspenders (the unit-test mock queryFn does
    // not execute this WHERE clause, so that test coverage still depends on the in-loop branch).
    const rows = await queryFn<OrphanBlobRow>(
      `SELECT id, storage_key
         FROM files
        WHERE deleted_at IS NOT NULL
          AND blob_purged_at IS NULL
          AND storage_key IS NOT NULL
          AND NOT starts_with(storage_key, $3)
          AND deleted_at < now() - make_interval(hours => $1)
        ORDER BY deleted_at ASC
        LIMIT $2`,
      [graceHours, batchSize, FILES_POISON_KEY_PREFIX],
    )

    let purged = 0
    let skipped = 0

    for (const row of rows.rows) {
      const id = String(row.id)
      const storageKey = String(row.storage_key)

      // GF5-3: a poisoned (`!f3-collision:`) key is a migration-quarantined collision-group sentinel —
      // the same physical blob may still be referenced by another un-purged row in that group. Never
      // resolve or delete it here; leave `blob_purged_at` NULL forever for this row (a deliberate
      // terminal state, not a bug — poison rows are human-reconciliation territory, out of F5's scope).
      if (isPoisonedStorageKey(storageKey)) {
        skipped += 1
        logger.warn(`Orphan blob sweep skipped poisoned storage_key for file ${id}`)
        continue
      }

      // GF5-3b defense in depth: belt-and-suspenders confirmation that no OTHER un-purged row still
      // references this exact key before physically deleting it. The active-row partial UNIQUE index
      // (F3) already makes "no two SERVABLE rows share a key" a DB invariant, but that index is scoped to
      // `deleted_at IS NULL` — it does not reach two TOMBSTONED rows that legacy-backfilled to the same
      // key. `>0` here means "skip, don't delete, don't stamp" — never a keep-one-winner race.
      try {
        const countResult = await queryFn<SharedKeyCountRow>(
          `SELECT count(*) AS n FROM files WHERE storage_key = $1 AND blob_purged_at IS NULL AND id <> $2`,
          [storageKey, id],
        )
        const sharedCount = Number(countResult.rows[0]?.n ?? 0)
        if (sharedCount > 0) {
          skipped += 1
          logger.warn(`Orphan blob sweep skipped file ${id}: storage_key still referenced by ${sharedCount} other un-purged row(s)`)
          continue
        }
      } catch (error) {
        skipped += 1
        logger.warn(`Orphan blob sweep skipped file ${id}: shared-key check failed`, error as Error)
        continue
      }

      // GF5-2/GF5-5: `deleteByKey` itself treats ENOENT (blob already gone) as a successful resolve —
      // this call site does not need to (and must not) special-case error codes; anything it catches here
      // is a genuine non-ENOENT failure (EACCES/EIO/etc.), which stays unstamped for a retry next tick.
      try {
        await storage.deleteByKey(storageKey)
      } catch (error) {
        skipped += 1
        logger.warn(`Orphan blob sweep failed to delete blob for file ${id}; will retry next tick`, error as Error)
        continue
      }

      await queryFn(
        `UPDATE files SET blob_purged_at = now() WHERE id = $1 AND blob_purged_at IS NULL`,
        [id],
      )
      purged += 1
    }

    if (purged > 0 || skipped > 0) {
      logger.info(`Files orphan blob sweep processed ${rows.rows.length} row(s), purged=${purged}, skipped=${skipped}`)
    }

    return { inspected: rows.rows.length, purged, skipped }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      logger.warn('Files orphan blob sweep skipped: files table not ready', error as Error)
      return { inspected: 0, purged: 0, skipped: 0 }
    }
    logger.warn('Files orphan blob sweep failed', error as Error)
    return { inspected: 0, purged: 0, skipped: 0 }
  }
}

export function startFilesOrphanBlobRetention(options: FilesOrphanBlobRetentionOptions = {}): () => void {
  if (!isEnabled()) return () => {}

  const logger = options.logger ?? new Logger('FilesOrphanBlobRetention')
  const intervalMs = options.intervalMs ?? parseIntervalMs(process.env.FILES_ORPHAN_BLOB_RETENTION_INTERVAL_MS)
  const graceHours = options.graceHours ?? parseGraceHours(process.env.FILES_ORPHAN_BLOB_RETENTION_GRACE_HOURS)
  const batchSize = options.batchSize ?? parseBatchSize(process.env.FILES_ORPHAN_BLOB_RETENTION_BATCH_SIZE)

  let stopped = false

  async function runOnce(): Promise<void> {
    if (stopped) return
    await sweepOrphanFileBlobs({
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

  logger.info(`Files orphan blob retention started (graceHours=${graceHours}, intervalMs=${intervalMs}, batchSize=${batchSize})`)

  return () => {
    stopped = true
    clearInterval(timer)
    logger.info('Files orphan blob retention stopped')
  }
}
