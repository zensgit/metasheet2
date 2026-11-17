/**
 * Transaction plumbing shared by the endpoint and preference writes: the per-user lock, the
 * isolation level, the lock wait bound, and the mapping of database failures to a retryable answer.
 *
 * Every write of one user (create or refresh an endpoint, revoke one, change a preference) takes the
 * same per-user advisory lock first, so a user's writes are serialized. A write that must also change
 * another user's endpoint takes both users' locks in ascending (organization, user) order.
 */
import type { Db } from './recipient-resolver'
import { NotificationHttpError, isNotificationHttpError } from './notification-errors'

export interface NotificationDbDeps {
  /** Reads outside a transaction. */
  readonly db: Db
  /** Runs `fn` on one connection inside a transaction: commit when it resolves, roll back when it throws. */
  transaction<T>(fn: (client: Db) => Promise<T>): Promise<T>
}

export interface UserLockKey {
  readonly orgId: string
  readonly userId: string
}

export const LOCK_WAIT = '5s'

/** Two-argument form: the organization and the user are hashed separately, so the key is injective in practice. */
export const USER_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('notif-user:' || $1::text), hashtext($2::text))`

const BUSY_CODES = new Set(['55P03', '40P01', '40001', '57014'])
/** A relation (42P01) or column (42703) that the schema does not have yet. */
const SCHEMA_CODES = new Set(['42P01', '42703'])

export function sortedUserLocks(keys: readonly UserLockKey[]): UserLockKey[] {
  const unique = new Map<string, UserLockKey>()
  for (const key of keys) unique.set(JSON.stringify([key.orgId, key.userId]), key)
  return [...unique.values()].sort((a, b) =>
    a.orgId === b.orgId ? (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0) : a.orgId < b.orgId ? -1 : 1,
  )
}

/**
 * Runs `fn` in a transaction that holds the lock of every user in `locks`. The isolation level is
 * set to READ COMMITTED first, whatever the pool default is, so a write that waited for the lock reads
 * the state its predecessor committed.
 */
export async function withUserLocks<T>(
  deps: NotificationDbDeps,
  locks: readonly UserLockKey[],
  fn: (client: Db) => Promise<T>,
): Promise<T> {
  return deps.transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`)
    for (const key of sortedUserLocks(locks)) await client.query(USER_LOCK_SQL, [key.orgId, key.userId])
    return fn(client)
  })
}

/**
 * A lock wait, deadlock, serialization failure or statement cancel is answered 503 NOTIFICATION_BUSY, retryable.
 * A missing table or column is answered 503 NOTIFICATION_SCHEMA_UNAVAILABLE. Anything else passes through.
 */
export function mapBusy(error: unknown): unknown {
  if (isNotificationHttpError(error)) return error
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && BUSY_CODES.has(code)) return new NotificationHttpError(503, 'NOTIFICATION_BUSY')
  if (typeof code === 'string' && SCHEMA_CODES.has(code)) return new NotificationHttpError(503, 'NOTIFICATION_SCHEMA_UNAVAILABLE')
  return error
}

export function pgErrorOf(error: unknown): { code?: string; constraint?: string } {
  const record = (error ?? {}) as { code?: unknown; constraint?: unknown }
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    constraint: typeof record.constraint === 'string' ? record.constraint : undefined,
  }
}

export interface AuditEvent {
  actorId?: string
  actorType: 'user' | 'system'
  action: string
  resourceType: string
  resourceId: string
  meta?: Record<string, unknown>
}

export type AuditSink = (event: AuditEvent) => Promise<void>
