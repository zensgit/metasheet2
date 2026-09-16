/**
 * #5781 — GET /sheets/:sheetId/person-fields/:fieldId/directory is BOUNDED, not re-scoped.
 *
 * What was wrong: the route is gated on canEditRecord only (the sibling /permission-candidates in the
 * same file requires canManageSheetAccess), and the set it hydrates comes from
 * loadSheetMemberUserIdSet → listSheetPermissionCandidates, whose `user_candidates` CTE carries the
 * sheet id ONLY in the LEFT JOIN ON clause — so the "sheet members" it returns are really every active
 * user in the deployment holding multitable read/write. With NO search term and NO limit, one call by
 * any editor of any sheet returned that whole roster as id + name + email.
 *
 * What this suite pins (bounds only — eligibility is deliberately unchanged, see the route comment):
 *   §1 no search term ⇒ empty list + the `requiresQuery` marker, and ZERO hydration (the directory
 *      resolver is never even called, so no name/email leaves the users table)
 *   §2 a search term ⇒ at most PERSON_DIRECTORY_MAX_ITEMS items, `hasMore: true` when clamped
 *   §3 the hydration is asked for at most ceiling+1 rows (clamp lives BELOW the hydration, not above it)
 *   §4 eligibility unchanged: the route still resolves the field's restrict groups through the
 *      CANONICAL write-validator resolver (4th arg left undefined) and a user who was eligible before
 *      is still returned for a matching term
 *   §5 the term requirement is scoped to the branch that actually leaks: a field with
 *      restrictToMemberGroupIds resolves to (sheet members ∩ configured groups) — a strictly narrower,
 *      deliberately configured set — so it KEEPS its term-less browse (still clamped by the ceiling),
 *      while the unrestricted (deployment-wide) branch still requires a term
 *
 * Fixtures are obviously fake (fake.invalid). TRANSPORT: one pinned listener per file + request(url())
 * — `request(app)` app-mode is banned by tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_person_dir'
const BASE_ID = 'base_person_dir'
const FIELD_ID = 'fld_owner'
const TEXT_FIELD_ID = 'fld_title'

type QueryResult = { rows: any[]; rowCount?: number }

interface DirectoryCall {
  sheetId: string
  restrictGroupIds: string[]
  resolveAllowed: unknown
  options: { search?: string; limit?: number } | undefined
}

/** Obviously fake directory rows — never real user data. */
function fakeDirectory(count: number, prefix = 'u') {
  return Array.from({ length: count }, (_, i) => ({
    userId: `${prefix}${i + 1}`,
    name: `Fake Person ${i + 1}`,
    email: `fake.person${i + 1}@example.invalid`,
  }))
}

const pinned = usePinnedServer()

let directoryCalls: DirectoryCall[] = []
let directoryRows: Array<{ userId: string; name: string | null; email: string | null }> = []
let MAX_ITEMS = 0
let MIN_QUERY_LENGTH = 0

async function buildApp(opts?: { restrictToMemberGroupIds?: string[]; sheetAccess?: string }): Promise<Express> {
  vi.resetModules()
  directoryCalls = []

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  // Mock ONLY the hydration read model, keeping personRestrictGroupIds (and the whole validator side:
  // createPersonMemberResolver) real — this suite is about what the ROUTE asks for and returns.
  vi.doMock('../../src/multitable/person-field-restriction', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/multitable/person-field-restriction')>()
    return {
      ...actual,
      resolvePersonAssignableDirectory: vi.fn(
        async (
          _query: unknown,
          sheetId: string,
          restrictGroupIds: string[],
          resolveAllowed?: unknown,
          options?: { search?: string; limit?: number },
        ) => {
          directoryCalls.push({ sheetId, restrictGroupIds, resolveAllowed, options })
          // Mirror the real resolver's SQL bound: it never returns more than `limit` rows.
          const limit = options?.limit
          return typeof limit === 'number' ? directoryRows.slice(0, limit) : directoryRows
        },
      ),
    }
  })

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const univerMeta = await import('../../src/routes/univer-meta')
  MAX_ITEMS = univerMeta.PERSON_DIRECTORY_MAX_ITEMS
  MIN_QUERY_LENGTH = univerMeta.PERSON_DIRECTORY_MIN_QUERY_LENGTH

  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<QueryResult> => {
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ deleted_at: null }], rowCount: 1 }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1') && sql.includes('base_id')) {
      return { rows: [{ id: SHEET_ID, base_id: BASE_ID, name: 'People', description: null }] }
    }
    // Sheet-scoped grant: full write on THIS sheet ⇒ canEditRecord true, canManageSheetAccess false —
    // exactly the actor the route is open to and the sibling endpoint refuses.
    if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
      return { rows: [{ sheet_id: SHEET_ID, perm_code: opts?.sheetAccess ?? 'spreadsheet:write', subject_type: 'user' }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return {
        rows: [
          {
            id: FIELD_ID,
            name: 'Owner',
            type: 'person',
            property: opts?.restrictToMemberGroupIds ? { restrictToMemberGroupIds: opts.restrictToMemberGroupIds } : {},
            order: 1,
          },
          { id: TEXT_FIELD_ID, name: 'Title', type: 'text', property: {}, order: 2 },
        ],
      }
    }
    return { rows: [] }
  })
  const pool = { query, transaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: 'user_editor_1', roles: [], perms: ['multitable:read', 'multitable:write'] }
    next()
  })
  app.use('/api/multitable', univerMeta.univerMetaRouter())
  return app
}

const url = (query = '') => `/api/multitable/sheets/${SHEET_ID}/person-fields/${FIELD_ID}/directory${query}`

describe('#5781 person-field directory — bounded disclosure', () => {
  beforeEach(() => {
    directoryRows = fakeDirectory(3)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe('§1 a term-less call discloses nothing', () => {
    it('no q ⇒ empty list + requiresQuery marker, and the directory is never hydrated', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(500) // the whole "deployment roster" is available — and must not ship

      const res = await request(pinned.url()).get(url())

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.items).toEqual([])
      expect(res.body.data.total).toBe(0)
      expect(res.body.data.requiresQuery).toBe(true)
      expect(res.body.data.minQueryLength).toBe(MIN_QUERY_LENGTH)
      expect(res.body.data.hasMore).toBe(false)
      expect(res.body.data.limit).toBe(MAX_ITEMS)
      // ZERO hydration: no name/email lookup was even issued for this call.
      expect(directoryCalls).toHaveLength(0)
      // Values-free marker: the refusal body carries no person data at all.
      const body = JSON.stringify(res.body)
      expect(body).not.toContain('Fake Person')
      expect(body).not.toContain('example.invalid')
    })

    it('whitespace-only q is treated as no term (no roster, no hydration)', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(500)

      const res = await request(pinned.url()).get(url('?q=%20%20%20'))

      expect(res.status).toBe(200)
      expect(res.body.data.items).toEqual([])
      expect(res.body.data.requiresQuery).toBe(true)
      expect(directoryCalls).toHaveLength(0)
    })

    it('the refusal is a 200 marker, not an error — the picker must not render it as a load failure', async () => {
      pinned.setApp(await buildApp())
      const res = await request(pinned.url()).get(url())
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
    })

    it('the term-less short-circuit sits AFTER the existing guards (unknown field still 404s)', async () => {
      pinned.setApp(await buildApp())
      const res = await request(pinned.url())
        .get(`/api/multitable/sheets/${SHEET_ID}/person-fields/${TEXT_FIELD_ID}/directory`)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })
  })

  describe('§2 the ceiling', () => {
    it('clamps to PERSON_DIRECTORY_MAX_ITEMS and reports hasMore when the ceiling is hit', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(400) // far more matches than the ceiling

      const res = await request(pinned.url()).get(url('?q=fake'))

      expect(res.status).toBe(200)
      expect(MAX_ITEMS).toBe(50) // same ceiling the sibling /permission-candidates clamps to
      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.total).toBe(MAX_ITEMS)
      expect(res.body.data.limit).toBe(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
      expect(res.body.data.requiresQuery).toBe(false)
    })

    it('exactly-at-the-ceiling is NOT reported as truncated', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(50)

      const res = await request(pinned.url()).get(url('?q=fake'))

      expect(res.body.data.items).toHaveLength(50)
      expect(res.body.data.hasMore).toBe(false)
    })

    it('a short answer is returned whole with hasMore false', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(3)

      const res = await request(pinned.url()).get(url('?q=fake'))

      expect(res.body.data.items).toHaveLength(3)
      expect(res.body.data.hasMore).toBe(false)
      expect(res.body.data.query).toBe('fake')
    })
  })

  describe('§3 the clamp is below the hydration, not above it', () => {
    it('never asks the DB for more than the ceiling + 1 rows of display data', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(400)

      await request(pinned.url()).get(url('?q=fake'))

      expect(directoryCalls).toHaveLength(1)
      // ceiling + 1 = enough to know `hasMore` without a second COUNT (queryRecordsWithCursor convention).
      expect(directoryCalls[0].options?.limit).toBe(MAX_ITEMS + 1)
      expect(directoryCalls[0].options?.search).toBe('fake')
    })

    it('passes the trimmed term (not the raw one) down to the hydration', async () => {
      pinned.setApp(await buildApp())
      await request(pinned.url()).get(url('?q=%20fake%20'))
      expect(directoryCalls[0].options?.search).toBe('fake')
    })
  })

  describe('§4 eligibility is UNCHANGED (this fix bounds disclosure only)', () => {
    it('a user eligible before is still returned for a matching term', async () => {
      pinned.setApp(await buildApp())
      directoryRows = [{ userId: 'u_still_eligible', name: 'Fake Eligible', email: 'fake.eligible@example.invalid' }]

      const res = await request(pinned.url()).get(url('?q=Fake'))

      expect(res.body.data.items).toEqual([
        { userId: 'u_still_eligible', name: 'Fake Eligible', email: 'fake.eligible@example.invalid' },
      ])
    })

    it('still resolves through the CANONICAL write-validator allowed-set resolver (no read-side fork)', async () => {
      pinned.setApp(await buildApp())
      await request(pinned.url()).get(url('?q=fake'))
      // 4th arg left undefined ⇒ createPersonMemberResolver, the same seam the write validator uses.
      expect(directoryCalls[0].resolveAllowed).toBeUndefined()
      expect(directoryCalls[0].sheetId).toBe(SHEET_ID)
    })

    it("still forwards the field's restrictToMemberGroupIds unchanged", async () => {
      pinned.setApp(await buildApp({ restrictToMemberGroupIds: ['grp_a', 'grp_b'] }))
      await request(pinned.url()).get(url('?q=fake'))
      expect(directoryCalls[0].restrictGroupIds).toEqual(['grp_a', 'grp_b'])
    })

    it('a single character is an acceptable term (the picker re-queries on every keystroke)', async () => {
      pinned.setApp(await buildApp())
      directoryRows = fakeDirectory(2)

      const res = await request(pinned.url()).get(url('?q=f'))

      expect(res.body.data.requiresQuery).toBe(false)
      expect(res.body.data.items).toHaveLength(2)
      expect(directoryCalls).toHaveLength(1)
    })

    it('still refuses an actor without canEditRecord (the pre-existing gate is untouched)', async () => {
      pinned.setApp(await buildApp({ sheetAccess: 'spreadsheet:read' }))
      const res = await request(pinned.url()).get(url('?q=fake'))
      expect(res.status).toBe(403)
      expect(directoryCalls).toHaveLength(0)
    })
  })

  // §5 — the term requirement is scoped to the branch that leaks, not applied blind.
  //
  // An UNRESTRICTED person field's allowed set IS the deployment-wide roster (the whole reason for
  // this fix), so it must require a term. A field carrying restrictToMemberGroupIds resolves through
  // createPersonMemberResolver to (sheet members ∩ the explicitly configured groups) — an
  // intersection, never a widening (person-field-restriction.ts) — so the term-less answer for it is
  // that configured group, not the roster, and it is still clamped by the SAME ceiling. Applying the
  // requirement there cost the picker its browse affordance (the user must guess a first letter to
  // discover a 3-person reviewer group) for zero disclosure benefit: the same actor can already pull
  // up to the ceiling from that same restricted set with any one-character term.
  describe('§5 the term requirement is scoped to the UNRESTRICTED (deployment-wide) branch', () => {
    it('a RESTRICTED field answers a term-less call with its (clamped) group directory — browse survives', async () => {
      pinned.setApp(await buildApp({ restrictToMemberGroupIds: ['grp_reviewers'] }))
      directoryRows = fakeDirectory(3, 'rev')

      const res = await request(pinned.url()).get(url())

      expect(res.status).toBe(200)
      expect(res.body.data.requiresQuery).toBe(false)
      expect(res.body.data.items).toHaveLength(3)
      expect(res.body.data.hasMore).toBe(false)
      // Resolved through the same canonical resolver, with the field's groups forwarded unchanged.
      expect(directoryCalls).toHaveLength(1)
      expect(directoryCalls[0].restrictGroupIds).toEqual(['grp_reviewers'])
      expect(directoryCalls[0].resolveAllowed).toBeUndefined()
    })

    it('the term-less RESTRICTED answer is still clamped by the SAME ceiling (a huge group stays bounded)', async () => {
      pinned.setApp(await buildApp({ restrictToMemberGroupIds: ['grp_all_staff'] }))
      directoryRows = fakeDirectory(400, 'staff')

      const res = await request(pinned.url()).get(url())

      expect(res.body.data.items).toHaveLength(MAX_ITEMS)
      expect(res.body.data.hasMore).toBe(true)
      expect(res.body.data.limit).toBe(MAX_ITEMS)
      // The clamp still lives BELOW the hydration on this path too.
      expect(directoryCalls[0].options?.limit).toBe(MAX_ITEMS + 1)
    })

    it('an UNRESTRICTED field still refuses a term-less call (the leak this fix closes is untouched)', async () => {
      pinned.setApp(await buildApp()) // no restrictToMemberGroupIds
      directoryRows = fakeDirectory(500)

      const res = await request(pinned.url()).get(url())

      expect(res.body.data.requiresQuery).toBe(true)
      expect(res.body.data.items).toEqual([])
      expect(directoryCalls).toHaveLength(0)
    })

    it('a restrict list of only blank entries is NOT a restriction — it still requires a term', async () => {
      // The browse exemption keys off the SANITIZED list, so a blank-only `restrictToMemberGroupIds`
      // cannot be used to re-open the term-less roster dump. Two layers already strip it (stated so
      // nobody removes one believing the other is the guard): field-codecs.sanitizeFieldProperty drops
      // the key entirely when it sanitizes to empty (field-codecs.ts:345-348, applied by
      // serializeFieldRow inside loadFieldsForSheet), and personRestrictGroupIds re-sanitizes at use.
      // This pins the ROUTE-level outcome regardless of which layer does the work.
      pinned.setApp(await buildApp({ restrictToMemberGroupIds: ['', '   '] }))
      directoryRows = fakeDirectory(500)

      const res = await request(pinned.url()).get(url())

      expect(res.body.data.requiresQuery).toBe(true)
      expect(res.body.data.items).toEqual([])
      expect(directoryCalls).toHaveLength(0)
    })

    it('a RESTRICTED field still honours a term when one is given (search is forwarded, not dropped)', async () => {
      pinned.setApp(await buildApp({ restrictToMemberGroupIds: ['grp_reviewers'] }))
      directoryRows = fakeDirectory(2, 'rev')

      const res = await request(pinned.url()).get(url('?q=fake'))

      expect(res.body.data.requiresQuery).toBe(false)
      expect(directoryCalls[0].options?.search).toBe('fake')
      expect(res.body.data.items).toHaveLength(2)
    })

    it('the browse exemption does NOT bypass the permission gate (no canEditRecord ⇒ 403, no hydration)', async () => {
      pinned.setApp(await buildApp({ restrictToMemberGroupIds: ['grp_reviewers'], sheetAccess: 'spreadsheet:read' }))
      const res = await request(pinned.url()).get(url())
      expect(res.status).toBe(403)
      expect(directoryCalls).toHaveLength(0)
    })
  })
})
