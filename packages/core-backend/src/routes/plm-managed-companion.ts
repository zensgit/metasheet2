import { sendVisualPreviewImage } from '../auth/visual-preview-response'
import type { VisualPreviewImage } from '../services/plm-visual-preview-transport'
/**
 * Managed-login consumer routes.
 * The callback GET only hands the browser to the return view. Exchange waits
 * for the same-origin complete POST. Neither response returns the native credential.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { describeManagedCookie, managedSessionClientOrigin, revokePresentedManagedSession } from '../auth/plm-managed-session'
import { buildFeaturePayload } from './auth'
import { handoffSnapshotShare } from '../services/plm-managed-snapshot-share-flow'
import { relayManagedDiscussion } from '../services/plm-managed-discussion'
import {
  MANAGED_SESSION_COOKIE,
  ManagedCompanionRefusal,
  cookieSecureFor,
  readRequestCookie,
} from '../services/plm-managed-companion'
import {
  assertManagedBridge,
  assertManagedOrigin,
  completeManagedBrowserLogin,
  handoffManagedCallback,
  recoverManagedContinuousSession,
  provisionManagedLink,
  readManagedSessionStatus,
  retryManagedRevoke,
  revokeManagedLink,
  startManagedBrowserLogin,
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

function methodNotAllowed(res: Response, allow: string, code: string): void {
  res.set('Allow', allow)
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  res.status(405).json({
    ok: false,
    error: { code, message: 'Managed companion request refused' },
  })
}

function managedCurrentPayload(described: NonNullable<Awaited<ReturnType<typeof describeManagedCookie>>>) {
  const user = described.user
  const session = described.descriptor
  const permissions = Array.isArray(user.permissions)
    ? user.permissions.filter((permission): permission is string => typeof permission === 'string')
    : []
  return {
    success: true,
    data: {
      user: {
        id: user.id,
        email: typeof user.email === 'string' ? user.email : null,
        name: user.name,
        role: user.role,
        permissions,
        tenantId: typeof user.tenantId === 'string' ? user.tenantId : null,
        must_change_password: user.must_change_password === true,
      },
      features: buildFeaturePayload(user),
      managedSession: {
        mode: session.mode,
        userId: session.userId,
        tenantId: session.tenantId,
        sessionId: session.sessionId,
        revision: session.revision,
        expiresAt: session.expiresAt,
      },
    },
  }
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

router.post('/discussion-context', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  try {
    res.json({ ok: true, data: await relayManagedDiscussion(req) })
  } catch (error) { sendRefusal(res, error) }
})

router.post('/sources/:sourceId/discussion', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  try {
    const data = await relayManagedDiscussion(req, req.params.sourceId)
    if (req.body?.operation === 'preview-image') return sendVisualPreviewImage(res, data as VisualPreviewImage)
    res.json({ ok: true, data })
  } catch (error) { sendRefusal(res, error) }
})

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
    if (typeof req.query.code === 'string' && req.query.code.startsWith('yus_')) {
      await handoffSnapshotShare(req, res)
    } else handoffManagedCallback(req, res)
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

router.post('/browser-start', async (req: Request, res: Response) => {
  try {
    res.json(await startManagedBrowserLogin(req, res))
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.all('/browser-start', (_req: Request, res: Response) => {
  methodNotAllowed(res, 'POST', 'PLM_MANAGED_BROWSER_START_POST_ONLY')
})

router.post('/complete', async (req: Request, res: Response) => {
  try {
    await completeManagedBrowserLogin(req, res)
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.all('/complete', (_req: Request, res: Response) => {
  methodNotAllowed(res, 'POST', 'PLM_MANAGED_COMPLETE_POST_ONLY')
})

router.post('/renew-recovery', async (req: Request, res: Response) => {
  try {
    await recoverManagedContinuousSession(req, res)
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.all('/renew-recovery', (_req: Request, res: Response) => {
  methodNotAllowed(res, 'POST', 'PLM_MANAGED_RENEW_RECOVERY_POST_ONLY')
})

router.get('/current', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    const token = readRequestCookie(req.headers.cookie, MANAGED_SESSION_COOKIE)
    const described = token ? await describeManagedCookie(token) : null
    if (!described) {
      res.status(401).json({
        success: false,
        error: { code: 'PLM_MANAGED_SESSION_REQUIRED', message: 'Managed companion request refused' },
      })
      return
    }
    res.json(managedCurrentPayload(described))
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.all('/current', (_req: Request, res: Response) => {
  methodNotAllowed(res, 'GET', 'PLM_MANAGED_CURRENT_GET_ONLY')
})

router.post('/logout', async (req: Request, res: Response) => {
  try {
    assertManagedBridge(req, 'logout')
    const token = readRequestCookie(req.headers.cookie, MANAGED_SESSION_COOKIE) ?? ''
    const storedOrigin = token ? await managedSessionClientOrigin(token) : null
    if (storedOrigin) assertManagedOrigin(req, storedOrigin)
    else if (!req.headers.origin || typeof req.headers.origin !== 'string') {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ORIGIN_REFUSED')
    }
    const revoked = token ? await revokePresentedManagedSession(token) : null
    const secureOrigin = storedOrigin || (typeof req.headers.origin === 'string' ? req.headers.origin : 'http://127.0.0.1')
    res.clearCookie(MANAGED_SESSION_COOKIE, {
      httpOnly: true,
      secure: cookieSecureFor(secureOrigin),
      sameSite: 'lax',
      path: '/',
    })
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    res.json({ ok: true, revoked: revoked !== null })
  } catch (error) {
    if (!res.headersSent) sendRefusal(res, error)
  }
})

router.all('/logout', (_req: Request, res: Response) => {
  methodNotAllowed(res, 'POST', 'PLM_MANAGED_LOGOUT_POST_ONLY')
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
