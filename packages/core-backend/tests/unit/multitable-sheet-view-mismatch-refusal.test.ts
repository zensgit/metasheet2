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
 *  2. The three previously-echoing routes no longer answer 409, and no longer carry a `CONFLICT`
 *     code or the resolver's message.
 *  3. THE INVARIANT #5839 B5 left behind: on PATCH /records/:recordId, GET /view and GET /context a
 *     mismatched view answers BYTE-IDENTICALLY whether the named sheet is LIVE, soft-DELETED or
 *     ABSENT. The refusal must not become a new existence oracle — the difference the caller can
 *     observe has to stay on `view.sheetId !== sheetId` alone.
 *  4. Attribution: the same request with a view that DOES belong to the named sheet gets a
 *     DIFFERENT answer, so the 404 above is caused by the mismatch and not by the fixture.
 *  5. Structurally: every `resolveMetaSheetId(` in univer-meta.ts is the definition or a call written
 *     in the wrapped form, every wrapped call `return`s on the null it can get back, no
 *     `ConflictError` branch outside a named allow-list echoes `err.message` — and the wrapped form
 *     still names the resolver, so the sheet-liveness closure guard keeps every one of these
 *     handlers (GET /context is in ITS scope for that token alone).
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
 * Nothing is asserted about the `meta_views` read count: `tryResolveView` memoises a found view in a
 * module-level cache (multitable/loaders.ts), so the second request for the same viewId issues no
 * view read at all. That cache is product behaviour; an assertion resting on it would be a flake.
 * Reach evidence is the EXACT-BODY equality (an express default 404 is HTML and cannot pass it)
 * together with the per-route attribution cell.
 */
import express, { type Express, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import { SHEET_ABSENT_BODY, SHEET_NOT_LIVE_STATUS } from '../utils/sheet-existence-oracle'

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

const BASE_ID = 'base_5946'
const FLD_TEXT = 'fld_5946_text'
const REC_ON_LIVE = 'rec_5946_on_live'

/** Every id a request carries. No refusal body may contain any of them. */
const REQUEST_IDS = [...SHEET_STATES, VIEW_ELSEWHERE, VIEW_ON_LIVE] as const

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
  send: (agent: ReturnType<typeof request>, sheetId: string, viewId: string) => request.Test
}

/**
 * Every wrapped `resolveMetaSheetId` call site in routes/univer-meta.ts, one row each. The structural
 * cell at the bottom asserts this table has exactly as many rows as the source has wrapper calls, so
 * a route added to the wrapper without a row here reds.
 */
const ROUTES: RouteCase[] = [
  {
    name: 'GET /context',
    previouslyEchoed: false,
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
    for (const route of ROUTES) {
      it(`${route.name}: a cross-sheet viewId answers the values-free absent-sheet 404`, async () => {
        const res = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)

        expect(res.status, `${route.name} did not answer the shared refusal status`).toBe(MISMATCH_STATUS)
        expect(res.body, `${route.name} drifted away from sendSheetNotLive(res, 'absent')`).toEqual(MISMATCH_BODY)
        expectValuesFree(res.text, route.name)
        // Not the generic 500 the seven uncaught callers used to reach.
        expect(res.status).not.toBe(500)
        expect(JSON.stringify(res.body)).not.toContain('INTERNAL_ERROR')
      })

      it(`${route.name}: an ADMIN caller gets the SAME bytes — the refusal is the address, not authority`, async () => {
        const outsider = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)
        const manager = await route.send(on('MANAGER'), SHEET_LIVE, VIEW_ELSEWHERE)

        expect(manager.status).toBe(outsider.status)
        expect(manager.text).toBe(outsider.text)
        expect(manager.status).toBe(MISMATCH_STATUS)
        expect(manager.body).toEqual(MISMATCH_BODY)
      })

      it(`${route.name}: attribution — the SAME request with a view that DOES belong answers differently`, async () => {
        const mismatch = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)
        const matching = await route.send(on('OUTSIDER'), SHEET_LIVE, VIEW_ON_LIVE)

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
   * a caller separate a live sheet from a soft-deleted or an absent one. Asserted on the three routes
   * named in #5946, byte-for-byte rather than by deep equality: the wire form is what a caller sees.
   */
  describe('three-way same shape: LIVE / DELETED / ABSENT are indistinguishable through the mismatch', () => {
    for (const name of ['PATCH /records/:recordId', 'GET /view', 'GET /context']) {
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
   * MUTATION PROBES. The cells above measure the refusal; these show they would RED on the two shapes
   * main answered, by rebuilding the module graph with `sendSheetNotLive` swapped in memory
   * (`vi.doMock`) — no file on disk is ever mutated.
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
      expect(res.status).not.toBe(MISMATCH_STATUS)
      expect(res.body).not.toEqual(MISMATCH_BODY)
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
      const res = await ROUTES[0].send(on('OUTSIDER'), SHEET_LIVE, VIEW_ELSEWHERE)
      expect(res.status).toBe(MISMATCH_STATUS)
      expect(res.body).toEqual(MISMATCH_BODY)
    })
  })
})

// ── structural: no eleventh caller can reintroduce the 500 ────────────────────

const UNIVER_META_REL = 'routes/univer-meta.ts'
const UNIVER_META_SOURCE = readFileSync(join(__dirname, '../../src', UNIVER_META_REL), 'utf8')

/**
 * THE WRAPPED FORM. Every call to the resolver has to be written exactly like this, so that the
 * refusal is attached to it and the literal `resolveMetaSheetId` stays in the handler body (the
 * sheet-liveness closure guard scopes handlers on that token — a wrapper that hid the name would
 * have dropped GET /context out of ITS scope, paying for this fix with a weaker guard).
 */
const WRAPPED_CALL = 'await orRefuseSheetViewMismatch(res, resolveMetaSheetId('

/**
 * The ONLY other lines allowed to name the resolver, each with the reason it is not a route caller.
 * Anything else — a handler awaiting the raw resolver — is the 500 (or the id echo) coming back.
 */
const RAW_RESOLVER_ALLOW_LIST: Record<string, string> = {
  'async function resolveMetaSheetId(':
    'the definition itself; its ConflictError stays, because the class is what the wrapper maps.',
}

/**
 * A COMMENT line — a line whose first non-space characters open or continue a comment. Comments call
 * nothing, and the doc comment on the wrapper itself quotes `resolveMetaSheetId(` while explaining the
 * rule; scanning them would make the rule unstatable. This drops only lines that START as a comment,
 * so `await resolveMetaSheetId(...) // sneaky` is still scanned (self-tested below).
 */
const isCommentLine = (line: string) => /^(\/\/|\/\*|\*)/.test(line)

/** Lines that name the resolver outside the wrapped form and outside the allow-list. */
function rawResolverOffenders(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((entry) => !isCommentLine(entry.line))
    .filter((entry) => /resolveMetaSheetId\(/.test(entry.line))
    .filter((entry) => !entry.line.includes(WRAPPED_CALL))
    .filter((entry) => !Object.keys(RAW_RESOLVER_ALLOW_LIST).some((allowed) => entry.line.includes(allowed)))
    .map((entry) => `${UNIVER_META_REL}:${entry.n}: ${entry.line}`)
}

/**
 * `ConflictError` branches that answer with `err.message`, keyed by the route they sit in
 * (`(module scope)` for the helpers above the router).
 */
function conflictEchoes(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const found: string[] = []
  let route = '(module scope)'
  lines.forEach((line, i) => {
    const decl = /^\s*router\.(get|post|patch|put|delete)\('([^']+)'/.exec(line)
    if (decl) route = `${decl[1]} ${decl[2]}`
    if (isCommentLine(line.trim()) || !/instanceof ConflictError/.test(line)) return
    // Comment lines are dropped from the window too: the removed branches left a note behind that
    // NAMES `err.message`, and a scanner that read it would report a branch that is not there.
    const window = lines.slice(i, i + 4).filter((l) => !isCommentLine(l.trim())).join('\n')
    if (/err\.message/.test(window)) found.push(route)
  })
  return found
}

/**
 * The echoing branches that stay. Both are named rather than counted, so a new one has to argue for
 * itself here instead of landing quietly.
 */
const CONFLICT_ECHO_ALLOW_LIST: Record<string, string> = {
  '(module scope)':
    'serializePatchFailure — the PER-RECORD failure payload of POST /patch. No local ConflictError is '
    + 'thrown inside that per-record loop (the only two throw sites in the file are resolveMetaSheetId, '
    + 'now wrapped ABOVE the loop, and the POST /sheets insert collision), so this arm is unreachable '
    + 'today; it is named here so a future thrower inside the loop has to confront it.',
  'post /sheets':
    'the create-collision `Sheet already exists: <sheetId>` — the id is the one THIS caller just asked '
    + 'to create, on a route it is authorised for, so the message tells it nothing it did not send.',
}

/** Wrapped call sites that do not `return` on the null the wrapper gives back. */
function callSitesThatIgnoreNull(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const missing: string[] = []
  lines.forEach((line, i) => {
    if (!line.includes(WRAPPED_CALL)) return
    if (!/if \(!resolved\) return/.test(lines.slice(i, i + 8).join('\n'))) missing.push(`${UNIVER_META_REL}:${i + 1}`)
  })
  return missing
}

/**
 * Handlers holding a wrapped call, and whether the closure guard's scope heuristic can still see the
 * resolver's name in them. Written without a `\b` escape on purpose: this repo has twice had an
 * editor turn one into a real 0x08 byte, and the character class says the same thing.
 */
const RESOLVER_TOKEN = /[^A-Za-z0-9_$]resolveMetaSheetId[^A-Za-z0-9_$]/

describe('#5946 structural — the wrapped call is the only door', () => {
  it('every resolveMetaSheetId( call in univer-meta.ts is the definition or a wrapped call site', () => {
    expect(rawResolverOffenders(UNIVER_META_SOURCE), 'a handler awaits the raw resolver: its ConflictError becomes a 500 (or an echoing 409) again').toEqual([])
  })

  it('the wrapper has exactly as many call sites as this file has route cells', () => {
    const callers = UNIVER_META_SOURCE.split(WRAPPED_CALL).length - 1
    expect(callers, 'a wrapper call site landed without a cell in ROUTES (or a cell lost its route)').toBe(ROUTES.length)
    expect(ROUTES.length).toBe(10)
  })

  it('every wrapped call is followed by a `return` on null — no handler continues on a sent refusal', () => {
    expect(callSitesThatIgnoreNull(UNIVER_META_SOURCE), 'a call site keeps going after the refusal was already written').toEqual([])
  })

  /**
   * The guard this fix must not pay with. `addressesASheet` in
   * tests/unit/multitable-sheet-liveness-closure.guard.test.ts puts a handler in scope when its body
   * names `resolveMetaSheetId`; GET /context is in scope for that reason ALONE (it has no
   * resolveSheetCapabilities call and no `:sheetId` in its path). A wrapper that hid the name behind
   * `resolveMetaSheetIdOrRefuse(...)` would have silently removed it from that guard's population.
   */
  it('the wrapped form keeps the resolver token in the handler body (closure-guard scope preserved)', () => {
    expect(RESOLVER_TOKEN.test(` ${WRAPPED_CALL} `), 'the wrapped form stopped naming the resolver — the closure guard loses GET /context').toBe(true)
    const contextHandler = UNIVER_META_SOURCE.slice(
      UNIVER_META_SOURCE.indexOf("router.get('/context'"),
      UNIVER_META_SOURCE.indexOf("router.get('/context'") + 4000,
    )
    expect(contextHandler.length).toBeGreaterThan(100)
    expect(RESOLVER_TOKEN.test(contextHandler), 'GET /context no longer names resolveMetaSheetId — it drops out of the closure guard').toBe(true)
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
