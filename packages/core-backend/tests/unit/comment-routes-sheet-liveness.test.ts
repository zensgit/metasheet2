/**
 * Comments × sheet liveness. Comments are stored by `spreadsheet_id` and never join `meta_sheets`, so
 * before this gate every sheet-addressed comment route kept serving and accepting threads on a
 * soft-deleted sheet. `resolveCommentReadContext` now refuses a non-live sheet — AFTER the read gate,
 * so a caller who may not read the sheet gets the same 403 for a live and a deleted one.
 *
 * The route table below is pinned to the handlers the all-routes closed-world guard classifies as
 * sheet-addressed in routes/comments.ts (`sheetAddressedRouteKeys`, the scan behind
 * multitable-sheet-liveness-closure-all-routes.guard.test.ts): a route added to that file reds here until
 * it gets a row. The comment-id and cross-sheet routes are not sheet-addressed; the guard names them.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { sheetAddressedRouteKeys } from '../utils/sheet-liveness-route-scan'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveSheetReadableCapabilities: vi.fn(),
  loadRowLevelReadDenyEnabled: vi.fn(),
  loadDeniedRecordIds: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: mocks.query }) },
}))

vi.mock('../../src/multitable/permission-service', () => ({
  resolveSheetReadableCapabilities: (...args: unknown[]) => mocks.resolveSheetReadableCapabilities(...args),
  loadRowLevelReadDenyEnabled: (...args: unknown[]) => mocks.loadRowLevelReadDenyEnabled(...args),
  loadDeniedRecordIds: (...args: unknown[]) => mocks.loadDeniedRecordIds(...args),
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
import { SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from '../../src/multitable/sheet-liveness'

const SHEET = 'sheet_liveness_comments'

function buildCommentService() {
  return {
    getComments: vi.fn(async () => ({ items: [{ id: 'c1' }], total: 1 })),
    listMentionCandidates: vi.fn(async () => ({ items: [], total: 0 })),
    getInbox: vi.fn(),
    getUnreadSummary: vi.fn(),
    getMentionSummary: vi.fn(async () => ({ items: [] })),
    getCommentPresenceSummary: vi.fn(async () => ({ items: [], total: 0 })),
    createComment: vi.fn(async () => ({ id: 'c-new' })),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    markCommentRead: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    markMentionsRead: vi.fn(async () => undefined),
    resolveComment: vi.fn(),
    markAllCommentsRead: vi.fn(async () => 0),
    getCommentPresenceSummaryWithViewers: vi.fn(async () => ({ items: [], total: 0 })),
    setCommentTargetReadChecker: vi.fn(),
  }
}
type Service = ReturnType<typeof buildCommentService>

function buildApp(service: Service): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: 'actor-1', roles: [], perms: ['comments:read', 'comments:write', 'multitable:read'] }
    next()
  })
  app.use(commentsRouter({ get: () => service } as any))
  return app
}

type Agent = ReturnType<typeof request>
const ROUTES: Array<{ name: string; send: (agent: Agent) => request.Test; service: keyof Service; okStatus: number }> = [
  { name: 'GET /api/comments', send: (a) => a.get('/api/comments').query({ spreadsheetId: SHEET }), service: 'getComments', okStatus: 200 },
  { name: 'GET /api/comments/mention-candidates', send: (a) => a.get('/api/comments/mention-candidates').query({ spreadsheetId: SHEET, q: 'al' }), service: 'listMentionCandidates', okStatus: 200 },
  { name: 'GET /api/comments/mention-summary', send: (a) => a.get('/api/comments/mention-summary').query({ spreadsheetId: SHEET }), service: 'getMentionSummary', okStatus: 200 },
  { name: 'GET /api/comments/summary', send: (a) => a.get('/api/comments/summary').query({ spreadsheetId: SHEET, rowIds: 'r1' }), service: 'getCommentPresenceSummary', okStatus: 200 },
  { name: 'POST /api/comments/summary', send: (a) => a.post('/api/comments/summary').send({ spreadsheetId: SHEET, rowIds: ['r1'] }), service: 'getCommentPresenceSummary', okStatus: 200 },
  { name: 'POST /api/comments', send: (a) => a.post('/api/comments').send({ spreadsheetId: SHEET, rowId: 'r1', content: 'hello' }), service: 'createComment', okStatus: 201 },
  { name: 'POST /api/comments/mention-summary/mark-read', send: (a) => a.post('/api/comments/mention-summary/mark-read').send({ spreadsheetId: SHEET }), service: 'markMentionsRead', okStatus: 204 },
  { name: 'GET /api/multitable/:spreadsheetId/mention-candidates', send: (a) => a.get(`/api/multitable/${SHEET}/mention-candidates`).query({ q: 'al' }), service: 'listMentionCandidates', okStatus: 200 },
  { name: 'POST /api/multitable/:spreadsheetId/comments/mark-all-read', send: (a) => a.post(`/api/multitable/${SHEET}/comments/mark-all-read`).send({}), service: 'markAllCommentsRead', okStatus: 200 },
  { name: 'GET /api/multitable/:spreadsheetId/comments/presence', send: (a) => a.get(`/api/multitable/${SHEET}/comments/presence`), service: 'getCommentPresenceSummaryWithViewers', okStatus: 200 },
]

const pinned = usePinnedServer()

function capabilities(canRead: boolean, sheetLiveness: 'live' | 'deleted' | 'absent') {
  mocks.resolveSheetReadableCapabilities.mockResolvedValue({
    access: { userId: 'actor-1', isAdminRole: false },
    capabilities: { canRead },
    sheetLiveness,
  })
}

describe('comments routes refuse a non-live sheet', () => {
  let service: Service

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(false)
    mocks.loadDeniedRecordIds.mockResolvedValue(new Set())
    service = buildCommentService()
    pinned.setApp(buildApp(service))
  })

  it('covers exactly the sheet-addressed routes the closed-world scan finds in routes/comments.ts', () => {
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(ROUTES.length)
    expect(ROUTES.map((r) => r.name).sort()).toEqual(sheetAddressedRouteKeys('routes/comments.ts').sort())
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('soft-deleted sheet → 404 SHEET_DELETED; the service and the row-deny lookup are never reached', async () => {
        capabilities(true, 'deleted')
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
        expect(service[route.service]).not.toHaveBeenCalled()
        expect(mocks.loadRowLevelReadDenyEnabled).not.toHaveBeenCalled()
        expect(mocks.resolveSheetReadableCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), SHEET)
      })

      it('absent sheet → 404 NOT_FOUND (values-free)', async () => {
        capabilities(true, 'absent')
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } })
        expect(JSON.stringify(res.body)).not.toContain(SHEET)
        expect(service[route.service]).not.toHaveBeenCalled()
      })

      it('no read access → the same 403 for a live and a deleted sheet (no liveness oracle)', async () => {
        capabilities(false, 'live')
        const live = await route.send(request(pinned.url()))
        capabilities(false, 'deleted')
        const deleted = await route.send(request(pinned.url()))
        expect(live.status).toBe(403)
        expect(deleted.status).toBe(403)
        expect(deleted.body).toEqual(live.body)
        expect(service[route.service]).not.toHaveBeenCalled()
      })

      it('live sheet → the route proceeds (positive control)', async () => {
        capabilities(true, 'live')
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(route.okStatus)
        expect(service[route.service]).toHaveBeenCalledTimes(1)
      })
    })
  }
})
