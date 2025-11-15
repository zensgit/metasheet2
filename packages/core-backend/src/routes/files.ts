import { Request, Response, Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { pool } from '../db/pg'

export function filesRouter(): Router {
  const r = Router()

  r.post('/api/files/upload', rbacGuard('files', 'write'), async (req: Request, res: Response) => {
    const id = `file_${Date.now()}`
    const url = req.body?.url || null
    const ownerId = (req as any).user?.id || null
    if (pool) {
      await pool.query('INSERT INTO files(id, url, owner_id, meta) VALUES ($1,$2,$3,$4)', [id, url, ownerId, JSON.stringify({})])
    }
    await auditLog({ actorId: ownerId || undefined, actorType: 'user', action: 'upload', resourceType: 'file', resourceId: id, meta: { url } })
    return res.json({ ok: true, data: { id, url } })
  })

  r.get('/api/files/:id', rbacGuard('files', 'read'), async (req: Request, res: Response) => {
    if (pool) {
      const { rows } = await pool.query('SELECT id, url, owner_id, meta, created_at FROM files WHERE id=$1', [req.params.id])
      if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'File not found' } })
      await auditLog({ actorId: (req as any).user?.id, actorType: 'user', action: 'read', resourceType: 'file', resourceId: req.params.id })
      return res.json({ ok: true, data: rows[0] })
    }
    await auditLog({ actorId: (req as any).user?.id, actorType: 'user', action: 'read', resourceType: 'file', resourceId: req.params.id })
    return res.json({ ok: true, data: { id: req.params.id, url: `http://localhost:${process.env.PORT||8900}/files/${req.params.id}` } })
  })

  return r
}
