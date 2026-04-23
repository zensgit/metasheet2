import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_group_destinations
    ADD COLUMN IF NOT EXISTS org_id text
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_destinations_org_id
    ON dingtalk_group_destinations(org_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_destinations_org_enabled
    ON dingtalk_group_destinations(org_id, enabled)
    WHERE org_id IS NOT NULL
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'dingtalk_group_destinations_scope_exclusive'
          AND conrelid = 'dingtalk_group_destinations'::regclass
      ) THEN
        ALTER TABLE dingtalk_group_destinations
        ADD CONSTRAINT dingtalk_group_destinations_scope_exclusive
        CHECK (sheet_id IS NULL OR org_id IS NULL);
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_group_destinations
    DROP CONSTRAINT IF EXISTS dingtalk_group_destinations_scope_exclusive
  `.execute(db)

  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_destinations_org_enabled`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_group_destinations_org_id`.execute(db)

  await sql`
    ALTER TABLE dingtalk_group_destinations
    DROP COLUMN IF EXISTS org_id
  `.execute(db)
}
