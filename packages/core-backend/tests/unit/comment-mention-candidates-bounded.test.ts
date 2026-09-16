/**
 * #5795 — the comment @-mention candidate reads are BOUNDED, not re-scoped.
 *
 * What was wrong: GET /api/comments/mention-candidates sits behind rbacGuard('comments','read') (a
 * code the comment-permissions migration seeds onto the generic `user` role) plus the G-8 sheet-read
 * gate, and CommentService.listMentionCandidates answered a TERM-LESS call with the first 100 active
 * users of the whole deployment (label + email subtitle) plus `total` = the deployment-wide active-user
 * count. GET /api/multitable/:spreadsheetId/mention-candidates reads the same service behind the same
 * gate. That is a wider set behind a weaker gate than the person-field directory #5781 bounded.
 *
 * What this suite pins (bounds only — who is eligible is deliberately unchanged):
 *   §1 no term ⇒ empty list + `requiresQuery` marker, and ZERO hydration (service never called)
 *   §2 a term ⇒ at most MENTION_CANDIDATES_MAX_ITEMS items, `hasMore: true` when clamped
 *   §3 the service is asked for at most ceiling+1 rows (the clamp sits BELOW the hydration)
 *   §4 eligibility unchanged: a user the service returns for a matching term is still returned, and
 *      the pre-existing gates (G-8 sheet read) still answer first
 *   §5 the deployment-wide count is no longer disclosed: `total` is the clamped page size
 *   §6 the sibling /api/multitable/:spreadsheetId/mention-candidates route carries the same bounds
 *   §7 the term is NOT a narrowing guarantee: a one-character term every row contains (`-` is in every
 *      UUID-shaped id, `@` in every email) matches the whole set, so the ceiling is the only per-request
 *      bound against a deliberate caller — it must hold for exactly those terms
 *
 * The service is mocked here; the service's own SQL bound (LIMIT, escaped term, no COUNT) is pinned in
 * tests/unit/comment-service.test.ts. Fixtures are obviously fake (example.invalid). TRANSPORT: one
 * pinned listener + request(url()) — `request(app)` app-mode is banned (#4154 tripwire).
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
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  // getInternalPool: read at load time by src/db/pg.ts (routes/comments.ts -> multitable/access -> rbac/service).
  poolManager: { get: () => ({ query: mocks.query, getInternalPool: () => null }) },
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
import {
  MENTION_CANDIDATES_MAX_ITEMS as MAX_ITEMS,
  MENTION_CANDIDATES_MIN_QUERY_LENGTH as MIN_QUERY_LENGTH,
} from '../../src/services/comment-mention-bounds'

/** A deployment-wide population number the PRE-#5795 service used to hand back as `total`. The mock
 *  keeps returning it so a regression that re-plumbs `result.total` to the wire is caught. */
const DEPLOYMENT_POPULATION = 4321

interface MentionCall {
  spreadsheetId: string
  options: { q?: string; limit?: number } | undefined
}

/** Obviously fake candidates — never real user data. */
function fakeCandidates(count: number, prefix = 'u') {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    label: `Fake Person ${i + 1}`,
    subtitle: `fake.person${i + 1}@example.invalid`,
  }))
}

let calls: MentionCall[] = []
let candidateRows: Array<{ id: string; label: string; subtitle?: string }> = []

function buildCommentService() {
  return {
    listMentionCandidates: vi.fn(async (spreadsheetId: string, options?: { q?: string; limit?: number }) => {
      calls.push({ spreadsheetId, options })
      // Mirror the real service's SQL LIMIT: never more than `limit` rows come back.
      const limit = options?.limit
      const items = typeof limit === 'number' ? candidateRows.slice(0, limit) : candidateRows
      return { items, total: DEPLOYMENT_POPULATION }
    }),
    getComments: vi.fn(),
    getInbox: vi.fn(),
    getUnreadSummary: vi.fn(),
    getMentionSummary: vi.fn(),
    getCommentPresenceSummary: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    markCommentRead: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    markMentionsRead: vi.fn(),
    resolveComment: vi.fn(),
    markAllCommentsRead: vi.fn(),
    getCommentPresenceSummaryWithViewers: vi.fn(),
    setCommentTargetReadChecker: vi.fn(),
  }
}

function buildApp(commentService: ReturnType<typeof buildCommentService>): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = {
      id: 'actor_plain_user',
      roles: ['user'],
      perms: ['comments:read'],
      permissions: ['comments:read'],
    }
    next()
  })
  app.use(commentsRouter({ get: () => commentService } as any))
  return app
}

const pinned = usePinnedServer()
const SHEET = 'sheet_mentions'
const mainUrl = '/api/comments/mention-candidates'
const nsUrl = `/api/multitable/${SHEET}/mention-candidates`

describe('#5795 comment mention candidates — bounded disclosure', () => {
  let service: ReturnType<typeof buildCommentService>

  beforeEach(() => {
    vi.clearAllMocks()
    calls = []
    candidateRows = fakeCandidates(3)
    mocks.resolveSheetReadableCapabilities.mockResolvedValue({
      access: { userId: 'actor_plain_user', isAdminRole: false },
      capabilities: { canRead: true },
      sheetLiveness: 'live',
    })
    mocks.loadRowLevelReadDenyEnabled.mockResolvedValue(false)
    mocks.loadDeniedRecordIds.mockResolvedValue(new Set())
    service = buildCommentService()
    pinned.setApp(buildApp(service))
  })

  describe('§1 a term-less call discloses nothing', () => {
    it('no q ⇒ empty list + requiresQuery marker, and the service is never asked', async () => {
      candidateRows = fakeCandidates(500) // the whole "roster" is available — and must not ship

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.error).toBeUndefined()
      expect(res.body.data.items).toEqual([])
      expect(res.body.data.total).toBe(0)
      expect(res.body.data.requiresQuery).toBe(true)
      expect(res.body.data.minQueryLength).toBe(MIN_QUERY_LENGTH)
      expect(res.body.data.hasMore).toBe(false)
      expect(res.body.data.query).toBe('')
      // ZERO hydration: no name/email lookup was even issued for this call.
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
      const body = JSON.stringify(res.body)
      expect(body).not.toContain('Fake Person')
      expect(body).not.toContain('example.invalid')
      expect(body).not.toContain(String(DEPLOYMENT_POPULATION))
    })

    it('whitespace-only q and an explicit large limit are still treated as no term', async () => {
      candidateRows = fakeCandidates(500)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: '   ', limit: '200' })

      expect(res.status).toBe(200)
      expect(res.body.data.items).toEqual([])
      expect(res.body.data.requiresQuery).toBe(true)
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
    })

    it('the term-less short-circuit sits AFTER the G-8 sheet-read gate (no-read actor still gets 403)', async () => {
      mocks.resolveSheetReadableCapabilities.mockResolvedValue({
        access: { userId: 'actor_plain_user', isAdminRole: false },
        capabilities: { canRead: false },
        sheetLiveness: 'live',
      })

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET })

      expect(res.status).toBe(403)
      expect(res.body.data).toBeUndefined()
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
    })

    it('spreadsheetId is still required (pre-existing validation untouched)', async () => {
      const res = await request(pinned.url()).get(mainUrl).query({ q: 'fake' })
      expect(res.status).toBe(400)
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
    })
  })

  describe('§2 the ceiling', () => {
    it('clamps to MENTION_CANDIDATES_MAX_ITEMS and reports hasMore when the ceiling is hit', async () => {
      candidateRows = fakeCandidates(400)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake' })

      expect(res.status).toBe(200)
      expect(MAX_ITEMS).toBe(50) // same ceiling as #5781's person directory and /permission-candidates
      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.limit).toBe(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
      expect(res.body.data.requiresQuery).toBe(false)
      expect(res.body.data.query).toBe('fake')
    })

    it('a requested limit above the ceiling is clamped to it (the old route allowed 200, the service 100)', async () => {
      candidateRows = fakeCandidates(400)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake', limit: '200' })

      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.limit).toBe(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
    })

    it('a smaller requested limit is honoured, with hasMore when more matched', async () => {
      candidateRows = fakeCandidates(30)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake', limit: '10' })

      expect(res.body.data.items).toHaveLength(10)
      expect(res.body.data.limit).toBe(10)
      expect(res.body.data.hasMore).toBe(true)
    })

    it('exactly-at-the-ceiling is NOT reported as truncated', async () => {
      candidateRows = fakeCandidates(50)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake' })

      expect(res.body.data.items).toHaveLength(50)
      expect(res.body.data.hasMore).toBe(false)
    })
  })

  describe('§3 the clamp is below the hydration, not above it', () => {
    it('never asks the service for more than the ceiling + 1 rows', async () => {
      candidateRows = fakeCandidates(400)

      await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake', limit: '200' })

      expect(calls).toHaveLength(1)
      expect(calls[0].options?.limit).toBe(MAX_ITEMS + 1)
    })

    it('passes the trimmed term (not the raw one) down to the service', async () => {
      await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: '  fake  ' })

      expect(calls[0].options?.q).toBe('fake')
    })
  })

  describe('§4 eligibility is UNCHANGED (this fix bounds disclosure only)', () => {
    it('a user the service returns for a matching term is still returned, untouched', async () => {
      candidateRows = [{ id: 'u_still_eligible', label: 'Fake Eligible', subtitle: 'fake.eligible@example.invalid' }]

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'Fake' })

      expect(res.body.data.items).toEqual([
        { id: 'u_still_eligible', label: 'Fake Eligible', subtitle: 'fake.eligible@example.invalid' },
      ])
      expect(calls[0].spreadsheetId).toBe(SHEET)
    })

    it('a single character is an acceptable term', async () => {
      candidateRows = fakeCandidates(2)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'f' })

      expect(res.body.data.requiresQuery).toBe(false)
      expect(res.body.data.items).toHaveLength(2)
      expect(calls).toHaveLength(1)
    })
  })

  describe('§5 the deployment-wide count is no longer disclosed', () => {
    it('total is the size of the returned (clamped) page, never the population the service knows', async () => {
      candidateRows = fakeCandidates(3)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake' })

      expect(res.body.data.total).toBe(3)
      expect(res.body.data.total).toBe(res.body.data.items.length)
      expect(JSON.stringify(res.body)).not.toContain(String(DEPLOYMENT_POPULATION))
    })

    it('a clamped answer reports the page size, not how many matched', async () => {
      candidateRows = fakeCandidates(400)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake' })

      expect(res.body.data.total).toBe(MAX_ITEMS)
      expect(JSON.stringify(res.body)).not.toContain('"total":400')
      expect(JSON.stringify(res.body)).not.toContain(String(DEPLOYMENT_POPULATION))
    })
  })

  describe('§6 /api/multitable/:spreadsheetId/mention-candidates carries the same bounds', () => {
    it('no q ⇒ empty + requiresQuery, service never asked', async () => {
      candidateRows = fakeCandidates(500)

      const res = await request(pinned.url()).get(nsUrl)

      expect(res.status).toBe(200)
      expect(res.body.data.items).toEqual([])
      expect(res.body.data.requiresQuery).toBe(true)
      expect(res.body.data.minQueryLength).toBe(MIN_QUERY_LENGTH)
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
      expect(JSON.stringify(res.body)).not.toContain('Fake Person')
    })

    it('a term ⇒ clamped to the ceiling with hasMore, service asked for ceiling + 1 at most', async () => {
      candidateRows = fakeCandidates(400)

      const res = await request(pinned.url()).get(nsUrl).query({ q: 'fake', limit: '200' })

      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
      expect(res.body.data.requiresQuery).toBe(false)
      expect(calls[0].options?.limit).toBe(MAX_ITEMS + 1)
      // shape of this route is unchanged apart from the additive markers
      expect(res.body.data.items[0]).toEqual({ userId: 'u1', displayName: 'Fake Person 1' })
      expect(JSON.stringify(res.body)).not.toContain(String(DEPLOYMENT_POPULATION))
    })

    it('keeps its composer-sized default of 10', async () => {
      candidateRows = fakeCandidates(30)

      const res = await request(pinned.url()).get(nsUrl).query({ q: 'fake' })

      expect(res.body.data.items).toHaveLength(10)
      expect(res.body.data.hasMore).toBe(true)
      expect(calls[0].options?.limit).toBe(11)
    })

    it('still answers the G-8 gate first', async () => {
      mocks.resolveSheetReadableCapabilities.mockResolvedValue({
        access: { userId: 'actor_plain_user', isAdminRole: false },
        capabilities: { canRead: false },
        sheetLiveness: 'live',
      })

      const res = await request(pinned.url()).get(nsUrl)

      expect(res.status).toBe(403)
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
    })
  })

  describe('§7 a term that matches everyone is still capped (the ceiling, not the term, is the bound)', () => {
    for (const universal of ['-', '@']) {
      it(`q=${universal} (a character every row contains) is passed through and answered with at most the ceiling`, async () => {
        candidateRows = fakeCandidates(400) // the service matches the whole set for such a term

        const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: universal, limit: '200' })
        const ns = await request(pinned.url()).get(nsUrl).query({ q: universal, limit: '200' })

        expect(res.status).toBe(200)
        expect(res.body.data.requiresQuery).toBe(false)
        expect(res.body.data.query).toBe(universal)
        expect(res.body.data.items).toHaveLength(MAX_ITEMS)
        expect(res.body.data.hasMore).toBe(true)
        expect(ns.body.data.items).toHaveLength(MAX_ITEMS)
        expect(ns.body.data.hasMore).toBe(true)
        expect(calls.map((call) => call.options)).toEqual([
          { q: universal, limit: MAX_ITEMS + 1 },
          { q: universal, limit: MAX_ITEMS + 1 },
        ])
      })
    }
  })

  // §8 — #5809: `?match=exact-email` (the legacy person importer's email-owner lookup) only changes the
  // predicate the service applies; the gate, the term requirement and the ceiling are the same.
  describe('§8 #5809 opt-in email equality (?match=exact-email)', () => {
    it('forwards match: exact-email under the same ceiling', async () => {
      candidateRows = fakeCandidates(1)

      const res = await request(pinned.url()).get(mainUrl).query({
        spreadsheetId: SHEET, q: ' fake.person1@example.invalid ', limit: '50', match: 'exact-email',
      })

      expect(res.status).toBe(200)
      expect(res.body.data.items).toEqual(fakeCandidates(1))
      expect(res.body.data.hasMore).toBe(false)
      expect(calls.map((call) => call.options)).toEqual([
        { q: 'fake.person1@example.invalid', limit: MAX_ITEMS + 1, match: 'exact-email' },
      ])
    })

    it('still clamps: more rows than the ceiling ⇒ 50 items + hasMore', async () => {
      candidateRows = fakeCandidates(400)

      const res = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'x@example.invalid', limit: '200', match: 'exact-email' })

      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
      expect(calls[0].options?.limit).toBe(MAX_ITEMS + 1)
    })

    it('still requires a term and still answers the G-8 gate first', async () => {
      const blank = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, match: 'exact-email' })
      expect(blank.status).toBe(200)
      expect(blank.body.data.requiresQuery).toBe(true)
      expect(service.listMentionCandidates).not.toHaveBeenCalled()

      mocks.resolveSheetReadableCapabilities.mockResolvedValue({
        access: { userId: 'actor_plain_user', isAdminRole: false },
        capabilities: { canRead: false },
        sheetLiveness: 'live',
      })
      const denied = await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'x@example.invalid', match: 'exact-email' })
      expect(denied.status).toBe(403)
      expect(service.listMentionCandidates).not.toHaveBeenCalled()
    })

    it('any other match value, and the namespaced sibling route, keep the substring search', async () => {
      await request(pinned.url()).get(mainUrl).query({ spreadsheetId: SHEET, q: 'fake', match: 'exact' })
      await request(pinned.url()).get(nsUrl).query({ q: 'fake', match: 'exact-email' })

      expect(calls.map((call) => call.options)).toEqual([
        { q: 'fake', limit: MAX_ITEMS + 1 },
        { q: 'fake', limit: 11 },
      ])
    })
  })
})
