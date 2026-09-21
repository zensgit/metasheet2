/**
 * #5936 — `GET /api/multitable/context` decides AUTHORITY before it looks for the sheet row.
 *
 * ── The oracle that was here ──────────────────────────────────────────────────
 * `routes/univer-meta.ts`'s `GET /context` opened (on origin/main) with
 *
 *     const sheetRowResult = await pool.query(`SELECT s.id, … FROM meta_sheets s
 *        LEFT JOIN meta_bases b ON b.id = s.base_id
 *        WHERE s.id = $1 AND s.deleted_at IS NULL`, [resolvedSheetId])
 *     if (resolvedSheetId && !sheetRow) return res.status(404)… `Sheet not found: ${resolvedSheetId}`
 *
 * BEFORE its first `sendForbidden` — which sits much further down, after the base-wide sheet list has
 * been loaded and filtered. So a signed-in caller the handler was going to refuse anyway learned which
 * of three things a sheet id was: live (403), soft-deleted (404) or never real (404) — and the 404
 * echoed the id back. Same defect as the #5839 B-batches; different shape, which is exactly why it
 * survived them: the closure guard's `EXISTENCE_PROBE` recognised only the single-line
 * `FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL` form, so this handler never appeared in its
 * `EXISTENCE_BEFORE_AUTHORITY_GAP` ledger and its absence looked like innocence. The same commit widens
 * that probe (and this file's shared fixture) to read the aliased, multi-line form.
 *
 * Order is now the B-series order: 403 → liveness 404 → the row reads.
 *
 * ── What is pinned ────────────────────────────────────────────────────────────
 *   (a) a caller with no read authority gets 403 with a body STRICTLY EQUAL across live / soft-deleted
 *       / absent, equal to what `sendForbidden` itself emits, and the queries that ran ARE the
 *       capability lookup — same statements, same PARAMETERS, same order — so no sheet row, no base,
 *       no sheet list was touched on the way to the refusal;
 *   (b) an authorised caller gets the values-free 404 (SHEET_DELETED with the restore hint / NOT_FOUND)
 *       on a soft-deleted and on an absent sheet, from `sheetLiveness` alone — with the id NEVER echoed;
 *   (c) nothing else moved: an authorised caller on a LIVE sheet still gets the whole context payload;
 *   (d) the widened fixture reads the QUESTION, not the table name (self-test at the bottom).
 *
 * The fixture (tests/utils/sheet-existence-oracle.ts) answers "live" for any id it does not know as
 * deleted or absent, so a handler that asks about the WRONG id cannot pass (b)/(c) by accident; and its
 * log carries `$n` parameters, so such a handler cannot pass (a) either — for the REFUSED caller, whose
 * status code is 403 whichever sheet was consulted, that log is the only witness there is.
 *
 * TRANSPORT: one pinned listener per file + request(url()) — `request(app)` app-mode is banned by
 * tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ABSENT,
  BEYOND_CAPABILITY,
  beyondCapability,
  DELETED,
  FORBIDDEN,
  FORBIDDEN_STATUS,
  LIVE,
  makeOracleFakePool,
  MANAGER,
  OUTSIDER,
  READ_ONLY,
  SHEET_ABSENT_BODY,
  SHEET_DELETED_BODY,
  SHEET_IDS,
  SHEET_NOT_LIVE_STATUS,
  type OracleCall,
  type OracleFakePool,
  type OracleIdentity,
} from '../utils/sheet-existence-oracle'
import { usePinnedServer } from '../utils/pinned-server'

/** The base the fixture's LIVE sheet row points at (`base_id` of the row makeOracleFakePool serves). */
const BASE_ID = 'base_oracle'

/**
 * Rows the ROUTE reads AFTER the gate — the base and the base's sheet list. Never consulted on a
 * refused or non-live call: that is assertion (a)/(b). The sheet row itself is NOT here — the fixture
 * serves it, so a restored probe misses on DELETED/ABSENT instead of being handed a row by this file.
 */
function routeRows(sql: string, params: unknown[]) {
  if (/SELECT id, name, icon, color, owner_id, workspace_id FROM meta_bases WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) {
    return params[0] === BASE_ID
      ? { rows: [{ id: BASE_ID, name: 'Oracle base', icon: 'table', color: '#1677ff', owner_id: 'u_oracle_owner', workspace_id: null }] }
      : { rows: [] }
  }
  if (/FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(sql)) {
    return params[0] === BASE_ID
      ? { rows: [{ id: LIVE, base_id: BASE_ID, name: 'Oracle', description: null, system_kind: null }] }
      : { rows: [] }
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
    // SESSION identity only: a `Bearer mst_` token would let oapiScopeGuard refuse an unknown sheet id
    // at middleware level, which would be a 403 that says nothing about the handler.
    if (currentUser) (req as any).user = currentUser
    next()
  })
  app.use('/api/multitable', univerMeta.univerMetaRouter())
  return app
}

/** The `handlers: [ … ]` block of the closure guard's existence-oracle ledger, as raw source text. */
function existenceGapLedgerText(): string {
  const src = readFileSync(join(__dirname, 'multitable-sheet-liveness-closure.guard.test.ts'), 'utf8')
  const ledgerAt = src.indexOf('const EXISTENCE_BEFORE_AUTHORITY_GAP')
  const handlersAt = src.indexOf('handlers: [', ledgerAt)
  const endAt = src.indexOf('],', handlersAt)
  expect(
    Math.min(ledgerAt, handlersAt, endAt),
    'EXISTENCE_BEFORE_AUTHORITY_GAP.handlers was not found in the closure guard. If the ledger moved or '
    + 'was renamed, re-point this reader — do not delete the binding: it is what ties this file to the '
    + 'ledger entry #5936 must NOT create.',
  ).toBeGreaterThan(-1)
  return src.slice(handlersAt, endAt)
}

describe('#5936 — GET /context: authority before the sheet row', () => {
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

  const call = async (query: Record<string, string>) => {
    oracle.reset()
    const res = await request(pinned.url()).get('/api/multitable/context').query(query)
    // Snapshot: `oracle.calls` is emptied in place by the next reset / capability replay.
    const calls: OracleCall[] = oracle.calls.map((c) => ({ sql: c.sql, params: [...c.params] }))
    return { res, calls, transactions: oracle.transactions }
  }

  it('GET /context is NOT on the existence-oracle GAP ledger — this commit must not add it there', () => {
    const ledger = existenceGapLedgerText()
    // Non-vacuous: the extracted block really is a list of entries, so `not.toContain` is a claim.
    expect(
      ledger.split("',").length - 1,
      'the extracted ledger block holds no entries — the reader is pointed at the wrong text',
    ).toBeGreaterThan(5)
    expect(ledger).not.toContain("'GET /context'")
  })

  for (const caller of [OUTSIDER, READ_ONLY] as const) {
    const label = caller === OUTSIDER ? 'no multitable capability at all' : 'multitable:read but no grant on this sheet'
    const authorised = caller === READ_ONLY

    if (!authorised) {
      it(`(a) refused caller (${label}): the SAME 403 body for a live, a soft-deleted and an absent sheet`, async () => {
        currentUser = caller
        const answers: Array<[number, unknown]> = []
        for (const sheetId of SHEET_IDS) {
          const { res } = await call({ sheetId })
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

      it('(a) evidence: only the capability lookup ran, about THIS sheet — no sheet row, no base, no sheet list', async () => {
        currentUser = caller
        for (const sheetId of SHEET_IDS) {
          const { calls, transactions } = await call({ sheetId })
          const capability = await oracle.capabilityCallsFor(caller, sheetId)
          // Non-vacuous: the capability lookup really does query, so `toEqual` below is a claim about
          // WHICH queries ran, not an empty-vs-empty tautology.
          expect(capability.some((c) => /SELECT deleted_at FROM meta_sheets WHERE id = \$1/.test(c.sql)), sheetId)
            .toBe(true)
          // …and it really does carry the sheet id, so the equality below binds WHICH SHEET was asked
          // about. Without this the comparison is text-only, and a handler that authorised against a
          // DIFFERENT sheet would satisfy every assertion in this test.
          expect(capability.some((c) => c.params.includes(sheetId)), sheetId).toBe(true)
          expect(calls, sheetId).toEqual(capability)
          expect(beyondCapability(calls), sheetId).toEqual([])
          expect(transactions, sheetId).toBe(0)
        }
      })

      it('(a) the viewId door is the same door: an unresolvable viewId falls back to a sheet id and is refused identically', async () => {
        currentUser = caller
        const answers: Array<[number, unknown]> = []
        for (const sheetId of SHEET_IDS) {
          const { res, calls, transactions } = await call({ viewId: sheetId })
          answers.push([res.status, res.body])
          // The view lookup itself is allowed (it is not a sheet read); nothing past it is.
          expect(beyondCapability(calls), sheetId).toEqual([])
          expect(transactions, sheetId).toBe(0)
        }
        expect(answers[1]).toEqual(answers[0])
        expect(answers[2]).toEqual(answers[0])
        expect(answers[0]).toEqual([FORBIDDEN_STATUS, FORBIDDEN])
        expect(JSON.stringify(answers)).not.toContain('sht_oracle')
      })
    } else {
      // READ_ONLY holds GLOBAL multitable:read, so it clears the capability gate and reaches the
      // liveness answer — the half of the contract (b) is about, proved for a NON-ADMIN too.
      it(`(b) authorised caller (${label}): values-free 404 on soft-deleted and on absent, with no id echo`, async () => {
        currentUser = caller
        const deleted = await call({ sheetId: DELETED })
        expect(deleted.res.status).toBe(SHEET_NOT_LIVE_STATUS)
        expect(deleted.res.body).toEqual(SHEET_DELETED_BODY)

        const absent = await call({ sheetId: ABSENT })
        expect(absent.res.status).toBe(SHEET_NOT_LIVE_STATUS)
        expect(absent.res.body).toEqual(SHEET_ABSENT_BODY)

        // The 404 comes from sheetLiveness, not from a row probe: nothing beyond the capability
        // lookup was read and no transaction was opened.
        for (const [state, sheetId, outcome] of [['deleted', DELETED, deleted], ['absent', ABSENT, absent]] as const) {
          expect(outcome.calls, state).toEqual(await oracle.capabilityCallsFor(caller, sheetId))
          expect(beyondCapability(outcome.calls), state).toEqual([])
          expect(outcome.transactions, state).toBe(0)
        }
        expect(JSON.stringify([deleted.res.body, absent.res.body])).not.toContain('sht_oracle')
      })
    }
  }

  it('(b) an ADMIN sees the same values-free 404s — the answer is liveness, not the actor', async () => {
    currentUser = MANAGER
    const deleted = await call({ sheetId: DELETED })
    expect([deleted.res.status, deleted.res.body]).toEqual([SHEET_NOT_LIVE_STATUS, SHEET_DELETED_BODY])
    expect(deleted.calls).toEqual(await oracle.capabilityCallsFor(MANAGER, DELETED))

    const absent = await call({ sheetId: ABSENT })
    expect([absent.res.status, absent.res.body]).toEqual([SHEET_NOT_LIVE_STATUS, SHEET_ABSENT_BODY])
    expect(absent.calls).toEqual(await oracle.capabilityCallsFor(MANAGER, ABSENT))
    expect(JSON.stringify([deleted.res.body, absent.res.body])).not.toContain('sht_oracle')
  })

  it('(c) authorised caller on a LIVE sheet: the whole context payload, unchanged', async () => {
    currentUser = MANAGER
    const { res } = await call({ sheetId: LIVE })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.base).toEqual({
      id: BASE_ID,
      name: 'Oracle base',
      icon: 'table',
      color: '#1677ff',
      ownerId: 'u_oracle_owner',
      workspaceId: null,
    })
    expect(res.body.data.sheet).toEqual({ id: LIVE, baseId: BASE_ID, name: 'Oracle', description: null })
    expect((res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)).toEqual([LIVE])
    expect(res.body.data.views).toEqual([])
    expect(res.body.data.personalOverrideViewIds).toEqual([])
    expect(res.body.data.capabilities.canRead).toBe(true)
    expect(res.body.data.capabilityOrigin).toEqual({ source: 'admin', hasSheetAssignments: false })
    // The full payload really was assembled — the base, the base's sheet list AND the sheet row were
    // all read, i.e. the gate lets an authorised caller through rather than short-circuiting to 200.
    const { calls } = await call({ sheetId: LIVE })
    expect(calls.some((c) => /FROM meta_sheets s LEFT JOIN meta_bases b/.test(c.sql) && c.params.includes(LIVE))).toBe(true)
    expect(calls.some((c) => /FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(c.sql))).toBe(true)
  })

  it('(c) a base-only request (no sheetId, no viewId) is untouched by the gate', async () => {
    currentUser = MANAGER
    const { res } = await call({ baseId: BASE_ID })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((res.body.data.sheets as Array<{ id: string }>).map((s) => s.id)).toEqual([LIVE])
    // No sheet was named, so no per-sheet liveness question was asked about one.
    expect(res.body.data.sheet).toEqual({ id: LIVE, baseId: BASE_ID, name: 'Oracle', description: null })
  })

  it('the fixture cannot be satisfied by asking about the wrong sheet id (unknown id ⇒ live)', async () => {
    currentUser = MANAGER
    // An id the fixture does not know is LIVE, so a handler that mixed ids up would answer 404 on the
    // deleted/absent cases above for some OTHER reason than the one claimed. Here the sheet row is
    // served only for LIVE, so an unknown-but-live id reaches the row read and 404s VALUES-FREE.
    const { res } = await call({ sheetId: 'sht_oracle_never_configured' })
    expect(res.status).toBe(SHEET_NOT_LIVE_STATUS)
    expect(res.body).toEqual(SHEET_ABSENT_BODY)
    expect(JSON.stringify(res.body)).not.toContain('never_configured')
  })

  /**
   * (d) FIXTURE SELF-TEST for the #5936 widening. `BEYOND_CAPABILITY` and the fake pool's sheet-row
   * shape both used to read only the single-line probe; a probe written with a table alias walked
   * straight past them. These cells are what the widening rests on — remove the back-reference and the
   * negatives go green.
   */
  it('(d) the widened fixture reads the QUESTION, not the table name', () => {
    const aliased = 'SELECT s.id, s.base_id FROM meta_sheets s LEFT JOIN meta_bases b ON b.id = s.base_id WHERE s.id = $1 AND s.deleted_at IS NULL'
    expect(BEYOND_CAPABILITY.test(aliased)).toBe(true)
    expect(BEYOND_CAPABILITY.test('SELECT id FROM public.meta_sheets AS sheet_row WHERE sheet_row.id = $1 AND sheet_row.deleted_at IS NULL')).toBe(true)
    // The single-line shape the B-batches removed still matches (the widening ADDED, never replaced).
    expect(BEYOND_CAPABILITY.test('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')).toBe(true)

    // NEGATIVES: the alias is back-referenced, so the soft-delete filter must be on the SHEET.
    for (const notAProbe of [
      'SELECT x.id FROM other_table x LEFT JOIN meta_bases b ON b.id = x.base_id WHERE x.id = $1 AND x.deleted_at IS NULL',
      'SELECT b.id FROM meta_bases b WHERE b.id = $1 AND b.deleted_at IS NULL',
      'SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id = s.base_id AND b.deleted_at IS NULL',
    ]) {
      expect(BEYOND_CAPABILITY.test(notAProbe), notAProbe).toBe(false)
    }
    // And the capability lookup's own statements stay OUT of "beyond capability" — otherwise every
    // assertion that uses it would be vacuously red rather than a claim.
    expect(beyondCapability([{ sql: 'SELECT deleted_at FROM meta_sheets WHERE id = $1', params: [LIVE] }])).toEqual([])
  })
})
