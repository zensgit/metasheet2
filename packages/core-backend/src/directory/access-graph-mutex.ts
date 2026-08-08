/**
 * Canonical mutex for every writer that changes a user's access graph.
 *
 * Callers must lock all affected users before touching links, memberships,
 * external grants, or users.is_active. Multi-user callers use sorted ids to
 * keep one global lock order. A successful access-graph override invalidates
 * open deprovision evidence and advances the same user's generation in the
 * caller's transaction.
 */

export type AccessGraphTransactionClient = {
  query: (
    statement: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type LockedAccessGraphUser = {
  id: string
  name: string | null
  email: string | null
  username: string | null
  mobile: string | null
  activationStatus: string | null
  isActive: boolean
  accessGeneration: number
}

function normalizeUserIds(userIds: string[]): string[] {
  return Array.from(
    new Set(userIds.map((userId) => String(userId || '').trim()).filter(Boolean)),
  ).sort()
}

export async function lockUsersForAccessGraphWrite(
  client: AccessGraphTransactionClient,
  userIds: string[],
): Promise<Map<string, LockedAccessGraphUser>> {
  const normalizedUserIds = normalizeUserIds(userIds)
  const lockedUsers = new Map<string, LockedAccessGraphUser>()

  for (const userId of normalizedUserIds) {
    const result = await client.query(
      `SELECT id::text AS id,
              name,
              email,
              username,
              mobile,
              activation_status,
              COALESCE(is_active, TRUE) AS is_active,
              COALESCE(access_generation, 0)::bigint AS access_generation
         FROM users
        WHERE id = $1::text
        FOR UPDATE`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) continue
    lockedUsers.set(userId, {
      id: String(row.id),
      name: row.name === null || row.name === undefined ? null : String(row.name),
      email: row.email === null || row.email === undefined ? null : String(row.email),
      username:
        row.username === null || row.username === undefined
          ? null
          : String(row.username),
      mobile:
        row.mobile === null || row.mobile === undefined ? null : String(row.mobile),
      activationStatus:
        row.activation_status === null || row.activation_status === undefined
          ? null
          : String(row.activation_status),
      isActive: row.is_active === true,
      accessGeneration: Number(row.access_generation ?? 0),
    })
  }

  return lockedUsers
}

export async function supersedeDeprovisionEvidenceForAccessGraphWrite(
  client: AccessGraphTransactionClient,
  options: {
    userIds: string[]
    actorId: string
    reason: string
  },
): Promise<Map<string, number>> {
  const actorId = String(options.actorId || '').trim()
  const reason = String(options.reason || '').trim()
  if (!actorId) throw new Error('access-graph supersede actorId is required')
  if (!reason) throw new Error('access-graph supersede reason is required')

  const generations = new Map<string, number>()
  for (const userId of normalizeUserIds(options.userIds)) {
    await client.query(
      `UPDATE directory_deprovision_effects
          SET status = 'superseded',
              updated_at = NOW()
        WHERE local_user_id = $1::text
          AND status = 'applied'`,
      [userId],
    )
    await client.query(
      `UPDATE directory_deprovision_events
          SET status = 'superseded',
              resolved_at = NOW(),
              resolved_by = $2::text,
              resolve_note = $3::text,
              updated_at = NOW()
        WHERE local_user_id = $1::text
          AND status = 'applied'`,
      [userId, actorId, reason],
    )
    const generation = await client.query(
      `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              updated_at = NOW()
        WHERE id = $1::text
        RETURNING access_generation`,
      [userId],
    )
    const nextGeneration = Number(generation.rows[0]?.access_generation)
    if (!Number.isFinite(nextGeneration)) {
      throw new Error(`access-graph generation update returned no row for user ${userId}`)
    }
    generations.set(userId, nextGeneration)
  }

  return generations
}
