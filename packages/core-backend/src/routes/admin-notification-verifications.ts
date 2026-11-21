import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { DingTalkConfigValidationError } from '../integrations/dingtalk/config-validation-error'
import {
  isExternalNotificationDeliveryEnabled,
  isUserNotificationPreferencesEnabled,
} from '../notifications/notification-flags'
import {
  createNotificationVerificationService,
  notificationVerificationAuditMeta,
  NotificationVerificationEvidenceError,
  type NotificationVerificationService,
} from '../notifications/verification-service'
import { mapBusy } from '../notifications/notification-tx'
import { isNotificationHttpError } from '../notifications/notification-errors'
import { ensurePlatformAdmin } from './admin-directory'
import { jsonBodyOf, plainObjectKeys, UUID_SHAPE } from './me-notification-http'
import { productionNotificationDbDeps } from './me-notification-wiring'

export interface AdminNotificationVerificationsRouterDeps {
  service: NotificationVerificationService
  isEnabled(): boolean
  isDeliveryEnabled(): boolean
}

const BODY_KEYS = ['integrationId', 'level', 'recipientUserId'] as const

export function createAdminNotificationVerificationsRouter(deps: AdminNotificationVerificationsRouterDeps): Router {
  const router = Router()
  router.post('/notification-verification', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (!deps.isEnabled()) {
      res.status(404).json({ error: { code: 'NOT_FOUND' } })
      return
    }
    const jsonBody = jsonBodyOf(req)
    const keys = plainObjectKeys(jsonBody)
    const body = jsonBody as Record<string, unknown> | null
    if (keys === null || keys.some((key) => !(BODY_KEYS as readonly string[]).includes(key))) {
      res.status(422).json({ error: { code: 'INVALID_REQUEST' } })
      return
    }
    if (typeof body?.integrationId !== 'string' || !UUID_SHAPE.test(body.integrationId)) {
      res.status(400).json({ error: { code: 'DIRECTORY_INTEGRATION_ID_INVALID' } })
      return
    }
    if (body.level !== 'token' && body.level !== 'send') {
      res.status(400).json({ error: { code: 'INVALID_REQUEST' } })
      return
    }
    if (body.level === 'send' && !deps.isDeliveryEnabled()) {
      res.status(409).json({ error: { code: 'NOTIFICATION_DELIVERY_DISABLED' } })
      return
    }
    try {
      const response = await deps.service.verify({
        integrationId: body.integrationId, level: body.level,
        recipientUserId: body.recipientUserId, verifiedBy: adminUserId,
      })
      await auditLog({
        actorId: adminUserId, actorType: 'user', action: 'notification.verification.record',
        resourceType: 'notification-connection-verification', resourceId: body.integrationId,
        meta: notificationVerificationAuditMeta(response.result),
      })
      res.status(200).json(response)
    } catch (error) {
      // Never print provider errors: their message/cause can contain credentials or request URLs.
      if (error instanceof NotificationVerificationEvidenceError) {
        // auditLog reports its own storage failure without throwing; this is one attempt, never a retry.
        await auditLog({
          actorId: adminUserId, actorType: 'user', action: 'notification.verification.record',
          resourceType: 'notification-connection-verification', resourceId: body.integrationId,
          meta: error.auditMeta,
        })
      }
      const mapped = mapBusy(error)
      if (isNotificationHttpError(mapped) && mapped.status === 404 && mapped.code === 'NOT_FOUND') {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
      } else if (isNotificationHttpError(mapped) && mapped.status === 503 && mapped.code === 'NOTIFICATION_BUSY') {
        res.status(503).json({ error: { code: 'NOTIFICATION_BUSY' } })
      } else if (isNotificationHttpError(mapped) && mapped.status === 503 && mapped.code === 'NOTIFICATION_SCHEMA_UNAVAILABLE') {
        res.status(503).json({ error: { code: 'NOTIFICATION_SCHEMA_UNAVAILABLE' } })
      } else if (isNotificationHttpError(mapped) && mapped.status === 409 && mapped.code === 'VERIFICATION_TUPLE_UNSUPPORTED') {
        res.status(409).json({ error: { code: 'VERIFICATION_TUPLE_UNSUPPORTED' } })
      } else if (error instanceof NotificationVerificationEvidenceError) {
        res.status(500).json({ error: { code: 'VERIFICATION_EVIDENCE_WRITE_FAILED' } })
      } else if (error instanceof DingTalkConfigValidationError) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST' } })
      } else {
        res.status(500).json({ error: { code: 'INTERNAL' } })
      }
    }
  })
  return router
}

export function adminNotificationVerificationsRouter(): Router {
  return createAdminNotificationVerificationsRouter({
    service: createNotificationVerificationService(productionNotificationDbDeps()),
    isEnabled: () => isUserNotificationPreferencesEnabled(),
    isDeliveryEnabled: () => isExternalNotificationDeliveryEnabled(),
  })
}
