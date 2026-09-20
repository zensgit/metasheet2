/**
 * #5839 B1 — the univer-meta SHEET-CONFIG family decides AUTHORITY before it looks for the sheet row.
 *
 * ── The oracle that was here ──────────────────────────────────────────────────
 * Eleven handlers in routes/univer-meta.ts opened with
 *
 *     const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
 *     if (!sheet) return res.status(404)… `Sheet not found: ${sheetId}`
 *
 * BEFORE their first 403. `loadSheetRow` filters `deleted_at IS NULL`, so an authenticated caller the
 * handler was about to refuse anyway learned which of three things a sheet id was: live (403),
 * soft-deleted (404) or never real (404) — and the 404 echoed the id back. The
 * `if (sheetLiveness !== 'live') return sendSheetNotLive(…)` that already sat AFTER the 403 was
 * unreachable for exactly those two cases.
 *
 * The probe is gone. Order is now 403 → liveness 404 → the entity reads, matching `requireRecordReadable`
 * (#5830/#5844). Owner decision ①: the 404 message is now values-free (`Sheet not found`, no id) and a
 * soft-deleted sheet answers the distinct `SHEET_DELETED` code with the restore hint.
 *
 * ── What is pinned, per route ─────────────────────────────────────────────────
 *   (a) an authenticated caller with no capability gets 403 with a body STRICTLY EQUAL across live /
 *       soft-deleted / absent, and equal to what `sendForbidden` itself emits;
 *   (b) evidence, not vibes: the SQL that ran IS the capability lookup, byte for byte — so no sheet
 *       row, no field, no record, no write was touched on the way to the refusal;
 *   (c) nothing else moved: a manager still gets the route's normal 200 on a live sheet, and now gets
 *       404 SHEET_DELETED / 404 NOT_FOUND on a deleted / absent one (the answer the unreachable
 *       liveness line was always meant to give).
 *
 * The fixture (tests/utils/sheet-existence-oracle.ts) answers "live" for any id it does not know as
 * deleted or absent, so a handler that asks about the WRONG id cannot pass (c) by accident.
 *
 * TRANSPORT: one pinned listener per file + request(url()) — `request(app)` app-mode is banned by
 * tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
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
  type OracleFakePool,
  type OracleIdentity,
} from '../utils/sheet-existence-oracle'
import { usePinnedServer } from '../utils/pinned-server'

const FIELD_ID = 'fld_oracle_person'
const RECORD_ID = 'rec_oracle_1'
const SUBJECT_ID = 'u_oracle_subject'

/** Rows the ROUTE reads after the gate. Never consulted on a refused call — that is assertion (b). */
function routeRows(sql: string, params: unknown[]) {
  if (/FROM meta_fields WHERE sheet_id/.test(sql)) {
    return { rows: [{ id: FIELD_ID, name: 'Owner', type: 'person', property: {}, order: 1 }] }
  }
  if (/SELECT id FROM meta_fields WHERE id = \$1 AND sheet_id = \$2/.test(sql)) {
    return params[0] === FIELD_ID ? { rows: [{ id: FIELD_ID }] } : { rows: [] }
  }
  if (/SELECT id FROM users WHERE id = \$1/.test(sql)) {
    return params[0] === SUBJECT_ID ? { rows: [{ id: SUBJECT_ID }] } : { rows: [] }
  }
  if (/SELECT id FROM meta_records WHERE id = \$1 AND sheet_id = \$2/.test(sql)) {
    return params[0] === RECORD_ID ? { rows: [{ id: RECORD_ID }] } : { rows: [] }
  }
  return undefined
}

const pinned = usePinnedServer()
let oracle: OracleFakePool
let currentUser: OracleIdentity | undefined
let PERSON_DIRECTORY_MAX_ITEMS = 0
let PERSON_DIRECTORY_MIN_QUERY_LENGTH = 0
// Imported ONCE: routes/univer-meta.ts is ~20k lines and its cold transform outruns a 15s hook budget.
let poolManager: typeof import('../../src/integration/db/connection-pool')['poolManager']
let univerMeta: typeof import('../../src/routes/univer-meta')

function buildApp(): Express {
  oracle = makeOracleFakePool({ answer: routeRows })
  vi.spyOn(poolManager, 'get').mockReturnValue(oracle.pool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // SESSION identity only: a `Bearer mst_` token would let oapiScopeGuard refuse an unknown sheet id
    // at middleware level, which would be a 403 that says nothing about the handler.
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
  /** The route's own 200 for a manager on a LIVE sheet — unchanged by this PR. */
  ok: () => unknown
  /** Opens a transaction after the 403 (the deletion above sits before it and cannot affect it). */
  opensTransaction?: boolean
}

const ROUTES: RouteCase[] = [
  {
    name: 'GET /sheets/:sheetId/permissions',
    capability: 'canManageSheetAccess',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/permissions`),
    ok: () => ({ ok: true, data: { items: [] } }),
  },
  {
    name: 'GET /sheets/:sheetId/permission-candidates',
    capability: 'canManageSheetAccess',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/permission-candidates`),
    ok: () => ({ ok: true, data: { items: [], total: 0, limit: 20, query: '' } }),
  },
  {
    name: 'GET /sheets/:sheetId/person-fields/:fieldId/directory',
    capability: 'canEditRecord',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/person-fields/${FIELD_ID}/directory`),
    // No search term ⇒ the #5781 `requiresQuery` marker, so the positive control hydrates no person.
    ok: () => ({
      ok: true,
      data: {
        items: [],
        total: 0,
        limit: PERSON_DIRECTORY_MAX_ITEMS,
        query: '',
        hasMore: false,
        requiresQuery: true,
        minQueryLength: PERSON_DIRECTORY_MIN_QUERY_LENGTH,
      },
    }),
  },
  {
    name: 'PUT /sheets/:sheetId/permissions/:subjectType/:subjectId',
    capability: 'canManageSheetAccess',
    send: (a, s) => a.put(`/api/multitable/sheets/${s}/permissions/user/${SUBJECT_ID}`).send({ accessLevel: 'read' }),
    ok: () => ({ ok: true, data: { subjectType: 'user', subjectId: SUBJECT_ID, accessLevel: 'read', entry: null } }),
    opensTransaction: true,
  },
  {
    name: 'GET /sheets/:sheetId/row-level-read-deny',
    capability: 'canRead',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/row-level-read-deny`),
    ok: () => ({ ok: true, data: { enabled: false } }),
  },
  {
    name: 'PUT /sheets/:sheetId/row-level-read-deny',
    capability: 'canManageSheetAccess',
    send: (a, s) => a.put(`/api/multitable/sheets/${s}/row-level-read-deny`).send({ enabled: true }),
    ok: () => ({ ok: true, data: { enabled: true } }),
    opensTransaction: true,
  },
  {
    name: 'GET /sheets/:sheetId/conditional-rules',
    capability: 'canRead',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/conditional-rules`),
    ok: () => ({ ok: true, data: { rules: [], rejected: [] } }),
  },
  {
    name: 'PUT /sheets/:sheetId/conditional-rules',
    capability: 'canManageSheetAccess',
    send: (a, s) => a.put(`/api/multitable/sheets/${s}/conditional-rules`).send({ rules: [] }),
    ok: () => ({ ok: true, data: { rules: [] } }),
    opensTransaction: true,
  },
  {
    name: 'GET /sheets/:sheetId/field-permissions',
    capability: 'canManageFields',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/field-permissions`),
    ok: () => ({ ok: true, data: { items: [] } }),
  },
  {
    name: 'PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId',
    capability: 'canManageFields',
    send: (a, s) => a
      .put(`/api/multitable/sheets/${s}/field-permissions/${FIELD_ID}/user/${SUBJECT_ID}`)
      .send({ visible: false }),
    ok: () => ({
      ok: true,
      data: { sheetId: LIVE, fieldId: FIELD_ID, subjectType: 'user', subjectId: SUBJECT_ID, visible: false, readOnly: false },
    }),
    opensTransaction: true,
  },
  {
    name: 'GET /sheets/:sheetId/records/:recordId/permissions',
    capability: 'canManageSheetAccess',
    send: (a, s) => a.get(`/api/multitable/sheets/${s}/records/${RECORD_ID}/permissions`),
    ok: () => ({ ok: true, data: { items: [] } }),
  },
]

describe('#5839 B1 — univer-meta sheet-config routes: authority before the sheet row', () => {
  beforeAll(async () => {
    poolManager = (await import('../../src/integration/db/connection-pool')).poolManager
    univerMeta = await import('../../src/routes/univer-meta')
    PERSON_DIRECTORY_MAX_ITEMS = univerMeta.PERSON_DIRECTORY_MAX_ITEMS
    PERSON_DIRECTORY_MIN_QUERY_LENGTH = univerMeta.PERSON_DIRECTORY_MIN_QUERY_LENGTH
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
    return { res, sql: [...oracle.sqlLog], transactions: oracle.transactions }
  }

  it('the eleven routes of the B1 slice are all covered here', () => {
    expect(ROUTES).toHaveLength(11)
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(11)
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

      it('(b) evidence: only the capability lookup ran — no sheet row, no entity read, no write', async () => {
        currentUser = OUTSIDER
        for (const sheetId of SHEET_IDS) {
          const { sql, transactions } = await call(route, sheetId)
          const capability = await oracle.capabilitySqlFor(OUTSIDER, sheetId)
          // Non-vacuous: the capability lookup really does query, so `toEqual` below is a claim about
          // WHICH queries ran, not an empty-vs-empty tautology.
          expect(capability.some((s) => /SELECT deleted_at FROM meta_sheets WHERE id = \$1/.test(s)), sheetId).toBe(true)
          expect(sql, sheetId).toEqual(capability)
          expect(beyondCapability(sql), sheetId).toEqual([])
          expect(transactions, sheetId).toBe(0)
        }
      })

      // (c1) is also the PRE-CHANGE CONTROL: restoring the deleted probes in memory leaves this test
      // green (a live sheet has a row, so the probe was a no-op on this path) while (a)/(b)/(c2) red.
      it('(c1) manager on a LIVE sheet: the route answers exactly as it did before the probe was removed', async () => {
        currentUser = MANAGER
        const live = await call(route, LIVE)
        expect(live.res.status, JSON.stringify(live.res.body)).toBe(200)
        expect(live.res.body).toEqual(route.ok())
        expect(live.transactions).toBe(route.opensTransaction ? 1 : 0)
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
          expect(outcome.sql, state).toEqual(await oracle.capabilitySqlFor(MANAGER, sheetId))
          expect(beyondCapability(outcome.sql), state).toEqual([])
          expect(outcome.transactions, state).toBe(0)
        }
        expect(JSON.stringify([deleted.res.body, absent.res.body])).not.toContain('sht_oracle')
      })
    })
  }

  it('the fixture cannot be satisfied by asking about the wrong sheet id (unknown id ⇒ live)', async () => {
    currentUser = MANAGER
    const { res } = await call(ROUTES[0]!, 'sht_oracle_never_configured')
    // An id the fixture does not know is LIVE, so a handler that mixed ids up would answer 200 here and
    // the deleted/absent cases above would have had to come from somewhere else.
    expect(res.status).toBe(200)
  })
})
