import type { Request, Response, Router } from 'express'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { auditLog } from '../audit/audit'
import { claimNonEmptyLoginAliasesOrThrow } from '../auth/login-alias-service'
import { revokeUserSessions } from '../auth/session-revocation'
import {
  countLivePlatformAdmins,
  moveUsersToRecycleBin,
  resolveUserRecycleRetentionDays,
} from '../admin/user-recycle'
import {
  ADMIN_USER_BATCH_LIMIT,
  planCreateBatch,
  planDeleteBatch,
  planStatusBatch,
  planUpdateBatch,
  type BatchItemResult,
  type KnownBatchUser,
  type PlannedCreateRow,
  type PlannedUpdate,
} from '../admin/user-batch-plan'
import { query, transaction } from '../db/pg'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../directory/access-graph-mutex'
import { authenticate } from '../middleware/auth'
import { hasLegacyAdminClaim } from '../rbac/platform-admin'
import {
  disableNamespaceAdmissionsWithoutRoles,
  listRoleNamespaces,
  lockNamespaceAdmissionWrites,
} from '../rbac/namespace-admission'
import { assignUserRoles, unassignUserRoles } from '../rbac/role-assignment'
import { invalidateUserPerms, isAdmin as isRbacAdmin } from '../rbac/service'
import { jsonError, jsonOk } from '../util/response'

const PLATFORM_ADMIN_ROLE_ID = 'admin'

function getRequestUserId(req: Request): string {
  const raw = req.user as Record<string, unknown> | undefined
  const userId = raw?.id ?? raw?.userId ?? raw?.sub
  return typeof userId === 'string' ? userId.trim() : ''
}

async function ensureBatchAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = getRequestUserId(req)
  if (!userId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null
  }
  const allowed = hasLegacyAdminClaim(req) || await isRbacAdmin(userId)
  if (!allowed) {
    jsonError(res, 403, 'FORBIDDEN', 'Admin access required')
    return null
  }
  return userId
}

function summarize(results: BatchItemResult[]) {
  const successCount = results.filter((item) => item.ok).length
  const failureCount = results.length - successCount
  return { successCount, failureCount, results }
}

function generateTemporaryPassword(): string {
  return `Tmp-${crypto.randomBytes(8).toString('base64url')}9A`
}

function getBcryptSaltRounds(): number {
  const parsed = Number(process.env.BCRYPT_SALT_ROUNDS || 10)
  return Number.isFinite(parsed) && parsed >= 8 ? parsed : 10
}

async function loadKnownUsers(ids: string[], emails: string[]): Promise<KnownBatchUser[]> {
  if (ids.length === 0 && emails.length === 0) return []
  const result = await query<{
    id: string
    email: string | null
    name: string | null
    role: string
    department: string | null
    is_active: boolean
    deleted_at: string | null
    purged_at: string | null
    is_platform_admin: boolean
  }>(
    `SELECT id, email, name, role, department, is_active, deleted_at, purged_at,
            (COALESCE(is_admin, FALSE) IS TRUE OR role = 'admin' OR EXISTS (
              SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role_id = 'admin'
            )) AS is_platform_admin
     FROM users
     WHERE id = ANY($1::text[])
        OR lower(email) = ANY($2::text[])`,
    [ids, emails],
  )
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    department: row.department,
    isActive: row.is_active,
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    purgedAt: row.purged_at ? String(row.purged_at) : null,
    isPlatformAdmin: row.is_platform_admin === true,
  }))
}

async function loadRoleIds(roleIds: string[]): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set()
  const result = await query<{ id: string }>(
    'SELECT id FROM roles WHERE id = ANY($1::text[])',
    [roleIds],
  )
  return new Set(result.rows.map((row) => row.id))
}

async function auditItem(
  actorId: string,
  action: string,
  userId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await auditLog({
    actorId,
    actorType: 'user',
    action,
    resourceType: 'user',
    resourceId: userId,
    meta: { adminUserId: actorId, ...meta },
  })
}

export async function handleAdminUserBatchCreate(req: Request, res: Response, adminUserId: string): Promise<void> {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items as unknown[] : []
    if (rawItems.length > ADMIN_USER_BATCH_LIMIT) {
      return jsonError(res, 400, 'BATCH_LIMIT_EXCEEDED', `一次最多 ${ADMIN_USER_BATCH_LIMIT} 行`)
    }
    const emails = rawItems
      .map((item) => (item && typeof item === 'object' ? String((item as { email?: unknown }).email || '') : ''))
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
    const roleIds = rawItems
      .map((item) => (item && typeof item === 'object' ? String((item as { roleId?: unknown }).roleId || '') : ''))
      .map((roleId) => roleId.trim())
      .filter(Boolean)

    const [existing, knownRoleIds] = await Promise.all([
      emails.length
        ? query<{ email: string; in_recycle: boolean }>(
          `SELECT lower(email) AS email, (deleted_at IS NOT NULL AND purged_at IS NULL) AS in_recycle FROM users WHERE lower(email) = ANY($1::text[])`,
          [emails],
        )
        : Promise.resolve({ rows: [] as Array<{ email: string; in_recycle: boolean }> }),
      loadRoleIds(roleIds),
    ])
    const plan = planCreateBatch({
      body: req.body,
      existingEmails: new Set(existing.rows.filter((row) => !row.in_recycle).map((row) => row.email)),
      recycleEmails: new Set(existing.rows.filter((row) => row.in_recycle).map((row) => row.email)),
      knownRoleIds,
    })
    if (plan.ok === false) return jsonError(res, plan.status, plan.code, plan.message)

    const created: BatchItemResult[] = []
    for (const row of plan.rows) {
      created.push(await createOne(adminUserId, row))
    }
    const results = [...plan.failures, ...created].sort((left, right) => left.index - right.index)
    await auditLog({
      actorId: adminUserId,
      actorType: 'user',
      action: 'create',
      resourceType: 'user-batch',
      resourceId: 'create',
      meta: {
        adminUserId,
        limit: ADMIN_USER_BATCH_LIMIT,
        successCount: results.filter((item) => item.ok).length,
        failureCount: results.filter((item) => !item.ok).length,
      },
    })
    return jsonOk(res, summarize(results))
  } catch {
    return jsonError(res, 500, 'BATCH_CREATE_FAILED', '批量创建失败')
  }
}

export async function handleAdminUserBatchUpdate(req: Request, res: Response, adminUserId: string): Promise<void> {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items as Array<Record<string, unknown>> : []
    if (rawItems.length > ADMIN_USER_BATCH_LIMIT) {
      return jsonError(res, 400, 'BATCH_LIMIT_EXCEEDED', `一次最多 ${ADMIN_USER_BATCH_LIMIT} 行`)
    }
    const ids = rawItems.map((item) => (typeof item?.userId === 'string' ? item.userId.trim() : '')).filter(Boolean)
    const emails = rawItems.map((item) => (typeof item?.email === 'string' ? item.email.trim().toLowerCase() : '')).filter(Boolean)
    const roleIds = rawItems.map((item) => (typeof item?.roleId === 'string' ? item.roleId.trim() : '')).filter(Boolean)
    const known = await loadKnownUsers(ids, emails)
    const usersById = new Map(known.map((user) => [user.id, user]))
    const usersByEmail = new Map(known.filter((user) => user.email).map((user) => [String(user.email).toLowerCase(), user]))
    const plan = planUpdateBatch({
      body: req.body,
      usersById,
      usersByEmail,
      knownRoleIds: await loadRoleIds(roleIds),
    })
    if (plan.ok === false) return jsonError(res, plan.status, plan.code, plan.message)

    const dryRun = req.body?.dryRun === true
    const applied: BatchItemResult[] = []
    for (const row of plan.rows) {
      if (dryRun) {
        applied.push({
          index: row.index,
          ok: true,
          email: row.email,
          userId: row.userId,
          code: 'DRY_RUN',
          message: '预览，尚未写入',
          changes: row.changes,
        })
        continue
      }
      applied.push(await applyUpdate(adminUserId, row))
    }
    const results = [...plan.failures, ...applied].sort((left, right) => left.index - right.index)
    if (!dryRun) {
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'user-batch',
        resourceId: 'update',
        meta: {
          adminUserId,
          successCount: results.filter((item) => item.ok).length,
          failureCount: results.filter((item) => !item.ok).length,
        },
      })
    }
    return jsonOk(res, { ...summarize(results), dryRun })
  } catch {
    return jsonError(res, 500, 'BATCH_UPDATE_FAILED', '批量更新失败')
  }
}

export async function handleAdminUserBatchDisable(req: Request, res: Response, adminUserId: string): Promise<void> {
  try {
    const payload = await applyStatus(adminUserId, req.body?.userIds, req.body?.isActive)
    if ('error' in payload) return jsonError(res, payload.error.status, payload.error.code, payload.error.message)
    return jsonOk(res, payload)
  } catch {
    return jsonError(res, 500, 'BATCH_STATUS_FAILED', '批量停用失败')
  }
}

export async function handleAdminUserBatchDelete(req: Request, res: Response, adminUserId: string): Promise<void> {
  try {
    const ids = Array.isArray(req.body?.userIds)
      ? req.body.userIds.filter((value: unknown): value is string => typeof value === 'string')
      : []
    const known = await loadKnownUsers(ids.map((id) => id.trim()).filter(Boolean), [])
    const knownUsers = new Map(known.map((user) => [user.id, user]))
    const livePlatformAdminCount = req.body?.mode === 'hard' ? await countLivePlatformAdmins() : undefined
    const plan = planDeleteBatch({
      userIds: req.body?.userIds,
      mode: req.body?.mode,
      confirmText: req.body?.confirmText,
      actorId: adminUserId,
      knownIds: new Set(known.map((user) => user.id)),
      knownUsers,
      livePlatformAdminCount,
    })
    if (plan.ok === false) return jsonError(res, plan.status, plan.code, plan.message)

    const mode = req.body?.mode === 'hard' ? 'recycle' : 'disable'
    const applied: BatchItemResult[] = mode === 'recycle'
      ? await moveUsersToRecycleBin({
        actorId: adminUserId,
        rows: plan.rows,
        retentionDays: resolveUserRecycleRetentionDays(),
      })
      : []
    if (mode === 'disable') {
      for (const row of plan.rows) {
        applied.push(await setActive(adminUserId, row.userId, false, row.index))
      }
    }
    const results = [...plan.failures, ...applied].sort((left, right) => left.index - right.index)
    await auditLog({
      actorId: adminUserId,
      actorType: 'user',
      action: 'delete',
      resourceType: 'user-batch',
      resourceId: mode,
      meta: {
        adminUserId,
        mode,
        retentionDays: mode === 'recycle' ? resolveUserRecycleRetentionDays() : undefined,
        successCount: results.filter((item) => item.ok).length,
        failureCount: results.filter((item) => !item.ok).length,
      },
    })
    return jsonOk(res, { ...summarize(results), mode })
  } catch {
    return jsonError(res, 500, 'BATCH_DELETE_FAILED', '批量删除失败')
  }
}

export function registerAdminUserBatchRoutes(router: Router): void {
  router.post('/api/admin/users/batch/create', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureBatchAdmin(req, res)
    if (!adminUserId) return
    await handleAdminUserBatchCreate(req, res, adminUserId)
  })
  router.post('/api/admin/users/batch/update', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureBatchAdmin(req, res)
    if (!adminUserId) return
    await handleAdminUserBatchUpdate(req, res, adminUserId)
  })
  router.post('/api/admin/users/batch/disable', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureBatchAdmin(req, res)
    if (!adminUserId) return
    await handleAdminUserBatchDisable(req, res, adminUserId)
  })
  router.post('/api/admin/users/batch/delete', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureBatchAdmin(req, res)
    if (!adminUserId) return
    await handleAdminUserBatchDelete(req, res, adminUserId)
  })
}

async function createOne(adminUserId: string, row: PlannedCreateRow): Promise<BatchItemResult> {
  const userId = crypto.randomUUID()
  const temporaryPassword = generateTemporaryPassword()
  const displayRole = row.roleId === PLATFORM_ADMIN_ROLE_ID ? 'admin' : (row.roleId || 'user')
  try {
    const passwordHash = await bcrypt.hash(temporaryPassword, getBcryptSaltRounds())
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO users (
           id, email, username, name, mobile, employee_no, department, position, hire_date,
           password_hash, must_change_password, role, permissions, is_active, is_admin,
           activation_status, local_password_set, created_at, updated_at
         )
         VALUES (
           $1, $2, NULL, $3, NULL, NULL, $4, NULL, NULL, $5, TRUE, $6, '[]'::jsonb, TRUE, $7,
           'activated', TRUE, NOW(), NOW()
         )`,
        [userId, row.email, row.name, row.department, passwordHash, displayRole, displayRole === 'admin'],
      )
      await claimNonEmptyLoginAliasesOrThrow({
        userId,
        email: row.email,
        source: 'admin_batch_create',
        client,
      })
      if (row.roleId) {
        await assignUserRoles({
          userIds: [userId],
          roleId: row.roleId,
          scope: { kind: 'platform-admin' },
          executor: client,
        })
      }
    })
    invalidateUserPerms(userId)
    await auditItem(adminUserId, 'create', userId, {
      email: row.email,
      roleId: row.roleId,
      department: row.department,
    })
    return {
      index: row.index,
      ok: true,
      email: row.email,
      userId,
      code: null,
      message: '已创建',
      temporaryPassword,
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || 'CREATE_FAILED') : 'CREATE_FAILED'
    return {
      index: row.index,
      ok: false,
      email: row.email,
      userId: null,
      code,
      message: '创建失败',
    }
  }
}

async function applyUpdate(adminUserId: string, row: PlannedUpdate): Promise<BatchItemResult> {
  try {
    if (row.isActive === false && row.userId === adminUserId) {
      return {
        index: row.index,
        ok: false,
        email: row.email,
        userId: row.userId,
        code: 'SELF_DISABLE_FORBIDDEN',
        message: '不能停用自己的账号',
        changes: row.changes,
      }
    }
    await transaction(async (client) => {
      await lockNamespaceAdmissionWrites(client, row.userId)
      const lockedUser = (await lockUsersForAccessGraphWrite(client, [row.userId])).get(row.userId)
      if (!lockedUser) throw Object.assign(new Error('找不到该用户'), { code: 'USER_NOT_FOUND' })
      if (lockedUser.deletedAt || lockedUser.purgedAt) {
        throw Object.assign(new Error('该用户在回收站中'), { code: 'USER_IN_RECYCLE_BIN' })
      }
      if (row.name !== undefined || row.department !== undefined) {
        await client.query(
        `UPDATE users
         SET name = COALESCE($2, name),
             department = CASE WHEN $3::boolean THEN $4 ELSE department END,
             updated_at = NOW()
         WHERE id = $1`,
        [row.userId, row.name ?? null, row.department !== undefined, row.department ?? null],
        )
      }
      if (row.roleId) {
        const roleId = row.roleId
        const current = await client.query(
          'SELECT role_id FROM user_roles WHERE user_id = $1',
          [row.userId],
        )
        const previousRoleIds = current.rows
          .map((membership) => (typeof membership.role_id === 'string' ? membership.role_id.trim() : ''))
          .filter((previousRoleId) => previousRoleId && previousRoleId !== roleId)
        await assignUserRoles({
          userIds: [row.userId],
          roleId,
          scope: { kind: 'platform-admin' },
          executor: client,
        })
        for (const previousRoleId of previousRoleIds) {
          await unassignUserRoles({
            userIds: [row.userId],
            roleId: previousRoleId,
            scope: { kind: 'platform-admin' },
            executor: client,
          })
          await disableNamespaceAdmissionsWithoutRoles({
            userId: row.userId,
            namespaces: await listRoleNamespaces(previousRoleId, client.query),
            actorId: adminUserId,
            source: 'role_unassigned',
            revokedRoleId: previousRoleId,
          }, client.query)
        }
        const displayRole = roleId === PLATFORM_ADMIN_ROLE_ID ? 'admin' : roleId
        await client.query(
          `UPDATE users
           SET role = $2, is_admin = $3, updated_at = NOW()
           WHERE id = $1`,
          [row.userId, displayRole, displayRole === 'admin'],
        )
      }
      if (typeof row.isActive === 'boolean' && lockedUser.isActive !== row.isActive) {
        await client.query('UPDATE users SET is_active = $2, updated_at = NOW() WHERE id = $1', [row.userId, row.isActive])
        await supersedeDeprovisionEvidenceForAccessGraphWrite(client, { userIds: [row.userId], actorId: adminUserId, reason: 'superseded by administrator user-status update' })
      }
    })
    if (row.roleId) invalidateUserPerms(row.userId)
    if (row.isActive === false) {
      await revokeUserSessions(row.userId, { updatedBy: adminUserId, reason: 'user-disabled' }).catch(() => undefined)
    }
    await auditItem(adminUserId, 'update', row.userId, { changes: row.changes })
    return {
      index: row.index,
      ok: true,
      email: row.email,
      userId: row.userId,
      code: null,
      message: '已更新',
      changes: row.changes,
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || 'UPDATE_FAILED') : 'UPDATE_FAILED'
    return {
      index: row.index,
      ok: false,
      email: row.email,
      userId: row.userId,
      code,
      message: '更新失败',
      changes: row.changes,
    }
  }
}

async function applyStatus(
  adminUserId: string,
  userIds: unknown,
  isActive: unknown,
): Promise<{ successCount: number; failureCount: number; results: BatchItemResult[] } | { error: { status: number; code: string; message: string } }> {
  const ids = Array.isArray(userIds) ? userIds.filter((value): value is string => typeof value === 'string') : []
  const known = await loadKnownUsers(ids.map((id) => id.trim()).filter(Boolean), [])
  const plan = planStatusBatch({
    userIds,
    isActive,
    actorId: adminUserId,
    knownIds: new Set(known.map((user) => user.id)),
    knownUsers: new Map(known.map((user) => [user.id, user])),
  })
  if (plan.ok === false) return { error: { status: plan.status, code: plan.code, message: plan.message } }
  const applied: BatchItemResult[] = []
  for (const row of plan.rows) {
    applied.push(await setActive(adminUserId, row.userId, isActive === true, row.index))
  }
  const results = [...plan.failures, ...applied].sort((left, right) => left.index - right.index)
  await auditLog({
    actorId: adminUserId,
    actorType: 'user',
    action: 'update',
    resourceType: 'user-batch',
    resourceId: isActive === true ? 'enable' : 'disable',
    meta: {
      adminUserId,
      isActive: isActive === true,
      successCount: results.filter((item) => item.ok).length,
      failureCount: results.filter((item) => !item.ok).length,
    },
  })
  return summarize(results)
}

async function setActive(adminUserId: string, userId: string, isActive: boolean, index = 0): Promise<BatchItemResult> {
  const updated = await transaction(async (client) => {
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [userId])
    const lockedUser = lockedUsers.get(userId)
    if (!lockedUser) return null
    if (lockedUser.deletedAt || lockedUser.purgedAt) return { email: null, recycled: true }
    if (lockedUser.isActive !== isActive) {
      await client.query(
        `UPDATE users
         SET is_active = $2, updated_at = NOW()
         WHERE id = $1`,
        [userId, isActive],
      )
      await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
        userIds: [userId],
        actorId: adminUserId,
        reason: 'superseded by administrator user-status update',
      })
    }
    return { email: lockedUser.email }
  })
  if (!updated) {
    return { index, ok: false, email: null, userId, code: 'USER_NOT_FOUND', message: '找不到该用户' }
  }
  if ('recycled' in updated) {
    return { index, ok: false, email: null, userId, code: 'USER_IN_RECYCLE_BIN', message: '该用户在回收站中，请先恢复' }
  }
  if (!isActive) {
    try {
      await revokeUserSessions(userId, { updatedBy: adminUserId, reason: 'user-disabled' })
    } catch {
      // The account is already disabled. Session revoke is best-effort here.
    }
  }
  await auditItem(adminUserId, 'update', userId, { after: { is_active: isActive } })
  return {
    index,
    ok: true,
    email: updated.email,
    userId,
    code: null,
    message: isActive ? '已启用' : '已停用',
  }
}
