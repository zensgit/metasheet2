import { sql, type Kysely } from 'kysely'

/**
 * DT-HARDEN-08 — delivery telemetry indexes.
 *
 * Both dingtalk-group-delivery-service.ts and dingtalk-person-delivery-service.ts
 * list deliveries with `WHERE automation_rule_id = $1 ORDER BY created_at DESC
 * LIMIT $2`. Neither dingtalk_group_deliveries nor dingtalk_person_deliveries has
 * an index covering that filter+sort shape (only destination_id/local_user_id and
 * source_type are indexed), so those list queries fall back to a sequential scan
 * as delivery history grows. Add the missing composite indexes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_deliveries_rule_created_at
    ON dingtalk_group_deliveries(automation_rule_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_person_deliveries_rule_created_at
    ON dingtalk_person_deliveries(automation_rule_id, created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dingtalk_person_deliveries_rule_created_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_deliveries_rule_created_at`.execute(db)
}
