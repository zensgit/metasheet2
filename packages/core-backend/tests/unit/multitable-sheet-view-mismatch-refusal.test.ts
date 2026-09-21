/**
 * #5946 — VIEW/SHEET MISMATCH on univer-meta: one values-free 404 for all ten callers.
 *
 * ── What used to happen ───────────────────────────────────────────────────────
 * `resolveMetaSheetId` (routes/univer-meta.ts) throws `ConflictError` when a request names BOTH a
 * `sheetId` and a `viewId` and the view resolves to a DIFFERENT sheet. Ten routes call it and the
 * class was answered two wrong ways:
 *
 *   SEVEN had no branch for it — GET /context, POST /dashboard/query, GET /form-context,
 *   PATCH /records/:recordId, POST /records, POST /records/:recordId/duplicate,
 *   POST /records/:recordId/lock — so a mistyped address fell through to the handler's generic
 *   hardcoded 500. Values-free, but the wrong class: the caller cannot tell a bad address from a
 *   broken server, and every such request is logged as a server fault.
 *
 *   THREE caught it and answered `409 CONFLICT` with `err.message` — GET /view,
 *   GET /records/:recordId, POST /patch. That message is
 *   `View <viewId> does not belong to sheet <sheetId>`: the refusal pasted BOTH ids back onto the
 *   wire, which is exactly what the values-free refusal discipline forbids.
 *
 * Both are now answered by `orRefuseSheetViewMismatch` — the ONE wrapper, defined next to the
 * resolver — with the SAME body `sendSheetNotLive(res, 'absent')` emits (multitable/sheet-refusals.ts).
 *
 * ── What this file pins ───────────────────────────────────────────────────────
 *  1. ALL TEN routes answer a cross-sheet viewId with that exact 404 body, and no cell's response
 *     bytes contain any id the request carried. The route table below is asserted to be the same
 *     size as the number of wrapper calls in the source, so an eleventh caller cannot land without
 *     a cell here.
 *
 *     NINE of them answer it to ANY authenticated caller: their pairing check runs before any
 *     authority gate, so the refusal is about the address and identical for a caller that holds
 *     nothing and for an admin. GET /context is the TENTH and is DIFFERENT, by #5948's design: its
 *     pairing check sits BEHIND the #5936 authority gate, so a caller with no read grant is refused
 *     403 first — identically for a foreign view, a missing view and no view at all, with
 *     `meta_views` never consulted — and only a caller that PASSES the gate sees this 404. #5946
 *     changes the CLASS of that post-gate answer (it was the handler's generic 500) and nothing
 *     about the ORDER. Both halves are pinned: the 403 half in the "#5948 order" describe, the 404
 *     half in the route loop with the MANAGER actor.
 *  2. The three previously-echoing routes no longer answer 409, and no longer carry a `CONFLICT`
 *     code or the resolver's message.
 *  3. THE INVARIANT #5839 B5 left behind: on PATCH /records/:recordId and GET /view a mismatched view
 *     answers BYTE-IDENTICALLY whether the named sheet is LIVE, soft-DELETED or ABSENT. The refusal
 *     must not become a new existence oracle — the difference the caller can observe has to stay on
 *     `view.sheetId !== sheetId` alone. On GET /context the same statement holds for the caller that
 *     may NOT know (all three states answer one 403), and is asserted there instead.
 *  4. Attribution: the same request with a view that DOES belong to the named sheet gets a
 *     DIFFERENT answer, so the 404 above is caused by the mismatch and not by the fixture.
 *  5. Structurally: every `resolveMetaSheetId(` in univer-meta.ts is the definition, a call written
 *     in the wrapped form, or THE ONE allow-listed raw call (GET /context's pre-gate `sheetId: null`
 *     resolution, which cannot throw ConflictError and must stay above the gate); every wrapped call
 *     `return`s on the null it can get back, checked against ITS OWN binding; no `ConflictError`
 *     branch outside a named allow-list echoes `err.message`, keyed by the enclosing route or
 *     FUNCTION rather than by "somewhere above the router" — and the wrapped form still names the
 *     resolver, so the sheet-liveness closure guard keeps every one of these handlers (GET /context
 *     is in ITS scope for that token alone, asserted rather than asserted in prose).
 *
 * ── Why the ABSENT body and not a new code ────────────────────────────────────
 * A dedicated code would have to be emitted identically for a live, a soft-deleted and an absent
 * sheet, or it becomes the #5908-family oracle: a caller who may not read the sheet would learn
 * from the refusal that the viewId is real and lives somewhere else. The absent refusal is the body
 * every one of these routes already emits for an address it cannot serve, it carries no value, and
 * it is produced by the shared helper rather than copied — so it cannot drift away from the liveness
 * 404s it has to stay equal to.
 *
 * ── Fixture ───────────────────────────────────────────────────────────────────
 * Mock pool, no DB. The three refusal bodies come from tests/utils/sheet-existence-oracle.ts, which
 * CALLS the real `sendForbidden` / `sendSheetNotLive` against a capture double — a product body that
 * changes must not leave a hand-typed green copy behind here.
 *
 * `tryResolveView` memoises a found view in a module-level cache (multitable/loaders.ts), so the
 * SECOND request for the same viewId issues no view read at all. No route cell asserts a read count
 * for that reason; reach evidence there is the EXACT-BODY equality (an express default 404 is HTML
 * and cannot pass it) together with the per-route attribution cell. The ONE cell that does assert
 * "meta_views was never read" — the #5948 order describe — addresses a viewId used nowhere else in
 * the file, so the cache is cold when it runs, and pairs the assertion with a positive control on
 * the same id, so a warm cache would red it instead of greening it.
 */
import express, { type Express, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import { FORBIDDEN, FORBIDDEN_STATUS, SHEET_ABSENT_BODY, SHEET_NOT_LIVE_STATUS } from '../utils/sheet-existence-oracle'

// ── ids ───────────────────────────────────────────────────────────────────────

/** Exists, `deleted_at IS NULL`. */
const SHEET_LIVE = 'sht_5946_live'
/** Exists, soft-deleted. */
const SHEET_DELETED = 'sht_5946_deleted'
/** No `meta_sheets` row at all. */
const SHEET_ABSENT = 'sht_5946_absent'
/** The sheet the mismatched view really belongs to — never addressed by a request. */
const SHEET_OTHER = 'sht_5946_other'
/** The three states a mismatch refusal must not be able to tell apart. */
const SHEET_STATES = [SHEET_LIVE, SHEET_DELETED, SHEET_ABSENT] as const

/** THE VIEW UNDER TEST: it exists, and it belongs to `SHEET_OTHER`. */
const VIEW_ELSEWHERE = 'viw_5946_elsewhere'
/** The control: a view that really does belong to `SHEET_LIVE`. */
const VIEW_ON_LIVE = 'viw_5946_on_live'
/**
 * A SECOND cross-sheet view, addressed by exactly one cell — the one that asserts `meta_views` is
 * never read for the caller GET /context refuses. `tryResolveView` memoises found views in a
 * module-level cache (multitable/loaders.ts), so a viewId any earlier cell already resolved issues
 * no query on a later request and that assertion would pass for the WRONG reason. This id is used
 * nowhere else in the file, so its cache entry is cold when that cell runs.
 */
const VIEW_ELSEWHERE_UNCACHED = 'viw_5946_elsewhere_uncached'

const BASE_ID = 'base_5946'
const FLD_TEXT = 'fld_5946_text'
const REC_ON_LIVE = 'rec_5946_on_live'

/** Every id a request carries. No refusal body may contain any of them. */
const REQUEST_IDS = [...SHEET_STATES, VIEW_ELSEWHERE, VIEW_ELSEWHERE_UNCACHED, VIEW_ON_LIVE] as const

// ── the refusal under test ────────────────────────────────────────────────────

/** Captured from the real `sendSheetNotLive(res, 'absent')`, never hand-typed. */
const MISMATCH_BODY = SHEET_ABSENT_BODY
const MISMATCH_STATUS = SHEET_NOT_LIVE_STATUS

/** What the three echoing routes used to answer, kept here only to assert it is GONE. */
const OLD_ECHO_STATUS = 409
const OLD_ECHO_CODE = 'CONFLICT'
const oldEchoMessage = (viewId: string, sheetId: string) => `View ${viewId} does not belong to sheet ${sheetId}`

// ── fake pool ─────────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }

const SHEET_STATE = new Map<string, { deleted_at: string | null }>([
  [SHEET_LIVE, { deleted_at: null }],
  [SHEET_OTHER, { deleted_at: null }],
  [SHEET_DELETED, { deleted_at: '2026-09-19T00:00:00.000Z' }],
])

const viewRow = (id: string, sheetId: string) => ({
  id,
  sheet_id: sheetId,
  name: 'Grid',
  type: 'grid',
  hidden_field_ids: [],
  filter_info: null,
  sort_info: null,
  group_info: null,
  row_height: null,
  config: {},
})

const VIEW_ROWS = new Map<string, ReturnType<typeof viewRow>>([
  [VIEW_ELSEWHERE, viewRow(VIEW_ELSEWHERE, SHEET_OTHER)],
  [VIEW_ELSEWHERE_UNCACHED, viewRow(VIEW_ELSEWHERE_UNCACHED, SHEET_OTHER)],
  [VIEW_ON_LIVE, viewRow(VIEW_ON_LIVE, SHEET_LIVE)],
])

const RECORD_ROWS = new Map<string, { sheet_id: string; version: number; data: Record<string, unknown> }>([
  [REC_ON_LIVE, { sheet_id: SHEET_LIVE, version: 1, data: { [FLD_TEXT]: 'before' } }],
])

const FIELD_ROWS = [{ id: FLD_TEXT, name: 'Text', type: 'string', property: {}, order: 0 }]

const sqlLog: string[] = []

/**
 * Unlisted SQL answers an empty result set rather than throwing: no cell can be made to pass by a
 * fixture error, because every cell asserts an EXACT status and an EXACT body.
 */
function createFakePool() {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const flat = sql.replace(/\s+/g, ' ').trim()
    sqlLog.push(flat)
    const p = (i: number) => String(params?.[i] ?? '')

    if (flat.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      const state = SHEET_STATE.get(p(0))
      return { rows: state ? [{ deleted_at: state.deleted_at }] : [] }
    }
    if (flat.includes('FROM meta_sheets') && flat.includes('= ANY(')) return { rows: [] }
    if (flat.includes('FROM meta_sheets') && flat.includes('WHERE s.id = $1')) {
      const state = SHEET_STATE.get(p(0))
      if (!state || state.deleted_at !== null) return { rows: [] }
      return { rows: [{ id: p(0), base_id: BASE_ID, name: '5946', description: null, base_ref_id: BASE_ID, base_name: '5946', base_icon: null, base_color: null, base_owner_id: null, base_workspace_id: null }] }
    }
    if (flat.includes('FROM meta_sheets') && flat.includes('WHERE id = $1')) {
      const state = SHEET_STATE.get(p(0))
      if (!state || state.deleted_at !== null) return { rows: [] }
      return { rows: [{ id: p(0), base_id: BASE_ID, name: '5946', description: null }] }
    }
    if (flat.includes('FROM meta_views') && flat.includes('WHERE id = $1')) {
      const row = VIEW_ROWS.get(p(0))
      return { rows: row ? [{ ...row }] : [] }
    }
    if (flat.includes('FROM meta_views') && flat.includes('sheet_id = $1')) {
      return { rows: [...VIEW_ROWS.values()].filter((v) => v.sheet_id === p(0)).map((v) => ({ ...v })) }
    }
    if (flat.includes('FROM meta_records') && flat.includes('WHERE id = $1')) {
      const row = RECORD_ROWS.get(p(0))
      if (!row || (params.length > 1 && row.sheet_id !== p(1))) return { rows: [] }
      return { rows: [{ id: p(0), sheet_id: row.sheet_id, version: row.version, data: row.data, created_by: null, locked: false, locked_by: null, locked_at: null }] }
    }
    if (flat.includes('FROM meta_fields') && flat.includes('WHERE sheet_id = $1')) {
      return { rows: FIELD_ROWS.map((f) => ({ ...f })) }
    }
    if (flat.includes('FROM meta_bases')) {
      return { rows: p(0) === BASE_ID ? [{ id: BASE_ID, name: '5946', workspace_id: null }] : [] }
    }
    if (/^(INSERT|UPDATE|DELETE)/.test(flat)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const pool = createFakePool()

// ── actors ────────────────────────────────────────────────────────────────────

/**
 * OUTSIDER is AUTHENTICATED (so the 401 that several of these routes answer first is cleared) and
 * holds a permission that grants no multitable capability — the caller class these routes refuse.
 * The mismatch refusal is pre-authority, so it must reach this actor too; MANAGER (admin) proves the
 * same answer is not an authority refusal wearing a 404.
 */
type ActorId = 'OUTSIDER' | 'MANAGER'
const ACTOR: Record<ActorId, { id: string; roles: string[]; perms: string[] }> = {
  OUTSIDER: { id: 'u_5946_outsider', roles: ['member'], perms: ['files:read'] },
  MANAGER: { id: 'u_5946_manager', roles: ['admin'], perms: [] },
}

let currentActor: ActorId = 'OUTSIDER'
let app: Express

/**
 * ONE app for the behaviour cells, actor swapped per request: a difference between two cells can
 * then only come from the request, never from two routers that drifted apart.
 *
 * `refusalOverride` exists for the MUTATION PROBES at the bottom, which rebuild the module graph with
 * `sendSheetNotLive` swapped for what main answered before this fix. Nothing is written to disk.
 */
async function buildApp(refusalOverride?: (res: Response) => unknown): Promise<Express> {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  if (refusalOverride) {
    vi.doMock('../../src/multitable/sheet-refusals', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/multitable/sheet-refusals')>()
      return { ...actual, sendSheetNotLive: (res: Response) => refusalOverride(res) }
    })
  } else {
    vi.doUnmock('../../src/multitable/sheet-refusals')
  }

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

// ONE pinned listener for the file (#4154: `request(app)` is banned under tests/unit).
const pinned = usePinnedServer()

function on(actor: ActorId = 'OUTSIDER') {
  sqlLog.length = 0
  currentActor = actor
  pinned.setApp(app)
  return request(pinned.url())
}

beforeAll(async () => {
  app = await buildApp()
})

// ── the ten callers ───────────────────────────────────────────────────────────

const WIDGET = { title: 'w', chartType: 'bar' as const, groupByFieldId: FLD_TEXT, metric: 'count' as const }

interface RouteCase {
  /** Method + path as mounted, used as the cell name. */
  name: string
  /** True for the three that answered `409 CONFLICT` with the resolver's message before #5946. */
  previouslyEchoed: boolean
  /**
   * The actors that REACH the mismatch refusal on this route. Nine routes run the pairing check
   * before any authority gate, so both actors reach it and the refusal must be identical for both.
   * GET /context is the exception and the reason is named in `RESTRICTED_REACH` below — #5948 put an
   * authority gate in FRONT of its pairing check on purpose, so an unauthorised caller never gets
   * that far. Its 403 is pinned in its own describe rather than dropped.
   */
  reachedBy?: ActorId[]
  send: (agent: ReturnType<typeof request>, sheetId: string, viewId: string) => request.Test
}

/**
 * The ONE route whose reach is restricted, and why. Kept as data so the self-check cell below can
 * assert the exception did not spread: a route that quietly grows an authority gate in front of its
 * refusal has to be added here with a reason.
 */
const RESTRICTED_REACH: Record<string, { reachedBy: ActorId[]; why: string }> = {
  'GET /context': {
    reachedBy: ['MANAGER'],
    why: '#5948 moved this handler\'s sheetId+viewId pairing check BEHIND its #5936 authority gate, so a '
      + 'caller with no read grant is refused 403 before `meta_views` is consulted at all. That order is '
      + 'the fix for the view→sheet scan oracle and #5946 must not undo it: the values-free 404 is what '
      + 'a caller that PASSES the gate now sees instead of the old 500. The 403 half is pinned by the '
      + '"#5948 order" describe below.',
  },
}

const reachOf = (route: RouteCase): ActorId[] => route.reachedBy ?? ['OUTSIDER', 'MANAGER']

/**
 * Every wrapped `resolveMetaSheetId` call site in routes/univer-meta.ts, one row each. The structural
 * cell at the bottom asserts this table has exactly as many rows as the source has wrapper calls, so
 * a route added to the wrapper without a row here reds.
 */
const ROUTES: RouteCase[] = [
  {
    name: 'GET /context',
    previouslyEchoed: false,
    reachedBy: RESTRICTED_REACH['GET /context'].reachedBy,
    send: (a, sheetId, viewId) => a.get('/api/multitable/context').query({ sheetId, viewId }),
  },
  {
    name: 'POST /dashboard/query',
    previouslyEchoed: false,
    send: (a, sheetId, viewId) => a.post('/api/multitable/dashboard/query').send({ sheetId, viewId, widgets: [WIDGET] }),
  },
  {
    name: 'GET /view',
    previouslyEchoed: true,
    send: (a, sheetId, viewId) => a.get('/api/multitable/view').query({ sheetId, viewId }),
  },
  {
    name: 'GET /form-context',
    previouslyEchoed: false,
    send: (a, sheetId, viewId) => a.get('/api/multitable/form-context').query({ sheetId, viewId }),
  },
  {
    name: 'PATCH /records/:recordId',
    previouslyEchoed: false,
    send: (a, sheetId, viewId) => a.patch(`/api/multitable/records/${REC_ON_LIVE}`).send({ sheetId, viewId, data: { [FLD_TEXT]: 'after' } }),
  },
  {
    name: 'GET /records/:recordId',
    previouslyEchoed: true,
    send: (a, sheetId, viewId) => a.get(`/api/multitable/records/${REC_ON_LIVE}`).query({ sheetId, viewId }),
  },
  {
    name: 'POST /records',
    previouslyEchoed: false,
    send: (a, sheetId, viewId) => a.post('/api/multitable/records').send({ sheetId, viewId, data: { [FLD_TEXT]: 'new' } }),
  },
  {
    name: 'POST /records/:recordId/duplicate',
    previouslyEchoed: false,
    send: (a, sheetId, viewId) => a.post(`/api/multitable/records/${REC_ON_LIVE}/duplicate`).send({ sheetId, viewId }),
  },
  {
    name: 'POST /records/:recordId/lock',
    previouslyEchoed: false,
    send: (a, sheetId, viewId) => a.post(`/api/multitable/records/${REC_ON_LIVE}/lock`).send({ locked: true, sheetId, viewId }),
  },
  {
    name: 'POST /patch',
    previouslyEchoed: true,
    send: (a, sheetId, viewId) => a.post('/api/multitable/patch').send({
      sheetId,
      viewId,
      changes: [{ recordId: REC_ON_LIVE, fieldId: FLD_TEXT, value: 'after' }],
    }),
  },
]

/** No response may contain any id the request carried. */
function expectValuesFree(text: string, label: string) {
  for (const id of REQUEST_IDS) {
    expect(text, `${label} echoed ${id === VIEW_ELSEWHERE ? 'the requested viewId' : 'an id the request carried'}`).not.toContain(id)
  }
  expect(text, `${label} echoed the resolver's message`).not.toContain('does not belong to sheet')
}

describe('#5946 — a viewId that belongs to another sheet is refused values-free on every univer-meta caller', () => {
  describe('the one refusal, on all ten callers', () => {
    it('self-check: exactly one route has a restricted reach, it is GET /context, and the reason is recorded', () => {
      const restricted = ROUTES.filter((r) => r.reachedBy).map((r) => r.name)
      expect(restricted, 'a route grew an authority gate in front of its mismatch refusal without a recorded reason').toEqual(['GET /context'])
      expect(Object.keys(RESTRICTED_REACH)).toEqual(restricted)
      expect(RESTRICTED_REACH['GET /context'].why.length).toBeGreaterThan(120)
      // The nine unrestricted routes really are reached by the actor that holds nothing.
      for (const route of ROUTES.filter((r) => !r.reachedBy)) {
        expect(reachOf(route), route.name).toEqual(['OUTSIDER', 'MANAGER'])
      }
    })

    for (const route of ROUTES) {
      for (const actor of reachOf(route)) {
        it(`${route.name} (${actor}): a cross-sheet viewId answers the values-free absent-sheet 404`, async () => {
          const res = await route.send(on(actor), SHEET_LIVE, VIEW_ELSEWHERE)

          expect(res.status, `${route.name} did not answer the shared refusal status`).toBe(MISMATCH_STATUS)
          expect(res.body, `${route.name} drifted away from sendSheetNotLive(res, 'absent')`).toEqual(MISMATCH_BODY)
          expectValuesFree(res.text, route.name)
          // Not the generic 500 the seven uncaught callers used to reach.
          expect(res.status).not.toBe(500)
          expect(JSON.stringify(res.body)).not.toContain('INTERNAL_ERROR')
        })
      }

      if (reachOf(route).length > 1) {
        it(`${route.name}: an ADMIN caller gets the SAME bytes — the refusal is the address, not authority`, async () => {
          const outsider = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)
          const manager = await route.send(on('MANAGER'), SHEET_LIVE, VIEW_ELSEWHERE)

          expect(manager.status).toBe(outsider.status)
          expect(manager.text).toBe(outsider.text)
          expect(manager.status).toBe(MISMATCH_STATUS)
          expect(manager.body).toEqual(MISMATCH_BODY)
        })
      }

      it(`${route.name}: attribution — the SAME request with a view that DOES belong answers differently`, async () => {
        const actor = reachOf(route)[0]
        const mismatch = await route.send(on(actor), SHEET_LIVE, VIEW_ELSEWHERE)
        const matching = await route.send(on(actor), SHEET_LIVE, VIEW_ON_LIVE)

        expect(
          `${matching.status} ${matching.text}`,
          `${route.name} answers a matching view exactly as it answers a cross-sheet one — this cell then proves nothing`,
        ).not.toBe(`${mismatch.status} ${mismatch.text}`)
      })
    }
  })

  describe('the three that used to echo both ids back', () => {
    const echoing = ROUTES.filter((r) => r.previouslyEchoed)

    it('self-check: the table still names exactly the three routes that caught ConflictError on main', () => {
      expect(echoing.map((r) => r.name)).toEqual(['GET /view', 'GET /records/:recordId', 'POST /patch'])
    })

    for (const route of echoing) {
      it(`${route.name}: the 409 CONFLICT + err.message shape is gone`, async () => {
        const res = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)

        expect(res.status, `${route.name} still answers the old conflict status`).not.toBe(OLD_ECHO_STATUS)
        expect(JSON.stringify(res.body), `${route.name} still answers the old conflict code`).not.toContain(OLD_ECHO_CODE)
        expect(res.text, `${route.name} still echoes the resolver's message`).not.toContain(oldEchoMessage(VIEW_ELSEWHERE, SHEET_LIVE))
        expect(res.status).toBe(MISMATCH_STATUS)
        expect(res.body).toEqual(MISMATCH_BODY)
      })
    }
  })

  /**
   * THE #5839 INVARIANT, carried forward. B5 case ⑤ pinned it on PATCH /records/:recordId while the
   * answer was a 500; the answer is a 404 now and the promise is unchanged — a mismatch must not let
   * a caller separate a live sheet from a soft-deleted or an absent one. Asserted byte-for-byte
   * rather than by deep equality: the wire form is what a caller sees.
   *
   * GET /context is NOT in this list, and not because it fails it. #5948 put a liveness refusal in
   * front of its pairing check for callers that pass the authority gate, so on that route the three
   * states are separated BEFORE the mismatch is reached — by a gate that already decided the caller
   * may know. For the caller that may NOT know, the three states are indistinguishable on /context
   * too, and that is the stronger statement; it is pinned in the "#5948 order" describe below.
   */
  describe('three-way same shape: LIVE / DELETED / ABSENT are indistinguishable through the mismatch', () => {
    it('self-check: the routes listed here run the pairing check before any liveness answer', () => {
      // If /context ever rejoins this list, this cell says why it left.
      expect(Object.keys(RESTRICTED_REACH)).toContain('GET /context')
    })

    for (const name of ['PATCH /records/:recordId', 'GET /view']) {
      it(`${name}: the three sheet states answer byte-identically`, async () => {
        const route = ROUTES.find((r) => r.name === name)!
        const answers: Array<{ sheetId: string; status: number; text: string }> = []
        for (const sheetId of SHEET_STATES) {
          const res = await route.send(on('OUTSIDER'), sheetId, VIEW_ELSEWHERE)
          expectValuesFree(res.text, `${name} on ${sheetId}`)
          answers.push({ sheetId, status: res.status, text: res.text })
        }

        const first = `${answers[0].status} ${answers[0].text}`
        expect(
          answers.map((a) => `${a.status} ${a.text}`),
          `${name} distinguishes the three sheet states through a view/sheet mismatch — that is a #5839 oracle`,
        ).toEqual([first, first, first])
        expect(answers[0].status).toBe(MISMATCH_STATUS)
        expect(JSON.parse(answers[0].text)).toEqual(MISMATCH_BODY)
      })
    }
  })

  /**
   * #5948's ORDER, which #5946 changes the CLASS of the answer behind but must not change the POSITION
   * of. On GET /context the sheetId+viewId pairing check sits BEHIND the authority gate on purpose: a
   * caller with no read grant must not be able to hold a viewId, sweep candidate sheet ids and read
   * the view→sheet binding off the status code. If #5946's wrapper were attached to the PRE-gate
   * resolution instead — or if the pairing check were hoisted back above the gate — a foreign view
   * would answer 404 where a missing one answers 403, and the scan is back.
   *
   * These cells are the ones that red on that mistake, and the reason GET /context is missing from
   * the three-way describe above.
   */
  describe('#5948 order: on GET /context the refusal stays BEHIND the authority gate', () => {
    const context = ROUTES.find((r) => r.name === 'GET /context')!
    const VIEW_NOWHERE = 'viw_5946_nowhere'

    it('a caller with no read grant gets the SAME 403 for a foreign view, a missing view and no view at all', async () => {
      const foreign = await on('OUTSIDER').get('/api/multitable/context').query({ sheetId: SHEET_LIVE, viewId: VIEW_ELSEWHERE })
      const missing = await on('OUTSIDER').get('/api/multitable/context').query({ sheetId: SHEET_LIVE, viewId: VIEW_NOWHERE })
      const none = await on('OUTSIDER').get('/api/multitable/context').query({ sheetId: SHEET_LIVE })

      expect(
        [foreign.status, foreign.text],
        'an existing foreign view is now distinguishable from a missing one for a caller with no capability — the #5936/#5948 view→sheet scan is back',
      ).toEqual([missing.status, missing.text])
      expect([none.status, none.text]).toEqual([missing.status, missing.text])
      expect([foreign.status, foreign.body]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
      expectValuesFree(foreign.text, 'GET /context refused caller')
      expect(foreign.text).not.toContain(VIEW_NOWHERE)
    })

    /**
     * Stronger than the status equality above: for the caller the gate refuses, the server does not
     * look the view up AT ALL. Uses VIEW_ELSEWHERE_UNCACHED because `tryResolveView` memoises found
     * views module-wide — with an id an earlier cell already resolved this cell would be green
     * whatever the handler does. Its cold-cache-ness is asserted, not assumed: the same request from
     * the actor that PASSES the gate must produce the meta_views read this one must not.
     */
    it('meta_views is not consulted at all for the caller the gate refuses', async () => {
      const refused = await on('OUTSIDER').get('/api/multitable/context').query({ sheetId: SHEET_LIVE, viewId: VIEW_ELSEWHERE_UNCACHED })
      const refusedReads = sqlLog.filter((s) => /meta_views/i.test(s))
      expect([refused.status, refused.body]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
      expect(
        refusedReads,
        'the refused caller made the server read meta_views — the pairing check moved back in front of the gate',
      ).toEqual([])

      // The control that keeps the cell from passing on a warm cache: the very same viewId, asked by
      // a caller that gets past the gate, DOES reach meta_views. If this is empty the fixture never
      // had a lookup to suppress and the assertion above measured nothing.
      const allowed = await on('MANAGER').get('/api/multitable/context').query({ sheetId: SHEET_LIVE, viewId: VIEW_ELSEWHERE_UNCACHED })
      expect([allowed.status, allowed.body]).toEqual([MISMATCH_STATUS, MISMATCH_BODY])
      expect(
        sqlLog.filter((s) => /meta_views/i.test(s)).length,
        'no meta_views read happened even for the authorised caller — the cell above proves nothing',
      ).toBeGreaterThan(0)
    })

    it('the three sheet states stay indistinguishable for that caller, mismatched view or not', async () => {
      const answers: string[] = []
      for (const sheetId of SHEET_STATES) {
        const res = await context.send(on('OUTSIDER'), sheetId, VIEW_ELSEWHERE)
        expectValuesFree(res.text, `GET /context refused on ${sheetId}`)
        answers.push(`${res.status} ${res.text}`)
      }
      expect(answers, 'GET /context separates the three sheet states for a caller it refuses').toEqual([answers[0], answers[0], answers[0]])
      expect(answers[0]).toBe(`${FORBIDDEN_STATUS} ${JSON.stringify(FORBIDDEN)}`)
    })

    it('a caller that PASSES the gate gets the #5946 values-free 404 — not the 500 #5948 left behind', async () => {
      const res = await context.send(on('MANAGER'), SHEET_LIVE, VIEW_ELSEWHERE)
      expect(res.status, JSON.stringify(res.body)).toBe(MISMATCH_STATUS)
      expect(res.body).toEqual(MISMATCH_BODY)
      expect(res.status).not.toBe(500)
      expect(JSON.stringify(res.body)).not.toContain('INTERNAL_ERROR')
      expectValuesFree(res.text, 'GET /context authorised caller')
    })

    it('structural: the pairing check sits below the gate, and the pre-gate resolution above it', () => {
      const start = UNIVER_META_SOURCE.indexOf("router.get('/context'")
      expect(start).toBeGreaterThan(0)
      const gate = UNIVER_META_SOURCE.indexOf(CONTEXT_AUTHORITY_GATE, start)
      const preGate = UNIVER_META_SOURCE.indexOf(CONTEXT_PRE_GATE_CALL, start)
      const wrapped = UNIVER_META_SOURCE.indexOf(WRAPPED_CALL, start)
      expect(gate, 'the #5936 authority gate is gone from GET /context').toBeGreaterThan(start)
      expect(preGate, 'the pre-gate viewId-only resolution is gone').toBeGreaterThan(start)
      expect(preGate, 'the pre-gate resolution moved BELOW the gate').toBeLessThan(gate)
      expect(wrapped, 'GET /context no longer wraps its pairing check').toBeGreaterThan(start)
      expect(wrapped, 'the #5946 refusal was hoisted ABOVE the authority gate — that is the #5948 oracle').toBeGreaterThan(gate)
    })
  })

  /**
   * MUTATION PROBES. The cells above measure the refusal; these show they would RED on the two shapes
   * main answered, by rebuilding the module graph with `sendSheetNotLive` swapped in memory
   * (`vi.doMock`) — no file on disk is ever mutated.
   *
   * WHAT THEY DO AND DO NOT MEASURE, stated so nobody reads more out of a green: each probe installs
   * a response and then asserts that the REAL cells' assertions reject it. That makes them probes of
   * THIS SPEC's discrimination, not of the product — they stay green if the product fix is removed,
   * because the response they judge is the one they installed. The product's dependence on the
   * wrapper is measured by the route cells themselves: removing the wrapper's refusal branch reds 37
   * of them (in-memory source transform, reported with the PR).
   */
  describe('mutation probes: both pre-#5946 shapes would red the cells above', () => {
    async function withRefusal(override: (res: Response) => unknown, run: () => Promise<request.Response>) {
      const probeApp = await buildApp(override)
      pinned.setApp(probeApp)
      try {
        return await run()
      } finally {
        app = await buildApp()
        pinned.setApp(app)
      }
    }

    it('PROBE (the seven): main’s generic 500 fails the status and body assertions', async () => {
      const res = await withRefusal(
        (r) => (r as Response).status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load context' } }),
        () => request(pinned.url()).patch(`/api/multitable/records/${REC_ON_LIVE}`).send({ sheetId: SHEET_LIVE, viewId: VIEW_ELSEWHERE, data: { [FLD_TEXT]: 'after' } }),
      )

      expect(res.status).toBe(500)
      // The point is NOT that the override answered the 500 it was told to — that is a tautology,
      // and this cell used to consist of three of them. It is that EACH of the real route cell's
      // assertions, run against this response, THROWS. Asserted one at a time (a single `.toThrow()`
      // around a block is satisfied by whichever assertion throws first, so it would not notice one
      // of them going blind). Same shape as the values-free assertion in the sibling probe below.
      expect(() => expect(res.status).toBe(MISMATCH_STATUS), 'the generic-500 status satisfies the route cell').toThrow()
      expect(() => expect(res.body).toEqual(MISMATCH_BODY), 'the generic-500 body satisfies the route cell').toThrow()
      expect(() => expect(res.status).not.toBe(500), 'the route cell stopped refusing the 500 class').toThrow()
      expect(() => expect(JSON.stringify(res.body)).not.toContain('INTERNAL_ERROR'), 'the route cell stopped refusing INTERNAL_ERROR').toThrow()
    })

    it('PROBE (the three): main’s 409 + err.message fails the status, the code AND the values-free assertion', async () => {
      const res = await withRefusal(
        (r) => (r as Response).status(OLD_ECHO_STATUS).json({
          ok: false,
          error: { code: OLD_ECHO_CODE, message: oldEchoMessage(VIEW_ELSEWHERE, SHEET_LIVE) },
        }),
        () => request(pinned.url()).get('/api/multitable/view').query({ sheetId: SHEET_LIVE, viewId: VIEW_ELSEWHERE }),
      )

      expect(res.status).toBe(OLD_ECHO_STATUS)
      expect(res.body).not.toEqual(MISMATCH_BODY)
      expect(res.text).toContain(VIEW_ELSEWHERE)
      expect(res.text).toContain(SHEET_LIVE)
      expect(() => expectValuesFree(res.text, 'probe')).toThrow()
    })

    it('the probes really restored the product behaviour afterwards', async () => {
      // Checked on a route whose refusal is pre-authority, so the actor cannot be the variable:
      // ROUTES[0] is GET /context, where an OUTSIDER is refused 403 by #5948's gate long before the
      // wrapper runs, and a green here would say nothing about the restore.
      const route = ROUTES.find((r) => !r.reachedBy)!
      const res = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)
      expect(res.status).toBe(MISMATCH_STATUS)
      expect(res.body).toEqual(MISMATCH_BODY)

      // …and on /context too, with the actor that reaches it.
      const context = ROUTES.find((r) => r.name === 'GET /context')!
      const ctx = await context.send(on('MANAGER'), SHEET_LIVE, VIEW_ELSEWHERE)
      expect(ctx.status).toBe(MISMATCH_STATUS)
      expect(ctx.body).toEqual(MISMATCH_BODY)
    })
  })
})

// ── structural: no eleventh caller can reintroduce the 500 ────────────────────

const UNIVER_META_REL = 'routes/univer-meta.ts'
const UNIVER_META_SOURCE = readFileSync(join(__dirname, '../../src', UNIVER_META_REL), 'utf8')

/**
 * THE WRAPPED FORM. Every call to the resolver has to be written exactly like this, so that the
 * refusal is attached to it and the literal `resolveMetaSheetId` stays in the handler body (the
 * sheet-liveness closure guard scopes handlers on that token). On the tree this fix was written
 * against, BEFORE #5948 merged, a wrapper that hid the name measurably dropped GET /context out
 * of ITS scope; after #5948 it no longer would. See the closure-scope cell below for the numbers
 * and for why the shape is kept anyway.
 */
const WRAPPED_CALL = 'await orRefuseSheetViewMismatch(res, resolveMetaSheetId('

/**
 * The ONE raw resolver call #5948's order requires: GET /context resolving a viewId that came
 * WITHOUT a sheetId, above the authority gate. Kept as a literal so the allow-list entry below can
 * only ever excuse THIS text, and so the cell that pins where it sits can find it.
 */
const CONTEXT_PRE_GATE_CALL = 'const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {'

/** The #5936 gate the call above must stay in front of, and the pairing check must stay behind. */
const CONTEXT_AUTHORITY_GATE = 'if (!canReadWithSheetGrant(baseCapabilities, sheetScope, access.isAdminRole)) return sendForbidden(res)'

/**
 * The ONLY other lines allowed to name the resolver, each with the reason it is not a route caller.
 * Anything else — a handler awaiting the raw resolver — is the 500 (or the id echo) coming back.
 */
const RAW_RESOLVER_ALLOW_LIST: Record<string, string> = {
  'async function resolveMetaSheetId(':
    'the definition itself; its ConflictError stays, because the class is what the wrapper maps.',
  [CONTEXT_PRE_GATE_CALL]:
    'GET /context resolves a viewId WITHOUT a sheetId above its #5936 authority gate, because there is '
    + 'no other way to learn which sheet the request addresses. It passes `sheetId: null`, and the '
    + 'resolver throws ConflictError only on the `view.sheetId !== sheetId` comparison — unreachable '
    + 'with nothing to compare against, so there is no refusal here to improve. Wrapping it anyway '
    + 'would put a 404 IN FRONT of that gate and hand a caller with no capability the foreign-view / '
    + 'missing-view distinction #5948 closed. The cell below pins that this exception stays exactly '
    + 'one line, inside /context, above the gate, and still passing `sheetId: null`.',
}

/**
 * A COMMENT line — a line whose first non-space characters open or continue a comment. Comments call
 * nothing, and the doc comment on the wrapper itself quotes `resolveMetaSheetId(` while explaining the
 * rule; scanning them would make the rule unstatable. This drops only lines that START as a comment,
 * so `await resolveMetaSheetId(...) // sneaky` is still scanned (self-tested below).
 */
const isCommentLine = (line: string) => /^(\/\/|\/\*|\*)/.test(line)

/**
 * Lines that name the resolver outside the wrapped form and outside the allow-list.
 *
 * The excused forms are DELETED FROM THE LINE rather than used to drop it: a second, raw call
 * written on the SAME line as a wrapped one (a compressed line, or a formatter joining two
 * statements) used to be invisible, because the whole line matched `includes(WRAPPED_CALL)`.
 * Self-tested below on exactly that shape.
 */
function rawResolverOffenders(source: string): string[] {
  const excuses = [WRAPPED_CALL, ...Object.keys(RAW_RESOLVER_ALLOW_LIST)]
  return source
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((entry) => !isCommentLine(entry.line))
    .filter((entry) => /resolveMetaSheetId\(/.test(entry.line))
    .filter((entry) => {
      const residue = excuses.reduce((acc, excuse) => acc.split(excuse).join(''), entry.line)
      return /resolveMetaSheetId\(/.test(residue)
    })
    .map((entry) => `${UNIVER_META_REL}:${entry.n}: ${entry.line}`)
}

/**
 * `ConflictError` branches that answer with `err.message`, keyed by WHERE they sit.
 *
 * Above the first `router.` declaration (line ~7858 of a 20k-line file) there is no route to name,
 * and keying that whole region as one bucket called `(module scope)` made the allow-list excuse
 * every module-level helper at once — including the wrapper this fix adds. So a module-level branch
 * is keyed by its ENCLOSING FUNCTION instead, and the allow-list has to name that function.
 * Self-tested below by inserting a leaky module-level helper.
 */
function conflictEchoes(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const found: string[] = []
  let route = ''
  let enclosingFn = '(module top level)'
  lines.forEach((line, i) => {
    const fnDecl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line)
    if (fnDecl) enclosingFn = fnDecl[1]
    const decl = /^\s*router\.(get|post|patch|put|delete)\('([^']+)'/.exec(line)
    if (decl) route = `${decl[1]} ${decl[2]}`
    if (isCommentLine(line.trim()) || !/instanceof ConflictError/.test(line)) return
    // Comment lines are dropped from the window too: the removed branches left a note behind that
    // NAMES `err.message`, and a scanner that read it would report a branch that is not there.
    const window = lines.slice(i, i + 4).filter((l) => !isCommentLine(l.trim())).join('\n')
    if (/err\.message/.test(window)) found.push(route || `fn ${enclosingFn}`)
  })
  return found
}

/**
 * The echoing branches that stay. Both are named rather than counted, so a new one has to argue for
 * itself here instead of landing quietly.
 */
const CONFLICT_ECHO_ALLOW_LIST: Record<string, string> = {
  'fn serializePatchFailure':
    'the PER-RECORD failure payload of POST /patch. No local ConflictError is '
    + 'thrown inside that per-record loop (the only two throw sites in the file are resolveMetaSheetId, '
    + 'now wrapped ABOVE the loop, and the POST /sheets insert collision), so this arm is unreachable '
    + 'today; it is named here so a future thrower inside the loop has to confront it.',
  'post /sheets':
    'the create-collision `Sheet already exists: <sheetId>` — the id is the one THIS caller just asked '
    + 'to create, on a route it is authorised for, so the message tells it nothing it did not send.',
}

/**
 * Wrapped call sites that do not `return` on the null the wrapper gives back.
 *
 * The guarded name is DERIVED from each call site's own binding rather than hardcoded to `resolved`:
 * a site that binds a different name and then leans on a neighbouring site's `if (!resolved) return`
 * (they can sit within the 8-line window) would otherwise pass while continuing on a sent response.
 * A call site that binds nothing at all is reported by name-less capture. Self-tested below.
 */
function callSitesThatIgnoreNull(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const missing: string[] = []
  lines.forEach((line, i) => {
    if (!line.includes(WRAPPED_CALL)) return
    const bound = /const\s+([A-Za-z0-9_$]+)\s*=\s*await orRefuseSheetViewMismatch\(/.exec(line)
    if (!bound) {
      missing.push(`${UNIVER_META_REL}:${i + 1} (result not bound — the null can never be checked)`)
      return
    }
    const guard = new RegExp(`if \\(!${bound[1]}\\) return`)
    if (!guard.test(lines.slice(i, i + 8).join('\n'))) missing.push(`${UNIVER_META_REL}:${i + 1} (no \`if (!${bound[1]}) return\`)`)
  })
  return missing
}

/**
 * Handlers holding a wrapped call, and whether the closure guard's scope heuristic can still see the
 * resolver's name in them. Written without a `\b` escape on purpose: this repo has twice had an
 * editor turn one into a real 0x08 byte, and the character class says the same thing.
 */
const RESOLVER_TOKEN = /[^A-Za-z0-9_$]resolveMetaSheetId[^A-Za-z0-9_$]/

/**
 * The closure guard classifies on CODE, never on prose: it normalizes CRLF and strips comments
 * before matching (`stripComments` in tests/unit/multitable-sheet-liveness-closure.guard.test.ts,
 * which exists because a handler was once classified GUARDED by a sentence in its own docblock).
 * Any cell that counts the token in a handler has to read it the same way: the RAW /context slice
 * holds FOUR occurrences, two of them comments ABOUT the resolver, so a count taken on the raw
 * text would survive the deletion of both calls. Replicated rather than imported — the guard is a
 * spec file and exports nothing — and a copy that drifts from it reds the near-miss assertions in
 * the same cell.
 */
function guardCode(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('#5946 structural — the wrapped call is the only door', () => {
  it('every resolveMetaSheetId( call in univer-meta.ts is the definition or a wrapped call site', () => {
    expect(rawResolverOffenders(UNIVER_META_SOURCE), 'a handler awaits the raw resolver: its ConflictError becomes a 500 (or an echoing 409) again').toEqual([])
  })

  it('the wrapper has exactly as many call sites as this file has route cells', () => {
    const callers = UNIVER_META_SOURCE.split(WRAPPED_CALL).length - 1
    expect(callers, 'a wrapper call site landed without a cell in ROUTES (or a cell lost its route)').toBe(ROUTES.length)
    expect(ROUTES.length).toBe(10)
    // Counted separately and named, so this cell stays a "10 wrapped sites" statement rather than a
    // "every resolver call is wrapped" one — which the allow-listed pre-gate call would red forever.
    // Comment lines are excluded: the wrapper's doc comment quotes the call form while stating the rule.
    const codeMentions = UNIVER_META_SOURCE
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => !isCommentLine(l))
      .reduce((n, l) => n + (l.match(/[^A-Za-z0-9_$]?resolveMetaSheetId\(/g) ?? []).length, 0)
    expect(
      codeMentions,
      'the resolver gained or lost a mention in CODE: 1 definition + 10 wrapped call sites + the 1 allow-listed pre-gate /context call',
    ).toBe(callers + 2)
  })

  /**
   * The allow-listed raw call, pinned in place. The allow-list key is a LINE, so on its own it would
   * excuse that text anywhere in the file; these assertions make it excuse exactly one occurrence,
   * in GET /context, above the gate, still passing `sheetId: null` — the three properties that make
   * it safe not to wrap (finding: wrapping it re-opens the #5948 view→sheet scan).
   */
  it('the ONE allow-listed raw resolver call is the /context pre-gate viewId-only resolution and nothing else', () => {
    const occurrences = UNIVER_META_SOURCE.split(CONTEXT_PRE_GATE_CALL).length - 1
    expect(occurrences, 'the allow-listed raw resolver form appears more than once — the allow-list now excuses an unknown caller').toBe(1)

    const at = UNIVER_META_SOURCE.indexOf(CONTEXT_PRE_GATE_CALL)
    const contextStart = UNIVER_META_SOURCE.indexOf("router.get('/context'")
    const contextEnd = UNIVER_META_SOURCE.indexOf('\n  router.', contextStart + 10)
    const gate = UNIVER_META_SOURCE.indexOf(CONTEXT_AUTHORITY_GATE, contextStart)
    expect(contextStart).toBeGreaterThan(0)
    expect(contextEnd).toBeGreaterThan(contextStart)
    expect(at, 'the allow-listed raw call left GET /context').toBeGreaterThan(contextStart)
    expect(at, 'the allow-listed raw call left GET /context').toBeLessThan(contextEnd)
    expect(at, 'the allow-listed raw call sank BELOW the authority gate, where it should be wrapped instead').toBeLessThan(gate)

    // It cannot throw ConflictError: the resolver compares `view.sheetId !== sheetId`, and there is
    // no sheetId here. If that ever changes, the excuse is void and the call must be wrapped.
    const args = UNIVER_META_SOURCE.slice(at, at + 200)
    expect(args, 'the allow-listed raw call now passes a sheetId — its ConflictError became reachable and it must be wrapped').toContain('sheetId: null,')

    expect(RAW_RESOLVER_ALLOW_LIST[CONTEXT_PRE_GATE_CALL]?.length ?? 0, 'the allow-list entry lost its reason').toBeGreaterThan(200)
  })

  it('every wrapped call is followed by a `return` on null — no handler continues on a sent refusal', () => {
    expect(callSitesThatIgnoreNull(UNIVER_META_SOURCE), 'a call site keeps going after the refusal was already written').toEqual([])
  })

  /**
   * The guard this fix must not pay with. `addressesASheet` in
   * tests/unit/multitable-sheet-liveness-closure.guard.test.ts puts a handler in scope on FOUR
   * predicates, and for GET /context exactly ONE of them fires — the literal `resolveMetaSheetId`.
   * That "alone" is asserted here rather than asserted in prose, because #5948 added a
   * `resolveSheetCapabilitiesForAccess` call to this handler that LOOKS like it would carry the
   * scope: the guard's pattern is `\bresolveSheetCapabilities\b`, whose trailing boundary fails on
   * `ForAccess`, so it does not.
   *
   * What a name-hiding `resolveMetaSheetIdOrRefuse(...)` would actually cost, MEASURED by replaying
   * `addressesASheet` over the whole of univer-meta.ts with every wrapped call rewritten to that
   * shape:
   *   - pre-#5948 tree (2435c92ec): 105 handlers, in scope 83 -> 82, LOST ["GET /context"];
   *   - this tree, #5948 merged:    105 handlers, in scope 83 -> 83, LOST [].
   * #5948 left GET /context a PRE-gate BARE `resolveMetaSheetId` call — the allow-listed one the
   * cell above pins — and that call alone now holds the token in the handler body, so the shape of
   * the wrapper no longer decides /context's membership. The claim is therefore NOT that hiding the
   * name would drop /context today; it is that the membership must not DEPEND on either the
   * wrapper's shape or that one pre-gate call. The cell below pins both halves: the token occurs in
   * this handler's CODE exactly TWICE, and the FIRST of the two is the allow-listed pre-gate call.
   * Deleting the pre-gate call, or stripping the name from the wrapped call, changes what this cell
   * reads instead of silently shrinking the guard's population — which is what the bare `.test()`
   * this replaced allowed: satisfied by the pre-gate call alone, it stayed GREEN under exactly the
   * args-shaped mutation it claimed to catch.
   */
  it('the wrapped form keeps the resolver token in the handler body (closure-guard scope preserved)', () => {
    expect(RESOLVER_TOKEN.test(` ${WRAPPED_CALL} `), 'the wrapped form stopped naming the resolver — the closure guard loses GET /context').toBe(true)
    const contextStart = UNIVER_META_SOURCE.indexOf("router.get('/context'")
    const contextHandler = UNIVER_META_SOURCE.slice(contextStart, UNIVER_META_SOURCE.indexOf('\n  router.', contextStart + 10))
    expect(contextHandler.length).toBeGreaterThan(100)

    // What the guard actually sees, comments stripped: TWO occurrences, in this order —
    //   1. the allow-listed PRE-gate bare call #5948's order requires (`sheetId: null`), then
    //   2. the wrapped POST-gate pairing call this fix adds.
    const contextCode = guardCode(contextHandler)
    const occurrences = contextCode.match(new RegExp(RESOLVER_TOKEN.source, 'g')) ?? []
    expect(
      occurrences.length,
      'GET /context stopped naming resolveMetaSheetId exactly twice in CODE — recount before trusting its closure-guard membership',
    ).toBe(2)

    const firstAt = contextCode.search(RESOLVER_TOKEN)
    const preGateAt = contextCode.indexOf(CONTEXT_PRE_GATE_CALL)
    const wrappedAt = contextCode.indexOf(WRAPPED_CALL)
    expect(preGateAt, 'the allow-listed pre-gate call is gone from the CODE of GET /context').toBeGreaterThan(-1)
    expect(wrappedAt, 'the wrapped pairing call is gone from the CODE of GET /context').toBeGreaterThan(-1)
    // The FIRST occurrence must fall INSIDE the allow-listed pre-gate statement (RESOLVER_TOKEN
    // eats the boundary char, so it starts just after that statement begins)…
    expect(firstAt, 'the FIRST resolver occurrence in GET /context is no longer the allow-listed pre-gate call').toBeGreaterThan(preGateAt)
    expect(
      firstAt,
      'the FIRST resolver occurrence in GET /context is no longer the allow-listed pre-gate call',
    ).toBeLessThan(preGateAt + CONTEXT_PRE_GATE_CALL.length)
    // …and the wrapped call must be the SECOND.
    expect(wrappedAt, 'the wrapped call no longer follows the pre-gate call in GET /context').toBeGreaterThan(preGateAt)

    // The other three predicates of that guard, all FALSE for /context. The first is about the PATH
    // (`h.path.includes(':sheetId')` in the guard), not the body — the body carries the string in a
    // comment about a different route. Written with character classes instead of `\b` escapes for
    // the same reason RESOLVER_TOKEN is.
    const contextPath = /router\.get\('([^']+)'/.exec(UNIVER_META_SOURCE.slice(contextStart))![1]
    expect(contextPath).toBe('/context')
    expect(contextPath.includes(':sheetId'), 'GET /context grew a :sheetId path param — restate the claim above').toBe(false)
    expect(
      /[^A-Za-z0-9_$](resolveSheetCapabilities|resolveSheetReadableCapabilities)[^A-Za-z0-9_$]/.test(contextHandler),
      'GET /context now matches the guard\'s capability predicate — restate the claim above',
    ).toBe(false)
    expect(/[^A-Za-z0-9_$]requireRecordReadable[^A-Za-z0-9_$]/.test(contextHandler)).toBe(false)
    // …and the near-miss that makes the check worth having: the call IS there, the pattern misses it.
    expect(contextHandler.includes('resolveSheetCapabilitiesForAccess'), '#5948\'s gate left GET /context — recheck which predicate carries its scope').toBe(true)
  })

  it('no ConflictError branch echoes err.message outside the named allow-list', () => {
    const unexpected = conflictEchoes(UNIVER_META_SOURCE).filter((route) => !(route in CONFLICT_ECHO_ALLOW_LIST))
    expect(unexpected, 'a route answers ConflictError with the message that pastes viewId/sheetId back').toEqual([])
    for (const reason of Object.values(CONFLICT_ECHO_ALLOW_LIST)) {
      expect(reason.length, 'an allow-list entry without a real reason').toBeGreaterThan(40)
    }
  })

  // ── self-tests: the scanners really red on the shapes they forbid ───────────

  it('self-test: an unwrapped resolver call is caught — including one wearing a trailing comment', () => {
    const mutated = UNIVER_META_SOURCE.replace(
      'async function resolveMetaSheetId(',
      'async function resolveMetaSheetId(\n      const sneaky = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {',
    )
    expect(rawResolverOffenders(mutated).join('\n')).toMatch(/sneaky/)

    // The comment skip drops only lines that START as a comment: a call with a comment after it stays visible.
    const trailing = UNIVER_META_SOURCE.replace(
      'async function resolveMetaSheetId(',
      'async function resolveMetaSheetId(\n      const alsoSneaky = await resolveMetaSheetId(pool, args) // looks harmless',
    )
    expect(rawResolverOffenders(trailing).join('\n')).toMatch(/alsoSneaky/)

    expect(rawResolverOffenders(UNIVER_META_SOURCE)).toEqual([])
  })

  it('self-test: a raw call sharing a LINE with a wrapped one is caught (the excuses are deleted, not the line)', () => {
    // The shape an earlier version of this scanner could not see: `entry.line.includes(WRAPPED_CALL)`
    // dropped the whole line, so a second, raw call appended to it was invisible.
    const wrappedLine = UNIVER_META_SOURCE.split(/\r?\n/).find((l) => l.includes(WRAPPED_CALL))
    expect(wrappedLine, 'no wrapped call site to build the probe on').toBeTruthy()
    const sameLine = UNIVER_META_SOURCE.replace(
      wrappedLine!,
      `${wrappedLine!} const sameLineSneaky = await resolveMetaSheetId(pool, args)`,
    )
    expect(rawResolverOffenders(sameLine).join('\n'), 'a raw call hiding on a wrapped call\'s line is invisible').toMatch(/sameLineSneaky/)

    // Same for the allow-listed line: it excuses ITS text, not everything sharing its line.
    const allowLine = UNIVER_META_SOURCE.split(/\r?\n/).find((l) => l.includes(CONTEXT_PRE_GATE_CALL))
    expect(allowLine).toBeTruthy()
    const nextToAllowed = UNIVER_META_SOURCE.replace(
      allowLine!,
      `${allowLine!} const allowSneaky = await resolveMetaSheetId(pool, args)`,
    )
    expect(rawResolverOffenders(nextToAllowed).join('\n')).toMatch(/allowSneaky/)
  })

  it('self-test: a module-level ConflictError echo is caught — the allow-list names one FUNCTION, not a region', () => {
    // The shape the old `(module scope)` key excused wholesale: any helper above the first `router.`
    // declaration, ~7800 lines of the file including the #5946 wrapper itself.
    const anchor = 'async function orRefuseSheetViewMismatch('
    expect(UNIVER_META_SOURCE).toContain(anchor)
    const mutated = UNIVER_META_SOURCE.replace(
      anchor,
      'function leakyModuleHelper(res: Response, err: unknown) {'
      + '\n  if (err instanceof ConflictError) {'
      + "\n    return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })"
      + '\n  }'
      + '\n}'
      + `\n${anchor}`,
    )
    expect(conflictEchoes(mutated), 'a module-level echoing branch is invisible to the scanner').toContain('fn leakyModuleHelper')
    expect(conflictEchoes(mutated).filter((r) => !(r in CONFLICT_ECHO_ALLOW_LIST))).toEqual(['fn leakyModuleHelper'])
    // And the real file still names exactly the two allow-listed sites.
    expect(conflictEchoes(UNIVER_META_SOURCE).sort()).toEqual(Object.keys(CONFLICT_ECHO_ALLOW_LIST).sort())
  })

  it('self-test: a wrapped call that binds a different name cannot borrow a neighbour\'s null check', () => {
    const lines = UNIVER_META_SOURCE.split(/\r?\n/)
    const idx = lines.findIndex((l) => l.includes(WRAPPED_CALL) && /const\s+resolved\s*=/.test(l))
    expect(idx).toBeGreaterThan(0)
    const renamed = [...lines]
    renamed[idx] = renamed[idx].replace('const resolved =', 'const borrowed =')
    expect(
      callSitesThatIgnoreNull(renamed.join('\n')).join('\n'),
      'a call site binding another name passes on a neighbouring `if (!resolved) return`',
    ).toMatch(/borrowed/)

    // A site that binds nothing at all is reported too.
    const unbound = [...lines]
    unbound[idx] = unbound[idx].replace(/const\s+resolved\s*=\s*/, '')
    expect(callSitesThatIgnoreNull(unbound.join('\n')).join('\n')).toMatch(/result not bound/)
  })

  it('self-test: a re-added echoing ConflictError branch is caught', () => {
    const marker = "  router.get('/view', "
    expect(UNIVER_META_SOURCE).toContain(marker)
    const mutated = UNIVER_META_SOURCE.replace(
      marker,
      marker
        + '\n      if (err instanceof ConflictError) {'
        + "\n        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })"
        + '\n      }\n',
    )
    expect(conflictEchoes(mutated)).toContain('get /view')
    expect(conflictEchoes(UNIVER_META_SOURCE).filter((r) => !(r in CONFLICT_ECHO_ALLOW_LIST))).toEqual([])
  })

  it('self-test: a call site that forgets the null return is caught', () => {
    const lines = UNIVER_META_SOURCE.split(/\r?\n/)
    const idx = lines.findIndex((l) => /if \(!resolved\) return/.test(l))
    expect(idx).toBeGreaterThan(0)
    lines[idx] = '      // removed'
    expect(callSitesThatIgnoreNull(lines.join('\n')).length).toBe(1)
    expect(callSitesThatIgnoreNull(UNIVER_META_SOURCE)).toEqual([])
  })
})
