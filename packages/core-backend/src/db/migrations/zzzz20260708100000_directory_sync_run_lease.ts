import { sql, type Kysely } from 'kysely'

/**
 * DT-HARDEN-05 — directory sync run lease.
 *
 * `syncDirectoryIntegration` inserts its `directory_sync_runs` row and then pulls the
 * entire DingTalk directory (departments + users) before opening its apply
 * transaction. Nothing stopped a manual sync, the scheduler, and a second app replica
 * from doing that concurrently: double consumption of the shared DingTalk API quota,
 * two big apply transactions lock-waiting on the same integration, and a `last_seen_at
 * < syncTimestamp` sweep that can deactivate rows the other run just wrote.
 *
 * A partial unique index on the run row makes "at most one running run per
 * integration" a database invariant, enforced BEFORE the first outbound API call
 * (the run row already predates it). The second caller hits a unique violation and is
 * told a run is already in flight.
 *
 * Backfill: any `running` row on deploy is by definition orphaned — the process that
 * owned it is being replaced — so it is closed out first, which also clears the
 * pre-existing zombie rows that had no recovery path at all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE directory_sync_runs
       SET status = 'failed',
           finished_at = COALESCE(finished_at, NOW()),
           error_message = COALESCE(error_message, 'orphaned by restart (DT-HARDEN-05 backfill)'),
           updated_at = NOW()
     WHERE status = 'running'
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_directory_sync_runs_one_running_per_integration
    ON directory_sync_runs(integration_id)
    WHERE status = 'running'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_directory_sync_runs_one_running_per_integration`.execute(db)
}
