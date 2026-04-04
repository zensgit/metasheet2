import type { Injector } from '@wendellhu/redi'
import type { Request, Response } from 'express'
import { Router } from 'express'
import { IPLMAdapter } from '../di/identifiers'
import { authenticate } from '../middleware/auth'
import { pool } from '../db/pg'
import { ApprovalBridgeService } from '../services/ApprovalBridgeService'
import type { ApprovalBridgePlmAdapter } from '../services/approval-bridge-types'
import { parsePagination } from '../util/response'

interface ApprovalHistoryRouterOptions {
  injector?: Injector
  plmAdapter?: ApprovalBridgePlmAdapter | null
}

function isPlmApprovalId(id: string): boolean {
  return id.startsWith('plm:')
}

function resolvePlmAdapter(options?: ApprovalHistoryRouterOptions): ApprovalBridgePlmAdapter | null {
  if (options?.plmAdapter) {
    return options.plmAdapter
  }
  if (!options?.injector) {
    return null
  }
  return options.injector.get(IPLMAdapter) as unknown as ApprovalBridgePlmAdapter
}

export function approvalHistoryRouter(options?: ApprovalHistoryRouterOptions): Router {
  const r = Router()

  r.get('/api/approvals/:id/history', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id
    if (isPlmApprovalId(id)) {
      const plmAdapter = resolvePlmAdapter(options)
      if (!plmAdapter) {
        return res.status(503).json({
          ok: false,
          error: {
            code: 'PLM_APPROVAL_BRIDGE_UNAVAILABLE',
            message: 'PLM approval bridge is not configured',
          },
        })
      }

      const history = await new ApprovalBridgeService(plmAdapter).getApprovalHistory(id)
      return res.json({
        ok: true,
        data: {
          items: history,
          page: 1,
          pageSize: history.length,
          total: history.length,
        },
      })
    }

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
      `SELECT
         id,
         occurred_at,
         actor_id,
         actor_name,
         action,
         comment,
         from_status,
         to_status,
         COALESCE(to_version, version) AS version,
         from_version,
         to_version
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
