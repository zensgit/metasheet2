// @ts-nocheck
/**
 * Views API routes
 * Handles gallery and form view configurations, data loading, and form submissions
 *
 * Phase 3: RBAC Integration
 * - Uses ViewService RBAC-aware methods for permission-controlled operations
 * - Controlled by FEATURE_TABLE_RBAC_ENABLED flag
 */

import { Router, Request, Response } from 'express'
import { db } from '../db/db'
import { query as pgQuery } from '../db/pg'
import { Logger } from '../core/logger'
import { v4 as uuidv4 } from 'uuid'
import * as viewService from '../services/view-service'
import { canReadTable, canWriteTable } from '../rbac/table-perms'

const router = Router()
const logger = new Logger('ViewsAPI')

// Helper function to get user ID from request
function getUserId(req: Request): string {
  // Extract from JWT token or dev header
  return req.headers['x-user-id'] as string || 'dev-user'
}

function getUser(req: Request) {
  return (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles || [] }
}

async function getViewById(viewId: string) {
  if (!db) return null
  try {
    return await db.selectFrom('views').selectAll().where('id', '=', viewId).executeTakeFirst()
  } catch {
    return null
  }
}

/**
 * GET /api/views/:viewId/config
 * Get view configuration
 * Phase 3: Uses ViewService for standardized config access
 */
router.get('/:viewId/config', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    const view = await getViewById(viewId)
    if (!view) {
      return res.status(404).json({ success: false, error: 'View not found' })
    }

    // Table-level RBAC
    const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }
    const tableId = (view as any).table_id as string | null
    if (tableId && !(await canReadTable(user, tableId))) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    const config = {
      id: (view as any).id,
      name: (view as any).name,
      type: (view as any).type,
      createdAt: (view as any).created_at,
      updatedAt: (view as any).updated_at,
      ...((view as any).config || {})
    }

    res.json({ success: true, data: config })

  } catch (error) {
    logger.error('Error loading view config:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to load view configuration'
    })
  }
})

/**
 * PUT /api/views/:viewId/config
 * Save view configuration
 * Phase 3: Uses ViewService RBAC-aware method for permission-controlled updates
 */
router.put('/:viewId/config', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const config = req.body
    const user = getUser(req)

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    // Prefer RBAC-aware method if available
    const updated = await (viewService as any).updateViewConfigWithRBAC?.(user, viewId, config)
      ?? await viewService.updateViewConfig(viewId, config)
    if (!updated) return res.status(404).json({ success: false, error: 'View not found' })

    res.json({ success: true, data: updated })

  } catch (error) {
    // Handle permission denied errors
    if (error instanceof Error && error.message.includes('Permission denied')) {
      logger.warn(`Permission denied for user ${getUser(req).id} updating view ${req.params.viewId}`)
      return res.status(403).json({
        success: false,
        error: 'Permission denied: You do not have write access to this view\'s table'
      })
    }

    logger.error('Error saving view config:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to save view configuration'
    })
  }
})

/**
 * GET /api/views/:viewId/data
 * Get view data with filtering, sorting, and pagination
 * Phase 3: Uses ViewService RBAC-aware query methods for permission-controlled data access
 */
router.get('/:viewId/data', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const {
      page = '1',
      pageSize = '50',
      filters = '{}',
      sorting = '[]'
    } = req.query
    const user = getUser(req)

    const pageNum = parseInt(page as string, 10)
    const pageSizeNum = parseInt(pageSize as string, 10)
    const filtersObj = JSON.parse(filters as string)
    const sortingArr = JSON.parse(sorting as string)

    if (!db) {
      return res.status(503).json({
        success: false,
        data: [],
        meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
        error: 'Database not available'
      })
    }

    // Ensure view exists and check RBAC
    const view = await getViewById(viewId)
    if (!view) {
      return res.status(404).json({
        success: false,
        data: [],
        meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
        error: 'View not found'
      })
    }
    {
      const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }
      const tableId = (view as any).table_id as string | null
      if (tableId && !(await canReadTable(user, tableId))) {
        return res.status(403).json({ success: false, data: [], meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false }, error: 'Forbidden' })
      }
    }
    {
      const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }
      const tableId = (view as any).table_id as string | null
      if (tableId && !(await canReadTable(user, tableId))) {
        return res.status(403).json({ success: false, data: [], meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false }, error: 'Forbidden' })
      }
    }

    // Delegate to ViewService based on view type
    const vtype = (view as any).type as string
    if (vtype === 'grid') {
      const r = await viewService.queryGrid({ view, page: pageNum, pageSize: pageSizeNum, filters: filtersObj, sorting: sortingArr })
      return res.json({ success: true, ...r })
    } else if (vtype === 'kanban') {
      const r = await viewService.queryKanban({ view, page: pageNum, pageSize: pageSizeNum, filters: filtersObj })
      return res.json({ success: true, ...r })
    } else {
      return res.status(501).json({ success: false, error: 'Not implemented' })
    }

  } catch (error) {
    // Handle permission denied errors
    if (error instanceof Error && error.message.includes('Permission denied')) {
      logger.warn(`Permission denied for user ${getUser(req).id} accessing view ${req.params.viewId} data`)
      return res.status(403).json({
        success: false,
        data: [],
        meta: { total: 0, page: parseInt(req.query.page as string || '1', 10), pageSize: parseInt(req.query.pageSize as string || '50', 10), hasMore: false },
        error: 'Permission denied: You do not have read access to this view\'s table'
      })
    }

    logger.error('Error loading view data:', error)
    res.status(500).json({
      success: false,
      data: [],
      meta: { total: 0, page: 1, pageSize: 50, hasMore: false },
      error: 'Failed to load view data'
    })
  }
})

/**
 * GET /api/views/:viewId/state
 * GET user's view state (filters, sorting, etc.)
 */
router.get('/:viewId/state', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const userId = getUserId(req)

    if (!db) {
      return res.status(404).json({})
    }

    const row = await db
      .selectFrom('view_states')
      .select(['state'])
      .where('view_id', '=', viewId)
      .where('user_id', '=', userId)
      .executeTakeFirst()

    if (!row) {
      return res.status(404).json({})
    }

    res.json(row.state as any)

  } catch (error) {
    logger.error('Error loading view state:', error)
    res.status(404).json({})
  }
})

/**
 * POST /api/views/:viewId/state
 * Save user's view state
 */
router.post('/:viewId/state', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const state = req.body
    const userId = getUserId(req)

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    await pgQuery(
      `INSERT INTO view_states (view_id, user_id, state, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (view_id, user_id)
       DO UPDATE SET state = $3, updated_at = NOW()`,
      [viewId, userId, JSON.stringify(state)]
    )

    res.status(204).send()

  } catch (error) {
    logger.error('Error saving view state:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to save view state'
    })
  }
})

/**
 * POST /api/views
 * Create a new view
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { tableId, type, name, description, ...configData } = req.body
    const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }
    const viewId = uuidv4()

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    if (!tableId) return res.status(400).json({ success: false, error: 'tableId required' })
    if (!(await canWriteTable(user, String(tableId)))) return res.status(403).json({ success: false, error: 'Forbidden' })

    const inserted = await db
      .insertInto('views')
      .values({ id: viewId, table_id: String(tableId), name, type, config: configData as any, created_at: new Date(), updated_at: new Date() } as any)
      .returningAll()
      .executeTakeFirst()

    res.status(201).json({ success: true, data: inserted })

  } catch (error) {
    logger.error('Error creating view:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to create view'
    })
  }
})

/**
 * DELETE /api/views/:viewId
 * Delete a view (soft delete)
 */
router.delete('/:viewId', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }

    if (!db) {
      return res.status(503).json({ success: false, error: 'Database not available' })
    }

    const current = await getViewById(viewId)
    if (!current) return res.status(404).json({ success: false, error: 'View not found' })
    const tableId = (current as any).table_id as string | null
    if (tableId && !(await canWriteTable(user, tableId))) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    const del = await db.deleteFrom('views').where('id', '=', viewId).executeTakeFirst()
    const affected = (del as any)?.numDeletedRows ? Number((del as any).numDeletedRows) : 1
    if (!affected) {
      return res.status(404).json({ success: false, error: 'View not found or access denied' })
    }

    res.json({ success: true })

  } catch (error) {
    logger.error('Error deleting view:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to delete view'
    })
  }
})

/**
 * POST /api/views/:viewId/submit
 * Submit a form
 */
router.post('/:viewId/submit', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const { data } = req.body
    const userId = getUserId(req)
    const responseId = uuidv4()

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    // Verify view exists and is a form
    const viewResult = await db.query(
      'SELECT * FROM view_configs WHERE id = $1 AND type = $2 AND deleted_at IS NULL',
      [viewId, 'form']
    )

    if (viewResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Form not found'
      })
    }

    const view = viewResult.rows[0]
    const config = JSON.parse(view.config_data || '{}')

    // Check if authentication is required
    if (config.settings?.requireAuth && !userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      })
    }

    // Get client info
    const ipAddress = req.ip || req.connection.remoteAddress
    const userAgent = req.headers['user-agent']

    // Save form response
    await db.query(
      `INSERT INTO form_responses (id, form_id, response_data, submitted_by, ip_address, user_agent, submitted_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'submitted')`,
      [responseId, viewId, JSON.stringify(data), userId, ipAddress, userAgent]
    )

    res.json({
      success: true,
      data: {
        id: responseId,
        message: 'Form submitted successfully'
      }
    })

  } catch (error) {
    logger.error('Error submitting form:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to submit form'
    })
  }
})

/**
 * GET /api/views/:viewId/responses
 * Get form responses (admin only)
 */
router.get('/:viewId/responses', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const {
      page = '1',
      pageSize = '20'
    } = req.query
    const userId = getUserId(req)

    const pageNum = parseInt(page as string, 10)
    const pageSizeNum = parseInt(pageSize as string, 10)
    const offset = (pageNum - 1) * pageSizeNum

    if (!db) {
      return res.status(503).json({
        success: false,
        data: [],
        meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
        error: 'Database not available'
      })
    }

    // Verify user has access to view responses (form creator)
    const viewResult = await db.query(
      'SELECT * FROM view_configs WHERE id = $1 AND created_by = $2 AND deleted_at IS NULL',
      [viewId, userId]
    )

    if (viewResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        data: [],
        meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
        error: 'Access denied'
      })
    }

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) FROM form_responses WHERE form_id = $1',
      [viewId]
    )
    const total = parseInt(countResult.rows[0].count, 10)

    // Get responses
    const responsesResult = await db.query(
      `SELECT id, response_data, submitted_by, ip_address, submitted_at, status
       FROM form_responses
       WHERE form_id = $1
       ORDER BY submitted_at DESC
       LIMIT $2 OFFSET $3`,
      [viewId, pageSizeNum, offset]
    )

    const responses = responsesResult.rows.map(row => {
      let data = {}
      try {
        data = row.response_data ? JSON.parse(row.response_data) : {}
      } catch (e) {
        console.warn(`Failed to parse response_data for row ${row.id}:`, e instanceof Error ? e.message : String(e))
      }
      return {
        id: row.id,
        formId: viewId,
        data,
        submittedAt: row.submitted_at,
        submittedBy: row.submitted_by,
        ipAddress: row.ip_address,
        status: row.status
      }
    })

    const hasMore = offset + pageSizeNum < total

    res.json({
      success: true,
      data: responses,
      meta: {
        total,
        page: pageNum,
        pageSize: pageSizeNum,
        hasMore
      }
    })

  } catch (error) {
    logger.error('Error loading form responses:', error)
    res.status(500).json({
      success: false,
      data: [],
      meta: { total: 0, page: 1, pageSize: 20, hasMore: false },
      error: 'Failed to load form responses'
    })
  }
})

/**
 * POST /api/views/gallery
 * Create a gallery view
 */
router.post('/gallery', async (req: Request, res: Response) => {
  try {
    const config = req.body
    const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }
    const viewId = uuidv4()

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    if (!config.tableId) return res.status(400).json({ success: false, error: 'tableId required' })
    if (!(await canWriteTable(user, String(config.tableId)))) return res.status(403).json({ success: false, error: 'Forbidden' })
    const inserted = await db
      .insertInto('views')
      .values({ id: viewId, table_id: String(config.tableId), name: config.name, type: 'gallery', config: config as any, created_at: new Date(), updated_at: new Date() } as any)
      .returningAll()
      .executeTakeFirst()
    res.status(201).json({ success: true, data: inserted })

  } catch (error) {
    logger.error('Error creating gallery view:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to create gallery view'
    })
  }
})

/**
 * POST /api/views/form
 * Create a form view
 */
router.post('/form', async (req: Request, res: Response) => {
  try {
    const config = req.body
    const user = (req as any).user || { id: getUserId(req), roles: (req as any).user?.roles }
    const viewId = uuidv4()

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      })
    }

    if (!config.tableId) return res.status(400).json({ success: false, error: 'tableId required' })
    if (!(await canWriteTable(user, String(config.tableId)))) return res.status(403).json({ success: false, error: 'Forbidden' })
    const inserted = await db
      .insertInto('views')
      .values({ id: viewId, table_id: String(config.tableId), name: config.name, type: 'form', config: config as any, created_at: new Date(), updated_at: new Date() } as any)
      .returningAll()
      .executeTakeFirst()
    res.status(201).json({ success: true, data: inserted })

  } catch (error) {
    logger.error('Error creating form view:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to create form view'
    })
  }
})

export default router
