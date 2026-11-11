/**
 * `/api/me/notification-endpoints`: the caller's own notification endpoints.
 *
 * Handling order: authentication, then the switch (off: 404 and no query), then the organization, then
 * the closed request-body whitelist, then the service. The middleware chain is exactly `authenticate`:
 * the routes only read and write the caller's own rows and widen no authorization.
 */
import type { Request, Response, Router as ExpressRouter } from 'express'
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { isUserNotificationPreferencesEnabled } from '../notifications/notification-flags'
import { createEndpointsService, type EndpointsService } from '../notifications/endpoints-service'
import { PROOF_KINDS, type ProofKind } from '../notifications/provider-notification-registry'
import {
  invalidRequest,
  jsonBodyOf,
  plainObjectKeys,
  respondError,
  respondNotFound,
  respondUnauthorized,
  tenantOf,
  userOf,
  UUID_SHAPE,
} from './me-notification-http'
import { productionAuditSink, productionNotificationDbDeps, productionRecipientResolver } from './me-notification-wiring'

export const ME_NOTIFICATION_ENDPOINTS_PATH = '/api/me/notification-endpoints'

export interface MeNotificationEndpointsRouterDeps {
  isEnabled(): boolean
  readonly service: EndpointsService
}

const POST_KEYS = ['connectionId', 'proofKind'] as const

export function parseEndpointBody(body: unknown): { connectionId: string; proofKind: ProofKind } {
  const keys = plainObjectKeys(body)
  if (keys === null) throw invalidRequest(['body'])
  const record = body as Record<string, unknown>
  const bad = keys.filter((key) => !(POST_KEYS as readonly string[]).includes(key))
  if (typeof record.connectionId !== 'string' || !UUID_SHAPE.test(record.connectionId)) bad.push('connectionId')
  if (typeof record.proofKind !== 'string' || !(PROOF_KINDS as readonly string[]).includes(record.proofKind)) bad.push('proofKind')
  if (bad.length > 0) throw invalidRequest(bad)
  return { connectionId: record.connectionId as string, proofKind: record.proofKind as ProofKind }
}

export function createMeNotificationEndpointsRouter(deps: MeNotificationEndpointsRouterDeps): ExpressRouter {
  const router = Router()

  /** Authentication has run; answers 404 or 401 itself and returns null when the request must stop. */
  function caller(req: Request, res: Response, write: boolean): { orgId: string; userId: string } | null {
    if (!deps.isEnabled()) {
      respondNotFound(res)
      return null
    }
    const userId = userOf(req)
    if (userId === '') {
      respondUnauthorized(res)
      return null
    }
    const orgId = tenantOf(req)
    if (orgId === '') {
      if (write) res.status(422).json({ error: { code: 'ORG_MISSING' } })
      else respondNotFound(res)
      return null
    }
    return { orgId, userId }
  }

  router.get(ME_NOTIFICATION_ENDPOINTS_PATH, authenticate, async (req: Request, res: Response) => {
    const who = caller(req, res, false)
    if (!who) return
    try {
      res.status(200).json(await deps.service.list(who))
    } catch (error) {
      respondError(res, error)
    }
  })

  router.post(ME_NOTIFICATION_ENDPOINTS_PATH, authenticate, async (req: Request, res: Response) => {
    const who = caller(req, res, true)
    if (!who) return
    try {
      const input = parseEndpointBody(jsonBodyOf(req))
      const result = await deps.service.establish({ ...who, ...input })
      res.status(result.created ? 201 : 200).json({ endpoint: result.endpoint })
    } catch (error) {
      respondError(res, error)
    }
  })

  router.delete('/api/me/notification-endpoints/:id', authenticate, async (req: Request, res: Response) => {
    const who = caller(req, res, true)
    if (!who) return
    try {
      const endpointId = String(req.params.id ?? '')
      if (!UUID_SHAPE.test(endpointId)) {
        respondNotFound(res)
        return
      }
      res.status(200).json({ endpoint: await deps.service.revoke({ ...who, endpointId }) })
    } catch (error) {
      respondError(res, error)
    }
  })

  return router
}

/** Production router: bound to the production dependencies, accepts no arguments. */
export function meNotificationEndpointsRouter(): ExpressRouter {
  const service = createEndpointsService({
    ...productionNotificationDbDeps(),
    resolver: productionRecipientResolver(),
    audit: productionAuditSink,
  })
  return createMeNotificationEndpointsRouter({ isEnabled: () => isUserNotificationPreferencesEnabled(), service })
}
