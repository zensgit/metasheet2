/**
 * API Token, Webhook, and DingTalk group destination REST routes.
 */

import type { Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../db/db'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { authenticate } from '../middleware/auth'
import { ApiTokenService } from '../multitable/api-token-service'
import { ALL_API_TOKEN_SCOPES } from '../multitable/api-tokens'
import { DingTalkGroupDestinationService } from '../multitable/dingtalk-group-destination-service'
import { toDingTalkGroupDestinationResponse } from '../multitable/dingtalk-group-destination-response'
import { resolveSheetCapabilitiesForUser } from '../multitable/sheet-capabilities'
import { WebhookService } from '../multitable/webhook-service'
import { ALL_WEBHOOK_EVENT_TYPES } from '../multitable/webhooks'

const logger = new Logger('ApiTokenRoutes')

const apiTokenService = new ApiTokenService(db)
const webhookService = new WebhookService(db)
const dingTalkGroupDestinationService = new DingTalkGroupDestinationService(db)

const tokenListPaths = ['/api/multitable/api-tokens', '/api/multitable/tokens']
const tokenItemPaths = ['/api/multitable/api-tokens/:id', '/api/multitable/tokens/:id']
const tokenRotatePaths = ['/api/multitable/api-tokens/:id/rotate', '/api/multitable/tokens/:id/rotate']
const webhookPaths = ['/api/multitable/webhooks', '/api/multitable/webhooks/:id', '/api/multitable/webhooks/:id/deliveries']
const dingTalkGroupPaths = [
  '/api/multitable/dingtalk-groups',
  '/api/multitable/dingtalk-groups/:id',
  '/api/multitable/dingtalk-groups/:id/deliveries',
  '/api/multitable/dingtalk-groups/:id/test-send',
]

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ALL_API_TOKEN_SCOPES as [string, ...string[]])).min(1),
  expiresAt: z.string().datetime().optional(),
})

const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]])).min(1),
})

const UpdateWebhookSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  secret: z.string().optional(),
  events: z.array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]])).min(1).optional(),
  active: z.boolean().optional(),
})

const CreateDingTalkGroupSchema = z.object({
  name: z.string().min(1).max(100),
  webhookUrl: z.string().url(),
  secret: z.string().optional(),
  enabled: z.boolean().optional(),
  scope: z.enum(['private', 'sheet', 'org']).optional(),
  sheetId: z.string().optional(),
  orgId: z.string().optional(),
})

const UpdateDingTalkGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  webhookUrl: z.string().url().optional(),
  secret: z.string().optional(),
  enabled: z.boolean().optional(),
})

const DingTalkGroupTestSendSchema = z.object({
  subject: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(4000).optional(),
})

function getSheetId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getOrgId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isAdminRequest(req: Request): boolean {
  const user = req.user as Record<string, unknown> | undefined
  const role = typeof user?.role === 'string' ? user.role.trim() : ''
  const roles = Array.isArray(user?.roles) ? user.roles.map((value) => String(value).trim()) : []
  const permissions = [
    ...(Array.isArray(user?.permissions) ? user.permissions : []),
    ...(Array.isArray(user?.perms) ? user.perms : []),
  ].map((value) => String(value).trim())
  return Boolean(user?.isAdmin || user?.is_admin)
    || role === 'admin'
    || roles.includes('admin')
    || permissions.includes('*')
    || permissions.includes('admin')
    || permissions.includes('dingtalk:admin')
}

function rejectMixedScope(res: Response, sheetId: string, orgId: string): boolean {
  if (!sheetId || !orgId) return false
  res.status(400).json({
    ok: false,
    error: { code: 'VALIDATION_ERROR', message: 'sheetId and orgId cannot be used together' },
  })
  return true
}

function rejectInvalidDingTalkGroupScope(
  res: Response,
  scope: 'private' | 'sheet' | 'org' | undefined,
  sheetId: string,
  orgId: string,
): boolean {
  if (scope === 'private' && (sheetId || orgId)) {
    res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'private DingTalk group destinations cannot include sheetId or orgId' },
    })
    return true
  }
  if (scope === 'sheet' && !sheetId) {
    res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'sheetId is required for sheet-scoped DingTalk group destinations' },
    })
    return true
  }
  if (scope === 'org' && !orgId) {
    res.status(400).json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'orgId is required for organization DingTalk group destinations' },
    })
    return true
  }
  return false
}

async function requireSheetAutomationAccess(res: Response, userId: string, sheetId: string): Promise<boolean> {
  if (!sheetId) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    return false
  }
  const { capabilities } = await resolveSheetCapabilitiesForUser(query, sheetId, userId)
  if (!capabilities.canManageAutomation) {
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } })
    return false
  }
  return true
}

async function requireOrgMemberAccess(res: Response, userId: string, orgId: string): Promise<boolean> {
  if (!orgId) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'orgId is required' } })
    return false
  }
  const result = await query(
    'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true LIMIT 1',
    [userId, orgId],
  )
  if (!result.rows.length) {
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } })
    return false
  }
  return true
}

async function requireOrgReadAccess(req: Request, res: Response, userId: string, orgId: string): Promise<boolean> {
  if (isAdminRequest(req)) return true
  return requireOrgMemberAccess(res, userId, orgId)
}

function requireOrgAdminAccess(req: Request, res: Response): boolean {
  if (isAdminRequest(req)) return true
  res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin role required' } })
  return false
}

function getUserId(req: Request): string {
  const user = req.user as Record<string, unknown> | undefined
  const id = user?.id ?? user?.userId ?? user?.sub
  return typeof id === 'string' ? id.trim() : ''
}

function zodError(res: Response, err: z.ZodError): void {
  res.status(400).json({
    ok: false,
    error: { code: 'VALIDATION_ERROR', details: err.errors },
  })
}

function serviceErrorResponse(res: Response, err: unknown, action: string): void {
  const message = err instanceof Error ? err.message : 'Unknown error'
  let status = 500
  let code = `${action.toUpperCase()}_FAILED`

  if (message === 'Destination not found' || message === 'Token not found' || message === 'Webhook not found') {
    status = 404
  } else if (message === 'Not authorized') {
    status = 403
    code = 'FORBIDDEN'
  } else if (
    message.includes('required')
    || message.includes('valid URL')
    || message.includes('HTTPS')
    || message.includes('DingTalk robot')
    || message.includes('DingTalk group webhook')
    || message.includes('At least one scope')
  ) {
    status = 400
  }

  res.status(status).json({
    ok: false,
    error: { code, message },
  })
}

export function apiTokensRouter(): Router {
  const router = Router()

  router.use(
    [...tokenListPaths, ...tokenItemPaths, ...tokenRotatePaths, ...webhookPaths, ...dingTalkGroupPaths],
    authenticate,
  )

  router.get(tokenListPaths, async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const tokens = await apiTokenService.listTokens(userId)
    res.json({ ok: true, data: { tokens } })
  })

  router.post(tokenListPaths, async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = CreateTokenSchema.parse(req.body)
      const result = await apiTokenService.createToken(userId, {
        name: input.name,
        scopes: input.scopes as import('../multitable/api-tokens').ApiTokenScope[],
        expiresAt: input.expiresAt,
      })
      res.status(201).json({
        ok: true,
        data: {
          token: result.token,
          plaintext: result.plainTextToken,
        },
      })
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to create token', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'create')
    }
  })

  router.delete(tokenItemPaths, async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      await apiTokenService.revokeToken(req.params.id, userId)
      res.status(204).end()
    } catch (err) {
      logger.error('Failed to revoke token', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'revoke')
    }
  })

  router.post(tokenRotatePaths, async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const result = await apiTokenService.rotateToken(req.params.id, userId)
      res.json({
        ok: true,
        data: {
          token: result.token,
          plaintext: result.plainTextToken,
        },
      })
    } catch (err) {
      logger.error('Failed to rotate token', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'rotate')
    }
  })

  router.get('/api/multitable/webhooks', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const webhooks = await webhookService.listWebhooks(userId)
    res.json({ ok: true, data: { webhooks } })
  })

  router.post('/api/multitable/webhooks', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = CreateWebhookSchema.parse(req.body)
      const webhook = await webhookService.createWebhook(userId, {
        name: input.name,
        url: input.url,
        secret: input.secret,
        events: input.events as import('../multitable/webhooks').WebhookEventType[],
      })
      res.status(201).json({ ok: true, data: webhook })
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to create webhook', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'create')
    }
  })

  router.patch('/api/multitable/webhooks/:id', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = UpdateWebhookSchema.parse(req.body)
      const webhook = await webhookService.updateWebhook(req.params.id, userId, {
        name: input.name,
        url: input.url,
        secret: input.secret,
        events: input.events as import('../multitable/webhooks').WebhookEventType[] | undefined,
        active: input.active,
      })
      res.json({ ok: true, data: webhook })
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to update webhook', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'update')
    }
  })

  router.delete('/api/multitable/webhooks/:id', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      await webhookService.deleteWebhook(req.params.id, userId)
      res.status(204).end()
    } catch (err) {
      logger.error('Failed to delete webhook', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'delete')
    }
  })

  router.get('/api/multitable/webhooks/:id/deliveries', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const webhook = await webhookService.getWebhookById(req.params.id)
    if (!webhook) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } })
      return
    }
    if (webhook.createdBy !== userId) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } })
      return
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const deliveries = await webhookService.listDeliveries(req.params.id, limit)
    res.json({ ok: true, data: { deliveries } })
  })

  router.get('/api/multitable/dingtalk-groups', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const sheetId = getSheetId(req.query.sheetId)
    const orgId = getOrgId(req.query.orgId)
    if (rejectMixedScope(res, sheetId, orgId)) return
    if (sheetId && !await requireSheetAutomationAccess(res, userId, sheetId)) return
    if (orgId && !await requireOrgReadAccess(req, res, userId, orgId)) return
    const destinations = await dingTalkGroupDestinationService.listDestinations(userId, sheetId || undefined, orgId || undefined)
    const filtered = orgId ? destinations.filter((destination) => destination.orgId === orgId || destination.scope === 'private') : destinations
    res.json({ ok: true, data: { destinations: filtered.map(toDingTalkGroupDestinationResponse) } })
  })

  router.post('/api/multitable/dingtalk-groups', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = CreateDingTalkGroupSchema.parse(req.body)
      const sheetId = getSheetId(input.sheetId)
      const orgId = getOrgId(input.orgId)
      if (rejectMixedScope(res, sheetId, orgId)) return
      if (rejectInvalidDingTalkGroupScope(res, input.scope, sheetId, orgId)) return
      if ((orgId || input.scope === 'org') && !requireOrgAdminAccess(req, res)) return
      if (sheetId && !await requireSheetAutomationAccess(res, userId, sheetId)) return
      const destination = await dingTalkGroupDestinationService.createDestination(userId, {
        name: input.name,
        webhookUrl: input.webhookUrl,
        secret: input.secret,
        enabled: input.enabled,
        scope: input.scope,
        sheetId: sheetId || undefined,
        orgId: orgId || undefined,
      })
      res.status(201).json({ ok: true, data: toDingTalkGroupDestinationResponse(destination) })
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to create DingTalk group destination', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'create')
    }
  })

  router.patch('/api/multitable/dingtalk-groups/:id', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = UpdateDingTalkGroupSchema.parse(req.body)
      const sheetId = getSheetId(req.query.sheetId)
      const orgId = getOrgId(req.query.orgId)
      if (rejectMixedScope(res, sheetId, orgId)) return
      if (orgId && !requireOrgAdminAccess(req, res)) return
      if (sheetId && !await requireSheetAutomationAccess(res, userId, sheetId)) return
      const destination = await dingTalkGroupDestinationService.updateDestination(req.params.id, userId, {
        name: input.name,
        webhookUrl: input.webhookUrl,
        secret: input.secret,
        enabled: input.enabled,
      }, sheetId || undefined, orgId || undefined)
      res.json({ ok: true, data: toDingTalkGroupDestinationResponse(destination) })
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to update DingTalk group destination', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'update')
    }
  })

  router.delete('/api/multitable/dingtalk-groups/:id', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const sheetId = getSheetId(req.query.sheetId)
      const orgId = getOrgId(req.query.orgId)
      if (rejectMixedScope(res, sheetId, orgId)) return
      if (orgId && !requireOrgAdminAccess(req, res)) return
      if (sheetId && !await requireSheetAutomationAccess(res, userId, sheetId)) return
      await dingTalkGroupDestinationService.deleteDestination(req.params.id, userId, sheetId || undefined, orgId || undefined)
      res.status(204).end()
    } catch (err) {
      logger.error('Failed to delete DingTalk group destination', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'delete')
    }
  })

  router.get('/api/multitable/dingtalk-groups/:id/deliveries', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const sheetId = getSheetId(req.query.sheetId)
    const orgId = getOrgId(req.query.orgId)
    if (rejectMixedScope(res, sheetId, orgId)) return
    if (sheetId && !await requireSheetAutomationAccess(res, userId, sheetId)) return
    if (orgId && !await requireOrgReadAccess(req, res, userId, orgId)) return
    const destination = await dingTalkGroupDestinationService.getDestinationById(req.params.id)
    if (!destination) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } })
      return
    }
    if (destination.orgId) {
      if (!await requireOrgReadAccess(req, res, userId, destination.orgId)) return
    } else if (destination.sheetId ? destination.sheetId !== sheetId : destination.createdBy !== userId) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } })
      return
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const deliveries = await dingTalkGroupDestinationService.listDeliveries(req.params.id, limit)
    res.json({ ok: true, data: { deliveries } })
  })

  router.post('/api/multitable/dingtalk-groups/:id/test-send', async (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = DingTalkGroupTestSendSchema.parse(req.body ?? {})
      const sheetId = getSheetId(req.query.sheetId)
      const orgId = getOrgId(req.query.orgId)
      if (rejectMixedScope(res, sheetId, orgId)) return
      if (orgId && !requireOrgAdminAccess(req, res)) return
      if (sheetId && !await requireSheetAutomationAccess(res, userId, sheetId)) return
      await dingTalkGroupDestinationService.testSend(req.params.id, userId, input, sheetId || undefined, orgId || undefined)
      res.status(204).end()
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to test DingTalk group destination', err instanceof Error ? err : undefined)
      serviceErrorResponse(res, err, 'test_send')
    }
  })

  return router
}
