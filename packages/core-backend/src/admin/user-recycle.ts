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
import { Logger } from '../core/logger'
import { ADMIN_USER_BATCH_LIMIT, type BatchItemResult } from './user-batch-plan'
import { query, transaction } from '../db/pg'
import { lockUsersForAccessGraphWrite, supersedeDeprovisionEvidenceForAccessGraphWrite } from '../directory/access-graph-mutex'
import { lockNamespaceAdmissionWrites, disableNamespaceAdmissionsWithoutRoles, listRoleNamespaces } from '../rbac/namespace-admission'
import { unassignUserRoles } from '../rbac/role-assignment'
import { invalidateUserPerms } from '../rbac/service'
import { escapeLikePattern } from './user-visibility'

export const USER_RECYCLE_RETENTION_DEFAULT_DAYS = 30
export const USER_RECYCLE_RETENTION_MIN_DAYS = 1
export const USER_RECYCLE_RETENTION_MAX_DAYS = 3650
export const USER_RECYCLE_PURGE_CONFIRM_TEXT = '立即清除'
export const USER_RECYCLE_PURGE_CONFIRM_TEXT_EN = 'Purge now'
export const USER_RECYCLE_PURGE_CONFIRM_TEXTS = [USER_RECYCLE_PURGE_CONFIRM_TEXT, USER_RECYCLE_PURGE_CONFIRM_TEXT_EN] as const
export const USER_RECYCLE_RESCRUB_CONFIRM_TEXT = '重新清理'
export const USER_RECYCLE_RESCRUB_CONFIRM_TEXT_EN = 'Rescrub now'
export const USER_RECYCLE_RESCRUB_CONFIRM_TEXTS = [USER_RECYCLE_RESCRUB_CONFIRM_TEXT, USER_RECYCLE_RESCRUB_CONFIRM_TEXT_EN] as const
export const USER_TOMBSTONE_NAME = '已清除用户'
export const USER_RECYCLE_SWEEP_BATCH = 100
const recycleLogger = new Logger('UserRecycle')

/**
 * Identity scrub could not update the audit row it had selected.
 * The message is fixed on purpose: driver text can echo a timestamp or a stored value.
 */
export class AuditIdentityScrubError extends Error {
  readonly code: string

  constructor(code: string) {
    super('audit identity scrub failed')
    this.name = 'AuditIdentityScrubError'
    this.code = code
  }
}

/**
 * The per-item rescrub receipt could not be written. The message is fixed:
 * a driver error can echo the row that was supposed to stay out of the log.
 */
export class RescrubReceiptError extends Error {
  readonly code = 'RESCRUB_RECEIPT_FAILED'

  constructor() {
    super('rescrub receipt failed')
    this.name = 'RescrubReceiptError'
  }
}

const JS_DATE_TO_STRING = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/
const SAFE_ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/

export function describeRecycleFailure(error: unknown): string {
  let errorClass = 'unknown'
  try {
    if (error === null) errorClass = 'null'
    else if (typeof error !== 'object' && typeof error !== 'function') errorClass = typeof error
    else {
      const name = (error as { constructor?: { name?: unknown } }).constructor?.name
      errorClass = typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'unknown'
    }
  } catch {
    errorClass = 'unreadable'
  }
  const rawCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  const code = typeof rawCode === 'string' && SAFE_ERROR_CODE.test(rawCode) ? rawCode : ''
  return `errorClass=${errorClass}${code ? ` code=${code}` : ''}`
}

export function logRecycleFailure(event: string, error: unknown): void {
  try {
    recycleLogger.error(`${event} ${describeRecycleFailure(error)}`)
  } catch {
    // Logging must not replace the original failure.
  }
}

/**
 * Primary-key match for a partitioned audit row.
 * `created_at::text` keeps microsecond precision. A JS Date only has milliseconds,
 * so equality on that value can update zero rows; that path matches the millisecond
 * bucket and the caller rejects any count other than one.
 */
export function auditCreatedAtMatch(value: unknown): { whereSql: string; param: string } {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AuditIdentityScrubError('AUDIT_CREATED_AT_INVALID')
    return {
      whereSql: `id = $1 AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + INTERVAL '1 millisecond'`,
      param: value.toISOString(),
    }
  }
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new AuditIdentityScrubError('AUDIT_CREATED_AT_MISSING')
  if (JS_DATE_TO_STRING.test(text)) throw new AuditIdentityScrubError('AUDIT_CREATED_AT_UNPARSEABLE')
  return {
    whereSql: 'id = $1 AND created_at = $2::timestamptz',
    param: text,
  }
}

export const PLATFORM_ADMIN_ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin', 0))"

export function acceptsRecyclePurgeConfirm(value: unknown): boolean {
  return typeof value === 'string' && (USER_RECYCLE_PURGE_CONFIRM_TEXTS as readonly string[]).includes(value)
}

export function acceptsRecycleRescrubConfirm(value: unknown): boolean {
  return typeof value === 'string' && (USER_RECYCLE_RESCRUB_CONFIRM_TEXTS as readonly string[]).includes(value)
}

const PLATFORM_ADMIN_PREDICATE = `(
  COALESCE(u.is_admin, FALSE) IS TRUE
  OR u.role = 'admin'
  OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin')
)`

const SIGN_IN_PLATFORM_ADMIN_PREDICATE = `
  COALESCE(u.is_active, FALSE) IS TRUE
  AND u.deleted_at IS NULL
  AND u.purged_at IS NULL
  AND ${PLATFORM_ADMIN_PREDICATE}
`

export const LIVE_PLATFORM_ADMIN_COUNT_SQL = `
  SELECT COUNT(*)::int AS c
  FROM users u
  WHERE ${SIGN_IN_PLATFORM_ADMIN_PREDICATE}
`

/**
 * Take this before any users-row lock in the same transaction.
 * pg_advisory_xact_lock is reentrant, so a second call in the same transaction is safe.
 * Sharing this lock with recycle, disable, and admin demotion keeps the last
 * sign-in-capable platform admin from being removed by two concurrent paths.
 */
export async function lockPlatformAdminInvariant(client: RecycleClient): Promise<void> {
  await client.query(PLATFORM_ADMIN_ADVISORY_LOCK_SQL)
}

/** True when this user can currently sign in as a platform admin and nobody else can. */
export async function isLastSignInPlatformAdmin(client: RecycleClient, userId: string): Promise<boolean> {
  const self = await client.query(
    `SELECT (${SIGN_IN_PLATFORM_ADMIN_PREDICATE}) AS is_sign_in_admin
     FROM users u
     WHERE u.id = $1`,
    [userId],
  )
  if (self.rows[0]?.is_sign_in_admin !== true) return false
  const remaining = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM users u
     WHERE u.id <> $1
       AND ${SIGN_IN_PLATFORM_ADMIN_PREDICATE}`,
    [userId],
  )
  return readCount(remaining.rows) < 1
}

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
  await lockPlatformAdminInvariant(client)
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
  if (input.userId === input.actorId) {
    return item(input.index, input.userId, email, false, 'SELF_DELETE_FORBIDDEN', '不能把自己的账号移入回收站')
  }
  if (textOrNull(row.purged_at)) {
    return item(input.index, input.userId, email, false, 'ALREADY_PURGED', '该账号已清除，无法再移入回收站')
  }
  if (textOrNull(row.deleted_at)) {
    return item(input.index, input.userId, email, true, 'ALREADY_IN_RECYCLE', '已在回收站')
  }
  if (await isLastSignInPlatformAdmin(client, input.userId)) {
    return item(input.index, input.userId, email, false, 'LAST_PLATFORM_ADMIN', '至少保留一名可登录的平台管理员')
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
    `SELECT id, email, username, mobile, deleted_at, purged_at, deleted_at::text AS deletion_version, purge_after
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
         hire_date = NULL,
         cumulative_service_start_date = NULL,
         last_login_at = NULL,
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
  await scrubPurgedUserIdentity(client, {
    userId: input.userId,
    email: textOrNull(row.email),
    username: textOrNull(row.username),
    mobile: textOrNull(row.mobile),
    at: now.toISOString(),
  })
  await supersedeDeprovisionEvidenceForAccessGraphWrite(client, { userIds: [input.userId], actorId: input.actorId, reason: 'user-purged' })
  return item(input.index, input.userId, null, true, null, '已清除个人身份，历史记录仍保留')
}

/**
 * Re-apply the current audit identity scrub to an account that is already purged.
 * Does not change the users row, directory links, or sessions. Safe to run again.
 * The rewrite and its per-item receipt commit in the caller's transaction.
 */
export async function applyRecycleRescrub(
  client: RecycleClient,
  input: { userId: string; actorId: string; index: number; now?: Date },
): Promise<BatchItemResult> {
  await lockNamespaceAdmissionWrites(client, input.userId)
  await lockUsersForAccessGraphWrite(client, [input.userId])
  const locked = await client.query(
    `SELECT id, email, username, mobile, deleted_at, purged_at
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [input.userId],
  )
  const row = locked.rows[0]
  if (!row) {
    await insertRescrubReceipt(client, {
      resourceId: null,
      outcome: 'USER_NOT_FOUND',
      auditRowsUpdated: 0,
      actorId: input.actorId,
    })
    return item(input.index, input.userId, null, false, 'USER_NOT_FOUND', '找不到该用户')
  }
  const confirmedId = String(row.id)
  if (!textOrNull(row.purged_at)) {
    const inBin = Boolean(textOrNull(row.deleted_at))
    await insertRescrubReceipt(client, {
      resourceId: confirmedId,
      outcome: 'NOT_PURGED',
      auditRowsUpdated: 0,
      actorId: input.actorId,
    })
    return item(
      input.index,
      confirmedId,
      textOrNull(row.email),
      false,
      'NOT_PURGED',
      inBin ? '该账号还在回收站，尚未清除' : '只能重新清理已经清除的账号',
    )
  }
  const auditRowsUpdated = await scrubPurgedUserAuditIdentity(client, { userId: confirmedId })
  await insertRescrubReceipt(client, {
    resourceId: confirmedId,
    outcome: 'rescrubbed',
    auditRowsUpdated,
    actorId: input.actorId,
  })
  return item(input.index, confirmedId, null, true, null, '已按当前规则重新清理审计中的身份')
}

async function relationExists(client: RecycleClient, name: string): Promise<boolean> {
  const found = await client.query('SELECT to_regclass($1) AS rel', [name])
  const rel = found.rows[0]?.rel
  return rel !== null && rel !== undefined && String(rel).length > 0
}

const AUDIT_IDENTITY_KEYS = new Set([
  'email',
  'user_email',
  'userEmail',
  'name',
  'user_name',
  'userName',
  'mobile',
  'username',
  'department',
  'employee_no',
  'employeeNo',
  'avatar_url',
  'avatarUrl',
  'nick',
  'org_email',
  'orgEmail',
  // Login and display labels copy the same identity as email/username/mobile/name.
  'accountLabel',
  'account_label',
  'loginName',
  'login_name',
  'loginLabel',
  'login_label',
  'displayName',
  'display_name',
  'displayLabel',
  'display_label',
  'fullName',
  'full_name',
  'nickname',
  'nickName',
  'phone',
  'phoneNumber',
  'telephone',
  'jobNumber',
  'job_number',
  'position',
])

const AUDIT_NAME_KEYS = new Set([
  'name',
  'user_name',
  'userName',
  'displayName',
  'display_name',
  'displayLabel',
  'display_label',
  'fullName',
  'full_name',
  'nickname',
  'nickName',
])

/**
 * User-subject resource types and the id shape each writer actually stores.
 * Actor columns are matched separately and never expand this list.
 * Shapes are taken from the auditLog call sites (admin user, role grant,
 * namespace admission, auth grant, permission, delegated scope, member group).
 */
const USER_AUDIT_SUBJECT_RULES = [
  { type: 'user', kind: 'exact' },
  { type: 'user-password', kind: 'exact' },
  { type: 'user-session', kind: 'exact' },
  { type: 'user-role', kind: 'prefix', minSegments: 2, maxSegments: 2 },
  { type: 'user-auth-grant', kind: 'prefix', minSegments: 2, maxSegments: 2 },
  { type: 'permission', kind: 'prefix', minSegments: 2 },
  { type: 'permission-template', kind: 'prefix', minSegments: 2, maxSegments: 2 },
  { type: 'user-namespace-admission', kind: 'prefix', minSegments: 2, maxSegments: 2 },
  { type: 'delegated-admin-scope', kind: 'prefix', minSegments: 2, maxSegments: 3 },
  { type: 'delegated-admin-group-scope', kind: 'prefix', minSegments: 4, maxSegments: 4, literalSegment: { index: 3, value: 'group' } },
  { type: 'delegated-admin-scope-template', kind: 'prefix', minSegments: 4, maxSegments: 4, literalSegment: { index: 3, value: 'template' } },
  { type: 'platform-member-group', kind: 'segment', userSegment: 2, minSegments: 2, maxSegments: 2 },
] as const

type UserAuditSubjectRule = (typeof USER_AUDIT_SUBJECT_RULES)[number]

function auditSqlLiteral(value: string): string {
  if (!/^[a-z0-9-]+$/.test(value)) throw new AuditIdentityScrubError('AUDIT_SUBJECT_RULE_INVALID')
  return `'${value}'`
}

function auditIdSegments(resourceId: string): string[] | null {
  if (!resourceId || resourceId.startsWith(':') || resourceId.endsWith(':') || resourceId.includes('::')) return null
  const parts = resourceId.split(':')
  if (parts.some((part) => part.length === 0)) return null
  return parts
}

function auditRuleMatchesResource(rule: UserAuditSubjectRule, resourceId: string, userId: string): boolean {
  if (rule.kind === 'exact') return resourceId === userId
  const parts = auditIdSegments(resourceId)
  if (!parts) return false
  if (parts.length < rule.minSegments || ('maxSegments' in rule && parts.length > rule.maxSegments)) return false
  if ('literalSegment' in rule && parts[rule.literalSegment.index - 1] !== rule.literalSegment.value) return false
  const userIndex = ('userSegment' in rule ? rule.userSegment : 1) - 1
  return parts[userIndex] === userId
}

/**
 * True when this resource type and id are the purged user's own subject.
 * A role (or any other resource) that happens to reuse the same id is not.
 */
export function auditResourceIsUserSubject(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
  userId: string,
): boolean {
  if (!resourceType || resourceId == null || !userId) return false
  const rule = USER_AUDIT_SUBJECT_RULES.find((item) => item.type === resourceType)
  if (!rule) return false
  return auditRuleMatchesResource(rule, resourceId, userId)
}

/**
 * Row selection for the identity scrub. The actor column is included even when
 * the resource is not a user subject. No substring search.
 */
export function auditSubjectMatchSql(): string {
  const clauses = USER_AUDIT_SUBJECT_RULES.map((rule) => {
    const type = auditSqlLiteral(rule.type)
    if (rule.kind === 'exact') {
      return `(resource_type = ${type} AND resource_id = $1)`
    }
    const userPart = 'userSegment' in rule ? rule.userSegment : 1
    const literal = 'literalSegment' in rule
      ? `AND split_part(resource_id, ':', ${rule.literalSegment.index}) = ${auditSqlLiteral(rule.literalSegment.value)}`
      : ''
    return `(
      resource_type = ${type}
      AND resource_id IS NOT NULL
      AND split_part(resource_id, ':', ${userPart}) = $1
      AND array_length(string_to_array(resource_id, ':'), 1) ${'maxSegments' in rule ? `BETWEEN ${rule.minSegments} AND ${rule.maxSegments}` : `>= ${rule.minSegments}`}
      AND strpos(resource_id, '::') = 0
      AND left(resource_id, 1) <> ':'
      AND right(resource_id, 1) <> ':'
      ${literal}
    )`
  })
  return `(user_id::text = $1 OR ${clauses.join(' OR ')})`
}

export function auditRowMatchesSubject(
  row: { resource_type?: string | null; resource_id?: string | null; user_id?: string | number | null },
  userId: string,
): boolean {
  if (auditResourceIsUserSubject(row.resource_type, row.resource_id, userId)) return true
  return row.user_id != null && String(row.user_id) === userId
}

export type PurgeAuditRow = {
  id: string | number
  created_at: string
  resource_id: string | null
  resource_type?: string | null
  resource_name: string | null
  user_id: string | number | null
  user_email: string | null
  user_name: string | null
  action_details: unknown
  request_body: unknown
}

function isAuditObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nestedOwnerId(node: Record<string, unknown>): string {
  if (typeof node.id === 'string' && node.id.trim()) return node.id
  if (typeof node.userId === 'string' && node.userId.trim()) return node.userId
  return ''
}

function redactOwnedAuditValue(value: unknown, subjectId: string, owned: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (owned && isAuditObject(item) && typeof item.field === 'string' && AUDIT_IDENTITY_KEYS.has(item.field)) {
        const tombstone = AUDIT_NAME_KEYS.has(item.field) ? USER_TOMBSTONE_NAME : null
        return { ...item, before: tombstone, after: tombstone }
      }
      return redactOwnedAuditValue(item, subjectId, owned)
    })
  }
  if (!isAuditObject(value)) return value
  const ownerId = nestedOwnerId(value)
  if (ownerId && ownerId !== subjectId) {
    const kept: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      kept[key] = isAuditObject(child) || Array.isArray(child)
        ? redactOwnedAuditValue(child, subjectId, false)
        : child
    }
    return kept
  }
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (owned && AUDIT_IDENTITY_KEYS.has(key)) {
      next[key] = AUDIT_NAME_KEYS.has(key) ? USER_TOMBSTONE_NAME : null
      continue
    }
    next[key] = redactOwnedAuditValue(child, subjectId, owned)
  }
  return next
}

/**
 * Subject rows lose their own identity fields. Nested objects that name a
 * different user id are left in place. Actor-only rows clear the actor
 * columns and do not rewrite another resource's event body.
 */
export function redactAuditRow(row: PurgeAuditRow, userId: string): PurgeAuditRow {
  const aboutSubject = auditResourceIsUserSubject(row.resource_type, row.resource_id, userId)
  const actor = row.user_id != null && String(row.user_id) === userId
  if (!aboutSubject && !actor) return row
  if (!aboutSubject) {
    return { ...row, user_email: null, user_name: null }
  }
  return {
    ...row,
    action_details: redactOwnedAuditValue(row.action_details, userId, true),
    request_body: redactOwnedAuditValue(row.request_body, userId, true),
    user_email: null,
    user_name: USER_TOMBSTONE_NAME,
    resource_name: USER_TOMBSTONE_NAME,
  }
}

/**
 * Remove identity copies that would survive the users-row tombstone.
 * Directory keys are rewritten so the next sync cannot upsert the old PII back
 * onto the same row. Missing relations are skipped so a partial schema still purges.
 */
export async function scrubPurgedUserIdentity(
  client: RecycleClient,
  input: { userId: string; email: string | null; username: string | null; mobile: string | null; at: string },
): Promise<void> {
  const aliases = [input.email, input.username, input.mobile]
    .map((value) => (value ? value.trim().toLowerCase() : ''))
    .filter((value) => value.length > 0)
  if (await relationExists(client, 'directory_account_links')) {
    if (await relationExists(client, 'directory_accounts')) {
      await client.query(
        `UPDATE directory_accounts AS account
         SET name = $2,
             nick = NULL,
             email = NULL,
             mobile = NULL,
             job_number = NULL,
             title = NULL,
             avatar_url = NULL,
             org_email = NULL,
             open_id = NULL,
             union_id = NULL,
             raw = '{}'::jsonb,
             is_active = FALSE,
             external_user_id = 'purged:' || account.id::text,
             external_key = 'purged:' || account.id::text,
             updated_at = $3::timestamptz
         WHERE account.id IN (
           SELECT directory_account_id
           FROM directory_account_links
           WHERE local_user_id = $1
             AND link_status = 'linked'
         )`,
        [input.userId, USER_TOMBSTONE_NAME, input.at],
      )
    }
    await client.query(
      `UPDATE directory_account_links
       SET local_user_id = NULL,
           link_status = CASE WHEN link_status = 'linked' THEN 'unlinked' ELSE link_status END,
           updated_at = $2::timestamptz
       WHERE local_user_id = $1`,
      [input.userId, input.at],
    )
  }
  if (await relationExists(client, 'user_login_alias_collision_report')) {
    await client.query(
      `UPDATE user_login_alias_collision_report
       SET normalized_value = 'redacted:' || id::text
       WHERE $1::text = ANY(candidate_user_ids)
          OR normalized_value = ANY($2::text[])`,
      [input.userId, aliases],
    )
  }
  await scrubPurgedUserAuditIdentity(client, { userId: input.userId })
}

/**
 * Rewrite identity copies in the two audit tables only.
 * An actor-only match updates the actor columns and does not write
 * action_details or request_body back. Those JSON columns are a snapshot
 * from this transaction; assigning them again restores a value another
 * committed rescrub has already removed.
 */
export async function scrubPurgedUserAuditIdentity(
  client: RecycleClient,
  input: { userId: string },
): Promise<number> {
  let updatedRows = 0
  for (const table of ['audit_logs', 'audit_logs_archive']) {
    if (!(await relationExists(client, table))) continue
    const selected = await client.query(
      `SELECT id, created_at::text AS created_at, resource_type, resource_id, resource_name,
              user_id::text AS user_id, user_name, user_email, action_details, request_body
       FROM ${table}
       WHERE ${auditSubjectMatchSql()}
       ORDER BY id, created_at`,
      [input.userId],
    )
    for (const raw of selected.rows) {
      const createdAt = auditCreatedAtMatch(raw.created_at)
      const current: PurgeAuditRow = {
        id: raw.id as string | number,
        created_at: createdAt.param,
        resource_id: raw.resource_id == null ? null : String(raw.resource_id),
        resource_type: raw.resource_type == null ? null : String(raw.resource_type),
        resource_name: raw.resource_name == null ? null : String(raw.resource_name),
        user_id: raw.user_id == null ? null : String(raw.user_id),
        user_email: raw.user_email == null ? null : String(raw.user_email),
        user_name: raw.user_name == null ? null : String(raw.user_name),
        action_details: raw.action_details ?? null,
        request_body: raw.request_body ?? null,
      }
      const aboutSubject = auditResourceIsUserSubject(current.resource_type, current.resource_id, input.userId)
      const actor = current.user_id != null && String(current.user_id) === input.userId
      if (!aboutSubject && !actor) continue
      if (!aboutSubject) {
        if (current.user_email == null && current.user_name == null) continue
        const updated = await client.query(
          `UPDATE ${table}
           SET user_email = NULL,
               user_name = NULL
           WHERE ${createdAt.whereSql}
             AND user_id::text = $3
           RETURNING id`,
          [current.id, createdAt.param, input.userId],
        )
        const updatedCount = typeof updated.rowCount === 'number' ? updated.rowCount : updated.rows.length
        if (updatedCount !== 1) throw new AuditIdentityScrubError('AUDIT_ROW_NOT_UPDATED')
        updatedRows += 1
        continue
      }
      const redacted = redactAuditRow(current, input.userId)
      if (JSON.stringify(redacted) === JSON.stringify(current)) continue
      const updated = await client.query(
        `UPDATE ${table}
         SET action_details = $3::jsonb,
             request_body = $4::jsonb,
             user_email = $5,
             user_name = $6,
             resource_name = $7
         WHERE ${createdAt.whereSql}
         RETURNING id`,
        [
          redacted.id,
          createdAt.param,
          JSON.stringify(redacted.action_details ?? null),
          JSON.stringify(redacted.request_body ?? null),
          redacted.user_email,
          redacted.user_name,
          redacted.resource_name,
        ],
      )
      const updatedCount = typeof updated.rowCount === 'number' ? updated.rowCount : updated.rows.length
      if (updatedCount !== 1) throw new AuditIdentityScrubError('AUDIT_ROW_NOT_UPDATED')
      updatedRows += 1
    }
  }
  return updatedRows
}

const RESCRUB_RECEIPT_OUTCOMES = ['rescrubbed', 'NOT_PURGED', 'USER_NOT_FOUND'] as const

/**
 * Per-item receipt committed in the same transaction as the rewrite.
 * The operator id is required here: a later item can fail before the batch
 * summary is written, and that summary's audit writer swallows its own errors.
 * Unmatched input is never stored. Throws on failure so the rewrite rolls back.
 */
async function insertRescrubReceipt(
  client: RecycleClient,
  input: {
    resourceId: string | null
    outcome: (typeof RESCRUB_RECEIPT_OUTCOMES)[number]
    auditRowsUpdated: number
    actorId: string
  },
): Promise<void> {
  const operatorId = input.actorId.trim()
  if (!RESCRUB_RECEIPT_OUTCOMES.includes(input.outcome)) throw new RescrubReceiptError()
  if (!Number.isInteger(input.auditRowsUpdated) || input.auditRowsUpdated < 0) throw new RescrubReceiptError()
  if (input.outcome === 'USER_NOT_FOUND' && input.resourceId !== null) throw new RescrubReceiptError()
  if (operatorId.length === 0 || operatorId.length > 255) throw new RescrubReceiptError()
  try {
    const inserted = await client.query(
      `INSERT INTO audit_logs (
         event_type, event_category, event_severity,
         resource_type, resource_id, action, action_details,
         resource_name, user_name
       ) VALUES (
         'UPDATE', 'USER', 'INFO',
         'user', $1::text, 'rescrub',
         jsonb_build_object(
           'outcome', $2::text,
           'auditRowsUpdated', $3::int,
           'adminUserId', $4::text
         ),
         CASE WHEN $2::text = 'rescrubbed' THEN '${USER_TOMBSTONE_NAME}' ELSE NULL END,
         CASE WHEN $2::text = 'rescrubbed' THEN '${USER_TOMBSTONE_NAME}' ELSE NULL END
       )
       RETURNING id`,
      [input.resourceId, input.outcome, input.auditRowsUpdated, operatorId],
    )
    if (!inserted.rows[0]) throw new RescrubReceiptError()
  } catch (error) {
    if (error instanceof RescrubReceiptError) throw error
    throw new RescrubReceiptError()
  }
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

export async function rescrubPurgedUsers(input: {
  actorId: string
  rows: Array<{ index: number; userId: string }>
  now?: Date
}): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = []
  for (const row of input.rows) {
    try {
      const outcome = await transaction((client) => applyRecycleRescrub(client, {
        userId: row.userId,
        actorId: input.actorId,
        index: row.index,
        now: input.now,
      }))
      results.push(outcome)
    } catch (error) {
      if (error instanceof RescrubReceiptError) {
        results.push(item(row.index, row.userId, null, false, 'RESCRUB_RECEIPT_FAILED', '重新清理的记录没有写入，本次清理已撤销'))
        continue
      }
      throw error
    }
  }
  return results
}

export async function listRecycleBin(input: { q?: string; limit: number; offset: number }): Promise<{ total: number; items: RecycleBinUser[] }> {
  const term = input.q?.trim() ? `%${escapeLikePattern(input.q.trim())}%` : ''
  const where = term
    ? `WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND (
        COALESCE(email, '') ILIKE $1 ESCAPE E'\\\\' OR COALESCE(name, '') ILIKE $1 ESCAPE E'\\\\' OR COALESCE(department, '') ILIKE $1 ESCAPE E'\\\\' OR id ILIKE $1 ESCAPE E'\\\\'
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
