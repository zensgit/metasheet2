type Client = {
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

export function isSessionRenewalBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '55P03' || code === '40P01' || code === '57014' || code === '40001'
    || (error instanceof Error && error.message === 'Query read timeout')
}

/**
 * Transaction-only user admission, held until commit/rollback. Call before any users row lock.
 * The shared key namespace is hashtextextended('user-access:v1:' || userId, 0).
 * Batch writers acquire every distinct numeric key in order before taking physical row locks.
 * Do not upgrade or re-enter these locks in the same transaction.
 */
export async function lockUserAccessShared(client: Client, userId: string) {
  const timeout = await client.query(`SELECT setting AS previous,
    set_config('lock_timeout', LEAST(1000, NULLIF(setting::int, 0))::text, true)
    FROM pg_catalog.pg_settings WHERE name = 'lock_timeout'`)
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('user-access:v1:' || $1::text, 0))",
    [userId],
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

export async function lockUserAccessExclusive(client: Client, userIds: readonly string[]) {
  const keys = await client.query(
    `SELECT DISTINCT hashtextextended('user-access:v1:' || id, 0) AS key
       FROM unnest($1::text[]) AS ids(id) ORDER BY key`,
    [userIds],
  )
  for (const row of keys.rows) {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [row.key])
  }
  for (const userId of [...new Set(userIds)].sort()) {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
  }
}
