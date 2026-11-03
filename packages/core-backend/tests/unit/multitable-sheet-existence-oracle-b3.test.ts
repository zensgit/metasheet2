/**
 * #5839 B3 — SHEET-EXISTENCE ORACLE, four univer-meta handlers (mock pool, no DB).
 *
 * ── What is under test ────────────────────────────────────────────────────────
 * Each of these four handlers used to OPEN with a sheet-existence probe — `loadSheetRow(...)` /
 * `loadSheetRowShared(...)`, or an inline `SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS
 * NULL` — and answer 404 (mostly echoing the requested id) BEFORE its first 403. A signed-in caller
 * the handler then refused could therefore tell a LIVE sheet from a SOFT-DELETED or an ABSENT one,
 * just by watching 404-vs-403. That is the oracle #5839 tracks; the four were named in the GAP ledger
 * of tests/unit/multitable-sheet-liveness-closure.guard.test.ts and this commit removes them from it.
 *
 *   (a) POST /person-fields/prepare        probe moved AFTER canManageFields + liveness
 *   (b) GET  /sheets/:sheetId/export-xlsx  BOTH probes (sheet row and VIEW row) moved after 401/403/404
 *   (c) POST /sheets/:sheetId/formula/dry-run  probe DELETED, and the missing liveness refusal ADDED
 *       to the no-recordId branch (deleting the probe alone regressed it to 200 on a dead sheet)
 *   (d) POST /attachments                  inline probe deleted, liveness refusal moved after the 403
 *
 * ── Why this file exists (the structural guard cannot replace it) ─────────────
 * The sibling closure guard classifies a HANDLER, by regex, on whichever branch matches first. For
 * (c) that is `requireRecordReadable` in the recordId branch — so the guard called the whole handler
 * GUARDED while the no-recordId branch had no liveness check at all, and its bind-and-use assertion
 * passed VACUOUSLY because that branch bound nothing. A structural guard also cannot see an ORDER
 * that is only observable as a status code, nor a message that stopped echoing an id. Those are
 * behavioural facts and they need behavioural assertions.
 *
 * ── The table ─────────────────────────────────────────────────────────────────
 * Each route x {OUTSIDER, MANAGER} x {LIVE, DELETED, ABSENT}. The two load-bearing claims:
 *
 *   ORACLE CLOSED   OUTSIDER gets the IDENTICAL 403 body for all three livenesses, and no
 *                   existence read is issued on their behalf at all (computed from the recorded
 *                   sqlLog, not from a hand-listed expectation).
 *   STILL REFUSED   MANAGER gets 404 SHEET_DELETED for the soft-deleted sheet and 404 NOT_FOUND
 *                   (values-free, no id) for the absent one — i.e. closing the oracle did not open
 *                   a hole. This is the assertion that (c)'s regression would have failed.
 *
 * Every cell additionally asserts the request REACHED the handler: the sqlLog is non-empty and its
 * first `meta_sheets` statement is the liveness read, so a 403 produced by middleware (or by a
 * fixture that answered nothing) cannot masquerade as a pass.
 *
 * ── Fixture notes ─────────────────────────────────────────────────────────────
 * SELF-CONTAINED by design: the fake pool below models `deleted_at` and answers the REAL resolver's
 * read, `SELECT deleted_at FROM meta_sheets WHERE id = $1` (multitable/sheet-liveness.ts), NOT the
 * loader's `SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS
 * NULL`. A fixture that only answered the loader's form would translate liveness through the very
 * probe these handlers no longer run, and every cell would pass vacuously. (#5839 B1 is landing a
 * shared fixture, tests/utils/sheet-existence-oracle.ts; a follow-up migrates this file to it.)
 *
 * Unlisted SQL returns an empty result set rather than throwing. That cannot make a cell pass by
 * accident: every cell asserts an EXACT status and an EXACT body.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET_LIVE = 'sheet_b3_live'
const SHEET_DELETED = 'sheet_b3_deleted'
const SHEET_ABSENT = 'sheet_b3_absent'
const BASE_ID = 'base_b3'
const VIEW_ON_LIVE = 'viw_b3_live'
const VIEW_ABSENT = 'viw_b3_absent'
const FIELD_ABSENT = 'fld_b3_absent'

type Liveness = 'LIVE' | 'DELETED' | 'ABSENT'

const SHEET_ID: Record<Liveness, string> = {
  LIVE: SHEET_LIVE,
  DELETED: SHEET_DELETED,
  ABSENT: SHEET_ABSENT,
}

/** The exact read the liveness resolver issues (multitable/sheet-liveness.ts). */
const LIVENESS_SQL = 'SELECT deleted_at FROM meta_sheets WHERE id = $1'

/**
 * The EXISTENCE-PROBE shape, as a substring: it covers both the loader's projection
 * (`SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL`,
 * multitable/loaders.ts) and the inline bare-id form the attachments route used to run. A statement
 * of this shape is what turned "may I?" into "does it exist?" — its ABSENCE before a 403 is the fix.
 */
const EXISTENCE_PROBE_SQL = 'FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL'

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }
const SHEET_ABSENT_BODY = { ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } }
const SHEET_DELETED_BODY = {
  ok: false,
  error: {
    code: 'SHEET_DELETED',
    message:
      'This sheet has been deleted. It can be restored with POST /api/multitable/sheets/{sheetId}/restore by an actor with schema authority.',
  },
}

/** Body → the liveness 404 the MANAGER must still get. */
const LIVENESS_BODY: Record<'DELETED' | 'ABSENT', unknown> = {
  DELETED: SHEET_DELETED_BODY,
  ABSENT: SHEET_ABSENT_BODY,
}

// ── fake pool ─────────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }

/** `deleted_at` is MODELLED, not filtered — that is the whole point of the fixture. */
const SHEET_STATE = new Map<string, { deleted_at: string | null }>([
  [SHEET_LIVE, { deleted_at: null }],
  [SHEET_DELETED, { deleted_at: '2026-09-18T00:00:00.000Z' }],
])

const SHEET_ROW = { id: SHEET_LIVE, base_id: BASE_ID, name: 'B3 oracle sheet', description: null }
const FIELDS = [
  { id: 'fld_b3_qty', sheet_id: SHEET_LIVE, name: 'Qty', type: 'number', property: {}, order: 0 },
  { id: 'fld_b3_note', sheet_id: SHEET_LIVE, name: 'Note', type: 'string', property: {}, order: 1 },
]
const VIEW_ROW = {
  id: VIEW_ON_LIVE,
  sheet_id: SHEET_LIVE,
  name: 'Grid',
  type: 'grid',
  hidden_field_ids: [],
  filter_info: null,
  sort_info: null,
  group_info: null,
  row_height: null,
  config: {},
}

const sqlLog: string[] = []

function createFakePool() {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    sqlLog.push(sql)
    const p = (i: number) => String(params?.[i] ?? '')

    // THE RESOLVER'S OWN READ. Answered from the modelled `deleted_at`, so `deleted` and `absent`
    // stay distinguishable exactly as the product distinguishes them.
    if (sql.includes(LIVENESS_SQL)) {
      const state = SHEET_STATE.get(p(0))
      return { rows: state ? [{ deleted_at: state.deleted_at }] : [] }
    }
    // The EXISTENCE PROBE, in both shapes. Answered (a live sheet has a row) so that a handler which
    // still ran one early would SUCCEED rather than fail — the assertions below are about whether it
    // ran at all and when, never about it erroring.
    if (sql.includes(EXISTENCE_PROBE_SQL)) {
      const state = SHEET_STATE.get(p(0))
      const live = !!state && state.deleted_at === null
      if (!live) return { rows: [] }
      return { rows: [sql.includes('base_id') ? { ...SHEET_ROW } : { id: p(0) }] }
    }
    // Projection-base narrowing lookups (approval / e-learning) — this sheet is neither.
    if (sql.includes('FROM meta_sheets') && sql.includes('= ANY(')) return { rows: [] }

    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
    if (sql.includes('FROM field_permissions')) return { rows: [] }
    if (sql.includes('FROM record_permissions')) return { rows: [] }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [] }
    if (sql.includes('FROM formula_dependencies')) return { rows: [] }
    if (sql.includes('FROM plugin_multitable_object_registry')) return { rows: [] }

    if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
      return { rows: p(0) === VIEW_ON_LIVE ? [{ ...VIEW_ROW }] : [] }
    }
    // The attachments route's FIELD probe: nothing matches, which is how the LIVE cell proves it
    // reached the handler BODY (a 404 that is neither of the liveness bodies).
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE id = $1')) return { rows: [] }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE sheet_id = $1')) {
      return { rows: p(0) === SHEET_LIVE ? FIELDS.map((f) => ({ ...f })) : [] }
    }
    if (sql.includes('FROM meta_bases')) {
      return { rows: p(0) === BASE_ID ? [{ id: BASE_ID, name: 'B3', workspace_id: null }] : [] }
    }

    return { rows: [] }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const pool = createFakePool()

// ── apps ──────────────────────────────────────────────────────────────────────

type ActorId = 'OUTSIDER' | 'MANAGER'

/**
 * OUTSIDER holds a real user id and a permission that is NOT a multitable code, so it is refused by
 * EVERY gate here (canRead / canExport / canManageFields / canEditRecord all false) while still
 * clearing the 401. MANAGER is an admin role, so it holds all four.
 */
const ACTOR: Record<ActorId, { id: string; roles: string[]; perms: string[] }> = {
  OUTSIDER: { id: 'u_b3_outsider', roles: ['member'], perms: ['files:read'] },
  MANAGER: { id: 'u_b3_manager', roles: ['admin'], perms: [] },
}

/**
 * ONE app, actor swapped per cell. The actor is a module-level variable read by the auth middleware
 * rather than baked into two separately built routers: every cell must be answered by the SAME
 * wiring, so a difference between two cells can only come from the actor or the sheet, never from
 * two router instances that drifted. (It also keeps the fixture to a single `univerMetaRouter()`
 * construction, which is the expensive part of this file.)
 */
let currentActor: ActorId = 'OUTSIDER'
let app: Express

async function buildApp(): Promise<Express> {
  // Attachment storage root, read at MODULE scope by the router — so it must be set before the import
  // below. No cell here is supposed to reach the store (the (d) LIVE cell stops at the field probe),
  // but a BROKEN liveness guard would let one through, and a mutation probe must not be able to write
  // blobs into the repo. Pointed at the OS temp dir, never a repo path.
  process.env.ATTACHMENT_PATH = join(tmpdir(), 'b3-existence-oracle-attachments')
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    ;(req as any).user = { ...ACTOR[currentActor] }
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  return built
}

// ONE pinned listener for the file (#4154: `request(app)` is banned in tests/unit).
const pinned = usePinnedServer()

function on(actor: ActorId) {
  sqlLog.length = 0
  currentActor = actor
  pinned.setApp(app)
  return request(pinned.url())
}

beforeAll(async () => {
  app = await buildApp()
})

// ── computed evidence ─────────────────────────────────────────────────────────

/** Statements of the existence-probe shape, COMPUTED from the recorded log (never hand-listed). */
function existenceProbes(): string[] {
  return sqlLog.filter((sql) => sql.includes(EXISTENCE_PROBE_SQL))
}

/**
 * The request REACHED the handler: it issued SQL, and the first statement that touches `meta_sheets`
 * is the liveness read. A refusal produced by middleware, or by a handler that returned before doing
 * any work, fails this — so no cell can pass without the route actually adjudicating.
 */
function expectReachedHandler() {
  expect(sqlLog.length, 'the request issued no SQL — it never reached the handler').toBeGreaterThan(0)
  const firstSheetStatement = sqlLog.find((sql) => sql.includes('meta_sheets'))
  expect(firstSheetStatement, 'no meta_sheets statement was issued').toBeDefined()
  expect(firstSheetStatement).toContain(LIVENESS_SQL)
}

/** The OUTSIDER cell: identical 403, and NOTHING was looked up about the sheet's existence. */
function expectOracleClosed(status: number, body: unknown) {
  expect(status).toBe(403)
  expect(body).toEqual(FORBIDDEN_BODY)
  expectReachedHandler()
  expect(
    existenceProbes(),
    'an existence probe ran for a caller this route refuses — that is the #5839 oracle',
  ).toEqual([])
}

/** The MANAGER-on-a-dead-sheet cell: the liveness 404, values-free, and still no existence probe. */
function expectStillRefused(status: number, body: unknown, liveness: 'DELETED' | 'ABSENT', sheetId: string) {
  expect(status).toBe(404)
  expect(body).toEqual(LIVENESS_BODY[liveness])
  expect(JSON.stringify(body), 'the refusal echoed the requested id back').not.toContain(sheetId)
  expectReachedHandler()
  expect(existenceProbes()).toEqual([])
}

describe('#5839 B3 — sheet-existence oracle on four univer-meta handlers', () => {
  describe('(a) POST /person-fields/prepare', () => {
    const send = (actor: ActorId, sheetId: string) =>
      on(actor).post('/api/multitable/person-fields/prepare').send({ sheetId })

    for (const liveness of ['LIVE', 'DELETED', 'ABSENT'] as Liveness[]) {
      it(`OUTSIDER x ${liveness} -> one identical 403, no existence read`, async () => {
        const res = await send('OUTSIDER', SHEET_ID[liveness])
        expectOracleClosed(res.status, res.body)
      })
    }

    for (const liveness of ['DELETED', 'ABSENT'] as const) {
      it(`MANAGER x ${liveness} -> 404 liveness refusal, values-free`, async () => {
        const res = await send('MANAGER', SHEET_ID[liveness])
        expectStillRefused(res.status, res.body, liveness, SHEET_ID[liveness])
      })
    }

    it('MANAGER x LIVE -> not refused, and the sheet row IS read (after the 403, not before)', async () => {
      const res = await send('MANAGER', SHEET_LIVE)
      expect([401, 403, 404]).not.toContain(res.status)
      expectReachedHandler()
      // The probe did not vanish, it MOVED: on the one path that gets past both refusals it runs.
      expect(existenceProbes().length).toBeGreaterThan(0)
      const probeIndex = sqlLog.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      const livenessIndex = sqlLog.findIndex((sql) => sql.includes(LIVENESS_SQL))
      expect(livenessIndex).toBeGreaterThanOrEqual(0)
      expect(probeIndex, 'the existence probe still runs before the liveness resolution').toBeGreaterThan(livenessIndex)
    })
  })

  describe('(b) GET /sheets/:sheetId/export-xlsx', () => {
    const send = (actor: ActorId, sheetId: string, viewId?: string) =>
      on(actor).get(`/api/multitable/sheets/${sheetId}/export-xlsx${viewId ? `?viewId=${viewId}` : ''}`)

    for (const liveness of ['LIVE', 'DELETED', 'ABSENT'] as Liveness[]) {
      it(`OUTSIDER x ${liveness} -> one identical 403, no existence read`, async () => {
        const res = await send('OUTSIDER', SHEET_ID[liveness])
        expectOracleClosed(res.status, res.body)
      })
    }

    it('OUTSIDER x LIVE with a viewId -> the SAME 403, and the VIEW row is never read either', async () => {
      const res = await send('OUTSIDER', SHEET_LIVE, VIEW_ON_LIVE)
      expectOracleClosed(res.status, res.body)
      expect(sqlLog.filter((sql) => sql.includes('meta_views'))).toEqual([])
    })

    for (const liveness of ['DELETED', 'ABSENT'] as const) {
      it(`MANAGER x ${liveness} -> 404 liveness refusal, values-free`, async () => {
        const res = await send('MANAGER', SHEET_ID[liveness])
        expectStillRefused(res.status, res.body, liveness, SHEET_ID[liveness])
      })
    }

    it('MANAGER x LIVE -> 200, and the sheet row is read only after the liveness resolution', async () => {
      const res = await send('MANAGER', SHEET_LIVE)
      expect(res.status).toBe(200)
      expectReachedHandler()
      const probeIndex = sqlLog.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      const livenessIndex = sqlLog.findIndex((sql) => sql.includes(LIVENESS_SQL))
      expect(probeIndex).toBeGreaterThan(livenessIndex)
    })

    it('MANAGER x LIVE with an ABSENT viewId -> 404 "View not found", values-free (no view id echoed)', async () => {
      const res = await send('MANAGER', SHEET_LIVE, VIEW_ABSENT)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })
      expect(JSON.stringify(res.body)).not.toContain(VIEW_ABSENT)
      // The view probe is INSIDE the guarded region: it only ran because this caller passed
      // canRead + canExport + liveness.
      expect(sqlLog.filter((sql) => sql.includes('meta_views')).length).toBeGreaterThan(0)
    })
  })

  describe('(c) POST /sheets/:sheetId/formula/dry-run (no recordId)', () => {
    const send = (actor: ActorId, sheetId: string) =>
      on(actor).post(`/api/multitable/sheets/${sheetId}/formula/dry-run`).send({ expression: '1 + 1' })

    for (const liveness of ['LIVE', 'DELETED', 'ABSENT'] as Liveness[]) {
      it(`OUTSIDER x ${liveness} -> one identical 403, no existence read`, async () => {
        const res = await send('OUTSIDER', SHEET_ID[liveness])
        expectOracleClosed(res.status, res.body)
      })
    }

    /**
     * THE REGRESSION CELL. Deleting the opening probe closed the oracle and, on its own, replaced it
     * with a worse hole: this branch bound no `sheetLiveness`, so a canManageFields caller got 200 —
     * a result computed from a soft-deleted sheet's live field schema, because `loadFieldsForSheet`
     * reads `meta_fields` by `sheet_id` and never joins `meta_sheets`.
     */
    for (const liveness of ['DELETED', 'ABSENT'] as const) {
      it(`MANAGER x ${liveness} -> 404 liveness refusal (NOT a 200 dry-run result)`, async () => {
        const res = await send('MANAGER', SHEET_ID[liveness])
        expectStillRefused(res.status, res.body, liveness, SHEET_ID[liveness])
        expect(JSON.stringify(res.body)).not.toContain('result')
        // And the dead sheet's schema was never even loaded.
        expect(sqlLog.filter((sql) => sql.includes('FROM meta_fields'))).toEqual([])
      })
    }

    it('MANAGER x LIVE -> 200 with the evaluated result (the refusal is liveness-scoped, not a blanket 404)', async () => {
      const res = await send('MANAGER', SHEET_LIVE)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data?.result).toBe(2)
      expectReachedHandler()
      // (c)'s probe was DELETED, not moved: nothing reads the sheet row on this route any more.
      expect(existenceProbes()).toEqual([])
    })
  })

  describe('(d) POST /attachments', () => {
    const send = (actor: ActorId, sheetId: string, fieldId?: string) => {
      const agent = on(actor)
        .post('/api/multitable/attachments')
        .field('sheetId', sheetId)
      return (fieldId ? agent.field('fieldId', fieldId) : agent)
        .attach('file', Buffer.from('b3'), 'b3.txt')
    }

    for (const liveness of ['LIVE', 'DELETED', 'ABSENT'] as Liveness[]) {
      it(`OUTSIDER x ${liveness} -> one identical 403, no existence read`, async () => {
        const res = await send('OUTSIDER', SHEET_ID[liveness])
        expectOracleClosed(res.status, res.body)
      })
    }

    /**
     * Before the fix the DELETED and ABSENT cells both answered `404 NOT_FOUND "Sheet not found:
     * <id>"` from the inline probe — id-bearing, and ahead of the 403. (The soft-deleted case could
     * additionally reach a 500: the route threw `SheetNotLiveError`, which extends Error, while the
     * catch tests `instanceof NotFoundError` — a module-private class — so it fell through to
     * INTERNAL_ERROR. That was reachable only in the race between the probe and the resolver.)
     */
    for (const liveness of ['DELETED', 'ABSENT'] as const) {
      it(`MANAGER x ${liveness} -> 404 liveness refusal, values-free (not 500, not an id-bearing 404)`, async () => {
        const res = await send('MANAGER', SHEET_ID[liveness])
        expectStillRefused(res.status, res.body, liveness, SHEET_ID[liveness])
      })
    }

    it('MANAGER x LIVE -> past both gates and into the handler body (the field probe answers)', async () => {
      const res = await send('MANAGER', SHEET_LIVE, FIELD_ABSENT)
      expect(res.status).toBe(404)
      // A 404 that is NEITHER liveness body: it can only be produced after the 403 and the liveness check.
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'NOT_FOUND', message: `Field not found: ${FIELD_ABSENT}` },
      })
      expectReachedHandler()
      // (d)'s probe was DELETED: the sheet row is never read on this route any more.
      expect(existenceProbes()).toEqual([])
    })
  })
})
