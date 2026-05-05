import { randomUUID } from 'crypto'
import { sql, type Kysely } from 'kysely'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecordSubscriptionEventType = 'record.updated' | 'comment.created'

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
  createdAt: string
  readAt: string | null
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
  input: {
    sheetId: string
    recordId: string
    eventType: RecordSubscriptionEventType
    actorId?: string | null
    revisionId?: string | null
    commentId?: string | null
  },
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

  const values = userIds.map((userId) => ({
    id: randomUUID(),
    sheetId: input.sheetId,
    recordId: input.recordId,
    userId,
    eventType: input.eventType,
    actorId: input.actorId ?? null,
    revisionId: input.revisionId ?? null,
    commentId: input.commentId ?? null,
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
       comment_id
     )
     SELECT
       item.id::uuid,
       item.sheet_id,
       item.record_id,
       item.user_id,
       item.event_type,
       item.actor_id,
       item.revision_id::uuid,
       item.comment_id
     FROM jsonb_to_recordset($1::jsonb) AS item(
       id text,
       sheet_id text,
       record_id text,
       user_id text,
       event_type text,
       actor_id text,
       revision_id text,
       comment_id text
     )`,
    [JSON.stringify(values.map((item) => ({
      id: item.id,
      sheet_id: item.sheetId,
      record_id: item.recordId,
      user_id: item.userId,
      event_type: item.eventType,
      actor_id: item.actorId,
      revision_id: item.revisionId,
      comment_id: item.commentId,
    })))],
  )

  return { inserted: userIds.length, userIds }
}

export async function notifyRecordSubscribersWithKysely(
  db: Kysely<any>,
  input: {
    sheetId: string
    recordId: string
    eventType: RecordSubscriptionEventType
    actorId?: string | null
    revisionId?: string | null
    commentId?: string | null
  },
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
    `SELECT id, sheet_id, record_id, user_id, event_type, actor_id, revision_id, comment_id, created_at, read_at
     FROM meta_record_subscription_notifications
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    params,
  )
  return (result.rows as Array<Record<string, unknown>>).map(serializeNotification)
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
    eventType: row.event_type === 'comment.created' ? 'comment.created' : 'record.updated',
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    revisionId: typeof row.revision_id === 'string' ? row.revision_id : null,
    commentId: typeof row.comment_id === 'string' ? row.comment_id : null,
    createdAt: serializeTime(row.created_at),
    readAt: row.read_at === null || row.read_at === undefined ? null : serializeTime(row.read_at),
  }
}

function serializeTime(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '')
}
