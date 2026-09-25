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
 *  6. …and by SHAPE, because 5 is by NAME. Every cell in 5 recognises the refusal by the resolver's
 *     name or by `instanceof ConflictError`, so the three form-share routes that HAND-WRITE the same
 *     view→sheet check (#5957 final review) were invisible to all of them, and a fourth copy under
 *     any other name would be too. The last sections of this file find sheet-pairing refusals by
 *     what they do — an `if` (or a boolean it tests) comparing a sheet id with a non-literal, whose
 *     mismatch path answers the request; the exact shape, and what it does NOT see, are spelled out
 *     there — COMPUTE whether that answer is values-free and whether it runs before the handler's
 *     first 403, and hold the result to a closed-world census with named exceptions. The three
 *     form-share routes are on it as a GAP, and that GAP is also measured on the wire.
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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
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

// ══════════════════════════════════════════════════════════════════════════════
// BY SHAPE, NOT BY NAME — sheet-pairing refusals in univer-meta.ts (the shape and its limits below)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ── Why the cells above are not enough ────────────────────────────────────────
 * Every structural cell above recognises the #5946 refusal by a NAME: a line that says
 * `resolveMetaSheetId(`, a branch that says `instanceof ConflictError`, the wrapper's literal call
 * form. The #5957 final review read the one path none of them looks at: GET and PATCH
 * /sheets/:sheetId/views/:viewId/form-share and POST …/form-share/regenerate each HAND-WRITE the same
 * check — read the view row, compare its `sheet_id` with the addressed sheet, refuse — before any
 * authority or liveness gate, with both ids pasted into the message and "no such view" worded apart
 * from "view on another sheet". None of the names the cells above know appears there, so they stayed
 * green over all three, and a fourth copy under any other name would be just as invisible.
 *
 * ── What this section recognises instead ──────────────────────────────────────
 * THE SHAPE. An `===` / `!==` / `==` / `!=` outside every literal whose two operands — each read WHOLE,
 * out to the nearest operator that binds looser than `===` (`&&` `||` `??` `?` `:` `,` `=` `=>` …) or
 * the enclosing bracket — are:
 *   (a) one of them SHEET-ID-VALUED: it holds an identifier, or a quoted key (`row['sheet_id']`), named
 *       `…sheetId` / `…sheet_id` in any case, that is not dereferenced further (`sheetId.length` is not).
 *       Wrappers do not matter: `String(x.sheet_id ?? '')`, `(x.sheet_id as string)`, `x.sheetId.trim()`,
 *       `normalise(x.sheet_id)`, `(await sheetIdOf(…)) !== sheetId` all count;
 *   (b) the other NOT A LITERAL (a string, a template without holes, a number, `null`, `undefined`,
 *       `true`, `false` — parentheses and `as const` peeled);
 *   (c) sitting in the condition of an `if` — or in the initialiser of a binding (`const x = …`,
 *       `x = …`, `x ||= …`, across line breaks) whose name a later `if` in the same handler tests;
 *   (d) whose MISMATCH path answers the request (see `readAnswer`: a response method on any object, a
 *       write onto the response object, a call handed the response object anywhere in its arguments or
 *       a function the handler defined over it, a `throw`, `next(…)` / `reject(…)`, or a returned object
 *       with a `status` key).
 * The mismatch path is the then-branch when the comparison being an inequality makes the condition
 * true, the else-branch otherwise. A mismatch branch that does not `return` / `throw`, opposite one that
 * does — with no else, the empty else-branch — continues into the FALL-THROUGH RUN (`fallThroughRun`):
 * the statements after the `if`, up to and including the first that returns, throws or answers
 * unconditionally, or to the end of the enclosing block; an inner `if` / loop / `try` on the way is read
 * whole and the run goes on past it. A `!(…)` that holds exactly the comparison, or a `!` on the bound
 * boolean, flips the polarity; so does the `!` before `rows.some((row) => …)` / `rows.every(…)` whose
 * one-parameter arrow body IS the comparison, when that call is a whole `&&` / `||` operand of a condition
 * with no `?` / `:` / `??` at its top level (`quantifiedPolarity` — both are monotone in the predicate).
 * When the polarity cannot be told from the text — any other callback (`.filter(…)`, `.some(…) === false`,
 * `const same = (v) => …`), a `!(…)` that holds more than the comparison (`!(owner && owner.sheetId === x)`),
 * or the boolean tested as more than a bare name — BOTH paths are read.
 *
 * Two properties of every site are COMPUTED from the code, never taken from the table:
 *   echo             the answer's payload is not provably constant. Every construct that makes a path
 *                    answer also hands `readAnswer` its payload — all arguments of every response method
 *                    (`.end(…)`, `.redirect(…)`, `.set(…)` included), the value written onto the response
 *                    object, everything a response-handed call is given besides the response (`req`
 *                    included), a response closure's own answer, a thrown / rejected / next()-ed
 *                    expression, a returned `{ …status… }` object, the arguments of every `new X(…)`.
 *                    A value HANDED ON — thrown, returned as a status object, passed to `next` / `reject` —
 *                    is answered somewhere else, and that answer is read as well (`consumerOf`): for a
 *                    `throw`, the `catch` of the innermost `try` in the handler that holds it; for a status
 *                    object returned out of a callback into a binding (`const failure = await
 *                    pool.transaction(async … => …)`), the then-branch of the first later `if (failure)`.
 *                    There the value's own name (`err.message`, `failure.status`) stands for the value,
 *                    whose payload is read at the handoff. Where the handler has no such place — `next` /
 *                    `reject`, a throw with no `catch`, a status object returned any other way — it reads
 *                    as echo. A payload is constant only if every leaf is a literal or a MODULE constant:
 *                    declared once, at column 0, as `const` with a plain literal initialiser and bound
 *                    nowhere else in the file (or imported unrenamed from a relative module that exports
 *                    it so). A `${…}` hole, a spread, a concatenation with a variable, a shorthand
 *                    `{ viewId }`, a member path, a call, a `let` / `var`, or any function-local name reads
 *                    as echo. Within what the scan reads, "cannot prove constant" is echo; what it does
 *                    NOT read is listed under NOT FOLLOWED below.
 *   beforeAuthority  inside a route handler: no 403-class refusal (the closure guard's AUTHORITY_REFUSAL,
 *                    NOT widened to 401 — a 401 turns away only callers who are not signed in, while the
 *                    GAP is a signed-in caller told apart before its 403) precedes the site in the
 *                    handler, and the site's mismatch path does not answer ONLY a 403 (then it is the
 *                    authority refusal itself). `null` outside every handler.
 *
 * THE RULES, over the whole file:
 *   1. CLOSED WORLD — the sites found are exactly the keys of SHEET_PAIRING_CENSUS. A new site of the
 *      shape above (within the limits listed below) reds until it is written down; what its helpers are
 *      called and how its message is worded do not enter into it.
 *   2. DECLARED = COMPUTED — each row's `echo` and `beforeAuthority` equal what the scan computes, so a
 *      row cannot be written down more flattering than the code it describes.
 *   3. ONLY NAMED EXCEPTIONS — `echo: true`, or `beforeAuthority` other than `false`, is allowed only
 *      for a key in SHEET_PAIRING_EXCEPTIONS, each with its reason; an exception whose site no longer
 *      needs it reds as well, so the list can only shrink.
 * A key is `<route or enclosing function> | <the comparison as written>`, never a line number.
 *
 * ── Known limits, stated instead of claimed away ──────────────────────────────
 * NOT SEEN (the comparison is not in an `if` condition or a tested binding, or is not an equality):
 *   - a pairing in a predicate DECLARED AS A FUNCTION (`function belongsTo(v, s) { return v.sheetId === s }`
 *     then `if (!belongsTo(view, sheetId))`) — an arrow bound to a name is a binding and is read — or one
 *     written as a ternary (`x ? res.status(404)… : …`), a `switch` / `case`, a loop condition, or a
 *     boolean stored on an object (`ctx.mismatch = …`);
 *   - a comparison through a function (`Object.is(…)`, `isEqual(…)`) or a membership test
 *     (`ids.includes(view.sheetId)`, `set.has(…)`), or one whose operands are both named for something
 *     other than a sheet id (`row.owner !== target`);
 *   - a bound boolean tested only in a different handler, or more than 4000 characters past a
 *     comparison outside every handler; a comparison inside a template-literal hole.
 * NOT FOLLOWED:
 *   - a mismatch path that only hands back `null` and lets its CALLER answer is not a site; the caller's
 *     answer is not traced back to it;
 *   - a helper handed the response object is read at the call: its body is not, so a helper handed only
 *     `res` and literals reads as values-free whatever it sends; the same for a module-level function
 *     that answers through a response object it reaches some other way;
 *   - a response closure is followed one level: a closure that calls another closure is read by its own
 *     text only, and a closure that throws, returns a status object or calls `next` reads as echo;
 *   - a fall-through run ends with its enclosing block: when the returning `if` is the last statement
 *     of a `try` or another inner block, what runs after that block is not read — the mismatch path then
 *     reads as not answering, and the site is not seen;
 *   - a thrown value is taken to reach the `catch` of the innermost enclosing `try` in the handler, by
 *     position; whether a throw inside a callback that is not awaited really gets there is not checked.
 *     That `catch` is read whole — every answer in it is payload, whichever error it is written for —
 *     and one that does not answer, rethrows, or hands the error on reads as echo;
 *   - a returned status object is followed only into an `if (<binding>)` after the binding it is
 *     returned into; `if (!failure)`, a caller of a named function, or any other consumer reads as echo.
 * OTHER:
 *   - Authority position is TEXTUAL, as in the closure guard: a 403 written earlier in the handler
 *     counts even when it sits in a branch or a closure that does not run before the site.
 *   - A pairing pushed into SQL is covered by the SQL cell below for a `meta_views` SELECT that binds
 *     `id = $n` and `sheet_id = $n` in one literal or `+`-joined literals, the SELECT anywhere in it
 *     (a CTE, `INSERT … SELECT`); not for SQL assembled through `${…}` holes or other builders.
 *   - Scope is routes/univer-meta.ts, the file the #5946 refusal and its three hand-written copies
 *     live in. Other route files are not scanned.
 *   - Comments are blanked with the same two regexes the closure guard strips them with; the
 *     population cell reds if that ever swallows a route declaration.
 *   - The constant rule errs toward echo: a function-local `const` with a literal value, a constant
 *     defined from another constant, a TS cast in a payload, a response method name on an unrelated
 *     object (`map.set(k, v)` on the path), or a `catch` whose other branches answer a local (the
 *     `getDbNotReadyMessage` hint most handlers carry) reads as echo — false alarms in that direction.
 */

const ROUTES_DIR = join(__dirname, '../../src/routes')

/** CRLF-normalised; comments blanked to spaces IN PLACE, so every offset keeps its line. */
function maskComments(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])(\/\/.*)$/gm, (_all, lead: string, comment: string) => lead + ' '.repeat(comment.length))
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** End (exclusive) of a '…' or "…" literal opening at `at`; -1 if it runs off its line. */
function skipQuoted(code: string, at: number): number {
  const quote = code[at]
  for (let i = at + 1; i < code.length; i += 1) {
    if (code[i] === '\\') { i += 1; continue }
    if (code[i] === quote) return i + 1
    if (code[i] === '\n') return -1
  }
  return -1
}

/** End (exclusive) of a template literal opening at `at`, `${…}` holes included; -1 if unbalanced. */
function skipTemplate(code: string, at: number): number {
  for (let i = at + 1; i < code.length; i += 1) {
    if (code[i] === '\\') { i += 1; continue }
    if (code[i] === '`') return i + 1
    if (code[i] === '$' && code[i + 1] === '{') {
      const close = matchBracket(code, i + 1)
      if (close === -1) return -1
      i = close
    }
  }
  return -1
}

/**
 * A `/` starts a regex literal (not a division) after an operator, an opening bracket, a separator or
 * a keyword — the usual rule. Needed because this file has regex literals holding quotes INSIDE
 * template holes (`${s.replace(/"/g, '""')}`), and a scanner that reads that `"` as a string start
 * loses its place for the rest of the file.
 */
function regexMayStart(code: string, at: number, prev: string): boolean {
  if (code[at] !== '/' || code[at + 1] === '/' || code[at + 1] === '*') return false
  return prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)
    || /(?<![\w$])(?:return|typeof|case|in|of|delete|void|throw|new)$/.test(code.slice(Math.max(0, at - 10), at).trimEnd())
}

/**
 * If a string, template or regex literal starts at `at` (`prev` = the previous significant char), its
 * end (exclusive); 0 if none starts there; -1 if a string or template starts and never ends. A `/`
 * whose closing slash is not on its line is read as a division.
 */
function literalEnd(code: string, at: number, prev: string): number {
  const c = code[at]
  if (c === "'" || c === '"') return skipQuoted(code, at)
  if (c === '`') return skipTemplate(code, at)
  if (!regexMayStart(code, at, prev)) return 0
  let inClass = false
  for (let j = at + 1; j < code.length && code[j] !== '\n'; j += 1) {
    if (code[j] === '\\') { j += 1; continue }
    if (code[j] === '[') inClass = true
    else if (code[j] === ']') inClass = false
    else if (code[j] === '/' && !inClass) {
      let end = j + 1
      while (/[a-z]/i.test(code[end] ?? '')) end += 1
      return end
    }
  }
  return 0
}

/** Index of the bracket closing the one at `open`, string/template/regex-aware; -1 if unbalanced. */
function matchBracket(code: string, open: number): number {
  const first = CLOSER[code[open] ?? '']
  if (!first) return -1
  const stack = [first]
  let prev = code[open]!
  for (let i = open + 1; i < code.length; i += 1) {
    const c = code[i]!
    const end = literalEnd(code, i, prev)
    if (end === -1) return -1
    if (end > 0) {
      i = end - 1
      prev = 'x'
      continue
    }
    if (c in CLOSER) {
      stack.push(CLOSER[c]!)
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
    if (!/\s/.test(c)) prev = c
  }
  return -1
}

function skipSpace(code: string, at: number): number {
  let i = at
  while (i < code.length && /\s/.test(code[i]!)) i += 1
  return i
}

/**
 * End (exclusive) of the statement starting at `at`: its `;`, or a line break at bracket depth 0 that
 * is not followed by a continuation, or the enclosing block's closing bracket. -1 if unbalanced.
 */
function statementEnd(code: string, at: number): number {
  let prev = ''
  for (let i = at; i < code.length; i += 1) {
    const c = code[i]!
    const end = literalEnd(code, i, prev)
    if (end === -1) return -1
    if (end > 0) {
      i = end - 1
      prev = 'x'
      continue
    }
    if (c in CLOSER) {
      const close = matchBracket(code, i)
      if (close === -1) return -1
      i = close
      prev = 'x'
      continue
    }
    if (c === ';') return i + 1
    if (c === '\n' && !/^\s*(?:[.?:+]|&&|\|\|)/.test(code.slice(i + 1, i + 80))) return i
    if (c === '}' || c === ')' || c === ']') return i
    if (!/\s/.test(c)) prev = c
  }
  return code.length
}

/** The parenthesised condition of the `if` at `at`, as [open, close] bracket indexes. */
function ifCondition(code: string, at: number): [number, number] | null {
  const open = code.indexOf('(', at)
  const close = open === -1 ? -1 : matchBracket(code, open)
  return close === -1 ? null : [open, close]
}

interface IfStatement {
  condition: [number, number]
  then: [number, number]
  else: [number, number] | null
  /** Just past the whole statement, else-chain included. */
  end: number
}

/** Branch extent of a block (`{…}`) or a single statement starting at `at`. */
function branchAt(code: string, at: number): [number, number] | null {
  if (code[at] === '{') {
    const close = matchBracket(code, at)
    return close === -1 ? null : [at, close + 1]
  }
  if (/^if\s*\(/.test(code.slice(at, at + 8))) {
    const nested = parseIf(code, at)
    return nested ? [at, nested.end] : null
  }
  const end = statementEnd(code, at)
  return end <= at ? null : [at, end]
}

function parseIf(code: string, at: number): IfStatement | null {
  const condition = ifCondition(code, at)
  if (!condition) return null
  const then = branchAt(code, skipSpace(code, condition[1] + 1))
  if (!then) return null
  const afterThen = skipSpace(code, then[1])
  let elseBranch: [number, number] | null = null
  if (/^else(?![\w$])/.test(code.slice(afterThen, afterThen + 5))) {
    elseBranch = branchAt(code, skipSpace(code, afterThen + 4))
    if (!elseBranch) return null
  }
  return { condition, then, else: elseBranch, end: elseBranch ? elseBranch[1] : then[1] }
}

/** A statement that only answers CONDITIONALLY: the run below reads it whole and goes on past it. */
const COMPOUND_HEAD = /^(?:if|else|for|while|do|switch|try)(?![\w$])|^\{/

/**
 * The FALL-THROUGH RUN from `at`: the statements of the enclosing block from there on, up to and
 * including the first that ends the path unconditionally — one headed by `return` / `throw`, or a
 * plain statement that answers (`answers`) — or up to the block's end. An inner `if`, loop, `try` or
 * block is read whole and the run continues past it, since what it answers is conditional. null if a
 * statement in the run cannot be delimited.
 */
function fallThroughRun(code: string, at: number, answers: (statement: string) => boolean): [number, number] | null {
  const start = skipSpace(code, at)
  let i = start
  let end = start
  while (i < code.length && !'})]'.includes(code[i]!)) {
    if (code[i] === ';') {
      i = skipSpace(code, i + 1)
      continue
    }
    const statement = branchAt(code, i)
    if (!statement) return null
    end = statement[1]
    const text = code.slice(statement[0], statement[1])
    if (/^(?:return|throw)(?![\w$])/.test(text) || (!COMPOUND_HEAD.test(text) && answers(text))) break
    i = skipSpace(code, end)
  }
  return [start, end]
}

// ── the comparison ────────────────────────────────────────────────────────────

/** Every `===` / `!==` / `==` / `!=` outside string, template and regex literals, as [offset, operator]. */
function equalityOperators(code: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  let prev = ''
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!
    const end = literalEnd(code, i, prev)
    if (end > 0) {
      i = end - 1
      prev = 'x'
      continue
    }
    const op = c === '=' || c === '!' ? /^(?:!==|===|!=|==)/.exec(code.slice(i, i + 3))?.[0] : undefined
    if (op) {
      out.push([i, op])
      i += op.length - 1
      prev = '='
      continue
    }
    if (!/\s/.test(c)) prev = c
  }
  return out
}

/** One bracket level of an expression, as `unitAt` walks it. */
interface Frame {
  /** The opening bracket (for the walked region itself: one before its start). */
  open: number
  /** An odd number of `!` stands right before the bracket. */
  negated: boolean
  /** An arrow `=>` was passed at this level: what follows it is a callback body. */
  arrow: boolean
  /** Where the first such `=>` stands; -1 if none. */
  arrowAt: number
  /** Start of the current operand at this level: just past the last operator that binds looser than `===`. */
  from: number
}

/** The expression around [at, at + length): from the start of its left operand to the end of its right one. */
interface ExpressionUnit {
  start: number
  end: number
  /** The bracket levels enclosing the unit, the walked region first. */
  frames: Frame[]
  /** The unit is the ENTIRE content of its innermost bracket (`!(a === b)`, not `!(x && a === b)`). */
  whole: boolean
}

/** Words that end an operand the way `;` does. */
const OPERAND_ENDING_WORDS = new Set(['return', 'throw', 'yield', 'case', 'else', 'do', 'const', 'let', 'var'])
/** Operators that bind looser than `===` and so end an operand: `&&` `||` `??` (and their `=` forms), `=>`, shift-assignments. */
const LOOSE_OPERATOR = /^(?:&&=?|\|\|=?|\?\?=?|=>|>>>=|>>=|<<=|\*\*=)/

/**
 * Walks [from, to) bracket- and literal-aware and returns the expression unit that holds [at, at + length):
 * at every bracket level an operand runs between the operators that bind looser than `===` — `&&` `||` `??`
 * `?` `:` `,` `;` `=` `=>` `&` `|` `^`, `return` / `throw` / …, and, inside a `{…}` block, a line break
 * that ends a statement. null if the walk cannot reach `at` outside a literal.
 */
function unitAt(code: string, from: number, to: number, at: number, length: number): ExpressionUnit | null {
  const stack: Frame[] = [{ open: from - 1, negated: false, arrow: false, arrowAt: -1, from }]
  let prev = ''
  let held: { start: number; frames: Frame[]; depth: number; fromFrameStart: boolean } | null = null
  const unit = (end: number, byBracket: boolean): ExpressionUnit =>
    ({ start: held!.start, end, frames: held!.frames, whole: byBracket && held!.fromFrameStart })
  for (let i = from; i < to; i += 1) {
    const top = stack[stack.length - 1]!
    if (i === at && held === null) {
      held = { start: top.from, frames: stack.map((f) => ({ ...f })), depth: stack.length, fromFrameStart: top.from === top.open + 1 }
      i = at + length - 1
      prev = code[i]!
      continue
    }
    const end = literalEnd(code, i, prev)
    if (end === -1) return null
    if (end > 0) {
      if (held === null && at > i && at < end) return null
      i = end - 1
      prev = 'x'
      continue
    }
    const c = code[i]!
    if (c in CLOSER) {
      let bangs = 0
      for (let j = i - 1; j >= from && /[\s!]/.test(code[j]!); j -= 1) if (code[j] === '!') bangs += 1
      stack.push({ open: i, negated: bangs % 2 === 1, arrow: false, arrowAt: -1, from: i + 1 })
      prev = c
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      if (held && stack.length === held.depth) return unit(i, true)
      stack.pop()
      if (stack.length === 0) return null
      prev = c
      continue
    }
    const ahead = code.slice(i, i + 4)
    let skip = 0
    let delimiter = 0
    const loose = LOOSE_OPERATOR.exec(ahead)
    if (/^(?:===|!==)/.test(ahead)) skip = 3
    else if (/^(?:==|!=|<=|>=|\?\.(?!\d))/.test(ahead)) skip = 2
    else if (loose) {
      delimiter = loose[0].length
      if (loose[0] === '=>' && !top.arrow) {
        top.arrow = true
        top.arrowAt = i
      }
    } else if ('=?:,;&|^'.includes(c)) delimiter = 1
    else if (/[A-Za-z_$]/.test(c) && !/[\w$]/.test(code[i - 1] ?? '')) {
      const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 40))![0]
      if (code[i - 1] !== '.' && OPERAND_ENDING_WORDS.has(word)) delimiter = word.length
      else skip = word.length
    } else if (c === '\n' && code[top.open] === '{' && !/^\s*(?:[.?:+\-*/%&|^=<>!,)\]}]|&&|\|\|)/.test(code.slice(i + 1, i + 80))) {
      delimiter = 1
    }
    if (delimiter > 0) {
      if (held && stack.length === held.depth) return unit(i, false)
      top.from = i + delimiter
      i += delimiter - 1
      prev = code[i]!
      continue
    }
    if (skip > 0) {
      i += skip - 1
      prev = code[i]!
      continue
    }
    if (!/\s/.test(c)) prev = c
  }
  return held ? unit(to, true) : null
}

type Polarity = 'direct' | 'flipped' | 'unknown'

/**
 * Whether the unit being TRUE makes its enclosing condition true (`direct`), false (`flipped`), or cannot
 * be told from the text (`unknown`): inside a callback, or inside a `!(…)` that holds more than the unit.
 * `bangs` counts the `!` written right before the unit itself (a bound boolean's `!elsewhere`).
 */
function polarityOf(unit: ExpressionUnit, bangs: number): Polarity {
  if (unit.frames.some((f) => f.arrow)) return 'unknown'
  const negated = unit.frames.filter((f) => f.negated)
  if (negated.length === 0) return bangs % 2 === 1 ? 'flipped' : 'direct'
  if (negated.length === 1 && unit.frames[unit.frames.length - 1]!.negated && unit.whole && bangs === 0) return 'flipped'
  return 'unknown'
}

const combinePolarity = (a: Polarity, b: Polarity): Polarity =>
  a === 'unknown' || b === 'unknown' ? 'unknown' : (a === 'flipped') !== (b === 'flipped') ? 'flipped' : 'direct'

/** `text` with every literal and every bracket's content blanked to spaces in place: its top level only. */
function topLevelOnly(text: string): string {
  const unreadable = text.replace(/[^\n]/g, '?')
  const out = text.split('')
  let prev = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    const end = literalEnd(text, i, prev)
    if (end === -1) return unreadable
    if (end > 0) {
      for (let j = i; j < end; j += 1) out[j] = ' '
      i = end - 1
      prev = 'x'
      continue
    }
    if (c in CLOSER) {
      const close = matchBracket(text, i)
      if (close === -1) return unreadable
      for (let j = i + 1; j < close; j += 1) out[j] = ' '
      i = close
      prev = 'x'
      continue
    }
    if (!/\s/.test(c)) prev = c
  }
  return out.join('')
}

/**
 * The polarity of a comparison that is the WHOLE body of a one-parameter, expression-bodied arrow handed
 * straight to `.some(…)` / `.every(…)` on a dotted name — `!rows.some((row) => String(row.id) === x)`.
 * Both are monotone in their predicate, so the comparison keeps the polarity of the call, `!`s before its
 * receiver counted. Read through only when that call is a whole operand of `&&` / `||` at the region's top
 * level (region start, `&&` or `||` before it; region end, `&&` or `||` after it) and that top level holds
 * no `?` / `:` / `??` — otherwise, and for every other callback, null (the caller keeps `unknown`).
 */
function quantifiedPolarity(code: string, unit: ExpressionUnit, region: [number, number]): Polarity | null {
  if (unit.frames.length !== 2) return null
  const [outer, call] = unit.frames as [Frame, Frame]
  if (outer.arrow || !call.arrow || call.negated) return null
  const close = matchBracket(code, call.open)
  if (close === -1 || unit.end !== close) return null
  if (!/^\s*(?:\(\s*[A-Za-z_$][\w$]*\s*(?::[^(),]*)?\)|[A-Za-z_$][\w$]*)\s*$/.test(code.slice(call.open + 1, call.arrowAt))) return null
  if (code.slice(call.arrowAt + 2, unit.start).trim() !== '') return null
  const head = code.slice(region[0], call.open)
  const receiver = /(?<![\w$.!])(!*)\s*[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*\s*\??\.\s*(?:some|every)\s*$/.exec(head)
  if (!receiver || !/(?:^|&&|\|\|)\s*$/.test(head.slice(0, receiver.index))) return null
  if (!/^\s*(?:;?\s*$|&&(?!=)|\|\|(?!=))/.test(code.slice(close + 1, region[1]))) return null
  if (/\?(?!\.)|:/.test(topLevelOnly(code.slice(region[0], region[1])))) return null
  return receiver[1]!.length % 2 === 1 ? 'flipped' : 'direct'
}

/**
 * The operand's VALUE is a sheet id: it holds an identifier, or a quoted key (`row['sheet_id']`,
 * `.get('sheetId')`), named `…sheetId` / `…sheet_id` in any case, that is not dereferenced any further
 * (`sheetId.length` is a number). Wrappers do not matter: `String(x.sheet_id ?? '')`, `(x.sheet_id as string)`,
 * `normalise(x.sheet_id)`, `x.sheetId.trim()` all count.
 */
function isSheetIdValued(operand: string): boolean {
  for (const m of operand.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])|'([\w$]*)'|"([\w$]*)"/g)) {
    const name = m[1] ?? m[2] ?? m[3] ?? ''
    if (!/sheet_?id$/i.test(name)) continue
    if (/^\s*\]?\s*\??\.\s*[A-Za-z_$][\w$]*(?![\w$])(?!\s*\()/.test(operand.slice(m.index! + m[0].length))) continue
    return true
  }
  return false
}

/** A literal, once wrapping parentheses and `as const` are peeled off. */
function isLiteralOperand(operand: string): boolean {
  let o = operand.trim()
  while (o.startsWith('(') && matchBracket(o, 0) === o.length - 1) o = o.slice(1, -1).trim()
  o = o.replace(/\s+as\s+const$/, '')
  return /^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`|-?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0x[\da-f]+|null|undefined|true|false|NaN|Infinity|void\s+0)$/i.test(o)
}

/** `name = …` / `name ||= …` or `const/let/var name[: T] = …`, but not `==`, `=>`, or a member / index write. */
const BINDING = /(?<![\w$.])(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?|([A-Za-z_$][\w$]*)\s*(?:\|\||&&|\?\?)?)\s*=(?![=>])/g

/** A position test against sorted, disjoint [start, end) spans. */
function withinSpans(spans: ReadonlyArray<[number, number]>): (at: number) => boolean {
  return (at) => {
    let lo = 0
    let hi = spans.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const [s, e] = spans[mid]!
      if (at < s) hi = mid - 1
      else if (at >= e) lo = mid + 1
      else return true
    }
    return false
  }
}

/**
 * The binding whose initialiser holds `at`: the nearest `name = …` before it — outside every literal —
 * whose statement runs past it.
 */
function bindingAround(code: string, at: number, inLiteral: (at: number) => boolean): { name: string; from: number; end: number } | null {
  const lo = Math.max(0, at - 3000)
  const candidates = [...code.slice(lo, at).matchAll(BINDING)]
  for (let k = candidates.length - 1; k >= 0; k -= 1) {
    const m = candidates[k]!
    const name = (m[1] ?? m[2])!
    if (OPERAND_ENDING_WORDS.has(name) || inLiteral(lo + m.index!)) continue
    const from = skipSpace(code, lo + m.index! + m[0].length)
    if (from > at) continue
    const end = statementEnd(code, from)
    if (end !== -1 && at < end) return { name, from, end }
  }
  return null
}

// ── the answer ────────────────────────────────────────────────────────────────

/** Response methods that END the request, ones that only WRITE to it, and ones that only READ it. */
const RESPONSE_ENDS = ['status', 'json', 'jsonp', 'send', 'sendStatus', 'sendFile', 'end', 'redirect', 'render', 'download', 'flushHeaders']
const RESPONSE_WRITES = ['write', 'writeHead', 'set', 'header', 'setHeader', 'append', 'location', 'links', 'cookie', 'clearCookie', 'type', 'contentType', 'attachment', 'vary', 'format']
const RESPONSE_READS = ['get', 'getHeader', 'getHeaders', 'getHeaderNames', 'hasHeader', 'removeHeader', 'on', 'once', 'off', 'addListener', 'removeListener']
const RESPONSE_METHOD = new RegExp(String.raw`\.\s*(${[...RESPONSE_ENDS, ...RESPONSE_WRITES].join('|')})\s*\(`, 'g')
/** A call (not a keyword): the callee's last name and its `(`. */
const CALLEE = /(?<![\w$])(?!(?:if|for|while|switch|catch|return|new|function|typeof|await|async|throw|void|delete|in|of|instanceof|yield|super)(?![\w$]))([A-Za-z_$][\w$]*)\s*\(/g
/** What a response object is called when the handler does not say (and outside every handler). */
const DEFAULT_RESPONSE_NAMES = ['res', 'response']

/** The response object itself as a value (`res`, `{ res }`, `[res]`), not a read off it (`res.locals`, `res[k]`). */
const responseToken = (names: readonly string[], flags = ''): RegExp =>
  new RegExp(String.raw`(?<![\w$.])(?:${names.map(escapeName).join('|')})(?![\w$])(?!\s*(?:\??\.|\[))`, flags)

/** A list split at its top-level commas (brackets and literals respected). */
function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let from = 0
  let prev = ''
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i]!
    const end = literalEnd(list, i, prev)
    if (end === -1) return [list]
    if (end > 0) {
      i = end - 1
      prev = 'x'
      continue
    }
    if (c in CLOSER) {
      const close = matchBracket(list, i)
      if (close === -1) return [list]
      i = close
      prev = 'x'
      continue
    }
    if (c === ',') {
      parts.push(list.slice(from, i))
      from = i + 1
    }
    if (!/\s/.test(c)) prev = c
  }
  parts.push(list.slice(from))
  return parts
}

/**
 * A value the path hands to code that answers it ELSEWHERE, at `at` (an offset in the text read):
 *   throw   a `throw` — answered by a `catch` (see `consumerOf`);
 *   return  a returned `{ …status… }` object — answered by whoever receives it (see `consumerOf`);
 *   pass    `next(…)` / `reject(…)` / `Promise.reject(…)` — answered outside the handler, never followed.
 */
interface Handoff { kind: 'throw' | 'return' | 'pass'; at: number }

interface AnswerRead {
  /** The text answers the request. */
  answers: boolean
  /** Everything the answer carries, or null if some of it could not be delimited (read as echo). */
  payloads: string[] | null
  /** Values handed on to be answered elsewhere; the answer given THERE is part of this path's payload. */
  handoffs: Handoff[]
}

/**
 * Functions a handler defines for itself that reach its response object — `const refuse = () => res.status(…)…`,
 * `const send = res.json.bind(res)`, `function refuse() { res… }` — or that throw, by name, with the text that
 * defines them. A call to one of these answers the way its definition does.
 */
function responseClosures(handlerText: string, responseNames: readonly string[]): Map<string, string> {
  // …or that THROW: a call to one hands its error on to wherever it is caught, which readAnswer does not
  // follow through a call — so such a call answers, and reads as echo.
  const reaches = new RegExp(String.raw`(?<![\w$.])(?:${responseNames.map(escapeName).join('|')}|throw)(?![\w$])`)
  const closures = new Map<string, string>()
  for (const m of handlerText.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?![=>])\s*/g)) {
    const from = m.index! + m[0].length
    const end = statementEnd(handlerText, from)
    const init = end === -1 ? handlerText.slice(from) : handlerText.slice(from, end)
    if (reaches.test(init)) closures.set(m[1]!, init)
  }
  for (const m of handlerText.matchAll(/(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = m.index! + m[0].length - 1
    const paramsEnd = matchBracket(handlerText, params)
    const body = paramsEnd === -1 ? -1 : handlerText.indexOf('{', paramsEnd)
    const bodyEnd = body === -1 ? -1 : matchBracket(handlerText, body)
    const text = bodyEnd === -1 ? handlerText.slice(m.index!) : handlerText.slice(m.index!, bodyEnd + 1)
    if (reaches.test(text)) closures.set(m[1]!, text)
  }
  return closures
}

/**
 * Reads a mismatch path. Every construct that makes it ANSWER also contributes its PAYLOAD, so the answer
 * trigger and the payload read are the same constructs:
 *   - a response method on ANY receiver — `.status/json/jsonp/send/sendStatus/sendFile/end/redirect/render/
 *     download/flushHeaders(` answers; `.write/writeHead/set/header/setHeader/append/location/links/cookie/
 *     clearCookie/type/contentType/attachment/vary/format(` only writes — and either way ALL its arguments are payload;
 *   - on the response object itself, the WHOLE chain is walked (`res.status(404).set(…).json(…)`, `res['json'](…)`):
 *     every call in it is payload, any call other than a known read (`get`, `getHeader`, `on`, …) or write
 *     answers, and a property write at its end (`res.statusMessage = …`) answers with the assigned value;
 *   - a call handed the response object ANYWHERE in its arguments (`refuse(req, res)`, `refuse(404, res, …)`,
 *     `refuse({ res, viewId })`) answers, and everything else it is handed — `req` included — is payload;
 *   - a call to a function the handler defined over its response object (`closures`) answers, and carries its
 *     arguments plus whatever that definition's own answer carries (a closure that itself throws, returns a
 *     status object or calls `next` reads as undelimited, i.e. echo);
 *   - `throw`: the thrown expression; `next(…)` / `reject(…)` / `Promise.reject(…)` with an argument: the argument;
 *   - `return {…}` with a `status` key anywhere in it: the whole object;
 *   - every `new X(…)` on the path: its arguments.
 * The last three answer SOMEWHERE ELSE, so each is also listed as a handoff: the scan then reads the place
 * that answers it (`consumerOf`) as part of the same payload, and reads it as echo where there is none.
 */
function readAnswer(text: string, responseNames: readonly string[], closures: ReadonlyMap<string, string> = new Map()): AnswerRead {
  let answers = false
  const payloads: string[] = []
  const handoffs: Handoff[] = []
  const argsOf = (open: number): string | null => {
    const close = matchBracket(text, open)
    return close === -1 ? null : text.slice(open + 1, close)
  }
  for (const m of text.matchAll(RESPONSE_METHOD)) {
    const args = argsOf(m.index! + m[0].length - 1)
    if (args === null) return { answers: true, payloads: null, handoffs: [] }
    payloads.push(args)
    if (RESPONSE_ENDS.includes(m[1]!)) answers = true
  }
  // The whole chain hanging off the response object: `res.status(404).set(…).json(…)`, `res['json'](…)`,
  // `res.statusMessage = …`. Every call in it is payload; any call that is not a known read/write, and any
  // property write at its end, answers.
  const receiver = new RegExp(String.raw`(?<![\w$.])(?:${responseNames.map(escapeName).join('|')})(?![\w$])(?=\s*(?:\??\.|\[))`, 'g')
  for (const m of text.matchAll(receiver)) {
    let i = m.index! + m[0].length
    let member: string | null = null
    for (;;) {
      let j = skipSpace(text, i)
      if (text.startsWith('?.', j)) j += 2
      else if (text[j] === '.') j += 1
      else if (!(text[j] === '[' || text[j] === '(' || (text[j] === '=' && !/^=[=>]/.test(text.slice(j, j + 2))))) break
      j = skipSpace(text, j)
      const c = text[j]
      if (c === '[') {
        const close = matchBracket(text, j)
        if (close === -1) return { answers: true, payloads: null, handoffs: [] }
        member = '[]'
        i = close + 1
      } else if (c === '(') {
        const args = argsOf(j)
        if (args === null) return { answers: true, payloads: null, handoffs: [] }
        payloads.push(args)
        if (member === null || !(RESPONSE_READS.includes(member) || RESPONSE_WRITES.includes(member))) answers = true
        member = null
        i = matchBracket(text, j) + 1
      } else if (c === '=' && member !== null && text[j - 1] !== '.') {
        answers = true
        const end = statementEnd(text, j + 1)
        if (end === -1) return { answers: true, payloads: null, handoffs: [] }
        payloads.push(text.slice(j + 1, end))
        break
      } else {
        const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(j, j + 80))
        if (!name) break
        member = name[0]
        i = j + name[0].length
      }
    }
  }
  const handed = responseToken(responseNames)
  const handedAll = responseToken(responseNames, 'g')
  for (const m of text.matchAll(CALLEE)) {
    const args = argsOf(m.index! + m[0].length - 1)
    if (args === null) return { answers: true, payloads: null, handoffs: [] }
    const closure = text[m.index! - 1] === '.' ? undefined : closures.get(m[1]!)
    if (closure !== undefined) {
      const inner = readAnswer(closure, responseNames)
      // A closure that hands its value on (throws, returns a status object, calls next) is not followed.
      if (inner.payloads === null || inner.handoffs.length > 0) return { answers: true, payloads: null, handoffs: [] }
      answers = true
      payloads.push(args, ...inner.payloads)
      continue
    }
    if (!handed.test(args)) continue
    answers = true
    payloads.push(args.replace(handedAll, ' '))
  }
  for (const m of text.matchAll(/(?<![\w$.])throw(?![\w$])/g)) {
    answers = true
    const from = m.index! + m[0].length
    const end = statementEnd(text, from)
    if (end === -1) return { answers: true, payloads: null, handoffs: [] }
    payloads.push(text.slice(from, end))
    handoffs.push({ kind: 'throw', at: m.index! })
  }
  for (const m of text.matchAll(/(?<![\w$.])next\s*\(|(?<![\w$])reject\s*\(/g)) {
    const args = argsOf(m.index! + m[0].length - 1)
    if (args === null) return { answers: true, payloads: null, handoffs: [] }
    if (args.trim() === '') continue
    answers = true
    payloads.push(args)
    handoffs.push({ kind: 'pass', at: m.index! })
  }
  for (const m of text.matchAll(/(?<![\w$.])return\s*(?=\{)/g)) {
    const open = m.index! + m[0].length
    const close = matchBracket(text, open)
    if (close === -1) return { answers: true, payloads: null, handoffs: [] }
    const object = text.slice(open, close + 1)
    if (!/(?<![\w$.])status\s*:|['"]status['"]\s*:/.test(object)) continue
    answers = true
    payloads.push(object)
    handoffs.push({ kind: 'return', at: m.index! })
  }
  for (const m of text.matchAll(/(?<![\w$.])new\s+[A-Za-z_$][\w$.]*\s*\(/g)) {
    const args = argsOf(m.index! + m[0].length - 1)
    if (args === null) return { answers, payloads: null, handoffs }
    payloads.push(args)
  }
  return { answers, payloads, handoffs }
}

// ── constants ─────────────────────────────────────────────────────────────────

const TEMPLATE_LITERAL = /`(?:[^`\\]|\\.)*`/g
const QUOTED_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g
const LITERAL_INITIALISER = /^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`|-?\d+(?:\.\d+)?)(?:\s+as\s+const)?\s*;?$/

const escapeName = (name: string): string => name.replace(/\$/g, '\\$')

/** Parameter lists and destructuring patterns of a file: places a name can be bound without `name =`. */
function bindingLists(code: string): string[] {
  const lists: string[] = []
  for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s*([{[][^=;]*?[}\]])\s*(?::[^=;]+)?=(?![=>])/g)) lists.push(m[1]!)
  for (const m of code.matchAll(/(?<![\w$])function\s*\*?\s*[\w$]*\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) lists.push(m[1]!)
  for (const m of code.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*[^=;{}()]+)?\s*=>/g)) lists.push(m[1]!)
  for (const m of code.matchAll(/(?<![\w$])catch\s*\(([^()]*)\)/g)) lists.push(m[1]!)
  return lists
}

/** `name` is bound NOWHERE in `code` (no declaration, parameter, destructuring, catch, assignment or ++/--). */
function neverBound(code: string, lists: readonly string[], name: string): boolean {
  const n = escapeName(name)
  const id = new RegExp(String.raw`(?<![\w$.])${n}(?![\w$])`)
  if (new RegExp(String.raw`(?<![\w$.])(?:const|let|var|function\s*\*?|class|enum)\s+${n}(?![\w$])`).test(code)) return false
  if (new RegExp(String.raw`(?<![\w$.])${n}\s*(?:\*\*|>>>|>>|<<|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])|(?<![\w$.])${n}\s*(?:\+\+|--)|(?:\+\+|--)\s*${n}(?![\w$])|(?<![\w$.])${n}\s*=>`).test(code)) return false
  return !lists.some((list) => id.test(list))
}

/**
 * `name` is a MODULE constant of `code`: declared once, at column 0, as `const` (or `export const`) with a
 * plain literal initialiser, and bound nowhere else in the file — so no local, parameter or later
 * assignment can stand in for it where it is read.
 */
function moduleLiteralConstant(code: string, lists: readonly string[], name: string, exportedOnly: boolean): boolean | null {
  const declarations = [...code.matchAll(new RegExp(
    String.raw`^${exportedOnly ? String.raw`export\s+` : String.raw`(?:export\s+)?`}const\s+${escapeName(name)}\s*(?::[^=\n]+)?=(?![=>])\s*`,
    'gm',
  ))]
  if (declarations.length !== 1) return declarations.length === 0 ? null : false
  const at = declarations[0]!.index!
  const from = at + declarations[0]![0].length
  const end = statementEnd(code, from)
  if (end === -1 || !LITERAL_INITIALISER.test(code.slice(from, end).trim())) return false
  // The declaration itself is no parameter list or destructuring, so `lists` holds for the rest as well.
  return neverBound(code.slice(0, at) + code.slice(end), lists, name)
}

/**
 * The names of `code` that are provably one literal value wherever they are read: its own module
 * constants, and names imported unrenamed from a relative module that exports them as one.
 */
function constantNames(code: string): (name: string) => boolean {
  const cache = new Map<string, boolean>()
  let lists: string[] | null = null
  const decide = (name: string): boolean => {
    lists ??= bindingLists(code)
    const local = moduleLiteralConstant(code, lists, name, false)
    if (local !== null) return local
    if (!neverBound(code, lists, name)) return false
    for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
      if (!splitTopLevel(m[1]!).some((spec) => spec.trim() === name)) continue
      if (!m[2]!.startsWith('.')) return false
      const base = join(ROUTES_DIR, m[2]!)
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (!existsSync(candidate)) continue
        const moduleCode = maskComments(readFileSync(candidate, 'utf8'))
        return moduleLiteralConstant(moduleCode, bindingLists(moduleCode), name, true) === true
      }
      return false
    }
    return false
  }
  return (name) => {
    let known = cache.get(name)
    if (known === undefined) {
      known = decide(name)
      cache.set(name, known)
    }
    return known
  }
}

/**
 * Fail-closed: true only when every leaf of `expr` is provably a constant — a literal, or a name
 * `isConstantName` vouches for. A `${…}` hole, a spread, a member path, a call, a shorthand property or any
 * other name reads as echo.
 */
function isConstantExpression(expr: string, isConstantName: (name: string) => boolean): boolean {
  const templates: string[] = expr.match(TEMPLATE_LITERAL) ?? []
  if (templates.some((t) => t.includes('${'))) return false
  const residue = expr.replace(TEMPLATE_LITERAL, ' ').replace(QUOTED_LITERAL, ' ')
  if (residue.includes('...')) return false
  const leaves = residue
    .replace(/(?<![\w$.])as\s+const(?![\w$])/g, ' ')
    .replace(/(?<![\w$.])new\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g, ' ')
    .replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1')
  for (const ref of leaves.match(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/g) ?? []) {
    if (/^(?:true|false|null|undefined)$/.test(ref)) continue
    if (!/^[A-Za-z_$][\w$]*$/.test(ref)) return false
    if (!isConstantName(ref)) return false
  }
  return true
}

// ── authority position ────────────────────────────────────────────────────────

/**
 * The closure guard's AUTHORITY_REFUSAL: a 403-class refusal. NOT widened to 401 — the GAP is answering
 * before the 403 (a signed-in caller holding nothing gets 403 on its own view and something else on a
 * foreign one), and a 401 only turns away callers who are not signed in, so it closes none of that.
 */
const AUTHORITY_REFUSAL_403 = /\.status\(\s*403\s*\)|(?<![\w$])status:\s*403(?![\w$])|(?<![\w$])send\w*Forbidden\w*\(|(?<![\w$])ForbiddenError(?![\w$])|(?<![\w$])requireRecordReadable\(/

const SHAPE_ROUTE_DECL = /^([ \t]*)router\.(get|post|patch|delete|put)\(\s*'([^']+)'/
const SHAPE_FN_DECL = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+?)?\s*=>/gm
/** The handler's `(req, res)` on its declaration line: the second name is what the response object is called. */
const HANDLER_PARAMS = /\(\s*[A-Za-z_$][\w$]*\s*(?::\s*[\w$.<>]+)?\s*,\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+)?\s*(?:,\s*[A-Za-z_$][\w$]*\s*(?::\s*[\w$.<>]+)?\s*)?\)\s*(?::\s*[^=]+)?=>/g

interface HandlerSpan { key: string; start: number; end: number; responseNames: string[] }

function handlerSpans(code: string): HandlerSpan[] {
  const lines = code.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const spans: HandlerSpan[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = SHAPE_ROUTE_DECL.exec(lines[i]!)
    if (!m) continue
    let j = i + 1
    while (j < lines.length && lines[j]!.trimEnd() !== `${m[1]}})` && !SHAPE_ROUTE_DECL.test(lines[j]!)) j += 1
    const declared = [...lines[i]!.matchAll(HANDLER_PARAMS)].pop()?.[1]
    spans.push({
      key: `${m[2]!.toUpperCase()} ${m[3]}`,
      start: offsets[i]!,
      end: j < lines.length ? offsets[j]! + lines[j]!.length : code.length,
      responseNames: declared && !DEFAULT_RESPONSE_NAMES.includes(declared) ? [...DEFAULT_RESPONSE_NAMES, declared] : DEFAULT_RESPONSE_NAMES,
    })
  }
  return spans
}

// ── where a handed-off value is answered ──────────────────────────────────────

/** The text that answers a handed-off value, and the name the value goes by there (null: it has none). */
interface Consumer { text: string; name: string | null }

/**
 * Where the value handed off at `at` is ANSWERED, inside `handler`:
 *   throw   the `catch` of the innermost `try` of the handler whose block holds the `throw`: its body, and
 *           its parameter;
 *   return  the function holding the `return` is written inside the initialiser of a binding
 *           (`const failure = await pool.transaction(async … => { … })`, or `failure = …`): the first
 *           later `if` in the handler that names the binding, provided its condition is the bare binding
 *           — its then-branch, and the binding.
 * null — NOT FOLLOWED, read as echo — for `next(…)` / `reject(…)`, for a site outside every handler, for
 * a throw with no enclosing `try` (or only a `finally`), and for an object returned anywhere else.
 */
function consumerOf(
  code: string,
  handler: HandlerSpan | null,
  handoff: Handoff,
  at: number,
  ifStarts: readonly number[],
  conditionOf: (start: number) => [number, number] | null,
  inLiteral: (at: number) => boolean,
): Consumer | null {
  if (!handler || handoff.kind === 'pass') return null
  const before = code.slice(handler.start, at)
  if (handoff.kind === 'throw') {
    let tryOpen = -1
    let tryClose = -1
    for (const m of before.matchAll(/(?<![\w$.])try\s*\{/g)) {
      const open = handler.start + m.index! + m[0].length - 1
      if (inLiteral(open)) continue
      const close = matchBracket(code, open)
      if (close > at && open > tryOpen) {
        tryOpen = open
        tryClose = close
      }
    }
    if (tryOpen === -1) return null
    const after = skipSpace(code, tryClose + 1)
    const clause = /^catch\s*(?:\(\s*([A-Za-z_$][\w$]*)?[^)]*\))?\s*\{/.exec(code.slice(after, after + 200))
    if (!clause) return null
    const bodyOpen = after + clause[0].length - 1
    const bodyClose = matchBracket(code, bodyOpen)
    return bodyClose === -1 ? null : { text: code.slice(bodyOpen, bodyClose + 1), name: clause[1] ?? null }
  }
  // return: the innermost function body holding the `return`, then the binding its initialiser sits in.
  let body = -1
  for (const m of before.matchAll(/=>\s*\{|(?<![\w$.])function(?![\w$])[^{;]*\{/g)) {
    const open = handler.start + m.index! + m[0].length - 1
    if (inLiteral(handler.start + m.index!)) continue
    if (open > body && matchBracket(code, open) > at) body = open
  }
  if (body === -1) return null
  const bound = bindingAround(code, body, inLiteral)
  if (!bound || bound.end <= at) return null
  const named = new RegExp(String.raw`(?<![\w$.])${escapeName(bound.name)}(?![\w$])`)
  for (const start of ifStarts) {
    if (start < bound.end || start >= handler.end) continue
    const condition = conditionOf(start)
    if (!condition || !named.test(code.slice(condition[0] + 1, condition[1]))) continue
    // The first `if` that names the binding is the consumer; only `if (<binding>)` is read as one.
    if (code.slice(condition[0] + 1, condition[1]).trim() !== bound.name) return null
    const consumer = parseIf(code, start)
    return consumer ? { text: code.slice(consumer.then[0], consumer.then[1]), name: bound.name } : null
  }
  return null
}

// ── the scan ──────────────────────────────────────────────────────────────────

interface PairingSite {
  key: string
  /** For messages only; never part of the key. */
  line: number
  echo: boolean
  beforeAuthority: boolean | null
}

interface PairingScan {
  sites: PairingSite[]
  /** Sites whose `if` or whose expression could not be parsed — reported, never silently skipped. */
  unparseable: string[]
  handlers: number
}

function scanSheetPairings(source: string): PairingScan {
  const code = maskComments(source)
  const lineAt = (index: number) => code.slice(0, index).split('\n').length
  const handlers = handlerSpans(code)
  const fnDecls = [...code.matchAll(SHAPE_FN_DECL)].map((m) => ({ index: m.index!, name: (m[1] ?? m[2])! }))
  const ifStarts = [...code.matchAll(/(?<![\w$.])if\s*\(/g)].map((m) => m.index!)
  const conditions = new Map<number, [number, number] | null>()
  const conditionOf = (start: number) => {
    if (!conditions.has(start)) conditions.set(start, ifCondition(code, start))
    return conditions.get(start)!
  }
  const isConstantName = constantNames(code)
  const inLiteral = withinSpans(literalSpans(code))
  const closuresByHandler = new Map<HandlerSpan, Map<string, string>>()
  const sites: PairingSite[] = []
  const unparseable: string[] = []

  let firstIfAfter = 0
  for (const [at, op] of equalityOperators(code)) {
    while (firstIfAfter < ifStarts.length && ifStarts[firstIfAfter]! < at) firstIfAfter += 1
    const handler = handlers.find((h) => at >= h.start && at < h.end) ?? null

    // 1. The region that holds the comparison: the condition of the nearest `if` whose `(…)` spans it…
    let statement: IfStatement | null = null
    let region: [number, number] | null = null
    let nearestFailed = false
    for (let k = firstIfAfter - 1; k >= 0; k -= 1) {
      const start = ifStarts[k]!
      if (start < at - 4000) break
      const condition = conditionOf(start)
      if (!condition) {
        if (start > at - 600) nearestFailed = true
        continue
      }
      if (condition[0] < at && condition[1] > at) {
        region = [condition[0] + 1, condition[1]]
        statement = parseIf(code, start)
        if (!statement) nearestFailed = true
        break
      }
    }
    // …or the initialiser of the binding it is first assigned to, across line breaks, with or without a keyword.
    const binding = region ? null : bindingAround(code, at, inLiteral)
    if (binding) region = [binding.from, binding.end]
    if (!region) continue

    // 2. Its operands, whole: from the looser operator before it to the one after it.
    const unit = unitAt(code, region[0], region[1], at, op.length)
    if (!unit) {
      if (/sheet_?id/i.test(code.slice(region[0], region[1]))) unparseable.push(`line ${lineAt(at)}: the expression around \`${op}\``)
      continue
    }
    const left = code.slice(unit.start, at).trim()
    const right = code.slice(at + op.length, unit.end).trim()
    if (!isSheetIdValued(left) && !isSheetIdValued(right)) continue
    if (isLiteralOperand(left) || isLiteralOperand(right)) continue
    const text = `${left} ${op} ${right}`.replace(/\s+/g, ' ')

    // 3. Its polarity in the `if` that decides — through the bound boolean when there is one.
    let polarity = quantifiedPolarity(code, unit, region) ?? polarityOf(unit, 0)
    if (binding) {
      const limit = handler ? handler.end : at + 4000
      const use = new RegExp(String.raw`(?<![\w$.])${escapeName(binding.name)}(?![\w$])`, 'g')
      for (let k = firstIfAfter; k < ifStarts.length && ifStarts[k]! < limit; k += 1) {
        const start = ifStarts[k]!
        if (start < binding.end) continue
        const condition = conditionOf(start)
        if (!condition) continue
        const uses = [...code.slice(condition[0] + 1, condition[1]).matchAll(use)].filter((u) => !inLiteral(condition[0] + 1 + u.index!))
        if (uses.length === 0) continue
        statement = parseIf(code, start)
        if (!statement) {
          nearestFailed = true
          break
        }
        const aliasAt = condition[0] + 1 + uses[0]!.index!
        const aliasUnit = unitAt(code, condition[0] + 1, condition[1], aliasAt, binding.name.length)
        const prefix = aliasUnit ? code.slice(aliasUnit.start, aliasAt) : ''
        const suffix = aliasUnit ? code.slice(aliasAt + binding.name.length, aliasUnit.end) : ''
        const aliasPolarity: Polarity = !aliasUnit || uses.length > 1 || !/^[\s!]*$/.test(prefix) || suffix.trim() !== ''
          ? 'unknown'
          : polarityOf(aliasUnit, (prefix.match(/!/g) ?? []).length)
        polarity = combinePolarity(polarity, aliasPolarity)
        break
      }
    }
    if (!statement) {
      if (nearestFailed) unparseable.push(`line ${lineAt(at)}: ${text}`)
      continue
    }

    // 4. The mismatch path(s) — both branches when the polarity is unknown — and whether any answers.
    //    A mismatch branch that does not end the path, opposite one that does, continues into the
    //    FALL-THROUGH RUN after the `if` (with no else, the empty else-branch is such a branch).
    const mismatchWhenTrue = (op === '!==' || op === '!=') !== (polarity === 'flipped')
    const responseNames = handler ? handler.responseNames : DEFAULT_RESPONSE_NAMES
    let closures = handler ? closuresByHandler.get(handler) : undefined
    if (handler && !closures) {
      closures = responseClosures(code.slice(handler.start, handler.end), responseNames)
      closuresByHandler.set(handler, closures)
    }
    const ends = (span: [number, number] | null) => span !== null && /(?<![\w$.])(?:return|throw)(?![\w$])/.test(code.slice(span[0], span[1]))
    const paths: Array<[number, number]> = []
    const ifEnd = statement.end
    let undelimited = false
    const mismatchPath = (branch: [number, number] | null, other: [number, number] | null) => {
      if (branch) paths.push(branch)
      if (ends(branch) || !ends(other)) return
      const run = fallThroughRun(code, ifEnd, (next) => readAnswer(next, responseNames, closures).answers)
      if (run) paths.push(run)
      else undelimited = true
    }
    if (polarity === 'unknown' || mismatchWhenTrue) mismatchPath(statement.then, statement.else)
    if (polarity === 'unknown' || !mismatchWhenTrue) mismatchPath(statement.else, statement.then)
    if (undelimited) {
      unparseable.push(`line ${lineAt(at)}: ${text} (the statements after it)`)
      continue
    }
    const reads = paths.map(([s, e]) => ({ from: s, path: code.slice(s, e), read: readAnswer(code.slice(s, e), responseNames, closures) }))
    const answering = reads.filter((r) => r.read.answers)
    if (answering.length === 0) continue

    // 5. Its shape. A handed-off value is answered where `consumerOf` finds it answered: that answer is
    //    payload too — with the value's own name there (`err`, `failure`) standing for the value, whose
    //    payload is already read at the handoff. No such place in the handler reads as echo.
    const constant = (p: string) => isConstantExpression(p, isConstantName)
    const answeredConstant = (from: number, handoff: Handoff): boolean => {
      const consumer = consumerOf(code, handler, handoff, from + handoff.at, ifStarts, conditionOf, inLiteral)
      if (!consumer) return false
      const read = readAnswer(consumer.text, responseNames, closures)
      if (!read.answers || read.payloads === null || read.handoffs.length > 0) return false
      const value = consumer.name
        ? new RegExp(String.raw`(?<![\w$.])${escapeName(consumer.name)}(?![\w$])(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*`, 'g')
        : null
      return read.payloads.every((p) => constant(value ? p.replace(value, ' null ') : p))
    }
    const echo = answering.some(({ from, read }) => read.payloads === null
      || !read.payloads.every(constant)
      || !read.handoffs.every((h) => answeredConstant(from, h)))
    const fn = handler ? null : fnDecls.filter((f) => f.index < at).pop() ?? null
    const context = handler ? handler.key : fn ? `fn ${fn.name}` : '(module)'
    // A mismatch path that answers ONLY a 403 is the authority refusal itself — no other status in it.
    const answersOnlyWithAuthority = answering.every(({ path }) =>
      AUTHORITY_REFUSAL_403.test(path) && !/\.\s*status\s*\(\s*(?!403\s*\))/.test(path))
    const beforeAuthority = handler
      ? !AUTHORITY_REFUSAL_403.test(code.slice(handler.start, at)) && !answersOnlyWithAuthority
      : null
    sites.push({ key: `${context} | ${text}`, line: lineAt(at), echo, beforeAuthority })
  }

  const seen = new Map<string, number>()
  for (const site of sites) {
    const n = (seen.get(site.key) ?? 0) + 1
    seen.set(site.key, n)
    if (n > 1) site.key = `${site.key} #${n}`
  }
  return { sites, unparseable, handlers: handlers.length }
}

// ── the census ────────────────────────────────────────────────────────────────

interface CensusRow {
  echo: boolean
  beforeAuthority: boolean | null
}

const RESOLVER_PAIRING_KEY = 'fn resolveMetaSheetId | view.sheetId !== sheetId'

const FORM_SHARE_GAP_WHY = 'GAP — #5957 final review (and the r59 handoff\'s "form-share: by name → by shape"). '
  + 'Hand-written, not routed through the #5946 wrapper: BEFORE the handler\'s canManageFormShareForSheet 403 and '
  + 'its liveness refusal, a cross-sheet viewId is answered 404 `View <viewId> does not belong to sheet <sheetId>` '
  + 'and a missing one 404 `View not found: <viewId>` — both ids pasted back, and the two cases told apart, for any '
  + 'signed-in caller, including one the handler would then refuse. Two of the three are write routes. Fix: read the '
  + 'view below the 403 + liveness gates and answer both cases with sendSheetNotLive(res, \'absent\') — fixed means a '
  + 'caller holding nothing gets the same 403 on its own, a foreign and a missing view. This row then leaves the list, '
  + 'its census row flips, and its wire witness below goes from holding GAP to holding FIXED.'

/**
 * The ONLY sites allowed to echo or to answer ahead of their handler's 403. Keyed like the census.
 * MAPPED: the echo never reaches the wire, and the cells that prove it are named. GAP: a known defect.
 */
const SHEET_PAIRING_EXCEPTIONS: Record<string, { kind: 'MAPPED' | 'GAP'; why: string }> = {
  [RESOLVER_PAIRING_KEY]: {
    kind: 'MAPPED',
    why: 'THE resolver. Its ConflictError message names both ids, but it never reaches the wire: every caller goes '
      + 'through orRefuseSheetViewMismatch, which answers sendSheetNotLive(res, \'absent\') instead — held by the '
      + 'by-name cells above (no raw call outside the allow-list, ten wrapped sites, a `return` on every null, no '
      + 'ConflictError branch echoing err.message). It sits outside every handler, so it has no authority position '
      + 'of its own; where its callers run it relative to their gates is pinned by the ROUTES cells.',
  },
  'GET /sheets/:sheetId/views/:viewId/form-share | String(row.sheet_id) !== sheetId': { kind: 'GAP', why: FORM_SHARE_GAP_WHY },
  'PATCH /sheets/:sheetId/views/:viewId/form-share | String(row.sheet_id) !== sheetId': { kind: 'GAP', why: FORM_SHARE_GAP_WHY },
  'POST /sheets/:sheetId/views/:viewId/form-share/regenerate | String(row.sheet_id) !== sheetId': { kind: 'GAP', why: FORM_SHARE_GAP_WHY },
}

/**
 * Every sheet-pairing refusal in routes/univer-meta.ts, with its COMPUTED shape. Closed world: the
 * scan must find exactly these keys. Only the four excepted rows may read anything but
 * `echo: false, beforeAuthority: false`.
 */
const SHEET_PAIRING_CENSUS: Record<string, CensusRow> = {
  // module scope — the #5946 resolver (MAPPED)
  [RESOLVER_PAIRING_KEY]: { echo: true, beforeAuthority: null },
  // GET /context: the addressed sheet must be one the caller can read; its answer IS the 403
  'GET /context | String(row.id) === resolvedSheetId': { echo: false, beforeAuthority: false },
  // config restore: a revision's entity must sit on the sheet being restored
  'POST /sheets/:sheetId/config-restore-preview | fieldRow.sheetId !== sheetId': { echo: false, beforeAuthority: false },
  'POST /sheets/:sheetId/config-restore-preview | rev.entity_id !== rev.sheet_id': { echo: false, beforeAuthority: false },
  'POST /sheets/:sheetId/config-restore-execute | rev.entity_id !== rev.sheet_id': { echo: false, beforeAuthority: false },
  'POST /sheets/:sheetId/config-restore-execute | entitySheetId !== sheetId': { echo: false, beforeAuthority: false },
  'POST /sheets/:sheetId/config-restore-execute | liveField.sheetId !== sheetId': { echo: false, beforeAuthority: false },
  'POST /sheets/:sheetId/config-restore-execute | fieldRow.sheetId !== sheetId': { echo: false, beforeAuthority: false },
  // the three hand-written form-share copies (GAP)
  'GET /sheets/:sheetId/views/:viewId/form-share | String(row.sheet_id) !== sheetId': { echo: true, beforeAuthority: true },
  'PATCH /sheets/:sheetId/views/:viewId/form-share | String(row.sheet_id) !== sheetId': { echo: true, beforeAuthority: true },
  'POST /sheets/:sheetId/views/:viewId/form-share/regenerate | String(row.sheet_id) !== sheetId': { echo: true, beforeAuthority: true },
  // the two view pairings that already sit behind their handler's gates and answer values-free
  'GET /sheets/:sheetId/export-xlsx | view.sheetId !== sheetId': { echo: false, beforeAuthority: false },
  'GET /sheets/:sheetId/view-aggregate | view.sheetId !== sheetId': { echo: false, beforeAuthority: false },
  // cross-base mirror link: the forward link must point at the other end
  'POST /crossbase/mirror-link | forwardCfg.foreignSheetId !== sheetB': { echo: false, beforeAuthority: false },
  // automation delivery logs: the rule must belong to the addressed sheet
  'GET /sheets/:sheetId/automations/:ruleId/dingtalk-person-deliveries | rule.sheet_id !== sheetId': { echo: false, beforeAuthority: false },
  'GET /sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries | rule.sheet_id !== sheetId': { echo: false, beforeAuthority: false },
}

function pairingViolations(scan: PairingScan): string[] {
  const out: string[] = scan.unparseable.map((u) => `UNPARSEABLE — the scan could not read the \`if\` around ${u}`)
  const found = new Map(scan.sites.map((s) => [s.key, s]))
  for (const [key, site] of found) {
    const shape = `echo=${site.echo} beforeAuthority=${site.beforeAuthority}`
    const row = SHEET_PAIRING_CENSUS[key]
    if (!row) out.push(`NEW (line ${site.line}) — not in SHEET_PAIRING_CENSUS: ${key}  [computed ${shape}]`)
    else if (row.echo !== site.echo || row.beforeAuthority !== site.beforeAuthority) {
      out.push(`DECLARED ≠ COMPUTED (line ${site.line}): ${key}  [declared echo=${row.echo} beforeAuthority=${row.beforeAuthority}, computed ${shape}]`)
    }
    const needsException = site.echo || site.beforeAuthority !== false
    if (needsException && !(key in SHEET_PAIRING_EXCEPTIONS)) out.push(`UNEXCUSED (line ${site.line}): ${key}  [${shape}]`)
    if (!needsException && key in SHEET_PAIRING_EXCEPTIONS) out.push(`REDUNDANT exception — the site no longer needs it: ${key}`)
  }
  for (const key of Object.keys(SHEET_PAIRING_CENSUS)) if (!found.has(key)) out.push(`GONE — census row matches no site: ${key}`)
  for (const key of Object.keys(SHEET_PAIRING_EXCEPTIONS)) if (!found.has(key)) out.push(`GONE — exception matches no site: ${key}`)
  return out
}

/**
 * Every string and template literal in `code` (comments already blanked), as [start, end) spans that
 * include the quotes. A real scan, not a regex over the file: one regex over 20k lines desyncs on the
 * first template whose `${…}` holds a backtick and then reads code as strings for thousands of lines
 * (measured while writing this: its longest "literal" was 28k characters). Regex literals are skipped
 * by the usual rule — a `/` after an operator, an opening bracket or a keyword starts one. The cell
 * that uses this checks that every `meta_views` in the code landed inside some span.
 */
function literalSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let prev = ''
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!
    const end = literalEnd(code, i, prev)
    if (end > 0) {
      if (c !== '/') spans.push([i, end])
      i = end - 1
      prev = 'x'
      continue
    }
    if (!/\s/.test(c)) prev = c
  }
  return spans
}

/**
 * The SQL spelling of the same pairing: a `meta_views` SELECT binding BOTH the view id and a sheet id,
 * so a view on another sheet and a missing view both come back as zero rows. The SELECT may stand
 * anywhere in the statement (`WITH v AS (SELECT …) …`, `INSERT … SELECT …`); bare or alias-qualified;
 * `sheet_id` is never read as `id` (lookbehind). Per statement — one literal, or literals joined by
 * `+` — so two statements cannot splice.
 */
const SQL_ID_BIND = String.raw`(?<![.\w])(?:\w+\.)?id\s*=\s*\$\d+`
const SQL_SHEET_BIND = String.raw`(?<![.\w])(?:\w+\.)?sheet_id\s*=\s*\$\d+`
const SQL_VIEW_PAIRING = new RegExp(
  String.raw`(?<![\w$])SELECT(?![\w$])[\s\S]*?(?<![\w$])meta_views(?![\w$])[\s\S]*?(?:${SQL_ID_BIND}[\s\S]*?${SQL_SHEET_BIND}|${SQL_SHEET_BIND}[\s\S]*?${SQL_ID_BIND})`,
  'i',
)

/** The SQL-bearing text of `code`: every literal's body, with literals joined by `+` read as one. */
function sqlStatements(code: string): string[] {
  const statements: string[] = []
  let lastEnd = -1
  for (const [s, e] of literalSpans(code)) {
    const body = code.slice(s + 1, e - 1)
    if (statements.length > 0 && /^\s*\+\s*$/.test(code.slice(lastEnd, s))) statements[statements.length - 1] += body
    else statements.push(body)
    lastEnd = e
  }
  return statements
}

function sqlViewPairings(source: string): string[] {
  return sqlStatements(maskComments(source))
    .filter((sql) => SQL_VIEW_PAIRING.test(sql))
    .map((sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 160))
}

describe('#5946 structural — by SHAPE: a sheet-pairing refusal of the recognised shape, whatever it is called', () => {
  let cached: PairingScan | null = null
  const scan = (): PairingScan => (cached ??= scanSheetPairings(UNIVER_META_SOURCE))

  it('population: every route declaration was seen, and the scan is live (the resolver is found by its shape)', () => {
    const declared = UNIVER_META_SOURCE.split(/\r?\n/).filter((l) => /^\s*router\.(get|post|patch|delete|put)\(\s*'/.test(l)).length
    expect(declared, 'univer-meta.ts lost its route declarations — the scan below would have nothing to read').toBeGreaterThan(100)
    expect(scan().handlers, 'comment blanking swallowed a route declaration').toBe(declared)
    expect(scan().sites.map((s) => s.key)).toContain(RESOLVER_PAIRING_KEY)
    expect(scan().sites.length, 'the scan found (almost) nothing — suspect it before trusting a green census').toBeGreaterThanOrEqual(10)
  })

  it('closed world, declared = computed, and only named exceptions echo or answer before authority', () => {
    expect(pairingViolations(scan()), 'a sheet-pairing refusal changed shape, appeared, or vanished — see the rules above').toEqual([])
  })

  it('the exceptions are the resolver (MAPPED) and form-share routes (GAP) only, each with its reason', () => {
    const gap = Object.entries(SHEET_PAIRING_EXCEPTIONS).filter(([, e]) => e.kind === 'GAP').map(([k]) => k.split(' | ')[0]!)
    const mapped = Object.entries(SHEET_PAIRING_EXCEPTIONS).filter(([, e]) => e.kind === 'MAPPED').map(([k]) => k)
    expect(mapped).toEqual([RESOLVER_PAIRING_KEY])
    // Each GAP route is one the wire witness holds (to GAP while its row is here, to FIXED once it is gone).
    for (const route of gap) expect(FORM_SHARE_ROUTES as readonly string[]).toContain(route)
    for (const exception of Object.values(SHEET_PAIRING_EXCEPTIONS)) expect(exception.why.length).toBeGreaterThan(200)
  })

  it('no meta_views SELECT pairs the view id with a sheet id in SQL (the SQL spelling of the same check)', () => {
    // The literal scan is trusted only if it put EVERY `meta_views` of the code inside some literal —
    // the table name appears nowhere else in this file, so one left outside means the scan desynced.
    const code = maskComments(UNIVER_META_SOURCE)
    const spans = literalSpans(code)
    const occurrences = [...code.matchAll(/(?<![\w$])meta_views(?![\w$])/g)].map((m) => m.index!)
    expect(occurrences.length, 'meta_views vanished from the code — this cell would measure nothing').toBeGreaterThan(10)
    const outside = occurrences.filter((at) => !spans.some(([s, e]) => at > s && at < e))
    expect(outside.map((at) => code.slice(0, at).split('\n').length), 'the literal scan desynced: these meta_views sit outside every literal it found').toEqual([])

    expect(sqlViewPairings(UNIVER_META_SOURCE), 'a view/sheet pairing moved into SQL — give it a census row and a values-free refusal').toEqual([])
  })
})

// ── the GAP, measured on the wire ─────────────────────────────────────────────

/**
 * The static rows say the three form-share routes echo and answer ahead of their 403. These cells say
 * the same thing about the RESPONSES, so the GAP rows describe the product rather than the scanner.
 * For each route, a caller holding nothing asks for three views, and `formShareGapState` names what the
 * three answers show:
 *   GAP      as recorded — on a view that DOES belong to the addressed sheet it is refused 403 (the route's
 *            own authority gate); on a view that belongs to ANOTHER sheet it gets a 404 instead (so the
 *            pairing answered first) that is not the shared #5946 refusal and carries both ids; on a view
 *            that does not exist it gets a different 404 text (so the two cases are told apart);
 *   FIXED    the order FORM_SHARE_GAP_WHY prescribes, stated positively: the SAME 403 FORBIDDEN on all
 *            three views. Nothing weaker counts — in particular not "the foreign view now answers the
 *            shared refusal", which a pairing still standing ahead of the 403 can do while the own-view
 *            403 vs foreign-view 404 difference remains;
 *   CHANGED  neither: the route moved, but not to the fixed state.
 * A route with a GAP row in SHEET_PAIRING_EXCEPTIONS is held to GAP; one without is held to FIXED. So
 * the list below never shrinks: when a route is fixed its GAP cell reds on purpose, its exception row is
 * deleted and its census row updated, and from then on the same entry holds FIXED — a route can only
 * leave the GAP list into three identical 403s, never because the static scan stopped seeing a pairing
 * (moving only the pairing below the 403, with "no such view" still answered first, reads REDUNDANT
 * there and CHANGED here). CHANGED reds with what the three answers were: the route is NOT fixed.
 */
interface WitnessAnswer { status: number; body: unknown; text: string }
type GapState = 'GAP' | 'FIXED' | 'CHANGED'

function formShareGapState(own: WitnessAnswer, foreign: WitnessAnswer, missing: WitnessAnswer): GapState {
  const forbidden = (r: WitnessAnswer) => r.status === FORBIDDEN_STATUS && isDeepStrictEqual(r.body, FORBIDDEN)
  if (forbidden(own) && forbidden(foreign) && forbidden(missing)) return 'FIXED'
  const recorded = forbidden(own)
    && foreign.status === 404 && !isDeepStrictEqual(foreign.body, MISMATCH_BODY)
    && foreign.text.includes(VIEW_ELSEWHERE) && foreign.text.includes(SHEET_LIVE)
    && missing.status === 404 && missing.text !== foreign.text
  return recorded ? 'GAP' : 'CHANGED'
}

const GAP_STATE_WHY: Record<GapState, string> = {
  GAP: 'still answers the GAP as recorded, but its SHEET_PAIRING_EXCEPTIONS row is gone — the route is NOT fixed: '
    + 'restore its GAP row, or fix the ORDER FORM_SHARE_GAP_WHY prescribes',
  FIXED: 'is FIXED — a caller holding nothing gets the same 403 on its own, a foreign and a missing view: delete its '
    + 'SHEET_PAIRING_EXCEPTIONS row and set its SHEET_PAIRING_CENSUS row to echo:false/beforeAuthority:false; '
    + 'its FORM_SHARE_WITNESS entry stays and holds FIXED from then on',
  CHANGED: 'changed but is NOT fixed — a caller holding nothing does not get the same 403 on its own, a foreign and a '
    + 'missing view, so something still answers ahead of the 403 (or the route broke). The fix is the ORDER in '
    + 'FORM_SHARE_GAP_WHY; a GAP row stays until the answers below are three identical 403s',
}

/** The #5957 final review's three routes. Fixed, not derived from the exceptions: the list cannot shrink. */
const FORM_SHARE_ROUTES = [
  'GET /sheets/:sheetId/views/:viewId/form-share',
  'PATCH /sheets/:sheetId/views/:viewId/form-share',
  'POST /sheets/:sheetId/views/:viewId/form-share/regenerate',
] as const

/** Every witnessed route and the state it is held to: GAP while it has a GAP row, FIXED once it has none. */
function witnessPlan(exceptions: Readonly<Record<string, { kind: string }>>): Array<[string, GapState]> {
  return FORM_SHARE_ROUTES.map((route): [string, GapState] => [
    route,
    Object.entries(exceptions).some(([key, e]) => e.kind === 'GAP' && key.startsWith(`${route} | `)) ? 'GAP' : 'FIXED',
  ])
}
const FORM_SHARE_WITNESS: Record<string, (agent: ReturnType<typeof request>, sheetId: string, viewId: string) => request.Test> = {
  'GET /sheets/:sheetId/views/:viewId/form-share': (a, sheetId, viewId) =>
    a.get(`/api/multitable/sheets/${sheetId}/views/${viewId}/form-share`),
  'PATCH /sheets/:sheetId/views/:viewId/form-share': (a, sheetId, viewId) =>
    a.patch(`/api/multitable/sheets/${sheetId}/views/${viewId}/form-share`).send({}),
  'POST /sheets/:sheetId/views/:viewId/form-share/regenerate': (a, sheetId, viewId) =>
    a.post(`/api/multitable/sheets/${sheetId}/views/${viewId}/form-share/regenerate`),
}

describe('GAP witness — the three form-share routes answer the hand-written pairing ahead of their 403', () => {
  const VIEW_NOWHERE = 'viw_5946_form_share_nowhere'

  it('self-check: the witness covers exactly the three form-share routes, and every GAP row is one of them', () => {
    expect(Object.keys(FORM_SHARE_WITNESS).sort()).toEqual([...FORM_SHARE_ROUTES].sort())
    const gap = Object.entries(SHEET_PAIRING_EXCEPTIONS).filter(([, e]) => e.kind === 'GAP').map(([k]) => k.split(' | ')[0])
    for (const route of gap) expect(FORM_SHARE_ROUTES as readonly string[], 'a GAP row with no wire witness').toContain(route)
  })

  it('self-check: a route whose GAP row is deleted stays witnessed, held to FIXED — the list cannot shrink', () => {
    const plan = witnessPlan(SHEET_PAIRING_EXCEPTIONS)
    expect(plan.map(([route]) => route).sort()).toEqual([...FORM_SHARE_ROUTES].sort())
    const getRoute = 'GET /sheets/:sheetId/views/:viewId/form-share'
    const withoutGet = Object.fromEntries(Object.entries(SHEET_PAIRING_EXCEPTIONS).filter(([key]) => !key.startsWith(`${getRoute} | `)))
    const after = witnessPlan(withoutGet)
    expect(after.map(([route]) => route).sort(), 'deleting a GAP row dropped its route from the witness').toEqual([...FORM_SHARE_ROUTES].sort())
    expect(after.find(([route]) => route === getRoute)?.[1]).toBe('FIXED')
  })

  for (const [route, expected] of witnessPlan(SHEET_PAIRING_EXCEPTIONS)) {
    const send = FORM_SHARE_WITNESS[route]!
    const title = expected === 'GAP'
      ? 'the caller it refuses learns, before the 403, that a foreign view exists and on which sheet'
      : 'a caller holding nothing gets the same 403 on its own, a foreign and a missing view'
    it(`${route} (${expected}): ${title}`, async () => {
      const own = await send(on('OUTSIDER'), SHEET_LIVE, VIEW_ON_LIVE)
      const foreign = await send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)
      const missing = await send(on('OUTSIDER'), SHEET_LIVE, VIEW_NOWHERE)

      expect([own.status, own.body], `${route}: a caller holding nothing is not refused on a view that belongs — the witness proves nothing`).toEqual([FORBIDDEN_STATUS, FORBIDDEN])

      const state = formShareGapState(own, foreign, missing)
      const seen = `own ${own.status} / foreign ${foreign.status} ${foreign.text.slice(0, 160)} / missing ${missing.status} ${missing.text.slice(0, 160)}`
      expect(state, `${route} ${GAP_STATE_WHY[state]} [${seen}]`).toBe(expected)
    })
  }
})

// ── self-tests: invisible by name, red by shape ───────────────────────────────

describe('by SHAPE — self-tests: a hand-written copy under new names is invisible to the by-name cells and red here', () => {
  const ANCHOR = "  router.delete('/views/:viewId', "
  const PLANTED = 'GET /sheets/:sheetId/views/:viewId/share-snapshot'

  /** A new route holding `body`, planted just above DELETE /views/:viewId. Nothing touches the disk. */
  const plant = (body: string): string => {
    expect(UNIVER_META_SOURCE).toContain(ANCHOR)
    return UNIVER_META_SOURCE.replace(
      ANCHOR,
      "  router.get('/sheets/:sheetId/views/:viewId/share-snapshot', async (req: Request, res: Response) => {\n"
        + '    const target = String(req.params.sheetId)\n'
        + "    const found = await poolManager.get().query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [req.params.viewId])\n"
        + '    const owner = found.rows[0]\n'
        + `${body}\n`
        + '    return res.json({ ok: true })\n'
        + '  })\n\n'
        + ANCHOR,
    )
  }

  const siteIn = (source: string, keyPrefix: string): PairingSite | undefined =>
    scanSheetPairings(source).sites.find((s) => s.key.startsWith(keyPrefix))

  it('the fourth copy, renamed throughout: every by-name cell stays green over it, the shape census reds', () => {
    const mutated = plant(
      '    if (owner && owner.sheet_id != target) {\n'
        + "      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${req.params.viewId} is not part of ${target}` } })\n"
        + '    }',
    )
    // By name: blind. Each of these is what a by-name cell above asserts, and each still holds.
    expect(rawResolverOffenders(mutated)).toEqual([])
    expect(conflictEchoes(mutated).filter((r) => !(r in CONFLICT_ECHO_ALLOW_LIST))).toEqual([])
    expect(callSitesThatIgnoreNull(mutated)).toEqual([])
    expect(mutated.split(WRAPPED_CALL).length - 1).toBe(ROUTES.length)
    // By shape: seen, with the shape it really has.
    const site = siteIn(mutated, `${PLANTED} | `)
    expect(site, 'the planted pairing refusal is invisible to the shape scan').toBeTruthy()
    expect(site!.key).toBe(`${PLANTED} | owner.sheet_id != target`)
    expect([site!.echo, site!.beforeAuthority]).toEqual([true, true])
    const violations = pairingViolations(scanSheetPairings(mutated)).join('\n')
    expect(violations).toContain(`NEW (line ${site!.line}) — not in SHEET_PAIRING_CENSUS: ${site!.key}`)
    expect(violations).toContain(`UNEXCUSED (line ${site!.line}): ${site!.key}`)
  })

  it('values-free wording does not buy a pass: a new site still reds the closed world, and ahead of the 403 it is unexcused', () => {
    const mutated = plant(
      "    if (!owner || String(owner.sheet_id) !== target) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Nothing here' } })",
    )
    const site = siteIn(mutated, `${PLANTED} | `)!
    expect([site.echo, site.beforeAuthority]).toEqual([false, true])
    const violations = pairingViolations(scanSheetPairings(mutated)).join('\n')
    expect(violations).toContain(`NEW (line ${site.line})`)
    expect(violations).toContain(`UNEXCUSED (line ${site.line})`)
  })

  it('evasions of the obvious spelling are still read: a bound boolean with a message built in a local', () => {
    const mutated = plant(
      '    const elsewhere = owner.sheetId !== target\n'
        + '    const text = `View ${req.params.viewId} lives elsewhere`\n'
        + '    if (elsewhere) {\n'
        + "      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: text } })\n"
        + '    }',
    )
    const site = siteIn(mutated, `${PLANTED} | `)
    expect(site, 'a comparison bound to a boolean first is invisible').toBeTruthy()
    expect(site!.echo, 'a message interpolated into a local first reads as values-free').toBe(true)
  })

  it('…an equality whose else answers, echoing through a shorthand property', () => {
    const mutated = plant(
      '    if (owner.sheetId === target) {\n'
        + '      return res.json({ ok: true })\n'
        + '    } else {\n'
        + '      const viewId = req.params.viewId\n'
        + "      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', viewId } })\n"
        + '    }',
    )
    const site = siteIn(mutated, `${PLANTED} | `)
    expect(site, 'an equality refusing in its else-branch is invisible').toBeTruthy()
    expect(site!.echo, 'a shorthand `{ viewId }` reads as values-free').toBe(true)
  })

  it('…an equality that returns, followed by the refusal, after a 403 (so NOT before authority) — concatenation is still echo', () => {
    const mutated = plant(
      "    if (!req.user) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'no' } })\n"
        + '    if (owner.sheetId === target) return res.json({ ok: true })\n'
        + "    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View ' + req.params.viewId } })",
    )
    const site = siteIn(mutated, `${PLANTED} | `)
    expect(site, 'a fall-through refusal after a returning equality is invisible').toBeTruthy()
    expect([site!.echo, site!.beforeAuthority]).toEqual([true, false])
  })

  it('…a trimmed operand refused through a helper handed `res`, a thrown error, and a response object not named `res`', () => {
    const viaHelper = siteIn(plant("    if (owner.sheet_id.trim() !== target) return refuseElsewhere(res, req.params.viewId)"), `${PLANTED} | `)
    expect(viaHelper?.key).toBe(`${PLANTED} | owner.sheet_id.trim() !== target`)
    expect(viaHelper!.echo, 'an id handed to a refusal helper reads as values-free').toBe(true)

    const thrown = siteIn(plant('    if (String(owner.sheet_id).trim() !== target) throw new NotFoundError(`View ${req.params.viewId}`)'), `${PLANTED} | `)
    expect(thrown?.key).toBe(`${PLANTED} | String(owner.sheet_id).trim() !== target`)
    expect(thrown!.echo).toBe(true)

    const renamed = siteIn(
      plant("    if (owner.sheetId !== target) return response.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })"),
      `${PLANTED} | `,
    )
    expect(renamed, 'a refusal written on a response object with another name is invisible').toBeTruthy()
    expect([renamed!.echo, renamed!.beforeAuthority]).toEqual([false, true])
  })

  it('negative controls: a commented-out copy and a comparison that only skips a row are not sites', () => {
    const commented = plant(
      "    // if (owner.sheet_id !== target) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `${target}` } })",
    )
    expect(siteIn(commented, `${PLANTED} | `)).toBeUndefined()
    const skipping = plant('    for (const row of found.rows) { if (row.sheet_id !== target) continue }')
    expect(siteIn(skipping, `${PLANTED} | `)).toBeUndefined()
    expect(pairingViolations(scanSheetPairings(skipping))).toEqual([])
  })

  it('a GAP row cannot outlive its fix: values-free wording on one form-share route reds declared = computed', () => {
    const echoing = "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${viewId} does not belong to sheet ${sheetId}` } })"
    const first = UNIVER_META_SOURCE.indexOf(echoing)
    expect(first, 'the form-share echo this probe rewrites is gone — the GAP may be fixed; see the witness cells').toBeGreaterThan(0)
    const mutated = UNIVER_META_SOURCE.slice(0, first) + "return sendSheetNotLive(res, 'absent')" + UNIVER_META_SOURCE.slice(first + echoing.length)
    const key = 'GET /sheets/:sheetId/views/:viewId/form-share | String(row.sheet_id) !== sheetId'
    expect(scanSheetPairings(mutated).sites.find((s) => s.key === key)?.echo).toBe(false)
    expect(pairingViolations(scanSheetPairings(mutated)).join('\n')).toContain(`DECLARED ≠ COMPUTED`)
  })

  it('position is computed, not declared: remove the 403 ahead of a post-authority site and its row reds', () => {
    // A view pairing that was moved BEHIND its handler's gates — the move the form-share fix will make.
    const key = 'GET /sheets/:sheetId/view-aggregate | view.sheetId !== sheetId'
    expect(SHEET_PAIRING_CENSUS[key], 'the probed row left the census — pick another post-authority row').toEqual({ echo: false, beforeAuthority: false })
    const route = key.split(' | ')[0]!
    const [verb, path] = route.split(' ')
    const decl = `router.${verb!.toLowerCase()}('${path}'`
    const start = UNIVER_META_SOURCE.indexOf(decl)
    expect(start, `cannot find ${route}`).toBeGreaterThan(0)
    const end = UNIVER_META_SOURCE.indexOf('\n  router.', start + 10)
    const handler = UNIVER_META_SOURCE.slice(start, end)
    const disarmed = handler
      .replace(/sendForbidden\(res\)/g, 'res.json({ ok: true })')
      .replace(/\.status\(40[13]\)/g, '.status(200)')
      .replace(/status: 40[13]/g, 'status: 200')
    expect(disarmed, 'the probe did not remove anything').not.toBe(handler)
    const mutated = UNIVER_META_SOURCE.slice(0, start) + disarmed + UNIVER_META_SOURCE.slice(end)
    expect(scanSheetPairings(mutated).sites.find((s) => s.key === key)?.beforeAuthority).toBe(true)
    expect(pairingViolations(scanSheetPairings(mutated)).join('\n')).toContain(`DECLARED ≠ COMPUTED`)
  })

  it('the SQL spelling is caught, bare or aliased, and a sheet-scoped LIST is not', () => {
    const bare = plant("    const probe = await poolManager.get().query('SELECT id FROM meta_views WHERE id = $1 AND sheet_id = $2', [req.params.viewId, target])")
    expect(sqlViewPairings(bare)).toHaveLength(1)
    const aliased = plant('    const probe = await poolManager.get().query(`SELECT v.id FROM meta_views v\n      WHERE v.sheet_id = $2 AND v.id = $1`, [req.params.viewId, target])')
    expect(sqlViewPairings(aliased)).toHaveLength(1)
    const listing = plant("    const probe = await poolManager.get().query('SELECT id FROM meta_views WHERE sheet_id = $1 ORDER BY id', [target])")
    expect(sqlViewPairings(listing)).toEqual([])
  })

  // ── #6069 review: spellings the first version of the scan did not read ──────────────────────
  // Each shape below was planted by the review and left the closed world green. Every cell plants it
  // the same way as above (a route with no 403 at all, so a site is always ahead of authority).

  const ECHO_REFUSAL = "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${req.params.viewId} is on ${owner.sheetId}` } })"

  /** The planted site: found, with this echo, ahead of authority, and red as NEW + UNEXCUSED. */
  const plantedSite = (mutated: string, echo: boolean, label: string): PairingSite => {
    const scanned = scanSheetPairings(mutated)
    const site = scanned.sites.find((s) => s.key.startsWith(`${PLANTED} | `))
    expect(site, `${label}: the planted pairing refusal is invisible to the shape scan`).toBeTruthy()
    expect([site!.echo, site!.beforeAuthority], `${label}: [echo, beforeAuthority]`).toEqual([echo, true])
    const violations = pairingViolations(scanned).join('\n')
    expect(violations, label).toContain(`NEW (line ${site!.line}) — not in SHEET_PAIRING_CENSUS: ${site!.key}`)
    expect(violations, label).toContain(`UNEXCUSED (line ${site!.line}): ${site!.key}`)
    return site!
  }

  it('operands are read whole: `String(x ?? \'\')`, a cast, a bracket key and a call are sheet-id-valued', () => {
    for (const condition of [
      "String(owner.sheet_id ?? '') !== target",
      '(owner.sheet_id as string) !== target',
      "owner['sheet_id'] !== target",
      '(await sheetIdOfView(poolManager.get(), req.params.viewId)) !== req.params.sheetId',
    ]) {
      const site = plantedSite(plant(`    if (${condition}) {\n      ${ECHO_REFUSAL}\n    }`), true, condition)
      expect(site.key, 'the key is the comparison as written, operands whole').toBe(`${PLANTED} | ${condition}`)
    }
    // …and a sheet id that is dereferenced (`.length`) is not one.
    const measured = plant('    if (req.params.sheetId.length !== owner.count) return res.status(400).json({ ok: false })')
    expect(siteIn(measured, `${PLANTED} | `)).toBeUndefined()
  })

  it('bound booleans: across a line break, by plain assignment, by `||=`, and an arrow predicate bound to a name', () => {
    plantedSite(plant(`    const elsewhere =\n      owner.sheetId !== target\n    if (elsewhere) {\n      ${ECHO_REFUSAL}\n    }`), true, 'bound across a line break')
    plantedSite(plant(`    let elsewhere = false\n    elsewhere = owner.sheetId !== target\n    if (elsewhere) {\n      ${ECHO_REFUSAL}\n    }`), true, 'bound by plain assignment')
    plantedSite(plant(`    let elsewhere = false\n    elsewhere ||= owner.sheetId !== target\n    if (elsewhere) {\n      ${ECHO_REFUSAL}\n    }`), true, 'bound by ||=')
    const predicate = plantedSite(plant(`    const belongs = (v: any) => v.sheetId === target\n    if (!belongs(owner)) {\n      ${ECHO_REFUSAL}\n    }`), true, 'an arrow predicate')
    expect(predicate.key).toBe(`${PLANTED} | v.sheetId === target`)
  })

  it('polarity that the text cannot settle reads BOTH paths: `!(a && x === y)`, and a bound boolean inside `!(…)`', () => {
    // The then-branch refuses; the statement after the `if` does not answer. Reading only the
    // else/fall-through (as the first version did for an equality) found nothing.
    plantedSite(plant(`    if (!(owner && owner.sheetId === target)) {\n      ${ECHO_REFUSAL}\n    }\n    const snapshot = owner.config`), true, '!(a && x === y)')
    plantedSite(plant(`    const same = owner.sheetId === target\n    if (!(owner && same)) {\n      ${ECHO_REFUSAL}\n    }\n    const snapshot = owner.config`), true, '!(a && bound)')
    // A `!(…)` holding exactly the comparison still flips it exactly.
    plantedSite(plant(`    if (!(owner.sheetId === target)) {\n      ${ECHO_REFUSAL}\n    }`), true, '!(x === y)')
  })

  it('answers: `res` handed anywhere, a member-callee helper, a closure over `res`, `res[…]`, `response.json`, `Promise.reject`, `return { …, status }`', () => {
    const refuse = (then: string) => plant(`    if (owner.sheetId !== target) return ${then}`)
    plantedSite(refuse('sendRefusal(404, res, `View ${req.params.viewId}`)'), true, 'res as the 2nd argument')
    plantedSite(refuse('refuse({ res, viewId: req.params.viewId })'), true, 'res inside an object argument')
    plantedSite(refuse('refusals.elsewhere(res, req.params.viewId)'), true, 'a member-callee helper')
    plantedSite(refuse("res['json']({ ok: false, viewId: req.params.viewId })"), true, 'a bracketed method on res')
    plantedSite(refuse('response.json({ ok: false, viewId: req.params.viewId })'), true, 'response.json with no status')
    plantedSite(refuse('Promise.reject(new NotFoundError(req.params.viewId))'), true, 'Promise.reject')
    plantedSite(refuse("{ code: 'NOT_FOUND', status: 404, message: `View ${req.params.viewId}` }"), true, 'status not the first key')
    plantedSite(plant('    const refuseHere = () => res.status(404).json({ ok: false, viewId: req.params.viewId })\n    if (owner.sheetId !== target) return refuseHere()'), true, 'a closure over res, echoing')
    // A closure that answers values-free is still a site (it answers), and reads as values-free.
    plantedSite(plant("    const refuseHere = () => sendSheetNotLive(res, 'absent')\n    if (owner.sheetId !== target) return refuseHere()"), false, 'a closure over res, values-free')
    // Negative control: a mismatch path that only logs does not answer.
    expect(siteIn(plant("    if (owner.sheetId !== target) console.warn('elsewhere')"), `${PLANTED} | `)).toBeUndefined()
  })

  /** The view-aggregate row (post-authority, values-free) with its refusal rewritten in memory. */
  const AGGREGATE_KEY = 'GET /sheets/:sheetId/view-aggregate | view.sheetId !== sheetId'
  const rewriteAggregateRefusal = (replacement: string, before = ''): string => {
    const values = "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })"
    const decl = UNIVER_META_SOURCE.indexOf("router.get('/sheets/:sheetId/view-aggregate'")
    const cond = UNIVER_META_SOURCE.indexOf('if (!view || view.sheetId !== sheetId) {', decl)
    const at = UNIVER_META_SOURCE.indexOf(values, cond)
    expect([decl, cond, at].every((i) => i > 0) && at - cond < 200, 'the view-aggregate refusal this probe rewrites moved — re-anchor it').toBe(true)
    const rewritten = UNIVER_META_SOURCE.slice(0, at) + replacement + UNIVER_META_SOURCE.slice(at + values.length)
    return before ? rewritten.slice(0, cond) + before + rewritten.slice(cond) : rewritten
  }

  it('echo is fail-closed on an EXISTING values-free row: each of these rewrites reds declared = computed', () => {
    expect(SHEET_PAIRING_CENSUS[AGGREGATE_KEY], 'the probed row left the census — pick another post-authority row').toEqual({ echo: false, beforeAuthority: false })
    const rewrites: Array<[string, string, string?]> = [
      ['.end(template)', 'return res.status(404).end(`View ${viewId} lives on sheet ${view?.sheetId}`)'],
      ['.redirect(template)', 'return res.redirect(`/sheets/${view?.sheetId}/views/${viewId}`)'],
      ['a header', "return res.status(404).set('X-Owner-Sheet', String(view?.sheetId)).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })"],
      ['an unlisted method chained on res', 'return res.status(404).refuseWith(`View ${viewId} lives on sheet ${view?.sheetId}`)'],
      ['.end on the response object under another name', 'const out = res\n          return out.status(404).end(`View ${viewId} lives on sheet ${view?.sheetId}`)'],
      ['a spread', "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found', ...req.params } })"],
      ['req handed to a helper', 'return refuseForeignView(req, res)'],
      ['res.statusMessage', 'res.statusMessage = `View ${viewId}`\n          return res.status(404).end()'],
      ['a let reassigned in the branch', "let msg = 'View not found'\n          msg = `View ${viewId} is on sheet ${view?.sheetId}`\n          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: msg } })"],
      [
        'a let reassigned before the if',
        "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: reason } })",
        "let reason = 'View not found'\n        if (view) reason = `View ${viewId} lives on sheet ${view.sheetId}`\n        ",
      ],
    ]
    for (const [label, replacement, before] of rewrites) {
      const scanned = scanSheetPairings(rewriteAggregateRefusal(replacement, before))
      const site = scanned.sites.find((s) => s.key === AGGREGATE_KEY)
      expect([site?.echo, site?.beforeAuthority], `${label}: computed [echo, beforeAuthority]`).toEqual([true, false])
      const violations = pairingViolations(scanned).join('\n')
      expect(violations, label).toContain(`DECLARED ≠ COMPUTED (line ${site!.line}): ${AGGREGATE_KEY}`)
      expect(violations, label).toContain(`UNEXCUSED (line ${site!.line}): ${AGGREGATE_KEY}`)
    }
  })

  it('only a MODULE constant is constant: the real `let sheetId` of PATCH /fields/:fieldId, and a function-local const, read as echo', () => {
    // The handler declares `let sheetId = ''` and later reassigns it from the row; a refusal throwing it
    // is an echo, whatever the declaration's initialiser says.
    const anchor = UNIVER_META_SOURCE.indexOf('\n        sheetId = String(row.sheet_id)')
    expect(anchor, 'PATCH /fields/:fieldId no longer reassigns its sheetId — re-anchor this probe').toBeGreaterThan(0)
    const lineEnd = UNIVER_META_SOURCE.indexOf('\n', anchor + 1) + 1
    const thrown = UNIVER_META_SOURCE.slice(0, lineEnd)
      + '        if (String(row.sheet_id) !== preflightSheetId) throw new NotFoundError(sheetId)\n'
      + UNIVER_META_SOURCE.slice(lineEnd)
    const scanned = scanSheetPairings(thrown)
    const site = scanned.sites.find((s) => s.key === 'PATCH /fields/:fieldId | String(row.sheet_id) !== preflightSheetId')
    expect(site?.echo, 'a `let` the handler reassigns reads as a constant').toBe(true)
    expect(pairingViolations(scanned).join('\n')).toContain(`UNEXCUSED (line ${site!.line})`)

    // A module constant (column 0, literal, bound nowhere else) stays constant — the export-xlsx row relies on it…
    plantedSite(plant("    if (owner.sheetId !== target) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: EXPORT_VIEW_NOT_FOUND_MESSAGE } })"), false, 'a module constant')
    // …a function-local one does not (it could be any binding of that name; the rule errs toward echo).
    plantedSite(plant("    const localMessage = 'View not found'\n    if (owner.sheetId !== target) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: localMessage } })"), true, 'a function-local const')
  })

  it('the SQL spelling is caught wherever the SELECT stands (a CTE, INSERT … SELECT) and across `+`-joined literals', () => {
    const cte = plant("    const probe = await poolManager.get().query('WITH v AS (SELECT id FROM meta_views WHERE id = $1 AND sheet_id = $2) SELECT id FROM v', [req.params.viewId, target])")
    expect(sqlViewPairings(cte)).toHaveLength(1)
    const insertSelect = plant("    const probe = await poolManager.get().query('INSERT INTO t (id) SELECT id FROM meta_views WHERE id = $1 AND sheet_id = $2', [req.params.viewId, target])")
    expect(sqlViewPairings(insertSelect)).toHaveLength(1)
    const joined = plant("    const probe = await poolManager.get().query('SELECT id FROM meta_views ' + 'WHERE id = $1 AND sheet_id = $2', [req.params.viewId, target])")
    expect(sqlViewPairings(joined)).toHaveLength(1)
    // Two separate statements do not splice into one pairing.
    const apart = plant("    const a = 'SELECT id FROM meta_views WHERE id = $1'\n    const b = 'UPDATE t SET x = 1 WHERE sheet_id = $2'")
    expect(sqlViewPairings(apart)).toEqual([])
  })

  // ── #6069 second review: what the scan read too narrowly ────────────────────────────────────
  const FREE_REFUSAL = "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })"
  const RETURNS_WHEN_EQUAL = '    if (owner.sheetId === target) return res.json({ ok: true })\n'

  it('a fall-through refusal is read as a RUN, not one statement: a local, a log line or a conditional answer between; an else that does not answer', () => {
    // FT0 (the control the first version already read): the refusal right after the returning equality.
    plantedSite(plant(`${RETURNS_WHEN_EQUAL}    ${ECHO_REFUSAL}`), true, 'FT0 refusal directly after')
    // FT1: the message built in a local between the `if` and the refusal.
    plantedSite(plant(`${RETURNS_WHEN_EQUAL}    const text = \`View \${req.params.viewId} is on \${owner.sheetId}\`\n    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: text } })`), true, 'FT1 message built in a local between')
    // FT2: a log line between.
    plantedSite(plant(`${RETURNS_WHEN_EQUAL}    console.warn('view elsewhere', req.params.viewId)\n    ${ECHO_REFUSAL}`), true, 'FT2 a log line between')
    // A conditional values-free answer between does not end the run: the refusal after it is read too.
    plantedSite(plant(`${RETURNS_WHEN_EQUAL}    if (!owner.name) ${FREE_REFUSAL}\n    ${ECHO_REFUSAL}`), true, 'a conditional answer between')
    // An else that does not answer continues into the statements after the `if`.
    plantedSite(plant(`    if (owner.sheetId === target) {\n      return res.json({ ok: true })\n    } else {\n      console.warn('elsewhere')\n    }\n    ${ECHO_REFUSAL}`), true, 'an else that does not answer')
    // The run is read as far as it goes, and no further: a values-free one reads values-free.
    plantedSite(plant(`${RETURNS_WHEN_EQUAL}    console.warn('view elsewhere')\n    ${FREE_REFUSAL}`), false, 'a values-free run')
  })

  /** The two transaction refusals (a returned `{ status }` object) the census holds, and the caller line that answers one. */
  const TXN_SITES: Array<[key: string, site: string]> = [
    [
      'POST /sheets/:sheetId/config-restore-execute | entitySheetId !== sheetId',
      "if (entitySheetId !== sheetId) return { status: 400, code: 'INVALID_REVISION', message: 'The config entity belongs to a different sheet than its revision; refusing to un-create.' }",
    ],
    [
      'POST /sheets/:sheetId/config-restore-execute | fieldRow.sheetId !== sheetId',
      "if (fieldRow.sheetId !== sheetId) return { status: 400, code: 'INVALID_REVISION', message: 'field revision entity does not belong to this sheet.' }",
    ],
  ]
  const TXN_CONSUMER = 'if (failure) return res.status(failure.status).json({ ok: false, error: { code: failure.code, message: failure.message } })'

  it('a handed-off value is read where it is ANSWERED: the caller of a returned status object, the catch of a throw', () => {
    // RS: the census rows whose refusal is `return { status: 400, … }` inside pool.transaction. Only the CALLER changes.
    for (const [key, text] of TXN_SITES) {
      expect(SHEET_PAIRING_CENSUS[key], `${key}: the probed row left the census — re-anchor this probe`).toEqual({ echo: false, beforeAuthority: false })
      const site = UNIVER_META_SOURCE.indexOf(text)
      const consumer = UNIVER_META_SOURCE.indexOf(TXN_CONSUMER, site)
      expect(site > 0 && consumer > site && consumer - site < 8000, `${key}: the refusal or its caller moved — re-anchor this probe`).toBe(true)
      const callerEchoes = UNIVER_META_SOURCE.slice(0, consumer)
        + 'if (failure) return res.status(failure.status).json({ ok: false, error: { code: failure.code, message: `${failure.message} (sheet ${sheetId}, revision ${revisionId})` } })'
        + UNIVER_META_SOURCE.slice(consumer + TXN_CONSUMER.length)
      const rs = scanSheetPairings(callerEchoes)
      const rsSite = rs.sites.find((s) => s.key === key)
      expect([rsSite?.echo, rsSite?.beforeAuthority], `RS ${key}: the caller echoes, the returned object does not`).toEqual([true, false])
      expect(pairingViolations(rs).join('\n')).toContain(`DECLARED ≠ COMPUTED (line ${rsSite!.line}): ${key}`)
    }

    // TH: the view-aggregate refusal becomes a throw, and the handler's catch answers it with both ids.
    const thrown = rewriteAggregateRefusal("throw new NotFoundError('View not found')")
    const catchAt = thrown.indexOf('} catch (err) {', thrown.indexOf("router.get('/sheets/:sheetId/view-aggregate'"))
    expect(catchAt, 'the view-aggregate catch moved — re-anchor this probe').toBeGreaterThan(0)
    const opened = catchAt + '} catch (err) {'.length
    const th = scanSheetPairings(thrown.slice(0, opened)
      + "\n      if (err instanceof NotFoundError) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `${err.message}: ${viewId} is not on ${sheetId}` } })"
      + thrown.slice(opened))
    const thSite = th.sites.find((s) => s.key === AGGREGATE_KEY)
    expect([thSite?.echo, thSite?.beforeAuthority], 'TH: the catch echoes, the thrown error does not').toEqual([true, false])
    expect(pairingViolations(th).join('\n')).toContain(`DECLARED ≠ COMPUTED (line ${thSite!.line}): ${AGGREGATE_KEY}`)

    // The same readings on a planted route: the answer given where the value lands decides.
    const tryCatch = (answer: string) => plant("    try {\n      if (owner.sheetId !== target) throw new NotFoundError('View not found')\n    } catch (err) {\n"
      + `      if (err instanceof NotFoundError) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: ${answer} } })\n`
      + "      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'failed' } })\n    }")
    plantedSite(tryCatch('err.message'), false, 'a constant error, answered with its own message')
    plantedSite(tryCatch('`${err.message}: ${req.params.viewId}`'), true, 'a constant error, answered with the viewId')
    plantedSite(plant("    if (owner.sheetId !== target) throw new NotFoundError('View not found')"), true, 'a throw no catch in the handler answers')
    plantedSite(plant("    if (owner.sheetId !== target) return next(new NotFoundError('View not found'))"), true, 'next(…): answered outside the handler')
    plantedSite(plant("    const fail = () => { throw new NotFoundError('View not found') }\n    if (owner.sheetId !== target) fail()"), true, 'a local function that only throws')
    const transaction = (answer: string) => plant('    const failure = await poolManager.get().transaction(async () => {\n'
      + "      if (owner.sheetId !== target) return { status: 404, code: 'NOT_FOUND', message: 'View not found' }\n      return null\n    })\n"
      + (answer ? `    if (failure) return res.status(failure.status).json({ ok: false, error: { code: failure.code, message: ${answer} } })` : ''))
    plantedSite(transaction('failure.message'), false, 'a constant status object, answered with its own fields')
    plantedSite(transaction('`${failure.message}: ${req.params.viewId}`'), true, 'a constant status object, answered with the viewId')
    plantedSite(transaction(''), true, 'a status object nobody answers here')
  })

  it('polarity passes through a whole `!rows.some((row) => …)` conjunct, and nowhere else a callback stands', () => {
    // GET /context's pairing is exactly this shape; its census row (echo:false) is read through it, so the
    // success path after its 403 is not mistaken for the refusal.
    expect(SHEET_PAIRING_CENSUS['GET /context | String(row.id) === resolvedSheetId']).toEqual({ echo: false, beforeAuthority: false })
    const echoingSuccess = '    return res.json({ ok: true, data: { rows: found.rows, viewId: req.params.viewId } })'
    // The refusal is values-free and the success path echoes: only the refusal is the mismatch path.
    plantedSite(plant(`    if (target && !found.rows.some((row: any) => row.sheet_id === target)) {\n      ${FREE_REFUSAL}\n    }\n${echoingSuccess}`), false, '!rows.some(…) as a whole conjunct')
    plantedSite(plant(`    if (found.rows.every((row: any) => row.sheet_id !== target)) {\n      ${FREE_REFUSAL}\n    }\n${echoingSuccess}`), false, 'rows.every(…) as the whole condition')
    // Anything the rule does not cover keeps `unknown` and reads both paths — here the echoing success path.
    plantedSite(plant(`    if (found.rows.some((row: any) => row.sheet_id === target) === false) {\n      ${FREE_REFUSAL}\n    }\n${echoingSuccess}`), true, '.some(…) compared with false')
    plantedSite(plant(`    if (found.rows.filter((row: any) => row.sheet_id === target).length === 0) {\n      ${FREE_REFUSAL}\n    }\n${echoingSuccess}`), true, '.filter(…) is not read through')
    plantedSite(plant(`    if (target ? !found.rows.some((row: any) => row.sheet_id === target) : false) {\n      ${FREE_REFUSAL}\n    }\n${echoingSuccess}`), true, 'a ternary at the top level')
  })

  it('position counts only a 403: a pairing moved between a 401 and its 403 is before authority, and a 401 does not close a GAP', () => {
    // B: view-aggregate's pairing block moved between its 401 and its sendForbidden.
    // Multi-line anchors: read the product text with LF line ends (a Windows checkout has CRLF).
    const LF_SOURCE = UNIVER_META_SOURCE.replace(/\r\n/g, '\n')
    const decl = LF_SOURCE.indexOf("router.get('/sheets/:sheetId/view-aggregate'")
    const blockStart = LF_SOURCE.indexOf('      let view: SharedMultitableViewConfig | null = null\n      if (viewId) {', decl)
    const blockTail = `          ${"return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })"}\n        }\n      }\n`
    const blockEnd = LF_SOURCE.indexOf(blockTail, blockStart) + blockTail.length
    const gate = LF_SOURCE.indexOf('      if (!capabilities.canRead) return sendForbidden(res)\n', decl)
    const unauthenticated = LF_SOURCE.indexOf('return res.status(401)', decl)
    expect(decl > 0 && unauthenticated > decl && gate > unauthenticated && blockStart > gate && blockEnd > blockStart + 100, 'view-aggregate moved — re-anchor this probe').toBe(true)
    const block = LF_SOURCE.slice(blockStart, blockEnd)
    const lifted = LF_SOURCE.slice(0, gate) + block + LF_SOURCE.slice(gate, blockStart) + LF_SOURCE.slice(blockEnd)
    const b = scanSheetPairings(lifted)
    const bSite = b.sites.find((s) => s.key === AGGREGATE_KEY)
    expect([bSite?.echo, bSite?.beforeAuthority], 'B: a 401 ahead of the pairing is not its authority gate').toEqual([false, true])
    expect(pairingViolations(b).join('\n')).toContain(`UNEXCUSED (line ${bSite!.line}): ${AGGREGATE_KEY}`)

    // C: a GAP route with a 401 on top and its pairing answering the SHARED refusal — still ahead of the 403.
    // The first GAP route whose handler still holds the hand-written echo (GET form-share today).
    const echoing = "return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${viewId} does not belong to sheet ${sheetId}` } })"
    const target = Object.keys(FORM_SHARE_WITNESS).map((route) => {
      const [verb, path] = route.split(' ') as [string, string]
      const declaration = `router.${verb.toLowerCase()}('${path}', async (req: Request, res: Response) => {\n`
      const top = LF_SOURCE.indexOf(declaration) + declaration.length
      const end = LF_SOURCE.indexOf('\n  })\n', top)
      const refusal = LF_SOURCE.indexOf(echoing, top)
      return { route, top, refusal: top > declaration.length && refusal > top && refusal < end ? refusal : -1 }
    }).find((r) => r.refusal > 0)
    expect(target, 'no GAP route still holds the hand-written pairing — the GAP is fixed: retire this probe').toBeTruthy()
    const partial = LF_SOURCE.slice(0, target!.top)
      + "    if (!(req as any).user) return res.status(401).json({ error: 'Authentication required' })\n"
      + LF_SOURCE.slice(target!.top, target!.refusal) + "return sendSheetNotLive(res, 'absent')" + LF_SOURCE.slice(target!.refusal + echoing.length)
    const c = scanSheetPairings(partial)
    const key = `${target!.route} | String(row.sheet_id) !== sheetId`
    const cSite = c.sites.find((s) => s.key === key)
    expect([cSite?.echo, cSite?.beforeAuthority], 'C: values-free now, but still ahead of the 403').toEqual([false, true])
    const violations = pairingViolations(c).join('\n')
    expect(violations).toContain(`DECLARED ≠ COMPUTED (line ${cSite!.line}): ${key}`)
    expect(violations, 'C: the ledger would call the GAP closed while the pairing still answers first').not.toContain(`REDUNDANT exception — the site no longer needs it: ${key}`)
  })

  it('the witness calls a route FIXED only on three identical 403s: the shared refusal ahead of the 403 is CHANGED', () => {
    const answer = (status: number, body: unknown): WitnessAnswer => ({ status, body, text: JSON.stringify(body) })
    const forbidden = answer(FORBIDDEN_STATUS, FORBIDDEN)
    const shared = answer(MISMATCH_STATUS, MISMATCH_BODY)
    const echoed = answer(404, { ok: false, error: { code: 'NOT_FOUND', message: `View ${VIEW_ELSEWHERE} does not belong to sheet ${SHEET_LIVE}` } })
    const missing = answer(404, { ok: false, error: { code: 'NOT_FOUND', message: 'View not found: viw_x' } })
    expect(formShareGapState(forbidden, echoed, missing), 'the recorded GAP').toBe('GAP')
    expect(formShareGapState(forbidden, forbidden, forbidden), 'the fix FORM_SHARE_GAP_WHY prescribes').toBe('FIXED')
    // Probe C on the wire: the foreign view answers the shared refusal, but after an own-view 403 — not fixed.
    expect(formShareGapState(forbidden, shared, missing)).toBe('CHANGED')
    expect(formShareGapState(forbidden, shared, shared), 'foreign and missing alike, still 404 vs the own view\'s 403').toBe('CHANGED')
    expect(formShareGapState(forbidden, forbidden, missing)).toBe('CHANGED')
  })
})
