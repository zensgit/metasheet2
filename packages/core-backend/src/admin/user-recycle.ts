/**
 * User recycle bin.
 *
 * Move hides the account (deleted_at) from lists, login, and directory pickers.
 * Purge anonymizes the same row — it does not DELETE FROM users — so attendance,
 * audit, and directory history keep a stable id.
 */
import { auditLog } from '../audit/audit'
import { buildUnusablePasswordHash } from '../auth/user-activation'
import { revokeUserSessions } from '../auth/session-revocation'
import { ADMIN_USER_BATCH_LIMIT, type BatchItemResult } from './user-batch-plan'
import { query, transaction } from '../db/pg'
import { lockUsersForAccessGraphWrite, supersedeDeprovisionEvidenceForAccessGraphWrite } from '../directory/access-graph-mutex'
import { lockNamespaceAdmissionWrites, disableNamespaceAdmissionsWithoutRoles, listRoleNamespaces } from '../rbac/namespace-admission'
import { unassignUserRoles } from '../rbac/role-assignment'
import { invalidateUserPerms } from '../rbac/service'

export const USER_RECYCLE_RETENTION_DEFAULT_DAYS = 30
export const USER_RECYCLE_RETENTION_MIN_DAYS = 1
export const USER_RECYCLE_RETENTION_MAX_DAYS = 3650
export const USER_RECYCLE_PURGE_CONFIRM_TEXT = '立即清除'
export const USER_TOMBSTONE_NAME = '已清除用户'
export const USER_RECYCLE_SWEEP_BATCH = 100

const PLATFORM_ADMIN_PREDICATE = `(
  COALESCE(u.is_admin, FALSE) IS TRUE
  OR u.role = 'admin'
  OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin')
)`

export const LIVE_PLATFORM_ADMIN_COUNT_SQL = `
  SELECT COUNT(*)::int AS c
  FROM users u
  WHERE u.deleted_at IS NULL
    AND u.purged_at IS NULL
    AND ${PLATFORM_ADMIN_PREDICATE}
`

export type RecycleClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
}

export type RecycleBinUser = {
  id: string
  email: string | null
  name: string | null
  department: string | null
  deletedAt: string
  deletedBy: string | null
  purgeAfter: string | null
  activeBeforeDelete: boolean | null
}

export function resolveUserRecycleRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.USER_RECYCLE_RETENTION_DAYS)
  if (!Number.isFinite(raw) || raw <= 0) return USER_RECYCLE_RETENTION_DEFAULT_DAYS
  return Math.min(USER_RECYCLE_RETENTION_MAX_DAYS, Math.max(USER_RECYCLE_RETENTION_MIN_DAYS, Math.floor(raw)))
}

export function resolveUserRecycleSweeperIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.USER_RECYCLE_SWEEPER_INTERVAL_MS)
  const fallback = 6 * 60 * 60 * 1000
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.max(60_000, Math.floor(raw))
}

export function isUserRecycleSweeperDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.USER_RECYCLE_SWEEPER_DISABLED === '1' || env.NODE_ENV === 'test' || Boolean(env.VITEST)
}

export function readCount(rows: Array<Record<string, unknown>>): number {
  const raw = rows[0]?.c
  const count = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(count) ? count : 0
}

export function planRecycleIdList(userIds: unknown): { ok: true; ids: Array<{ index: number; userId: string }> } | { ok: false; status: number; code: string; message: string } {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { ok: false, status: 400, code: 'BATCH_EMPTY', message: '请至少选择一名用户' }
  }
  const ids = userIds
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    return { ok: false, status: 400, code: 'BATCH_EMPTY', message: '请至少选择一名用户' }
  }
  if (ids.length > ADMIN_USER_BATCH_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: 'BATCH_LIMIT_EXCEEDED',
      message: `一次最多 ${ADMIN_USER_BATCH_LIMIT} 人`,
    }
  }
  return { ok: true, ids: ids.map((userId, index) => ({ index, userId })) }
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function boolOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

function item(
  index: number,
  userId: string,
  email: string | null,
  ok: boolean,
  code: string | null,
  message: string,
): BatchItemResult {
  return { index, ok, email, userId, code, message }
}

export async function applyRecycleMove(
  client: RecycleClient,
  input: { userId: string; actorId: string; retentionDays: number; index: number; now?: Date },
): Promise<BatchItemResult> {
  const now = input.now ?? new Date()
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin', 0))")
  await lockNamespaceAdmissionWrites(client, input.userId)
  await lockUsersForAccessGraphWrite(client, [input.userId])
  const locked = await client.query(
    `SELECT id, email,
            deleted_at, purged_at,
            (COALESCE(is_admin, FALSE) IS TRUE OR role = 'admin' OR EXISTS (
              SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role_id = 'admin'
            )) AS is_platform_admin
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [input.userId],
  )
  const row = locked.rows[0]
  if (!row) return item(input.index, input.userId, null, false, 'USER_NOT_FOUND', '找不到该用户')
  const email = textOrNull(row.email)
  if (input.userId === input.actorId) {
    return item(input.index, input.userId, email, false, 'SELF_DELETE_FORBIDDEN', '不能把自己的账号移入回收站')
  }
  if (textOrNull(row.purged_at)) {
    return item(input.index, input.userId, email, false, 'ALREADY_PURGED', '该账号已清除，无法再移入回收站')
  }
  if (textOrNull(row.deleted_at)) {
    return item(input.index, input.userId, email, true, 'ALREADY_IN_RECYCLE', '已在回收站')
  }
  if (row.is_platform_admin === true) {
    const remaining = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM users u
       WHERE u.deleted_at IS NULL
         AND u.purged_at IS NULL
         AND u.id <> $1
         AND ${PLATFORM_ADMIN_PREDICATE}`,
      [input.userId],
    )
    if (readCount(remaining.rows) < 1) {
      return item(input.index, input.userId, email, false, 'LAST_PLATFORM_ADMIN', '至少保留一名平台管理员')
    }
  }
  const days = Math.min(
    USER_RECYCLE_RETENTION_MAX_DAYS,
    Math.max(USER_RECYCLE_RETENTION_MIN_DAYS, Math.floor(input.retentionDays)),
  )
  const updated = await client.query(
    `UPDATE users
     SET deleted_at = $2,
         deleted_by = $3,
         purge_after = $2::timestamptz + ($4::int * INTERVAL '1 day'),
         active_before_delete = is_active,
         is_active = FALSE,
         updated_at = $2
     WHERE id = $1
       AND deleted_at IS NULL
       AND purged_at IS NULL
     RETURNING id, email`,
    [input.userId, now.toISOString(), input.actorId, days],
  )
  const saved = updated.rows[0]
  if (!saved) return item(input.index, input.userId, email, false, 'USER_NOT_FOUND', '找不到该用户')
  await client.query('UPDATE multitable_api_tokens SET revoked = TRUE, revoked_at = COALESCE(revoked_at, NOW()) WHERE created_by = $1', [input.userId])
  await supersedeDeprovisionEvidenceForAccessGraphWrite(client, { userIds: [input.userId], actorId: input.actorId, reason: 'user-recycled' })
  return item(input.index, input.userId, textOrNull(saved.email) ?? email, true, null, '已移入回收站')
}

export async function applyRecycleRestore(
  client: RecycleClient,
  input: { userId: string; actorId: string; index: number; now?: Date },
): Promise<BatchItemResult> {
  const now = input.now ?? new Date()
  await lockNamespaceAdmissionWrites(client, input.userId)
  await lockUsersForAccessGraphWrite(client, [input.userId])
  const locked = await client.query(
    `SELECT id, email, deleted_at, purged_at
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [input.userId],
  )
  const row = locked.rows[0]
  if (!row) return item(input.index, input.userId, null, false, 'USER_NOT_FOUND', '找不到该用户')
  const email = textOrNull(row.email)
  if (textOrNull(row.purged_at)) {
    return item(input.index, input.userId, email, false, 'ALREADY_PURGED', '已清除的账号不能恢复')
  }
  if (!textOrNull(row.deleted_at)) {
    return item(input.index, input.userId, email, false, 'NOT_IN_RECYCLE_BIN', '该用户不在回收站')
  }
  const updated = await client.query(
    `UPDATE users
     SET is_active = COALESCE(active_before_delete, FALSE),
         deleted_at = NULL,
         deleted_by = NULL,
         purge_after = NULL,
         active_before_delete = NULL,
         updated_at = $2
     WHERE id = $1
       AND deleted_at IS NOT NULL
       AND purged_at IS NULL
     RETURNING id, email`,
    [input.userId, now.toISOString()],
  )
  const saved = updated.rows[0]
  if (!saved) return item(input.index, input.userId, email, false, 'NOT_IN_RECYCLE_BIN', '该用户不在回收站')
  await supersedeDeprovisionEvidenceForAccessGraphWrite(client, { userIds: [input.userId], actorId: input.actorId, reason: 'user-restored' })
  return item(input.index, input.userId, textOrNull(saved.email) ?? email, true, null, '已恢复')
}

export async function applyRecyclePurge(
  client: RecycleClient,
  input: { userId: string; actorId: string; index: number; now?: Date; passwordHash?: string; expectedDeletedAt?: string; dueBefore?: Date },
): Promise<BatchItemResult> {
  const now = input.now ?? new Date()
  await lockNamespaceAdmissionWrites(client, input.userId)
  await lockUsersForAccessGraphWrite(client, [input.userId])
  const locked = await client.query(
    `SELECT id, email, deleted_at, purged_at, deleted_at::text AS deletion_version, purge_after
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [input.userId],
  )
  const row = locked.rows[0]
  if (!row) return item(input.index, input.userId, null, false, 'USER_NOT_FOUND', '找不到该用户')
  if (textOrNull(row.purged_at)) {
    return item(input.index, input.userId, null, false, 'ALREADY_PURGED', '该账号已清除')
  }
  if (!textOrNull(row.deleted_at)) {
    return item(input.index, input.userId, textOrNull(row.email), false, 'NOT_IN_RECYCLE_BIN', '只能清除回收站中的账号')
  }
  if (input.dueBefore || input.expectedDeletedAt !== undefined) {
    const deadline = input.dueBefore?.getTime()
    const purgeAfter = row.purge_after ? new Date(String(row.purge_after)).getTime() : NaN
    if (!Number.isFinite(deadline) || !Number.isFinite(purgeAfter) || purgeAfter > deadline! || !input.expectedDeletedAt || input.expectedDeletedAt !== textOrNull(row.deletion_version)) {
      return item(input.index, input.userId, null, false, 'STALE_RECYCLE_CANDIDATE', '清除候选已变化')
    }
  }
  const passwordHash = input.passwordHash ?? await buildUnusablePasswordHash()
  await client.query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [input.userId])
  await client.query(`DELETE FROM user_external_identities WHERE local_user_id = $1`, [input.userId])
  await client.query(
    `UPDATE user_external_auth_grants
     SET enabled = FALSE, updated_at = $2
     WHERE local_user_id = $1`,
    [input.userId, now.toISOString()],
  )
  const memberships = await client.query('SELECT role_id FROM user_roles WHERE user_id = $1', [input.userId])
  for (const membership of memberships.rows) {
    const roleId = String(membership.role_id)
    await unassignUserRoles({ userIds: [input.userId], roleId, scope: { kind: 'platform-admin' }, executor: client })
    await disableNamespaceAdmissionsWithoutRoles({ userId: input.userId, namespaces: await listRoleNamespaces(roleId, client.query), actorId: input.actorId, source: 'role_unassigned', revokedRoleId: roleId }, client.query)
  }
  await client.query(`DELETE FROM user_permissions WHERE user_id = $1`, [input.userId])
  const updated = await client.query(
    `UPDATE users
     SET email = NULL,
         username = NULL,
         mobile = NULL,
         employee_no = NULL,
         name = $2,
         avatar_url = NULL,
         department = NULL,
         position = NULL,
         password_hash = $3,
         permissions = '[]'::jsonb,
         is_admin = FALSE,
         is_active = FALSE,
         role = 'user',
         local_password_set = FALSE,
         must_change_password = TRUE,
         purged_at = $4,
         purged_by = $5,
         updated_at = $4
     WHERE id = $1
       AND deleted_at IS NOT NULL
       AND purged_at IS NULL
     RETURNING id`,
    [input.userId, USER_TOMBSTONE_NAME, passwordHash, now.toISOString(), input.actorId],
  )
  if (!updated.rows[0]) return item(input.index, input.userId, null, false, 'NOT_IN_RECYCLE_BIN', '只能清除回收站中的账号')
  await client.query('UPDATE multitable_api_tokens SET revoked = TRUE, revoked_at = COALESCE(revoked_at, NOW()) WHERE created_by = $1', [input.userId])
  await supersedeDeprovisionEvidenceForAccessGraphWrite(client, { userIds: [input.userId], actorId: input.actorId, reason: 'user-purged' })
  return item(input.index, input.userId, null, true, null, '已清除个人身份，历史记录仍保留')
}

export async function listDueRecycleUsers(client: RecycleClient, now: Date, limit = USER_RECYCLE_SWEEP_BATCH): Promise<Array<{ id: string; deletedAt: string }>> {
  const result = await client.query(
    `SELECT id, deleted_at::text AS deleted_at
     FROM users
     WHERE deleted_at IS NOT NULL
       AND purged_at IS NULL
       AND purge_after IS NOT NULL
       AND purge_after <= $1
     ORDER BY purge_after ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  )
  return result.rows.flatMap(row => {
    const id = textOrNull(row.id)
    const deletedAt = textOrNull(row.deleted_at)
    return id && deletedAt ? [{ id, deletedAt }] : []
  })
}

export async function listDueRecycleUserIds(client: RecycleClient, now: Date, limit = USER_RECYCLE_SWEEP_BATCH): Promise<string[]> {
  return (await listDueRecycleUsers(client, now, limit)).map(row => row.id)
}

async function auditRecycle(
  actorId: string,
  actorType: 'user' | 'system',
  action: string,
  userId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await auditLog({
    actorId,
    actorType,
    action,
    resourceType: 'user',
    resourceId: userId,
    meta: { adminUserId: actorId, ...meta },
  })
}

async function revokeQuietly(userId: string, actorId: string, reason: string): Promise<void> {
  try {
    await revokeUserSessions(userId, { updatedBy: actorId, reason })
  } catch {
    // The account is already inactive. Session revoke is best-effort.
  }
}

export async function moveUsersToRecycleBin(input: {
  actorId: string
  rows: Array<{ index: number; userId: string }>
  retentionDays?: number
  now?: Date
}): Promise<BatchItemResult[]> {
  const retentionDays = input.retentionDays ?? resolveUserRecycleRetentionDays()
  const results: BatchItemResult[] = []
  for (const row of input.rows) {
    const outcome = await transaction((client) => applyRecycleMove(client, {
      userId: row.userId,
      actorId: input.actorId,
      retentionDays,
      index: row.index,
      now: input.now,
    }))
    if (outcome.ok && outcome.code !== 'ALREADY_IN_RECYCLE') {
      await revokeQuietly(row.userId, input.actorId, 'user-recycled')
    }
    await auditRecycle(input.actorId, 'user', 'delete', row.userId, {
      outcome: outcome.ok ? (outcome.code ?? 'recycled') : outcome.code,
      retentionDays,
    })
    results.push(outcome)
  }
  return results
}

export async function restoreRecycleUsers(input: {
  actorId: string
  rows: Array<{ index: number; userId: string }>
  now?: Date
}): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = []
  for (const row of input.rows) {
    const outcome = await transaction((client) => applyRecycleRestore(client, {
      userId: row.userId,
      actorId: input.actorId,
      index: row.index,
      now: input.now,
    }))
    await auditRecycle(input.actorId, 'user', 'restore', row.userId, {
      outcome: outcome.ok ? 'restored' : outcome.code,
    })
    results.push(outcome)
  }
  return results
}

export async function purgeRecycleUsers(input: {
  actorId: string
  actorType?: 'user' | 'system'
  rows: Array<{ index: number; userId: string; expectedDeletedAt?: string }>
  now?: Date
  dueBefore?: Date
}): Promise<BatchItemResult[]> {
  const actorType = input.actorType ?? 'user'
  const results: BatchItemResult[] = []
  for (const row of input.rows) {
    const passwordHash = await buildUnusablePasswordHash()
    const outcome = await transaction((client) => applyRecyclePurge(client, {
      userId: row.userId,
      actorId: input.actorId,
      index: row.index,
      now: input.now,
      passwordHash,
      expectedDeletedAt: row.expectedDeletedAt,
      dueBefore: input.dueBefore,
    }))
    if (outcome.ok) {
      invalidateUserPerms(row.userId)
      await revokeQuietly(row.userId, input.actorId, 'user-purged')
    }
    await auditRecycle(input.actorId, actorType, 'delete', row.userId, {
      outcome: outcome.ok ? 'purged' : outcome.code,
      tombstone: outcome.ok,
    })
    results.push(outcome)
  }
  return results
}

export async function listRecycleBin(input: { q?: string; limit: number; offset: number }): Promise<{ total: number; items: RecycleBinUser[] }> {
  const term = input.q?.trim() ? `%${input.q.trim()}%` : ''
  const where = term
    ? `WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND (
        COALESCE(email, '') ILIKE $1 OR COALESCE(name, '') ILIKE $1 OR COALESCE(department, '') ILIKE $1 OR id ILIKE $1
      )`
    : 'WHERE deleted_at IS NOT NULL AND purged_at IS NULL'
  const count = await query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM users ${where}`,
    term ? [term] : undefined,
  )
  const list = await query<Record<string, unknown>>(
    `SELECT id, email, name, department, deleted_at, deleted_by, purge_after, active_before_delete
     FROM users
     ${where}
     ORDER BY deleted_at DESC
     LIMIT $${term ? 2 : 1} OFFSET $${term ? 3 : 2}`,
    term ? [term, input.limit, input.offset] : [input.limit, input.offset],
  )
  return {
    total: count.rows[0]?.c ?? 0,
    items: list.rows.map((row) => ({
      id: String(row.id),
      email: textOrNull(row.email),
      name: textOrNull(row.name),
      department: textOrNull(row.department),
      deletedAt: String(row.deleted_at),
      deletedBy: textOrNull(row.deleted_by),
      purgeAfter: textOrNull(row.purge_after),
      activeBeforeDelete: boolOrNull(row.active_before_delete),
    })),
  }
}

export async function countLivePlatformAdmins(): Promise<number> {
  const result = await query<{ c: number }>(LIVE_PLATFORM_ADMIN_COUNT_SQL)
  return readCount(result.rows as Array<Record<string, unknown>>)
}

export async function purgeDueRecycleUsers(now = new Date()): Promise<number> {
  const candidates = await listDueRecycleUsers({ query }, now, USER_RECYCLE_SWEEP_BATCH)
  if (candidates.length === 0) return 0
  const actorId = 'system:user-recycle'
  const results = await purgeRecycleUsers({
    actorId,
    actorType: 'system',
    rows: candidates.map((candidate, index) => ({ index, userId: candidate.id, expectedDeletedAt: candidate.deletedAt })),
    now,
    dueBefore: now,
  })
  return results.filter((row) => row.ok).length
}
