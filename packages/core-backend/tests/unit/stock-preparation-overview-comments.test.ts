/**
 * 一个项目一张备料表 — S3 fix round 1 (R11): comments on the stock-preparation project overview. The
 * capability resolvers clamp `canComment` to false on the overview for every person, but the comment routes
 * gate on the sheet READ plus the global `comments:write` code — so the clamped bit was never consulted and
 * anyone who could read the overview could comment on its rows. Pinned here, with the REAL capability
 * resolver (permission-service) over a mock pool, for a PLATFORM ADMIN and for a floor reader:
 *
 *   - every comment WRITE (create, edit, delete, react, un-react, resolve) on the overview answers 403
 *     STOCK_PREP_OVERVIEW_READ_ONLY and the service is never called;
 *   - reads and the caller's own read marks (list, mark-read) still work on the overview;
 *   - an ordinary sheet is unchanged (control), and no overview lookup is even issued for its id.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const OVERVIEW = 'sheet_0123456789abcdef01234567'
const PLAIN = 'sheet_plain_comments_r11'
const ROW = 'rec_r11'
const COMMENT_ID = 'cmt_r11'

const mocks = vi.hoisted(() => ({
  log: [] as Array<{ sql: string; params: unknown[] }>,
  commentSheet: 'sheet_0123456789abcdef01234567',
  isAdmin: true,
  perms: [] as string[],
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      getInternalPool: () => null,
      query: async (sql: string, params: unknown[] = []) => {
        const q = sql.replace(/\s+/g, ' ').trim()
        mocks.log.push({ sql: q, params })
        if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') return { rows: [{ deleted_at: null }] }
        if (q === "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2") {
          const ids = (params[0] as string[]) ?? []
          return { rows: ids.filter((id) => id === 'sheet_0123456789abcdef01234567').map((id) => ({ id })) }
        }
        return { rows: [] }
      },
    }),
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => mocks.isAdmin),
  listUserPermissions: vi.fn(async () => mocks.perms),
  userHasPermission: vi.fn(async () => mocks.isAdmin),
  invalidateUserPerms: vi.fn(),
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: (resource: string, action: string) => (req: any, res: any, next: () => void) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' })
    const perms: string[] = Array.isArray(req.user.perms) ? req.user.perms : []
    if (!perms.includes(`${resource}:${action}`)) return res.status(403).json({ error: 'Insufficient permissions' })
    return next()
  },
}))
vi.mock('../../src/middleware/api-token-auth', () => ({
  apiTokenAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../../src/middleware/rate-limiter', () => ({
  apiTokenWriteRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../../src/multitable/oapi-write-audit', () => ({
  buildOapiAuditContext: () => undefined,
  oapiWriteAuditBoundary: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../../src/services/CommentService', () => ({
  CommentAccessError: class CommentAccessError extends Error {},
  CommentConflictError: class CommentConflictError extends Error {},
  CommentNotFoundError: class CommentNotFoundError extends Error {},
  CommentValidationError: class CommentValidationError extends Error {},
}))

import { commentsRouter } from '../../src/routes/comments'

function buildService() {
  return {
    getComments: vi.fn(async () => ({ items: [], total: 0 })),
    getCommentAddress: vi.fn(async () => ({ spreadsheetId: mocks.commentSheet, rowId: ROW })),
    createComment: vi.fn(async () => ({ id: 'c-new' })),
    updateComment: vi.fn(async () => ({ id: COMMENT_ID })),
    deleteComment: vi.fn(async () => undefined),
    markCommentRead: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    resolveComment: vi.fn(async () => undefined),
    setCommentTargetReadChecker: vi.fn(),
  }
}
type Service = ReturnType<typeof buildService>

const PERMS = ['comments:read', 'comments:write', 'multitable:read']

function buildApp(service: Service): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: 'u_r11', roles: mocks.isAdmin ? ['admin'] : [], perms: PERMS }
    next()
  })
  app.use(commentsRouter({ get: () => service } as any))
  return app
}

type Agent = ReturnType<typeof request>
const WRITES: Array<{ name: string; send: (a: Agent, sheet: string) => request.Test; service: keyof Service; okStatus: number }> = [
  { name: 'POST /api/comments', send: (a, sheet) => a.post('/api/comments').send({ spreadsheetId: sheet, rowId: ROW, content: 'hello' }), service: 'createComment', okStatus: 201 },
  { name: 'PATCH /api/comments/:id', send: (a) => a.patch(`/api/comments/${COMMENT_ID}`).send({ content: 'edited' }), service: 'updateComment', okStatus: 200 },
  { name: 'DELETE /api/comments/:id', send: (a) => a.delete(`/api/comments/${COMMENT_ID}`), service: 'deleteComment', okStatus: 204 },
  { name: 'POST /api/comments/:id/reactions', send: (a) => a.post(`/api/comments/${COMMENT_ID}/reactions`).send({ emoji: '👍' }), service: 'addReaction', okStatus: 201 },
  { name: 'DELETE /api/comments/:id/reactions', send: (a) => a.delete(`/api/comments/${COMMENT_ID}/reactions`).send({ emoji: '👍' }), service: 'removeReaction', okStatus: 204 },
  { name: 'POST /api/comments/:id/resolve', send: (a) => a.post(`/api/comments/${COMMENT_ID}/resolve`), service: 'resolveComment', okStatus: 204 },
]

const pinned = usePinnedServer()

describe('S3 fix round 1 — no comment writes on the stock-preparation project overview (R11)', () => {
  let service: Service
  beforeEach(() => {
    mocks.log.length = 0
    mocks.isAdmin = true
    mocks.perms = []
    mocks.commentSheet = OVERVIEW
    service = buildService()
    pinned.setApp(buildApp(service))
  })

  for (const asAdmin of [true, false]) {
    for (const route of WRITES) {
      it(`${asAdmin ? 'platform admin' : 'floor reader'}: ${route.name} on the overview → 403 STOCK_PREP_OVERVIEW_READ_ONLY, service never called`, async () => {
        mocks.isAdmin = asAdmin
        mocks.perms = asAdmin ? [] : ['multitable:read', 'multitable:write', 'comments:write']
        const res = await route.send(request(pinned.url()), OVERVIEW)
        expect(res.status).toBe(403)
        expect(res.body.error).toMatchObject({ code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'comment' } })
        expect(service[route.service]).not.toHaveBeenCalled()
      })
    }
  }

  it('reads and the caller\'s own read marks still work on the overview', async () => {
    const list = await request(pinned.url()).get('/api/comments').query({ spreadsheetId: OVERVIEW })
    expect(list.status).toBe(200)
    const read = await request(pinned.url()).post(`/api/comments/${COMMENT_ID}/read`)
    expect(read.status).toBe(204)
    expect(service.markCommentRead).toHaveBeenCalledTimes(1)
  })

  for (const route of WRITES) {
    it(`control: ${route.name} on an ordinary sheet reaches the service, with no overview lookup for its id`, async () => {
      mocks.commentSheet = PLAIN
      const res = await route.send(request(pinned.url()), PLAIN)
      expect(res.status).toBe(route.okStatus)
      expect(service[route.service]).toHaveBeenCalledTimes(1)
      expect(mocks.log.some((entry) => entry.sql.includes("'system_kind'"))).toBe(false)
    })
  }
})
