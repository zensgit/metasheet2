import { Router } from 'express'
import type { Request, Response } from 'express'
import { changeManagementService } from '../services/ChangeManagementService'
import { schemaSnapshotService } from '../services/SchemaSnapshotService'
import { Logger } from '../core/logger'
import { requireAdminRole } from '../guards/audit-integration'

const logger = new Logger('ChangeManagementRoutes')
const router = Router()

// SECURITY (GHSA-q7hj): the entire change-management surface — change create/approve/deploy/rollback
// AND schema snapshot/diff — performs privileged, side-effecting operations (a deploy can drive a full
// snapshot restore). Gate it on platform-admin. requireAdminRole() reads the authenticated principal
// (req.user, set by jwtAuthMiddleware), calls isAdmin(user.id), returns 403 for a non-admin, and FAILS
// CLOSED (503, never next()) if the permission check itself throws.
//
// The guard is bound to this router's OWN namespaces (/changes, /schemas) rather than added path-less.
// This router is mounted at `app.use('/api', changeManagementRouter)` (index.ts), so a path-less
// `router.use(guard)` would execute for EVERY /api/* request that reaches this router in the chain —
// 403'ing unrelated endpoints mounted after it (e.g. /api/admin/*) for any non-admin. Every route below
// lives under /changes or /schemas, so these two mounts cover the whole surface (and any future route in
// those namespaces) without leaking the gate to sibling routers.
router.use('/changes', requireAdminRole())
router.use('/schemas', requireAdminRole())

// Identity comes ONLY from the authenticated principal. requireAdminRole() above guarantees req.user
// is present; we never trust an `x-user-id` header and never fall back to a spoofable `anonymous`
// identity (GHSA-q7hj). If req.user.id is somehow absent, fail rather than impersonate.
const getUser = (req: Request): string => {
  const id = req.user?.id
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error('unauthenticated: change-management requires an authenticated req.user.id')
  }
  return String(id)
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
    // SECURITY (GHSA-q7hj): a caller-supplied `force` would drive a real full snapshot restore with no
    // break-glass controls. Reject ANY truthy force outright — forced restore is not permitted via this
    // endpoint (a genuine forced restore is a separate named, reason-logged, strongly-audited scheme).
    // Never forward a caller-supplied force to the service.
    if (req.body.force) {
      return res.status(400).json({ success: false, error: 'force restore is not permitted via this endpoint' })
    }
    const result = await changeManagementService.deployChange(
      req.params.id,
      userId,
      { dryRun: req.body.dry_run, force: false }
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
