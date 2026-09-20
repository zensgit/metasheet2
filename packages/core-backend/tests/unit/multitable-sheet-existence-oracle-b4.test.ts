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
 * One self-contained fake pool answers by SQL SHAPE and records every statement; its `transaction()`
 * hands the handler THE SAME query function, so the recorded log is exactly what the transaction did.
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

interface Fake {
  sqlLog: string[]
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  pool: {
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>
    transaction: <T>(handler: (client: { query: Fake['query'] }) => Promise<T>) => Promise<T>
  }
  /** True once the transaction callback returned and the simulated COMMIT ran. */
  committed: () => boolean
}

/**
 * Self-contained fake pool. `canShare` decides the ONLY authority input that matters here
 * (`multitable:share` ⇒ `canManageSheetAccess`); the actor is never a DB admin, so the resolver
 * always walks its full stage list and the SQL shape does not depend on the answer.
 */
function createFake(opts: { state: SheetState; canShare: boolean }): Fake {
  const sqlLog: string[] = []
  let committed = false

  const answer = (q: string, params: unknown[]): QueryResult => {
    if (/^SAVEPOINT\b/.test(q) || /^RELEASE SAVEPOINT\b/.test(q) || /^ROLLBACK TO SAVEPOINT\b/.test(q)) {
      return { rows: [] }
    }

    // ── sheet rows, by state ────────────────────────────────────────────────
    if (q === 'SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE') {
      // FOR SHARE on zero rows returns normally — the ABSENT path must not throw.
      return { rows: opts.state === 'absent' ? [] : [{ id: params[0] }] }
    }
    if (q === LIVENESS_SQL) {
      if (opts.state === 'absent') return { rows: [] }
      return { rows: [{ deleted_at: opts.state === 'deleted' ? '2026-09-01T00:00:00.000Z' : null }] }
    }
    // approval-projection probe: this sheet is not a projection sheet in any state.
    if (q === 'SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND base_id = $2') return { rows: [] }

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

  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const q = normalizeSql(sql)
    sqlLog.push(q)
    return answer(q, params)
  }

  const transaction = async <T>(handler: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    // Same query function inside the transaction, so sqlLog IS the transaction's statement list.
    const result = await handler({ query })
    committed = true
    return result
  }

  return { sqlLog, query, pool: { query, transaction }, committed: () => committed }
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

/** Run a production helper against a fresh fake and return the statements it issued. */
async function recordStandalone(
  opts: { state: SheetState; canShare: boolean },
  run: (query: Fake['query']) => Promise<unknown>,
): Promise<string[]> {
  const fake = createFake(opts)
  await run(fake.query)
  return [...fake.sqlLog]
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
      const observed = await recordStandalone({ state, canShare: false }, runPrelude)
      expect(observed, `prelude drifted on the ${state} sheet`).toEqual([...RECORD_LINK_LOCK_PRELUDE])
    }
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
      const seen: Array<{ state: SheetState; status: number; body: unknown; sql: string[] }> = []

      for (const state of STATES) {
        const fake = createFake({ state, canShare: false })
        pinned.setApp(installApp(fake))
        const res = await route.send()
        seen.push({ state, status: res.status, body: res.body, sql: [...fake.sqlLog] })
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
      const resolverSql = await recordStandalone({ state: 'live', canShare: false }, runResolver)
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

      // The liveness round trip belongs AFTER the 403 — a refused caller never triggers it.
      for (const s of seen) {
        expect(s.sql.includes(LIVENESS_SQL), `${s.state} resolved liveness for a refused caller`).toBe(false)
      }
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
    // Liveness is resolved once, after the 403 gate and before the write.
    const livenessAt = fake.sqlLog.indexOf(LIVENESS_SQL)
    const insertAt = fake.sqlLog.findIndex((q) => q.startsWith('INSERT INTO record_permissions'))
    expect(livenessAt).toBeGreaterThanOrEqual(RECORD_LINK_LOCK_PRELUDE.length)
    expect(insertAt).toBeGreaterThan(livenessAt)
    expect(fake.sqlLog.filter((q) => q === LIVENESS_SQL)).toHaveLength(1)
  })

  it('PUT: a canManageSheetAccess caller is refused 404 on a DELETED sheet and writes nothing', async () => {
    const fake = createFake({ state: 'deleted', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).put(PUT_PATH).send(PUT_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual(NOT_LIVE_DELETED.body)
    expect(res.body?.error?.code).toBe(SHEET_DELETED_CODE)
    expect(fake.sqlLog.includes(LIVENESS_SQL)).toBe(true)
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
    expect(fake.sqlLog.filter(touchesRecordPermissionWrite)).toEqual([])
  })

  it('DELETE: a canManageSheetAccess caller revokes and commits on a LIVE sheet', async () => {
    const fake = createFake({ state: 'live', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).delete(DELETE_PATH)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { deleted: true, permissionId: PERMISSION_ID } })
    expect(fake.committed()).toBe(true)
    const livenessAt = fake.sqlLog.indexOf(LIVENESS_SQL)
    const deleteAt = fake.sqlLog.findIndex((q) => q.startsWith('DELETE FROM record_permissions'))
    expect(livenessAt).toBeGreaterThanOrEqual(RECORD_LINK_LOCK_PRELUDE.length)
    expect(deleteAt).toBeGreaterThan(livenessAt)
  })

  it('DELETE: a canManageSheetAccess caller is refused 404 on a DELETED sheet and deletes nothing', async () => {
    const fake = createFake({ state: 'deleted', canShare: true })
    pinned.setApp(installApp(fake))

    const res = await request(pinned.url()).delete(DELETE_PATH)

    expect(res.status).toBe(404)
    expect(res.body).toEqual(NOT_LIVE_DELETED.body)
    expect(res.body?.error?.code).toBe(SHEET_DELETED_CODE)
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
    expect(fake.sqlLog.filter(touchesRecordPermissionWrite)).toEqual([])
  })
})
