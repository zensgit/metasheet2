/**
 * P3-3 — `/api/approvals/form-drafts*` routes (docs contract:
 * reviews/p33-server-draft-contract-20260914.md). NEW FILE, mirrors `routes/approval-comments.ts`'s
 * shape (dedicated router, local viewer-id derivation per this family's own convention rather than
 * importing a sibling route's private helper).
 *
 * RBAC SCOPE: `rbacGuard('approvals', 'write')` on every route, including the two GETs. A draft is
 * scratch state for a NOT-YET-SUBMITTED approval, gated by the same permission `POST /api/approvals`
 * itself uses (`routes/approvals.ts:1415`) — reading back or discarding your own in-progress draft
 * requires no LESS permission than being allowed to eventually submit it.
 *
 * AUTHORIZATION IS `user_id` ONLY (contract §2). Every handler below derives the acting user from
 * the verified token (`resolveApprovalActorId`) and every query the service issues is scoped to
 * that id. There is no `:userId` route param and no code path here reads a tenant/org header
 * (`x-tenant-id` or otherwise) — org must never participate in this table's visibility. See the
 * service module and the migration for the full reasoning.
 *
 * NEVER-THROW-TO-THE-USER (contract §4 D): every handler is wrapped so a DB failure returns a
 * values-free 5xx JSON body, never an unhandled exception — the FRONTEND wrapper
 * (`apps/web/src/approvals/serverFormDraft.ts`) is what actually implements "silent degrade" by
 * swallowing any non-2xx/network failure and behaving as if there were no draft, mirroring
 * `formDraft.ts`'s try/catch doctrine one layer up.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { pool } from '../db/pg'
import {
  clearApprovalFormDraft,
  listApprovalFormDrafts,
  loadApprovalFormDraft,
  saveApprovalFormDraft,
  ApprovalFormDraftConflictError,
  ApprovalFormDraftTooLargeError,
  ApprovalFormDraftValidationError,
} from '../services/approval-form-draft-service'

/** Local copy, not an import of a sibling route's private helper — this family's own stated
 *  convention (see `approval-comments.ts`'s and `approval-history.ts`'s identical local copies). */
function resolveApprovalActorId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? req.user?.sub
  if (typeof candidate !== 'string') return null
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : null
}

function draftErrorResponse(code: string, message: string) {
  return { ok: false, error: { code, message } }
}

function unauthenticatedResponse(res: Response): Response {
  return res.status(401).json(draftErrorResponse('UNAUTHENTICATED', 'Authentication required'))
}

function handleDraftError(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string): Response {
  if (error instanceof ApprovalFormDraftValidationError) {
    return res.status(400).json(draftErrorResponse(error.code, error.message))
  }
  if (error instanceof ApprovalFormDraftTooLargeError) {
    return res.status(413).json(draftErrorResponse(error.code, error.message))
  }
  // FIX 4 (gate P2-4): the row this save's UPDATE branch expected to find vanished between its
  // existence SELECT and the UPDATE itself. 409, not 500 — this is a deliberate, detected conflict,
  // not an unexpected failure; the client's `saveFormDraftServer` already swallows any non-2xx
  // response (contract §4 D), so this surfaces to the user identically to any other lost autosave.
  // (gate2 P3-D fix round: `clearApprovalFormDraft` now shares this save's advisory lock and can no
  // longer produce this specific interleaving itself — see that function's own comment — so this
  // branch is reached via some OTHER unlocked writer, e.g. `sweepExpiredApprovalFormDrafts`, racing
  // the same window; the 409 handling here stays live code either way.)
  if (error instanceof ApprovalFormDraftConflictError) {
    return res.status(409).json(draftErrorResponse(error.code, error.message))
  }
  return res.status(500).json(draftErrorResponse(fallbackCode, fallbackMessage))
}

export function approvalFormDraftsRouter(): Router {
  const r = Router()

  // Route registered BEFORE `/form-drafts/:templateId` is unnecessary here (distinct exact vs.
  // one-segment-longer paths never collide in Express), but the list route is still declared first
  // for readability (list → single-item CRUD).
  r.get('/api/approvals/form-drafts', authenticate, rbacGuard('approvals', 'write'), async (req: Request, res: Response) => {
    try {
      if (!pool) return res.status(503).json(draftErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      const userId = resolveApprovalActorId(req)
      if (!userId) return unauthenticatedResponse(res)
      const drafts = await listApprovalFormDrafts(pool, userId)
      return res.json({ ok: true, data: { drafts } })
    } catch (error) {
      return handleDraftError(res, error, 'APPROVAL_FORM_DRAFT_LIST_FAILED', 'Failed to list approval form drafts')
    }
  })

  r.get('/api/approvals/form-drafts/:templateId', authenticate, rbacGuard('approvals', 'write'), async (req: Request, res: Response) => {
    try {
      if (!pool) return res.status(503).json(draftErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      const userId = resolveApprovalActorId(req)
      if (!userId) return unauthenticatedResponse(res)
      const draft = await loadApprovalFormDraft(pool, userId, req.params.templateId)
      return res.json({ ok: true, data: { draft } })
    } catch (error) {
      return handleDraftError(res, error, 'APPROVAL_FORM_DRAFT_LOAD_FAILED', 'Failed to load approval form draft')
    }
  })

  r.put('/api/approvals/form-drafts/:templateId', authenticate, rbacGuard('approvals', 'write'), async (req: Request, res: Response) => {
    try {
      if (!pool) return res.status(503).json(draftErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      const userId = resolveApprovalActorId(req)
      if (!userId) return unauthenticatedResponse(res)
      const signature = req.body?.signature
      const data = req.body?.data
      if (typeof signature !== 'string' || !signature) {
        return res.status(400).json(draftErrorResponse('VALIDATION_ERROR', 'signature is required'))
      }
      const draft = await saveApprovalFormDraft({
        userId,
        templateId: req.params.templateId,
        signature,
        data: (data ?? {}) as Record<string, unknown>,
      })
      return res.json({ ok: true, data: { draft } })
    } catch (error) {
      return handleDraftError(res, error, 'APPROVAL_FORM_DRAFT_SAVE_FAILED', 'Failed to save approval form draft')
    }
  })

  r.delete('/api/approvals/form-drafts/:templateId', authenticate, rbacGuard('approvals', 'write'), async (req: Request, res: Response) => {
    try {
      if (!pool) return res.status(503).json(draftErrorResponse('SERVICE_UNAVAILABLE', 'DB not configured'))
      const userId = resolveApprovalActorId(req)
      if (!userId) return unauthenticatedResponse(res)
      await clearApprovalFormDraft(userId, req.params.templateId)
      return res.status(204).end()
    } catch (error) {
      return handleDraftError(res, error, 'APPROVAL_FORM_DRAFT_CLEAR_FAILED', 'Failed to clear approval form draft')
    }
  })

  return r
}
