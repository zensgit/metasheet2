/**
 * W4-G — `POST /api/multitable/:spreadsheetId/comments/mark-all-read` 的读回执主体身份。
 *
 * 该路由曾以 `parsed.data.userId?.trim() || context.userId` 取身份（“优先用 body 里的 userId”），
 * 于是任何已认证、对该 sheet 有读权的调用方都能传 `{"userId":"<受害者>"}`，让
 * `CommentService.markAllCommentsRead` 以受害者身份批量 upsert `meta_comment_reads`，抹掉其未读/提醒。
 * 本 spec 钉死：写回执的主体只能是**认证主体**（`resolveRequestAccess` → `context.userId`），
 * 请求体里的 `userId` 恒被忽略；无认证主体时由 `rbacGuard` 401 挡在服务之前。
 *
 * 挂法与 tests/unit/comment-routes-row-deny.test.ts 一致（pinned-server + mock 掉触库依赖），
 * 唯一区别：这里**不 mock** `src/rbac/rbac`，而是 mock 它的两个触库依赖，让 REAL `rbacGuard`
 * 参与——未认证那条断言才是真门的证据，而不是在断言一个假门。
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const ACTOR = 'user-actor-a'
const VICTIM = 'user-victim-b'

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

// REAL rbacGuard，只替掉它的触库依赖（service 表查询 / 命名空间准入）。
vi.mock('../../src/rbac/service', () => ({
  userHasPermission: vi.fn(async () => false),
  isAdmin: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => []),
}))

vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn(async () => true),
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
    getComments: vi.fn(async () => ({ items: [], total: 0 })),
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
    markAllCommentsRead: vi.fn(async () => 3),
    getCommentPresenceSummaryWithViewers: vi.fn(async () => ({ items: [], total: 0 })),
    setCommentTargetReadChecker: vi.fn(),
  }
}

/** `authenticated=false` 时完全不挂 req.user，等价于没有认证主体的请求。 */
function buildApp(commentService: ReturnType<typeof buildCommentService>, authenticated = true): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (authenticated) {
      ;(req as any).user = {
        id: ACTOR,
        roles: [],
        perms: ['comments:read', 'comments:write', 'multitable:read'],
        permissions: ['comments:read', 'comments:write', 'multitable:read'],
      }
    }
    next()
  })
  app.use(commentsRouter({ get: () => commentService } as any))
  return app
}

const pinned = usePinnedServer()

describe('mark-all-read 只认认证主体', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveSheetReadableCapabilities.mockResolvedValue({
      access: { userId: ACTOR, isAdminRole: false },
      capabilities: { canRead: true },
    })
    mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(false)
    mocks.loadDeniedRecordIds.mockResolvedValue(new Set<string>())
  })

  it('请求体里的 userId 被忽略：服务收到的仍是认证主体，绝不是受害者', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService))

    const res = await request(pinned.url())
      .post('/api/multitable/sheet-1/comments/mark-all-read')
      .send({ userId: VICTIM })

    expect(res.status).toBe(200)
    expect(commentService.markAllCommentsRead).toHaveBeenCalledTimes(1)
    expect(commentService.markAllCommentsRead).toHaveBeenCalledWith('sheet-1', ACTOR, [])
    // 点名负控：受害者身份绝不能出现在任何一次调用的 actor 位上。
    expect(commentService.markAllCommentsRead).not.toHaveBeenCalledWith(
      expect.anything(),
      VICTIM,
      expect.anything(),
    )
  })

  it('空 body：服务收到认证主体', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService))

    await request(pinned.url())
      .post('/api/multitable/sheet-1/comments/mark-all-read')
      .send({})
      .expect(200)

    expect(commentService.markAllCommentsRead).toHaveBeenCalledWith('sheet-1', ACTOR, [])
  })

  it('未认证：真 rbacGuard 401，服务不被调用', async () => {
    const commentService = buildCommentService()
    pinned.setApp(buildApp(commentService, false))

    const res = await request(pinned.url())
      .post('/api/multitable/sheet-1/comments/mark-all-read')
      .send({ userId: VICTIM })

    expect(res.status).toBe(401)
    expect(commentService.markAllCommentsRead).not.toHaveBeenCalled()
    expect(mocks.resolveSheetReadableCapabilities).not.toHaveBeenCalled()
  })
})
