import type { Request, Response, Router } from 'express'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { auditLog } from '../audit/audit'
import { claimNonEmptyLoginAliasesOrThrow } from '../auth/login-alias-service'
import { revokeUserSessions } from '../auth/session-revocation'
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
import { authenticate } from '../middleware/auth'
import { hasLegacyAdminClaim } from '../rbac/platform-admin'
import { assignUserRoles } from '../rbac/role-assignment'
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
  }>(
    `SELECT id, email, name, role, department, is_active
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
          ? query<{ email: string }>('SELECT lower(email) AS email FROM users WHERE lower(email) = ANY($1::text[])', [emails])
          : Promise.resolve({ rows: [] as Array<{ email: string }> }),
        loadRoleIds(roleIds),
      ])
      const plan = planCreateBatch({
        body: req.body,
        existingEmails: new Set(existing.rows.map((row) => row.email)),
        knownRoleIds,
      })
      if (!plan.ok) return jsonError(res, plan.status, plan.code, plan.message)

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
      if (!plan.ok) return jsonError(res, plan.status, plan.code, plan.message)

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
      const plan = planDeleteBatch({
        userIds: req.body?.userIds,
        mode: req.body?.mode,
        confirmText: req.body?.confirmText,
        actorId: adminUserId,
        knownIds: new Set(known.map((user) => user.id)),
      })
      if (!plan.ok && plan.code === 'HARD_DELETE_UNSUPPORTED') {
        await auditLog({
          actorId: adminUserId,
          actorType: 'user',
          action: 'delete',
          resourceType: 'user-batch',
          resourceId: 'hard-delete',
          meta: {
            adminUserId,
            outcome: 'refused',
            code: 'HARD_DELETE_UNSUPPORTED',
            count: plan.userIds.length,
          },
        })
        const results: BatchItemResult[] = plan.userIds.map((userId, index) => ({
          index,
          ok: false,
          email: known.find((user) => user.id === userId)?.email ?? null,
          userId,
          code: 'HARD_DELETE_UNSUPPORTED',
          message: plan.message,
        }))
        return jsonError(res, 409, 'HARD_DELETE_UNSUPPORTED', plan.message, summarize(results))
      }
      if (!plan.ok) return jsonError(res, plan.status, plan.code, plan.message)

      const applied: BatchItemResult[] = []
      for (const row of plan.rows) {
        applied.push(await setActive(adminUserId, row.userId, false, row.index))
      }
      const results = [...plan.failures, ...applied].sort((left, right) => left.index - right.index)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'delete',
        resourceType: 'user-batch',
        resourceId: 'disable',
        meta: {
          adminUserId,
          mode: 'disable',
          successCount: results.filter((item) => item.ok).length,
          failureCount: results.filter((item) => !item.ok).length,
        },
      })
      return jsonOk(res, { ...summarize(results), mode: 'disable' })
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
    if (row.name !== undefined || row.department !== undefined) {
      await query(
        `UPDATE users
         SET name = COALESCE($2, name),
             department = CASE WHEN $3::boolean THEN $4 ELSE department END,
             updated_at = NOW()
         WHERE id = $1`,
        [row.userId, row.name ?? null, row.department !== undefined, row.department ?? null],
      )
    }
    if (row.roleId) {
      await assignUserRoles({
        userIds: [row.userId],
        roleId: row.roleId,
        scope: { kind: 'platform-admin' },
      })
      const displayRole = row.roleId === PLATFORM_ADMIN_ROLE_ID ? 'admin' : row.roleId
      await query(
        `UPDATE users
         SET role = $2, is_admin = $3, updated_at = NOW()
         WHERE id = $1`,
        [row.userId, displayRole, displayRole === 'admin'],
      )
      invalidateUserPerms(row.userId)
    }
      if (typeof row.isActive === 'boolean') {
      const status = await setActive(adminUserId, row.userId, row.isActive, row.index)
      if (!status.ok) return { ...status, changes: row.changes }
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
  })
  if (!plan.ok) return { error: { status: plan.status, code: plan.code, message: plan.message } }
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
  const updated = await query<{ id: string; email: string | null }>(
    `UPDATE users
     SET is_active = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, email`,
    [userId, isActive],
  )
  const row = updated.rows[0]
  if (!row) {
    return { index, ok: false, email: null, userId, code: 'USER_NOT_FOUND', message: '找不到该用户' }
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
    email: row.email,
    userId,
    code: null,
    message: isActive ? '已启用' : '已停用',
  }
}
