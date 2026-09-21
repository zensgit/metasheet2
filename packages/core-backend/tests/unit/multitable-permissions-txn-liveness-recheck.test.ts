/**
 * issue #5938 — the FORWARD multitable permission doors: sheet liveness re-checked INSIDE the write
 * transaction, under the row lock.
 *
 * Sibling of tests/unit/spreadsheet-permissions-txn-liveness-recheck.test.ts, which pins the same
 * property on the legacy door. Same window, same fix, six more lock sites:
 *
 *   PUT /sheets/:sheetId/permissions/:subjectType/:subjectId           → spreadsheet_permissions
 *   PUT /views/:viewId/permissions/:subjectType/:subjectId             → meta_view_permissions
 *   PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId → field_permissions
 *   POST /sheets/:sheetId/config-restore-execute (permission-revert)   → applyPermissionDeEscalation
 *   PUT /sheets/:sheetId/row-level-read-deny                           → meta_sheets.row_level_read_permissions_enabled
 *   PUT /sheets/:sheetId/conditional-rules                             → meta_sheets.conditional_read_rules
 *
 * The last two write access-control POLICY onto the sheet row itself rather than a grant table. They are
 * here because the authority (`canManageSheetAccess`), the shape (pool gate, then transaction) and the
 * consequence (a read-deny decision recorded against a sheet that no longer exists, waiting for a
 * restore to bring it back) are the same — only the table differs.
 *
 * ── The window ────────────────────────────────────────────────────────────────
 * Each handler gates on `resolveSheetCapabilities` (403 → 404) using the POOL, then opens a transaction
 * that takes `meta_sheets … FOR UPDATE` before writing. A soft delete committing BETWEEN those two
 * leaves the row lock FREE — the writer neither waits nor sees the pre-delete row version — so it locked
 * a dead row and wrote anyway. Every leg scripts that exact interleaving: the unlocked gate read answers
 * LIVE, the locked re-read answers DELETED (or NO ROW).
 *
 * ── Harness ───────────────────────────────────────────────────────────────────
 * The route's FINAL handler is invoked directly (the same discipline as
 * recovery-conflict-surfaces-routes-univer-meta.test.ts) over a scripted fake pool; no real Postgres
 * (real-DB legs run only in CI). The transaction fake mirrors integration/db/connection-pool.ts:174-208
 * — BEGIN, handler on the TRANSACTION's client, COMMIT; on a throw, ROLLBACK then rethrow — so the
 * ROLLBACK assertion rests on the protocol rather than on trust. Every statement is logged with the
 * client that issued it, which is how "the re-read ran on the transaction client" is asserted: a
 * pool-level re-read would run on a different connection, take a second independent lock, and prove
 * nothing about the row this transaction writes.
 *
 * Each refusal leg also asserts the transaction was ENTERED (BEGIN logged). Without that, every leg
 * would pass just as well against a handler that refused at the pre-transaction gate — which is the
 * behaviour these legs exist to go BEYOND.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response, Router } from 'express'

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
import { univerMetaRouter } from '../../src/routes/univer-meta'

const SHEET = 'sheet_fwd_5938'
const VIEW = 'view_fwd_5938'
const FIELD = 'field_fwd_5938'
const SUBJECT = 'u_subject_5938'
const CALLER = 'u_caller_5938'
const REVISION = 'rev_fwd_5938'

/** Enough codes for canManageSheetAccess (share+read), canManageViews (write) and canManageFields. */
const CALLER_PERMISSIONS = ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema']

const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

const GATE_READ = /^SELECT deleted_at FROM meta_sheets WHERE id = \$1$/i
const LOCKED_READ = /^SELECT deleted_at FROM meta_sheets WHERE id = \$1 FOR UPDATE$/i

/**
 * Write statements against the three permission tables this file's routes own — AND the two
 * access-control columns on `meta_sheets` itself (the row-level read-deny switch and the conditional
 * read-deny rules). Those two are read-deny POLICY, written by the same `canManageSheetAccess`
 * authority through the same pool-gate-then-transaction shape, and their UPDATE carries no
 * `deleted_at` predicate: under READ COMMITTED it waits for a concurrent soft delete's row lock and
 * then overwrites on top of it. A matcher scoped to "permission tables" called them clean by omission.
 */
const PERMISSION_WRITE = /^(?:(?:INSERT INTO|DELETE FROM|UPDATE)\s+(?:spreadsheet_permissions|meta_view_permissions|field_permissions)\b|UPDATE meta_sheets SET (?:row_level_read_permissions_enabled|conditional_read_rules)\b)/i

type Liveness = 'live' | 'deleted' | 'absent'

const sqlLog: Array<{ sql: string; params: unknown[]; via: 'pool' | 'txn' }> = []
let gateAnswer: Liveness = 'live'
let lockedAnswer: Liveness = 'live'

function sheetRows(liveness: Liveness): { rows: unknown[]; rowCount: number } {
  if (liveness === 'absent') return { rows: [], rowCount: 0 }
  if (liveness === 'deleted') return { rows: [{ deleted_at: '2026-09-19T10:00:00.000Z' }], rowCount: 1 }
  return { rows: [{ deleted_at: null }], rowCount: 1 }
}

/** The permission revision the revert branch reverts: a partial `before` (no embedded subject keys). */
const PERMISSION_REVISION = {
  id: REVISION,
  sheet_id: SHEET,
  entity_type: 'permission',
  entity_id: `sheet:${JSON.stringify(['user', SUBJECT])}`,
  action: 'update',
  before: { accessLevel: 'read' },
  after: { accessLevel: 'admin' },
  changed_keys: ['accessLevel'],
}

function answerFor(sql: string): { rows: unknown[]; rowCount: number } {
  const text = collapse(sql)
  if (LOCKED_READ.test(text)) return sheetRows(lockedAnswer)
  if (GATE_READ.test(text)) return sheetRows(gateAnswer)
  // Subject existence (users / roles / platform_member_groups) — present, so the handler reaches the txn.
  if (/^SELECT id FROM users WHERE id = \$1$/i.test(text)) return { rows: [{ id: SUBJECT }], rowCount: 1 }
  if (/^SELECT id, sheet_id FROM meta_views WHERE id = \$1$/i.test(text)) {
    return { rows: [{ id: VIEW, sheet_id: SHEET }], rowCount: 1 }
  }
  if (/^SELECT id FROM meta_fields WHERE id = \$1 AND sheet_id = \$2$/i.test(text)) {
    return { rows: [{ id: FIELD }], rowCount: 1 }
  }
  if (/FROM meta_config_revisions WHERE id = \$1 AND sheet_id = \$2/i.test(text)) {
    return { rows: [PERMISSION_REVISION], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
}

const record = (via: 'pool' | 'txn') => async (sql: string, params: unknown[] = []) => {
  sqlLog.push({ sql: collapse(sql), params, via })
  return answerFor(sql)
}

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

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as Response & { statusCode: number; body: unknown }
}

/** Invoke the route's FINAL handler directly (mounting guards are not under test here). */
function invokeHandler(
  router: Router,
  method: 'post' | 'put',
  path: string,
  req: Partial<Request>,
  res: Response,
): Promise<unknown> {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const fullReq = {
    method: method.toUpperCase(),
    headers: {},
    query: {},
    params: {},
    body: {},
    user: { id: CALLER, permissions: CALLER_PERMISSIONS, perms: CALLER_PERMISSIONS, roles: [] },
  } as unknown as Request
  Object.assign(fullReq, req)
  return Promise.resolve(handler(fullReq, res, (err?: unknown) => {
    if (err) throw err
  }))
}

const permissionWrites = () => sqlLog.filter(({ sql }) => PERMISSION_WRITE.test(sql))
const lockedReads = () => sqlLog.filter(({ sql }) => LOCKED_READ.test(sql))
const txnMarkers = () => sqlLog
  .filter(({ sql }) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
  .map((s) => s.sql)

/** One lock site: how to reach it, and the write statement that proves the handler got past the lock. */
type Site = {
  name: string
  method: 'post' | 'put'
  path: string
  req: Partial<Request>
  wrote: RegExp
  /** Set for the branch that is only reachable with its flag on. */
  env?: Record<string, string>
}

const SITES: Site[] = [
  {
    name: 'PUT /sheets/:sheetId/permissions/:subjectType/:subjectId',
    method: 'put',
    path: '/sheets/:sheetId/permissions/:subjectType/:subjectId',
    req: { params: { sheetId: SHEET, subjectType: 'user', subjectId: SUBJECT }, body: { accessLevel: 'read' } },
    wrote: /^DELETE FROM spreadsheet_permissions/i,
  },
  {
    name: 'PUT /views/:viewId/permissions/:subjectType/:subjectId',
    method: 'put',
    path: '/views/:viewId/permissions/:subjectType/:subjectId',
    req: { params: { viewId: VIEW, subjectType: 'user', subjectId: SUBJECT }, body: { permission: 'read' } },
    wrote: /^DELETE FROM meta_view_permissions/i,
  },
  {
    name: 'PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId',
    method: 'put',
    path: '/sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId',
    req: {
      params: { sheetId: SHEET, fieldId: FIELD, subjectType: 'user', subjectId: SUBJECT },
      body: { remove: true },
    },
    wrote: /^DELETE FROM field_permissions/i,
  },
  {
    // The revert path the legacy route's own grant/revoke comment blocks point at (they name the
    // "permission-revert execute path" whose lock they take — anchored on that phrase rather than on a
    // line number, which drifts the moment either file gains a line):
    // de-escalation-only, but a de-escalation applied to a soft-deleted sheet still silently narrows
    // what a later restore brings back. Its liveness re-check is the FIRST statement in the txn, so the
    // refusal precedes the preview-identity verdict — which is why a placeholder token reaches it.
    name: 'POST /sheets/:sheetId/config-restore-execute (permission-revert branch)',
    method: 'post',
    path: '/sheets/:sheetId/config-restore-execute',
    req: {
      params: { sheetId: SHEET },
      body: { revisionId: REVISION, previewToken: 'not-a-real-token', confirm: 'revert-permission' },
    },
    // This branch never reaches a write in these legs; the control leg asserts the 404 is gone instead.
    wrote: /^never-matches-anything$/,
    env: { MULTITABLE_ENABLE_PERMISSION_REVERT: 'true' },
  },
  {
    // The read-deny SWITCH. Not a grant-table row — a column on `meta_sheets` itself — but the same
    // authority, the same window, and an UPDATE with no `deleted_at` predicate, so a soft delete that
    // commits after the gate read is simply overwritten on top of.
    name: 'PUT /sheets/:sheetId/row-level-read-deny',
    method: 'put',
    path: '/sheets/:sheetId/row-level-read-deny',
    req: { params: { sheetId: SHEET }, body: { enabled: true } },
    wrote: /^UPDATE meta_sheets SET row_level_read_permissions_enabled\b/i,
  },
  {
    // The read-deny RULES — same shape, same reasoning as the switch above.
    name: 'PUT /sheets/:sheetId/conditional-rules',
    method: 'put',
    path: '/sheets/:sheetId/conditional-rules',
    req: { params: { sheetId: SHEET }, body: { rules: [] } },
    wrote: /^UPDATE meta_sheets SET conditional_read_rules\b/i,
  },
]

const SHEET_DELETED_BODY = {
  ok: false,
  error: {
    code: 'SHEET_DELETED',
    message: 'This sheet has been deleted. It can be restored with POST /api/multitable/sheets/{sheetId}/restore by an actor with schema authority.',
  },
}
const NOT_FOUND_BODY = { ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } }

describe('forward multitable permission writes — in-transaction liveness re-check (#5938)', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    sqlLog.length = 0
    gateAnswer = 'live'
    lockedAnswer = 'live'
    transactionFake.mockClear()
    vi.spyOn(poolManager, 'get').mockReturnValue({
      query: (sql: string, params?: unknown[]) => record('pool')(sql, params ?? []),
      transaction: transactionFake,
    } as never)
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
  })

  function applyEnv(site: Site): void {
    for (const [key, value] of Object.entries(site.env ?? {})) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
  }

  for (const site of SITES) {
    describe(site.name, () => {
      it('gate saw LIVE, the locked re-read sees SOFT-DELETED → 404 SHEET_DELETED, ROLLBACK, no permission write', async () => {
        applyEnv(site)
        gateAnswer = 'live'
        lockedAnswer = 'deleted'
        const res = mockResponse()
        await invokeHandler(univerMetaRouter(), site.method, site.path, site.req, res)

        expect(res.statusCode).toBe(404)
        expect(res.body).toEqual(SHEET_DELETED_BODY)
        // Values-free: no sheet / view / field / subject id comes back.
        const body = JSON.stringify(res.body)
        for (const value of [SHEET, VIEW, FIELD, SUBJECT, REVISION]) expect(body).not.toContain(value)

        // The transaction was ENTERED and rolled back — not refused at the pre-transaction gate.
        expect(transactionFake).toHaveBeenCalledTimes(1)
        expect(txnMarkers()).toEqual(['BEGIN', 'ROLLBACK'])
        expect(permissionWrites()).toEqual([])

        expect(lockedReads().length).toBe(1)
        expect(lockedReads()[0].via).toBe('txn')
        expect(lockedReads()[0].params).toEqual([SHEET])
      })

      it('gate saw LIVE, the locked re-read finds NO ROW → 404 NOT_FOUND, ROLLBACK, no permission write', async () => {
        applyEnv(site)
        gateAnswer = 'live'
        lockedAnswer = 'absent'
        const res = mockResponse()
        await invokeHandler(univerMetaRouter(), site.method, site.path, site.req, res)

        expect(res.statusCode).toBe(404)
        expect(res.body).toEqual(NOT_FOUND_BODY)
        expect(JSON.stringify(res.body)).not.toContain(SHEET)

        expect(transactionFake).toHaveBeenCalledTimes(1)
        expect(txnMarkers()).toEqual(['BEGIN', 'ROLLBACK'])
        expect(permissionWrites()).toEqual([])
        expect(lockedReads().length).toBe(1)
        expect(lockedReads()[0].via).toBe('txn')
      })

      it('CONTROL — live at BOTH reads gets past the lock, and the gate read stays POOL-level and unlocked', async () => {
        applyEnv(site)
        gateAnswer = 'live'
        lockedAnswer = 'live'
        const res = mockResponse()
        await invokeHandler(univerMetaRouter(), site.method, site.path, site.req, res)

        // Not a liveness refusal any more — whatever else this branch decides.
        expect(res.body).not.toEqual(SHEET_DELETED_BODY)
        expect(res.body).not.toEqual(NOT_FOUND_BODY)
        expect(transactionFake).toHaveBeenCalledTimes(1)
        expect(lockedReads().length).toBe(1)
        expect(lockedReads()[0].via).toBe('txn')

        const gateReads = sqlLog.filter(({ sql }) => GATE_READ.test(sql))
        expect(gateReads.length).toBeGreaterThan(0)
        for (const read of gateReads) expect(read.via).toBe('pool')
      })
    })
  }

  // The three PUT routes additionally prove the ORDER: lock-and-re-read strictly before the write.
  for (const site of SITES.filter((s) => s.wrote.source !== '^never-matches-anything$')) {
    it(`${site.name} — the locked re-read precedes the permission write, on the same client`, async () => {
      applyEnv(site)
      gateAnswer = 'live'
      lockedAnswer = 'live'
      const res = mockResponse()
      await invokeHandler(univerMetaRouter(), site.method, site.path, site.req, res)

      const lockIndex = sqlLog.findIndex(({ sql }) => LOCKED_READ.test(sql))
      const writeIndex = sqlLog.findIndex(({ sql }) => site.wrote.test(sql))
      expect(lockIndex).toBeGreaterThanOrEqual(0)
      expect(writeIndex, `${site.name}: the route's own write never ran — the order leg would be vacuous`).toBeGreaterThanOrEqual(0)
      expect(lockIndex).toBeLessThan(writeIndex)
      expect(sqlLog[lockIndex].via).toBe('txn')
      expect(sqlLog[writeIndex].via).toBe('txn')
    })
  }
})
