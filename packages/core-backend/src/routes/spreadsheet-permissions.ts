import type { Request, Response} from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { pool } from '../db/pg'

// Use the global Express.Request type which already includes user property
type AuthenticatedRequest = Request

// Database row type for permission query results
interface PermissionRow {
  perm_code: string;
  [key: string]: unknown;
}

// 简易内存：sheetId -> userId -> perms
const sheetPerms = new Map<string, Map<string, Set<string>>>()

export function spreadsheetPermissionsRouter(): Router {
  const r = Router()

  r.get('/api/spreadsheets/:id/permissions', rbacGuard('spreadsheet-permissions', 'read'), async (req: Request, res: Response) => {
    if (pool) {
      const { rows } = await pool.query('SELECT user_id, perm_code FROM spreadsheet_permissions WHERE sheet_id=$1', [req.params.id])
      const grouped: Record<string, Set<string>> = {}
      for (const r of rows) {
        grouped[r.user_id] = grouped[r.user_id] || new Set<string>()
        grouped[r.user_id].add(r.perm_code)
      }
      const items = Object.entries(grouped).map(([userId, set]) => ({ userId, permissions: Array.from(set) }))
      return res.json({ ok: true, data: { items } })
    }
    const map = sheetPerms.get(req.params.id) || new Map<string, Set<string>>()
    const items = Array.from(map.entries()).map(([userId, set]) => ({ userId, permissions: Array.from(set) }))
    return res.json({ ok: true, data: { items } })
  })

  r.post('/api/spreadsheets/:id/permissions/grant', rbacGuard('spreadsheet-permissions', 'write'), async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.body?.userId
    const perm = req.body?.permission
    if (!userId || !perm) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } })
    if (pool) {
      await pool.query('INSERT INTO spreadsheet_permissions(sheet_id, user_id, perm_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, userId, perm])
    } else {
      const map = sheetPerms.get(req.params.id) || new Map<string, Set<string>>()
      const set = map.get(userId) || new Set<string>()
      set.add(perm)
      map.set(userId, set)
      sheetPerms.set(req.params.id, map)
    }
    await auditLog({ actorId: req.user?.id != null ? String(req.user.id) : undefined, actorType: 'user', action: 'grant', resourceType: 'spreadsheet-permission', resourceId: `${req.params.id}:${userId}:${perm}` })
    if (pool) {
      const { rows } = await pool.query<PermissionRow>('SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id=$1 AND user_id=$2', [req.params.id, userId])
      return res.json({ ok: true, data: { userId, permissions: rows.map((r: PermissionRow) => r.perm_code) } })
    } else {
      const set = (sheetPerms.get(req.params.id) as Map<string, Set<string>>).get(userId) as Set<string>
      return res.json({ ok: true, data: { userId, permissions: Array.from(set) } })
    }
  })

  r.post('/api/spreadsheets/:id/permissions/revoke', rbacGuard('spreadsheet-permissions', 'write'), async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.body?.userId
    const perm = req.body?.permission
    if (!userId || !perm) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } })
    if (pool) {
      await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id=$1 AND user_id=$2 AND perm_code=$3', [req.params.id, userId, perm])
    } else {
      const map = sheetPerms.get(req.params.id) || new Map<string, Set<string>>()
      const set = map.get(userId) || new Set<string>()
      set.delete(perm)
      map.set(userId, set)
      sheetPerms.set(req.params.id, map)
    }
    await auditLog({ actorId: req.user?.id != null ? String(req.user.id) : undefined, actorType: 'user', action: 'revoke', resourceType: 'spreadsheet-permission', resourceId: `${req.params.id}:${userId}:${perm}` })
    if (pool) {
      const { rows } = await pool.query<PermissionRow>('SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id=$1 AND user_id=$2', [req.params.id, userId])
      return res.json({ ok: true, data: { userId, permissions: rows.map((r: PermissionRow) => r.perm_code) } })
    } else {
      const set = (sheetPerms.get(req.params.id) as Map<string, Set<string>>).get(userId) as Set<string>
      return res.json({ ok: true, data: { userId, permissions: Array.from(set) } })
    }
  })

  return r
}
