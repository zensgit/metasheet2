/**
 * #5795 follow-up — GET /api/multitable/sheets/:sheetId/form-share-candidates is BOUNDED, not re-scoped.
 *
 * What was wrong: the route is gated on canManageFormShareForSheet → capabilities.canManageViews, which a
 * sheet-level FULL-WRITE grant alone turns on (applyContextSheetSchemaWriteGrant). It reads the same
 * listSheetPermissionCandidates roster as the #5781 person directory and answered a TERM-LESS call with
 * 20-50 users + member groups (name + email + DingTalk-binding flags). It was already clamped to 50;
 * what it lacked was "must supply a term".
 *
 * What this suite pins (bounds only — eligibility is deliberately unchanged):
 *   §1 no term ⇒ empty list + `requiresQuery`, and ZERO hydration (neither the roster read nor the
 *      DingTalk enrichment runs), placed AFTER the existing 404 / permission gates
 *   §2 a term ⇒ the existing clamp (≤ 50, default 20) with `hasMore` when more matched
 *   §3 the roster read is asked for at most ceiling + 1 rows (clamp below the name/email hydration),
 *      the enrichment only sees the returned page, and the term is handed down as a LITERAL substring
 *   §4 eligibility unchanged: whatever the roster read returns for a matching term (users + member
 *      groups, roles still dropped) is still returned, with the same DingTalk fields
 *
 * Fixtures are obviously fake (example.invalid). TRANSPORT: one pinned listener + request(url()) —
 * `request(app)` app-mode is banned by tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import {
  MENTION_CANDIDATES_MAX_ITEMS,
  MENTION_CANDIDATES_MIN_QUERY_LENGTH,
} from '../../src/services/comment-mention-bounds'

const SHEET_ID = 'sheet_form_share'
const BASE_ID = 'base_form_share'

type QueryResult = { rows: any[]; rowCount?: number }
type Candidate = {
  subjectType: 'user' | 'member-group' | 'role'
  subjectId: string
  label: string
  subtitle: string | null
  isActive: boolean
  accessLevel: null
}

interface RosterCall {
  sheetId: string
  params: { q?: string; limit: number }
}

/** Obviously fake roster rows — never real user data. */
function fakeUsers(count: number, prefix = 'u'): Candidate[] {
  return Array.from({ length: count }, (_, i) => ({
    subjectType: 'user',
    subjectId: `${prefix}${i + 1}`,
    label: `Fake Person ${i + 1}`,
    subtitle: `fake.person${i + 1}@example.invalid`,
    isActive: true,
    accessLevel: null,
  }))
}

const pinned = usePinnedServer()

let rosterCalls: RosterCall[] = []
let enrichCalls: Candidate[][] = []
let rosterRows: Candidate[] = []
let MAX_ITEMS = 0
let MIN_QUERY_LENGTH = 0
let PERSON_MAX = 0
let PERSON_MIN = 0
let PERMISSION_CANDIDATES_MAX = 0

async function buildApp(opts?: { sheetAccess?: string; sheetExists?: boolean }): Promise<Express> {
  vi.resetModules()
  rosterCalls = []
  enrichCalls = []

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  // Mock ONLY the roster read + the DingTalk enrichment; capability resolution stays real, so the
  // canManageViews gate is exercised exactly as in production.
  vi.doMock('../../src/multitable/permission-service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/multitable/permission-service')>()
    return {
      ...actual,
      listSheetPermissionCandidates: vi.fn(async (_query: unknown, sheetId: string, params: { q?: string; limit: number }) => {
        rosterCalls.push({ sheetId, params })
        // Mirror the real SQL LIMIT: never more than `limit` rows come back.
        return rosterRows.slice(0, params.limit)
      }),
      enrichFormShareCandidatesWithDingTalkStatus: vi.fn(async (_query: unknown, candidates: Candidate[]) => {
        enrichCalls.push(candidates)
        return candidates.map((candidate) => candidate.subjectType === 'user'
          ? { ...candidate, dingtalkBound: true, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: true }
          : { ...candidate, dingtalkBound: null, dingtalkGrantEnabled: null, dingtalkPersonDeliveryAvailable: null })
      }),
    }
  })

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const univerMeta = await import('../../src/routes/univer-meta')
  MAX_ITEMS = univerMeta.FORM_SHARE_CANDIDATES_MAX_ITEMS
  MIN_QUERY_LENGTH = univerMeta.FORM_SHARE_CANDIDATES_MIN_QUERY_LENGTH
  PERSON_MAX = univerMeta.PERSON_DIRECTORY_MAX_ITEMS
  PERSON_MIN = univerMeta.PERSON_DIRECTORY_MIN_QUERY_LENGTH
  PERMISSION_CANDIDATES_MAX = univerMeta.PERMISSION_CANDIDATES_MAX_ITEMS

  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<QueryResult> => {
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ deleted_at: null }], rowCount: 1 }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1') && sql.includes('base_id')) {
      if (opts?.sheetExists === false) return { rows: [] }
      return { rows: [{ id: SHEET_ID, base_id: BASE_ID, name: 'Share', description: null }] }
    }
    // Sheet-scoped grant: full write on THIS sheet (no global multitable:write) ⇒ canManageViews via
    // applyContextSheetSchemaWriteGrant — the actor shape the route is open to.
    if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
      return { rows: [{ sheet_id: SHEET_ID, perm_code: opts?.sheetAccess ?? 'spreadsheet:write', subject_type: 'user' }] }
    }
    return { rows: [] }
  })
  const pool = { query, transaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: 'user_sheet_writer_1', roles: [], perms: ['multitable:read'] }
    next()
  })
  app.use('/api/multitable', univerMeta.univerMetaRouter())
  return app
}

const url = `/api/multitable/sheets/${SHEET_ID}/form-share-candidates`

describe('#5795 form-share candidates — bounded disclosure', () => {
  beforeEach(() => {
    rosterRows = fakeUsers(3)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe('§1 a term-less call discloses nothing', () => {
    it('no q ⇒ empty list + requiresQuery marker, and neither the roster nor DingTalk status is read', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(500)

      const res = await request(pinned.url()).get(url)

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.error).toBeUndefined()
      expect(res.body.data).toEqual({
        items: [],
        total: 0,
        limit: 20,
        query: '',
        hasMore: false,
        requiresQuery: true,
        minQueryLength: MIN_QUERY_LENGTH,
      })
      expect(rosterCalls).toHaveLength(0)
      expect(enrichCalls).toHaveLength(0)
      const body = JSON.stringify(res.body)
      expect(body).not.toContain('Fake Person')
      expect(body).not.toContain('example.invalid')
      expect(body).not.toContain('dingtalk')
    })

    it('whitespace-only q with the maximum limit is still no term', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(500)

      const res = await request(pinned.url()).get(`${url}?q=%20%20&limit=50`)

      expect(res.status).toBe(200)
      expect(res.body.data.items).toEqual([])
      expect(res.body.data.requiresQuery).toBe(true)
      expect(res.body.data.limit).toBe(50)
      expect(rosterCalls).toHaveLength(0)
      expect(enrichCalls).toHaveLength(0)
    })

    it('the short-circuit sits AFTER the permission gate (read-only actor still 403, nothing read)', async () => {
      pinned.setApp(await buildApp({ sheetAccess: 'spreadsheet:read' }))

      const res = await request(pinned.url()).get(url)

      expect(res.status).toBe(403)
      expect(res.body.data).toBeUndefined()
      expect(rosterCalls).toHaveLength(0)
    })

    it('the short-circuit sits AFTER the sheet 404', async () => {
      pinned.setApp(await buildApp({ sheetExists: false }))

      const res = await request(pinned.url()).get(url)

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })
  })

  describe('§2 the ceiling (unchanged) now reports truncation', () => {
    it('uses the same bounds as the #5781 person directory', async () => {
      pinned.setApp(await buildApp())
      expect(MAX_ITEMS).toBe(50)
      expect(MAX_ITEMS).toBe(PERSON_MAX)
      expect(MIN_QUERY_LENGTH).toBe(PERSON_MIN)
    })

    // Refuter round (#5795 nit): the comment @-mention bounds are separate literals in a service module
    // (it must not import this route file), so only this assertion keeps the roster-shaped reads on one
    // volume: move PERSON_DIRECTORY_* and this fails until the mention pair moves with it.
    it('the comment @-mention bounds equal the person-directory bounds (separate literals, pinned here)', async () => {
      pinned.setApp(await buildApp())
      expect(MENTION_CANDIDATES_MAX_ITEMS).toBe(PERSON_MAX)
      expect(MENTION_CANDIDATES_MIN_QUERY_LENGTH).toBe(PERSON_MIN)
    })

    it('/permission-candidates clamps to the same shared ceiling (no private literal)', async () => {
      pinned.setApp(await buildApp({ sheetAccess: 'spreadsheet:admin' }))
      rosterRows = fakeUsers(400)

      const res = await request(pinned.url()).get(`/api/multitable/sheets/${SHEET_ID}/permission-candidates?q=fake&limit=500`)

      expect(res.status).toBe(200)
      expect(PERMISSION_CANDIDATES_MAX).toBe(PERSON_MAX)
      expect(rosterCalls).toHaveLength(1)
      expect(rosterCalls[0].params.limit).toBe(PERSON_MAX)
      expect(res.body.data.limit).toBe(PERSON_MAX)
      expect(res.body.data.items).toHaveLength(PERSON_MAX)
    })

    // Refuter round (#5795): the route already had this cap before the term requirement, and a
    // one-character term every row contains (`-` in every UUID-shaped id, `@` in every email) matches the
    // whole roster — so the cap, not the term, is what a deliberate caller runs into.
    for (const universal of ['-', '@']) {
      it(`q=${universal} (a character every row contains) is still answered with at most the ceiling`, async () => {
        pinned.setApp(await buildApp())
        rosterRows = fakeUsers(400)

        const res = await request(pinned.url()).get(`${url}?q=${encodeURIComponent(universal)}&limit=500`)

        expect(res.status).toBe(200)
        expect(res.body.data.requiresQuery).toBe(false)
        expect(res.body.data.items).toHaveLength(MAX_ITEMS)
        expect(res.body.data.hasMore).toBe(true)
        expect(rosterCalls).toEqual([{ sheetId: SHEET_ID, params: { q: universal, limit: MAX_ITEMS + 1 } }])
        expect(enrichCalls).toHaveLength(1)
        expect(enrichCalls[0]).toHaveLength(MAX_ITEMS)
      })
    }

    it('clamps an over-large limit to 50 and reports hasMore', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(400)

      const res = await request(pinned.url()).get(`${url}?q=fake&limit=500`)

      expect(res.status).toBe(200)
      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.total).toBe(MAX_ITEMS)
      expect(res.body.data.limit).toBe(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
      expect(res.body.data.requiresQuery).toBe(false)
      expect(res.body.data.query).toBe('fake')
    })

    it('keeps the default page of 20, with hasMore when more matched', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(30)

      const res = await request(pinned.url()).get(`${url}?q=fake`)

      expect(res.body.data.items).toHaveLength(20)
      expect(res.body.data.limit).toBe(20)
      expect(res.body.data.hasMore).toBe(true)
    })

    it('exactly-at-the-limit is NOT reported as truncated', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(8)

      const res = await request(pinned.url()).get(`${url}?q=fake&limit=8`)

      expect(res.body.data.items).toHaveLength(8)
      expect(res.body.data.hasMore).toBe(false)
    })
  })

  describe('§3 the clamp is below the hydration and the term is literal', () => {
    it('asks the roster read for at most ceiling + 1 rows, and enriches only the returned page', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(400)

      await request(pinned.url()).get(`${url}?q=fake&limit=500`)

      expect(rosterCalls).toHaveLength(1)
      expect(rosterCalls[0].params.limit).toBe(MAX_ITEMS + 1)
      expect(enrichCalls).toHaveLength(1)
      expect(enrichCalls[0]).toHaveLength(MAX_ITEMS)
    })

    it('passes the trimmed term down', async () => {
      pinned.setApp(await buildApp())
      await request(pinned.url()).get(`${url}?q=%20fake%20`)
      expect(rosterCalls[0].params.q).toBe('fake')
    })

    it('escapes LIKE metacharacters so `%` / `_` cannot stand in for "everyone"', async () => {
      pinned.setApp(await buildApp())

      await request(pinned.url()).get(`${url}?q=%25`)
      await request(pinned.url()).get(`${url}?q=a_b%5C`)

      expect(rosterCalls.map((call) => call.params.q)).toEqual(['\\%', 'a\\_b\\\\'])
    })

    it('echoes the term as typed (unescaped)', async () => {
      pinned.setApp(await buildApp())
      const res = await request(pinned.url()).get(`${url}?q=50%25`)
      expect(res.body.data.query).toBe('50%')
    })
  })

  describe('§4 eligibility is UNCHANGED', () => {
    it('users and member groups the roster read returns for a term are still returned; roles still dropped', async () => {
      pinned.setApp(await buildApp())
      rosterRows = [
        { subjectType: 'user', subjectId: 'u_still_eligible', label: 'Fake Eligible', subtitle: 'fake.eligible@example.invalid', isActive: true, accessLevel: null },
        { subjectType: 'member-group', subjectId: 'grp_fake', label: 'Fake Group', subtitle: '3 members', isActive: true, accessLevel: null },
        { subjectType: 'role', subjectId: 'role_fake', label: 'Fake Role', subtitle: 'Role', isActive: true, accessLevel: null },
      ]

      const res = await request(pinned.url()).get(`${url}?q=Fake`)

      expect(res.body.data.items).toEqual([
        {
          subjectType: 'user',
          subjectId: 'u_still_eligible',
          label: 'Fake Eligible',
          subtitle: 'fake.eligible@example.invalid',
          isActive: true,
          accessLevel: null,
          dingtalkBound: true,
          dingtalkGrantEnabled: false,
          dingtalkPersonDeliveryAvailable: true,
        },
        {
          subjectType: 'member-group',
          subjectId: 'grp_fake',
          label: 'Fake Group',
          subtitle: '3 members',
          isActive: true,
          accessLevel: null,
          dingtalkBound: null,
          dingtalkGrantEnabled: null,
          dingtalkPersonDeliveryAvailable: null,
        },
      ])
      expect(res.body.data.hasMore).toBe(false)
      expect(rosterCalls[0].sheetId).toBe(SHEET_ID)
    })

    it('a single character is an acceptable term (the automation pickers search per keystroke)', async () => {
      pinned.setApp(await buildApp())
      rosterRows = fakeUsers(2)

      const res = await request(pinned.url()).get(`${url}?q=f&limit=8`)

      expect(res.body.data.requiresQuery).toBe(false)
      expect(res.body.data.items).toHaveLength(2)
      expect(rosterCalls).toHaveLength(1)
    })

    it('a sheet full-write holder (no global write) still passes the gate with a term', async () => {
      pinned.setApp(await buildApp({ sheetAccess: 'spreadsheet:write' }))
      const res = await request(pinned.url()).get(`${url}?q=fake`)
      expect(res.status).toBe(200)
      expect(rosterCalls).toHaveLength(1)
    })
  })
})
