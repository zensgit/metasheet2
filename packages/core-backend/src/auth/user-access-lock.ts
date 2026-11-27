import { createHash } from 'node:crypto'

type Client = {
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

/** Two-int4 namespace MS2A; reserved in ADVISORY_FIXED_KEY1_REGISTRY. */
export const USER_ACCESS_LOCK_NAMESPACE = 0x4d533241

export function deriveUserAccessLockKey(userId: string): number {
  return createHash('sha256').update('metasheet2:user-access:v1\0').update(userId).digest().readInt32BE(0)
}

export function isSessionRenewalBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '55P03' || code === '40P01' || code === '57014' || code === '40001'
    || (error instanceof Error && error.message === 'Query read timeout')
}

/**
 * Transaction-only user admission, held until commit/rollback. Call before any users row lock.
 * The key is (MS2A, SHA-256("metasheet2:user-access:v1" NUL raw userId)[0:4] as signed int4).
 * A key collision only serializes unrelated users; it never skips their physical row locks.
 * Batch writers acquire every distinct numeric key in order before taking physical row locks.
 * Do not upgrade or re-enter these locks in the same transaction.
 */
export async function lockUserAccessShared(client: Client, userId: string) {
  const timeout = await client.query(`SELECT setting AS previous,
    set_config('lock_timeout', LEAST(1000, NULLIF(setting::int, 0))::text, true)
    FROM pg_catalog.pg_settings WHERE name = 'lock_timeout'`)
  await client.query(
    'SELECT pg_advisory_xact_lock_shared($1::int4, $2::int4)',
    [USER_ACCESS_LOCK_NAMESPACE, deriveUserAccessLockKey(userId)],
  )
  const account = await client.query(
    `SELECT role, is_active, activation_status, access_generation,
            to_jsonb(users)->>'deleted_at' AS deleted_at, to_jsonb(users)->>'purged_at' AS purged_at
       FROM users WHERE id = $1 FOR SHARE`,
    [userId],
  )
  await client.query("SELECT set_config('lock_timeout', $1, true)", [timeout.rows[0].previous])
  return account.rows[0] as {
    role: string | null
    is_active: boolean | null
    activation_status: string | null
    access_generation: string | number | null
    deleted_at: string | null
    purged_at: string | null
  } | undefined
}

/**
 * Exclusive admission, step one: every distinct numeric key in order, and no row lock. A writer that
 * must take another lock before its users rows (the identity repair takes the maintenance mutex)
 * calls this, then that lock, then `lockUserAccessRows`, so it never holds a users row while it waits
 * for the other lock.
 */
export async function lockUserAccessKeysExclusive(client: Client, userIds: readonly string[]) {
  const keys = [...new Set(userIds.map(deriveUserAccessLockKey))].sort((a, b) => a - b)
  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [USER_ACCESS_LOCK_NAMESPACE, key])
  }
}

/** Exclusive admission, step two: the physical users rows in id order. Only after step one for the same users. */
export async function lockUserAccessRows(client: Client, userIds: readonly string[]) {
  for (const userId of [...new Set(userIds)].sort()) {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
  }
}

/** Both steps back to back, for a writer that takes no other lock between its keys and its rows. */
export async function lockUserAccessExclusive(client: Client, userIds: readonly string[]) {
  await lockUserAccessKeysExclusive(client, userIds)
  await lockUserAccessRows(client, userIds)
}
