/**
 * #5839 B2 — the univer-meta FIELD/VIEW/IMPORT/SUMMARY family decides AUTHORITY before it looks for the
 * sheet row.
 *
 * ── The oracle that was here ──────────────────────────────────────────────────
 * Eight handlers in routes/univer-meta.ts opened with an inline
 *
 *     const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', […])
 *     if (sheetRes.rows.length === 0) return res.status(404)… `Sheet not found: ${sheetId}`
 *
 * (form-share-candidates and import-xlsx used the `loadSheetRow`/`loadSheetRowShared` helper instead of the
 * inline SELECT, same shape) BEFORE their first 403. An authenticated caller the handler was about to refuse
 * anyway learned which of three things a sheet id was: live (403), soft-deleted (404) or never real (404) —
 * and the 404 echoed the id back. The `if (sheetLiveness !== 'live') return sendSheetNotLive(…)` that already
 * sat AFTER the 403 was unreachable for exactly those two cases.
 *
 * The probe is gone. Order is now 403 → liveness 404 → the entity reads, matching B1's eleven sheet-config
 * routes (#5839 B1) and `requireRecordReadable` (#5830/#5844). Same owner decision ①: the 404 message is
 * values-free (`Sheet not found`, no id) and a soft-deleted sheet answers the distinct `SHEET_DELETED` code
 * with the restore hint. `POST /fields` used to `throw new NotFoundError(…)`, caught further down and turned
 * into a 404 that echoed the id — its ABSENT/DELETED answer is now the same values-free `sendSheetNotLive`
 * output as every other route here (see the dedicated MANAGER/ABSENT case below).
 *
 * `GET /sheets/:sheetId/view-aggregate` also resolved `viewId` (a SEPARATE meta_views existence probe, an
 * id-bearing `View not found: ${viewId}` 404) between the deleted sheet-row probe and the 403. That lookup is
 * a `meta_views` probe outside this issue's `EXISTENCE_PROBE` regex (it is not on the GAP ledger — the
 * ledger only tracks `meta_sheets` probes) — moved anyway, to AFTER the liveness check, with a values-free
 * message, because it sat in the exact same pre-authority position and view.sheetId is not needed before
 * then.
 *
 * ── What is pinned, per route ─────────────────────────────────────────────────
 *   (a) an authenticated caller with no capability gets 403 with a body STRICTLY EQUAL across live /
 *       soft-deleted / absent, and equal to what `sendForbidden` itself emits;
 *   (b) evidence, not vibes: the queries that ran ARE the capability lookup — same statements, same
 *       PARAMETERS, in the same order — so no sheet row, no field, no record, no write was touched on the
 *       way to the refusal, and the sheet the handler asked about is the sheet in the URL;
 *   (b2) self-check: the call log is non-empty and its FIRST entry is the capability resolver's own liveness
 *       query, carrying the URL's sheet id — so a middleware-level refusal (e.g. an `oapiScopeGuard` 403
 *       before the handler ever runs) cannot fake-green assertion (a) by producing the same 403 body without
 *       the handler being reached;
 *   (c) nothing else moved: a manager still gets the route's normal success on a live sheet, and now gets 404
 *       SHEET_DELETED / 404 NOT_FOUND on a deleted / absent one (the answer the unreachable liveness line was
 *       always meant to give).
 *
 * ── Why SESSION identities, never `Bearer mst_` ────────────────────────────────
 * `GET /fields`, `GET /sheets/:sheetId/view-aggregate` and `GET /records-summary` mount
 * `apiTokenAuth, oapiScopeGuard, requireScope(...)`. For a caller with NO `Bearer mst_` token, all three are
 * no-ops: `apiTokenAuth` (middleware/api-token-auth.ts ~:47-49) skips when the header is absent;
 * `oapiScopeGuard` is a no-op without `req.apiTokenId`; `requireScope` `next()`s when `!req.apiTokenScopes`.
 * A `Bearer mst_` token WOULD get refused by `oapiScopeGuard`/`requireScope` at the MIDDLEWARE layer for an
 * unknown sheet id — a 403 that says nothing about the route handler under test (and would make assertion
 * (b2)'s self-check red for the wrong reason: the call log would be empty). So every case below carries a
 * SESSION identity (`req.user`), exactly like #5839 B1.
 *
 * The fixture (tests/utils/sheet-existence-oracle.ts) answers "live" for any id it does not know as deleted
 * or absent, so a handler that asks about the WRONG id cannot pass (c) by accident; and its log carries `$n`
 * parameters, so such a handler cannot pass (b) either — for the REFUSED caller, whose status code is 403
 * whichever sheet was consulted, that log is the only witness there is.
 *
 * TRANSPORT: one pinned listener per file + request(url()) — `request(app)` app-mode is banned by
 * tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import * as XLSX from 'xlsx'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ABSENT,
  beyondCapability,
  DELETED,
  FORBIDDEN,
  FORBIDDEN_STATUS,
  LIVE,
  makeOracleFakePool,
  MANAGER,
  OUTSIDER,
  SHEET_ABSENT_BODY,
  SHEET_DELETED_BODY,
  SHEET_IDS,
  SHEET_NOT_LIVE_STATUS,
  type OracleCall,
  type OracleFakePool,
  type OracleIdentity,
} from '../utils/sheet-existence-oracle'
import { usePinnedServer } from '../utils/pinned-server'
import { buildXlsxBuffer } from '../../src/multitable/xlsx-service'

const FIELD_ID = 'fld_oracle_person'
const FIELD_NAME = 'Owner'
const VIEW_ID = 'view_oracle_1'

/** The handler's own capability-resolution liveness query — how the (b2) self-check knows the handler ran. */
const LIVENESS_SELF_CHECK_SQL = /SELECT deleted_at FROM meta_sheets WHERE id = \$1/

/** A minimal, always-valid XLSX upload: one header row ("Owner"), zero data rows. Reused by every state —
 * the OUTSIDER 403 cases never parse it (they are refused before the file is touched); the MANAGER/LIVE
 * case parses it into an empty `built.records` (no data rows), so the route's `RecordService.createRecord`
 * write path is never exercised — success here is proven by the response shape, not by a record write. */
const XLSX_UPLOAD_BUFFER = buildXlsxBuffer(XLSX as any, { headers: [FIELD_NAME], rows: [] })

/** Rows the ROUTE reads after the gate. Never consulted on a refused call — that is assertion (b). */
function routeRows(sql: string, params: unknown[]) {
  // POST /fields success path — the field write chokepoints, in the order the handler issues them.
  if (/SELECT COALESCE\(MAX\("order"\), -1\) AS max_order FROM meta_fields WHERE sheet_id = \$1/.test(sql)) {
    return { rows: [{ max_order: -1 }] }
  }
  if (/INSERT INTO meta_fields \(id, sheet_id, name, type, property, "order"\)/.test(sql)) {
    return {
      rows: [{
        id: params[0],
        name: params[2],
        type: params[3],
        property: typeof params[4] === 'string' ? JSON.parse(params[4] as string) : params[4],
        order: params[5],
      }],
    }
  }
  if (/^SELECT id, name, type, property, "order" FROM meta_fields WHERE id = \$1$/.test(sql)) {
    return { rows: [{ id: FIELD_ID, name: 'Oracle Field', type: 'string', property: {}, order: 0 }] }
  }
  // GET /fields, GET /sheets/:sheetId/view-aggregate, GET /records-summary, POST /sheets/:sheetId/import-xlsx
  // — the sheet's field list (also the xlsx auto-mapping's name match: header "Owner" ↔ field "Owner").
  if (/FROM meta_fields WHERE sheet_id/.test(sql)) {
    return { rows: [{ id: FIELD_ID, name: FIELD_NAME, type: 'person', property: {}, order: 1 }] }
  }
  // GET /views success path — a pre-existing view so the lazy default-view INSERT transaction never fires.
  if (/FROM meta_views WHERE sheet_id = \$1/.test(sql)) {
    return {
      rows: [{
        id: VIEW_ID,
        sheet_id: LIVE,
        name: 'Grid',
        type: 'grid',
        filter_info: {},
        sort_info: {},
        group_info: {},
        hidden_field_ids: [],
        config: {},
      }],
    }
  }
  return undefined
}

const pinned = usePinnedServer()
let oracle: OracleFakePool
let currentUser: OracleIdentity | undefined
// Imported ONCE: routes/univer-meta.ts is ~20k lines and its cold transform outruns a 15s hook budget.
let poolManager: typeof import('../../src/integration/db/connection-pool')['poolManager']
let univerMeta: typeof import('../../src/routes/univer-meta')

function buildApp(): Express {
  oracle = makeOracleFakePool({ answer: routeRows })
  vi.spyOn(poolManager, 'get').mockReturnValue(oracle.pool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // SESSION identity only — see the header comment on why an api token would fake-green.
    if (currentUser) (req as any).user = currentUser
    next()
  })
  app.use('/api/multitable', univerMeta.univerMetaRouter())
  return app
}

type Agent = ReturnType<typeof request>

interface RouteCase {
  name: string
  /** The capability the handler refuses on (documentation — the fixture grants OUTSIDER none of them). */
  capability: string
  send: (agent: Agent, sheetId: string) => request.Test
  /** The route's success status for a manager on a LIVE sheet — unchanged by this PR. */
  okStatus: number
  /** Extra shape assertions on a manager/LIVE 2xx body, beyond `ok: true` (or its absence for that route). */
  assertOk?: (body: any) => void
}

const ROUTES: RouteCase[] = [
  {
    name: 'GET /fields',
    capability: 'canRead',
    send: (a, s) => a.get(`/api/multitable/fields?sheetId=${s}`),
    okStatus: 200,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.data.fields)).toBe(true)
    },
  },
  {
    name: 'POST /fields',
    capability: 'canManageFields',
    send: (a, s) => a.post('/api/multitable/fields').send({ sheetId: s, name: 'Oracle Field' }),
    okStatus: 201,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      expect(body.data.field.name).toBe('Oracle Field')
    },
  },
  {
    name: 'GET /views',
    capability: 'canRead',
    send: (a, s) => a.get(`/api/multitable/views?sheetId=${s}`),
    okStatus: 200,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.data.views)).toBe(true)
    },
  },
  {
    name: 'POST /views',
    capability: 'canManageViews',
    send: (a, s) => a.post('/api/multitable/views').send({ sheetId: s, name: 'Oracle View' }),
    okStatus: 201,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      expect(body.data.view.name).toBe('Oracle View')
    },
  },
  {
    name: 'GET /sheets/:sheetId/form-share-candidates',
    capability: 'canManageViews (via canManageFormShareForSheet)',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/form-share-candidates`),
    okStatus: 200,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      // No `q` ⇒ the #5795 bound short-circuit — no roster read, so this alone cannot prove the route's
      // OWN existence gate; the SQL-log equality assertion below is what proves it.
      expect(body.data.requiresQuery).toBe(true)
    },
  },
  {
    name: 'POST /sheets/:sheetId/import-xlsx',
    capability: 'canCreateRecord',
    send: (a, s) => a
      .post(`/api/multitable/sheets/${s}/import-xlsx`)
      .attach('file', XLSX_UPLOAD_BUFFER, 'oracle-import.xlsx'),
    okStatus: 200,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      // Header-only workbook (zero data rows) ⇒ RecordService.createRecord is never invoked — success is
      // proven by the response shape, not by a record write against the fake pool.
      expect(body.data.imported).toBe(0)
      expect(body.data.failed).toBe(0)
    },
  },
  {
    name: 'GET /sheets/:sheetId/view-aggregate',
    capability: 'canRead',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/view-aggregate`),
    okStatus: 200,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
    },
  },
  {
    name: 'GET /records-summary',
    capability: 'canRead',
    send: (a, s) => a.get(`/api/multitable/records-summary?sheetId=${s}`),
    okStatus: 200,
    assertOk: (body) => {
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.data.records)).toBe(true)
    },
  },
]

describe('#5839 B2 — univer-meta field/view/import/summary routes: authority before the sheet row', () => {
  beforeAll(async () => {
    poolManager = (await import('../../src/integration/db/connection-pool')).poolManager
    univerMeta = await import('../../src/routes/univer-meta')
  }, 120_000)

  beforeEach(() => {
    currentUser = MANAGER
    pinned.setApp(buildApp())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    currentUser = undefined
  })

  const call = async (route: RouteCase, sheetId: string) => {
    oracle.reset()
    const res = await route.send(request(pinned.url()), sheetId)
    // Snapshot: `oracle.calls` is emptied in place by the next reset / capability replay.
    const calls: OracleCall[] = oracle.calls.map((c) => ({ sql: c.sql, params: [...c.params] }))
    return { res, calls, transactions: oracle.transactions }
  }

  it('the eight routes of the B2 slice are all covered here', () => {
    expect(ROUTES).toHaveLength(8)
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(8)
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it(`(a) refused caller (no ${route.capability}): the SAME 403 body for a live, a soft-deleted and an absent sheet`, async () => {
        currentUser = OUTSIDER
        const answers: Array<[number, unknown]> = []
        for (const sheetId of SHEET_IDS) {
          const { res } = await call(route, sheetId)
          answers.push([res.status, res.body])
        }
        // Strictly equal across the three states — the oracle is what a DIFFERENCE would be.
        expect(answers[1]).toEqual(answers[0])
        expect(answers[2]).toEqual(answers[0])
        // …and equal to what the product's own sendForbidden emits (never a copied literal).
        expect(answers[0]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
        // The id is never echoed back, in any of the three.
        expect(JSON.stringify(answers)).not.toContain('sht_oracle')
      })

      it('(b) evidence: only the capability lookup ran, about THIS sheet — no sheet row, no entity read, no write', async () => {
        currentUser = OUTSIDER
        for (const sheetId of SHEET_IDS) {
          const { calls, transactions } = await call(route, sheetId)
          const capability = await oracle.capabilityCallsFor(OUTSIDER, sheetId)
          // Non-vacuous: the capability lookup really does query, so `toEqual` below is a claim about
          // WHICH queries ran, not an empty-vs-empty tautology.
          expect(capability.some((c) => LIVENESS_SELF_CHECK_SQL.test(c.sql)), sheetId).toBe(true)
          // …and it really does carry the sheet id, so the equality below binds WHICH SHEET was asked
          // about. Without this the comparison is text-only, and a handler that authorised against a
          // DIFFERENT sheet would satisfy every assertion in this test.
          expect(capability.some((c) => c.params.includes(sheetId)), sheetId).toBe(true)
          expect(calls, sheetId).toEqual(capability)
          expect(beyondCapability(calls), sheetId).toEqual([])
          expect(transactions, sheetId).toBe(0)
        }
      })

      it('(b2) self-check: the handler was actually reached — a middleware refusal cannot fake-green (a)', async () => {
        currentUser = OUTSIDER
        const { calls } = await call(route, LIVE)
        expect(calls.length).toBeGreaterThan(0)
        expect(calls[0]!.sql).toMatch(LIVENESS_SELF_CHECK_SQL)
        // The first question the handler asked was about the sheet in the URL, not some other id.
        expect(calls[0]!.params).toContain(LIVE)
      })

      it('(c1) manager on a LIVE sheet: the route answers exactly as it did before the probe was removed', async () => {
        currentUser = MANAGER
        const live = await call(route, LIVE)
        expect(live.res.status, JSON.stringify(live.res.body)).toBe(route.okStatus)
        route.assertOk?.(live.res.body)
      })

      it('(c2) manager on a SOFT-DELETED / ABSENT sheet: 404 SHEET_DELETED / NOT_FOUND, values-free, from sheetLiveness alone', async () => {
        currentUser = MANAGER

        const deleted = await call(route, DELETED)
        expect(deleted.res.status).toBe(SHEET_NOT_LIVE_STATUS)
        expect(deleted.res.body).toEqual(SHEET_DELETED_BODY)

        const absent = await call(route, ABSENT)
        expect(absent.res.status).toBe(SHEET_NOT_LIVE_STATUS)
        expect(absent.res.body).toEqual(SHEET_ABSENT_BODY)

        // The sheet-row probe is gone for the authorised caller too: the 404 comes from sheetLiveness,
        // so nothing beyond the capability lookup was read and no transaction was opened.
        for (const [state, sheetId, outcome] of [['deleted', DELETED, deleted], ['absent', ABSENT, absent]] as const) {
          expect(outcome.calls, state).toEqual(await oracle.capabilityCallsFor(MANAGER, sheetId))
          expect(beyondCapability(outcome.calls), state).toEqual([])
          expect(outcome.transactions, state).toBe(0)
        }
        expect(JSON.stringify([deleted.res.body, absent.res.body])).not.toContain('sht_oracle')
      })
    })
  }

  // Extra (owner decision ①): POST /fields used to `throw new NotFoundError(\`Sheet not found: ${sheetId}\`)`
  // for ABSENT/DELETED, caught further down and turned into a 404 that echoed the id. It now shares the
  // same values-free sheetLiveness answer as every other route in this file — pinned explicitly here (the
  // (c2) loop above already covers it structurally, this is the "not the old id-bearing message" proof).
  it('POST /fields — MANAGER on ABSENT: 404 SHEET_ABSENT_BODY (not the old id-bearing NotFoundError message)', async () => {
    currentUser = MANAGER
    const route = ROUTES.find((r) => r.name === 'POST /fields')!
    const { res } = await call(route, ABSENT)
    expect(res.status).toBe(SHEET_NOT_LIVE_STATUS)
    expect(res.body).toEqual(SHEET_ABSENT_BODY)
    expect(JSON.stringify(res.body)).not.toContain('Sheet not found: sht_oracle')
  })

  // Extra: import-xlsx, view-aggregate and records-summary each carry a 401 check
  // (`if (!access.userId) return res.status(401)…`) that is INERT for a SESSION identity — every
  // `OracleIdentity` (including OUTSIDER) carries a non-empty `id`, so `!access.userId` is never true for
  // one. A previous version of this case set `currentUser = OUTSIDER` and claimed to pin the 401 branch
  // while never actually reaching it (it was a byte-for-byte duplicate of assertion (a) for the same
  // route). An ANONYMOUS caller — no `req.user` at all — is the only identity that takes the branch, and
  // is the one this proves: the three sheet states must still be indistinguishable (all 401, same body),
  // so an unauthenticated caller cannot use this family as an existence oracle either.
  for (const routeName of [
    'POST /sheets/:sheetId/import-xlsx',
    'GET /sheets/:sheetId/view-aggregate',
    'GET /records-summary',
  ] as const) {
    it(`${routeName} — an ANONYMOUS caller (no session) gets the same 401 for live/soft-deleted/absent`, async () => {
      currentUser = undefined
      const route = ROUTES.find((r) => r.name === routeName)!
      const answers: Array<[number, unknown]> = []
      for (const sheetId of SHEET_IDS) {
        const { res } = await call(route, sheetId)
        answers.push([res.status, res.body])
      }
      expect(answers[1]).toEqual(answers[0])
      expect(answers[2]).toEqual(answers[0])
      expect(answers[0]).toEqual([401, { error: 'Authentication required' }])
    })
  }

  // Extra: `GET /sheets/:sheetId/view-aggregate` resolves a SECOND id off its own request — `viewId` — via
  // a `meta_views` probe that is NOT covered by `EXISTENCE_PROBE`/the GAP ledger (those only match
  // `meta_sheets` reads). It moved (critic ⑤) from BEFORE the 403 to AFTER it, but nothing in this spec
  // ever sent a `viewId` before now, so that move had zero coverage: reverting it back to its old,
  // pre-403 position would leave every case above green. These two pin it the same way the sheet oracle
  // above is pinned: (d) a refused caller cannot use a real viewId to learn about a sheet it may not read;
  // (e) an authorised caller gets a values-free 404 for an unknown view, not the old id-echoing message.
  it('(d) view-aggregate: a refused caller gets the SAME 403 for live/soft-deleted/absent even with a viewId attached', async () => {
    currentUser = OUTSIDER
    const route = ROUTES.find((r) => r.name === 'GET /sheets/:sheetId/view-aggregate')!
    const answers: Array<[number, unknown]> = []
    for (const sheetId of SHEET_IDS) {
      const res = await request(pinned.url()).get(`/api/multitable/sheets/${sheetId}/view-aggregate?viewId=view_oracle_probe`)
      answers.push([res.status, res.body])
    }
    // Strictly equal across the three sheet states — a viewId cannot be used to tell them apart.
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    expect(answers[0]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
    expect(JSON.stringify(answers)).not.toContain('sht_oracle')
  })

  it('view-aggregate — MANAGER/LIVE with an unknown viewId: values-free 404, not the old id-echoing message', async () => {
    currentUser = MANAGER
    const res = await request(pinned.url()).get(`/api/multitable/sheets/${LIVE}/view-aggregate?viewId=view_oracle_unknown`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'View not found' } })
    expect(JSON.stringify(res.body)).not.toContain('view_oracle_unknown')
  })

  it('the fixture cannot be satisfied by asking about the wrong sheet id (unknown id ⇒ live)', async () => {
    currentUser = MANAGER
    const { res } = await call(ROUTES[0]!, 'sht_oracle_never_configured')
    // An id the fixture does not know is LIVE, so a handler that mixed ids up would answer 200 here and
    // the deleted/absent cases above would have had to come from somewhere else.
    expect(res.status).toBe(200)
  })
})
