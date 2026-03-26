import type { Request, Response } from 'express'
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { pool } from '../db/pg'
import { parsePagination } from '../util/response'

export function approvalHistoryRouter(): Router {
  const r = Router()

  r.get('/api/approvals/:id/history', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'DB not configured',
        },
      })
    }

    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1', [id])
    const total = Number(countRes.rows[0]?.c || 0)
    const { rows } = await pool.query(
      `SELECT occurred_at, actor_id, action, comment, from_status, to_status, version
       FROM approval_records
       WHERE instance_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2 OFFSET $3`,
      [id, pageSize, offset],
    )

    return res.json({
      ok: true,
      data: {
        items: rows,
        page,
        pageSize,
        total,
      },
    })
  })

  return r
}
