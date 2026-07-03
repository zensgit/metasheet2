import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * nodeEntryEpoch — durable T2-4 threshold (门槛会签) round-scoping.
 *
 * Replaces the append-only cutoff heuristic (#3446 / #3453 / #3499) that inferred
 * "which round am I in" from transition metadata with a per-node-entry epoch recorded
 * AT activation. Two additive columns (see design-lock
 * docs/development/node-entry-epoch-threshold-round-scoping-design-lock-20260703.md §3/§6):
 *
 *   - approval_instances.node_activation_seq: a per-instance monotonic counter bumped by 1
 *     each time a node is activated. The post-increment value is that activation's epoch.
 *     NOT NULL DEFAULT 0 so legacy rows read a stable baseline.
 *   - approval_assignments.entry_epoch: the instance's post-increment node_activation_seq
 *     stamped on every assignment row created in that activation. NULLABLE — pre-migration
 *     (legacy) assignments carry NULL, which the tally treats as "use the cutoff fallback"
 *     (dual-read, §6) so in-flight instances are never mis-counted.
 *
 * Additive + idempotent; no backfill (the dual-read fallback removes backfill risk).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const hasInstances = await checkTableExists(db, 'approval_instances')
  if (hasInstances) {
    await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS node_activation_seq INTEGER NOT NULL DEFAULT 0`.execute(db)
  }

  const hasAssignments = await checkTableExists(db, 'approval_assignments')
  if (hasAssignments) {
    await sql`ALTER TABLE approval_assignments ADD COLUMN IF NOT EXISTS entry_epoch INTEGER`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const hasAssignments = await checkTableExists(db, 'approval_assignments')
  if (hasAssignments) {
    await sql`ALTER TABLE approval_assignments DROP COLUMN IF EXISTS entry_epoch`.execute(db)
  }

  const hasInstances = await checkTableExists(db, 'approval_instances')
  if (hasInstances) {
    await sql`ALTER TABLE approval_instances DROP COLUMN IF EXISTS node_activation_seq`.execute(db)
  }
}
