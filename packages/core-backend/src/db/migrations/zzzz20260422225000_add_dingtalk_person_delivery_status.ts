import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_person_deliveries
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'failed'
  `.execute(db)

  await sql`
    UPDATE dingtalk_person_deliveries
       SET status = CASE
         WHEN success = TRUE THEN 'success'
         WHEN dingtalk_user_id IS NULL
          AND error_message = 'DingTalk account is not linked or user is inactive'
           THEN 'skipped'
         ELSE 'failed'
       END
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'chk_dingtalk_person_deliveries_status'
      ) THEN
        ALTER TABLE dingtalk_person_deliveries
        ADD CONSTRAINT chk_dingtalk_person_deliveries_status
        CHECK (status IN ('success', 'failed', 'skipped'));
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_person_deliveries
    DROP CONSTRAINT IF EXISTS chk_dingtalk_person_deliveries_status
  `.execute(db)

  await sql`
    ALTER TABLE dingtalk_person_deliveries
    DROP COLUMN IF EXISTS status
  `.execute(db)
}
