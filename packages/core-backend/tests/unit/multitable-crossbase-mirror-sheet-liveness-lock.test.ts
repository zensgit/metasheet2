/**
 * issue #5954 — the cross-base mirror op's TWO-sheet lock re-reads liveness under the lock.
 *
 * `POST /crossbase/mirror-link` gates both ends of the edge (`livenessB`, `livenessA`) through the POOL,
 * outside any transaction, and then — inside the patch transaction, in `preWriteGuard` — locked both sheet
 * rows with a lock-only `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE`. A soft delete
 * that commits between the gate reads and that lock leaves the lock FREE: the op took it on a dead row and
 * wrote the forward edge anyway, answering 200. `assertSheetsLiveForUpdate` locks the rows AND reads
 * `deleted_at` in one statement, and refuses with the same values-free 404 the gates answer.
 *
 * Two layers, both over scripted fakes (no Postgres here — the real two-connection race is
 * the #5954 suite in tests/integration/multitable-crossbase-mirror-writethrough-concurrency-realdb.test.ts,
 * CI only):
 *
 *   §1 the helper — verdicts, normalisation, the statement it issues, the refusal shape.
 *   §2 the route — the gate reads LIVE, the locked read sees DELETED / NO ROW ⇒ 404, ROLLBACK, nothing
 *      after the lock; both live ⇒ the guard runs past the lock.
 *
 * The fakes are SQL-HONEST about `meta_sheets`: they PROJECT the columns the statement selects instead of
 * returning a canned row. A fake that always handed back `deleted_at` would keep every refusal leg green
 * against a helper whose statement stopped selecting it — the exact regression this file must catch.
 *
 * TRANSPORT: one pinned listener per file (usePinnedServer); `request(app)` is banned in tests/unit by the
 * supertest app-mode tripwire (#4154).
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rbacServiceMocks = vi.hoisted(() => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  userHasPermission: vi.fn().mockResolvedValue(false),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))
vi.mock('../../src/rbac/service', () => rbacServiceMocks)
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
}))

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  SHEETS_ROW_LOCK_LIVENESS_SQL,
  SHEET_DELETED_CODE,
  SHEET_DELETED_MESSAGE,
  SHEET_NOT_FOUND_MESSAGE,
  SheetNotLiveError,
  assertSheetsLiveForUpdate,
} from '../../src/multitable/sheet-liveness'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'

const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

type SheetRow = { id: string; base_id: string | null; deleted_at: unknown }

/**
 * `SELECT <cols> FROM meta_sheets WHERE id = ANY($1::text[]) …` answered from a table, projecting ONLY the
 * selected columns. Returns null for any other statement. `AND …` predicates are not modelled (they belong
 * to other readers — the approval-projection probe — which must see nothing here).
 */
function answerMultiSheetSelect(table: ReadonlyMap<string, SheetRow>, sql: string, params: unknown[]): { rows: unknown[] } | null {
  const m = /^SELECT (.+?) FROM meta_sheets WHERE id = ANY\(\$1::text\[\]\)(.*)$/i.exec(collapse(sql))
  if (!m) return null
  if (/\bAND\b/i.test(m[2]!)) return { rows: [] }
  const cols = m[1]!.split(',').map((c) => c.trim().split(/\s+/).pop()!)
  const ids = Array.isArray(params[0]) ? (params[0] as unknown[]) : []
  const rows: unknown[] = []
  for (const id of ids) {
    const row = table.get(String(id))
    if (!row) continue
    rows.push(Object.fromEntries(cols.map((c) => [c, (row as Record<string, unknown>)[c]])))
  }
  return { rows }
}

// ── §1 the helper ──────────────────────────────────────────────────────────────

const A = 'sheet_mlk_a_5954'
const B = 'sheet_mlk_b_5954'
const DELETED_AT = '2026-09-25T08:00:00.000Z'

function sheetTable(entries: Array<[string, unknown]>): Map<string, SheetRow> {
  return new Map(entries.map(([id, deletedAt]) => [id, { id, base_id: null, deleted_at: deletedAt }]))
}

/** A transaction query over `table`, logging every statement it is handed. */
function lockingQuery(table: Map<string, SheetRow>) {
  const seen: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    seen.push({ sql: collapse(sql), params })
    return answerMultiSheetSelect(table, sql, params) ?? { rows: [] }
  })
  return { query, seen }
}

async function refusal(promise: Promise<void>): Promise<SheetNotLiveError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err, 'expected a refusal, got a pass').toBeInstanceOf(SheetNotLiveError)
  return err as SheetNotLiveError
}

describe('§1 assertSheetsLiveForUpdate — lock every named sheet and refuse unless all are live', () => {
  it('all live: passes, issuing ONE statement — the exported constant — with the ids sorted', async () => {
    const { query, seen } = lockingQuery(sheetTable([[A, null], [B, null]]))
    await expect(assertSheetsLiveForUpdate(query, [B, A])).resolves.toBeUndefined()
    expect(seen).toEqual([{ sql: SHEETS_ROW_LOCK_LIVENESS_SQL, params: [[A, B]] }])
    // The statement itself: locks, reads deleted_at, and fixes the ACQUISITION order.
    expect(SHEETS_ROW_LOCK_LIVENESS_SQL).toBe(
      'SELECT id, deleted_at FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
    )
  })

  it('duplicates and unsorted input are normalised before they reach the statement', async () => {
    const { query, seen } = lockingQuery(sheetTable([[A, null], [B, null]]))
    await assertSheetsLiveForUpdate(query, [B, A, B, A, B])
    expect(seen.length).toBe(1)
    expect(seen[0]!.params).toEqual([[A, B]])
    // The sort is JS code-unit order — the order `[sheetA, sheetB].sort()` always used.
    expect(seen[0]!.params[0]).toEqual([B, A].sort())
  })

  it('one id ABSENT: refused as absent — NOT_FOUND, "Sheet not found"', async () => {
    const { query } = lockingQuery(sheetTable([[A, null]]))
    const err = await refusal(assertSheetsLiveForUpdate(query, [A, B]))
    expect(err.liveness).toBe('absent')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe(SHEET_NOT_FOUND_MESSAGE)
    expect(err.sheetId).toBe(B)
  })

  for (const [label, deleted, live] of [['sheet A', A, B], ['sheet B', B, A]] as const) {
    it(`${label} DELETED under the lock: refused as deleted — SHEET_DELETED, values-free`, async () => {
      const { query } = lockingQuery(sheetTable([[deleted, DELETED_AT], [live, null]]))
      const err = await refusal(assertSheetsLiveForUpdate(query, [B, A]))
      expect(err.liveness).toBe('deleted')
      expect(err.code).toBe(SHEET_DELETED_CODE)
      expect(err.message).toBe(SHEET_DELETED_MESSAGE)
      // Values-free: the message names neither sheet; the id travels only as a field, for logs.
      expect(err.message).not.toContain(A)
      expect(err.message).not.toContain(B)
      expect(err.sheetId).toBe(deleted)
    })
  }

  it('a Date deleted_at (what node-postgres returns for timestamptz) is deleted', async () => {
    const { query } = lockingQuery(sheetTable([[A, new Date()], [B, null]]))
    expect((await refusal(assertSheetsLiveForUpdate(query, [A, B]))).liveness).toBe('deleted')
  })

  it('both dead: the FIRST dead sheet in the CALLER\'S order decides — not the sort order', async () => {
    // A absent, B deleted. The route passes [sheetB, sheetA] — the order its pre-transaction gates run.
    const table = sheetTable([[B, DELETED_AT]])
    expect((await refusal(assertSheetsLiveForUpdate(lockingQuery(table).query, [B, A]))).liveness).toBe('deleted')
    expect((await refusal(assertSheetsLiveForUpdate(lockingQuery(table).query, [A, B]))).liveness).toBe('absent')
  })

  it('a row for an id that was NOT asked about cannot vouch for one that was', async () => {
    const seen: unknown[] = []
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      seen.push(params)
      // A misbehaving reader that answers with some other live sheet instead of the requested one.
      return { rows: [{ id: A, deleted_at: null }, { id: 'sheet_someone_else', deleted_at: null }] }
    })
    expect((await refusal(assertSheetsLiveForUpdate(query, [A, B]))).liveness).toBe('absent')
  })

  it('an empty or non-string id is refused as absent — never silently skipped', async () => {
    const { query } = lockingQuery(sheetTable([[A, null], [B, null]]))
    expect((await refusal(assertSheetsLiveForUpdate(query, [A, '']))).liveness).toBe('absent')
    expect((await refusal(assertSheetsLiveForUpdate(query, [A, undefined as unknown as string]))).liveness).toBe('absent')
    expect((await refusal(assertSheetsLiveForUpdate(query, [null as unknown as string]))).liveness).toBe('absent')
  })

  it('an empty list is a caller bug: a values-free TypeError, and no statement at all', async () => {
    const { query } = lockingQuery(sheetTable([[A, null]]))
    await expect(assertSheetsLiveForUpdate(query, [])).rejects.toThrow(new TypeError('SHEET_LIVENESS_NO_SHEET_IDS'))
    expect(query).not.toHaveBeenCalled()
  })
})

// ── §2 the route ───────────────────────────────────────────────────────────────

const SA = 'sheet_mlr_a_5954' // base-A sheet — the forward field F_A, rec_A
const SB = 'sheet_mlr_b_5954' // base-B sheet — the mirror field M_B, rec_B
const BASE_A = 'base_mlr_a_5954'
const BASE_B = 'base_mlr_b_5954'
const F_A = 'fld_mlr_fwd_5954'
const M_B = 'fld_mlr_mir_5954'
const REC_A = 'rec_mlr_a_5954'
const REC_B = 'rec_mlr_b_5954'
const CALLER = 'u_mlr_caller_5954'
const CALLER_PERMISSIONS = ['multitable:read', 'multitable:write']

const FORWARD_PROPERTY = { foreignSheetId: SB, foreignBaseId: BASE_B, twoWay: true, mirrorFieldId: M_B }
const MIRROR_PROPERTY = { foreignSheetId: SA, foreignBaseId: BASE_A, twoWay: true, mirrorFieldId: F_A, mirrorOf: F_A }

const SHEET_DELETED_BODY = { ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } }
const NOT_FOUND_BODY = { ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } }

type Via = 'pool' | 'txn'
const sqlLog: Array<{ sql: string; params: unknown[]; via: Via }> = []
/** What the pool-level gate reads see (pre-transaction, unlocked): always both live here. */
let gateSheets = new Map<string, SheetRow>()
/** What the transaction sees under the lock — the state after a concurrent soft delete committed. */
let lockedSheets = new Map<string, SheetRow>()

function liveSheets(): Map<string, SheetRow> {
  return new Map([
    [SA, { id: SA, base_id: BASE_A, deleted_at: null }],
    [SB, { id: SB, base_id: BASE_B, deleted_at: null }],
  ])
}

function answerFor(via: Via, sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  const text = collapse(sql)
  const sheets = via === 'txn' ? lockedSheets : gateSheets
  const wrap = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1( FOR UPDATE)?$/i.test(text)) {
    const row = sheets.get(String(params[0]))
    return wrap(row ? [{ deleted_at: row.deleted_at }] : [])
  }
  const multi = answerMultiSheetSelect(sheets, text, params)
  if (multi) return wrap(multi.rows)
  if (/^SELECT id, type, property FROM meta_fields WHERE id = \$1 AND sheet_id = \$2$/i.test(text)) {
    if (params[0] === M_B && params[1] === SB) return wrap([{ id: M_B, type: 'link', property: MIRROR_PROPERTY }])
    if (params[0] === F_A && params[1] === SA) return wrap([{ id: F_A, type: 'link', property: FORWARD_PROPERTY }])
    return wrap([])
  }
  if (/^SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = \$1\b/i.test(text)) {
    if (params[0] === SA) return wrap([{ id: F_A, name: 'Fwd', type: 'link', property: FORWARD_PROPERTY, order: 1 }])
    if (params[0] === SB) return wrap([{ id: M_B, name: 'Mir', type: 'link', property: MIRROR_PROPERTY, order: 1 }])
    return wrap([])
  }
  return wrap([])
}

const record = (via: Via) => async (sql: string, params: unknown[] = []) => {
  sqlLog.push({ sql: collapse(sql), params, via })
  return answerFor(via, sql, params)
}

/** Mirrors integration/db/connection-pool.ts `transaction`: BEGIN, handler, COMMIT — or ROLLBACK + rethrow. */
const transactionFake = vi.fn(async (handler: (c: { query: ReturnType<typeof record> }) => Promise<unknown>) => {
  sqlLog.push({ sql: 'BEGIN', params: [], via: 'txn' })
  try {
    const out = await handler({ query: record('txn') })
    sqlLog.push({ sql: 'COMMIT', params: [], via: 'txn' })
    return out
  } catch (e) {
    sqlLog.push({ sql: 'ROLLBACK', params: [], via: 'txn' })
    throw e
  }
})

const isMultiLock = (sql: string) => sql === SHEETS_ROW_LOCK_LIVENESS_SQL
const lockIndex = () => sqlLog.findIndex(({ sql }) => isMultiLock(sql))
const txnMarkers = () => sqlLog.filter(({ sql }) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)).map((s) => s.sql)
/** Transaction statements issued AFTER the sheet lock, excluding the protocol's own markers. */
const txnStatementsAfterLock = () =>
  sqlLog.slice(lockIndex() + 1).filter(({ via, sql }) => via === 'txn' && !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))

describe('§2 POST /crossbase/mirror-link — the two-sheet lock re-reads liveness (#5954)', () => {
  const pinned = usePinnedServer()
  const savedFlag = process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE

  beforeEach(() => {
    process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = 'true'
    sqlLog.length = 0
    gateSheets = liveSheets()
    lockedSheets = liveSheets()
    transactionFake.mockClear()
    vi.spyOn(poolManager, 'get').mockReturnValue({
      query: (sql: string, params?: unknown[]) => record('pool')(sql, params ?? []),
      transaction: transactionFake,
    } as never)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: unknown }).user = {
        id: CALLER, permissions: CALLER_PERMISSIONS, perms: CALLER_PERMISSIONS, roles: [],
      }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    pinned.setApp(app)
  })

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE
    else process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = savedFlag
    vi.restoreAllMocks()
  })

  const mirrorOp = () =>
    request(pinned.url()).post('/api/multitable/crossbase/mirror-link').send({
      sheetId: SB, recordId: REC_B, fieldId: M_B, action: 'add', foreignRecordId: REC_A, targetBaseId: BASE_A,
    })

  /** The shared tail of every refusal leg: entered the txn, locked on its own client, rolled back, wrote nothing. */
  function expectRefusedUnderTheLock(res: request.Response, body: unknown): void {
    expect(res.status).toBe(404) // not 200 (the pre-fix answer), not 500
    expect(res.body).toEqual(body)
    const raw = JSON.stringify(res.body)
    for (const value of [SA, SB, BASE_A, BASE_B, F_A, M_B, REC_A, REC_B]) expect(raw).not.toContain(value)

    // The gates ran on the POOL and saw both ends live — this refusal is the lock's, not the gate's.
    const gateReads = sqlLog.filter(({ sql }) => /^SELECT deleted_at FROM meta_sheets WHERE id = \$1$/.test(sql))
    expect(gateReads.map((r) => [r.via, r.params[0]])).toEqual([['pool', SB], ['pool', SA]])

    expect(transactionFake).toHaveBeenCalledTimes(1)
    expect(txnMarkers()).toEqual(['BEGIN', 'ROLLBACK'])
    const locks = sqlLog.filter(({ sql }) => isMultiLock(sql))
    expect(locks).toEqual([{ sql: SHEETS_ROW_LOCK_LIVENESS_SQL, params: [[SA, SB].sort()], via: 'txn' }])
    // Nothing ran on the transaction after the refused lock — no record lock, no edge read, no write.
    expect(txnStatementsAfterLock()).toEqual([])
  }

  it('gate saw both LIVE, sheet A (the edge\'s write target) is SOFT-DELETED under the lock → 404 SHEET_DELETED', async () => {
    lockedSheets.get(SA)!.deleted_at = DELETED_AT
    expectRefusedUnderTheLock(await mirrorOp(), SHEET_DELETED_BODY)
  })

  it('gate saw both LIVE, sheet B (the mirror side) is SOFT-DELETED under the lock → 404 SHEET_DELETED', async () => {
    lockedSheets.get(SB)!.deleted_at = DELETED_AT
    expectRefusedUnderTheLock(await mirrorOp(), SHEET_DELETED_BODY)
  })

  it('gate saw both LIVE, sheet A has NO ROW under the lock → 404 NOT_FOUND', async () => {
    lockedSheets.delete(SA)
    expectRefusedUnderTheLock(await mirrorOp(), NOT_FOUND_BODY)
  })

  it('both ends dead under the lock: B is judged first, as the gates judge it', async () => {
    lockedSheets.delete(SA)
    lockedSheets.get(SB)!.deleted_at = DELETED_AT
    expectRefusedUnderTheLock(await mirrorOp(), SHEET_DELETED_BODY)
  })

  it('CONTROL — both live under the lock: the guard runs PAST the lock, on the same transaction', async () => {
    const res = await mirrorOp()
    // Whatever else the guard decides (rec_B is not seeded here), it is not a liveness refusal.
    expect(res.body).not.toEqual(SHEET_DELETED_BODY)
    expect(res.body).not.toEqual(NOT_FOUND_BODY)
    expect(res.status).not.toBe(500)
    expect(transactionFake).toHaveBeenCalledTimes(1)
    expect(lockIndex()).toBeGreaterThanOrEqual(0)
    expect(sqlLog[lockIndex()]!.via).toBe('txn')
    // The very next thing the guard does on the transaction is lock rec_B — it got past the sheets.
    const after = txnStatementsAfterLock()
    expect(after.length).toBeGreaterThan(0)
    expect(after.some(({ sql }) => /^SELECT id, created_by, locked, locked_by FROM meta_records WHERE id = \$1 AND sheet_id = \$2 FOR UPDATE$/.test(sql)))
      .toBe(true)
    // …and the sheet lock was the FIRST statement the guard issued on the transaction.
    const firstTxnStatement = sqlLog.find(({ via, sql }) => via === 'txn' && sql !== 'BEGIN')
    expect(firstTxnStatement?.sql).toBe(SHEETS_ROW_LOCK_LIVENESS_SQL)
  })
})
