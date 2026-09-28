/**
 * Config-restore LOSSY retype-revert (preview + execute) requires READ on the sheet.
 *
 * THE GAP (found by two reviewers of #6139 on main): both routes gate the field-revision surface on
 * `canManageFields`, and the lossy branch then gates on `hasFullTableReadAccess`. `canManageFields` is true on
 * `multitable:manage-schema` ALONE (multitable/manage-schema-permission.ts), while `canRead` needs read, write
 * or admin (multitable/access.ts `deriveCapabilities`). `hasFullTableReadAccess` only looked for RESTRICTIONS
 * (row-level deny switch, field masks, formula taint) and never asked whether the actor may read the sheet at
 * all. So a schema manager with no read grant, on an unrestricted sheet, passed both gates: the preview handed
 * it whole-table loss counts and a preview token, the execute ran a whole-table cell transform.
 *
 * THE FIX lives in the primitive (`hasFullTableReadAccess` refuses when `capabilities.canRead` is false), so
 * both routes answer their EXISTING full-read refusal — 403 `FULL_TABLE_READ_REQUIRED` — and so does every
 * other caller. This spec drives the REAL route handlers (mock pool, no DB) and pins, per route:
 *   - the manage-schema-only principal is refused AT the full-read gate (it reached the lossy branch: the
 *     lossy field-row read is in the SQL log), no `meta_records` statement of any kind is issued, no write
 *     statement is issued, and the body carries no counts and no token;
 *   - the control principal (the same grant plus `multitable:read`) keeps its previous behaviour: preview
 *     200 with the loss summary and a token, execute 200 with the rewrite issued.
 * The execute refusal is driven with a token that is VALID for the refused actor (minted with the same claims
 * the preview would have minted for it), so without the fix it would run the transform — see the mutation
 * table in the PR body.
 *
 * Transport: ONE pinned listener for the file (#4154 — `request(app)` is banned in tests/unit).
 */
import express, { type Express } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_lrq'
const BASE_ID = 'base_lrq'
const FIELD_ID = 'fld_lrq_price'
const REVISION_ID = 'rev_lrq_property'
const CONFIRM = 'revert-retype-lossy'

const BASE_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
const LOSSY_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'
const TOUCHED_ENV = [BASE_FLAG, LOSSY_FLAG, 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED', 'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA']

type Principal = { id: string; roles: string[]; perms: string[] }
/** Holds canManageFields and NOTHING on the read plane. */
const SCHEMA_ONLY: Principal = { id: 'u_lrq_schema_only', roles: ['member'], perms: ['multitable:manage-schema'] }
/** The control: the same grant with read added (no write — the lossy path never asked for it). */
const SCHEMA_AND_READ: Principal = { id: 'u_lrq_schema_read', roles: ['member'], perms: ['multitable:read', 'multitable:manage-schema'] }

const FULL_READ_REFUSAL = {
  ok: false,
  error: {
    code: 'FULL_TABLE_READ_REQUIRED',
    message: 'A value-transforming field revert requires unrestricted read access to every record and field of this sheet.',
  },
}

// A property-only field revision on a Batch-1 type (currency): live property {precision:0}, revert restores
// {precision:2}. Same fixture as the real-DB L3 golden, so the same three buckets.
const REVISION = {
  id: REVISION_ID,
  sheet_id: SHEET_ID,
  entity_type: 'field',
  entity_id: FIELD_ID,
  action: 'update',
  before: { property: { precision: 2 } },
  after: { property: { precision: 0 } },
  changed_keys: ['property'],
}
const FIELD = { id: FIELD_ID, sheet_id: SHEET_ID, name: 'Price', type: 'currency', property: { precision: 0 }, order: 0 }
const RECORDS: Array<{ id: string; data: Record<string, unknown> }> = [
  { id: 'rec_lrq_1', data: { [FIELD_ID]: 9 } },
  { id: 'rec_lrq_2', data: { [FIELD_ID]: '12.5' } },
  { id: 'rec_lrq_3', data: { [FIELD_ID]: 'abc' } },
  { id: 'rec_lrq_4', data: { [FIELD_ID]: '' } },
  { id: 'rec_lrq_5', data: { [FIELD_ID]: null } },
  { id: 'rec_lrq_6', data: { other: 1 } }, // no cell for the field: scanned, never bucketed
]
const EXPECTED_SUMMARY = { unchanged: 2, coerced: 1, dropped: 2 }

const RECORD_TABLE = /\bmeta_records\b/i
const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE)\b/i
const LOSSY_FIELD_ROW = 'SELECT id, sheet_id, type FROM meta_fields WHERE id = $1'

// ── mock pool ──────────────────────────────────────────────────────────────────

function createMockPool() {
  const sqlLog: string[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }> => {
    sqlLog.push(sql)
    const p = (i: number) => String(params?.[i] ?? '')

    // No sheet-scoped grants anywhere: the GLOBAL capability derivation is what these cells measure.
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
    if (sql.includes('FROM field_permissions')) return { rows: [] }
    if (sql.includes('FROM record_permissions')) return { rows: [] }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [] }
    if (sql.includes('FROM formula_dependencies')) return { rows: [] }

    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: p(0) === SHEET_ID ? [{ deleted_at: null }] : [] }
    }
    if (sql.includes('row_level_read_permissions_enabled AS enabled')) {
      return { rows: p(0) === SHEET_ID ? [{ enabled: false, base_id: BASE_ID }] : [] }
    }
    if (sql.includes('FROM meta_sheets')) return { rows: [] } // not an approval-projection sheet, etc.

    if (sql.includes('FROM meta_config_revisions WHERE id = $1 AND sheet_id = $2')) {
      return { rows: p(0) === REVISION_ID && p(1) === SHEET_ID ? [{ ...REVISION }] : [] }
    }
    if (/^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql)) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM meta_config_revisions')) return { rows: [] } // type-era guard: no type change since

    if (sql.startsWith(LOSSY_FIELD_ROW)) {
      return { rows: p(0) === FIELD_ID ? [{ id: FIELD.id, sheet_id: FIELD.sheet_id, type: FIELD.type }] : [] }
    }
    if (sql.includes('SELECT name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      return { rows: p(0) === FIELD_ID ? [{ name: FIELD.name, type: FIELD.type, property: FIELD.property, order: FIELD.order }] : [] }
    }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE sheet_id = $1')) {
      return { rows: p(0) === SHEET_ID ? [{ ...FIELD }] : [] }
    }
    if (/^\s*UPDATE\s+meta_fields\b/i.test(sql)) return { rows: [], rowCount: 1 }

    if (sql.includes('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1')) {
      return { rows: [{ c: p(0) === SHEET_ID ? RECORDS.length : 0 }] }
    }
    if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND data ? $2')) {
      return {
        rows: p(0) === SHEET_ID
          ? RECORDS.filter((r) => Object.prototype.hasOwnProperty.call(r.data, p(1))).map((r) => ({ id: r.id, data: { ...r.data } }))
          : [],
      }
    }
    if (/^\s*UPDATE\s+meta_records\s+AS\s+m\b/i.test(sql)) {
      const payload = JSON.parse(String(params?.[2] ?? '[]')) as Array<{ record_id: string }>
      return { rows: payload.map((item) => ({ id: item.record_id, version: 2 })), rowCount: payload.length }
    }
    if (/^\s*INSERT\s+INTO\s+meta_record_revisions\b/i.test(sql)) return { rows: [], rowCount: 1 }

    return { rows: [] }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction, sqlLog }
}

// ── app harness ────────────────────────────────────────────────────────────────

type Harness = {
  app: Express
  pool: ReturnType<typeof createMockPool>
  setActor: (principal: Principal) => void
  mintPreviewToken: (claims: Record<string, unknown>) => string
}

async function buildHarness(): Promise<Harness> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  // Same module instance the router signs/verifies with (imported after the same resetModules).
  const { mintConfigRestorePreviewIdentity } = await import('../../src/multitable/restore-preview-identity')
  const pool = createMockPool()
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  let actor: Principal = SCHEMA_AND_READ
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { ...actor, perms: [...actor.perms], roles: [...actor.roles] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return {
    app,
    pool,
    setActor: (principal) => { actor = principal },
    mintPreviewToken: (claims) => mintConfigRestorePreviewIdentity(claims as any),
  }
}

const pinned = usePinnedServer()

function preview(h: Harness, as: Principal) {
  h.setActor(as)
  pinned.setApp(h.app)
  return request(pinned.url()).post(`/api/multitable/sheets/${SHEET_ID}/config-restore-preview`).send({ revisionId: REVISION_ID })
}

function execute(h: Harness, as: Principal, previewToken: string) {
  h.setActor(as)
  pinned.setApp(h.app)
  return request(pinned.url())
    .post(`/api/multitable/sheets/${SHEET_ID}/config-restore-execute`)
    .send({ revisionId: REVISION_ID, previewToken, confirm: CONFIRM })
}

/** The claims a preview token carries, minus the JWT envelope — re-signable for another actor. */
function claimsOf(token: string): Record<string, unknown> {
  const decoded = jwt.decode(token) as Record<string, unknown> | null
  if (!decoded) throw new Error('control preview token did not decode')
  const { iat: _iat, exp: _exp, type: _type, ...claims } = decoded
  return claims
}

function expectNoLeak(body: unknown) {
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain('lossSummary')
  expect(serialized).not.toContain('previewToken')
  expect(serialized).not.toContain('undisclosed')
  expect(serialized).not.toMatch(/\b(unchanged|coerced|dropped)\b/)
  expect(serialized).not.toMatch(/\d/)
}

function recordStatements(sqlLog: string[]): string[] {
  return sqlLog.filter((sql) => RECORD_TABLE.test(sql))
}

function writeStatements(sqlLog: string[]): string[] {
  return sqlLog.filter((sql) => WRITE_STATEMENT.test(sql))
}

// ── suite ──────────────────────────────────────────────────────────────────────

describe('config-restore lossy retype-revert requires read on the sheet', () => {
  beforeEach(() => {
    for (const key of TOUCHED_ENV) delete process.env[key]
    process.env[BASE_FLAG] = 'true'
    process.env[LOSSY_FLAG] = 'true'
    vi.resetModules()
  })

  afterEach(() => {
    for (const key of TOUCHED_ENV) delete process.env[key]
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe('POST /sheets/:sheetId/config-restore-preview', () => {
    it('multitable:manage-schema alone -> 403 FULL_TABLE_READ_REQUIRED at the full-read gate; no record read, no write, no counts, no token', async () => {
      const h = await buildHarness()
      const res = await preview(h, SCHEMA_ONLY)

      expect(res.status).toBe(403)
      expect(res.body).toEqual(FULL_READ_REFUSAL)
      expectNoLeak(res.body)
      // It passed the canManageFields gate and entered the lossy branch (the lossy field-row read ran), so the
      // refusal above is the FULL-READ gate's, not the generic 403 FORBIDDEN of the capability gate.
      expect(h.pool.sqlLog.some((sql) => sql.startsWith(LOSSY_FIELD_ROW))).toBe(true)
      expect(recordStatements(h.pool.sqlLog)).toEqual([])
      expect(writeStatements(h.pool.sqlLog)).toEqual([])
    })

    it('control: the same grant + multitable:read -> 200 with the loss summary and a preview token (unchanged behaviour)', async () => {
      const h = await buildHarness()
      const res = await preview(h, SCHEMA_AND_READ)

      expect(res.status).toBe(200)
      expect(res.body?.ok).toBe(true)
      expect(res.body?.data?.lossSummary).toEqual(EXPECTED_SUMMARY)
      expect(typeof res.body?.data?.previewToken).toBe('string')
      expect(res.body?.data?.confirm).toBe(CONFIRM)
      expect(recordStatements(h.pool.sqlLog).length).toBeGreaterThan(0)
      expect(writeStatements(h.pool.sqlLog)).toEqual([])
    })
  })

  describe('POST /sheets/:sheetId/config-restore-execute', () => {
    it('multitable:manage-schema alone, holding a token valid for it -> 403 FULL_TABLE_READ_REQUIRED; no record read or write, no counts', async () => {
      const h = await buildHarness()
      const control = await preview(h, SCHEMA_AND_READ)
      expect(control.status).toBe(200)
      // Exactly the token the preview would have minted for SCHEMA_ONLY had it not been refused: the preview's
      // computation is whole-table and actor-independent except for the actorId claim.
      const token = h.mintPreviewToken({ ...claimsOf(control.body.data.previewToken), actorId: SCHEMA_ONLY.id })
      h.pool.sqlLog.length = 0

      const res = await execute(h, SCHEMA_ONLY, token)

      expect(res.status).toBe(403)
      expect(res.body).toEqual(FULL_READ_REFUSAL)
      expectNoLeak(res.body)
      // Refused INSIDE the lossy transaction, at the full-read gate (the locked field-row read ran first).
      expect(h.pool.sqlLog.some((sql) => sql.startsWith(`${LOSSY_FIELD_ROW} FOR UPDATE`))).toBe(true)
      expect(recordStatements(h.pool.sqlLog)).toEqual([])
      expect(writeStatements(h.pool.sqlLog)).toEqual([])
    })

    it('control: the same grant + multitable:read -> 200, the coerced/dropped cells are rewritten (unchanged behaviour)', async () => {
      const h = await buildHarness()
      const p = await preview(h, SCHEMA_AND_READ)
      expect(p.status).toBe(200)
      h.pool.sqlLog.length = 0

      const res = await execute(h, SCHEMA_AND_READ, p.body.data.previewToken)

      expect(res.status).toBe(200)
      expect(res.body?.ok).toBe(true)
      expect(res.body?.data?.lossSummary).toEqual(EXPECTED_SUMMARY)
      expect(res.body?.data?.restored).toMatchObject({ revisionId: REVISION_ID, entityType: 'field', entityId: FIELD_ID })
      const writes = writeStatements(h.pool.sqlLog)
      expect(writes.filter((sql) => /^\s*UPDATE\s+meta_records\b/i.test(sql))).toHaveLength(1)
      expect(writes.filter((sql) => /^\s*INSERT\s+INTO\s+meta_record_revisions\b/i.test(sql))).toHaveLength(
        EXPECTED_SUMMARY.coerced + EXPECTED_SUMMARY.dropped,
      )
      expect(writes.filter((sql) => /^\s*UPDATE\s+meta_fields\b/i.test(sql))).toHaveLength(1)
      expect(writes.filter((sql) => /^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql))).toHaveLength(1)
    })
  })

  describe('the primitive: hasFullTableReadAccess', () => {
    it('refuses a principal with no read plane before any DB access, and admits the same principal once read is added', async () => {
      const { hasFullTableReadAccess } = await import('../../src/routes/univer-meta')
      const { deriveCapabilities } = await import('../../src/multitable/access')
      const pool = createMockPool()
      const access = (principal: Principal) => ({ userId: principal.id, permissions: principal.perms, isAdminRole: false })

      const schemaOnly = deriveCapabilities(SCHEMA_ONLY.perms, false)
      expect(schemaOnly).toMatchObject({ canRead: false, canManageFields: true })
      expect(await hasFullTableReadAccess(undefined, pool.query, SHEET_ID, access(SCHEMA_ONLY), schemaOnly)).toBe(false)
      expect(pool.sqlLog).toEqual([])

      const withRead = deriveCapabilities(SCHEMA_AND_READ.perms, false)
      expect(withRead).toMatchObject({ canRead: true, canManageFields: true })
      expect(await hasFullTableReadAccess(undefined, pool.query, SHEET_ID, access(SCHEMA_AND_READ), withRead)).toBe(true)
    })
  })
})
