import type { Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import type { Injector } from '@wendellhu/redi'
import { ICommentService, type CommentQueryOptions } from '../di/identifiers'
import { Logger } from '../core/logger'
import { rbacGuard } from '../rbac/rbac'
import { CommentValidationError } from '../services/CommentService'

const logger = new Logger('CommentsRoutes')
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string') return value
  return undefined
}

function readQueryValues(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
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

  router.get('/api/comments/mention-candidates', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
      q: z.string().optional(),
      limit: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      q: readQueryValue(req.query.q),
      limit: parseNumberParam(readQueryValue(req.query.limit)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const limit = clampLimit(parsed.data.limit)
      const result = await commentService.listMentionCandidates(parsed.data.spreadsheetId, {
        q: parsed.data.q,
        limit,
      })
      return res.json({ ok: true, data: { items: result.items, total: result.total, limit } })
    } catch (error) {
      logger.error('Failed to load comment mention candidates', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load comment mention candidates' } })
    }
  })

  router.get('/api/comments/inbox', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      limit: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      limit: parseNumberParam(readQueryValue(req.query.limit)),
      offset: parseNumberParam(readQueryValue(req.query.offset)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const limit = clampLimit(parsed.data.limit)
      const offset = clampOffset(parsed.data.offset)
      const result = await commentService.getInbox(getUserId(req), { limit, offset })
      return res.json({ ok: true, data: { items: result.items, total: result.total, limit, offset } })
    } catch (error) {
      logger.error('Failed to load comment inbox', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load comment inbox' } })
    }
  })

  router.get('/api/comments/unread-count', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    try {
      const count = await commentService.getUnreadCount(getUserId(req))
      return res.json({ ok: true, data: { count } })
    } catch (error) {
      logger.error('Failed to load unread comment count', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load unread comment count' } })
    }
  })

  router.get('/api/comments/mention-summary', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const result = await commentService.getMentionSummary(parsed.data.spreadsheetId, getUserId(req))
      return res.json({ ok: true, data: result })
    } catch (error) {
      logger.error('Failed to load mention summary', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load mention summary' } })
    }
  })

  router.get('/api/comments/summary', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
      rowIds: z.array(z.string().min(1)).optional(),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      rowIds: readQueryValues(req.query.rowIds),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const result = await commentService.getCommentPresenceSummary(
        parsed.data.spreadsheetId,
        parsed.data.rowIds,
        getUserId(req),
      )
      return res.json({ ok: true, data: { items: result.items, total: result.total } })
    } catch (error) {
      logger.error('Failed to list comment summaries', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list comment summaries' } })
    }
  })

  router.post('/api/comments', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
      rowId: z.string().min(1),
      fieldId: z.string().min(1).optional(),
      content: z.string().min(1),
      parentId: z.string().min(1).optional(),
      mentions: z.array(z.string().min(1)).optional(),
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
        mentions: parsed.data.mentions,
        authorId: getUserId(req),
      })
      return res.status(201).json({ ok: true, data: { comment } })
    } catch (error) {
      if (error instanceof CommentValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: error.message } })
      }
      logger.error('Failed to create comment', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create comment' } })
    }
  })

  router.post('/api/comments/:commentId/read', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }

    try {
      await commentService.markCommentRead(commentId, getUserId(req))
      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to mark comment as read', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark comment as read' } })
    }
  })

  router.post('/api/comments/mention-summary/mark-read', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      await commentService.markMentionsRead(parsed.data.spreadsheetId, getUserId(req))
      return res.status(204).send()
    } catch (error) {
      logger.error('Failed to mark mentions read', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark mentions read' } })
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
