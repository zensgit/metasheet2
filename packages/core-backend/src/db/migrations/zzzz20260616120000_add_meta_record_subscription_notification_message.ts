/**
 * Migration: B1-S1 D0-A — make the Notification Center sink carry a durable
 * `send_notification` button delivery.
 *
 * Two changes to meta_record_subscription_notifications:
 *  1) add a nullable `message text` column (the custom notification body; NULL on
 *     the watcher events record.updated / comment.created).
 *  2) widen the event_type CHECK to admit `notification.sent` alongside the two
 *     existing watcher types.
 *
 * The original CHECK (zzzz20260505103000) was declared INLINE/unnamed, so Postgres
 * auto-named it `<table>_<column>_check`. We drop that auto-name AND any prior run
 * of our named constraint (idempotent), then re-add a NAMED constraint so future
 * widenings are stable.
 */

import { sql, type Kysely } from 'kysely'

const AUTO_CHECK_NAME = 'meta_record_subscription_notifications_event_type_check'
const NAMED_CHECK_NAME = 'chk_meta_record_subscription_notifications_event_type'

const EVENT_TYPES_WITH_NOTIFICATION_SENT = ['record.updated', 'comment.created', 'notification.sent'] as const
const EVENT_TYPES_WATCHER_ONLY = ['record.updated', 'comment.created'] as const

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

async function replaceEventTypeCheck(db: Kysely<unknown>, values: readonly string[]): Promise<void> {
  // Drop BOTH the auto-named (original inline) and our named constraint so up/down
  // are idempotent regardless of which is currently present.
  await sql.raw(
    `ALTER TABLE meta_record_subscription_notifications DROP CONSTRAINT IF EXISTS ${AUTO_CHECK_NAME}`,
  ).execute(db)
  await sql.raw(
    `ALTER TABLE meta_record_subscription_notifications DROP CONSTRAINT IF EXISTS ${NAMED_CHECK_NAME}`,
  ).execute(db)
  await sql.raw(
    `ALTER TABLE meta_record_subscription_notifications
     ADD CONSTRAINT ${NAMED_CHECK_NAME}
     CHECK (event_type IN (${quoted(values)}))`,
  ).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_record_subscription_notifications
    ADD COLUMN IF NOT EXISTS message text
  `.execute(db)
  await replaceEventTypeCheck(db, EVENT_TYPES_WITH_NOTIFICATION_SENT)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Narrow the CHECK back to watcher-only. Rebuild under the original AUTO name so
  // the schema matches the pre-migration shape. (Any notification.sent rows must
  // be removed first or the ADD CONSTRAINT would fail — defensive cleanup.)
  await sql`
    DELETE FROM meta_record_subscription_notifications
    WHERE event_type = 'notification.sent'
  `.execute(db)
  await sql.raw(
    `ALTER TABLE meta_record_subscription_notifications DROP CONSTRAINT IF EXISTS ${NAMED_CHECK_NAME}`,
  ).execute(db)
  await sql.raw(
    `ALTER TABLE meta_record_subscription_notifications DROP CONSTRAINT IF EXISTS ${AUTO_CHECK_NAME}`,
  ).execute(db)
  await sql.raw(
    `ALTER TABLE meta_record_subscription_notifications
     ADD CONSTRAINT ${AUTO_CHECK_NAME}
     CHECK (event_type IN (${quoted(EVENT_TYPES_WATCHER_ONLY)}))`,
  ).execute(db)
  await sql`
    ALTER TABLE meta_record_subscription_notifications
    DROP COLUMN IF EXISTS message
  `.execute(db)
}
