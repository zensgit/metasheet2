import { Router, type Request, type Response } from 'express'
import { findActiveOrgMembers } from '../services/task-org-members'
import { pool } from '../db/pg'
import { Logger } from '../core/logger'
import { mapBusy } from '../notifications/notification-tx'
import { NotificationHttpError } from '../notifications/notification-errors'
import { isUserNotificationPreferencesEnabled, isExternalNotificationDeliveryEnabled } from '../notifications/notification-flags'
import { createTopicPolicyService, type TopicPolicyPatch, type TopicPolicyService } from '../notifications/topic-policy-service'
import { ensurePlatformAdmin } from './admin-directory'
import { jsonBodyOf, plainObjectKeys, respondError, UUID_SHAPE } from './me-notification-http'
import { productionAuditSink, productionNotificationDbDeps, productionNotificationVerificationSummary, productionRecipientResolver } from './me-notification-wiring'

const logger = new Logger('NotificationTopicPolicyRoutes')
function policyError(req: Request, res: Response, error: unknown): void {
  const mapped = mapBusy(error)
  if (mapped instanceof NotificationHttpError) {
    logger.warn('notification_topic_policy_rejected', { code: mapped.code, topic: req.params.topic === 'task_reminder' ? 'task_reminder' : 'unknown' })
  }
  respondError(res, error)
}
const actorOf = (req: Request, actorId: string) => ({ actorId, authenticatedTenantId: req.authenticatedTenantId })
const invalid = () => { throw new NotificationHttpError(422, 'INVALID_REQUEST') }
const KEYS = ['expectedRevision', 'state', 'defaultConnectionId', 'confirmNoDefaultConnection']

export function createAdminDirectoryNotificationRouter(deps: { service: TopicPolicyService; isEnabled(): boolean }): Router {
  const router = Router()
  router.get('/notification-topic-policies', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (!(await ensurePlatformAdmin(req, res))) return
      if (!deps.isEnabled()) { res.status(404).json({ error: { code: 'NOT_FOUND' } }); return }
      res.json(await deps.service.list())
    } catch (error) { policyError(req, res, error) }
  })
  router.put('/notification-topic-policies/:topic', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const actorId = await ensurePlatformAdmin(req, res)
      if (!actorId) return
      if (!deps.isEnabled()) { res.status(404).json({ error: { code: 'NOT_FOUND' } }); return }
      const body = jsonBodyOf(req)
      const keys = plainObjectKeys(body)
      const actor = actorOf(req, actorId)
      // A nonnull selection enters the trusted-tenant gate even when its value is malformed.
      if (keys?.includes('defaultConnectionId') && (body as Record<string, unknown>).defaultConnectionId !== null) await deps.service.requireMember(actor)
      if (!keys || keys.some(key => !KEYS.includes(key))) invalid()
      const value = body as Record<string, unknown>
      if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) invalid()
      if (value.state !== 'active' && value.state !== 'paused') invalid()
      if (value.expectedRevision === 0 && (!keys.includes('defaultConnectionId') || value.state !== 'active')) invalid()
      if (keys.includes('defaultConnectionId') && value.defaultConnectionId !== null
        && (typeof value.defaultConnectionId !== 'string' || !UUID_SHAPE.test(value.defaultConnectionId))) invalid()
      if (keys.includes('confirmNoDefaultConnection') && value.confirmNoDefaultConnection !== true) invalid()
      res.json(await deps.service.put(actor, req.params.topic, { ...value, ...(typeof value.defaultConnectionId === 'string' ? { defaultConnectionId: value.defaultConnectionId.toLowerCase() } : {}) } as unknown as TopicPolicyPatch))
    } catch (error) { policyError(req, res, error) }
  })
  router.get('/notification-topic-policies/:topic/takeover-preview', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const actorId = await ensurePlatformAdmin(req, res)
      if (!actorId) return
      if (!deps.isEnabled()) { res.status(404).json({ error: { code: 'NOT_FOUND' } }); return }
      if (Object.keys(req.query).some(key => key !== 'defaultConnectionId')) invalid()
      const connectionId = req.query.defaultConnectionId
      if (connectionId !== undefined && (typeof connectionId !== 'string' || !UUID_SHAPE.test(connectionId))) invalid()
      res.json(await deps.service.preview(actorOf(req, actorId), req.params.topic, typeof connectionId === 'string' ? connectionId.toLowerCase() : null))
    } catch (error) { policyError(req, res, error) }
  })
  return router
}

export function adminDirectoryNotificationRouter(): Router {
  const dbDeps = productionNotificationDbDeps()
  return createAdminDirectoryNotificationRouter({
    isEnabled: () => isUserNotificationPreferencesEnabled(),
    service: createTopicPolicyService({ ...dbDeps,
      transaction: async fn => {
        if (!pool) throw new NotificationHttpError(503, 'NOTIFICATION_BUSY')
        const client = await pool.connect()
        let discard = false
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          const result = await fn(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          try { await client.query('ROLLBACK') } catch { discard = true }
          throw error
        } finally { client.release(discard) }
      },
      isActiveOrgMembers: findActiveOrgMembers,
      resolver: productionRecipientResolver(), audit: productionAuditSink,
      deliveryEnabled: () => isExternalNotificationDeliveryEnabled() && isUserNotificationPreferencesEnabled(),
      verification: productionNotificationVerificationSummary,
    }),
  })
}
