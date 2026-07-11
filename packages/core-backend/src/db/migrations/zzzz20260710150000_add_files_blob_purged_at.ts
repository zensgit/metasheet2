import type { Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * F5 files-orphan-blob-retention design-lock (2026-07-10), GF5-1: the compensating-cleanup consume
 * marker.
 *
 * F2 (`zzzz20260710130000_add_files_deleted_at.ts`) made `deleted_at` a tombstone that is set once and
 * NEVER cleared — the row remains an audit record forever, even after its physical blob is gone. That
 * means `deleted_at IS NOT NULL` (F5's natural "this row has an orphan blob to reconcile" entry
 * condition) can never double as the "already processed" flag the way it does in
 * `attachment-orphan-retention.ts` (which flips `deleted_at` NULL→NOT NULL as its own consume marker):
 * reusing `deleted_at` here would make the F5 sweep re-attempt (and re-log) a physical delete against
 * every tombstoned row on every tick, forever.
 *
 * `blob_purged_at` is therefore a SEPARATE, purpose-built marker: NULL means "the physical blob's fate
 * is still unknown/unconfirmed", non-NULL means "a delete-by-key against the physical blob resolved
 * (either it was actually removed, or it was already gone — ENOENT is treated as success)". The sweep's
 * query (`files-orphan-blob-retention.ts`) is `WHERE deleted_at IS NOT NULL AND blob_purged_at IS NULL
 * AND deleted_at < now() - grace`, and it stamps `blob_purged_at = now()` after a successful (or
 * ENOENT) delete — so a purged row drops out of the candidate set forever, and a row whose physical
 * delete genuinely failed (EACCES/EIO/etc.) stays a candidate and is retried on the next tick.
 *
 * No backfill: NULL is the correct value for every existing row (active or already-tombstoned) — it
 * means "not yet confirmed physically purged", which is true for all of them (this column did not exist
 * before, so nothing could have stamped it). The F5 delete-route fix (GF5-7) and sweep (GF5-6) are the
 * only writers.
 *
 * Additive-only, single ALTER TABLE, idempotent (checkTableExists + checkColumnExists — mirrors
 * `zzzz20260710130000_add_files_deleted_at.ts`'s guard style exactly). Runs after
 * `zzzz20260710140000_add_files_storage_key.ts` in filename-sort migration order (not load-bearing here
 * — this column is independent of `storage_key` — but keeps the `files` migration chain in one
 * chronological line).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const filesExists = await checkTableExists(db, 'files')
  if (!filesExists) return

  const hasBlobPurgedAt = await checkColumnExists(db, 'files', 'blob_purged_at')
  if (!hasBlobPurgedAt) {
    await db.schema
      .alterTable('files')
      .addColumn('blob_purged_at', 'timestamptz', (col) => col.defaultTo(null))
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const filesExists = await checkTableExists(db, 'files')
  if (!filesExists) return

  const hasBlobPurgedAt = await checkColumnExists(db, 'files', 'blob_purged_at')
  if (hasBlobPurgedAt) {
    await db.schema
      .alterTable('files')
      .dropColumn('blob_purged_at')
      .execute()
  }
}
