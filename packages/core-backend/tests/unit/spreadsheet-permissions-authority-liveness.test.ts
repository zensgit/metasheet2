/**
 * issue #5829 — the LEGACY spreadsheet-permissions routes were a second, unguarded door onto the
 * multitable per-sheet grant table.
 *
 * `spreadsheet_permissions.sheet_id` is a `meta_sheets` id: the live migration is
 * src/db/migrations/zzzz20260405190000_create_spreadsheet_permissions.ts:7 (`REFERENCES
 * meta_sheets(id)`); the raw-SQL twin that said `REFERENCES spreadsheets(id)`
 * (migrations/036_create_spreadsheet_permissions.sql:4) is a no-op history marker listed in
 * SUPERSEDED_LEGACY_SQL_MIGRATIONS (src/db/migration-provider.ts:78) — for every database the CURRENT
 * provider builds; that hold-down dates from 36ee32502 (2026-05-12) and is re-enterable with
 * MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL='true', so the pre-2026-05-12 database is a named residual
 * class, not an empty one (see the route file's header). So the rows these three routes list, insert
 * and delete are exactly the rows multitable reads as per-sheet grants — and the routes carried only
 * `rbacGuard('spreadsheet-permissions', …)`, one GLOBAL code, with no per-sheet
 * `canManageSheetAccess` and no sheet-liveness check.
 *
 * What this suite pins, per route:
 *   - a caller who HOLDS the global code but not `canManageSheetAccess` gets the IDENTICAL 403 —
 *     same status, same body — whether the addressed sheet is LIVE, soft-DELETED or ABSENT, and the
 *     recorded SQL contains none of the route's own grant-table statements. Identical is the point:
 *     a different answer per state turns the refusal into a sheet-existence oracle;
 *   - the 403 body is `sendForbidden`'s, NOT rbacGuard's — so a green here cannot come from the
 *     outer guard having refused before the new gate ever ran;
 *   - a caller who DOES hold `canManageSheetAccess` succeeds on a LIVE sheet (the control, which is
 *     also the handler-reached self-check: the route's own SQL must appear in the log, otherwise the
 *     refusal assertions above would be vacuous);
 *   - the same authorised caller gets 404 SHEET_DELETED on a soft-deleted sheet and 404 NOT_FOUND on
 *     an absent one, with no INSERT/DELETE and no sheet-row lock taken;
 *   - authority may come from THIS table (a per-sheet `spreadsheet:admin` grant), and it is per-SHEET:
 *     the same caller holding that grant on one LIVE sheet is refused on a DIFFERENT LIVE sheet — and
 *     the gate's grant read is bound to the ADDRESSED sheet and to the CALLER's own subject id, both
 *     asserted on the bound values, not only on the SQL text.
 *
 * Fake pool, never a real DB: every statement the code under test issues is appended to `sqlLog`, so
 * "never touched the table" is asserted on the SQL itself rather than on a spy over one helper. The
 * fake answers each statement the way PostgreSQL would answer THAT statement (it honours the bind
 * values of the gate's grant read), so no leg rests on a row a real backend could never return.
 * Identities are session-shaped only (an id plus permission codes) — no names, no directory lookups.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import { usePinnedServer } from '../utils/pinned-server'

/** Every statement issued through the pool or inside a transaction, in order. */
const sqlLog: Array<{ sql: string; params: unknown[] }> = []

/** Sheet ids whose `meta_sheets` row is live / soft-deleted; anything else is absent. */
const LIVE_SHEET = 'sheet_live_5829'
/** A SECOND live sheet — so "the grant is per-sheet" can be asked between two sheets that both exist. */
const OTHER_LIVE_SHEET = 'sheet_live_other_5829'
const DELETED_SHEET = 'sheet_deleted_5829'
const ABSENT_SHEET = 'sheet_absent_5829'

/** The caller every leg authenticates as; the gate's grant read must be scoped to exactly this id. */
const CALLER = 'u_caller_5829'

const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

/** Flipped by the fail-closed leg: the gate's liveness probe rejects instead of answering. */
let livenessProbeThrows = false

/**
 * When set, the gate's caller-scoped grant read answers with a `spreadsheet:admin` row on that sheet
 * — the PER-SHEET path to canManageSheetAccess (permission-service applySheetPermissionScope:1494),
 * i.e. authority that comes out of this very table rather than out of a global code.
 */
let sheetAdminGrantOn: string | null = null

function answerFor(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  const text = collapse(sql)
  // BOTH forms of the liveness read answer from the SAME sheet table: the gate's pool-level read, and
  // the in-transaction `FOR UPDATE` re-check the write paths take (#5938). A fake that answered only the
  // unlocked form would report every live sheet as absent once inside the transaction, and the control
  // leg ("an authorised caller succeeds on a LIVE sheet") would fail for a fixture reason.
  if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1(?: FOR UPDATE)?$/i.test(text)) {
    const id = params[0]
    if (id === LIVE_SHEET || id === OTHER_LIVE_SHEET) return { rows: [{ deleted_at: null }], rowCount: 1 }
    if (id === DELETED_SHEET) return { rows: [{ deleted_at: '2026-09-01T00:00:00.000Z' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  // The grant/revoke read-back. One row so the control case has something to answer with.
  if (/^SELECT perm_code FROM spreadsheet_permissions/i.test(text)) {
    return { rows: [{ perm_code: 'spreadsheet:read' }], rowCount: 1 }
  }
  if (/^SELECT user_id, perm_code FROM spreadsheet_permissions/i.test(text)) {
    return { rows: [{ user_id: 'u_target_5829', perm_code: 'spreadsheet:read' }], rowCount: 1 }
  }
  // The gate's own, caller-scoped grant read (permission-service loadSheetPermissionScopeMap).
  //
  // Answered the way PostgreSQL would answer THIS statement: the row comes back only if the statement
  // itself admits it — `sp.sheet_id = ANY($2::text[])` must cover the granted sheet and
  // `sp.subject_id = $1` must name the row's subject. A fake that ignored the bind values would hand
  // the gate a state no backend can produce (a grant on a sheet the query never asked about), which
  // would make any assertion resting on it unfalsifiable.
  if (/^SELECT sp\.sheet_id, sp\.perm_code, sp\.subject_type/i.test(text) && sheetAdminGrantOn) {
    const scopedToSheets = /sp\.sheet_id = ANY\(\$2::text\[\]\)/.test(text)
    const askedSheets = Array.isArray(params[1]) ? (params[1] as string[]) : []
    const scopedToSubject = /sp\.subject_id = \$1/.test(text)
    const admitted = (!scopedToSheets || askedSheets.includes(sheetAdminGrantOn))
      && (!scopedToSubject || params[0] === CALLER)
    if (!admitted) return { rows: [], rowCount: 0 }
    return {
      rows: [{ sheet_id: sheetAdminGrantOn, perm_code: 'spreadsheet:admin', subject_type: 'user' }],
      rowCount: 1,
    }
  }
  return { rows: [], rowCount: 0 }
}

const record = async (sql: string, params: unknown[] = []) => {
  const text = collapse(sql)
  sqlLog.push({ sql: text, params })
  if (livenessProbeThrows && /FROM meta_sheets/i.test(text)) {
    throw new Error('gate lookup failed')
  }
  return answerFor(sql, params)
}

const pgMocks = vi.hoisted(() => ({ transaction: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  pool: { query: (sql: string, params?: unknown[]) => record(sql, params ?? []) },
  query: (sql: string, params?: unknown[]) => record(sql, params ?? []),
  transaction: pgMocks.transaction,
}))

// The RBAC tables are not the subject: the caller's codes ride on the session, and the namespace
// admission lookup (which would otherwise need a DB) admits them. `isAdmin` stays FALSE throughout —
// an admin would satisfy canManageSheetAccess by role and prove nothing about the per-sheet gate.
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  userHasPermission: vi.fn().mockResolvedValue(false),
  invalidateUserPerms: vi.fn(),
}))
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }))

import { spreadsheetPermissionsRouter } from '../../src/routes/spreadsheet-permissions'

/** Holds the global rbac code for these routes — and nothing that confers sheet-access management. */
const GLOBAL_CODE_ONLY = ['spreadsheet-permissions:read', 'spreadsheet-permissions:write']
/**
 * The same, plus what deriveCapabilities maps to canManageSheetAccess: `multitable:share` AND
 * `multitable:read` — with no per-sheet assignment, applySheetPermissionScope:1482 keeps
 * canManageSheetAccess only while the actor can also read the sheet.
 */
const SHEET_MANAGER = [...GLOBAL_CODE_ONLY, 'multitable:read', 'multitable:share']

function buildApp(permissions: string[]): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = { id: CALLER, permissions }
    next()
  })
  app.use(spreadsheetPermissionsRouter())
  return app
}

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }

/** Statements this ROUTE issues against the grant table, and the sheet-row lock its writes take. */
const routeOwnStatements = () => sqlLog.filter(({ sql }) => (
  /INSERT INTO spreadsheet_permissions/i.test(sql)
  || /DELETE FROM spreadsheet_permissions/i.test(sql)
  || /FOR UPDATE/i.test(sql)
  || /^SELECT user_id, perm_code FROM spreadsheet_permissions/i.test(sql)
  || /^SELECT perm_code FROM spreadsheet_permissions/i.test(sql)
))

const grantTableWrites = () => sqlLog.filter(({ sql }) => (
  /INSERT INTO spreadsheet_permissions/i.test(sql) || /DELETE FROM spreadsheet_permissions/i.test(sql)
))

const pinned = usePinnedServer()

/** The three routes, each with the call that exercises it. */
const ROUTES = [
  {
    name: 'GET /api/spreadsheets/:id/permissions',
    call: (sheetId: string) => request(pinned.url()).get(`/api/spreadsheets/${sheetId}/permissions`),
    /** The statement that proves the handler body ran. */
    reached: /^SELECT user_id, perm_code FROM spreadsheet_permissions/i,
  },
  {
    name: 'POST /api/spreadsheets/:id/permissions/grant',
    call: (sheetId: string) => request(pinned.url())
      .post(`/api/spreadsheets/${sheetId}/permissions/grant`)
      .send({ userId: 'u_target_5829', permission: 'spreadsheet:read' }),
    reached: /INSERT INTO spreadsheet_permissions/i,
  },
  {
    name: 'POST /api/spreadsheets/:id/permissions/revoke',
    call: (sheetId: string) => request(pinned.url())
      .post(`/api/spreadsheets/${sheetId}/permissions/revoke`)
      .send({ userId: 'u_target_5829', permission: 'spreadsheet:read' }),
    reached: /DELETE FROM spreadsheet_permissions/i,
  },
] as const

describe('legacy spreadsheet-permissions routes — canManageSheetAccess then sheet liveness (#5829)', () => {
  beforeEach(() => {
    sqlLog.length = 0
    livenessProbeThrows = false
    sheetAdminGrantOn = null
    pgMocks.transaction.mockReset()
    pgMocks.transaction.mockImplementation(async (handler: (c: { query: typeof record }) => Promise<unknown>) => (
      handler({ query: record })
    ))
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('the global code alone answers the IDENTICAL 403 on a live, a deleted and an absent sheet, and never touches the grant table', async () => {
        const answers: Array<{ status: number; body: unknown }> = []
        for (const sheetId of [LIVE_SHEET, DELETED_SHEET, ABSENT_SHEET]) {
          sqlLog.length = 0
          pinned.setApp(buildApp(GLOBAL_CODE_ONLY))
          const res = await route.call(sheetId)
          answers.push({ status: res.status, body: res.body })

          // The refusal came from the new sheet gate, not from rbacGuard (whose 403 body is the bare
          // `{ error: 'Insufficient permissions' }`): a green here cannot be the outer guard's.
          expect(res.status, sheetId).toBe(403)
          expect(res.body, sheetId).toEqual(FORBIDDEN_BODY)

          // Nothing of the route's own — no listing, no read-back, no write, no sheet-row lock.
          expect(routeOwnStatements(), `${sheetId}: route statements ran`).toEqual([])
          expect(pgMocks.transaction, sheetId).not.toHaveBeenCalled()
          // …and what the GATE did read of the grant table is scoped to the caller's own subject —
          // asserted on the BOUND VALUE as well as on the text, because a read that said
          // `sp.subject_id = $1` while binding $1 to the TARGET user would match the text and still
          // answer the question about somebody else's grants.
          for (const { sql, params } of sqlLog.filter((s) => /spreadsheet_permissions/i.test(s.sql))) {
            expect(sql, `${sheetId}: unscoped grant-table read`).toMatch(/sp\.subject_id = \$1/)
            expect(params[0], `${sheetId}: grant read bound to another subject`).toBe(CALLER)
            // …and about the sheet the request addressed, not some other one.
            expect(params[1], `${sheetId}: grant read asked about another sheet`).toEqual([sheetId])
          }
        }
        // IDENTICAL, not merely "all 403": one body for all three states, so nothing distinguishes
        // "this sheet exists" from "it was deleted" from "it never existed".
        expect(answers[1]).toEqual(answers[0])
        expect(answers[2]).toEqual(answers[0])
      })

      it('a canManageSheetAccess caller succeeds on a LIVE sheet (control + handler-reached self-check)', async () => {
        pinned.setApp(buildApp(SHEET_MANAGER))
        const res = await route.call(LIVE_SHEET)

        expect(res.status).toBe(200)
        expect(res.body?.ok).toBe(true)
        // SELF-CHECK: the handler body really ran. Without this, the refusal specs above would pass
        // just as well against a route that had been unmounted or renamed.
        expect(
          sqlLog.some(({ sql }) => route.reached.test(sql)),
          `${route.name}: handler never reached — refusal assertions would be vacuous`,
        ).toBe(true)
      })

      it('a canManageSheetAccess caller gets 404 SHEET_DELETED on a soft-deleted sheet, with no write', async () => {
        pinned.setApp(buildApp(SHEET_MANAGER))
        const res = await route.call(DELETED_SHEET)

        expect(res.status).toBe(404)
        expect(res.body?.ok).toBe(false)
        expect(res.body?.error?.code).toBe('SHEET_DELETED')
        // Values-free: the refusal never echoes the id the caller asked about.
        expect(JSON.stringify(res.body)).not.toContain(DELETED_SHEET)
        expect(routeOwnStatements()).toEqual([])
        expect(grantTableWrites()).toEqual([])
        expect(pgMocks.transaction).not.toHaveBeenCalled()
      })

      it('a canManageSheetAccess caller gets 404 NOT_FOUND on an absent sheet, with no write', async () => {
        pinned.setApp(buildApp(SHEET_MANAGER))
        const res = await route.call(ABSENT_SHEET)

        expect(res.status).toBe(404)
        expect(res.body?.ok).toBe(false)
        expect(res.body?.error?.code).toBe('NOT_FOUND')
        expect(res.body?.error?.message).toBe('Sheet not found')
        expect(JSON.stringify(res.body)).not.toContain(ABSENT_SHEET)
        expect(routeOwnStatements()).toEqual([])
        expect(grantTableWrites()).toEqual([])
        expect(pgMocks.transaction).not.toHaveBeenCalled()
      })
    })
  }

  it('authority may come from THIS table: a per-sheet spreadsheet:admin grant, with no global multitable code, passes the gate', async () => {
    sheetAdminGrantOn = LIVE_SHEET
    pinned.setApp(buildApp(GLOBAL_CODE_ONLY))
    const res = await request(pinned.url())
      .post(`/api/spreadsheets/${LIVE_SHEET}/permissions/grant`)
      .send({ userId: 'u_target_5829', permission: 'spreadsheet:read' })

    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)

    // …and the SAME caller, still holding that grant on LIVE_SHEET, is refused on a DIFFERENT live
    // sheet. Both sheets exist, and the grant row is left exactly where it was: the only thing that
    // changes is which sheet the request addresses — a state PostgreSQL can actually be in, unlike
    // "a grant row for a sheet the gate's query never asked about".
    sqlLog.length = 0
    pgMocks.transaction.mockClear()
    const other = await request(pinned.url())
      .post(`/api/spreadsheets/${OTHER_LIVE_SHEET}/permissions/grant`)
      .send({ userId: 'u_target_5829', permission: 'spreadsheet:read' })
    expect(other.status).toBe(403)
    expect(other.body).toEqual(FORBIDDEN_BODY)
    expect(routeOwnStatements()).toEqual([])

    // The gate asked about the ADDRESSED sheet (and about this caller) — not about the sheet the
    // grant happens to be on. A gate that authorised one sheet id and wrote another is exactly the
    // drift the unnormalised pass-through in the route exists to prevent.
    const gateGrantReads = sqlLog.filter(({ sql }) => /^SELECT sp\.sheet_id, sp\.perm_code/i.test(sql))
    expect(gateGrantReads.length, 'the gate never read the grant table').toBeGreaterThan(0)
    for (const { params } of gateGrantReads) {
      expect(params[0]).toBe(CALLER)
      expect(params[1]).toEqual([OTHER_LIVE_SHEET])
    }
  })

  it('the 403 is answered BEFORE the body is validated — an unauthorised caller learns nothing from a bad body either', async () => {
    pinned.setApp(buildApp(GLOBAL_CODE_ONLY))
    // No userId/permission at all: the pre-#5829 order would have answered 400 VALIDATION_ERROR.
    const res = await request(pinned.url())
      .post(`/api/spreadsheets/${LIVE_SHEET}/permissions/grant`)
      .send({})

    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(routeOwnStatements()).toEqual([])
  })

  it('a capability/liveness lookup that throws is FAIL-CLOSED: the same 403, and the table is untouched', async () => {
    livenessProbeThrows = true
    try {
      pinned.setApp(buildApp(SHEET_MANAGER))
      const res = await request(pinned.url())
        .post(`/api/spreadsheets/${LIVE_SHEET}/permissions/grant`)
        .send({ userId: 'u_target_5829', permission: 'spreadsheet:read' })

      // A broken gate answers exactly what a denial answers — so the failure mode is not an oracle
      // either — and it never falls through to the grant table.
      expect(res.status).toBe(403)
      expect(res.body).toEqual(FORBIDDEN_BODY)
      expect(routeOwnStatements()).toEqual([])
      expect(pgMocks.transaction).not.toHaveBeenCalled()
    } finally {
      livenessProbeThrows = false
    }
  })
})
