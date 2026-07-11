import type { Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * F9 storage-integrity owner CHANGES-REQUESTED design-lock (2026-07-10), GF9-2 (P2-1②, Option A — full F5
 * alignment): the multitable-attachment compensating-cleanup consume marker, mirroring
 * `zzzz20260710150000_add_files_blob_purged_at.ts` exactly.
 *
 * `multitable_attachments.deleted_at` (present since the table's creation migration
 * `zzzz20260319103000_create_multitable_attachments.ts`) is a tombstone set once by
 * `softDeleteAttachmentRow` and never cleared — the row stays a permanent audit record even after its
 * physical blob is gone. That means `deleted_at IS NOT NULL` cannot double as this column's "already
 * physically purged" flag: reusing it would make the compensating sweep re-attempt (and re-log) a
 * physical delete against every soft-deleted attachment row on every tick, forever — exactly the reason
 * F5 introduced a SEPARATE marker for `files` instead of reusing `files.deleted_at`.
 *
 * `blob_purged_at` is therefore a dedicated marker, same semantics as F5's: NULL means "the physical
 * blob's fate is still unknown/unconfirmed", non-NULL means "a delete against the physical blob resolved
 * (either it was actually removed, or it was already gone — ENOENT is treated as success)". The
 * compensating sweep (`sweepMultitableAttachmentBlobPurge` in `multitable/attachment-orphan-retention.ts`)
 * is `WHERE deleted_at IS NOT NULL AND blob_purged_at IS NULL AND deleted_at < now() - grace`, and stamps
 * `blob_purged_at = now()` after a successful (or ENOENT) delete. The interactive delete path
 * (`deleteAttachmentBinary`, GF9-1/GF9-2) stamps it synchronously on the common path; the sweep exists for
 * the residual real-failure tail (EACCES/EIO/etc.), same division of labor as F5. The pre-existing
 * DRAFT-orphan sweep (`cleanupOrphanMultitableAttachments`, `record_id IS NULL AND deleted_at IS NULL`)
 * also stamps this column when it tombstones a row, so that row does not get re-selected by the
 * compensating sweep on the very next tick.
 *
 * No backfill: NULL is the correct value for every existing row (active or already soft-deleted) — it
 * means "not yet confirmed physically purged", which is true for all of them (this column did not exist
 * before, so nothing could have stamped it).
 *
 * Additive-only, single ALTER TABLE, idempotent (checkTableExists + checkColumnExists — mirrors
 * `zzzz20260710150000_add_files_blob_purged_at.ts`'s guard style exactly).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'multitable_attachments')
  if (!tableExists) return

  const hasBlobPurgedAt = await checkColumnExists(db, 'multitable_attachments', 'blob_purged_at')
  if (!hasBlobPurgedAt) {
    await db.schema
      .alterTable('multitable_attachments')
      .addColumn('blob_purged_at', 'timestamptz', (col) => col.defaultTo(null))
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'multitable_attachments')
  if (!tableExists) return

  const hasBlobPurgedAt = await checkColumnExists(db, 'multitable_attachments', 'blob_purged_at')
  if (hasBlobPurgedAt) {
    await db.schema
      .alterTable('multitable_attachments')
      .dropColumn('blob_purged_at')
      .execute()
  }
}
