/**
 * issue #5938 — the LEGACY grant/revoke door: sheet liveness re-checked INSIDE the write transaction,
 * under the row lock.
 *
 * ── The window this pins shut ─────────────────────────────────────────────────
 * The #5829 gate (`resolveSheetCapabilities` → 403 → 404) reads liveness on the POOL, before the write
 * transaction exists. Soft delete is a plain `UPDATE meta_sheets SET deleted_at = now()` in its OWN
 * transaction. If that delete COMMITS between the gate's read and the write transaction's
 * `meta_sheets … FOR UPDATE`, the lock is already FREE: the writer does not wait for it, and it does not
 * see the pre-delete row version. It took the lock and wrote a grant onto a soft-deleted sheet.
 *
 * A lock is not a time machine, so the fix cannot be "lock harder": the write transaction has to ASK
 * AGAIN, under the lock it now holds. Every leg below scripts exactly that interleaving — the gate's
 * unlocked read answers LIVE, the locked re-read answers DELETED (or NO ROW) — which is the state a real
 * backend is in when the delete commits in the window, and the state the pre-#5938 code wrote through.
 *
 * ── What is asserted, and why each half is needed ─────────────────────────────
 *   - 404 with the SAME values-free bodies the gate answers (`SHEET_DELETED` / `NOT_FOUND`), never the
 *     sheet id — a refusal that echoed the id would be an existence oracle, and a DIFFERENT body for the
 *     window than for "already deleted when you asked" would make the window itself observable;
 *   - ROLLBACK, not COMMIT. The fake transaction here mirrors the real one
 *     (integration/db/connection-pool.ts:174-208 — BEGIN, handler, COMMIT; on throw ROLLBACK then
 *     rethrow), so "the refusal rolls back" is asserted on the protocol rather than assumed;
 *   - ZERO INSERT/DELETE/UPDATE against `spreadsheet_permissions` — the point of the fix is the absence
 *     of the write, not the presence of the status code;
 *   - the re-read ran through the TRANSACTION's own client, not the pool. A pool-level re-read runs on a
 *     different connection and takes a second, independent lock: it would prove nothing about the row
 *     this transaction is about to write, while looking identical in a status-code-only test;
 *   - the transaction was ENTERED at all (`transaction` called, BEGIN logged). Without this every leg
 *     would pass just as well against a route that refused at the pre-transaction gate — i.e. against
 *     the #5829 behaviour these legs are supposed to go beyond;
 *   - `auditLog` never ran: a refused grant must not leave an audit record claiming it happened;
 *   - the CONTROL: live at BOTH reads still writes and still commits, so none of the above is passing
 *     because the handler stopped working.
 *
 * Fake pool, never a real DB (real Postgres runs only in CI): every statement is appended to `sqlLog`
 * with the client that issued it, so "never touched the table" and "asked on the transaction client" are
 * both asserted on the SQL itself. Identities are session-shaped only — an id plus permission codes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import { usePinnedServer } from '../utils/pinned-server'

/** Every statement, in order, tagged with the client that issued it. */
const sqlLog: Array<{ sql: string; params: unknown[]; via: 'pool' | 'txn' }> = []

const SHEET = 'sheet_toctou_5938'
const CALLER = 'u_caller_5938'
const TARGET = 'u_target_5938'

const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

/** The unlocked gate read. */
const GATE_READ = /^SELECT deleted_at FROM meta_sheets WHERE id = \$1$/i
/** The in-transaction re-read that ALSO takes the row lock. */
const LOCKED_READ = /^SELECT deleted_at FROM meta_sheets WHERE id = \$1 FOR UPDATE$/i

type Liveness = 'live' | 'deleted' | 'absent'

/** What each of the two reads answers — scripted independently, which is the whole point. */
let gateAnswer: Liveness = 'live'
let lockedAnswer: Liveness = 'live'

function sheetRows(liveness: Liveness): { rows: unknown[]; rowCount: number } {
  if (liveness === 'absent') return { rows: [], rowCount: 0 }
  if (liveness === 'deleted') return { rows: [{ deleted_at: '2026-09-19T10:00:00.000Z' }], rowCount: 1 }
  return { rows: [{ deleted_at: null }], rowCount: 1 }
}

function answerFor(sql: string): { rows: unknown[]; rowCount: number } {
  const text = collapse(sql)
  if (LOCKED_READ.test(text)) return sheetRows(lockedAnswer)
  if (GATE_READ.test(text)) return sheetRows(gateAnswer)
  if (/^SELECT perm_code FROM spreadsheet_permissions/i.test(text)) {
    return { rows: [{ perm_code: 'spreadsheet:read' }], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
}

const record = (via: 'pool' | 'txn') => async (sql: string, params: unknown[] = []) => {
  sqlLog.push({ sql: collapse(sql), params, via })
  return answerFor(sql)
}

const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn().mockResolvedValue(undefined) }))

/**
 * The transaction fake mirrors integration/db/connection-pool.ts:174-208: BEGIN, run the handler on the
 * TRANSACTION's client, COMMIT; on a throw, ROLLBACK and rethrow. Anything looser (a bare `handler(...)`)
 * would make the ROLLBACK assertion unfalsifiable.
 */
const pgMocks = vi.hoisted(() => ({ transaction: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  pool: { query: (sql: string, params?: unknown[]) => record('pool')(sql, params ?? []) },
  query: (sql: string, params?: unknown[]) => record('pool')(sql, params ?? []),
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  userHasPermission: vi.fn().mockResolvedValue(false),
  invalidateUserPerms: vi.fn(),
}))
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/audit/audit', () => auditMocks)

import { spreadsheetPermissionsRouter } from '../../src/routes/spreadsheet-permissions'

/** The global rbac codes these routes carry, plus what makes canManageSheetAccess true (#5829). */
const SHEET_MANAGER = [
  'spreadsheet-permissions:read',
  'spreadsheet-permissions:write',
  'multitable:read',
  'multitable:share',
]

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = { id: CALLER, permissions: SHEET_MANAGER }
    next()
  })
  app.use(spreadsheetPermissionsRouter())
  return app
}

const grantTableWrites = () => sqlLog.filter(({ sql }) => (
  /INSERT INTO spreadsheet_permissions/i.test(sql)
  || /DELETE FROM spreadsheet_permissions/i.test(sql)
  || /UPDATE spreadsheet_permissions/i.test(sql)
))

const lockedReads = () => sqlLog.filter(({ sql }) => LOCKED_READ.test(sql))
const txnMarkers = () => sqlLog.filter(({ sql }) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK').map((s) => s.sql)

const pinned = usePinnedServer()

const ROUTES = [
  {
    name: 'POST /api/spreadsheets/:id/permissions/grant',
    call: () => request(pinned.url())
      .post(`/api/spreadsheets/${SHEET}/permissions/grant`)
      .send({ userId: TARGET, permission: 'spreadsheet:read' }),
    wrote: /INSERT INTO spreadsheet_permissions/i,
  },
  {
    name: 'POST /api/spreadsheets/:id/permissions/revoke',
    call: () => request(pinned.url())
      .post(`/api/spreadsheets/${SHEET}/permissions/revoke`)
      .send({ userId: TARGET, permission: 'spreadsheet:read' }),
    wrote: /DELETE FROM spreadsheet_permissions/i,
  },
] as const

describe('legacy spreadsheet-permissions grant/revoke — in-transaction liveness re-check (#5938)', () => {
  beforeEach(() => {
    sqlLog.length = 0
    gateAnswer = 'live'
    lockedAnswer = 'live'
    auditMocks.auditLog.mockClear()
    pgMocks.transaction.mockReset()
    pgMocks.transaction.mockImplementation(async (handler: (c: { query: ReturnType<typeof record> }) => Promise<unknown>) => {
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
    pinned.setApp(buildApp())
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('gate saw LIVE, the locked re-read sees SOFT-DELETED → 404 SHEET_DELETED, ROLLBACK, no write', async () => {
        gateAnswer = 'live'
        lockedAnswer = 'deleted'
        const res = await route.call()

        expect(res.status).toBe(404)
        expect(res.body).toEqual({
          ok: false,
          error: {
            code: 'SHEET_DELETED',
            message: 'This sheet has been deleted. It can be restored with POST /api/multitable/sheets/{sheetId}/restore by an actor with schema authority.',
          },
        })
        // Values-free: neither the sheet id nor the subject the caller named comes back.
        expect(JSON.stringify(res.body)).not.toContain(SHEET)
        expect(JSON.stringify(res.body)).not.toContain(TARGET)

        // The transaction was ENTERED — so this is the in-transaction refusal, not the #5829 gate.
        expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
        expect(txnMarkers()).toEqual(['BEGIN', 'ROLLBACK'])
        expect(grantTableWrites()).toEqual([])
        expect(auditMocks.auditLog).not.toHaveBeenCalled()

        // Exactly one locked re-read, on the TRANSACTION's client, bound to the addressed sheet.
        expect(lockedReads().length).toBe(1)
        expect(lockedReads()[0].via).toBe('txn')
        expect(lockedReads()[0].params).toEqual([SHEET])
      })

      it('gate saw LIVE, the locked re-read finds NO ROW → 404 NOT_FOUND, ROLLBACK, no write', async () => {
        gateAnswer = 'live'
        lockedAnswer = 'absent'
        const res = await route.call()

        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } })
        expect(JSON.stringify(res.body)).not.toContain(SHEET)

        expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
        expect(txnMarkers()).toEqual(['BEGIN', 'ROLLBACK'])
        expect(grantTableWrites()).toEqual([])
        expect(auditMocks.auditLog).not.toHaveBeenCalled()
        expect(lockedReads().length).toBe(1)
        expect(lockedReads()[0].via).toBe('txn')
      })

      it('CONTROL — live at BOTH reads still writes and still COMMITs', async () => {
        gateAnswer = 'live'
        lockedAnswer = 'live'
        const res = await route.call()

        expect(res.status).toBe(200)
        expect(res.body?.ok).toBe(true)
        expect(txnMarkers()).toEqual(['BEGIN', 'COMMIT'])
        // The route's own write really ran: without this the refusal legs above could pass against a
        // handler that had stopped writing for an unrelated reason.
        expect(sqlLog.some(({ sql }) => route.wrote.test(sql))).toBe(true)
        expect(lockedReads().length).toBe(1)
        expect(auditMocks.auditLog).toHaveBeenCalledTimes(1)
      })

      it('the locked re-read happens BEFORE the write statement, on the same client', async () => {
        gateAnswer = 'live'
        lockedAnswer = 'live'
        await route.call()

        const lockIndex = sqlLog.findIndex(({ sql }) => LOCKED_READ.test(sql))
        const writeIndex = sqlLog.findIndex(({ sql }) => route.wrote.test(sql))
        expect(lockIndex).toBeGreaterThanOrEqual(0)
        expect(writeIndex).toBeGreaterThanOrEqual(0)
        expect(lockIndex).toBeLessThan(writeIndex)
        expect(sqlLog[lockIndex].via).toBe('txn')
        expect(sqlLog[writeIndex].via).toBe('txn')
      })
    })
  }

  it('the two reads are DISTINCT statements: the gate never locks, the re-check always does', async () => {
    gateAnswer = 'live'
    lockedAnswer = 'live'
    await request(pinned.url())
      .post(`/api/spreadsheets/${SHEET}/permissions/grant`)
      .send({ userId: TARGET, permission: 'spreadsheet:read' })

    const gateReads = sqlLog.filter(({ sql }) => GATE_READ.test(sql))
    expect(gateReads.length).toBeGreaterThan(0)
    // The gate's read is pool-level and unlocked — taking a row lock there would serialize every
    // authority check in the system, and would still not cover the write transaction.
    for (const read of gateReads) expect(read.via).toBe('pool')
    expect(lockedReads().length).toBe(1)
    expect(lockedReads()[0].via).toBe('txn')
  })
})
