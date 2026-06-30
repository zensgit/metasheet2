import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * T1-1 node-level SLA — per-node timeout deadline + effect, read by the node-timeout scanner.
 *
 * Two nullable scalar columns on the existing approval_metrics row: the deadline for the
 * CURRENT node (NULL = no node timeout / already fired) and the configured effect. Maintained
 * at node activation/decision; cleared (set NULL) when the timeout fires (single-shot) or the
 * node is decided / the instance terminates. A partial index keeps the scan cheap, mirroring
 * idx_approval_metrics_sla_scan.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'approval_metrics')
  if (!exists) return

  await sql`ALTER TABLE approval_metrics ADD COLUMN IF NOT EXISTS current_node_deadline_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE approval_metrics ADD COLUMN IF NOT EXISTS current_node_timeout_effect TEXT`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_metrics_node_timeout
      ON approval_metrics(current_node_deadline_at)
      WHERE current_node_deadline_at IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'approval_metrics')
  if (!exists) return
  await sql`DROP INDEX IF EXISTS idx_approval_metrics_node_timeout`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS current_node_timeout_effect`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS current_node_deadline_at`.execute(db)
}
