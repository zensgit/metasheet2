/**
 * Unmounted admin-grant proof router. Production auth does not mount this factory.
 * The router installs no body parser and no target or body-size cap. A test that mounts it
 * states the parser it installs. The browser cookie is written only by the actor-input
 * factory after its establish transaction commits.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { AdminGrantActorInputError } from '../auth/admin-grant-local-credential'
import { createAdminGrantBrowserContext } from '../auth/admin-grant-browser-context'
import { readAuthenticatedSessionContext, SecurityActionProofContractError } from '../auth/security-action-proof'
import {
  AdminGrantProofContractError,
  AdminGrantProofError,
  createAdminGrantProofService,
  retainAdminGrantBrowserContext,
} from '../auth/admin-grant-proof'
import type { AdminGrantProofServiceOptions } from '../auth/admin-grant-proof'

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
}

function refuse(res: Response, status: number, code: string, retryAfter?: number): void {
  const error = typeof retryAfter === 'number'
    ? { code, message: 'Admin grant proof refused', retryAfter }
    : { code, message: 'Admin grant proof refused' }
  res.status(status).json({ ok: false, error })
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return null
  return origin
}

function sendFailure(res: Response, error: unknown): void {
  if (res.headersSent) return
  if (error instanceof AdminGrantProofError) {
    refuse(res, error.status, error.code, error.retryAfter)
    return
  }
  if (error instanceof AdminGrantProofContractError) {
    if (error.code === 'ADMIN_GRANT_INPUT_SHAPE') {
      refuse(res, 422, 'ADMIN_GRANT_INVALID_REQUEST')
      return
    }
    if (error.code === 'ADMIN_GRANT_ORIGIN_INVALID') {
      refuse(res, 403, 'ADMIN_GRANT_ORIGIN_REJECTED')
      return
    }
    if (error.code === 'ADMIN_GRANT_CONTEXT_REQUIRED') {
      refuse(res, 401, 'ADMIN_GRANT_SESSION_REQUIRED')
      return
    }
  }
  if (error instanceof AdminGrantActorInputError) {
    if (error.code === 'ADMIN_GRANT_BROWSER_ORIGIN_INVALID' || error.code === 'ADMIN_GRANT_BROWSER_ORIGIN_MISMATCH') {
      refuse(res, 403, 'ADMIN_GRANT_ORIGIN_REJECTED')
      return
    }
    if (error.code === 'ADMIN_GRANT_BROWSER_COOKIE_MISMATCH') {
      refuse(res, 403, 'ADMIN_GRANT_PROOF_INVALID')
      return
    }
    if (
      error.code === 'ADMIN_GRANT_BROWSER_CONTEXT_REQUIRED'
      || error.code === 'ADMIN_GRANT_BROWSER_COOKIE_REQUIRED'
      || error.code === 'ADMIN_GRANT_BROWSER_SESSION_STALE'
    ) {
      refuse(res, 401, 'ADMIN_GRANT_SESSION_REQUIRED')
      return
    }
  }
  if (error instanceof SecurityActionProofContractError) {
    refuse(res, 503, 'ADMIN_GRANT_UNAVAILABLE')
    return
  }
  refuse(res, 503, 'ADMIN_GRANT_UNAVAILABLE')
}

export function createAdminGrantProofRouter(options: AdminGrantProofServiceOptions): Router {
  const service = createAdminGrantProofService(options)
  const browser = createAdminGrantBrowserContext({ publicOrigin: options.publicOrigin })
  const publicOrigin = options.publicOrigin
  const router = Router()

  router.post('/browser', (req, res) => {
    noStore(res)
    const session = readAuthenticatedSessionContext(req)
    if (!session) {
      refuse(res, 401, 'ADMIN_GRANT_SESSION_REQUIRED')
      return
    }
    if (requestOrigin(req) !== publicOrigin) {
      refuse(res, 403, 'ADMIN_GRANT_ORIGIN_REJECTED')
      return
    }
    browser.establish(req, res).then(
      () => {
        if (res.headersSent) return
        res.status(200).json({ ok: true })
      },
      (error: unknown) => {
        sendFailure(res, error)
      },
    )
  })

  router.post('/issue', (req, res) => {
    noStore(res)
    const session = readAuthenticatedSessionContext(req)
    if (!session) {
      refuse(res, 401, 'ADMIN_GRANT_SESSION_REQUIRED')
      return
    }
    if (requestOrigin(req) !== publicOrigin) {
      refuse(res, 403, 'ADMIN_GRANT_ORIGIN_REJECTED')
      return
    }
    browser.read(req).then(
      (browserContext) => {
        retainAdminGrantBrowserContext(publicOrigin, browserContext.session, browserContext)
        return service.issue(browserContext.session, req.body)
      },
    ).then(
      (issued) => {
        if (res.headersSent) return
        res.status(200).json({ ok: true, data: issued })
      },
      (error: unknown) => {
        sendFailure(res, error)
      },
    )
  })

  return router
}
