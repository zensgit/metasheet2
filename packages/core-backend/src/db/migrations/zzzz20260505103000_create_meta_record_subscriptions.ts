import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (sheet_id, record_id, user_id)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_subscription_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      user_id text NOT NULL,
      event_type text NOT NULL CHECK (event_type IN ('record.updated', 'comment.created')),
      actor_id text,
      revision_id uuid,
      comment_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_subscriptions_record
    ON meta_record_subscriptions(sheet_id, record_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_subscriptions_user
    ON meta_record_subscriptions(user_id, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_subscription_notifications_user
    ON meta_record_subscription_notifications(user_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_subscription_notifications_record
    ON meta_record_subscription_notifications(sheet_id, record_id, created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_record_subscription_notifications_record`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_subscription_notifications_user`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_subscriptions_user`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_subscriptions_record`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_record_subscription_notifications`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_record_subscriptions`.execute(db)
}
