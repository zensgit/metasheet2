/**
 * #5831 part A — the comment-id routes (PATCH/DELETE /api/comments/:commentId, POST …/read,
 * POST/DELETE …/reactions, POST …/resolve) name no sheet. Before this change they never asked which
 * sheet the comment lives on: any comments:read/write holder could act on a comment on a sheet they
 * cannot read or on a soft-deleted sheet, and ANY comments:write holder could resolve ANY comment.
 *
 * Pinned here:
 *   - the gate is the comment's OWN sheet (its stored spreadsheet_id), never a sheet named in the request;
 *   - a deleted sheet refuses (404 SHEET_DELETED) before the service is reached;
 *   - an unknown comment id, a comment on a sheet the caller cannot read and a comment on a row the caller
 *     is denied are indistinguishable (the same 403 body);
 *   - the row deny is loaded for the comment's own row only, while sheet-addressed routes keep the full set;
 *   - a readable, live comment behaves as before;
 *   - resolve needs the author or the right to edit the comment's record (owner-visible decision);
 *   - API tokens still reach exactly the comment routes they reached before (none of these).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveSheetReadableCapabilities: vi.fn(),
  loadRowLevelReadDenyEnabled: vi.fn(),
  loadDeniedRecordIds: vi.fn(),
  loadRecordCreatorMap: vi.fn(),
  loadRecordPermissionScopeMap: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  // getInternalPool: read at load time by src/db/pg.ts, which the real permission-service pulls in.
  poolManager: { get: () => ({ query: mocks.query, getInternalPool: () => null }) },
}))

vi.mock('../../src/multitable/permission-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/permission-service')>(
    '../../src/multitable/permission-service',
  )
  return {
    // The row-level write decision itself is the real one (own-write scope, record grants).
    ensureRecordWriteAllowed: actual.ensureRecordWriteAllowed,
    resolveSheetReadableCapabilities: (...args: unknown[]) => mocks.resolveSheetReadableCapabilities(...args),
    loadRowLevelReadDenyEnabled: (...args: unknown[]) => mocks.loadRowLevelReadDenyEnabled(...args),
    loadDeniedRecordIds: (...args: unknown[]) => mocks.loadDeniedRecordIds(...args),
    loadRecordCreatorMap: (...args: unknown[]) => mocks.loadRecordCreatorMap(...args),
    loadRecordPermissionScopeMap: (...args: unknown[]) => mocks.loadRecordPermissionScopeMap(...args),
  }
})

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
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from '../../src/multitable/sheet-liveness'

const COMMENT_ID = 'cmt-fake-1'
const COMMENT_SHEET = 'sheet_fake_of_comment'
/** A sheet the CALLER names in the query/body — the gate must never look at it. */
const OTHER_SHEET = 'sheet_fake_named_by_caller'
const ROW = 'row-fake-1'
const AUTHOR = 'user-fake-author'
const ACTOR = 'user-fake-actor'

type Sheet = { canRead: boolean; canEditRecord?: boolean; liveness: 'live' | 'deleted' | 'absent'; scope?: Record<string, unknown> }
let sheets: Record<string, Sheet>
let isAdmin: boolean

function buildCommentService() {
  return {
    getComments: vi.fn(async () => ({ items: [], total: 0 })),
    listMentionCandidates: vi.fn(async () => ({ items: [] })),
    getInbox: vi.fn(),
    getUnreadSummary: vi.fn(),
    getCommentAddress: vi.fn(async (_id: string): Promise<{ spreadsheetId: string; rowId: string; authorId: string } | null> => ({
      spreadsheetId: COMMENT_SHEET,
      rowId: ROW,
      authorId: AUTHOR,
    })),
    getMentionSummary: vi.fn(async () => ({ items: [] })),
    getCommentPresenceSummary: vi.fn(async () => ({ items: [], total: 0 })),
    createComment: vi.fn(async () => ({ id: 'c-new' })),
    updateComment: vi.fn(async () => ({ id: COMMENT_ID })),
    deleteComment: vi.fn(async () => undefined),
    markCommentRead: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    markMentionsRead: vi.fn(async () => undefined),
    resolveComment: vi.fn(async () => undefined),
    markAllCommentsRead: vi.fn(async () => 0),
    getCommentPresenceSummaryWithViewers: vi.fn(async () => ({ items: [], total: 0 })),
    setCommentTargetReadChecker: vi.fn(),
  }
}
type Service = ReturnType<typeof buildCommentService>

type Caller = { userId: string | null; apiToken?: boolean }

function buildApp(service: Service, caller: Caller = { userId: ACTOR }): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (caller.userId !== null) {
      ;(req as any).user = { id: caller.userId, roles: [], perms: ['comments:read', 'comments:write', 'multitable:read'] }
    }
    if (caller.apiToken) {
      ;(req as any).apiTokenId = 'tok-fake-1'
      ;(req as any).apiTokenScopes = ['comments:read']
    }
    next()
  })
  app.use(commentsRouter({ get: () => service } as any))
  return app
}

type Agent = ReturnType<typeof request>
/**
 * Every request also NAMES another sheet (query + body) — a gate that looked at the request instead of
 * the comment would pick OTHER_SHEET, which is readable and live.
 */
const ID_ROUTES: Array<{
  name: string
  send: (agent: Agent) => request.Test
  service: keyof Service
  okStatus: number
  args: unknown[]
}> = [
  {
    name: 'PATCH /api/comments/:commentId',
    send: (a) => a.patch(`/api/comments/${COMMENT_ID}`).query({ spreadsheetId: OTHER_SHEET }).send({ content: 'edited', spreadsheetId: OTHER_SHEET }),
    service: 'updateComment',
    okStatus: 200,
    args: [COMMENT_ID, ACTOR, { content: 'edited' }],
  },
  {
    name: 'DELETE /api/comments/:commentId',
    send: (a) => a.delete(`/api/comments/${COMMENT_ID}`).query({ spreadsheetId: OTHER_SHEET }).send({ spreadsheetId: OTHER_SHEET }),
    service: 'deleteComment',
    okStatus: 204,
    args: [COMMENT_ID, ACTOR],
  },
  {
    name: 'POST /api/comments/:commentId/read',
    send: (a) => a.post(`/api/comments/${COMMENT_ID}/read`).query({ containerId: OTHER_SHEET }).send({ spreadsheetId: OTHER_SHEET }),
    service: 'markCommentRead',
    okStatus: 204,
    args: [COMMENT_ID, ACTOR],
  },
  {
    name: 'POST /api/comments/:commentId/reactions',
    send: (a) => a.post(`/api/comments/${COMMENT_ID}/reactions`).query({ spreadsheetId: OTHER_SHEET }).send({ emoji: '👍', spreadsheetId: OTHER_SHEET }),
    service: 'addReaction',
    okStatus: 201,
    args: [COMMENT_ID, ACTOR, '👍'],
  },
  {
    name: 'DELETE /api/comments/:commentId/reactions',
    send: (a) => a.delete(`/api/comments/${COMMENT_ID}/reactions`).query({ spreadsheetId: OTHER_SHEET }).send({ emoji: '👍', spreadsheetId: OTHER_SHEET }),
    service: 'removeReaction',
    okStatus: 204,
    args: [COMMENT_ID, ACTOR, '👍'],
  },
  {
    name: 'POST /api/comments/:commentId/resolve',
    send: (a) => a.post(`/api/comments/${COMMENT_ID}/resolve`).query({ spreadsheetId: OTHER_SHEET }).send({ spreadsheetId: OTHER_SHEET }),
    service: 'resolveComment',
    okStatus: 204,
    args: [COMMENT_ID],
  },
]

const ACCESS_FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN', message: 'Not permitted to access comments on this sheet' } }

const pinned = usePinnedServer()

function resolverCalls(): string[] {
  return mocks.resolveSheetReadableCapabilities.mock.calls.map((call) => call[2] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  isAdmin = false
  sheets = {
    // For the generic route checks the actor may edit records here, so resolve is authorised.
    [COMMENT_SHEET]: { canRead: true, canEditRecord: true, liveness: 'live' },
    [OTHER_SHEET]: { canRead: true, canEditRecord: true, liveness: 'live' },
  }
  mocks.resolveSheetReadableCapabilities.mockImplementation(async (req: any, _query: unknown, sheetId: string) => {
    const sheet = sheets[sheetId] ?? { canRead: false, liveness: 'absent' as const }
    const userId = req.user?.id ?? ''
    return {
      access: { userId, permissions: [], isAdminRole: isAdmin },
      capabilities: { canRead: sheet.canRead, canEditRecord: sheet.canEditRecord ?? false, canDeleteRecord: sheet.canEditRecord ?? false },
      sheetLiveness: sheet.liveness,
      ...(sheet.scope ? { sheetScope: sheet.scope } : {}),
    }
  })
  mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(false)
  mocks.loadDeniedRecordIds.mockResolvedValue(new Set())
  mocks.loadRecordCreatorMap.mockResolvedValue(new Map([[ROW, AUTHOR]]))
  mocks.loadRecordPermissionScopeMap.mockResolvedValue(new Map())
})

describe('comment-id routes gate on the comment’s own sheet (#5831)', () => {
  let service: Service

  beforeEach(() => {
    service = buildCommentService()
    pinned.setApp(buildApp(service))
  })

  for (const route of ID_ROUTES) {
    describe(route.name, () => {
      it('deleted sheet → 404 SHEET_DELETED; the service, the row deny and the pool are never reached', async () => {
        sheets[COMMENT_SHEET]!.liveness = 'deleted'
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
        expect(service[route.service]).not.toHaveBeenCalled()
        expect(mocks.loadRowLevelReadDenyEnabled).not.toHaveBeenCalled()
        expect(mocks.query).not.toHaveBeenCalled()
        expect(resolverCalls()).toEqual([COMMENT_SHEET])
      })

      it('absent sheet (orphan comment) → 404 NOT_FOUND, values-free', async () => {
        delete sheets[COMMENT_SHEET]
        sheets.__absent_but_readable = { canRead: true, liveness: 'absent' }
        service.getCommentAddress.mockResolvedValue({ spreadsheetId: '__absent_but_readable', rowId: ROW, authorId: AUTHOR })
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } })
        expect(JSON.stringify(res.body)).not.toContain(COMMENT_ID)
        expect(service[route.service]).not.toHaveBeenCalled()
      })

      it('unknown id, unreadable sheet (live or deleted) and denied row all answer the SAME 403; nothing runs', async () => {
        service.getCommentAddress.mockResolvedValueOnce(null)
        const unknown = await route.send(request(pinned.url()))
        expect(resolverCalls()).toEqual([])

        sheets[COMMENT_SHEET] = { canRead: false, liveness: 'live' }
        const unreadable = await route.send(request(pinned.url()))
        sheets[COMMENT_SHEET] = { canRead: false, liveness: 'deleted' }
        const unreadableDeleted = await route.send(request(pinned.url()))

        sheets[COMMENT_SHEET] = { canRead: true, canEditRecord: true, liveness: 'live' }
        mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
        mocks.loadDeniedRecordIds.mockResolvedValue(new Set([ROW]))
        const rowDenied = await route.send(request(pinned.url()))

        for (const res of [unknown, unreadable, unreadableDeleted, rowDenied]) {
          expect(res.status).toBe(403)
          expect(res.body).toEqual(ACCESS_FORBIDDEN)
        }
        expect(service[route.service]).not.toHaveBeenCalled()
        expect(mocks.loadRecordCreatorMap).not.toHaveBeenCalled()
        expect(resolverCalls()).toEqual([COMMENT_SHEET, COMMENT_SHEET, COMMENT_SHEET])
        expect(service.getCommentAddress.mock.calls.map((c) => c[0])).toEqual([COMMENT_ID, COMMENT_ID, COMMENT_ID, COMMENT_ID])
      })

      it('the gate reads the comment’s sheet, never the sheet the request names', async () => {
        sheets[COMMENT_SHEET] = { canRead: false, liveness: 'live' }
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(403)
        expect(resolverCalls()).toEqual([COMMENT_SHEET])
        expect(resolverCalls()).not.toContain(OTHER_SHEET)
        expect(service[route.service]).not.toHaveBeenCalled()
      })

      it('readable live comment → the route works as before', async () => {
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(route.okStatus)
        expect(service[route.service]).toHaveBeenCalledTimes(1)
        expect(service[route.service]).toHaveBeenCalledWith(...route.args)
        expect(resolverCalls()).toEqual([COMMENT_SHEET])
      })
    })
  }

  it('a denied row elsewhere on the sheet does not block a comment on a readable row', async () => {
    mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
    mocks.loadDeniedRecordIds.mockResolvedValue(new Set(['row-fake-other']))
    const res = await request(pinned.url()).post(`/api/comments/${COMMENT_ID}/read`)
    expect(res.status).toBe(204)
    expect(service.markCommentRead).toHaveBeenCalledWith(COMMENT_ID, ACTOR)
  })

  describe('the row deny is evaluated for the comment’s own row only (no whole-sheet scan)', () => {
    for (const route of ID_ROUTES) {
      it(route.name, async () => {
        mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(route.okStatus)
        expect(mocks.loadRowLevelReadDenyEnabled).toHaveBeenCalledWith(expect.any(Function), COMMENT_SHEET)
        expect(mocks.loadDeniedRecordIds.mock.calls).toEqual([[expect.any(Function), COMMENT_SHEET, ACTOR, [ROW]]])
      })
    }

    it('the bound still refuses the comment’s row when it is denied', async () => {
      mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
      mocks.loadDeniedRecordIds.mockImplementation(async (_q: unknown, _s: string, _u: string, ids?: string[]) =>
        new Set((ids ?? [ROW, 'row-fake-other']).filter((id) => id === ROW)))
      const res = await request(pinned.url()).post(`/api/comments/${COMMENT_ID}/reactions`).send({ emoji: '👍' })
      expect(res.status).toBe(403)
      expect(res.body).toEqual(ACCESS_FORBIDDEN)
      expect(service.addReaction).not.toHaveBeenCalled()
    })

    it('an admin, or a sheet without row-level deny, loads no deny set at all', async () => {
      const off = await request(pinned.url()).post(`/api/comments/${COMMENT_ID}/read`)
      expect(off.status).toBe(204)
      expect(mocks.loadRowLevelReadDenyEnabled).toHaveBeenCalledTimes(1)
      expect(mocks.loadDeniedRecordIds).not.toHaveBeenCalled()

      vi.clearAllMocks()
      isAdmin = true
      mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
      const admin = await request(pinned.url()).post(`/api/comments/${COMMENT_ID}/read`)
      expect(admin.status).toBe(204)
      expect(mocks.loadRowLevelReadDenyEnabled).not.toHaveBeenCalled()
      expect(mocks.loadDeniedRecordIds).not.toHaveBeenCalled()
    })

    it('the sheet-addressed routes still load the sheet’s COMPLETE deny set (their filters need it)', async () => {
      mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(true)
      const sheetRoutes: Array<(a: Agent) => request.Test> = [
        (a) => a.get('/api/comments').query({ spreadsheetId: COMMENT_SHEET }),
        (a) => a.get('/api/comments').query({ spreadsheetId: COMMENT_SHEET, rowId: ROW }),
        (a) => a.post('/api/comments').send({ spreadsheetId: COMMENT_SHEET, rowId: ROW, content: 'x' }),
        (a) => a.get('/api/comments/mention-summary').query({ spreadsheetId: COMMENT_SHEET }),
        (a) => a.post('/api/comments/summary').send({ spreadsheetId: COMMENT_SHEET, rowIds: [ROW] }),
        (a) => a.post('/api/comments/mention-summary/mark-read').send({ spreadsheetId: COMMENT_SHEET }),
        (a) => a.post(`/api/multitable/${COMMENT_SHEET}/comments/mark-all-read`).send({}),
        (a) => a.get(`/api/multitable/${COMMENT_SHEET}/comments/presence`).query({ rowIds: ROW }),
      ]
      for (const send of sheetRoutes) {
        mocks.loadDeniedRecordIds.mockClear()
        const res = await send(request(pinned.url()))
        expect(res.status, res.text).toBeLessThan(300)
        expect(mocks.loadDeniedRecordIds.mock.calls).toHaveLength(1)
        expect(mocks.loadDeniedRecordIds.mock.calls[0]!.slice(1, 3)).toEqual([COMMENT_SHEET, ACTOR])
        expect(mocks.loadDeniedRecordIds.mock.calls[0]![3]).toBeUndefined()
      }
    })
  })

  it('a service refusal after the gate keeps its own answer (author check on edit stays in the service)', async () => {
    const { CommentAccessError } = await import('../../src/services/CommentService')
    service.updateComment.mockRejectedValueOnce(new CommentAccessError('Only the author can edit this comment'))
    const res = await request(pinned.url()).patch(`/api/comments/${COMMENT_ID}`).send({ content: 'hijack' })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('Only the author can edit this comment')
  })
})

describe('who may resolve a comment (#5831 owner decision: author, or whoever may edit its record)', () => {
  const RESOLVE_FORBIDDEN = {
    ok: false,
    error: { code: 'FORBIDDEN', message: 'Only the comment author or someone who can edit this record can resolve this comment' },
  }
  const OWN_WRITE_SCOPE = { hasAssignments: true, canRead: true, canWrite: false, canWriteOwn: true, canAdmin: false }

  async function resolveAs(caller: Caller, headers: Record<string, string> = {}) {
    const service = buildCommentService()
    pinned.setApp(buildApp(service, caller))
    let req = request(pinned.url()).post(`/api/comments/${COMMENT_ID}/resolve`)
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v)
    const res = await req
    return { res, service }
  }

  it('the author may resolve without any record edit right (no record lookups needed)', async () => {
    sheets[COMMENT_SHEET] = { canRead: true, canEditRecord: false, liveness: 'live' }
    const { res, service } = await resolveAs({ userId: AUTHOR })
    expect(res.status).toBe(204)
    expect(service.resolveComment).toHaveBeenCalledWith(COMMENT_ID)
    expect(mocks.loadRecordCreatorMap).not.toHaveBeenCalled()
  })

  it('a reader who holds comments:write but may not edit records is refused, and nothing is resolved', async () => {
    sheets[COMMENT_SHEET] = { canRead: true, canEditRecord: false, liveness: 'live' }
    const { res, service } = await resolveAs({ userId: ACTOR })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(RESOLVE_FORBIDDEN)
    expect(service.resolveComment).not.toHaveBeenCalled()
  })

  it('a record editor may resolve someone else’s comment; the decision is asked about the comment’s own row', async () => {
    const { res, service } = await resolveAs({ userId: ACTOR })
    expect(res.status).toBe(204)
    expect(service.resolveComment).toHaveBeenCalledWith(COMMENT_ID)
    expect(mocks.loadRecordCreatorMap).toHaveBeenCalledWith(expect.any(Function), COMMENT_SHEET, [ROW])
    expect(mocks.loadRecordPermissionScopeMap).toHaveBeenCalledWith(expect.any(Function), COMMENT_SHEET, [ROW], ACTOR)
  })

  it('an admin may resolve anyone’s comment', async () => {
    isAdmin = true
    const { res } = await resolveAs({ userId: ACTOR })
    expect(res.status).toBe(204)
  })

  it('an own-records-only writer may resolve on a record they created, not on someone else’s', async () => {
    sheets[COMMENT_SHEET] = { canRead: true, canEditRecord: true, liveness: 'live', scope: OWN_WRITE_SCOPE }
    const other = await resolveAs({ userId: ACTOR })
    expect(other.res.status).toBe(403)
    expect(other.res.body).toEqual(RESOLVE_FORBIDDEN)
    expect(other.service.resolveComment).not.toHaveBeenCalled()

    mocks.loadRecordCreatorMap.mockResolvedValue(new Map([[ROW, ACTOR]]))
    const own = await resolveAs({ userId: ACTOR })
    expect(own.res.status).toBe(204)
    expect(own.service.resolveComment).toHaveBeenCalledWith(COMMENT_ID)
  })

  it('a record-level write grant on the comment’s row lets an own-records-only writer resolve there', async () => {
    sheets[COMMENT_SHEET] = { canRead: true, canEditRecord: true, liveness: 'live', scope: OWN_WRITE_SCOPE }
    mocks.loadRecordPermissionScopeMap.mockResolvedValue(new Map([[ROW, { recordId: ROW, accessLevel: 'write' }]]))
    const { res } = await resolveAs({ userId: ACTOR })
    expect(res.status).toBe(204)

    // …and a grant on a DIFFERENT row does not.
    mocks.loadRecordPermissionScopeMap.mockResolvedValue(new Map([['row-fake-other', { recordId: 'row-fake-other', accessLevel: 'write' }]]))
    const elsewhere = await resolveAs({ userId: ACTOR })
    expect(elsewhere.res.status).toBe(403)
  })

  it('authorship is never taken from the x-user-id header', async () => {
    sheets[COMMENT_SHEET] = { canRead: true, canEditRecord: false, liveness: 'live' }
    const spoofed = await resolveAs({ userId: null }, { 'x-user-id': AUTHOR })
    expect(spoofed.res.status).toBe(403)
    expect(spoofed.res.body).toEqual(RESOLVE_FORBIDDEN)
    expect(spoofed.service.resolveComment).not.toHaveBeenCalled()

    const real = await resolveAs({ userId: AUTHOR })
    expect(real.res.status).toBe(204)
  })

  it('the resolve authority is asked only AFTER the sheet gate (an unreadable comment gets the access 403, not the resolve one)', async () => {
    sheets[COMMENT_SHEET] = { canRead: false, liveness: 'live' }
    const { res, service } = await resolveAs({ userId: AUTHOR })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(ACCESS_FORBIDDEN)
    expect(service.resolveComment).not.toHaveBeenCalled()
    expect(mocks.loadRecordCreatorMap).not.toHaveBeenCalled()
  })
})

describe('API tokens reach the same comment routes as before (#5831 changes none of them)', () => {
  const TOKEN = 'Bearer mst_fake_token'

  it('no comment-id route is on the token allowlist (an mst_ bearer 401s at the global gate there)', () => {
    const idRoutes: Array<[string, string]> = [
      ['PATCH', `/api/comments/${COMMENT_ID}`],
      ['DELETE', `/api/comments/${COMMENT_ID}`],
      ['POST', `/api/comments/${COMMENT_ID}/read`],
      ['POST', `/api/comments/${COMMENT_ID}/reactions`],
      ['DELETE', `/api/comments/${COMMENT_ID}/reactions`],
      ['POST', `/api/comments/${COMMENT_ID}/resolve`],
      ['GET', `/api/comments/${COMMENT_ID}`],
    ]
    for (const [method, path] of idRoutes) {
      expect(isOapiAllowlistRequest(method, path, TOKEN), `${method} ${path}`).toBe(false)
    }
  })

  it('the legitimate token routes stay allowlisted', () => {
    expect(isOapiAllowlistRequest('GET', '/api/comments', TOKEN)).toBe(true)
    expect(isOapiAllowlistRequest('GET', '/api/comments/summary', TOKEN)).toBe(true)
    expect(isOapiAllowlistRequest('GET', `/api/multitable/${COMMENT_SHEET}/comments/presence`, TOKEN)).toBe(true)
    expect(isOapiAllowlistRequest('POST', '/api/comments', TOKEN)).toBe(true)
  })

  it('a token request on the comment list still works through the sheet gate', async () => {
    const service = buildCommentService()
    pinned.setApp(buildApp(service, { userId: ACTOR, apiToken: true }))
    const list = await request(pinned.url()).get('/api/comments').query({ spreadsheetId: COMMENT_SHEET })
    expect(list.status).toBe(200)
    expect(service.getComments).toHaveBeenCalledTimes(1)
    const created = await request(pinned.url()).post('/api/comments').send({ spreadsheetId: COMMENT_SHEET, rowId: ROW, content: 'via token' })
    expect(created.status).toBe(201)
    expect(service.getCommentAddress).not.toHaveBeenCalled()
  })
})
