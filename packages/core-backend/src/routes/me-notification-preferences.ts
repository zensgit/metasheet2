/**
 * `/api/me/notification-preferences`: the caller's own preference per topic.
 *
 * Handling order and middleware chain as in me-notification-endpoints.ts. A write names the revision
 * it expects; a change is applied only if the stored revision still equals it.
 */
import type { Request, Response, Router as ExpressRouter } from 'express'
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { isUserNotificationPreferencesEnabled } from '../notifications/notification-flags'
import { createPreferencesService, type PreferencePatch, type PreferencesService } from '../notifications/preferences-service'
import { quietHoursProblem } from '../notifications/quiet-hours'
import { isNotificationTopic } from '../notifications/topic-registry'
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

export const ME_NOTIFICATION_PREFERENCES_PATH = '/api/me/notification-preferences'

export interface MeNotificationPreferencesRouterDeps {
  isEnabled(): boolean
  readonly service: PreferencesService
}

const PATCH_KEYS = ['topic', 'expectedRevision', 'enabled', 'primaryEndpointId', 'fallbackEndpointId', 'quietHours'] as const
const QUIET_KEYS = ['start', 'end', 'timeZone'] as const

const isEndpointIdOrNull = (value: unknown): boolean => value === null || (typeof value === 'string' && UUID_SHAPE.test(value))

export function parsePreferencePatch(body: unknown): PreferencePatch {
  const keys = plainObjectKeys(body)
  if (keys === null) throw invalidRequest(['body'])
  const record = body as Record<string, unknown>
  const bad = keys.filter((key) => !(PATCH_KEYS as readonly string[]).includes(key))
  if (!isNotificationTopic(record.topic)) bad.push('topic')
  const expected = record.expectedRevision
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) bad.push('expectedRevision')
  if ('enabled' in record && typeof record.enabled !== 'boolean') bad.push('enabled')
  for (const key of ['primaryEndpointId', 'fallbackEndpointId'] as const) {
    if (key in record && !isEndpointIdOrNull(record[key])) bad.push(key)
  }
  let quietHours: PreferencePatch['quietHours']
  if ('quietHours' in record) {
    const quiet = record.quietHours
    if (quiet === null) {
      quietHours = null
    } else {
      const quietKeys = plainObjectKeys(quiet)
      if (quietKeys === null) {
        bad.push('quietHours')
      } else {
        const value = quiet as Record<string, unknown>
        for (const key of quietKeys) if (!(QUIET_KEYS as readonly string[]).includes(key)) bad.push(`quietHours.${key}`)
        const problem = quietHoursProblem({ start: value.start, end: value.end, timeZone: value.timeZone })
        if (problem !== null) bad.push(problem === 'window' ? 'quietHours' : `quietHours.${problem}`)
        else quietHours = { start: value.start as string, end: value.end as string, timeZone: value.timeZone as string }
      }
    }
  }
  if (bad.length > 0) throw invalidRequest(bad)
  const patch: PreferencePatch = { topic: record.topic as string, expectedRevision: expected as number }
  if ('enabled' in record) patch.enabled = record.enabled as boolean
  if ('primaryEndpointId' in record) patch.primaryEndpointId = record.primaryEndpointId as string | null
  if ('fallbackEndpointId' in record) patch.fallbackEndpointId = record.fallbackEndpointId as string | null
  if ('quietHours' in record) patch.quietHours = quietHours
  return patch
}

export function createMeNotificationPreferencesRouter(deps: MeNotificationPreferencesRouterDeps): ExpressRouter {
  const router = Router()

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

  router.get(ME_NOTIFICATION_PREFERENCES_PATH, authenticate, async (req: Request, res: Response) => {
    const who = caller(req, res, false)
    if (!who) return
    try {
      res.status(200).json(await deps.service.list(who))
    } catch (error) {
      respondError(res, error)
    }
  })

  router.patch(ME_NOTIFICATION_PREFERENCES_PATH, authenticate, async (req: Request, res: Response) => {
    const who = caller(req, res, true)
    if (!who) return
    try {
      const patch = parsePreferencePatch(jsonBodyOf(req))
      res.status(200).json(await deps.service.patch({ ...who, patch }))
    } catch (error) {
      respondError(res, error)
    }
  })

  return router
}

/** Production router: bound to the production dependencies, accepts no arguments. */
export function meNotificationPreferencesRouter(): ExpressRouter {
  const service = createPreferencesService({
    ...productionNotificationDbDeps(),
    resolver: productionRecipientResolver(),
    audit: productionAuditSink,
  })
  return createMeNotificationPreferencesRouter({ isEnabled: () => isUserNotificationPreferencesEnabled(), service })
}
