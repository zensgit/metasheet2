import { json, Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { authenticate } from '../middleware/auth'
import { isElearningEnabled } from '../elearning/feature-flags'
import { rbacGuard } from '../rbac/rbac'
import { isElearningGlobalAdminRequest } from './elearning-admin-access'
import type { ElearningAdminAccessDb } from '../services/elearning-admin-access'
import {
  changeElearningAppInstallation,
  ElearningAppInstallationError,
  readElearningAppInstallation,
} from '../services/elearning-app-installation'

const PATH = '/api/elearning-app/installation'
function identity(req: Request): { orgId: string; actorId: string } | null {
  const orgId = req.authenticatedTenantId
  const actorId = req.user?.id ?? req.user?.userId
  return typeof orgId === 'string' && orgId.trim() === orgId && orgId.length > 0
    && typeof actorId === 'string' && actorId.length > 0 ? { orgId, actorId } : null
}

/** The one switched-off answer of this file; both gates below send it, so they cannot drift apart. */
function sendFeatureDisabled(res: Response): void {
  res.status(404).json({ error: 'feature_disabled' })
}

/**
 * Master switch for the installation surface (ELEARNING_ENABLED, exact literal 'true', read per
 * request like `requireElearningAppInstallation` below). While it is off, every method on the
 * installation path answers what the business gate answers for a switched-off feature and reaches
 * neither the org-context check, the admin guard, the body parser nor the database: no install, no
 * enable, and no read that could tell whether an installation row exists. Rows written earlier are
 * left exactly as they are and take effect again once the switch is on.
 */
export function requireElearningEnabled(options: { env?: NodeJS.ProcessEnv } = {}): RequestHandler {
  return (_req, res, next) => {
    if (!isElearningEnabled(options.env ?? process.env)) { sendFeatureDisabled(res); return }
    next()
  }
}

export function createElearningAppInstallationRouter(options: {
  getDb(): ElearningAdminAccessDb
  authenticate?: RequestHandler
  adminGuard?: RequestHandler
  /**
   * Runs right after authentication, before everything else on the installation path. index.ts
   * passes `requireElearningEnabled()`; the real-assembly case in
   * tests/unit/elearning-app-installation.test.ts reddens if that mount loses it.
   */
  featureGate?: RequestHandler
}): Router {
  const router = Router()
  const context: RequestHandler = (req, res, next) => {
    if (!identity(req)) { res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' }); return }
    next()
  }
  const featureGate: RequestHandler = options.featureGate ?? ((_req, _res, next) => { next() })
  router.use(PATH, options.authenticate ?? authenticate, featureGate, context)
  router.get(PATH, (req, res) => {
    const input = identity(req)!
    const db = options.getDb()
    void readElearningAppInstallation(db, input.orgId)
      .then(async (state) => {
        const canManage = isElearningGlobalAdminRequest(req)
          && (await db.query(`SELECT user_id FROM user_orgs
            WHERE org_id = $1 AND user_id = $2 AND is_active = true`,
          [input.orgId, input.actorId])).rows.length === 1
        res.json({ ...state, canManage })
      })
      .catch(() => res.status(503).json({ error: 'unavailable' }))
  })
  const write: RequestHandler = (req, res) => {
    const body: unknown = req.body
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null
    const config = body as { enabled?: unknown; notificationsEnabled?: unknown } | undefined
    const install = req.method === 'POST'
    if (!keys || (install ? keys.length !== 0 : keys.length !== 2
      || !keys.includes('enabled') || !keys.includes('notificationsEnabled')
      || typeof config?.enabled !== 'boolean' || typeof config?.notificationsEnabled !== 'boolean')) {
      res.status(400).json({ error: 'invalid_input' }); return
    }
    void changeElearningAppInstallation(options.getDb(), {
      ...identity(req)!, isGlobalAdmin: isElearningGlobalAdminRequest(req),
    }, install ? undefined : {
      enabled: config!.enabled as boolean,
      notificationsEnabled: config!.notificationsEnabled as boolean,
    }).then((state) => res.json({ ...state, canManage: true })).catch((error: unknown) => {
      const code = error instanceof ElearningAppInstallationError ? error.code : 'unavailable'
      res.status(code === 'forbidden' ? 403 : code === 'not_installed' ? 409 : 503).json({ error: code })
    })
  }
  router.post(PATH, options.adminGuard ?? rbacGuard('elearning', 'admin'), json({ limit: '1kb' }), write)
  router.put(PATH, options.adminGuard ?? rbacGuard('elearning', 'admin'), json({ limit: '1kb' }), write)
  const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: 'invalid_input' })
  }
  router.use(PATH, invalidJson)
  return router
}

/** Mounted after public signed playback, before all authenticated business/plugin routers. */
export function requireElearningAppInstallation(options: {
  getDb(): ElearningAdminAccessDb
  env?: NodeJS.ProcessEnv
}): RequestHandler {
  return (req, res, next) => {
    if (!isElearningEnabled(options.env ?? process.env)) {
      sendFeatureDisabled(res); return
    }
    const input = identity(req)
    if (!input) { res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' }); return }
    void readElearningAppInstallation(options.getDb(), input.orgId).then((state) => {
      if (state.status !== 'active') { res.status(403).json({ error: 'app_not_enabled' }); return }
      next()
    }).catch(() => res.status(503).json({ error: 'unavailable' }))
  }
}
