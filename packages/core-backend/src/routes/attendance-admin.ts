import type { Request, Response } from 'express'
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { isAdmin as isRbacAdmin, listUserPermissions } from '../rbac/service'
import { query } from '../db/pg'
import { jsonError, jsonOk, parsePagination } from '../util/response'

type AttendanceRoleTemplateId = 'employee' | 'approver' | 'admin'

const ATTENDANCE_ROLE_TEMPLATES: Record<AttendanceRoleTemplateId, {
  id: AttendanceRoleTemplateId
  roleId: string
  permissions: string[]
  description: string
}> = {
  employee: {
    id: 'employee',
    roleId: 'attendance_employee',
    permissions: ['attendance:read', 'attendance:write'],
    description: 'Punch, submit adjustment requests, and read attendance records.',
  },
  approver: {
    id: 'approver',
    roleId: 'attendance_approver',
    permissions: ['attendance:read', 'attendance:approve'],
    description: 'Approve or reject attendance adjustment requests.',
  },
  admin: {
    id: 'admin',
    roleId: 'attendance_admin',
    permissions: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:admin'],
    description: 'Full attendance administration (rules, imports, holidays, groups).',
  },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function parseDateParam(raw: unknown): Date | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) return null
  return d
}

async function ensureAttendanceRoleTemplates(): Promise<void> {
  // Ensure permission codes exist.
  await query(
    `INSERT INTO permissions (code, name, description)
     VALUES
      ('attendance:read', 'Attendance Read', 'Read attendance records and summaries'),
      ('attendance:write', 'Attendance Write', 'Create attendance punches and adjustment requests'),
      ('attendance:approve', 'Attendance Approve', 'Approve or reject attendance adjustments'),
      ('attendance:admin', 'Attendance Admin', 'Manage attendance rules, settings, and schedules')
     ON CONFLICT (code) DO NOTHING`,
  )

  // Ensure role-permission mappings exist (role_id is a string identifier).
  const pairs: Array<[string, string]> = []
  Object.values(ATTENDANCE_ROLE_TEMPLATES).forEach((tpl) => {
    tpl.permissions.forEach((perm) => pairs.push([tpl.roleId, perm]))
  })

  const values = pairs.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ')
  const params = pairs.flat()
  await query(
    `INSERT INTO role_permissions (role_id, permission_code)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params,
  )
}

async function fetchUserProfile(userId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<{
    id: string
    email: string
    name: string | null
    role: string
    is_active: boolean
    is_admin: boolean
    last_login_at: string | null
    created_at: string
  }>(
    `SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at
     FROM users
     WHERE id = $1`,
    [userId],
  )
  if (!rows.length) return null
  return rows[0] as unknown as Record<string, unknown>
}

async function fetchUserRoleIds(userId: string): Promise<string[]> {
  const { rows } = await query<{ role_id: string }>(
    `SELECT role_id
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role_id ASC`,
    [userId],
  )
  return rows.map((row) => row.role_id).filter(Boolean)
}

function normalizeBatchUserIds(rawIds: unknown[]): { userIds: string[]; invalidUserIds: string[] } {
  const userIds: string[] = []
  const invalidUserIds: string[] = []
  const seen = new Set<string>()

  for (const value of rawIds) {
    const id = String(value || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (!isUuid(id)) {
      invalidUserIds.push(id)
      continue
    }
    userIds.push(id)
  }

  return { userIds, invalidUserIds }
}

type AttendanceAdminResolvedUser = {
  id: string
  email: string
  name: string | null
  is_active: boolean
}

async function resolveBatchUsers(userIds: string[]): Promise<{
  items: AttendanceAdminResolvedUser[]
  missingUserIds: string[]
  inactiveUserIds: string[]
}> {
  if (userIds.length === 0) {
    return { items: [], missingUserIds: [], inactiveUserIds: [] }
  }

  const found = await query<AttendanceAdminResolvedUser>(
    `SELECT id, email, name, is_active
     FROM users
     WHERE id = ANY($1::text[])`,
    [userIds],
  )

  const byId = new Map(found.rows.map((row) => [String(row.id), row]))
  const items: AttendanceAdminResolvedUser[] = []
  const missingUserIds: string[] = []

  for (const userId of userIds) {
    const item = byId.get(userId)
    if (!item) {
      missingUserIds.push(userId)
      continue
    }
    items.push(item)
  }

  const inactiveUserIds = items
    .filter((item) => item.is_active === false)
    .map((item) => item.id)

  return { items, missingUserIds, inactiveUserIds }
}

export function attendanceAdminRouter(): Router {
  const r = Router()

  // NOTE: This is an attendance-scoped admin surface. Guard by attendance:admin (not global admin),
  // so tenants can delegate attendance administration without exposing the whole platform.
  r.use('/api/attendance-admin', rbacGuard('attendance', 'admin'))

  r.get('/api/attendance-admin/role-templates', async (_req: Request, res: Response) => {
    try {
      await ensureAttendanceRoleTemplates()
      const templates = Object.values(ATTENDANCE_ROLE_TEMPLATES)
      return jsonOk(res, { templates })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_TEMPLATES_FAILED', (error as Error)?.message || 'Failed to load role templates')
    }
  })

  r.get('/api/attendance-admin/users/search', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })

      const term = q ? `%${q}%` : '%'
      const where = q ? 'WHERE email ILIKE $1 OR name ILIKE $1 OR id ILIKE $1' : ''
      const countSql = `SELECT COUNT(*)::int AS c FROM users ${where}`
      const listSql = `
        SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at
        FROM users
        ${where}
        ORDER BY created_at DESC
        LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `

      const count = await query<{ c: number }>(countSql, q ? [term] : undefined)
      const total = count.rows[0]?.c ?? 0
      const listParams = q ? [term, pageSize, offset] : [pageSize, offset]
      const list = await query(listSql, listParams)

      return jsonOk(res, { items: list.rows, page, pageSize, total })
    } catch (error) {
      return jsonError(res, 500, 'USER_SEARCH_FAILED', (error as Error)?.message || 'Failed to search users')
    }
  })

  r.get('/api/attendance-admin/users/:userId/access', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      const [roles, permissions, isAdmin] = await Promise.all([
        fetchUserRoleIds(userId),
        listUserPermissions(userId),
        isRbacAdmin(userId),
      ])

      return jsonOk(res, {
        user: profile,
        roles,
        permissions,
        isAdmin,
      })
    } catch (error) {
      return jsonError(res, 500, 'USER_ACCESS_FAILED', (error as Error)?.message || 'Failed to load user access')
    }
  })

  r.post('/api/attendance-admin/users/:userId/roles/assign', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolved = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolved?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      await ensureAttendanceRoleTemplates()

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, finalRoleId],
      )

      const [roles, permissions, isAdmin] = await Promise.all([
        fetchUserRoleIds(userId),
        listUserPermissions(userId),
        isRbacAdmin(userId),
      ])

      return jsonOk(res, {
        user: profile,
        roles,
        permissions,
        isAdmin,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_ASSIGN_FAILED', (error as Error)?.message || 'Failed to assign role')
    }
  })

  r.post('/api/attendance-admin/users/:userId/roles/unassign', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || '').trim()
      if (!userId) return jsonError(res, 400, 'USER_ID_REQUIRED', 'userId is required')

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolved = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolved?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      const profile = await fetchUserProfile(userId)
      if (!profile) return jsonError(res, 404, 'NOT_FOUND', 'User not found')

      await query(
        `DELETE FROM user_roles
         WHERE user_id = $1 AND role_id = $2`,
        [userId, finalRoleId],
      )

      const [roles, permissions, isAdmin] = await Promise.all([
        fetchUserRoleIds(userId),
        listUserPermissions(userId),
        isRbacAdmin(userId),
      ])

      return jsonOk(res, {
        user: profile,
        roles,
        permissions,
        isAdmin,
      })
    } catch (error) {
      return jsonError(res, 500, 'ROLE_UNASSIGN_FAILED', (error as Error)?.message || 'Failed to unassign role')
    }
  })

  r.get('/api/attendance-admin/audit-logs', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 50,
        maxPageSize: 200,
      })

      const term = q ? `%${q}%` : '%'
      const where = q
        ? `WHERE resource_type = 'attendance'
             AND (
               action ILIKE $1 OR actor_id ILIKE $1 OR resource_id ILIKE $1 OR route ILIKE $1
             )`
        : `WHERE resource_type = 'attendance'`

      const count = await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM operation_audit_logs ${where}`,
        q ? [term] : undefined,
      )
      const total = count.rows[0]?.c ?? 0

      const listSql = `
        SELECT
          id,
          actor_id,
          actor_type,
          action,
          resource_type,
          resource_id,
          request_id,
          COALESCE(ip, ip_address) AS ip,
          user_agent,
          route,
          status_code,
          latency_ms,
          COALESCE(occurred_at, created_at) AS occurred_at,
          COALESCE(meta, metadata, '{}'::jsonb) AS meta
        FROM operation_audit_logs
        ${where}
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `
      const params = q ? [term, pageSize, offset] : [pageSize, offset]
      const list = await query(listSql, params)

      return jsonOk(res, { items: list.rows, page, pageSize, total })
    } catch (error) {
      return jsonError(res, 500, 'AUDIT_LOGS_FAILED', (error as Error)?.message || 'Failed to load audit logs')
    }
  })

  r.get('/api/attendance-admin/audit-logs/export.csv', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '').trim()
      const from = parseDateParam(req.query.from)
      const to = parseDateParam(req.query.to)
      const rawLimit = Number(req.query.limit ?? 0) || 0
      const limit = Math.min(Math.max(rawLimit || 5000, 1), 10000)

      const params: unknown[] = []
      const clauses: string[] = [`resource_type = 'attendance'`]

      if (q) {
        const term = `%${q}%`
        params.push(term)
        const idx = params.length
        clauses.push(`(
          action ILIKE $${idx}
          OR actor_id ILIKE $${idx}
          OR resource_id ILIKE $${idx}
          OR route ILIKE $${idx}
        )`)
      }

      if (from) {
        params.push(from.toISOString())
        const idx = params.length
        clauses.push(`COALESCE(occurred_at, created_at) >= $${idx}`)
      }

      if (to) {
        params.push(to.toISOString())
        const idx = params.length
        clauses.push(`COALESCE(occurred_at, created_at) <= $${idx}`)
      }

      params.push(limit)
      const limitIdx = params.length

      const where = `WHERE ${clauses.join(' AND ')}`
      const sql = `
        SELECT
          id,
          actor_id,
          actor_type,
          action,
          resource_type,
          resource_id,
          request_id,
          COALESCE(ip, ip_address) AS ip,
          user_agent,
          route,
          status_code,
          latency_ms,
          COALESCE(occurred_at, created_at) AS occurred_at,
          COALESCE(meta, metadata, '{}'::jsonb) AS meta
        FROM operation_audit_logs
        ${where}
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT $${limitIdx}
      `

      const rows = await query(sql, params)

      const filename = `attendance-audit-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

      const header = [
        'occurredAt',
        'id',
        'actorId',
        'actorType',
        'action',
        'route',
        'statusCode',
        'latencyMs',
        'resourceType',
        'resourceId',
        'requestId',
        'ip',
        'userAgent',
        'errorCode',
        'errorMessage',
        'meta',
      ].join(',')
      const lines: string[] = [header]

      for (const row of rows.rows) {
        const meta = (row as any).meta ?? {}
        const errorCode = meta?.error?.code ?? ''
        const errorMessage = meta?.error?.message ?? ''
        const occurredRaw = (row as any).occurred_at
        const occurredAt = occurredRaw instanceof Date
          ? occurredRaw.toISOString()
          : occurredRaw
            ? new Date(occurredRaw).toISOString()
            : ''
        lines.push([
          csvCell(occurredAt),
          csvCell((row as any).id),
          csvCell((row as any).actor_id),
          csvCell((row as any).actor_type),
          csvCell((row as any).action),
          csvCell((row as any).route),
          csvCell((row as any).status_code),
          csvCell((row as any).latency_ms),
          csvCell((row as any).resource_type),
          csvCell((row as any).resource_id),
          csvCell((row as any).request_id),
          csvCell((row as any).ip),
          csvCell((row as any).user_agent),
          csvCell(errorCode),
          csvCell(errorMessage),
          csvCell(meta),
        ].join(','))
      }

      res.send(lines.join('\n'))
    } catch (error) {
      return jsonError(res, 500, 'AUDIT_LOGS_EXPORT_FAILED', (error as Error)?.message || 'Failed to export audit logs')
    }
  })

  r.post('/api/attendance-admin/users/batch/resolve', async (req: Request, res: Response) => {
    try {
      const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : []
      const { userIds, invalidUserIds } = normalizeBatchUserIds(rawIds)
      if (userIds.length === 0) return jsonError(res, 400, 'USER_IDS_REQUIRED', 'userIds is required')
      if (invalidUserIds.length) {
        return jsonError(res, 400, 'USER_IDS_INVALID', `Invalid UUID(s): ${invalidUserIds.slice(0, 5).join(', ')}`)
      }

      const resolved = await resolveBatchUsers(userIds)
      return jsonOk(res, {
        requested: userIds.length,
        found: resolved.items.length,
        missingUserIds: resolved.missingUserIds,
        inactiveUserIds: resolved.inactiveUserIds,
        items: resolved.items,
      })
    } catch (error) {
      return jsonError(res, 500, 'BATCH_USER_RESOLVE_FAILED', (error as Error)?.message || 'Failed to resolve users')
    }
  })

  r.post('/api/attendance-admin/users/batch/roles/assign', async (req: Request, res: Response) => {
    try {
      const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : []
      const { userIds, invalidUserIds } = normalizeBatchUserIds(rawIds)
      if (userIds.length === 0) return jsonError(res, 400, 'USER_IDS_REQUIRED', 'userIds is required')
      if (invalidUserIds.length) {
        return jsonError(res, 400, 'USER_IDS_INVALID', `Invalid UUID(s): ${invalidUserIds.slice(0, 5).join(', ')}`)
      }

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolvedTemplate = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolvedTemplate?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      await ensureAttendanceRoleTemplates()

      const resolvedUsers = await resolveBatchUsers(userIds)
      const eligibleUserIds = resolvedUsers.items.map((item) => item.id)
      if (eligibleUserIds.length === 0) {
        return jsonOk(res, {
          roleId: finalRoleId,
          requested: userIds.length,
          eligible: 0,
          updated: 0,
          missingUserIds: resolvedUsers.missingUserIds,
          inactiveUserIds: resolvedUsers.inactiveUserIds,
          items: resolvedUsers.items,
        })
      }

      const insert = await query<{ user_id: string }>(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT unnest($1::text[]), $2
         ON CONFLICT DO NOTHING
         RETURNING user_id`,
        [eligibleUserIds, finalRoleId],
      )

      return jsonOk(res, {
        roleId: finalRoleId,
        requested: userIds.length,
        eligible: eligibleUserIds.length,
        updated: insert.rowCount ?? insert.rows.length,
        missingUserIds: resolvedUsers.missingUserIds,
        inactiveUserIds: resolvedUsers.inactiveUserIds,
        items: resolvedUsers.items,
      })
    } catch (error) {
      return jsonError(res, 500, 'BATCH_ROLE_ASSIGN_FAILED', (error as Error)?.message || 'Failed to batch assign role')
    }
  })

  r.post('/api/attendance-admin/users/batch/roles/unassign', async (req: Request, res: Response) => {
    try {
      const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : []
      const { userIds, invalidUserIds } = normalizeBatchUserIds(rawIds)
      if (userIds.length === 0) return jsonError(res, 400, 'USER_IDS_REQUIRED', 'userIds is required')
      if (invalidUserIds.length) {
        return jsonError(res, 400, 'USER_IDS_INVALID', `Invalid UUID(s): ${invalidUserIds.slice(0, 5).join(', ')}`)
      }

      const templateId = String(req.body?.template || '').trim() as AttendanceRoleTemplateId
      const roleId = String(req.body?.roleId || '').trim()
      const resolved = templateId && ATTENDANCE_ROLE_TEMPLATES[templateId]
      const finalRoleId = resolved?.roleId || roleId
      if (!finalRoleId) return jsonError(res, 400, 'ROLE_REQUIRED', 'template or roleId is required')

      const resolvedUsers = await resolveBatchUsers(userIds)
      const eligibleUserIds = resolvedUsers.items.map((item) => item.id)
      if (eligibleUserIds.length === 0) {
        return jsonOk(res, {
          roleId: finalRoleId,
          requested: userIds.length,
          eligible: 0,
          updated: 0,
          missingUserIds: resolvedUsers.missingUserIds,
          inactiveUserIds: resolvedUsers.inactiveUserIds,
          items: resolvedUsers.items,
        })
      }

      const del = await query<{ user_id: string }>(
        `DELETE FROM user_roles
         WHERE role_id = $2 AND user_id = ANY($1::text[])
         RETURNING user_id`,
        [eligibleUserIds, finalRoleId],
      )

      return jsonOk(res, {
        roleId: finalRoleId,
        requested: userIds.length,
        eligible: eligibleUserIds.length,
        updated: del.rowCount ?? del.rows.length,
        missingUserIds: resolvedUsers.missingUserIds,
        inactiveUserIds: resolvedUsers.inactiveUserIds,
        items: resolvedUsers.items,
      })
    } catch (error) {
      return jsonError(res, 500, 'BATCH_ROLE_UNASSIGN_FAILED', (error as Error)?.message || 'Failed to batch unassign role')
    }
  })

  return r
}
