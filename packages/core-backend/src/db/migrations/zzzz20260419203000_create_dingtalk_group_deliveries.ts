import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS dingtalk_group_deliveries (
      id TEXT PRIMARY KEY,
      destination_id TEXT NOT NULL REFERENCES dingtalk_group_destinations(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      success BOOLEAN NOT NULL DEFAULT FALSE,
      http_status INTEGER,
      response_body TEXT,
      error_message TEXT,
      automation_rule_id TEXT REFERENCES automation_rules(id) ON DELETE SET NULL,
      record_id TEXT,
      initiated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_deliveries_destination_id
    ON dingtalk_group_deliveries(destination_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_deliveries_source_type
    ON dingtalk_group_deliveries(source_type)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_deliveries_source_type`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_deliveries_destination_id`.execute(db)
  await sql`DROP TABLE IF EXISTS dingtalk_group_deliveries`.execute(db)
}
