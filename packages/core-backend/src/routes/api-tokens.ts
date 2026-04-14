/**
 * API Token & Webhook REST Routes
 * Provides CRUD endpoints for managing API tokens and webhooks.
 */

import type { Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { Logger } from '../core/logger'
import { authenticate } from '../middleware/auth'
import { apiTokenService } from '../multitable/api-token-service'
import { webhookService } from '../multitable/webhook-service'
import { ALL_API_TOKEN_SCOPES } from '../multitable/api-tokens'
import { ALL_WEBHOOK_EVENT_TYPES } from '../multitable/webhooks'

const logger = new Logger('ApiTokenRoutes')

// ─── Zod schemas ───────────────────────────────────────────────────────

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ALL_API_TOKEN_SCOPES as [string, ...string[]])).min(1),
  expiresAt: z.string().datetime().optional(),
})

const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z
    .array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]]))
    .min(1),
})

const UpdateWebhookSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  secret: z.string().optional(),
  events: z
    .array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]]))
    .min(1)
    .optional(),
  active: z.boolean().optional(),
})

// ─── Helpers ───────────────────────────────────────────────────────────

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

// ─── Router factory ────────────────────────────────────────────────────

export function apiTokensRouter(): Router {
  const router = Router()

  // All routes require authentication
  router.use(
    ['/api/multitable/api-tokens', '/api/multitable/webhooks'],
    authenticate,
  )

  // ── Token routes ──────────────────────────────────────────────────

  // GET /api/multitable/api-tokens — list user's tokens
  router.get('/api/multitable/api-tokens', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const tokens = apiTokenService.listTokens(userId)
    res.json({ ok: true, data: tokens })
  })

  // POST /api/multitable/api-tokens — create token
  router.post('/api/multitable/api-tokens', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = CreateTokenSchema.parse(req.body)
      const result = apiTokenService.createToken(userId, {
        name: input.name,
        scopes: input.scopes as import('../multitable/api-tokens').ApiTokenScope[],
        expiresAt: input.expiresAt,
      })
      res.status(201).json({ ok: true, data: result })
    } catch (err) {
      if (err instanceof z.ZodError) {
        zodError(res, err)
        return
      }
      logger.error('Failed to create token', err instanceof Error ? err : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'CREATE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
      })
    }
  })

  // DELETE /api/multitable/api-tokens/:id — revoke token
  router.delete('/api/multitable/api-tokens/:id', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      apiTokenService.revokeToken(req.params.id, userId)
      res.json({ ok: true })
    } catch (err) {
      logger.error('Failed to revoke token', err instanceof Error ? err : undefined)
      const status = (err instanceof Error && err.message === 'Token not found') ? 404 : 500
      res.status(status).json({
        ok: false,
        error: { code: 'REVOKE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
      })
    }
  })

  // POST /api/multitable/api-tokens/:id/rotate — rotate token
  router.post('/api/multitable/api-tokens/:id/rotate', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const result = apiTokenService.rotateToken(req.params.id, userId)
      res.json({ ok: true, data: result })
    } catch (err) {
      logger.error('Failed to rotate token', err instanceof Error ? err : undefined)
      const status = (err instanceof Error && err.message === 'Token not found') ? 404 : 500
      res.status(status).json({
        ok: false,
        error: { code: 'ROTATE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
      })
    }
  })

  // ── Webhook routes ────────────────────────────────────────────────

  // GET /api/multitable/webhooks — list webhooks
  router.get('/api/multitable/webhooks', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const webhooks = webhookService.listWebhooks(userId)
    res.json({ ok: true, data: webhooks })
  })

  // POST /api/multitable/webhooks — create webhook
  router.post('/api/multitable/webhooks', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = CreateWebhookSchema.parse(req.body)
      const webhook = webhookService.createWebhook(userId, {
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
      res.status(400).json({
        ok: false,
        error: { code: 'CREATE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
      })
    }
  })

  // PATCH /api/multitable/webhooks/:id — update webhook
  router.patch('/api/multitable/webhooks/:id', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      const input = UpdateWebhookSchema.parse(req.body)
      const webhook = webhookService.updateWebhook(req.params.id, userId, {
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
      const status = (err instanceof Error && err.message === 'Webhook not found') ? 404 : 500
      res.status(status).json({
        ok: false,
        error: { code: 'UPDATE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
      })
    }
  })

  // DELETE /api/multitable/webhooks/:id — delete webhook
  router.delete('/api/multitable/webhooks/:id', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    try {
      webhookService.deleteWebhook(req.params.id, userId)
      res.json({ ok: true })
    } catch (err) {
      logger.error('Failed to delete webhook', err instanceof Error ? err : undefined)
      const status = (err instanceof Error && err.message === 'Webhook not found') ? 404 : 500
      res.status(status).json({
        ok: false,
        error: { code: 'DELETE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
      })
    }
  })

  // GET /api/multitable/webhooks/:id/deliveries — list recent deliveries
  router.get('/api/multitable/webhooks/:id/deliveries', (req: Request, res: Response) => {
    const userId = getUserId(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      return
    }
    const wh = webhookService.getWebhookById(req.params.id)
    if (!wh) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } })
      return
    }
    if (wh.createdBy !== userId) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } })
      return
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const deliveries = webhookService.listDeliveries(req.params.id, limit)
    res.json({ ok: true, data: deliveries })
  })

  return router
}
