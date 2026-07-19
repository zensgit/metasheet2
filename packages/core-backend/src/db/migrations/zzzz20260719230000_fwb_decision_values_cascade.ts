/**
 * FWB-3 lifecycle: approval_node_decision_values follows the approval instance (Q4).
 * Adds FK ON DELETE CASCADE so instance delete/archive cascades decision freeze rows.
 * Also replaces silent ON CONFLICT posture by keeping UNIQUE (instance, node, epoch, field).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop orphan freeze rows whose instance no longer exists (pre-FK cleanup).
  await sql`
    DELETE FROM approval_node_decision_values d
     WHERE NOT EXISTS (SELECT 1 FROM approval_instances i WHERE i.id = d.instance_id)
  `.execute(db)
  await sql`
    ALTER TABLE approval_node_decision_values
      DROP CONSTRAINT IF EXISTS approval_node_decision_values_instance_fkey
  `.execute(db)
  await sql`
    ALTER TABLE approval_node_decision_values
      ADD CONSTRAINT approval_node_decision_values_instance_fkey
      FOREIGN KEY (instance_id) REFERENCES approval_instances(id) ON DELETE CASCADE
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE approval_node_decision_values
      DROP CONSTRAINT IF EXISTS approval_node_decision_values_instance_fkey
  `.execute(db)
}
