import { randomUUID } from 'crypto'
import { sql, type Kysely } from 'kysely'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

// B1-S1 D0-A: `notification.sent` joins the two watcher event types. It is the
// durable in-app notification produced by a side-effecting `send_notification`
// button action (recipient-validated server-side at dispatch). The two watcher
// types stay untouched (no regression).
export type RecordSubscriptionEventType = 'record.updated' | 'comment.created' | 'notification.sent'

export interface RecordSubscription {
  id: string
  sheetId: string
  recordId: string
  userId: string
  createdAt: string
  updatedAt: string
}

export interface RecordSubscriptionNotification {
  id: string
  sheetId: string
  recordId: string
  userId: string
  eventType: RecordSubscriptionEventType
  actorId: string | null
  revisionId: string | null
  commentId: string | null
  /** Custom message body — populated for `notification.sent`; NULL for watcher events. */
  message: string | null
  createdAt: string
  readAt: string | null
}

export interface NotifyRecordSubscribersInput {
  sheetId: string
  recordId: string
  eventType: RecordSubscriptionEventType
  actorId?: string | null
  revisionId?: string | null
  commentId?: string | null
}

/**
 * Explicit-recipient INSERT seam (B1-S1 D0-A). Extracted from
 * `notifyRecordSubscribers` so the durable notification write has ONE home that
 * both the watcher path (recipients derived from subscriptions) and the
 * side-effecting button/rule path (recipients supplied + server-validated) share
 * — no parallel INSERT.
 *
 * Faithful SUPERSET of the watcher INSERT: it still carries `revisionId`/
 * `commentId` so re-pointing `notifyRecordSubscribers` to it does NOT regress the
 * watcher rows (record.updated → revision_id; the comment.created path uses the
 * Kysely variant, untouched). `message` is the only NEW column, NULL on the
 * watcher path.
 *
 * RECIPIENTS ARE NOT AUTHORIZED HERE — the caller owns recipient policy (the
 * button route member-filters before dispatch). This seam writes exactly what it
 * is handed.
 */
export interface InsertRecordSubscriptionNotificationsInput {
  userIds: string[]
  sheetId: string
  recordId?: string | null
  eventType: RecordSubscriptionEventType
  message?: string | null
  actorId?: string | null
  revisionId?: string | null
  commentId?: string | null
}

export async function insertRecordSubscriptionNotifications(
  query: QueryFn,
  input: InsertRecordSubscriptionNotificationsInput,
): Promise<{ inserted: number }> {
  const userIds = input.userIds
    .map((userId) => (typeof userId === 'string' ? userId.trim() : ''))
    .filter((userId) => userId.length > 0)
  if (userIds.length === 0) return { inserted: 0 }

  const recordId = input.recordId ?? ''
  const values = userIds.map((userId) => ({
    id: randomUUID(),
    sheet_id: input.sheetId,
    record_id: recordId,
    user_id: userId,
    event_type: input.eventType,
    actor_id: input.actorId ?? null,
    revision_id: input.revisionId ?? null,
    comment_id: input.commentId ?? null,
    message: input.message ?? null,
  }))

  await query(
    `INSERT INTO meta_record_subscription_notifications (
       id,
       sheet_id,
       record_id,
       user_id,
       event_type,
       actor_id,
       revision_id,
       comment_id,
       message
     )
     SELECT
       item.id::uuid,
       item.sheet_id,
       item.record_id,
       item.user_id,
       item.event_type,
       item.actor_id,
       item.revision_id::uuid,
       item.comment_id,
       item.message
     FROM jsonb_to_recordset($1::jsonb) AS item(
       id text,
       sheet_id text,
       record_id text,
       user_id text,
       event_type text,
       actor_id text,
       revision_id text,
       comment_id text,
       message text
     )`,
    [JSON.stringify(values)],
  )

  return { inserted: userIds.length }
}

export async function subscribeRecord(
  query: QueryFn,
  input: { sheetId: string; recordId: string; userId: string },
): Promise<RecordSubscription> {
  const result = await query(
    `INSERT INTO meta_record_subscriptions (id, sheet_id, record_id, user_id, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, now(), now())
     ON CONFLICT (sheet_id, record_id, user_id)
     DO UPDATE SET updated_at = now()
     RETURNING id, sheet_id, record_id, user_id, created_at, updated_at`,
    [randomUUID(), input.sheetId, input.recordId, input.userId],
  )
  return serializeSubscription((result.rows as Array<Record<string, unknown>>)[0])
}

export async function unsubscribeRecord(
  query: QueryFn,
  input: { sheetId: string; recordId: string; userId: string },
): Promise<boolean> {
  const result = await query(
    `DELETE FROM meta_record_subscriptions
     WHERE sheet_id = $1 AND record_id = $2 AND user_id = $3`,
    [input.sheetId, input.recordId, input.userId],
  )
  return Number(result.rowCount ?? 0) > 0
}

export async function listRecordSubscriptions(
  query: QueryFn,
  input: { sheetId: string; recordId: string },
): Promise<RecordSubscription[]> {
  const result = await query(
    `SELECT id, sheet_id, record_id, user_id, created_at, updated_at
     FROM meta_record_subscriptions
     WHERE sheet_id = $1 AND record_id = $2
     ORDER BY updated_at DESC, user_id ASC`,
    [input.sheetId, input.recordId],
  )
  return (result.rows as Array<Record<string, unknown>>).map(serializeSubscription)
}

export async function getRecordSubscriptionStatus(
  query: QueryFn,
  input: { sheetId: string; recordId: string; userId: string },
): Promise<{ subscribed: boolean; subscription: RecordSubscription | null }> {
  const result = await query(
    `SELECT id, sheet_id, record_id, user_id, created_at, updated_at
     FROM meta_record_subscriptions
     WHERE sheet_id = $1 AND record_id = $2 AND user_id = $3`,
    [input.sheetId, input.recordId, input.userId],
  )
  const row = (result.rows as Array<Record<string, unknown>>)[0]
  return {
    subscribed: !!row,
    subscription: row ? serializeSubscription(row) : null,
  }
}

export async function notifyRecordSubscribers(
  query: QueryFn,
  input: NotifyRecordSubscribersInput,
): Promise<{ inserted: number; userIds: string[] }> {
  const subscriptions = await query(
    `SELECT user_id
     FROM meta_record_subscriptions
     WHERE sheet_id = $1 AND record_id = $2
       AND ($3::text IS NULL OR user_id <> $3::text)
     ORDER BY user_id ASC`,
    [input.sheetId, input.recordId, input.actorId ?? null],
  )
  const userIds = (subscriptions.rows as Array<Record<string, unknown>>)
    .map((row) => (typeof row.user_id === 'string' ? row.user_id : ''))
    .filter((userId) => userId.length > 0)

  if (userIds.length === 0) return { inserted: 0, userIds: [] }

  // Re-pointed onto the shared writer seam (B1-S1 D0-A). Watcher events never
  // carry a `message`, so it stays NULL — revision_id/comment_id round-trip
  // exactly as before (no regression).
  const { inserted } = await insertRecordSubscriptionNotifications(query, {
    userIds,
    sheetId: input.sheetId,
    recordId: input.recordId,
    eventType: input.eventType,
    actorId: input.actorId ?? null,
    revisionId: input.revisionId ?? null,
    commentId: input.commentId ?? null,
  })

  return { inserted, userIds }
}

export async function notifyRecordSubscribersBestEffort(
  query: QueryFn,
  input: NotifyRecordSubscribersInput,
  context = 'record-subscription',
): Promise<{ inserted: number; userIds: string[] } | null> {
  try {
    return await notifyRecordSubscribers(query, input)
  } catch (error) {
    console.warn(`[${context}] Failed to notify record subscribers`, error)
    return null
  }
}

export async function notifyRecordSubscribersWithKysely(
  db: Kysely<any>,
  input: NotifyRecordSubscribersInput,
): Promise<{ inserted: number; userIds: string[] }> {
  const subscriptionRows = await sql<{ user_id: string }>`
    SELECT user_id
    FROM meta_record_subscriptions
    WHERE sheet_id = ${input.sheetId}
      AND record_id = ${input.recordId}
      AND (${input.actorId ?? null}::text IS NULL OR user_id <> ${input.actorId ?? null}::text)
    ORDER BY user_id ASC
  `.execute(db)

  const userIds = subscriptionRows.rows
    .map((row) => (typeof row.user_id === 'string' ? row.user_id : ''))
    .filter((userId) => userId.length > 0)

  if (userIds.length === 0) return { inserted: 0, userIds: [] }

  await sql`
    INSERT INTO meta_record_subscription_notifications (
      id,
      sheet_id,
      record_id,
      user_id,
      event_type,
      actor_id,
      revision_id,
      comment_id
    )
    SELECT
      gen_random_uuid(),
      ${input.sheetId},
      ${input.recordId},
      user_id,
      ${input.eventType},
      ${input.actorId ?? null},
      ${input.revisionId ?? null}::uuid,
      ${input.commentId ?? null}
    FROM unnest(${userIds}::text[]) AS user_id
  `.execute(db)

  return { inserted: userIds.length, userIds }
}

export async function listRecordSubscriptionNotifications(
  query: QueryFn,
  input: { userId: string; sheetId?: string; recordId?: string; limit?: number; offset?: number },
): Promise<RecordSubscriptionNotification[]> {
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 100)
  const offset = Math.max(Number(input.offset ?? 0), 0)
  const params: unknown[] = [input.userId, limit, offset]
  const filters: string[] = ['user_id = $1']
  if (input.sheetId) {
    params.push(input.sheetId)
    filters.push(`sheet_id = $${params.length}`)
  }
  if (input.recordId) {
    params.push(input.recordId)
    filters.push(`record_id = $${params.length}`)
  }
  const result = await query(
    `SELECT id, sheet_id, record_id, user_id, event_type, actor_id, revision_id, comment_id, message, created_at, read_at
     FROM meta_record_subscription_notifications
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    params,
  )
  return (result.rows as Array<Record<string, unknown>>).map(serializeNotification)
}

// Notification Center S1 — mark-read / unread-count over the actor's OWN notifications.
// SELF-SCOPED: every statement filters `user_id = $1`, so a caller can only ever touch their own
// rows — passing another user's notification id is a silent no-op (0 rows), never a cross-user write.
export async function markRecordSubscriptionNotificationsRead(
  query: QueryFn,
  input: { userId: string; ids: string[] },
): Promise<number> {
  const ids = input.ids.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return 0
  // Only flip still-unread rows so the returned count is the number actually transitioned (idempotent
  // re-marks return 0). `user_id = $1` is the cross-user guard. Compare `id::text = ANY($2)` rather than
  // casting the input to uuid[] — a malformed/non-uuid id then simply fails to match (0 rows) instead of
  // throwing a Postgres invalid-uuid error that would surface as a 500.
  const result = await query(
    `UPDATE meta_record_subscription_notifications
     SET read_at = now()
     WHERE user_id = $1 AND id::text = ANY($2) AND read_at IS NULL`,
    [input.userId, ids],
  )
  return Number(result.rowCount ?? 0)
}

export async function markAllRecordSubscriptionNotificationsRead(
  query: QueryFn,
  input: { userId: string },
): Promise<number> {
  const result = await query(
    `UPDATE meta_record_subscription_notifications
     SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL`,
    [input.userId],
  )
  return Number(result.rowCount ?? 0)
}

export async function countUnreadRecordSubscriptionNotifications(
  query: QueryFn,
  input: { userId: string },
): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM meta_record_subscription_notifications
     WHERE user_id = $1 AND read_at IS NULL`,
    [input.userId],
  )
  return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0)
}

function serializeSubscription(row: Record<string, unknown>): RecordSubscription {
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    recordId: String(row.record_id),
    userId: String(row.user_id),
    createdAt: serializeTime(row.created_at),
    updatedAt: serializeTime(row.updated_at),
  }
}

function serializeNotification(row: Record<string, unknown>): RecordSubscriptionNotification {
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    recordId: String(row.record_id),
    userId: String(row.user_id),
    // Map ALL three known types — coercing an unknown value to record.updated
    // would silently mislabel a notification.sent row and hide its message.
    eventType: normalizeEventType(row.event_type),
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    revisionId: typeof row.revision_id === 'string' ? row.revision_id : null,
    commentId: typeof row.comment_id === 'string' ? row.comment_id : null,
    message: typeof row.message === 'string' ? row.message : null,
    createdAt: serializeTime(row.created_at),
    readAt: row.read_at === null || row.read_at === undefined ? null : serializeTime(row.read_at),
  }
}

function normalizeEventType(value: unknown): RecordSubscriptionEventType {
  if (value === 'comment.created') return 'comment.created'
  if (value === 'notification.sent') return 'notification.sent'
  return 'record.updated'
}

function serializeTime(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '')
}
