import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS dingtalk_person_deliveries (
      id TEXT PRIMARY KEY,
      local_user_id TEXT NOT NULL,
      dingtalk_user_id TEXT,
      source_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      success BOOLEAN NOT NULL DEFAULT FALSE,
      http_status INTEGER,
      response_body TEXT,
      error_message TEXT,
      automation_rule_id TEXT,
      record_id TEXT,
      initiated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_person_deliveries_local_user
    ON dingtalk_person_deliveries(local_user_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_person_deliveries_source_type
    ON dingtalk_person_deliveries(source_type)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dingtalk_person_deliveries_source_type`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_person_deliveries_local_user`.execute(db)
  await sql`DROP TABLE IF EXISTS dingtalk_person_deliveries`.execute(db)
}
