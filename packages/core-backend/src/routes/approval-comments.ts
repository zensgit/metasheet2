/**
 * Lock-10 (S2) — `/api/approvals/:id/comments*` routes. NEW FILE (not folded into
 * `routes/approvals.ts`, per the S2 implementation contract §6).
 *
 * RBAC SCOPE ON EVERY ROUTE, INCLUDING WRITE, IS `rbacGuard('approvals', 'read')` — deliberate.
 * OD-S1-14 says "the same predicate [`canReadApprovalInstance`] gates comment create" and rejects
 * a separate `canWriteApprovalComment`. D3 (participant-union write widening) is the WHOLE
 * authorization for write, not a conjunct — adding `approvals:write` here would make comment
 * write `S1 AND approvals:write`, strictly narrower than the ruled union, which no owner ruling
 * authorizes. `rbacGuard('approvals','read')` is only the coarse leg-1 door (matches
 * `routes/approval-history.ts`'s own reasoning); `canReadApprovalInstance` (leg-2) is the real
 * authorization for every verb on this router.
 *
 * Order of checks (§6.2, gated by C-16):
 *   1. authenticate                                -> 401
 *   2. rbacGuard('approvals','read')                -> 403
 *   3. isPlmApprovalId(id)                          -> 404 APPROVAL_NOT_FOUND (OD-S1-18(a))
 *   4. canReadApprovalInstance(pool, viewerId, id)  -> 404 APPROVAL_NOT_FOUND (OD-S1-11/14)
 *      -- PATCH/DELETE only, in THIS order:
 *   5. comment lookup (id + same instance_id)       -> 404 APPROVAL_COMMENT_NOT_FOUND
 *   6. author check                                 -> 404 APPROVAL_COMMENT_NOT_FOUND
 *   7. tombstone check (PATCH only)                 -> 409 APPROVAL_COMMENT_DELETED
 *   8. payload validation                           -> 400 VALIDATION_ERROR
 * Steps 3/4 run before payload validation (a non-participant must not learn their payload was
 * malformed); steps 5/6 run before 8 for the SAME reason one level down (a non-author must not
 * learn their edit payload was malformed). All of this ordering lives inside
 * `approval-comment-service.ts`'s exported functions — this route layer only maps the thrown
 * error's `code` to an HTTP status, so the ordering cannot drift between the two files.
 *
 * Denial shapes are values-free (`approvalCommentErrorResponse`, mirroring
 * `routes/approval-history.ts`'s dedicated `approvalNotFoundResponse` builder and its own
 * docblock's reason: never forward an `error.details` key onto a denial path, Lock-7 OD-L7-7).
 * The 404-not-403 collapse for "not the author" is REVERSIBLE S2 IMPLEMENTATION JUDGEMENT, not a
 * ratified ruling — see the PR body.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { pool } from '../db/pg'
import {
  createApprovalComment,
  deleteApprovalComment,
  editApprovalComment,
  listApprovalComments,
  listMentionCandidates,
  notifyApprovalCommentMentions,
  ApprovalCommentDeletedError,
  ApprovalCommentNotFoundError,
  ApprovalCommentRecordNotFoundError,
  ApprovalCommentValidationError,
} from '../services/approval-comment-service'

const MAX_APPROVAL_COMMENT_PAGE_SIZE = 200

/** Same viewer-id derivation `routes/approvals.ts` and `routes/approval-history.ts` each keep a
 *  local copy of, rather than importing a sibling route's private helper (this family's own
 *  stated convention — see `approval-history.ts:47-49`'s docblock). */
function resolveApprovalActorId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? req.user?.sub
  if (typeof candidate !== 'string') return null
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : null
}

function parsePaging(value: unknown, fallback: number, max: number = MAX_APPROVAL_COMMENT_PAGE_SIZE): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  return Math.min(parsed, max)
}

/** Mirrors `approval-history.ts`'s dedicated denial builder: `{ ok:false, error:{ code, message } }`
 *  with NO `details` key — a values channel out of a denial path (Lock-7 OD-L7-7). */
function approvalCommentErrorResponse(code: string, message: string) {
  return { ok: false, error: { code, message } }
}

function unauthenticatedResponse(res: Response): Response {
  return res.status(404).json(approvalCommentErrorResponse('APPROVAL_NOT_FOUND', 'Approval instance not found'))
}

export function approvalCommentsRouter(): Router {
  const r = Router()

  // Route-ordering caution: `/comments/mention-candidates` is registered BEFORE any
  // `/comments/:commentId` pattern, or Express would match `mention-candidates` as a `:commentId`.

  r.get(
    '/api/approvals/:id/comments/mention-candidates',
    authenticate,
    rbacGuard('approvals', 'read'),
    async (req: Request, res: Response) => {
      try {
        if (!pool) {
          return res.status(503).json(approvalCommentErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
        }
        const viewerId = resolveApprovalActorId(req)
        if (!viewerId) return unauthenticatedResponse(res)

        const q = typeof req.query.q === 'string' ? req.query.q : undefined
        const limit = Number.parseInt(String(req.query.limit ?? ''), 10)
        const result = await listMentionCandidates(pool, {
          instanceId: req.params.id,
          viewerId,
          q,
          limit: Number.isFinite(limit) ? limit : undefined,
        })
        return res.json({ ok: true, data: result })
      } catch (error) {
        return handleApprovalCommentError(res, error, 'APPROVAL_COMMENT_MENTION_CANDIDATES_FAILED', 'Failed to list mention candidates')
      }
    },
  )

  r.get('/api/approvals/:id/comments', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(approvalCommentErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      }
      const viewerId = resolveApprovalActorId(req)
      if (!viewerId) return unauthenticatedResponse(res)

      const limit = parsePaging(req.query.limit, 50)
      const offset = parsePaging(req.query.offset, 0, Number.MAX_SAFE_INTEGER)
      const result = await listApprovalComments(pool, {
        instanceId: req.params.id,
        viewerId,
        limit,
        offset,
      })
      return res.json({ ok: true, data: result })
    } catch (error) {
      return handleApprovalCommentError(res, error, 'APPROVAL_COMMENT_LIST_FAILED', 'Failed to list approval comments')
    }
  })

  r.post('/api/approvals/:id/comments', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(approvalCommentErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      }
      const authorId = resolveApprovalActorId(req)
      if (!authorId) return unauthenticatedResponse(res)

      const body = req.body?.body
      const parentId = typeof req.body?.parentId === 'string' && req.body.parentId.trim() ? req.body.parentId.trim() : undefined
      const mentions = Array.isArray(req.body?.mentions) ? (req.body.mentions as unknown[]).filter((m): m is string => typeof m === 'string') : undefined

      const { comment } = await createApprovalComment(pool, {
        instanceId: req.params.id,
        authorId,
        body,
        parentId,
        mentions,
      })
      // Best-effort, outside the write's own success/failure — a mention notification never rolls
      // back a committed comment. Values-free payload w.r.t. the instance (see the service's
      // `notifyApprovalCommentMentions` docblock).
      notifyApprovalCommentMentions({
        instanceId: req.params.id,
        commentId: comment.id,
        authorId,
        mentions: comment.mentions,
      }).catch(() => {})
      return res.status(201).json({ ok: true, data: { comment } })
    } catch (error) {
      return handleApprovalCommentError(res, error, 'APPROVAL_COMMENT_CREATE_FAILED', 'Failed to create approval comment')
    }
  })

  r.patch('/api/approvals/:id/comments/:commentId', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(approvalCommentErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      }
      const editorId = resolveApprovalActorId(req)
      if (!editorId) return unauthenticatedResponse(res)

      const body = req.body?.body
      const mentions = Array.isArray(req.body?.mentions) ? (req.body.mentions as unknown[]).filter((m): m is string => typeof m === 'string') : undefined

      const { comment } = await editApprovalComment(pool, {
        commentId: req.params.commentId,
        instanceId: req.params.id,
        editorId,
        body,
        mentions,
      })
      notifyApprovalCommentMentions({
        instanceId: req.params.id,
        commentId: comment.id,
        authorId: editorId,
        mentions: comment.mentions,
      }).catch(() => {})
      return res.json({ ok: true, data: { comment } })
    } catch (error) {
      return handleApprovalCommentError(res, error, 'APPROVAL_COMMENT_UPDATE_FAILED', 'Failed to update approval comment')
    }
  })

  r.delete('/api/approvals/:id/comments/:commentId', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(approvalCommentErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      }
      const actorId = resolveApprovalActorId(req)
      if (!actorId) return unauthenticatedResponse(res)

      const { comment } = await deleteApprovalComment(pool, {
        commentId: req.params.commentId,
        instanceId: req.params.id,
        actorId,
      })
      return res.json({ ok: true, data: { comment } })
    } catch (error) {
      return handleApprovalCommentError(res, error, 'APPROVAL_COMMENT_DELETE_FAILED', 'Failed to delete approval comment')
    }
  })

  return r
}

function handleApprovalCommentError(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string): Response {
  if (error instanceof ApprovalCommentNotFoundError) {
    return res.status(404).json(approvalCommentErrorResponse(error.code, error.message))
  }
  if (error instanceof ApprovalCommentRecordNotFoundError) {
    return res.status(404).json(approvalCommentErrorResponse(error.code, error.message))
  }
  if (error instanceof ApprovalCommentDeletedError) {
    return res.status(409).json(approvalCommentErrorResponse(error.code, error.message))
  }
  if (error instanceof ApprovalCommentValidationError) {
    return res.status(400).json(approvalCommentErrorResponse(error.code, error.message))
  }
  return res.status(500).json(approvalCommentErrorResponse(fallbackCode, fallbackMessage))
}
