import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS dingtalk_group_destinations (
      id text PRIMARY KEY,
      name text NOT NULL,
      webhook_url text NOT NULL,
      secret text,
      enabled boolean NOT NULL DEFAULT true,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz,
      last_tested_at timestamptz,
      last_test_status text,
      last_test_error text
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_destinations_created_by
    ON dingtalk_group_destinations(created_by)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_destinations_enabled
    ON dingtalk_group_destinations(enabled)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_destinations_enabled`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_destinations_created_by`.execute(db)
  await sql`DROP TABLE IF EXISTS dingtalk_group_destinations`.execute(db)
}
