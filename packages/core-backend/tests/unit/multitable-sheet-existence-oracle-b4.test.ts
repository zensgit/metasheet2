/**
 * #5839 B4 — the two record_permissions TRANSACTION routes must not be an existence oracle.
 *
 * ── What was wrong ────────────────────────────────────────────────────────────
 * `PUT /sheets/:sheetId/records/:recordId/permissions` and
 * `DELETE /sheets/:sheetId/records/:recordId/permissions/:permissionId` read the sheet row
 * (`loadSheetRow`, which filters `deleted_at IS NULL`) and answered 404 — echoing the id back —
 * BEFORE their first 403. So a signed-in caller the route was about to refuse could tell a LIVE
 * sheet from a soft-DELETED or ABSENT one just by reading the status code: authority was decided
 * after existence had already been disclosed.
 *
 * ── What this file pins ───────────────────────────────────────────────────────
 * The ORACLE is closed from the caller's side (identical 403 body in all three states) AND from the
 * evidence side: the SQL the transaction issues before the 403 is a CONSTANT — the record-link lock
 * prelude plus exactly one capability resolution — with no branch on sheet state. A refusal that
 * looks identical but takes a state-dependent number of round trips is still an oracle to anyone who
 * can watch the database; pinning the statement list is what makes "identical" mean identical.
 *
 * ── SCOPE of that constancy, and the RESIDUAL it does not cover ───────────────
 * The round-trip constancy holds for sheets OUTSIDE the approval-projection base. The resolver does
 * read `meta_sheets` in exactly one place: its own projection fence — `loadApprovalProjectionSheetIds`
 * (`multitable/permission-service.ts`, `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND
 * base_id = $2`, deliberately WITHOUT a `deleted_at` filter). For an id inside that base the fence
 * hits for a live AND for a soft-deleted sheet, adds a participant round trip, and strips
 * `canManageSheetAccess`. Consequences, both pinned below as named RESIDUAL cases rather than left to
 * be rediscovered: the 403 BODY still closes over the three states, but (a) the pre-403 statement
 * count is 1 higher for present than for absent, and (b) a caller holding `multitable:share` gets
 * 403 / 403 / 404 — still able to split PRESENT from ABSENT inside that one base. That is strictly
 * narrower than the probe this PR removed (which also split live from soft-deleted, on every base),
 * so it is a residual, not a regression.
 *
 * The prelude is pre-403 BY DESIGN (see the comment at the PUT handler): the shared authority locks
 * and the row-auth advisory must be held before the capability read so a concurrent approval-create
 * final recheck serialises against a deny INSERT. It is therefore pinned here as a KNOWN constant
 * rather than treated as a leak — and its constancy across the three states is asserted, not assumed.
 *
 * ── Why the liveness check could not simply be deleted ────────────────────────
 * `resolveSheetCapabilitiesForUserOnQuery` returns `{ isAdminRole, capabilities, permissions }` —
 * it carries NO liveness. Deleting the pre-403 probe without replacing it would have let a sheet
 * manager keep writing grants onto a soft-deleted sheet (the `record_permissions` and `meta_records`
 * rows outlive the sheet). So the probe MOVED: after the 403 the handler resolves liveness itself
 * and refuses with the values-free bodies from `multitable/sheet-liveness.ts`.
 *
 * ── Seams ─────────────────────────────────────────────────────────────────────
 * One self-contained fake pool answers by SQL SHAPE **and by params**, and records both. Two things
 * it deliberately keeps apart:
 *   - INSIDE vs OUTSIDE the transaction. `pool.query` has its OWN recorder (`outsideLog`) and is NOT
 *     the function `transaction()` hands the handler. A read that takes a second pooled connection
 *     while this transaction holds `meta_sheets … FOR SHARE` plus the row-auth advisory escapes the
 *     snapshot the handler's own comment says it relies on (and is a self-deadlock shape under pool
 *     saturation), so `loadSheetLiveness(pool.query.bind(pool), …)` must be distinguishable from
 *     `loadSheetLiveness(query, …)`. It is: the former lands in `outsideLog`.
 *   - WHICH id a statement was issued for. `calls` keeps `{ sql, params }` and the sheet-keyed
 *     answers are selected by `params[0]`, so resolving liveness for the RECORD id (or any other id)
 *     answers `absent` instead of silently passing.
 * The expected statement lists are COMPUTED by running the real prelude helpers and the real resolver
 * against that same fake — never hand-listed — so a change in either shows up here as a diff rather
 * than as a stale expectation that keeps passing.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { ELEARNING_STATS_MULTITABLE_SHEETS_TABLE } from '../../src/multitable/elearning-projection-constants'
import {
  SHEET_DELETED_CODE,
  SHEET_DELETED_MESSAGE,
  SHEET_NOT_FOUND_MESSAGE,
  loadSheetLiveness,
} from '../../src/multitable/sheet-liveness'
import { sendForbidden, sendSheetNotLive } from '../../src/multitable/sheet-refusals'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { acquireRecordLinkRowAuthLockOnQuery } from '../../src/services/approval-record-link-row-auth-lock'
import {
  lockRecordLinkAuthorityRowsOnQuery,
  resolveSheetCapabilitiesForUserOnQuery,
} from '../../src/services/approval-record-link-txn-auth'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet-b4-oracle'
const RECORD_ID = 'rec-b4-oracle'
const PERMISSION_ID = 'perm-b4-oracle'
const ACTOR_ID = 'user-b4-actor'
const TARGET_USER_ID = 'user-b4-target'

const PUT_PATH = `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/permissions`
const DELETE_PATH = `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/permissions/${PERMISSION_ID}`
const PUT_BODY = { subjectType: 'user' as const, subjectId: TARGET_USER_ID, accessLevel: 'read' as const }

/** The three states a sheet id can be in. `absent` never existed; `deleted` is soft-deleted. */
type SheetState = 'live' | 'deleted' | 'absent'
const STATES: readonly SheetState[] = ['live', 'deleted', 'absent']

type QueryResult = { rows: unknown[]; rowCount?: number }

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * PINNED pre-403 prelude. These statements run BEFORE the authority check by design (shared
 * authority locks + the canonical row-auth advisory, so a concurrent approval-create final recheck
 * serialises against a deny INSERT). The list is a literal so a new pre-403 statement has to be
 * added here deliberately; `the pinned prelude is the real prelude` below proves the literal still
 * matches what the production helpers actually issue.
 */
const RECORD_LINK_LOCK_PRELUDE: readonly string[] = [
  'SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE',
  'SELECT role_id FROM user_roles WHERE user_id = $1 FOR SHARE',
  'SELECT permission_code FROM user_permissions WHERE user_id = $1 FOR SHARE',
  'SELECT id FROM users WHERE id = $1 FOR SHARE',
  'SAVEPOINT record_link_actor_groups',
  'SELECT group_id FROM platform_member_group_members WHERE user_id = $1 FOR SHARE',
  'RELEASE SAVEPOINT record_link_actor_groups',
  "SELECT sheet_id FROM spreadsheet_permissions WHERE sheet_id = $1 AND ( (subject_type = 'user' AND subject_id = $2)"
  + " OR (subject_type = 'role' AND subject_id = ANY($3::text[]))"
  + " OR (subject_type = 'member-group' AND subject_id = ANY($4::text[])) ) FOR SHARE",
  'SELECT pg_advisory_xact_lock(hashtext($1))',
  'SAVEPOINT record_link_row_auth_perms',
  'SELECT id FROM record_permissions WHERE sheet_id = $1 AND record_id = $2 FOR UPDATE',
  'RELEASE SAVEPOINT record_link_row_auth_perms',
]

/** The one liveness round trip the handler adds AFTER the 403. */
const LIVENESS_SQL = 'SELECT deleted_at FROM meta_sheets WHERE id = $1'
/** The prelude's shared lock on the sheet row — the ONE pre-403 statement whose answer knows `absent`. */
const SHEET_FOR_SHARE_SQL = 'SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE'
/** The resolver's approval-projection fence (`loadApprovalProjectionSheetIds`). No `deleted_at` filter. */
const PROJECTION_FENCE_SQL = 'SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND base_id = $2'

/**
 * Lock / transaction-control forms are EXEMPT from the beyond-capability rule: they are the pinned
 * prelude's own shape and they read no record content (`SELECT id … FOR UPDATE` returns ids the
 * caller already supplied). Listed explicitly so the exemption cannot widen silently.
 */
const LOCK_OR_TXN_CONTROL = /\bFOR UPDATE\b|\bFOR SHARE\b|\bpg_advisory_xact_lock\b|^SAVEPOINT\b|^RELEASE\b|^ROLLBACK TO\b/
/** Anything that reaches record content or mutates state. */
const RECORD_DATA_OR_WRITE = /^(?:INSERT|UPDATE|DELETE)\b|\bFROM meta_records\b|\bFROM record_permissions\b|\bINTO record_permissions\b/

function isBeyondCapability(sql: string): boolean {
  if (LOCK_OR_TXN_CONTROL.test(sql)) return false
  return RECORD_DATA_OR_WRITE.test(sql)
}

function touchesRecordPermissionWrite(sql: string): boolean {
  return /^INSERT INTO record_permissions\b/.test(sql)
    || /^UPDATE record_permissions\b/.test(sql)
    || /^DELETE FROM record_permissions\b/.test(sql)
}

/** A statement as the fake saw it. The params are what make "which id?" an answerable question. */
interface RecordedCall {
  sql: string
  params: unknown[]
}

interface Fake {
  /** Text of every statement issued INSIDE the transaction, in order. */
  sqlLog: string[]
  /** The same statements WITH their params. */
  calls: RecordedCall[]
  /** Statements issued on the POOL, outside any transaction. A correct handler leaves this empty. */
  outsideLog: string[]
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  pool: {
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>
    transaction: <T>(handler: (client: { query: Fake['query'] }) => Promise<T>) => Promise<T>
  }
  /** True once the transaction callback returned and the simulated COMMIT ran. */
  committed: () => boolean
}

interface FakeOpts {
  state: SheetState
  canShare: boolean
  /**
   * Whether this sheet id lives in the ADMIN-ONLY approval-projection base. Off by default (the
   * ordinary sheet). On, the resolver's own fence hits — see the SCOPE section of the file docblock.
   */
  projection?: boolean
}

/**
 * Self-contained fake pool. `canShare` decides the ONLY authority input that matters here
 * (`multitable:share` ⇒ `canManageSheetAccess`); the actor is never a DB admin, so the resolver
 * always walks its full stage list and the SQL shape does not depend on the answer.
 *
 * Sheet-keyed answers are selected by `params[0]`, not by the statement text alone: a handler that
 * resolved liveness for the RECORD id would otherwise be indistinguishable from the correct one.
 */
function createFake(opts: FakeOpts): Fake {
  const sqlLog: string[] = []
  const calls: RecordedCall[] = []
  const outsideLog: string[] = []
  let committed = false

  /** Is this statement addressed at the sheet under test? `absent` is the answer for any other id. */
  const isThisSheet = (value: unknown): boolean => value === SHEET_ID

  const answer = (q: string, params: unknown[]): QueryResult => {
    if (/^SAVEPOINT\b/.test(q) || /^RELEASE SAVEPOINT\b/.test(q) || /^ROLLBACK TO SAVEPOINT\b/.test(q)) {
      return { rows: [] }
    }

    // ── sheet rows, by state AND by id ──────────────────────────────────────
    if (q === SHEET_FOR_SHARE_SQL) {
      // FOR SHARE on zero rows returns normally — the ABSENT path must not throw.
      if (!isThisSheet(params[0]) || opts.state === 'absent') return { rows: [] }
      return { rows: [{ id: params[0] }] }
    }
    if (q === LIVENESS_SQL) {
      // Keyed on params[0]: liveness asked about any other id resolves `absent`, so a handler that
      // passes the wrong id cannot ride the sheet's state.
      if (!isThisSheet(params[0]) || opts.state === 'absent') return { rows: [] }
      return { rows: [{ deleted_at: opts.state === 'deleted' ? '2026-09-01T00:00:00.000Z' : null }] }
    }
    // Approval-projection fence. NOTE the missing `deleted_at` filter — faithful to
    // permission-service.ts: a soft-deleted projection sheet still hits.
    if (q === PROJECTION_FENCE_SQL) {
      if (!opts.projection || opts.state === 'absent') return { rows: [] }
      const ids = Array.isArray(params[0]) ? (params[0] as unknown[]) : []
      return { rows: ids.filter(isThisSheet).map((id) => ({ id })) }
    }
    // Participant probe — only reached on a fence hit. The actor is never a participant, so the
    // fence stays at its full admin-only shape.
    if (q.startsWith('SELECT DISTINCT s.id')) return { rows: [] }

    // ── lock prelude ────────────────────────────────────────────────────────
    if (q === 'SELECT role_id FROM user_roles WHERE user_id = $1 FOR SHARE') return { rows: [] }
    if (q === 'SELECT permission_code FROM user_permissions WHERE user_id = $1 FOR SHARE') return { rows: [] }
    if (q === 'SELECT id FROM users WHERE id = $1 FOR SHARE') return { rows: [{ id: params[0] }] }
    if (q === 'SELECT group_id FROM platform_member_group_members WHERE user_id = $1 FOR SHARE') return { rows: [] }
    if (q.startsWith('SELECT sheet_id FROM spreadsheet_permissions') && q.includes('FOR SHARE')) return { rows: [] }
    if (q === 'SELECT pg_advisory_xact_lock(hashtext($1))') return { rows: [{ pg_advisory_xact_lock: '' }] }
    if (q.includes('FROM record_permissions') && q.includes('FOR UPDATE')) return { rows: [] }

    // ── capability resolution ───────────────────────────────────────────────
    if (q === 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1') return { rows: [] }
    if (q.includes('SELECT DISTINCT permission_code AS code')) {
      return { rows: [{ code: opts.canShare ? 'multitable:share' : 'multitable:read' }] }
    }
    if (q === 'SELECT permissions FROM users WHERE id = $1') return { rows: [{ permissions: [] }] }
    if (q.startsWith('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) return { rows: [] }

    // ── beyond the 403 + liveness gate ──────────────────────────────────────
    if (q === 'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2') return { rows: [{ id: params[0] }] }
    if (q === 'SELECT id FROM users WHERE id = $1') return { rows: [{ id: params[0] }] }
    if (q.startsWith('INSERT INTO record_permissions')) return { rows: [], rowCount: 1 }
    if (q.startsWith('DELETE FROM record_permissions')) return { rows: [], rowCount: 1 }

    throw new Error(`Unhandled SQL in #5839 B4 existence-oracle fake: ${q}`)
  }

  /** The transaction-bound query. Everything it sees is, by construction, inside the transaction. */
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const q = normalizeSql(sql)
    sqlLog.push(q)
    calls.push({ sql: q, params })
    return answer(q, params)
  }

  /**
   * The POOL-level query — a DIFFERENT function with a DIFFERENT recorder. Taking a second pooled
   * connection mid-transaction leaves the txn snapshot and the locks it holds, so it must not be
   * silently equivalent to `query`.
   */
  const poolQuery = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const q = normalizeSql(sql)
    outsideLog.push(q)
    return answer(q, params)
  }

  const transaction = async <T>(handler: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    const result = await handler({ query })
    committed = true
    return result
  }

  return { sqlLog, calls, outsideLog, query, pool: { query: poolQuery, transaction }, committed: () => committed }
}

function installApp(fake: Fake) {
  vi.spyOn(poolManager, 'get').mockReturnValue(fake.pool as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // A signed-in NON-admin actor. `perms` is non-empty so resolveRequestAccess short-circuits and
    // the transaction-bound resolver (not the request claims) decides authority.
    req.user = {
      id: ACTOR_ID,
      role: 'user',
      roles: [],
      permissions: ['multitable:read'],
      perms: ['multitable:read'],
    } as Express.Request['user']
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

/** Run a production helper against a fresh fake and return that fake, with everything it recorded. */
async function recordStandalone(
  opts: FakeOpts,
  run: (query: Fake['query']) => Promise<unknown>,
): Promise<Fake> {
  const fake = createFake(opts)
  await run(fake.query)
  return fake
}

/** The statements a helper issued, text only. */
async function statementsOf(
  opts: FakeOpts,
  run: (query: Fake['query']) => Promise<unknown>,
): Promise<string[]> {
  return [...(await recordStandalone(opts, run)).sqlLog]
}

/**
 * Of the calls actually RECORDED from a run, which ones does the fake answer differently between two
 * sheet states? Replayed with the REAL params, so this is a property of the statements the route
 * issued — not of a hand-guessed probe. Used to say, in machine-checked form, WHY two states are
 * indistinguishable: because nothing the route asked before its 403 has a state-dependent answer.
 */
async function callsAnsweredDifferently(
  recorded: readonly RecordedCall[],
  states: readonly [SheetState, SheetState],
  opts: { canShare: boolean; projection?: boolean },
): Promise<string[]> {
  const differing: string[] = []
  for (const call of recorded) {
    const answers: string[] = []
    for (const state of states) {
      const probe = createFake({ ...opts, state })
      answers.push(JSON.stringify(await probe.query(call.sql, call.params)))
    }
    if (answers[0] !== answers[1] && !differing.includes(call.sql)) differing.push(call.sql)
  }
  return differing
}

/** The real prelude, as the two production helpers issue it. */
const runPrelude = async (query: Fake['query']) => {
  await lockRecordLinkAuthorityRowsOnQuery(query, { userId: ACTOR_ID, baseId: '', sheetId: SHEET_ID })
  await acquireRecordLinkRowAuthLockOnQuery(query, SHEET_ID, RECORD_ID)
}

/** The real capability resolver, one run. */
const runResolver = async (query: Fake['query']) => {
  await resolveSheetCapabilitiesForUserOnQuery(query, SHEET_ID, ACTOR_ID)
}

/** Derive a refusal body from the SHARED helper, so the route's inline literal cannot drift from it. */
function bodyFrom(send: (res: never) => unknown): { status: number; body: unknown } {
  let status = 0
  let body: unknown
  const res = {
    status(code: number) {
      status = code
      return this
    },
    json(payload: unknown) {
      body = payload
      return this
    },
  }
  send(res as never)
  return { status, body }
}

/**
 * Everything that must hold about the liveness round trip on a run that gets PAST the 403:
 *   - it sits behind the AUTHORITY GATE — the pinned prelude plus the one capability resolution,
 *     both COMPUTED from the production helpers. `>= prelude.length` would also be satisfied by a
 *     handler that resolved liveness before the capability read (re-opening the oracle), so the
 *     index is compared against the end of the resolver, not the end of the locks;
 *   - it happens INSIDE the transaction — `pool.query` has its own recorder, and a read that takes a
 *     second pooled connection while this txn holds FOR SHARE + the advisory would land there;
 *   - it asks about the ADDRESSED SHEET — params, not just statement text.
 */
async function expectLivenessBehindAuthorityGate(fake: Fake, opts: FakeOpts): Promise<number> {
  const resolverSql = await statementsOf(opts, runResolver)
  const gate = RECORD_LINK_LOCK_PRELUDE.length + resolverSql.length
  expect(fake.sqlLog.slice(0, gate), 'the pre-403 statements drifted from prelude + one resolver run')
    .toEqual([...RECORD_LINK_LOCK_PRELUDE, ...resolverSql])
  const livenessAt = fake.sqlLog.indexOf(LIVENESS_SQL)
  expect(livenessAt, 'liveness must be resolved AFTER the capability read, not merely after the locks')
    .toBe(gate)
  expect(fake.sqlLog.filter((q) => q === LIVENESS_SQL), 'liveness was resolved more than once').toHaveLength(1)
  expect(fake.outsideLog, 'a statement escaped the transaction onto a second pooled connection').toEqual([])
  expect(
    fake.calls.find((c) => c.sql === LIVENESS_SQL)?.params,
    'liveness was resolved for an id other than the addressed sheet',
  ).toEqual([SHEET_ID])
  return livenessAt
}

const FORBIDDEN = bodyFrom((res) => sendForbidden(res))
const NOT_LIVE_DELETED = bodyFrom((res) => sendSheetNotLive(res, 'deleted'))
const NOT_LIVE_ABSENT = bodyFrom((res) => sendSheetNotLive(res, 'absent'))

const pinned = usePinnedServer()

describe('#5839 B4 — record_permissions PUT/DELETE: authority before existence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('the pinned prelude is the real prelude, and it is state-independent', async () => {
    for (const state of STATES) {
      const fake = await recordStandalone({ state, canShare: false }, runPrelude)
      expect(fake.sqlLog, `prelude drifted on the ${state} sheet`).toEqual([...RECORD_LINK_LOCK_PRELUDE])
      // WHICH id: the prelude's shared lock is taken on the ADDRESSED sheet, not on some other id.
      const forShare = fake.calls.filter((c) => c.sql === SHEET_FOR_SHARE_SQL)
      expect(forShare, `prelude locked the wrong row count on the ${state} sheet`).toHaveLength(1)
      expect(forShare[0]!.params, `prelude locked an id other than the addressed sheet`).toEqual([SHEET_ID])
    }
    // The liveness helper, likewise, is a statement ABOUT a given id — pinned here so the routes'
    // assertions below ("issued with [SHEET_ID]") are comparing against the helper's real contract.
    const livenessProbe = await recordStandalone({ state: 'live', canShare: false }, async (query) => {
      await loadSheetLiveness(query, SHEET_ID)
    })
    expect(livenessProbe.calls).toEqual([{ sql: LIVENESS_SQL, params: [SHEET_ID] }])
    // The shared refusal helpers agree with what the routes must answer.
    expect(FORBIDDEN).toEqual({
      status: 403,
      body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
    })
    expect(NOT_LIVE_DELETED).toEqual({
      status: 404,
      body: { ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } },
    })
    expect(NOT_LIVE_ABSENT).toEqual({
      status: 404,
      body: { ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } },
    })
  })

  const ROUTES = [
    {
      name: 'PUT /sheets/:sheetId/records/:recordId/permissions',
      send: () => request(pinned.url()).put(PUT_PATH).send(PUT_BODY),
    },
    {
      name: 'DELETE /sheets/:sheetId/records/:recordId/permissions/:permissionId',
      send: () => request(pinned.url()).delete(DELETE_PATH),
    },
  ]

  for (const route of ROUTES) {
    it(`${route.name}: a caller without canManageSheetAccess gets the SAME 403 on live / deleted / absent`, async () => {
      const seen: Array<{
        state: SheetState
        status: number
        body: unknown
        sql: string[]
        calls: RecordedCall[]
        outside: string[]
      }> = []

      for (const state of STATES) {
        const fake = createFake({ state, canShare: false })
        pinned.setApp(installApp(fake))
        const res = await route.send()
        seen.push({
          state,
          status: res.status,
          body: res.body,
          sql: [...fake.sqlLog],
          calls: [...fake.calls],
          outside: [...fake.outsideLog],
        })
        vi.restoreAllMocks()
      }

      // (a) The refusal is indistinguishable across the three states, and it is the SHARED 403.
      for (const s of seen) {
        expect(s.status, `${s.state} answered ${s.status}`).toBe(403)
        expect(s.body, `${s.state} body differs`).toEqual(FORBIDDEN.body)
      }
      expect(seen[1]!.body).toEqual(seen[0]!.body)
      expect(seen[2]!.body).toEqual(seen[0]!.body)

      // (b) EVIDENCE: the statement list is prelude + exactly one real resolver run, computed by
      // running the production resolver — never hand-listed — and identical in all three states.
      // SCOPE: `projection: false` — an ordinary sheet. The projection-base residual is pinned by its
      // own cases at the bottom of this file, where this constancy provably does NOT hold.
      const resolverSql = await statementsOf({ state: 'live', canShare: false }, runResolver)
      const expected = [...RECORD_LINK_LOCK_PRELUDE, ...resolverSql]
      for (const s of seen) {
        expect(s.sql, `${s.state} issued a different statement list`).toEqual(expected)
      }
      // The resolver walks admin_role → permission_codes (+ legacy) → sheet_scope → approval
      // projection. The query-bound resolver has NO e-learning segment; assert that, so a future
      // addition has to come here and say so.
      expect(resolverSql).toHaveLength(5)
      expect(resolverSql.some((s) => s.includes(ELEARNING_STATS_MULTITABLE_SHEETS_TABLE))).toBe(false)

      // (d) The prelude prefix is byte-identical across the states — it does not branch or 404.
      const preludes = seen.map((s) => s.sql.slice(0, RECORD_LINK_LOCK_PRELUDE.length))
      expect(preludes[0]).toEqual([...RECORD_LINK_LOCK_PRELUDE])
      expect(preludes[1]).toEqual(preludes[0])
      expect(preludes[2]).toEqual(preludes[0])

      // (c) NO beyond-capability access: after the pinned prelude nothing reads record content or
      // writes anything, and the whole log holds no non-exempt record-data statement.
      for (const s of seen) {
        const afterPrelude = s.sql.slice(RECORD_LINK_LOCK_PRELUDE.length)
        expect(afterPrelude.filter((q) => RECORD_DATA_OR_WRITE.test(q)), `${s.state} reached record data after the prelude`).toEqual([])
        expect(s.sql.filter(isBeyondCapability), `${s.state} made a beyond-capability query`).toEqual([])
      }

      // The liveness round trip belongs AFTER the 403 — a refused caller never triggers it, on the
      // pooled connection no more than inside the transaction.
      for (const s of seen) {
        expect(s.sql.includes(LIVENESS_SQL), `${s.state} resolved liveness for a refused caller`).toBe(false)
        expect(s.outside, `${s.state} issued a statement outside the transaction`).toEqual([])
      }

      // (e) WHY live and deleted come out identical — stated as a property of the ROUTE, not assumed
      // from the fake. Replaying the statements the route ACTUALLY issued (with their real params)
      // against a live and a soft-deleted fake must produce the same answers everywhere: the route
      // asks nothing before its 403 whose answer knows about `deleted_at`. Without this, "live and
      // deleted got the same 403" is only a restatement of the fake answering them alike; a new
      // pre-403 `deleted_at` read would slip through. (`s.calls` is the same for all three states by
      // (b); the live run is used as the witness.)
      const liveVsDeleted = await callsAnsweredDifferently(seen[0]!.calls, ['live', 'deleted'], { canShare: false })
      expect(
        liveVsDeleted,
        'a statement issued BEFORE the 403 distinguishes a live sheet from a soft-deleted one',
      ).toEqual([])

      // And the ABSENT column is NOT the same input replayed: the prelude's shared lock on the sheet
      // row answers zero rows there. So the identical 403 across live|deleted|absent rests on a real
      // difference the route swallows without branching — exactly one statement, named.
      const liveVsAbsent = await callsAnsweredDifferently(seen[0]!.calls, ['live', 'absent'], { canShare: false })
      expect(
        liveVsAbsent,
        'the absent case must differ from the live case in the pinned FOR SHARE prelude row only',
      ).toEqual([SHEET_FOR_SHARE_SQL])
    })
  }

  it('PUT: a canManageSheetAccess caller writes and commits on a LIVE sheet', async () => {
    const fake = createFake({ state: 'live', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).put(PUT_PATH).send(PUT_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        sheetId: SHEET_ID,
        recordId: RECORD_ID,
        subjectType: 'user',
        subjectId: TARGET_USER_ID,
        accessLevel: 'read',
      },
    })
    expect(fake.committed()).toBe(true)
    // Liveness is resolved once, inside the transaction, for THIS sheet, after the 403 gate — and
    // before the write.
    const livenessAt = await expectLivenessBehindAuthorityGate(fake, { state: 'live', canShare: true })
    const insertAt = fake.sqlLog.findIndex((q) => q.startsWith('INSERT INTO record_permissions'))
    expect(insertAt).toBeGreaterThan(livenessAt)
  })

  it('PUT: a canManageSheetAccess caller is refused 404 on a DELETED sheet and writes nothing', async () => {
    const fake = createFake({ state: 'deleted', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).put(PUT_PATH).send(PUT_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual(NOT_LIVE_DELETED.body)
    expect(res.body?.error?.code).toBe(SHEET_DELETED_CODE)
    await expectLivenessBehindAuthorityGate(fake, { state: 'deleted', canShare: true })
    expect(fake.sqlLog.filter(touchesRecordPermissionWrite)).toEqual([])
  })

  it('PUT: a canManageSheetAccess caller is refused 404 NOT_FOUND on an ABSENT sheet and writes nothing', async () => {
    const fake = createFake({ state: 'absent', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).put(PUT_PATH).send(PUT_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual(NOT_LIVE_ABSENT.body)
    expect(res.body?.error?.message).toBe(SHEET_NOT_FOUND_MESSAGE)
    // Values-free: the refusal never echoes the id the caller probed with.
    expect(JSON.stringify(res.body)).not.toContain(SHEET_ID)
    await expectLivenessBehindAuthorityGate(fake, { state: 'absent', canShare: true })
    expect(fake.sqlLog.filter(touchesRecordPermissionWrite)).toEqual([])
  })

  it('DELETE: a canManageSheetAccess caller revokes and commits on a LIVE sheet', async () => {
    const fake = createFake({ state: 'live', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).delete(DELETE_PATH)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { deleted: true, permissionId: PERMISSION_ID } })
    expect(fake.committed()).toBe(true)
    const livenessAt = await expectLivenessBehindAuthorityGate(fake, { state: 'live', canShare: true })
    const deleteAt = fake.sqlLog.findIndex((q) => q.startsWith('DELETE FROM record_permissions'))
    expect(deleteAt).toBeGreaterThan(livenessAt)
  })

  it('DELETE: a canManageSheetAccess caller is refused 404 on a DELETED sheet and deletes nothing', async () => {
    const fake = createFake({ state: 'deleted', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).delete(DELETE_PATH)

    expect(res.status).toBe(404)
    expect(res.body).toEqual(NOT_LIVE_DELETED.body)
    expect(res.body?.error?.code).toBe(SHEET_DELETED_CODE)
    await expectLivenessBehindAuthorityGate(fake, { state: 'deleted', canShare: true })
    expect(fake.sqlLog.filter(touchesRecordPermissionWrite)).toEqual([])
  })

  it('DELETE: a canManageSheetAccess caller is refused 404 NOT_FOUND on an ABSENT sheet and deletes nothing', async () => {
    const fake = createFake({ state: 'absent', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).delete(DELETE_PATH)

    expect(res.status).toBe(404)
    expect(res.body).toEqual(NOT_LIVE_ABSENT.body)
    expect(res.body?.error?.message).toBe(SHEET_NOT_FOUND_MESSAGE)
    expect(JSON.stringify(res.body)).not.toContain(SHEET_ID)
    await expectLivenessBehindAuthorityGate(fake, { state: 'absent', canShare: true })
    expect(fake.sqlLog.filter(touchesRecordPermissionWrite)).toEqual([])
  })

  /**
   * ── RESIDUAL: the approval-projection base ──────────────────────────────────
   * The claim "the pre-403 statement list is a CONSTANT" is scoped to ordinary sheets. The resolver's
   * OWN fence reads `meta_sheets` by id with no `deleted_at` filter
   * (`loadApprovalProjectionSheetIds`, multitable/permission-service.ts) and, on a hit, takes a second
   * participant round trip and strips `canManageSheetAccess`. So inside that one admin-only base:
   *   - the 403 BODY still closes over the three states (the wire-level oracle stays shut), but
   *   - the pre-403 round-trip COUNT is 1 higher for present than for absent, and
   *   - a caller holding `multitable:share` — refused by the fence, not by the sheet — gets
   *     403 / 403 / 404, i.e. can still split PRESENT from ABSENT.
   * Pinned so it cannot widen unnoticed, and so nobody reports it later as a new hole. It is strictly
   * narrower than the removed probe, which split live from soft-deleted on EVERY base.
   */
  for (const route of ROUTES) {
    it(`${route.name}: RESIDUAL — on an approval-projection sheet the 403 body still closes, but the pre-403 round trips do NOT`, async () => {
      const seen: Array<{ state: SheetState; status: number; body: unknown; sql: string[] }> = []
      for (const state of STATES) {
        const fake = createFake({ state, canShare: false, projection: true })
        pinned.setApp(installApp(fake))
        const res = await route.send()
        seen.push({ state, status: res.status, body: res.body, sql: [...fake.sqlLog] })
        vi.restoreAllMocks()
      }

      // Wire level: unchanged — still one 403 for all three.
      for (const s of seen) {
        expect(s.status, `${s.state} answered ${s.status}`).toBe(403)
        expect(s.body, `${s.state} body differs`).toEqual(FORBIDDEN.body)
      }

      // Evidence level: NOT constant. The fence hits for live and for soft-deleted (no `deleted_at`
      // filter), which adds the participant statement; the absent id misses it.
      const live = seen[0]!
      const deleted = seen[1]!
      const absent = seen[2]!
      expect(deleted.sql, 'a soft-deleted projection sheet must look exactly like a live one').toEqual(live.sql)
      const extra = live.sql.filter((q) => !absent.sql.includes(q))
      expect(extra.every((q) => q.startsWith('SELECT DISTINCT s.id')), `unexpected extra statements: ${extra.join(' | ')}`).toBe(true)
      expect(live.sql.length, 'the projection residual changed shape').toBe(absent.sql.length + 1)
      // The statement responsible is the fence itself, and it is issued for the addressed sheet.
      expect(live.sql.includes(PROJECTION_FENCE_SQL)).toBe(true)
      // No liveness for a refused caller here either: the refusal is still authority-first.
      for (const s of seen) expect(s.sql.includes(LIVENESS_SQL), `${s.state} resolved liveness`).toBe(false)
    })

    it(`${route.name}: RESIDUAL — inside the projection base a multitable:share caller still splits present (403) from absent (404)`, async () => {
      const answers: Array<{ state: SheetState; status: number; code: unknown }> = []
      for (const state of STATES) {
        const fake = createFake({ state, canShare: true, projection: true })
        pinned.setApp(installApp(fake))
        const res = await route.send()
        answers.push({ state, status: res.status, code: (res.body as { error?: { code?: string } })?.error?.code })
        vi.restoreAllMocks()
      }

      expect(answers).toEqual([
        { state: 'live', status: 403, code: 'FORBIDDEN' },
        { state: 'deleted', status: 403, code: 'FORBIDDEN' },
        // The fence never hits an id with no row, so the share grant survives the 403 and the
        // liveness check answers. This is the residual — narrower than the removed probe, which
        // ALSO told live apart from soft-deleted, and on every base.
        { state: 'absent', status: 404, code: 'NOT_FOUND' },
      ])
    })
  }
})
