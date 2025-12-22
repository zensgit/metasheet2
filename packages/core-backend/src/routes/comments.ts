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
    const schema = z.object({
      spreadsheetId: z.string().min(1),
      rowId: z.string().min(1).optional(),
      resolved: z.boolean().optional(),
      limit: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      rowId: readQueryValue(req.query.rowId),
      resolved: parseBoolean(readQueryValue(req.query.resolved)),
      limit: parseNumberParam(readQueryValue(req.query.limit)),
      offset: parseNumberParam(readQueryValue(req.query.offset)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const limit = clampLimit(parsed.data.limit)
      const offset = clampOffset(parsed.data.offset)
      const options: CommentQueryOptions = {
        rowId: parsed.data.rowId,
        resolved: parsed.data.resolved,
        limit,
        offset,
      }
      const result = await commentService.getComments(parsed.data.spreadsheetId, options)
      return res.json({ ok: true, data: { items: result.items, total: result.total, limit, offset } })
    } catch (error) {
      logger.error('Failed to list comments', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list comments' } })
    }
  })

  router.post('/api/comments', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
      rowId: z.string().min(1),
      fieldId: z.string().min(1).optional(),
      content: z.string().min(1),
      parentId: z.string().min(1).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const comment = await commentService.createComment({
        spreadsheetId: parsed.data.spreadsheetId,
        rowId: parsed.data.rowId,
        fieldId: parsed.data.fieldId,
        content: parsed.data.content,
        parentId: parsed.data.parentId,
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
