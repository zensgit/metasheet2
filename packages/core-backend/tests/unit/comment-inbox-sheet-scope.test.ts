/**
 * #5831 part B + #5840 — the cross-sheet comment aggregates and mark-all-read, through the real router.
 *
 * GET /api/comments/inbox and GET /api/comments/unread-count name no sheet. Before this change they listed
 * and counted comments on sheets the caller cannot read and on soft-deleted sheets, while (since part A)
 * POST /api/comments/:id/read refuses exactly those — so listed items could never be cleared.
 *
 * The permission helpers are replaced by one in-memory WORLD that answers the way the real ones do (read
 * rule, liveness, row deny); the service is a fake that applies the scope the route hands it BEFORE it
 * counts and paginates, as the SQL does (the SQL itself is pinned in comment-service-inbox-scope-sql.test.ts).
 * Pinned here:
 *   - only live sheets the caller may read, minus rows the caller is denied, are listed and counted;
 *     `total` and the pages agree;
 *   - every listed item can be marked read (the comment-id gate lets it through), and nothing else;
 *   - admins: liveness still applies, row deny does not, the e-learning projection check does (as on the
 *     sheet-addressed routes);
 *   - the row deny is asked only about candidate rows, only for sheets that have it switched on, and
 *     the flag itself is read in ONE batched query for the whole readable set;
 *   - on a row-deny sheet the scope is an ALLOW list of the rows it checked: a comment that arrives
 *     after the candidate lookup (a row nobody checked) is left out of that request, never let in
 *     (check-then-use race, disclosure-lens finding on #5831 part B);
 *   - the identity is the signed-in user, never the x-user-id header;
 *   - mark-all-read writes only the signed-in user's read state; a body userId naming someone else is
 *     refused (403) and that user's read state is untouched (#5840).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveSheetReadableCapabilities: vi.fn(),
  filterReadableSheetRowsForAccess: vi.fn(),
  loadRowLevelReadDenyEnabled: vi.fn(),
  loadDeniedRecordIds: vi.fn(),
  loadSheetLivenessBatch: vi.fn(),
  loadElearningProjectionSheetOrgMap: vi.fn(),
  canAccessElearningProjectionSheet: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  // getInternalPool: read at load time by src/db/pg.ts (routes/comments.ts -> multitable/access -> rbac/service).
  poolManager: { get: () => ({ query: mocks.query, getInternalPool: () => null }) },
}))

vi.mock('../../src/multitable/permission-service', () => ({
  resolveSheetReadableCapabilities: (...args: unknown[]) => mocks.resolveSheetReadableCapabilities(...args),
  filterReadableSheetRowsForAccess: (...args: unknown[]) => mocks.filterReadableSheetRowsForAccess(...args),
  loadRowLevelReadDenyEnabled: (...args: unknown[]) => mocks.loadRowLevelReadDenyEnabled(...args),
  loadDeniedRecordIds: (...args: unknown[]) => mocks.loadDeniedRecordIds(...args),
}))

vi.mock('../../src/multitable/sheet-liveness', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/sheet-liveness')>('../../src/multitable/sheet-liveness')
  return { ...actual, loadSheetLivenessBatch: (...args: unknown[]) => mocks.loadSheetLivenessBatch(...args) }
})

vi.mock('../../src/multitable/elearning-projection-access', () => ({
  loadElearningProjectionSheetOrgMap: (...args: unknown[]) => mocks.loadElearningProjectionSheetOrgMap(...args),
  canAccessElearningProjectionSheet: (...args: unknown[]) => mocks.canAccessElearningProjectionSheet(...args),
}))

vi.mock('../../src/rbac/rbac', () => ({
  // The real guard's contract, read from req.user: 401 without an authenticated id, 403 without the code.
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
import type { CommentInboxScope } from '../../src/di/identifiers'

const READER = 'user-fake-reader'
const AUTHOR = 'user-fake-author'
const BYSTANDER = 'user-fake-bystander'
const ADMIN = 'user-fake-admin'
const PERMS = ['comments:read', 'comments:write']

// ── The world ───────────────────────────────────────────────────────────────

type Sheet = {
  liveness: 'live' | 'deleted'
  readers: Set<string>
  rowDeny: boolean
  /** userId → denied row ids (only meaningful when rowDeny) */
  denied: Record<string, Set<string>>
  /** e-learning projection sheet: org id; access is decided by `elearningAccess` */
  elearningOrg?: string
}
type Comment = { id: string; sheet: string; row: string; author: string; mentions: string[]; readBy: Set<string>; at: number }

let sheets: Record<string, Sheet>
let comments: Comment[]
let elearningAccess: boolean

function sheet(partial: Partial<Sheet>): Sheet {
  return { liveness: 'live', readers: new Set([READER]), rowDeny: false, denied: {}, ...partial }
}

function buildWorld() {
  elearningAccess = false
  sheets = {
    'sht-readable': sheet({}),
    'sht-unreadable': sheet({ readers: new Set() }),
    'sht-deleted': sheet({ liveness: 'deleted' }),
    'sht-rowdeny': sheet({ rowDeny: true, denied: { [READER]: new Set(['row-denied']) } }),
    'sht-elearning': sheet({ elearningOrg: 'org-fake' }),
    // 'sht-absent' has comments but no meta_sheets row at all.
  }
  let at = 0
  const c = (id: string, sheetId: string, row: string, extra: Partial<Comment> = {}): Comment =>
    ({ id, sheet: sheetId, row, author: AUTHOR, mentions: [], readBy: new Set(), at: at++, ...extra })
  comments = [
    c('cmt-a1', 'sht-readable', 'row-a'),
    c('cmt-a2', 'sht-readable', 'row-a', { mentions: [READER] }),
    c('cmt-a3', 'sht-readable', 'row-b'),
    c('cmt-a4', 'sht-readable', 'row-b', { mentions: [READER], readBy: new Set([READER]) }), // listed as mentioned, not unread
    c('cmt-a5', 'sht-readable', 'row-b', { readBy: new Set([READER]) }), // read, not mentioned: not listed
    c('cmt-own', 'sht-readable', 'row-a', { author: READER }), // own: never listed
    c('cmt-b1', 'sht-unreadable', 'row-x', { mentions: [READER] }),
    c('cmt-b2', 'sht-unreadable', 'row-x'),
    c('cmt-c1', 'sht-deleted', 'row-y', { mentions: [READER] }),
    c('cmt-d1', 'sht-rowdeny', 'row-visible'),
    c('cmt-d2', 'sht-rowdeny', 'row-denied', { mentions: [READER] }),
    c('cmt-e1', 'sht-absent', 'row-z'),
    c('cmt-f1', 'sht-elearning', 'row-f'),
  ]
}

const livenessOf = (id: string): 'live' | 'deleted' | 'absent' => sheets[id]?.liveness ?? 'absent'
const canRead = (id: string, userId: string, isAdmin: boolean): boolean => {
  const s = sheets[id]
  if (s?.elearningOrg) return elearningAccess
  return isAdmin || (s?.readers.has(userId) ?? false)
}

function isCandidate(comment: Comment, userId: string): boolean {
  return comment.author !== userId && (comment.mentions.includes(userId) || !comment.readBy.has(userId))
}

/** What the SQL scope predicate admits: the sheet is in scope and, on a row-deny sheet, the row is allowed. */
function inScope(comment: Comment, scope: CommentInboxScope): boolean {
  if (!scope.sheetIds.includes(comment.sheet)) return false
  const rowDeny = scope.rowDenySheets.find((d) => d.spreadsheetId === comment.sheet)
  return !rowDeny || rowDeny.allowedRowIds.includes(comment.row.trim())
}

/** The batched row-deny flag lookup the route runs through the pool (loadInboxRowDenySheetIds). */
const ROW_DENY_FLAG_SQL = /row_level_read_permissions_enabled AS enabled, base_id FROM meta_sheets WHERE id = ANY\(\$1::text\[\]\)/

/** The service fake: filters by the scope BEFORE counting and paginating (what the SQL WHERE does). */
function buildCommentService() {
  return {
    listInboxCandidateSheetIds: vi.fn(async (userId: string) =>
      [...new Set(comments.filter((c) => isCandidate(c, userId)).map((c) => c.sheet))]),
    listInboxCandidateRowIds: vi.fn(async (userId: string, sheetIds: readonly string[]) => {
      const out = new Map<string, string[]>()
      for (const c of comments) {
        if (!sheetIds.includes(c.sheet) || !isCandidate(c, userId)) continue
        const rows = out.get(c.sheet) ?? []
        if (!rows.includes(c.row)) rows.push(c.row)
        out.set(c.sheet, rows)
      }
      return out
    }),
    getInbox: vi.fn(async (userId: string, options: { limit: number; offset: number }, scope: CommentInboxScope) => {
      if (!scope || scope.sheetIds.length === 0) return { items: [], total: 0 }
      const matched = comments
        .filter((c) => isCandidate(c, userId) && inScope(c, scope))
        .sort((a, b) => b.at - a.at)
      return {
        total: matched.length,
        items: matched.slice(options.offset, options.offset + options.limit).map((c) => ({
          id: c.id,
          sheetId: c.sheet,
          rowId: c.row,
          unread: !c.readBy.has(userId),
          mentioned: c.mentions.includes(userId),
        })),
      }
    }),
    getUnreadSummary: vi.fn(async (userId: string, scope: CommentInboxScope) => {
      if (!scope || scope.sheetIds.length === 0) return { unreadCount: 0, mentionUnreadCount: 0 }
      const unread = comments.filter((c) => c.author !== userId && !c.readBy.has(userId) && inScope(c, scope))
      return { unreadCount: unread.length, mentionUnreadCount: unread.filter((c) => c.mentions.includes(userId)).length }
    }),
    getCommentAddress: vi.fn(async (id: string) => {
      const c = comments.find((x) => x.id === id)
      return c ? { spreadsheetId: c.sheet, rowId: c.row } : null
    }),
    markCommentRead: vi.fn(async (id: string, userId: string) => {
      comments.find((x) => x.id === id)?.readBy.add(userId)
    }),
    markAllCommentsRead: vi.fn(async (sheetId: string, userId: string, excluded: string[] = []) => {
      let n = 0
      for (const c of comments) {
        if (c.sheet !== sheetId || c.author === userId || c.readBy.has(userId) || excluded.includes(c.row)) continue
        c.readBy.add(userId)
        n += 1
      }
      return n
    }),
    setCommentTargetReadChecker: vi.fn(),
  }
}
type Service = ReturnType<typeof buildCommentService>

function installWorldMocks() {
  mocks.query.mockImplementation(async (sqlText: string, params?: unknown[]) => {
    if (ROW_DENY_FLAG_SQL.test(sqlText)) {
      const ids = (params?.[0] as string[]) ?? []
      return { rows: ids.filter((id) => sheets[id]).map((id) => ({ id, enabled: sheets[id]!.rowDeny, base_id: null })) }
    }
    throw new Error(`unexpected pool query: ${sqlText}`)
  })
  mocks.resolveSheetReadableCapabilities.mockImplementation(async (req: any, _q: unknown, sheetId: string) => {
    const isAdminRole = Array.isArray(req.user?.roles) && req.user.roles.includes('admin')
    const userId = String(req.user?.id ?? '')
    return {
      access: { userId, permissions: req.user?.perms ?? [], isAdminRole },
      capabilities: { canRead: canRead(sheetId, userId, isAdminRole) },
      sheetLiveness: livenessOf(sheetId),
    }
  })
  mocks.filterReadableSheetRowsForAccess.mockImplementation(async (_q: unknown, rows: Array<{ id: string }>, access: any) =>
    // The real helper returns every row for an admin BEFORE its e-learning check.
    access.isAdminRole ? rows : rows.filter((row) => canRead(row.id, access.userId, false)))
  mocks.loadSheetLivenessBatch.mockImplementation(async (_q: unknown, ids: string[]) => new Map(ids.map((id) => [id, livenessOf(id)])))
  mocks.loadRowLevelReadDenyEnabled.mockImplementation(async (_q: unknown, id: string) => sheets[id]?.rowDeny ?? false)
  mocks.loadDeniedRecordIds.mockImplementation(async (_q: unknown, id: string, userId: string, rowIds?: string[]) => {
    const denied = sheets[id]?.denied[userId] ?? new Set<string>()
    return new Set((rowIds ?? [...denied]).filter((row) => denied.has(row)))
  })
  mocks.loadElearningProjectionSheetOrgMap.mockImplementation(async (_q: unknown, ids: string[]) =>
    new Map(ids.filter((id) => sheets[id]?.elearningOrg).map((id) => [id, sheets[id]!.elearningOrg!])))
  mocks.canAccessElearningProjectionSheet.mockImplementation(() => elearningAccess)
}

type Caller = { id: string; admin?: boolean; perms?: string[] }

function buildApp(service: Service, caller: Caller): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: caller.id, roles: caller.admin ? ['admin'] : [], perms: caller.perms ?? PERMS }
    next()
  })
  app.use(commentsRouter({ get: () => service } as any))
  return app
}

const pinned = usePinnedServer()

async function inboxPage(limit: number, offset: number, headers: Record<string, string> = {}) {
  const res = await request(pinned.url()).get('/api/comments/inbox').query({ limit, offset }).set(headers)
  expect(res.status, res.text).toBe(200)
  return res.body.data as { items: Array<{ id: string; unread: boolean; mentioned: boolean }>; total: number }
}

async function allInboxIds(limit = 2): Promise<{ ids: string[]; totals: number[] }> {
  const ids: string[] = []
  const totals: number[] = []
  for (let offset = 0; offset < 100; offset += limit) {
    const page = await inboxPage(limit, offset)
    totals.push(page.total)
    if (page.items.length === 0) break
    expect(page.items.length).toBeLessThanOrEqual(limit)
    ids.push(...page.items.map((i) => i.id))
  }
  return { ids, totals }
}

async function unreadCount() {
  const res = await request(pinned.url()).get('/api/comments/unread-count')
  expect(res.status, res.text).toBe(200)
  return res.body.data as { unreadCount: number; mentionUnreadCount: number; count: number }
}

beforeEach(() => {
  vi.clearAllMocks()
  buildWorld()
  installWorldMocks()
})

describe('GET /api/comments/inbox and /unread-count list only readable, live, non-denied comments (#5831 part B)', () => {
  let service: Service

  beforeEach(() => {
    service = buildCommentService()
    pinned.setApp(buildApp(service, { id: READER }))
  })

  it('lists exactly the readable, live, non-denied comments; total and every page agree', async () => {
    const { ids, totals } = await allInboxIds(2)
    expect(ids.sort()).toEqual(['cmt-a1', 'cmt-a2', 'cmt-a3', 'cmt-a4', 'cmt-d1'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(totals)).toEqual(new Set([5]))
    // Page sizes: 2, 2, 1 — nothing comes back short except the last page.
    expect((await inboxPage(2, 0)).items).toHaveLength(2)
    expect((await inboxPage(2, 2)).items).toHaveLength(2)
    expect((await inboxPage(2, 4)).items).toHaveLength(1)
    expect((await inboxPage(2, 6)).items).toHaveLength(0)
  })

  it('never lists a comment on an unreadable, deleted or absent sheet, or on a denied row', async () => {
    const { ids } = await allInboxIds(50)
    for (const hidden of ['cmt-b1', 'cmt-b2', 'cmt-c1', 'cmt-d2', 'cmt-e1', 'cmt-f1', 'cmt-own', 'cmt-a5']) {
      expect(ids, hidden).not.toContain(hidden)
    }
  })

  it('unread-count counts with the same scope: 4 unread, 1 of them mentioning the reader', async () => {
    expect(await unreadCount()).toEqual({ unreadCount: 4, mentionUnreadCount: 1, count: 4 })
    const inboxScope = service.getUnreadSummary.mock.calls[0]![1]
    await inboxPage(50, 0)
    expect(service.getInbox.mock.calls[0]![2]).toEqual(inboxScope)
    expect(inboxScope).toEqual({
      sheetIds: ['sht-readable', 'sht-rowdeny'],
      rowDenySheets: [{ spreadsheetId: 'sht-rowdeny', allowedRowIds: ['row-visible'] }],
    })
  })

  it('every listed item can be marked read through the comment-id gate; afterwards the unread count is 0', async () => {
    const { ids } = await allInboxIds(50)
    for (const id of ids) {
      const res = await request(pinned.url()).post(`/api/comments/${id}/read`)
      expect(res.status, `${id}: ${res.text}`).toBe(204)
    }
    expect(await unreadCount()).toEqual({ unreadCount: 0, mentionUnreadCount: 0, count: 0 })
    // Mentioned items stay listed (read now); nothing new appears.
    const after = await inboxPage(50, 0)
    expect(after.items.map((i) => i.id).sort()).toEqual(['cmt-a2', 'cmt-a4'])
    expect(after.items.every((i) => !i.unread && i.mentioned)).toBe(true)
  })

  it('the items the inbox leaves out are exactly the ones the gate refuses', async () => {
    const statuses: Record<string, number> = {}
    for (const id of ['cmt-b1', 'cmt-c1', 'cmt-d2', 'cmt-e1', 'cmt-f1']) {
      statuses[id] = (await request(pinned.url()).post(`/api/comments/${id}/read`)).status
    }
    // (The world grants no read on the absent sheet, so e1 gets the access 403; a global reader would get 404.)
    expect(statuses).toEqual({ 'cmt-b1': 403, 'cmt-c1': 404, 'cmt-d2': 403, 'cmt-e1': 403, 'cmt-f1': 403 })
    expect(service.markCommentRead).not.toHaveBeenCalled()
  })

  it('the row deny is asked only for sheets that have it on, and only about their candidate rows', async () => {
    await inboxPage(50, 0)
    // The flag: ONE batched query over the readable live set, never the per-sheet helper.
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0]![0]).toMatch(ROW_DENY_FLAG_SQL)
    expect(mocks.query.mock.calls[0]![1]).toEqual([['sht-readable', 'sht-rowdeny']])
    expect(mocks.loadRowLevelReadDenyEnabled).not.toHaveBeenCalled()
    expect(service.listInboxCandidateRowIds.mock.calls).toEqual([[READER, ['sht-rowdeny']]])
    expect(mocks.loadDeniedRecordIds.mock.calls).toEqual([[expect.any(Function), 'sht-rowdeny', READER, ['row-visible', 'row-denied']]])
    // The read rule and the liveness are each computed ONCE for the whole candidate set.
    expect(mocks.loadSheetLivenessBatch).toHaveBeenCalledTimes(1)
    expect(mocks.filterReadableSheetRowsForAccess).toHaveBeenCalledTimes(1)
    const [, rows, access] = mocks.filterReadableSheetRowsForAccess.mock.calls[0]!
    // Deleted and absent sheets never reach the read rule.
    expect((rows as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(['sht-elearning', 'sht-readable', 'sht-rowdeny', 'sht-unreadable'])
    expect(access).toMatchObject({ userId: READER, isAdminRole: false })
  })

  it('no sheet with row deny on → no candidate-row query and no deny lookup', async () => {
    sheets['sht-rowdeny']!.rowDeny = false
    const page = await inboxPage(50, 0)
    expect(page.items.map((i) => i.id)).toContain('cmt-d2')
    expect(service.listInboxCandidateRowIds).not.toHaveBeenCalled()
    expect(mocks.loadDeniedRecordIds).not.toHaveBeenCalled()
    expect(service.getInbox.mock.calls[0]![2]).toEqual({ sheetIds: ['sht-readable', 'sht-rowdeny'], rowDenySheets: [] })
  })

  it('an approval-projection sheet is always a row-deny sheet, as in the single-sheet gate', async () => {
    sheets['sht-rowdeny']!.rowDeny = false
    mocks.query.mockImplementation(async (sqlText: string, params?: unknown[]) => {
      expect(sqlText).toMatch(ROW_DENY_FLAG_SQL)
      return { rows: ((params?.[0] as string[]) ?? []).map((id) => ({ id, enabled: false, base_id: id === 'sht-rowdeny' ? 'base_apr_projection' : null })) }
    })
    const ids = (await inboxPage(50, 0)).items.map((i) => i.id)
    expect(ids).not.toContain('cmt-d2')
    expect(ids).toContain('cmt-d1')
    expect(service.listInboxCandidateRowIds.mock.calls).toEqual([[READER, ['sht-rowdeny']]])
  })

  it('a flag lookup error fails closed (500), never a wider scope', async () => {
    mocks.query.mockRejectedValue(new Error('fake connection lost'))
    const res = await request(pinned.url()).get('/api/comments/inbox')
    expect(res.status).toBe(500)
    expect(service.getInbox).not.toHaveBeenCalled()
  })

  describe('a row-deny sheet admits only the rows the scope checked (fail-closed against the check-then-use race)', () => {
    const lateComment = (row: string, extra: Partial<Comment> = {}) =>
      ({ id: 'cmt-late', sheet: 'sht-rowdeny', row, author: AUTHOR, mentions: [READER], readBy: new Set<string>(), at: 999, ...extra })

    /** A comment lands on `row` right after the candidate rows were read, before the count/page queries. */
    function arriveAfterCandidateLookup(row: string) {
      const original = service.listInboxCandidateRowIds.getMockImplementation()!
      service.listInboxCandidateRowIds.mockImplementationOnce(async (userId: string, sheetIds: readonly string[]) => {
        const out = await original(userId, sheetIds)
        comments.push(lateComment(row))
        return out
      })
    }

    it('a late comment on a DENIED row is not listed or counted, and stays out on the next request too', async () => {
      sheets['sht-rowdeny']!.denied[READER]!.add('row-late')
      arriveAfterCandidateLookup('row-late')
      const page = await inboxPage(50, 0)
      expect(page.items.map((i) => i.id)).not.toContain('cmt-late')
      expect(page.total).toBe(5)
      expect(service.getInbox.mock.calls[0]![2]).toEqual({
        sheetIds: ['sht-readable', 'sht-rowdeny'],
        rowDenySheets: [{ spreadsheetId: 'sht-rowdeny', allowedRowIds: ['row-visible'] }],
      })
      // Next request: the row is a candidate now, gets checked, and is denied.
      expect((await inboxPage(50, 0)).items.map((i) => i.id)).not.toContain('cmt-late')
      expect(await unreadCount()).toEqual({ unreadCount: 4, mentionUnreadCount: 1, count: 4 })
      expect((await request(pinned.url()).post('/api/comments/cmt-late/read')).status).toBe(403)
    })

    it('a late comment on a VISIBLE row is left out of the request that missed it and listed by the next', async () => {
      arriveAfterCandidateLookup('row-late-visible')
      expect((await inboxPage(50, 0)).items.map((i) => i.id)).not.toContain('cmt-late')
      const next = await inboxPage(50, 0)
      expect(next.items.map((i) => i.id)).toContain('cmt-late')
      expect(next.total).toBe(6)
      expect((await request(pinned.url()).post('/api/comments/cmt-late/read')).status).toBe(204)
    })

    it('a row-deny sheet with no candidate row at all admits nothing, even a comment that arrives meanwhile', async () => {
      comments = comments.filter((c) => c.sheet !== 'sht-rowdeny')
      comments.push({ id: 'cmt-d0', sheet: 'sht-rowdeny', row: 'row-visible', author: AUTHOR, mentions: [], readBy: new Set([READER]), at: 50 })
      sheets['sht-rowdeny']!.denied[READER]!.add('row-late')
      // sht-rowdeny is a candidate sheet only through the mention below, which is added AFTER the row lookup.
      service.listInboxCandidateSheetIds.mockResolvedValueOnce(['sht-readable', 'sht-rowdeny'])
      arriveAfterCandidateLookup('row-late')
      const page = await inboxPage(50, 0)
      expect(page.items.map((i) => i.id)).not.toContain('cmt-late')
      expect(service.getInbox.mock.calls[0]![2]).toEqual({
        sheetIds: ['sht-readable', 'sht-rowdeny'],
        rowDenySheets: [{ spreadsheetId: 'sht-rowdeny', allowedRowIds: [] }],
      })
      expect(mocks.loadDeniedRecordIds).not.toHaveBeenCalled()
    })
  })

  it('the identity is the signed-in user; a forged x-user-id changes nothing', async () => {
    const forged = await inboxPage(50, 0, { 'x-user-id': AUTHOR })
    expect(forged.total).toBe(5)
    const identities = new Set([
      ...service.listInboxCandidateSheetIds.mock.calls.map((c) => c[0]),
      ...service.getInbox.mock.calls.map((c) => c[0]),
      ...mocks.loadDeniedRecordIds.mock.calls.map((c) => c[2]),
      ...mocks.filterReadableSheetRowsForAccess.mock.calls.map((c) => (c[2] as { userId: string }).userId),
    ])
    expect(identities).toEqual(new Set([READER]))
  })

  it('a blank signed-in id gets an empty scope and no candidate query', async () => {
    pinned.setApp(buildApp(service, { id: '   ' }))
    expect((await inboxPage(50, 0)).total).toBe(0)
    expect(await unreadCount()).toEqual({ unreadCount: 0, mentionUnreadCount: 0, count: 0 })
    expect(service.listInboxCandidateSheetIds).not.toHaveBeenCalled()
    expect(service.getInbox.mock.calls[0]![2]).toEqual({ sheetIds: [], rowDenySheets: [] })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('without comments:read both routes refuse before any lookup', async () => {
    pinned.setApp(buildApp(service, { id: READER, perms: ['comments:write'] }))
    expect((await request(pinned.url()).get('/api/comments/inbox')).status).toBe(403)
    expect((await request(pinned.url()).get('/api/comments/unread-count')).status).toBe(403)
    expect(service.listInboxCandidateSheetIds).not.toHaveBeenCalled()
  })
})

describe('admins: the same rules as the sheet-addressed routes', () => {
  it('liveness applies, row deny does not, every other sheet is readable; the e-learning check still applies', async () => {
    const service = buildCommentService()
    pinned.setApp(buildApp(service, { id: ADMIN, admin: true }))
    const page = await inboxPage(50, 0)
    // Everything is unread for the admin; the deleted (c1), absent (e1) and e-learning (f1) sheets are out.
    expect(page.items.map((i) => i.id).sort()).toEqual([
      'cmt-a1', 'cmt-a2', 'cmt-a3', 'cmt-a4', 'cmt-a5', 'cmt-b1', 'cmt-b2', 'cmt-d1', 'cmt-d2', 'cmt-own',
    ])
    expect(page.total).toBe(10)
    expect(mocks.loadRowLevelReadDenyEnabled).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.loadDeniedRecordIds).not.toHaveBeenCalled()
    expect(service.getInbox.mock.calls[0]![2]).toMatchObject({ rowDenySheets: [] })
    expect(mocks.canAccessElearningProjectionSheet).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ADMIN, isAdminRole: true }), 'sht-elearning', 'org-fake')

    // Every item an admin sees can be marked read, and the e-learning sheet appears once the gate allows it.
    for (const item of page.items) {
      expect((await request(pinned.url()).post(`/api/comments/${item.id}/read`)).status, item.id).toBe(204)
    }
    elearningAccess = true
    expect((await inboxPage(50, 0)).items.map((i) => i.id)).toContain('cmt-f1')
    expect((await request(pinned.url()).post('/api/comments/cmt-f1/read')).status).toBe(204)
  })
})

describe('POST /api/multitable/:sheetId/comments/mark-all-read writes only the signed-in user’s read state (#5840)', () => {
  const OTHER_USER_FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN', message: 'Comments can only be marked read for the signed-in user' } }
  const readState = (userId: string) => comments.filter((c) => c.readBy.has(userId)).map((c) => c.id).sort()

  it('a body userId naming someone else is refused, and that user’s read state is untouched', async () => {
    sheets['sht-readable']!.readers.add(BYSTANDER)
    const service = buildCommentService()
    pinned.setApp(buildApp(service, { id: READER }))
    const bystanderBefore = readState(BYSTANDER)
    const readerBefore = readState(READER)
    const res = await request(pinned.url())
      .post('/api/multitable/sht-readable/comments/mark-all-read')
      .send({ userId: BYSTANDER })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(OTHER_USER_FORBIDDEN)
    expect(JSON.stringify(res.body)).not.toContain(BYSTANDER)
    expect(service.markAllCommentsRead).not.toHaveBeenCalled()
    expect(readState(BYSTANDER)).toEqual(bystanderBefore)
    expect(readState(READER)).toEqual(readerBefore)
  })

  it('no body userId, or the caller’s own id (padded or not), marks the caller’s comments read', async () => {
    for (const body of [{}, { userId: READER }, { userId: `  ${READER} ` }]) {
      buildWorld()
      installWorldMocks()
      const service = buildCommentService()
      pinned.setApp(buildApp(service, { id: READER }))
      const res = await request(pinned.url()).post('/api/multitable/sht-readable/comments/mark-all-read').send(body)
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(res.body.data.markedRead).toBe(3)
      expect(service.markAllCommentsRead).toHaveBeenCalledWith('sht-readable', READER, [])
      expect(readState(READER)).toEqual(['cmt-a1', 'cmt-a2', 'cmt-a3', 'cmt-a4', 'cmt-a5'])
      expect(readState(BYSTANDER)).toEqual([])
    }
  })

  it('the sheet gate still answers first: an unreadable sheet gets the access 403, a deleted one 404', async () => {
    const service = buildCommentService()
    pinned.setApp(buildApp(service, { id: READER }))
    const unreadable = await request(pinned.url()).post('/api/multitable/sht-unreadable/comments/mark-all-read').send({ userId: BYSTANDER })
    expect(unreadable.status).toBe(403)
    expect(unreadable.body.error.message).toBe('Not permitted to access comments on this sheet')
    const deleted = await request(pinned.url()).post('/api/multitable/sht-deleted/comments/mark-all-read').send({})
    expect(deleted.status).toBe(404)
    expect(service.markAllCommentsRead).not.toHaveBeenCalled()
  })

  it('the row deny applied is the caller’s own, which is now also whose state is written', async () => {
    const service = buildCommentService()
    pinned.setApp(buildApp(service, { id: READER }))
    const res = await request(pinned.url()).post('/api/multitable/sht-rowdeny/comments/mark-all-read').send({ userId: READER })
    expect(res.status).toBe(200)
    expect(service.markAllCommentsRead).toHaveBeenCalledWith('sht-rowdeny', READER, ['row-denied'])
    expect(readState(READER)).toEqual(['cmt-a4', 'cmt-a5', 'cmt-d1'])
  })
})
