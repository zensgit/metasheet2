import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => {
  const query = vi.fn()
  return {
    query,
    resolveSheetReadableCapabilities: vi.fn(),
    loadRowLevelReadDenyEnabled: vi.fn(),
    loadDeniedRecordIds: vi.fn(),
  }
})

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({ query: mocks.query }),
  },
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

function buildCommentService() {
  return {
    getComments: vi.fn(async () => ({ items: [{ id: 'visible-comment' }], total: 1 })),
    listMentionCandidates: vi.fn(async () => ({ items: [], total: 0 })),
    getInbox: vi.fn(),
    getUnreadSummary: vi.fn(),
    getMentionSummary: vi.fn(async () => ({ items: [], unresolvedMentionCount: 0, unreadMentionCount: 0, mentionedRecordCount: 0, unreadRecordCount: 0 })),
    getCommentPresenceSummary: vi.fn(async () => ({ items: [], total: 0 })),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    markCommentRead: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    markMentionsRead: vi.fn(),
    resolveComment: vi.fn(),
    markAllCommentsRead: vi.fn(),
    getCommentPresenceSummaryWithViewers: vi.fn(async () => ({ items: [], total: 0 })),
    setCommentTargetReadChecker: vi.fn(),
  }
}

function buildApp(
  commentService: ReturnType<typeof buildCommentService>,
  // #5808: `apiTokenId` stands in for what the real apiTokenAuth sets on an `mst_` request.
  requestShape: { apiTokenId?: string; noUser?: boolean } = {},
): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (!requestShape.noUser) {
      ;(req as any).user = {
        id: 'actor-row-denied',
        roles: [],
        perms: ['comments:read', 'comments:write', 'multitable:read'],
        permissions: ['comments:read', 'comments:write', 'multitable:read'],
      }
    }
    if (requestShape.apiTokenId) (req as any).apiTokenId = requestShape.apiTokenId
    next()
  })
  app.use(commentsRouter({ get: () => commentService } as any))
  return app
}

const pinned = usePinnedServer()

describe('comments routes row-deny gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveSheetReadableCapabilities.mockResolvedValue({
      access: { userId: 'actor-row-denied', isAdminRole: false },
      capabilities: { canRead: true },
    })
    mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
    mocks.loadDeniedRecordIds.mockResolvedValue(new Set(['row-denied']))
  })

  it('returns an empty comment page for a denied target row without calling the service reader', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService))
    const res = await request(pinned.url())
      .get('/api/comments')
      .query({ spreadsheetId: 'sheet-1', rowId: 'row-denied' })

    expect(res.status).toBe(200)
    expect(res.body.data.items).toEqual([])
    expect(res.body.data.total).toBe(0)
    expect(commentService.getComments).not.toHaveBeenCalled()
  })

  it('passes filtered rowIds and denied-row exclusions to summary and mention surfaces', async () => {
    const commentService = buildCommentService()
    const app = buildApp(commentService)

    pinned.setApp(app)
    await request(pinned.url())
      .get('/api/comments/summary')
      .query({ spreadsheetId: 'sheet-1', rowIds: ['row-visible', 'row-denied'] })
      .expect(200)
    expect(commentService.getCommentPresenceSummary).toHaveBeenCalledWith(
      'sheet-1',
      ['row-visible'],
      'actor-row-denied',
      ['row-denied'],
    )

    // POST variant (ids in the JSON body — the grid's per-page id set outgrew
    // the query string): same filtering + denied-row exclusions as GET.
    await request(pinned.url())
      .post('/api/comments/summary')
      .send({ spreadsheetId: 'sheet-1', rowIds: ['row-visible', 'row-denied'] })
      .expect(200)
    expect(commentService.getCommentPresenceSummary).toHaveBeenLastCalledWith(
      'sheet-1',
      ['row-visible'],
      'actor-row-denied',
      ['row-denied'],
    )

    await request(pinned.url())
      .get('/api/comments/mention-summary')
      .query({ spreadsheetId: 'sheet-1' })
      .expect(200)
    expect(commentService.getMentionSummary).toHaveBeenCalledWith(
      'sheet-1',
      'actor-row-denied',
      ['row-denied'],
    )
  })

  it('rejects an over-limit or over-length summary id set before the service is reached (Codex bound)', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService))

    // 5001 ids -> 400, service never called (bound is 5000).
    const tooMany = Array.from({ length: 5001 }, (_unused, index) => `row-${index}`)
    const overCount = await request(pinned.url())
      .post('/api/comments/summary')
      .send({ spreadsheetId: 'sheet-1', rowIds: tooMany })
    expect(overCount.status).toBe(400)

    // A single 129-char id -> 400 (per-id length bound is 128).
    const overLength = await request(pinned.url())
      .post('/api/comments/summary')
      .send({ spreadsheetId: 'sheet-1', rowIds: ['x'.repeat(129)] })
    expect(overLength.status).toBe(400)

    // The GET variant shares the schema, so it is bounded identically. It is
    // probed with the per-id length bound rather than the count bound: 5001 ids
    // in a query string exceed Node's URL/header limit and the socket resets
    // before any route runs (ECONNRESET) — which is precisely why the id set
    // moved into a POST body in the first place.
    const overLengthGet = await request(pinned.url())
      .get('/api/comments/summary')
      .query({ spreadsheetId: 'sheet-1', rowIds: 'x'.repeat(129) })
    expect(overLengthGet.status).toBe(400)

    expect(commentService.getCommentPresenceSummary).not.toHaveBeenCalled()

    // Exactly 5000 well-formed ids still passes through.
    const atLimit = await request(pinned.url())
      .post('/api/comments/summary')
      .send({ spreadsheetId: 'sheet-1', rowIds: Array.from({ length: 5000 }, (_unused, index) => `row-${index}`) })
    expect(atLimit.status).toBe(200)
    expect(commentService.getCommentPresenceSummary).toHaveBeenCalledTimes(1)
  })

  it('passes denied-row exclusions to mark-read paths', async () => {
    const commentService = buildCommentService()
    commentService.markAllCommentsRead.mockResolvedValue(2)
    const app = buildApp(commentService)

    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/comments/mention-summary/mark-read')
      .send({ spreadsheetId: 'sheet-1' })
      .expect(204)
    expect(commentService.markMentionsRead).toHaveBeenCalledWith(
      'sheet-1',
      'actor-row-denied',
      ['row-denied'],
    )

    await request(pinned.url())
      .post('/api/multitable/sheet-1/comments/mark-all-read')
      .send({})
      .expect(200)
    expect(commentService.markAllCommentsRead).toHaveBeenCalledWith(
      'sheet-1',
      'actor-row-denied',
      ['row-denied'],
    )
  })

  it('rejects comment creation on a denied target row before service create', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService))
    const res = await request(pinned.url())
      .post('/api/comments')
      .send({ spreadsheetId: 'sheet-1', rowId: 'row-denied', content: 'secret write' })

    expect(res.status).toBe(403)
    expect(commentService.createComment).not.toHaveBeenCalled()
  })
})

// #5808 — who gets edit-time mention labels on GET /api/comments. The service decides WHAT is named
// (own comments, own mentions, active users, bounded — pinned in comment-service.test.ts); the route
// decides FOR WHOM: only an authenticated interactive session caller, and only after the existing
// G-8 sheet-read gate and row-level deny. Fake ids only.
describe('comments list — edit-time mention labels (#5808)', () => {
  const ownComment = {
    id: 'comment-own',
    authorId: 'actor-row-denied',
    mentions: ['u-fake-alpha'],
    mentionLabels: { 'u-fake-alpha': 'Fake Alpha' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveSheetReadableCapabilities.mockResolvedValue({
      access: { userId: 'actor-row-denied', isAdminRole: false },
      capabilities: { canRead: true },
    })
    mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
    mocks.loadDeniedRecordIds.mockResolvedValue(new Set(['row-denied']))
  })

  it("asks the service to label the session caller's own comments and passes the labels through", async () => {
    const commentService = buildCommentService()
    commentService.getComments.mockResolvedValue({ items: [ownComment] as any, total: 1 })
    pinned.setApp(buildApp(commentService))

    const res = await request(pinned.url()).get('/api/comments').query({ spreadsheetId: 'sheet-1', rowId: 'row-visible' })

    expect(res.status).toBe(200)
    expect(commentService.getComments).toHaveBeenCalledTimes(1)
    expect((commentService.getComments.mock.calls[0] as unknown[])[1]).toMatchObject({
      mentionLabelsAuthorId: 'actor-row-denied',
      viewerId: 'actor-row-denied',
      excludeRowIds: ['row-denied'],
    })
    expect(res.body.data.items[0].mentionLabels).toEqual({ 'u-fake-alpha': 'Fake Alpha' })
  })

  it('never asks for labels on an API-token request', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService, { apiTokenId: 'tok-fake-1' }))

    await request(pinned.url()).get('/api/comments').query({ spreadsheetId: 'sheet-1' }).expect(200)

    expect(commentService.getComments).toHaveBeenCalledTimes(1)
    expect((commentService.getComments.mock.calls[0] as unknown[])[1]).not.toHaveProperty('mentionLabelsAuthorId')
  })

  it('never asks for labels when the id would only come from the x-user-id header', async () => {
    mocks.resolveSheetReadableCapabilities.mockResolvedValue({
      access: { userId: '', isAdminRole: false },
      capabilities: { canRead: true },
    })
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService, { noUser: true }))

    await request(pinned.url())
      .get('/api/comments')
      .set('x-user-id', 'actor-row-denied')
      .query({ spreadsheetId: 'sheet-1' })
      .expect(200)

    const options = (commentService.getComments.mock.calls[0] as unknown[])[1]
    // the header still feeds reactedByMe (pre-existing), but never decides whose comments get labels
    expect(options).toMatchObject({ viewerId: 'actor-row-denied' })
    expect(options).not.toHaveProperty('mentionLabelsAuthorId')
  })

  it('a caller who cannot read the sheet or the row gets no comments and no labels', async () => {
    const commentService = buildCommentService()
    commentService.getComments.mockResolvedValue({ items: [ownComment] as any, total: 1 })
    pinned.setApp(buildApp(commentService))

    const rowDenied = await request(pinned.url()).get('/api/comments').query({ spreadsheetId: 'sheet-1', rowId: 'row-denied' })
    expect(rowDenied.status).toBe(200)
    expect(rowDenied.body.data.items).toEqual([])

    mocks.resolveSheetReadableCapabilities.mockResolvedValue({
      access: { userId: 'actor-row-denied', isAdminRole: false },
      capabilities: { canRead: false },
    })
    const sheetDenied = await request(pinned.url()).get('/api/comments').query({ spreadsheetId: 'sheet-1' })
    expect(sheetDenied.status).toBe(403)
    expect(JSON.stringify(sheetDenied.body)).not.toContain('Fake Alpha')

    expect(commentService.getComments).not.toHaveBeenCalled()
  })
})
