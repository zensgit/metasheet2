import { Router } from 'express'
import type { Request, Response } from 'express'
import { changeManagementService } from '../services/ChangeManagementService'
import { schemaSnapshotService } from '../services/SchemaSnapshotService'
import { Logger } from '../core/logger'

const logger = new Logger('ChangeManagementRoutes')
const router = Router()

// Middleware to extract user (mock for now if not present)
const getUser = (req: Request): string => {
  const headerUserId = req.headers['x-user-id']
  const userId = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId
  return req.user?.id?.toString() || userId || 'anonymous'
}

/**
 * POST /api/changes
 * Create a change request
 */
router.post('/changes', async (req: Request, res: Response) => {
  try {
    const userId = getUser(req)
    const result = await changeManagementService.createChangeRequest({
      ...req.body,
      requestedBy: userId
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to create change request', error as Error)
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

/**
 * POST /api/changes/:id/approve
 * Approve a change request
 */
router.post('/changes/:id/approve', async (req: Request, res: Response) => {
  try {
    const userId = getUser(req)
    const result = await changeManagementService.approveChangeRequest(
      req.params.id,
      userId,
      req.body.comment
    )
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to approve change request', error as Error)
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

/**
 * POST /api/changes/:id/deploy
 * Deploy a change request
 */
router.post('/changes/:id/deploy', async (req: Request, res: Response) => {
  try {
    const userId = getUser(req)
    const result = await changeManagementService.deployChange(
      req.params.id,
      userId,
      { dryRun: req.body.dry_run, force: req.body.force }
    )
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to deploy change request', error as Error)
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

/**
 * POST /api/changes/:id/rollback
 * Rollback a change request
 */
router.post('/changes/:id/rollback', async (req: Request, res: Response) => {
  try {
    const userId = getUser(req)
    const result = await changeManagementService.rollbackChange(
      req.params.id,
      userId,
      req.body.reason
    )
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to rollback change request', error as Error)
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

/**
 * POST /api/schemas/:viewId/snapshot
 * Create a schema snapshot
 */
router.post('/schemas/:viewId/snapshot', async (req: Request, res: Response) => {
  try {
    const userId = getUser(req)
    const result = await schemaSnapshotService.createSchemaSnapshot(
      req.params.viewId,
      userId
    )
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to create schema snapshot', error as Error)
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

/**
 * GET /api/schemas/diff
 * Diff two schema snapshots
 */
router.get('/schemas/diff', async (req: Request, res: Response) => {
  try {
    const { schema1, schema2 } = req.query
    if (!schema1 || !schema2) {
      return res.status(400).json({ success: false, error: 'Missing schema1 or schema2 params' })
    }
    const diff = await schemaSnapshotService.diffSchemas(
      String(schema1),
      String(schema2)
    )
    res.json({ success: true, data: diff })
  } catch (error) {
    logger.error('Failed to diff schemas', error as Error)
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

export default router
