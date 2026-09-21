/**
 * #5839 B5 — SHEET-EXISTENCE ORACLE on the two record-WRITE entries of univer-meta (mock pool, no DB).
 *
 * ── What is under test ────────────────────────────────────────────────────────
 * Both handlers used to OPEN with a sheet-row existence probe — `loadSheetRow(...)`, i.e.
 * `SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL` —
 * and answer `404 { message: 'Sheet not found: <id>' }` BEFORE their first authority refusal. A
 * caller the handler was about to turn away could therefore separate LIVE from SOFT-DELETED/ABSENT
 * just by watching 404-vs-401/403, and the body even echoed the id back. Both are named in the GAP
 * ledger of tests/unit/multitable-sheet-liveness-closure.guard.test.ts; this commit removes them.
 *
 *   (a) POST /views/:viewId/submit   the SHEET probe moved after 401 / 403 / liveness. The VIEW probe
 *                                    did NOT move — see the residual note below.
 *   (b) PATCH /records/:recordId     the SHEET probe moved after 401 / 403 / liveness, and the second
 *                                    id-bearing 404 (`buildRecordPatchContext` → null) went values-free.
 *
 * ── The order this file pins, and why 401 comes before 403 on (a) ─────────────
 * `POST /views/:viewId/submit` is a PUBLIC FORM entry, so its layering is NOT the plain
 * "403 then liveness" of the other handlers:
 *
 *      401  anonymous caller with no valid publicToken   (univer-meta.ts, `!access.userId && !publicAccessAllowed`)
 *      403  LOGGED-IN caller lacking canCreateRecord     (sendForbidden)
 *      404  sheetLiveness !== 'live'                     (sendSheetNotLive — values-free)
 *      ...  only then the sheet row
 *
 * An earlier plan for this batch assumed the 403 came first and would therefore be the single
 * indistinguishable answer for every caller; it is not, and the 401 is pinned by
 * tests/integration/public-form-flow.test.ts (an invalid or expired token answers 401). So the
 * promise this file makes is per-CALLER-CLASS, not global: an anonymous caller sees ONE 401 for
 * LIVE and DELETED alike, a logged-in unauthorised caller sees ONE 403 for both. That is what
 * closes the oracle — a caller cannot change the answer by changing the sheet.
 *
 * ── Named residuals (deliberately NOT closed here) ────────────────────────────
 *  - #5908 — (a) keeps its VIEW-row probe ahead of authority. The view is an AUTHORISATION INPUT on
 *    this route (`isPublicFormAccessAllowed(view, token)` and the protected-form evaluation both
 *    consume it), so it cannot be moved below the decision it feeds. Consequence, pinned below: an
 *    ABSENT sheet carries no view — `meta_views.sheet_id` is
 *    `.references('meta_sheets.id').onDelete('cascade')`, src/db/migrations/
 *    zzz20251231_create_meta_schema.ts:32, the only production DDL for the table — so an absent
 *    sheet's viewId answers the same `View not found` 404 as a viewId that was never real. Should
 *    that FK ever be dropped, a DANGLING view is answered by the values-free liveness 404 and every
 *    refused caller class still sees exactly what it sees on a LIVE sheet; both arms are asserted
 *    below. A DELETED sheet's view DOES still resolve (`tryResolveView`, multitable/loaders.ts,
 *    does not filter liveness), which is exactly why the LIVE/DELETED pair below is identical.
 *  - #5911 — (b) keeps its RECORD-row probe ahead of authority. Without `sheetId`/`viewId` in the
 *    body it is the ONLY way to learn which sheet is addressed. It is not a SHEET oracle: with a
 *    body `sheetId`, an ABSENT sheet yields zero rows and the byte-identical `Record not found:
 *    <recordId>` that a LIVE sheet returns for a recordId that is not on it — asserted as one
 *    equality below, together with the probe's SQL shape.
 *
 * ── Fixture notes ─────────────────────────────────────────────────────────────
 * The shared fixture tests/utils/sheet-existence-oracle.ts (landed with #5839 B1) IS on main, and the
 * three refusal BODIES below are imported from it — so they stay captured from the real
 * `sendForbidden` / `sendSheetNotLive` rather than hand-typed, which is the discipline that keeps a
 * changed product body from leaving a green copy behind.
 *
 * Its POOL (`makeOracleFakePool`) is NOT used, for two states this batch cannot do without:
 *   - SHEET_RACE — `makeOracleFakePool` derives liveness `live` for every id it does not know and
 *     serves the `deleted_at IS NULL` row only for its own LIVE, so the race and an ordinary live
 *     sheet are the same id there; here they must be two ids answered by two different reads.
 *   - SHEET_LIVE_NOFIELDS — a SECOND live sheet that HAS a row (its `options.answer` hook is consulted
 *     only after the sheet-row probe, so a second row-bearing live sheet is not expressible).
 * The local pool below is modelled on tests/unit/multitable-record-gate-capability-before-liveness.ts
 * and on the sibling tests/unit/multitable-sheet-existence-oracle-b3.test.ts.
 *
 * The fake pool models `deleted_at` and answers the RESOLVER's read
 * (`SELECT deleted_at FROM meta_sheets WHERE id = $1`, multitable/sheet-liveness.ts) rather than
 * translating liveness through the loader's `... AND deleted_at IS NULL` projection. A fixture that
 * only answered the loader's form would derive liveness from the very probe these handlers no longer
 * run before refusing, and every cell would pass vacuously.
 *
 * Unlisted SQL returns an empty result set instead of throwing. That cannot make a cell pass by
 * accident: every cell asserts an EXACT status and an EXACT body.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import {
  FORBIDDEN as FORBIDDEN_BODY,
  SHEET_ABSENT_BODY,
  SHEET_DELETED_BODY,
} from '../utils/sheet-existence-oracle'

// ── ids ───────────────────────────────────────────────────────────────────────

const SHEET_LIVE = 'sheet_b5_live'
const SHEET_DELETED = 'sheet_b5_deleted'
const SHEET_ABSENT = 'sheet_b5_absent'
/** A LIVE sheet with NO fields — the one reachable way to make `buildRecordPatchContext` return null. */
const SHEET_LIVE_NOFIELDS = 'sheet_b5_live_nofields'
/**
 * THE RACE, staged. Liveness answers `live` and the sheet ROW is then gone — exactly the window the
 * moved probe now occupies (a delete committing between the two reads). It is the only way to reach
 * the relocated 404, and therefore the only way to prove its message is values-free.
 */
const SHEET_RACE = 'sheet_b5_race'
const BASE_ID = 'base_b5'

const VIEW_ON_LIVE = 'viw_b5_on_live'
const VIEW_ON_DELETED = 'viw_b5_on_deleted'
const VIEW_ON_RACE = 'viw_b5_on_race'
const VIEW_ABSENT = 'viw_b5_absent'
/**
 * A view whose sheet row does not exist. The production FK (`meta_views.sheet_id` REFERENCES
 * `meta_sheets(id) ON DELETE CASCADE`, src/db/migrations/zzz20251231_create_meta_schema.ts:32) makes
 * this unreachable today; it is staged anyway so the #5908 residual is pinned by BEHAVIOUR rather
 * than by that FK alone — if the constraint is ever dropped, the cell below still has to hold.
 */
const VIEW_DANGLING = 'viw_b5_dangling'
/** A view on the second LIVE sheet — used only to feed `resolveMetaSheetId` a cross-sheet viewId. */
const VIEW_ON_NOFIELDS = 'viw_b5_on_nofields'
/** The SAME token on both views, so a LIVE/DELETED difference can only come from the sheet. */
const PUBLIC_TOKEN = 'tok_b5_public'

const FLD_TEXT = 'fld_b5_text'

const REC_ON_LIVE = 'rec_b5_on_live'
const REC_ON_DELETED = 'rec_b5_on_deleted'
const REC_ON_NOFIELDS = 'rec_b5_on_nofields'
const REC_ON_RACE = 'rec_b5_on_race'
/** A record id that exists on NO sheet. */
const REC_NOWHERE = 'rec_b5_nowhere'

// ── SQL shapes ────────────────────────────────────────────────────────────────

/** The read the liveness resolver issues (multitable/sheet-liveness.ts). */
const LIVENESS_SQL = 'SELECT deleted_at FROM meta_sheets WHERE id = $1'
/** The EXISTENCE PROBE this batch moved: `loadSheetRow` (multitable/loaders.ts). */
const EXISTENCE_PROBE_SQL = 'FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL'
/** #5911: the record probe's shape, pinned so a future widening (dropping `sheet_id`) is visible. */
const RECORD_PROBE_SCOPED_SQL = 'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2'
const RECORD_PROBE_UNSCOPED_SQL = 'SELECT id, sheet_id FROM meta_records WHERE id = $1'

// ── bodies ────────────────────────────────────────────────────────────────────

/** The ONE body still written out here: the 401 is plain express, not a sheet refusal helper. */
const UNAUTHENTICATED_BODY = { error: 'Authentication required' }
/**
 * The relocated probe's 404 and the `buildRecordPatchContext` 404 are hand-built in the route rather
 * than emitted by `sendSheetNotLive`, and this equality is what pins them to the canonical absent
 * refusal: if either drifts away from it, the cells below red.
 */
const SHEET_NOT_FOUND_BODY = SHEET_ABSENT_BODY
const recordNotFoundBody = (recordId: string) => ({
  ok: false,
  error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` },
})

// ── fake pool ─────────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }

/** `deleted_at` is MODELLED, not filtered — that is the whole point of this fixture. */
const SHEET_STATE = new Map<string, { deleted_at: string | null }>([
  [SHEET_LIVE, { deleted_at: null }],
  [SHEET_LIVE_NOFIELDS, { deleted_at: null }],
  [SHEET_RACE, { deleted_at: null }],
  [SHEET_DELETED, { deleted_at: '2026-09-18T00:00:00.000Z' }],
])

const sheetRow = (id: string) => ({ id, base_id: BASE_ID, name: `B5 ${id}`, description: null })

const FIELD_ROWS = [{ id: FLD_TEXT, name: 'Text', type: 'string', property: {}, order: 0 }]

const viewRow = (id: string, sheetId: string) => ({
  id,
  sheet_id: sheetId,
  name: 'Form',
  type: 'form',
  hidden_field_ids: [],
  filter_info: null,
  sort_info: null,
  group_info: null,
  row_height: null,
  config: { publicForm: { enabled: true, publicToken: PUBLIC_TOKEN, accessMode: 'public' } },
})

const VIEW_ROWS = new Map<string, ReturnType<typeof viewRow>>([
  [VIEW_ON_LIVE, viewRow(VIEW_ON_LIVE, SHEET_LIVE)],
  [VIEW_ON_DELETED, viewRow(VIEW_ON_DELETED, SHEET_DELETED)],
  [VIEW_ON_RACE, viewRow(VIEW_ON_RACE, SHEET_RACE)],
  [VIEW_DANGLING, viewRow(VIEW_DANGLING, SHEET_ABSENT)],
  [VIEW_ON_NOFIELDS, viewRow(VIEW_ON_NOFIELDS, SHEET_LIVE_NOFIELDS)],
])

/** Record rows survive a SOFT delete; nothing can sit on a sheet that never existed. */
const RECORD_ROWS = new Map<string, { sheet_id: string; version: number; data: Record<string, unknown> }>([
  [REC_ON_LIVE, { sheet_id: SHEET_LIVE, version: 1, data: { [FLD_TEXT]: 'before' } }],
  [REC_ON_DELETED, { sheet_id: SHEET_DELETED, version: 1, data: { [FLD_TEXT]: 'before' } }],
  [REC_ON_NOFIELDS, { sheet_id: SHEET_LIVE_NOFIELDS, version: 1, data: {} }],
  [REC_ON_RACE, { sheet_id: SHEET_RACE, version: 1, data: { [FLD_TEXT]: 'before' } }],
])

const sqlLog: Array<{ sql: string; params: unknown[] }> = []

function createFakePool() {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const flat = sql.replace(/\s+/g, ' ').trim()
    sqlLog.push({ sql: flat, params })
    const p = (i: number) => String(params?.[i] ?? '')

    // THE RESOLVER'S OWN READ — answered from the modelled `deleted_at`, so `deleted` and `absent`
    // stay distinguishable exactly as the product distinguishes them.
    if (flat.includes(LIVENESS_SQL)) {
      const state = SHEET_STATE.get(p(0))
      return { rows: state ? [{ deleted_at: state.deleted_at }] : [] }
    }
    // THE MOVED PROBE. Answered (a live sheet has a row) so a handler that still ran one early would
    // SUCCEED rather than fail: the assertions are about WHETHER and WHEN it ran, never about errors.
    if (flat.includes(EXISTENCE_PROBE_SQL)) {
      // SHEET_RACE is the ONE id where the two reads disagree: the liveness read above said `live`
      // and the row is already gone. That is the delete-committed-in-between window the moved probe
      // now sits in, and the only way to reach its 404 at all.
      if (p(0) === SHEET_RACE) return { rows: [] }
      const state = SHEET_STATE.get(p(0))
      return { rows: state && state.deleted_at === null ? [sheetRow(p(0))] : [] }
    }
    // Projection-base narrowing lookups (approval / e-learning) — neither sheet is one.
    if (flat.includes('FROM meta_sheets') && flat.includes('= ANY(')) return { rows: [] }

    if (flat.includes('FROM meta_views') && flat.includes('WHERE id = $1')) {
      const row = VIEW_ROWS.get(p(0))
      return { rows: row ? [{ ...row }] : [] }
    }

    // Record reads, discriminated by PROJECTION (the route's probe and the response read-back share
    // a WHERE clause but not a select list).
    if (flat.startsWith(RECORD_PROBE_SCOPED_SQL)) {
      const row = RECORD_ROWS.get(p(0))
      return { rows: row && row.sheet_id === p(1) ? [{ id: p(0), sheet_id: row.sheet_id }] : [] }
    }
    if (flat.startsWith(RECORD_PROBE_UNSCOPED_SQL)) {
      const row = RECORD_ROWS.get(p(0))
      return { rows: row ? [{ id: p(0), sheet_id: row.sheet_id }] : [] }
    }
    if (/^SELECT id, version, data(, locked)?/.test(flat) && flat.includes('FROM meta_records')) {
      const row = RECORD_ROWS.get(p(0))
      if (!row || (params.length > 1 && row.sheet_id !== p(1))) return { rows: [] }
      return { rows: [{ id: p(0), version: row.version, data: row.data, locked: false, locked_by: null, locked_at: null }] }
    }
    if (flat.includes('FROM meta_records') && flat.includes('FOR UPDATE')) {
      const row = RECORD_ROWS.get(p(0))
      if (!row || (params.length > 1 && row.sheet_id !== p(1))) return { rows: [] }
      return { rows: [{ id: p(0), sheet_id: row.sheet_id, version: row.version, data: row.data, created_by: null, locked: false, locked_by: null }] }
    }

    if (flat.includes('FROM meta_fields') && flat.includes('WHERE sheet_id = $1')) {
      // Field rows are keyed by sheet_id and NEVER join meta_sheets — a soft-deleted sheet still has
      // its schema, which is why liveness has to be refused explicitly rather than inferred.
      // SHEET_LIVE_NOFIELDS is live but schema-less, which is what drives `buildRecordPatchContext`
      // to return null and the route to answer its second (now values-free) 404.
      // Only SHEET_LIVE_NOFIELDS is schema-less. SHEET_ABSENT is deliberately NOT listed: no cell can
      // reach a meta_fields read for it (every ABSENT request is answered by the record probe's 404
      // first, asserted in (b)①-residual), so an `|| p(0) === SHEET_ABSENT` arm would be dead code
      // implying a coverage this file does not have.
      const schemaless = p(0) === SHEET_LIVE_NOFIELDS
      return { rows: schemaless ? [] : FIELD_ROWS.map((f) => ({ ...f })) }
    }
    if (flat.includes('FROM meta_bases')) {
      return { rows: p(0) === BASE_ID ? [{ id: BASE_ID, name: 'B5', workspace_id: null }] : [] }
    }

    // The write path: echo back what the route needs to build its response.
    if (/^INSERT INTO meta_records/.test(flat)) {
      const id = p(0)
      RECORD_ROWS.set(id, { sheet_id: p(1), version: 1, data: JSON.parse(String(params[2] ?? '{}')) })
      return { rows: [{ id, version: 1 }], rowCount: 1 }
    }
    if (/^UPDATE meta_records/.test(flat)) {
      const patch = JSON.parse(String(params[0] ?? '{}'))
      const id = p(1)
      const row = RECORD_ROWS.get(id)
      if (!row) return { rows: [], rowCount: 0 }
      row.version += 1
      row.data = { ...row.data, ...patch }
      return { rows: [{ id, version: row.version, data: row.data }], rowCount: 1 }
    }
    if (/^(INSERT|UPDATE|DELETE)\b/.test(flat)) return { rows: [], rowCount: 1 }

    return { rows: [], rowCount: 0 }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const pool = createFakePool()

// ── actors ────────────────────────────────────────────────────────────────────

/**
 * ANON carries no `req.user` at all. OUTSIDER is authenticated with a permission that is not a
 * multitable code, so every capability is false while the 401 is cleared. EDITOR is an admin role,
 * so it holds `canEditRecord`.
 */
type ActorId = 'ANON' | 'OUTSIDER' | 'EDITOR'
const ACTOR: Record<Exclude<ActorId, 'ANON'>, { id: string; roles: string[]; perms: string[] }> = {
  OUTSIDER: { id: 'u_b5_outsider', roles: ['member'], perms: ['files:read'] },
  EDITOR: { id: 'u_b5_editor', roles: ['admin'], perms: [] },
}

/**
 * ONE app, actor swapped per cell: every cell must be answered by the SAME wiring, so a difference
 * between two cells can only come from the actor or the sheet, never from two routers that drifted.
 */
let currentActor: ActorId = 'ANON'
let app: Express

async function buildApp(): Promise<Express> {
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
    if (currentActor !== 'ANON') (req as any).user = { ...ACTOR[currentActor] }
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  return built
}

// ONE pinned listener for the file (#4154: `request(app)` is banned under tests/unit).
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

const statements = () => sqlLog.map((entry) => entry.sql)

/** Statements of the moved probe's shape, COMPUTED from the recorded log (never hand-listed). */
function existenceProbes(): string[] {
  return statements().filter((sql) => sql.includes(EXISTENCE_PROBE_SQL))
}

/**
 * The request REACHED the handler. Without this a 403 emitted by middleware — or a fixture that
 * answered nothing — could masquerade as a closed oracle.
 *
 * Phrased on the FIRST `meta_sheets` statement rather than on the first statement overall, because
 * `tryResolveView` memoises a found view in a MODULE-level cache (multitable/loaders.ts
 * DEFAULT_VIEW_CACHE): the second request for the same viewId issues no `meta_views` read at all.
 * That cache is product behaviour, and an assertion that depended on it would be a flake.
 */
function expectReachedHandler() {
  const log = statements()
  expect(log.length, 'the request issued no SQL — it never reached the handler').toBeGreaterThan(0)
  const firstSheetStatement = log.find((sql) => sql.includes('meta_sheets'))
  expect(firstSheetStatement, 'no meta_sheets statement was issued').toBeDefined()
  expect(firstSheetStatement, 'the handler asked about existence before liveness').toContain(LIVENESS_SQL)
}

/** No sheet ROW was read on this caller's behalf — the #5839 oracle, expressed as evidence. */
function expectNoSheetRowRead() {
  expect(
    existenceProbes(),
    'a sheet-row existence probe ran for a caller this route refuses — that is the #5839 oracle',
  ).toEqual([])
}

describe('#5839 B5 — sheet-existence oracle on POST /views/:viewId/submit and PATCH /records/:recordId', () => {
  // ══ (a) POST /views/:viewId/submit ══════════════════════════════════════════
  describe('(a) POST /views/:viewId/submit — public form entry', () => {
    const submit = (actor: ActorId, viewId: string, body: Record<string, unknown> = {}) =>
      on(actor).post(`/api/multitable/views/${viewId}/submit`).send({ data: { [FLD_TEXT]: 'x' }, ...body })

    /**
     * ① ANONYMOUS, no usable token. The handler answers 401 BEFORE it looks at any capability, so the
     * LIVE and the DELETED view must be indistinguishable — the view resolves in both cases
     * (`tryResolveView` does not filter liveness), and the sheet ROW is never read for either.
     */
    for (const [label, body] of [
      ['a missing publicToken', {}],
      ['an invalid publicToken', { publicToken: 'not-the-token' }],
    ] as const) {
      it(`① ANON with ${label}: LIVE and DELETED answer the IDENTICAL 401, and no sheet row is read`, async () => {
        const live = await submit('ANON', VIEW_ON_LIVE, body)
        const liveProbes = existenceProbes()
        const liveLog = statements()
        const deleted = await submit('ANON', VIEW_ON_DELETED, body)

        expect(live.status).toBe(401)
        expect(live.body).toEqual(UNAUTHENTICATED_BODY)
        expect(deleted.status).toBe(live.status)
        expect(deleted.body).toEqual(live.body)
        // Byte-identity, not merely deep equality: the wire form is what a caller observes.
        expect(deleted.text).toBe(live.text)

        expect(liveProbes, 'LIVE leaked a sheet-row read before the 401').toEqual([])
        expectNoSheetRowRead()
        // …and the request really did reach the handler in both cases.
        expect(liveLog.length).toBeGreaterThan(0)
        expect(liveLog.find((sql) => sql.includes('meta_sheets'))).toContain(LIVENESS_SQL)
        expectReachedHandler()
      })
    }

    /**
     * ② LOGGED IN, zero capability. Past the 401, refused by `canCreateRecord` — again the same
     * answer for both livenesses, and still no sheet row.
     */
    it('② OUTSIDER (logged in, no capability): LIVE and DELETED answer the IDENTICAL 403, and no sheet row is read', async () => {
      const live = await submit('OUTSIDER', VIEW_ON_LIVE)
      const liveProbes = existenceProbes()
      const deleted = await submit('OUTSIDER', VIEW_ON_DELETED)

      expect(live.status).toBe(403)
      expect(live.body).toEqual(FORBIDDEN_BODY)
      expect(deleted.status).toBe(live.status)
      expect(deleted.text).toBe(live.text)

      expect(liveProbes).toEqual([])
      expectNoSheetRowRead()
      expectReachedHandler()
    })

    /**
     * ③ The path that MAY write. On LIVE it must still get everything the response needs from the
     * moved `loadSheetRow` (`sheet.baseId` / `sheet.id` → commentsScope); on DELETED the refusal is
     * the values-free liveness 404 — closing the oracle did not open a hole.
     */
    it('③ a valid publicToken on LIVE: 200 with commentsScope built from the sheet row (read AFTER authority)', async () => {
      const res = await submit('ANON', VIEW_ON_LIVE, { publicToken: PUBLIC_TOKEN })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      // EXACT, not partial: a field ADDED to this scope (a leaked ownerId, a tenant id) must red here
      // too, exactly as it does on the PATCH side. The record id is generated, so it is read back from
      // the response's own `record` rather than hand-fixed — the assertion is still a total one.
      const newRecordId = res.body.data?.record?.id
      expect(typeof newRecordId, 'the submit response carried no record id').toBe('string')
      expect(res.body.data?.commentsScope).toEqual({
        targetType: 'meta_record',
        targetId: newRecordId,
        baseId: BASE_ID,
        sheetId: SHEET_LIVE,
        viewId: VIEW_ON_LIVE,
        recordId: newRecordId,
        containerType: 'meta_sheet',
        containerId: SHEET_LIVE,
      })
      // The probe did not vanish, it MOVED: on the one path that gets past authority it runs, and it
      // runs AFTER the liveness resolution.
      const log = statements()
      const probeIndex = log.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      const livenessIndex = log.findIndex((sql) => sql.includes(LIVENESS_SQL))
      expect(probeIndex, 'the sheet row was never read on the success path').toBeGreaterThanOrEqual(0)
      expect(livenessIndex).toBeGreaterThanOrEqual(0)
      expect(probeIndex, 'the existence probe must run AFTER the liveness resolution').toBeGreaterThan(livenessIndex)
    })

    it('③ a valid publicToken on DELETED: 404 SHEET_DELETED, values-free, and still no sheet row read', async () => {
      const res = await submit('ANON', VIEW_ON_DELETED, { publicToken: PUBLIC_TOKEN })

      expect(res.status).toBe(404)
      expect(res.body).toEqual(SHEET_DELETED_BODY)
      expect(JSON.stringify(res.body), 'the refusal echoed the requested id back').not.toContain(SHEET_DELETED)
      expectNoSheetRowRead()
      expectReachedHandler()
    })

    /**
     * ③ THE RACE, and the only reachable proof that the MOVED 404 is values-free. The probe now
     * sits after the liveness resolution, so its miss can only mean "the sheet was deleted between
     * the two reads". Staged here (see SHEET_RACE) because an unreachable branch cannot be pinned,
     * and an unpinned message is exactly how the id crept back in the first place.
     */
    it('③ the MOVED probe’s own 404 (delete-in-between race) is values-free — it never echoes the sheet id', async () => {
      const res = await submit('ANON', VIEW_ON_RACE, { publicToken: PUBLIC_TOKEN })

      expect(res.status).toBe(404)
      expect(res.body).toEqual(SHEET_NOT_FOUND_BODY)
      expect(res.text, 'the relocated 404 echoed the sheet id back').not.toContain(SHEET_RACE)
      // It really is the relocated probe: liveness passed (the resolver said `live`) and the row read
      // that follows it came back empty.
      const log = statements()
      const livenessIndex = log.findIndex((sql) => sql.includes(LIVENESS_SQL))
      const probeIndex = log.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      expect(livenessIndex).toBeGreaterThanOrEqual(0)
      expect(probeIndex).toBeGreaterThan(livenessIndex)
    })

    /**
     * ④ THE NAMED RESIDUAL (#5908). The VIEW probe stays ahead of authority because the view is an
     * authorisation input. An ABSENT sheet cannot carry a real view, so it is answered by the same
     * `View not found` 404 as a bad viewId — that collapse is the residual, and this cell is what
     * will red if someone later makes the two answers differ.
     */
    it('④ residual #5908: a nonexistent view answers 404 View-not-found, ahead of authority — for ANON and OUTSIDER alike', async () => {
      const anon = await submit('ANON', VIEW_ABSENT)
      const anonLog = statements()
      const outsider = await submit('OUTSIDER', VIEW_ABSENT)

      for (const res of [anon, outsider]) {
        expect(res.status).toBe(404)
        expect(res.body).toEqual({
          ok: false,
          error: { code: 'NOT_FOUND', message: `View not found: ${VIEW_ABSENT}` },
        })
      }
      // Ahead of authority: the ONLY statement issued is the view lookup — no liveness read, no
      // capability resolution, no sheet row. This is the shape #5908 tracks.
      expect(anonLog.length).toBe(1)
      expect(anonLog[0]).toContain('FROM meta_views')
      expectNoSheetRowRead()
    })

    /**
     * ⑤ THE ABSENT ARM, and the #5908 premise held to BEHAVIOUR rather than to a constraint. The FK
     * cited in the header means a view on an absent sheet cannot exist; this cell stages one anyway
     * and shows the oracle stays closed either way — every REFUSED caller class gets byte-identically
     * what it gets on a LIVE sheet, and the one caller that gets PAST authority is answered by the
     * values-free liveness 404, never by a row probe.
     */
    it('⑤ #5908 premise, held to behaviour: a DANGLING view (sheet row absent) changes no refused caller’s answer', async () => {
      const anonLive = await submit('ANON', VIEW_ON_LIVE)
      const anonDangling = await submit('ANON', VIEW_DANGLING)
      const anonDanglingProbes = existenceProbes()
      const outsiderLive = await submit('OUTSIDER', VIEW_ON_LIVE)
      const outsiderDangling = await submit('OUTSIDER', VIEW_DANGLING)
      const outsiderDanglingProbes = existenceProbes()

      expect(anonLive.status).toBe(401)
      expect(anonDangling.status).toBe(anonLive.status)
      expect(anonDangling.text, 'an anonymous caller can tell an absent sheet from a live one').toBe(anonLive.text)
      expect(outsiderLive.status).toBe(403)
      expect(outsiderDangling.status).toBe(outsiderLive.status)
      expect(outsiderDangling.text, 'a zero-capability caller can tell an absent sheet from a live one').toBe(outsiderLive.text)
      expect(anonDanglingProbes).toEqual([])
      expect(outsiderDanglingProbes).toEqual([])

      // …and the caller that DOES clear authority gets the values-free liveness 404, not a row-probe 404.
      const authorised = await submit('ANON', VIEW_DANGLING, { publicToken: PUBLIC_TOKEN })
      expect(authorised.status).toBe(404)
      expect(authorised.body).toEqual(SHEET_NOT_FOUND_BODY)
      expect(authorised.text, 'the refusal echoed the absent sheet id back').not.toContain(SHEET_ABSENT)
      expectNoSheetRowRead()
    })
  })

  // ══ (b) PATCH /records/:recordId ════════════════════════════════════════════
  describe('(b) PATCH /records/:recordId', () => {
    const patch = (actor: ActorId, recordId: string, body: Record<string, unknown>) =>
      on(actor).patch(`/api/multitable/records/${recordId}`).send({ data: { [FLD_TEXT]: 'after' }, ...body })

    /**
     * ① With a body `sheetId`, the caller names the sheet. A caller without `canEditRecord` must get
     * the SAME 403 whether that sheet is live or soft-deleted, and no sheet row may be read.
     * The record row IS read first (residual #5911) — it exists for both sheets in this fixture, so
     * the 403 cannot be an artefact of a missing record.
     */
    it('① OUTSIDER with a body sheetId: LIVE and DELETED answer the IDENTICAL 403, and no sheet row is read', async () => {
      const live = await patch('OUTSIDER', REC_ON_LIVE, { sheetId: SHEET_LIVE })
      const liveProbes = existenceProbes()
      const liveLog = statements()
      const deleted = await patch('OUTSIDER', REC_ON_DELETED, { sheetId: SHEET_DELETED })

      expect(live.status).toBe(403)
      expect(live.body).toEqual(FORBIDDEN_BODY)
      expect(deleted.status).toBe(live.status)
      expect(deleted.text).toBe(live.text)

      expect(liveProbes).toEqual([])
      expectNoSheetRowRead()
      // Handler-reached self-check: the FIRST statement is the record probe (#5911), not middleware.
      expect(liveLog[0]).toContain(RECORD_PROBE_SCOPED_SQL)
    })

    /**
     * ① (residual #5911, pinned) An ABSENT sheet is NOT distinguishable through this probe: the
     * scoped lookup yields zero rows, exactly as it does for a LIVE sheet asked about a recordId that
     * is not on it. Asserted as ONE equality so the two answers cannot drift apart silently, and the
     * probe's SQL shape is pinned in the same cell — widening it to `WHERE id = $1` would make the
     * ABSENT case answer differently and IS the thing this assertion forbids.
     */
    it('① residual #5911: ABSENT sheet and LIVE sheet answer a byte-identical Record-not-found, and the probe stays sheet-scoped', async () => {
      const absent = await patch('OUTSIDER', REC_NOWHERE, { sheetId: SHEET_ABSENT })
      const absentLog = statements()
      const liveMiss = await patch('OUTSIDER', REC_NOWHERE, { sheetId: SHEET_LIVE })

      expect(absent.status).toBe(404)
      expect(absent.body).toEqual(recordNotFoundBody(REC_NOWHERE))
      expect(liveMiss.status).toBe(absent.status)
      expect(liveMiss.text, 'ABSENT and LIVE-with-a-foreign-record answer differently — that is a sheet oracle').toBe(absent.text)

      // The same holds for a record that really exists, just not on the queried sheet.
      const absentReal = await patch('OUTSIDER', REC_ON_DELETED, { sheetId: SHEET_ABSENT })
      const liveReal = await patch('OUTSIDER', REC_ON_DELETED, { sheetId: SHEET_LIVE })
      expect(absentReal.status).toBe(404)
      expect(liveReal.text).toBe(absentReal.text)

      // SQL SHAPE, pinned: the probe is scoped by BOTH ids, which is what makes ABSENT indistinguishable.
      const probe = sqlLog.find((entry) => entry.sql.startsWith('SELECT id, sheet_id FROM meta_records'))
      expect(probe?.sql).toBe(RECORD_PROBE_SCOPED_SQL)
      expect(probe?.params).toEqual([REC_ON_DELETED, SHEET_LIVE])
      // And the ABSENT request never read a sheet row either.
      expect(absentLog.filter((sql) => sql.includes(EXISTENCE_PROBE_SQL))).toEqual([])
      expectNoSheetRowRead()
    })

    /**
     * ② Without `sheetId`/`viewId` the record probe is the only way to learn the target sheet, so it
     * necessarily runs first. Capability is then judged on the record's OWN sheet — and the refusal
     * is again identical across livenesses.
     */
    it('② OUTSIDER without sheetId/viewId: capability is judged on the record’s sheet — identical 403 for LIVE and DELETED', async () => {
      const live = await patch('OUTSIDER', REC_ON_LIVE, {})
      const liveProbes = existenceProbes()
      const liveLog = statements()
      const deleted = await patch('OUTSIDER', REC_ON_DELETED, {})

      expect(live.status).toBe(403)
      expect(live.body).toEqual(FORBIDDEN_BODY)
      expect(deleted.text).toBe(live.text)

      // Both halves carry the evidence assertion: `expectNoSheetRowRead` only sees the DELETED
      // request's log, so without this a probe that ran on the LIVE branch alone would be left to the
      // text-identity assertion to catch.
      expect(liveProbes).toEqual([])
      expectNoSheetRowRead()
      // The unscoped probe ran first, and the liveness read that followed named the record's sheet.
      expect(liveLog[0]).toBe(RECORD_PROBE_UNSCOPED_SQL)
      const liveness = sqlLog.find((entry) => entry.sql.includes(LIVENESS_SQL))
      expect(liveness?.params).toEqual([SHEET_DELETED])
    })

    it('② OUTSIDER without sheetId/viewId, record missing: 404 Record not found, before any authority work', async () => {
      const res = await patch('OUTSIDER', REC_NOWHERE, {})

      expect(res.status).toBe(404)
      expect(res.body).toEqual(recordNotFoundBody(REC_NOWHERE))
      expect(statements()).toEqual([RECORD_PROBE_UNSCOPED_SQL])
      expectNoSheetRowRead()
    })

    /**
     * ③ The path that MAY write, on a LIVE sheet: unchanged behaviour, including a commentsScope
     * whose baseId / sheetId / containerId come from the MOVED `loadSheetRow`. If the move had lost
     * the row, this is the cell that would red.
     */
    it('③ EDITOR on LIVE: the PATCH succeeds and commentsScope still carries baseId / sheetId / containerId from the sheet row', async () => {
      const res = await patch('EDITOR', REC_ON_LIVE, { sheetId: SHEET_LIVE })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data?.commentsScope).toEqual({
        targetType: 'meta_record',
        targetId: REC_ON_LIVE,
        baseId: BASE_ID,
        sheetId: SHEET_LIVE,
        viewId: null,
        recordId: REC_ON_LIVE,
        containerType: 'meta_sheet',
        containerId: SHEET_LIVE,
      })
      const log = statements()
      const probeIndex = log.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      const livenessIndex = log.findIndex((sql) => sql.includes(LIVENESS_SQL))
      expect(probeIndex, 'the sheet row was never read on the success path').toBeGreaterThanOrEqual(0)
      expect(probeIndex, 'the existence probe must run AFTER the liveness resolution').toBeGreaterThan(livenessIndex)
    })

    /**
     * ③ …and the liveness refusal it now sits behind still fires: an EDITOR (who clears the 403) is
     * told the sheet is gone, values-free, without the sheet row being read.
     */
    it('③ EDITOR on DELETED: 404 SHEET_DELETED, values-free, sheet row still unread', async () => {
      const res = await patch('EDITOR', REC_ON_DELETED, { sheetId: SHEET_DELETED })

      expect(res.status).toBe(404)
      expect(res.body).toEqual(SHEET_DELETED_BODY)
      expect(JSON.stringify(res.body)).not.toContain(SHEET_DELETED)
      expectNoSheetRowRead()
      expect(statements()[0]).toContain(RECORD_PROBE_SCOPED_SQL)
    })

    /**
     * ③ The same race on this route: `canEditRecord` and liveness both passed, and the relocated
     * row read then found nothing. Values-free, and the only cell that can reach this branch.
     */
    it('③ EDITOR on the RACE sheet: the MOVED probe’s 404 is values-free — it never echoes the sheet id', async () => {
      const res = await patch('EDITOR', REC_ON_RACE, { sheetId: SHEET_RACE })

      expect(res.status).toBe(404)
      expect(res.body).toEqual(SHEET_NOT_FOUND_BODY)
      expect(res.text, 'the relocated 404 echoed the sheet id back').not.toContain(SHEET_RACE)
      const log = statements()
      const livenessIndex = log.findIndex((sql) => sql.includes(LIVENESS_SQL))
      const probeIndex = log.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      expect(livenessIndex).toBeGreaterThanOrEqual(0)
      expect(probeIndex).toBeGreaterThan(livenessIndex)
    })

    /**
     * ④ The SECOND id-bearing 404 this batch made values-free. `buildRecordPatchContext` returns
     * null when the sheet carries no fields, and the body used to echo the resolved sheet id back.
     * It already sat behind the 401/403/liveness triple, so it is reachable only by an authorised
     * caller - but it is the same value the moved probe stopped leaking, so it goes too.
     *
     * Reached here for real (a LIVE, schema-less sheet), not asserted against the source text: an
     * in-memory mutation that restores `Sheet not found: ${sheetId}` must be able to turn this red.
     */
    it('④ values-free: the buildRecordPatchContext 404 answers `Sheet not found` without the sheet id', async () => {
      const res = await patch('EDITOR', REC_ON_NOFIELDS, { sheetId: SHEET_LIVE_NOFIELDS })

      expect(res.status).toBe(404)
      expect(res.body).toEqual(SHEET_NOT_FOUND_BODY)
      expect(res.text, 'the refusal echoed the requested sheet id back').not.toContain(SHEET_LIVE_NOFIELDS)
      // It really is the post-authority branch: the sheet row WAS read (the move put it here), and the
      // liveness read came first.
      const log = statements()
      const probeIndex = log.findIndex((sql) => sql.includes(EXISTENCE_PROBE_SQL))
      const livenessIndex = log.findIndex((sql) => sql.includes(LIVENESS_SQL))
      expect(probeIndex).toBeGreaterThan(livenessIndex)
    })

    /**
     * ④ HANDLER-REACHED self-check, stated once as its own cell: for every body shape the FIRST
     * statement this route issues is the record probe (#5911), and the capability resolution follows
     * it. Nothing here can be satisfied by a middleware refusal.
     */
    it('④ self-check: the first statement is always the record probe, and the liveness read follows it', async () => {
      await patch('OUTSIDER', REC_ON_LIVE, { sheetId: SHEET_LIVE })
      const scoped = statements()
      expect(scoped[0]).toBe(RECORD_PROBE_SCOPED_SQL)
      expect(scoped.findIndex((sql) => sql.includes(LIVENESS_SQL))).toBeGreaterThan(0)

      await patch('OUTSIDER', REC_ON_LIVE, {})
      const unscoped = statements()
      expect(unscoped[0]).toBe(RECORD_PROBE_UNSCOPED_SQL)
      expect(unscoped.findIndex((sql) => sql.includes(LIVENESS_SQL))).toBeGreaterThan(0)
    })

    /**
     * ⑤ THE OTHER pre-authority step, named so the residual list is exhaustive (#5911). When the body
     * carries `sheetId`/`viewId`, `resolveMetaSheetId` runs ABOVE the record probe; a viewId that
     * belongs to a DIFFERENT sheet throws `ConflictError`, for which the catch has no branch, so the
     * caller gets the generic 500 instead of the 404 an unknown viewId leads to. That difference turns
     * on `view.sheetId !== sheetId` ALONE: this cell pins that the three sheet states are still
     * indistinguishable through it, which is what keeps it out of the #5839 oracle. If someone ever
     * makes this step answer differently for a live / soft-deleted / absent sheet, this reds.
     */
    it('⑤ residual: the pre-authority resolveMetaSheetId answers identically for LIVE, DELETED and ABSENT', async () => {
      const answers: Array<{ status: number; text: string }> = []
      for (const sheetId of [SHEET_LIVE, SHEET_DELETED, SHEET_ABSENT]) {
        // The viewId belongs to a FOURTH sheet, so the mismatch is the same for all three ids and the
        // only thing varying across the loop is the liveness of the sheet the caller named.
        const res = await patch('OUTSIDER', REC_ON_LIVE, { sheetId, viewId: VIEW_ON_NOFIELDS })
        expect(res.text, 'the pre-authority resolution echoed a sheet id back').not.toContain(sheetId)
        answers.push({ status: res.status, text: res.text })
      }
      expect(
        answers.map((a) => `${a.status} ${a.text}`),
        'the pre-authority sheetId/viewId resolution distinguishes the three sheet states — that would be a #5839 oracle',
      ).toEqual([`${answers[0].status} ${answers[0].text}`, `${answers[0].status} ${answers[0].text}`, `${answers[0].status} ${answers[0].text}`])
      expectNoSheetRowRead()
    })
  })
})

