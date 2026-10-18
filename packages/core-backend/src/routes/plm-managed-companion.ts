/**
 * Managed-login consumer routes.
 * The callback is a browser GET. It is not a cross-origin POST and it does not
 * return the native credential.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { ManagedCompanionRefusal } from '../services/plm-managed-companion'
import {
  completeManagedCallback,
  provisionManagedLink,
  readManagedSessionStatus,
  retryManagedRevoke,
  revokeManagedLink,
  startManagedLogin,
  transferManagedLink,
  unlinkManagedSource,
  type ManagedActor,
} from '../services/plm-managed-companion-flow'

const router = Router()

function sendRefusal(res: Response, error: unknown): void {
  if (error instanceof ManagedCompanionRefusal) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message },
    })
    return
  }
  res.status(503).json({
    ok: false,
    error: { code: 'PLM_MANAGED_UNAVAILABLE', message: 'Managed companion is unavailable' },
  })
}

function actorFrom(req: Request): ManagedActor {
  const user = req.user
  if (!user || typeof user.id !== 'string' || user.id.length === 0) {
    throw new ManagedCompanionRefusal(401, 'PLM_MANAGED_ACTOR_REFUSED')
  }
  const authenticatedTenantId = typeof req.authenticatedTenantId === 'string'
    ? req.authenticatedTenantId.trim()
    : ''
  return {
    id: user.id,
    role: typeof user.role === 'string' ? user.role : null,
    authenticatedTenantId: authenticatedTenantId || null,
  }
}

router.post('/links', async (req: Request, res: Response) => {
  try {
    res.json(await provisionManagedLink(actorFrom(req), req.body))
  } catch (error) {
    sendRefusal(res, error)
  }
})

router.post('/links/:id/transfer', async (req: Request, res: Response) => {
  try {
    res.json(await transferManagedLink(actorFrom(req), req.params.id, req.body ?? {}))
  } catch (error) {
    sendRefusal(res, error)
  }
})

router.post('/links/:id/revoke', async (req: Request, res: Response) => {
  try {
    res.json(await revokeManagedLink(actorFrom(req), req.params.id, req.body ?? {}))
  } catch (error) {
    sendRefusal(res, error)
  }
})

router.post('/start', async (req: Request, res: Response) => {
  try {
    res.json(await startManagedLogin(actorFrom(req), req.body, res))
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.get('/callback', async (req: Request, res: Response) => {
  try {
    await completeManagedCallback(req, res)
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.post('/callback', (_req: Request, res: Response) => {
  res.set('Allow', 'GET')
  res.status(405).json({
    ok: false,
    error: { code: 'PLM_MANAGED_CALLBACK_GET_ONLY', message: 'Managed login callback is a browser navigation' },
  })
})

router.post('/unlink', async (req: Request, res: Response) => {
  try {
    res.json(await unlinkManagedSource(actorFrom(req), req.body))
  } catch (error) {
    sendRefusal(res, error)
  }
})

router.post('/revoke-retry', async (req: Request, res: Response) => {
  try {
    res.json(await retryManagedRevoke(actorFrom(req), req.body))
  } catch (error) {
    sendRefusal(res, error)
  }
})

router.get('/session', async (req: Request, res: Response) => {
  try {
    const dataSourceId = req.query.dataSourceId
    if (typeof dataSourceId !== 'string') throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
    res.json(await readManagedSessionStatus(actorFrom(req), dataSourceId))
  } catch (error) {
    sendRefusal(res, error)
  }
})

export default router
