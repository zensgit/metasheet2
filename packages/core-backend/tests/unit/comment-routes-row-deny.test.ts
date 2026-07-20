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

function buildApp(commentService: ReturnType<typeof buildCommentService>): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = {
      id: 'actor-row-denied',
      roles: [],
      perms: ['comments:read', 'comments:write', 'multitable:read'],
      permissions: ['comments:read', 'comments:write', 'multitable:read'],
    }
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
