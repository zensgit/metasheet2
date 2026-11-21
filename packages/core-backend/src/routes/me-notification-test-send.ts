import type { Request, Response, Router as ExpressRouter } from 'express'
import { Router } from 'express'
import { metrics } from '../metrics/metrics'
import { authenticate } from '../middleware/auth'
import { NotificationHttpError } from '../notifications/notification-errors'
import { isUserNotificationPreferencesEnabled } from '../notifications/notification-flags'
import type { AuditSink } from '../notifications/notification-tx'
import { createNotificationTestSendService, type NotificationTestSendService } from '../notifications/test-send-service'
import '../services/notification-adapter-bootstrap'
import { TASK_DELIVERY_PREPARE_BUDGET_MS } from '../tasks/task-delivery-protocol'
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
import {
  productionAuditSink,
  productionNotificationConnectionReadiness,
  productionNotificationDbDeps,
  productionNotificationDeliveryEnabled,
  productionRecipientResolver,
} from './me-notification-wiring'

export const ME_NOTIFICATION_TEST_SEND_PATH = '/api/me/notification-endpoints/:id/test'

export interface MeNotificationTestSendRouterDeps {
  isEnabled(): boolean
  isDeliveryEnabled(): boolean
  service: NotificationTestSendService
  audit: AuditSink
}

export function parseNotificationTestSendBody(body: unknown): { idempotencyKey: string } {
  const keys = plainObjectKeys(body)
  if (keys === null) throw invalidRequest(['body'])
  const record = body as Record<string, unknown>
  const bad = keys.filter((key) => key !== 'confirm' && key !== 'idempotencyKey')
  if (bad.length > 0) throw invalidRequest(bad)
  if (record.confirm !== true) throw new NotificationHttpError(422, 'CONFIRM_REQUIRED')
  if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.length < 8 || record.idempotencyKey.length > 64
    || /[^A-Za-z0-9_-]/.test(record.idempotencyKey)) {
    throw invalidRequest(['idempotencyKey'])
  }
  return { idempotencyKey: record.idempotencyKey }
}

export function createMeNotificationTestSendRouter(deps: MeNotificationTestSendRouterDeps): ExpressRouter {
  const router = Router()
  router.post(ME_NOTIFICATION_TEST_SEND_PATH, authenticate, async (req: Request, res: Response) => {
    const userId = userOf(req)
    if (!userId) { respondUnauthorized(res); return }
    if (!deps.isEnabled()) { respondNotFound(res); return }
    const orgId = tenantOf(req)
    if (!orgId) { res.status(422).json({ error: { code: 'ORG_MISSING' } }); return }
    try {
      const input = parseNotificationTestSendBody(jsonBodyOf(req))
      if (!deps.isDeliveryEnabled()) throw new NotificationHttpError(409, 'NOTIFICATION_DELIVERY_DISABLED')
      const endpointId = String(req.params.id ?? '')
      if (!UUID_SHAPE.test(endpointId)) { respondNotFound(res); return }
      const result = await deps.service.send({ orgId, userId, endpointId, ...input })
      // Refused means preparation prevented a transport call; public results retain the three-outcome contract.
      const outcome = result.outcome === 'refused' ? 'failed' : result.outcome
      await deps.audit({
        actorType: 'user', actorId: userId, action: 'notification.test_send',
        resourceType: 'notification_test_send', resourceId: result.testSendId,
        meta: { organizationId: orgId, endpointId, outcome: result.outcome, code: result.code },
      })
      res.status(200).json({ outcome, code: result.code, testSendId: result.testSendId })
    } catch (error) {
      respondError(res, error)
    }
  })
  return router
}

export function meNotificationTestSendRouter(): ExpressRouter {
  const service = createNotificationTestSendService({
    ...productionNotificationDbDeps(),
    resolver: productionRecipientResolver(),
    checkConnection: productionNotificationConnectionReadiness,
    prepareBudgetMs: TASK_DELIVERY_PREPARE_BUDGET_MS,
    isPreferencesEnabled: isUserNotificationPreferencesEnabled,
    isDeliveryEnabled: productionNotificationDeliveryEnabled,
    onOutcome: (outcome) => metrics.notificationTestSendsTotal.inc({ outcome }),
  })
  return createMeNotificationTestSendRouter({
    isEnabled: isUserNotificationPreferencesEnabled,
    isDeliveryEnabled: productionNotificationDeliveryEnabled,
    service,
    audit: productionAuditSink,
  })
}
