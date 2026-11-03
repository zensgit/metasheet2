import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { json, Router } from 'express'

import { isElearningContentSurfaceEnabled } from '../elearning/feature-flags'
import {
  ElearningContentCoursePublishError,
  publishElearningContentCourse,
  type ElearningContentCoursePublishDb,
  type PublishElearningContentCourseInput,
} from '../services/elearning-content-course-publish'
import {
  ElearningContentRevisionStoreError,
  storeElearningContentRevision,
  type CreateElearningContentRevisionInput,
  type ElearningContentRevisionDb,
} from '../services/elearning-content-revision-postgres'
import {
  ELEARNING_ASSIGNEE_SEARCH_DEFAULT_LIMIT,
  ELEARNING_ASSIGNEE_SEARCH_MAX_LIMIT,
  ELEARNING_ASSIGNEE_SEARCH_MAX_QUERY_LENGTH,
  searchElearningAssignees,
} from '../services/elearning-assignee-directory'
import {
  ElearningOpenCompletionStoreError,
  recordElearningOpenCompletion,
  type ElearningOpenCompletionDb,
  type RecordElearningOpenCompletionInput,
} from '../services/elearning-open-completion-postgres'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVISION_KEYS = new Set([
  'requestId',
  'itemType',
  'title',
  'articleHtml',
  'externalUrl',
])
const PUBLISH_KEYS = new Set(['requestId', 'title', 'items'])
const OPEN_KEYS = new Set(['requestId'])

const REVISION_STATUS = {
  invalid_input: 400,
  conflict: 409,
  unavailable: 503,
} as const
const PUBLISH_STATUS = {
  invalid_input: 400,
  reference_unavailable: 409,
  conflict: 409,
  unavailable: 503,
} as const
const OPEN_STATUS = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  course_withdrawn: 409,
  unsupported_item: 400,
  conflict: 409,
  unavailable: 503,
} as const

const smallJsonParser = json({ limit: 16 * 1024 })
export const ELEARNING_CONTENT_PUBLISH_JSON_LIMIT_BYTES = 1024 * 1024
export const ELEARNING_CONTENT_REVISION_JSON_LIMIT_BYTES = 8 * 1024 * 1024
const publishJsonParser = json({ limit: ELEARNING_CONTENT_PUBLISH_JSON_LIMIT_BYTES })
const revisionJsonParser = json({ limit: ELEARNING_CONTENT_REVISION_JSON_LIMIT_BYTES })

export interface ElearningContentRouteDeps {
  db: ElearningContentRevisionDb &
    ElearningContentCoursePublishDb &
    ElearningOpenCompletionDb
  env?: NodeJS.ProcessEnv
  adminGuard: RequestHandler
  readGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  storeElearningContentRevision?: typeof storeElearningContentRevision
  publishElearningContentCourse?: typeof publishElearningContentCourse
  recordElearningOpenCompletion?: typeof recordElearningOpenCompletion
  searchElearningAssignees?: typeof searchElearningAssignees
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function uuidParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null
}

const ASSIGNEE_SEARCH_KEYS = new Set(['q', 'limit'])
const ASSIGNEE_LIMIT_RE = /^[1-9][0-9]{0,2}$/

/**
 * Closed query for GET /api/elearning/admin/assignees: optional `q` (trimmed, at most
 * ELEARNING_ASSIGNEE_SEARCH_MAX_QUERY_LENGTH chars, no NUL) and optional `limit`
 * (1..ELEARNING_ASSIGNEE_SEARCH_MAX_LIMIT). Any other key, a repeated key, or a malformed
 * value is invalid_input; the org is never read from the request.
 */
function readAssigneeSearchQuery(req: Request): { query: string; limit: number } | null {
  const raw = req.query as Record<string, unknown>
  if (Object.keys(raw).some((key) => !ASSIGNEE_SEARCH_KEYS.has(key))) return null
  const q = raw.q === undefined ? '' : raw.q
  if (typeof q !== 'string') return null
  const query = q.trim()
  if (query.length > ELEARNING_ASSIGNEE_SEARCH_MAX_QUERY_LENGTH || query.includes('\0')) return null
  let limit = ELEARNING_ASSIGNEE_SEARCH_DEFAULT_LIMIT
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'string' || !ASSIGNEE_LIMIT_RE.test(raw.limit)) return null
    limit = Number(raw.limit)
    if (limit > ELEARNING_ASSIGNEE_SEARCH_MAX_LIMIT) return null
  }
  return { query, limit }
}

function parseJson(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    parser(req, res, (error?: unknown) => {
      if (!error) return next()
      if (!req.readableEnded) req.resume()
      const parsed = error as { status?: unknown; type?: unknown }
      if (parsed.status === 413 || parsed.type === 'entity.too.large') {
        res.status(413).json({ error: 'payload_too_large' })
        return
      }
      res.status(400).json({ error: 'invalid_input' })
    })
  }
}

export function createElearningContentRouter(
  deps: ElearningContentRouteDeps,
): Router | null {
  const env = deps.env ?? process.env
  if (!isElearningContentSurfaceEnabled(env)) return null

  const router = Router()
  const storeRevision = deps.storeElearningContentRevision ?? storeElearningContentRevision
  const publishCourse = deps.publishElearningContentCourse ?? publishElearningContentCourse
  const recordOpen = deps.recordElearningOpenCompletion ?? recordElearningOpenCompletion
  const searchAssignees = deps.searchElearningAssignees ?? searchElearningAssignees

  const requireFlags = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningContentSurfaceEnabled(env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }
  const requireIdentity = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    next()
  }
  const requireOrg = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }
  const gate = (
    guard: RequestHandler,
    parser: RequestHandler,
  ): RequestHandler[] => [requireFlags, requireIdentity, requireOrg, guard, parser]
  const context = (req: Request, res: Response): { actorId: string; orgId: string } | null => {
    if (!isElearningContentSurfaceEnabled(env)) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    const actorId = deps.viewerId(req)
    if (!actorId) {
      res.status(401).json({ error: 'unauthenticated' })
      return null
    }
    const orgId = deps.orgId(req)
    if (!orgId) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return null
    }
    return { actorId, orgId }
  }
  const asyncHandler =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response): void => {
      void handler(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    }

  router.post(
    '/api/elearning/admin/content-revisions',
    ...gate(deps.adminGuard, parseJson(revisionJsonParser)),
    asyncHandler(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || !hasExactKeys(body, REVISION_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await storeRevision(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          requestId: body.requestId,
          itemType: body.itemType,
          title: body.title,
          articleHtml: body.articleHtml,
          externalUrl: body.externalUrl,
        } as CreateElearningContentRevisionInput)
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningContentRevisionStoreError) {
          res.status(REVISION_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/admin/courses/content/publish',
    ...gate(deps.adminGuard, parseJson(publishJsonParser)),
    asyncHandler(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || !hasExactKeys(body, PUBLISH_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await publishCourse(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          requestId: body.requestId,
          title: body.title,
          items: body.items,
        } as PublishElearningContentCourseInput)
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningContentCoursePublishError) {
          res.status(PUBLISH_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  // F13 (no-video rehearsal 2026-10-12): the course forms' assignee picker. Same gate
  // chain as the content admin commands above (flags -> identity -> org -> adminGuard);
  // read-only, scoped to the JWT-bound org, returns id + name + email only.
  router.get(
    '/api/elearning/admin/assignees',
    requireFlags,
    requireIdentity,
    requireOrg,
    deps.adminGuard,
    asyncHandler(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const parsed = readAssigneeSearchQuery(req)
      if (!parsed) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const result = await searchAssignees(deps.db, {
        orgId: ctx.orgId,
        query: parsed.query,
        limit: parsed.limit,
      })
      res.status(200).json({
        items: result.items.map((item) => ({ id: item.id, name: item.name, email: item.email })),
      })
    }),
  )

  router.post(
    '/api/elearning/me/course-items/:itemId/open',
    ...gate(deps.readGuard, parseJson(smallJsonParser)),
    asyncHandler(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const itemId = uuidParam(req, 'itemId')
      const body = readObject(req.body)
      if (!itemId || !body || !hasExactKeys(body, OPEN_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await recordOpen(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
          requestId: body.requestId,
          itemId,
        } as RecordElearningOpenCompletionInput)
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningOpenCompletionStoreError) {
          res.status(OPEN_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  return router
}
