/**
 * Kanban MVP API
 *
 * Implements view-based Kanban endpoints backed by `views` + `view_states`.
 * This is the stable contract used by the frontend Kanban view.
 *
 * Notes:
 * - Uses UUID-constrained routes to avoid colliding with legacy plugin routes.
 * - Requires JWT (handled by global /api/** middleware).
 */

import type { Request } from 'express'
import { Router } from 'express'
import crypto from 'crypto'
import { poolManager } from '../integration/db/connection-pool'
import { Logger } from '../core/logger'

const logger = new Logger('KanbanRoutes')

const UUID_PARAM =
  ':viewId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'

function getUserId(req: Request): number {
  const user = (req as unknown as { user?: { id?: unknown } }).user
  const raw = user?.id ?? req.headers['x-user-id']

  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>
  return {}
}

function computeEtag(payload: unknown): string {
  const json = JSON.stringify(payload)
  const hash = crypto.createHash('sha1').update(json).digest('hex')
  // Strong ETag (quoted)
  return `"${hash}"`
}

export function kanbanRouter() {
  const router = Router()

  if (process.env.NODE_ENV !== 'production') {
    router.get('/board1', (_req, res) => {
      return res.json({
        success: true,
        data: [
          {
            id: 'todo',
            title: '待处理',
            cards: [
              { id: '1', title: '设计数据库架构', content: '设计插件系统的数据库表结构', status: 'todo' },
              { id: '2', title: '实现权限系统', content: '实现基于角色的访问控制', status: 'todo' }
            ],
            order: 1
          },
          {
            id: 'in_progress',
            title: '进行中',
            cards: [
              { id: '3', title: '开发插件加载器', content: '实现插件的动态加载和卸载功能', status: 'in_progress' }
            ],
            order: 2
          },
          {
            id: 'done',
            title: '已完成',
            cards: [
              { id: '4', title: '项目初始化', content: '创建项目结构和基础配置', status: 'done' },
              { id: '5', title: '微内核设计', content: '完成微内核架构设计', status: 'done' }
            ],
            order: 3
          }
        ]
      })
    })
  }

  /**
   * GET /api/kanban/:viewId
   * Returns view config + per-user state; supports ETag/If-None-Match.
   */
  router.get(`/${UUID_PARAM}`, async (req, res) => {
    try {
      const { viewId } = req.params
      const userId = getUserId(req)
      const pool = poolManager.get()

      const viewResult = await pool.query(
        'SELECT id, type, name, config, updated_at FROM views WHERE id = $1 AND deleted_at IS NULL',
        [viewId],
      )

      if (viewResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      const view = viewResult.rows[0] as {
        id: string
        type: string
        name: string
        config: unknown
        updated_at: Date | string
      }

      if (view.type !== 'kanban') {
        return res.status(400).json({ success: false, error: 'View type is not kanban' })
      }

      const config = normalizeJson(view.config)

      const stateResult = await pool.query(
        'SELECT state, updated_at FROM view_states WHERE view_id = $1 AND user_id = $2',
        [viewId, userId],
      )

      const stateRow = stateResult.rows[0] as { state: unknown; updated_at: Date | string } | undefined
      const state = stateRow ? normalizeJson(stateRow.state) : {}

      const payload = {
        viewId: view.id,
        name: view.name,
        config,
        state,
        updatedAt: view.updated_at,
      }

      const etag = computeEtag(payload)
      const ifNoneMatch = req.headers['if-none-match']
      if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
        return res.status(304).end()
      }

      res.setHeader('ETag', etag)
      return res.json({ success: true, data: payload })
    } catch (error) {
      logger.error('Failed to get kanban view', error as Error)
      return res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  /**
   * POST /api/kanban/:viewId/state
   * Persists per-user kanban state (drag/sort/filter UI state).
   */
  router.post(`/${UUID_PARAM}/state`, async (req, res) => {
    try {
      const { viewId } = req.params
      const userId = getUserId(req)
      const { state } = (req.body || {}) as { state?: unknown }
      const pool = poolManager.get()

      const exists = await pool.query(
        'SELECT 1 FROM views WHERE id = $1 AND deleted_at IS NULL',
        [viewId],
      )
      if (exists.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      await pool.query(
        `INSERT INTO view_states (view_id, user_id, state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (view_id, user_id) DO UPDATE SET
           state = EXCLUDED.state,
           updated_at = NOW()`,
        [viewId, userId, JSON.stringify(state ?? {})],
      )

      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to persist kanban state', error as Error)
      return res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  return router
}
