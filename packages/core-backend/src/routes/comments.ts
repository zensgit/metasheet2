import type { Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { Injector } from '@wendellhu/redi'
import { ICommentService, type CommentQueryOptions } from '../di/identifiers'
import { Logger } from '../core/logger'
import { rbacGuard } from '../rbac/rbac'

const logger = new Logger('CommentsRoutes')
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string') return value
  return undefined
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function parseNumberParam(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampLimit(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)))
}

function clampOffset(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function getUserId(req: Request): string {
  const user = (req as { user?: { id?: unknown; sub?: unknown; userId?: unknown } }).user
  const headerUserId = req.headers['x-user-id']
  const header = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId
  const raw = user?.id ?? user?.sub ?? user?.userId ?? header
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return 'anonymous'
}

export function commentsRouter(injector?: Injector): Router {
  const router = Router()
  const commentService = injector?.get(ICommentService)

  if (!commentService) {
    router.use('/api/comments', (_req, res) => {
      return res.status(500).json({
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'CommentService unavailable' },
      })
    })
    return router
  }

  router.get('/api/comments', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const params = {
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      containerType: readQueryValue(req.query.containerType),
      containerId: readQueryValue(req.query.containerId),
      rowId: readQueryValue(req.query.rowId),
      fieldId: readQueryValue(req.query.fieldId),
      targetType: readQueryValue(req.query.targetType),
      targetId: readQueryValue(req.query.targetId),
      targetFieldId: readQueryValue(req.query.targetFieldId),
      resolved: parseBoolean(readQueryValue(req.query.resolved)),
      limit: parseNumberParam(readQueryValue(req.query.limit)),
      offset: parseNumberParam(readQueryValue(req.query.offset)),
    }

    const hasLegacy = typeof params.spreadsheetId === 'string' && params.spreadsheetId.trim().length > 0
    const hasContainer = typeof params.containerId === 'string' && params.containerId.trim().length > 0
    if (!hasLegacy && !hasContainer) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId or containerId is required' },
      })
    }

    try {
      const limit = clampLimit(params.limit)
      const offset = clampOffset(params.offset)
      const options: CommentQueryOptions = {
        rowId: params.rowId,
        fieldId: params.fieldId,
        targetType: params.targetType,
        targetId: params.targetId,
        targetFieldId: params.targetFieldId,
        containerType: params.containerType,
        resolved: params.resolved,
        limit,
        offset,
      }
      const result = await commentService.getComments({
        spreadsheetId: params.spreadsheetId,
        containerType: params.containerType,
        containerId: params.containerId,
      }, options)
      return res.json({ ok: true, data: { items: result.items, total: result.total, limit, offset } })
    } catch (error) {
      logger.error('Failed to list comments', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list comments' } })
    }
  })

  router.post('/api/comments', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const parsed = z.object({
      spreadsheetId: z.string().min(1).optional(),
      rowId: z.string().min(1).optional(),
      fieldId: z.string().min(1).optional(),
      targetType: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      targetFieldId: z.string().min(1).optional(),
      containerType: z.string().min(1).optional(),
      containerId: z.string().min(1).optional(),
      content: z.string().min(1),
      parentId: z.string().min(1).optional(),
    }).safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const body = parsed.data
    const hasLegacy = !!body.spreadsheetId && !!body.rowId
    const hasTarget = !!body.targetId && !!body.containerId
    if (!hasLegacy && !hasTarget) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'legacy spreadsheetId/rowId or targetId/containerId is required' },
      })
    }

    try {
      const comment = await commentService.createComment({
        spreadsheetId: body.spreadsheetId,
        rowId: body.rowId,
        fieldId: body.fieldId,
        targetType: body.targetType,
        targetId: body.targetId,
        targetFieldId: body.targetFieldId,
        containerType: body.containerType,
        containerId: body.containerId,
        content: body.content,
        parentId: body.parentId,
        authorId: getUserId(req),
      })
      return res.status(201).json({ ok: true, data: { comment } })
    } catch (error) {
      logger.error('Failed to create comment', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create comment' } })
    }
  })

  router.post('/api/comments/:commentId/resolve', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }

    try {
      await commentService.resolveComment(commentId)
      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to resolve comment', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve comment' } })
    }
  })

  return router
}
