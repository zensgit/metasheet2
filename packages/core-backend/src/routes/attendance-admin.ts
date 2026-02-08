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

  return r
}

