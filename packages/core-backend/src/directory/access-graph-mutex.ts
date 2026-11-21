/**
 * Canonical mutex for every writer that changes a user's access graph.
 *
 * Callers must lock all affected users before touching links, memberships,
 * external grants, or users.is_active. Multi-user callers use sorted ids to
 * keep one global lock order. A successful access-graph override invalidates
 * open deprovision evidence and advances the same user's generation in the
 * caller's transaction.
 *
 * D21 (slice Y5a): the FIRST statement bumps the D21 subject authorization version row of every
 * locked user, sorted, BEFORE the `users … FOR UPDATE` rows are taken (under `nowait`, #6924's
 * authorization operation, it instead takes the existing version rows FOR UPDATE NOWAIT and writes
 * nothing; the operation's DML triggers then advance them). An admission transaction
 * locks `subject_authorization_versions` FOR SHARE and only then `users` FOR SHARE (the
 * live-authority order); a writer that took `users` first and bumped the subject row later (through
 * a membership trigger) would form the one holder-vs-writer cycle the protocol forbids. Doing it here
 * makes "the version rows before the users rows" true by construction for every caller of this
 * function. A caller that passes neither option bumps them. `nowait` and `lockOnly` take the
 * existing rows without a write (below), so a subject that has no version row yet is not locked
 * here on those two paths.
 *
 * The DingTalk identity repair (`auth/dingtalk-identity-repair.ts`) is not a caller since #6964.
 * It follows its own lock protocol (`auth/user-access-lock.ts`): sorted user admission keys, then
 * the identity-maintenance mutex, then the users rows. It takes no subject version row and needs
 * none. On `users` it changes only `access_generation` and `updated_at` (its own statements and
 * `supersedeDeprovisionEvidenceForAccessGraphWrite` below), columns the D21 users trigger does not
 * watch, and it writes no other table that carries a D21 subject trigger. It asks for the mutex
 * before any users row, so it never holds a users row while a handover that holds the mutex waits
 * for a subject version row.
 */
import { bumpSubjectAuthorizationVersions, lockSubjectAuthorizationVersions, lockSubjectAuthorizationVersionsNowait } from '../multitable/authz-version-protocol'

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
  /** Raw `users.role`; the shared authentication gate treats `'disabled'` as inactive. */
  role: string | null
  isActive: boolean
  accessGeneration: number
  deletedAt: string | null
  purgedAt: string | null
}

function normalizeUserIds(userIds: string[]): string[] {
  return Array.from(
    new Set(userIds.map((userId) => String(userId || '').trim()).filter(Boolean)),
  ).sort()
}

export async function lockUsersForAccessGraphWrite(
  client: AccessGraphTransactionClient,
  userIds: string[],
  options: Readonly<{ nowait?: boolean; lockOnly?: boolean }> = {},
): Promise<Map<string, LockedAccessGraphUser>> {
  const normalizedUserIds = normalizeUserIds(userIds)
  const lockedUsers = new Map<string, LockedAccessGraphUser>()

  // D21: subject version rows first (sorted, one statement), then the users rows. Under `nowait`
  // (#6924's authorization operation) the existing version rows are taken NOWAIT and lock-only,
  // like the users rows below; the operation's DML triggers advance them. Under `lockOnly` (a
  // CONSUME_CLASS_DECISION plan, which writes no D21-covered table) they are taken lock-only and waiting.
  if (options.nowait === true) await lockSubjectAuthorizationVersionsNowait(client, normalizedUserIds)
  else if (options.lockOnly === true) await lockSubjectAuthorizationVersions(client, normalizedUserIds)
  else await bumpSubjectAuthorizationVersions(client, normalizedUserIds)

  for (const userId of normalizedUserIds) {
    const result = await client.query(
      `SELECT id::text AS id,
              name,
              email,
              username,
              mobile,
              activation_status,
              role,
              COALESCE(is_active, TRUE) AS is_active,
              COALESCE(access_generation, 0)::bigint AS access_generation,
              (to_jsonb(users) ->> 'deleted_at') AS deleted_at,
              (to_jsonb(users) ->> 'purged_at') AS purged_at
         FROM users
        WHERE id = $1::text
        FOR UPDATE${options.nowait === true ? ' NOWAIT' : ''}`,
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
      role: row.role === null || row.role === undefined ? null : String(row.role),
      isActive: row.is_active === true,
      accessGeneration: Number(row.access_generation ?? 0),
      deletedAt: row.deleted_at === null || row.deleted_at === undefined || String(row.deleted_at).length === 0
        ? null
        : String(row.deleted_at),
      purgedAt: row.purged_at === null || row.purged_at === undefined || String(row.purged_at).length === 0
        ? null
        : String(row.purged_at),
    })
  }

  return lockedUsers
}

export class AccessGraphUserUnavailableError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'USER_IN_RECYCLE_BIN') {
    super(code === 'NOT_FOUND' ? 'User not found' : '账号在回收站中，请先恢复后再修改权限')
    this.name = 'AccessGraphUserUnavailableError'
  }
}

/** The caller holds the transaction through the dependent access writes. */
export async function lockVisibleUsersForAccessGraphWrite(
  client: AccessGraphTransactionClient,
  userIds: string[],
): Promise<Map<string, LockedAccessGraphUser>> {
  const locked = await lockUsersForAccessGraphWrite(client, userIds)
  for (const userId of normalizeUserIds(userIds)) {
    const user = locked.get(userId)
    if (!user) throw new AccessGraphUserUnavailableError('NOT_FOUND')
    if (user.deletedAt || user.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')
  }
  return locked
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
