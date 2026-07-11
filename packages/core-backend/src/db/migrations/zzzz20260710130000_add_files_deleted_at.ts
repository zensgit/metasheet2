import type { Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * F2 files.ts hardening design-lock (2026-07-10): tombstone-first delete substrate.
 *
 * `DELETE /api/files/:id` previously deleted the storage object first, then the `files` row —
 * if the storage delete succeeded but the row delete failed (or vice versa), the two could split:
 * a gone binary with a `files` row still standing in for it as "valid evidence" (the exact dangling
 * state H2 #4044 P3-2 was meant to close). The fix inverts the order to tombstone-first (mark the row
 * `deleted_at` before ever touching storage) so a mid-operation failure never leaves an orphan — the
 * row is either untouched (DB step failed, storage never attempted) or already invalidated (DB step
 * succeeded, so every consumer treats it as gone regardless of whether the storage delete itself
 * later succeeds, retries, or is completed by hand). `deleted_at` also makes the row an audit record
 * instead of a hard-deleted one.
 *
 * Runs AFTER `zzzz20260710120000_create_files.ts` in filename-sort migration order — required, not
 * cosmetic: on a fresh DB the `files` table does not exist until that migration runs, so this one's
 * `checkTableExists` guard must see it landed first or the column never gets added.
 *
 * Idempotent: guarded by checkTableExists + checkColumnExists (mirrors
 * zzzz20260627150000_add_approval_usable_to_roles.ts), so re-runs and any DB where `files` has not
 * been created yet are no-ops in both directions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const filesExists = await checkTableExists(db, 'files')
  if (!filesExists) return

  const hasDeletedAt = await checkColumnExists(db, 'files', 'deleted_at')
  if (!hasDeletedAt) {
    await db.schema
      .alterTable('files')
      .addColumn('deleted_at', 'timestamptz', (col) => col.defaultTo(null))
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const filesExists = await checkTableExists(db, 'files')
  if (!filesExists) return

  const hasDeletedAt = await checkColumnExists(db, 'files', 'deleted_at')
  if (hasDeletedAt) {
    await db.schema
      .alterTable('files')
      .dropColumn('deleted_at')
      .execute()
  }
}
