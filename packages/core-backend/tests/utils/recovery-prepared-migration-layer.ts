import { sql, type Kysely } from 'kysely'
import * as prepared from '../../src/db/migrations/zzzz20260918130000_create_recovery_archive_prepared_captures'
import * as checkpoints from '../../src/db/migrations/zzzz20260918120000_add_recovery_archive_section_checkpoints'
import * as manualRequests from '../../src/db/migrations/zzzz20260918140000_create_recovery_archive_manual_requests'
import * as attachmentStages from '../../src/db/migrations/zzzz20260919160000_create_archive_attachment_restore_stages'

const suspended = new WeakSet<Kysely<unknown>>()

/** Older migration suites roll back the parent catalog. Unwind only an empty newer layer first. */
export async function suspendPreparedMigrationLayer(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ present: boolean }>`SELECT
    to_regclass('public.meta_recovery_archive_prepared_captures') IS NOT NULL AS present`.execute(db)
  if (!result.rows[0]?.present) return
  // The production down refuses populated storage; never force-drop test or retained payloads.
  await db.transaction().execute(async (tx) => {
    await attachmentStages.down(tx)
    await manualRequests.down(tx)
    await prepared.down(tx)
    // Parent suites replace the checkpoint-amended functions as well as the catalog.
    await checkpoints.down(tx)
  })
  suspended.add(db)
}

export async function restorePreparedMigrationLayer(db: Kysely<unknown>): Promise<void> {
  if (!suspended.has(db)) return
  await db.transaction().execute(async (tx) => {
    await checkpoints.up(tx)
    await prepared.up(tx)
    await manualRequests.up(tx)
    await attachmentStages.up(tx)
    // A second up audits both recreated layers rather than merely checking table presence.
    await checkpoints.up(tx)
    await prepared.up(tx)
    await manualRequests.up(tx)
    await attachmentStages.up(tx)
  })
  suspended.delete(db)
}
