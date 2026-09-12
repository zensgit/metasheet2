/**
 * Managed-sheet SCHEMA-WRITE gate — the no-DB half (mock pool, REAL express app, REAL
 * `univerMetaRouter`, REAL permission service).
 *
 * The real-Postgres goldens live in
 * tests/integration/multitable-managed-sheet-schema-write-gate.db.test.ts (wired into
 * .github/workflows/managed-sheet-schema-write-gate-realdb.yml). THIS file exists so the same
 * verdicts are provable on a machine without Postgres and so the guard has a fast mutation surface:
 * capabilities are never stubbed here either — the actor's authority is derived by the shipped
 * `resolveSheetCapabilities` chain from the rows the mock pool answers.
 *
 * §1 route cells   — POST/PATCH/DELETE `/fields` on a plugin-managed sheet vs an ordinary one, for a
 *                    sheet-scoped writer, a global `multitable:manage-schema` holder, and an admin.
 *                    Every DENIED cell asserts the exact FORBIDDEN body AND that the in-memory
 *                    `meta_fields` table is unchanged in SIZE and that no field-writing SQL was
 *                    issued at all (the route refused BEFORE the transaction).
 * §2 capability layer — the fence itself through the real `resolveSheetCapabilitiesForAccess`:
 *                    which bit drops, which bits must NOT drop (the data plane), admin exemption,
 *                    and fail-closed on a registry lookup that throws.
 * §3 pure function  — `restrictManagedSheetSchemaWriteCapabilities` truth table.
 *
 * TRANSPORT: one pinned listener per file, app swapped per test (#4154 — `request(app)` is banned
 * under tests/unit by tests/unit/supertest-app-mode-tripwire.test.ts).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  isPluginManagedSheetFailClosed,
  restrictManagedSheetSchemaWriteCapabilities,
} from '../../src/multitable/managed-sheet-schema-write-guard'
import { resolveSheetCapabilitiesForAccess, type QueryFn } from '../../src/multitable/permission-service'
import { usePinnedServer } from '../utils/pinned-server'

const MANAGED_SHEET_ID = 'sheet_mgw_managed'
const PLAIN_SHEET_ID = 'sheet_mgw_plain'
const BASE_ID = 'base_mgw'
const MANAGED_FIELD_ID = 'fld_mgw_managed'
const PLAIN_FIELD_ID = 'fld_mgw_plain'

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }

type Actor = { id: string; roles: string[]; perms: string[] }

/** Sheet-scoped full write and nothing else — the tier `applyContextSheetSchemaWriteGrant` promotes. */
const WRITER: Actor = { id: 'u_mgw_writer', roles: ['member'], perms: [] }
/** A non-admin who holds the GLOBAL schema code: also fenced on managed sheets (documented collateral). */
const GLOBAL_SCHEMA: Actor = {
  id: 'u_mgw_schema',
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'],
}
const ADMIN: Actor = { id: 'u_mgw_admin', roles: ['admin'], perms: [] }
const GLOBAL_READ_WRITE: Actor = { id: 'u_mgw_global_rw', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const VIEW_ID = 'view_mgw_managed'

// ── mock pool ──────────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }
type Field = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }

function freshFields(): Map<string, Field> {
  return new Map<string, Field>([
    [MANAGED_FIELD_ID, { id: MANAGED_FIELD_ID, sheet_id: MANAGED_SHEET_ID, name: 'Template column', type: 'string', property: {}, order: 0 }],
    [PLAIN_FIELD_ID, { id: PLAIN_FIELD_ID, sheet_id: PLAIN_SHEET_ID, name: 'Ordinary column', type: 'string', property: {}, order: 0 }],
  ])
}

const SHEET_IDS = [MANAGED_SHEET_ID, PLAIN_SHEET_ID]

/** SQL that would change the column set. A denied cell must issue NONE of it. */
const FIELD_WRITE_SQL = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+meta_fields\b/i
const RECORD_WRITE_SQL = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+meta_records\b/i
type MockPoolOptions = {
  throwOnRegistry?: boolean
  deleteOnTransaction?: boolean
  collideOnSheetInsert?: boolean
  missingPermissionTable?: 'always' | 'transaction'
  failSavepointRollback?: boolean
}

function createMockPool(fields: Map<string, Field>, scopedWriterCodes: string[], options: MockPoolOptions = {}) {
  const sqlLog: string[] = []
  const sheets = new Map(SHEET_IDS.map((id) => [id, { id, base_id: BASE_ID, name: id, description: null, deleted_at: null as string | null }]))
  const records = new Map<string, { id: string; sheet_id: string; data: Record<string, unknown>; version: number }>()
  let inTransaction = false
  let transactionAborted = false
  let capabilitySavepoint = false
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    sqlLog.push(sql)
    const p = (i: number) => String(params?.[i] ?? '')

    // PostgreSQL errors poison a transaction even when the permission loader catches them.
    // Only ROLLBACK TO an existing savepoint repairs that state; a successful empty-result fake
    // would otherwise incorrectly endorse optional-table fallback inside the new seed transaction.
    if (/^ROLLBACK TO SAVEPOINT seed_capability_probe$/i.test(sql.trim())) {
      if (!capabilitySavepoint || options.failSavepointRollback) throw new Error('savepoint recovery failed')
      transactionAborted = false
      return { rows: [] }
    }
    if (inTransaction && transactionAborted) {
      throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' })
    }
    if (/^SAVEPOINT seed_capability_probe$/i.test(sql.trim())) {
      if (!inTransaction) throw new Error('SAVEPOINT outside transaction')
      capabilitySavepoint = true
      return { rows: [] }
    }
    if (/^RELEASE SAVEPOINT seed_capability_probe$/i.test(sql.trim())) {
      if (!capabilitySavepoint) throw new Error('no such savepoint')
      capabilitySavepoint = false
      return { rows: [] }
    }

    // The managed-sheet signal — the same registry row the sheet-delete refusal reads.
    if (sql.includes('FROM plugin_multitable_object_registry')) {
      if (options.throwOnRegistry) throw new Error('registry unavailable')
      return { rows: p(0) === MANAGED_SHEET_ID ? [{ '?column?': 1 }] : [] }
    }
    // Sheet-scoped grants: only the writer holds any, and it holds them on BOTH sheets, so the
    // managed/ordinary difference cannot come from the grant.
    if (sql.includes('FROM spreadsheet_permissions')) {
      if (options.missingPermissionTable === 'always' || (inTransaction && options.missingPermissionTable === 'transaction')) {
        if (inTransaction) transactionAborted = true
        throw Object.assign(new Error('relation "platform_member_group_members" does not exist'), { code: '42P01' })
      }
      const userId = p(0)
      if (userId !== WRITER.id) return { rows: [] }
      const requested = Array.isArray(params?.[1]) ? (params?.[1] as unknown[]).map(String) : []
      return {
        rows: requested.flatMap((sheetId) =>
          scopedWriterCodes.map((code) => ({ sheet_id: sheetId, perm_code: code, subject_type: 'user' })),
        ),
      }
    }
    // approval-projection read guard — neither sheet belongs to the projection base
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }

    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      const sheet = sheets.get(p(0))
      return { rows: sheet && !sheet.deleted_at ? [{ id: p(0) }] : [] }
    }
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      const sheet = sheets.get(p(0))
      return { rows: sheet ? [{ deleted_at: sheet.deleted_at }] : [] }
    }
    if (/FROM meta_sheets\b/.test(sql) && sql.includes('WHERE id = $1')) {
      const sheet = sheets.get(p(0))
      return { rows: sheet ? [{ ...sheet }] : [] }
    }
    if (/^\s*INSERT\s+INTO\s+meta_sheets\b/i.test(sql)) {
      if (sheets.has(p(0)) || options.collideOnSheetInsert) return { rows: [], rowCount: 0 }
      sheets.set(p(0), { id: p(0), base_id: p(1), name: p(2), description: null, deleted_at: null })
      return { rows: sql.includes('RETURNING id') ? [{ id: p(0) }] : [], rowCount: 1 }
    }
    if (/FROM meta_bases\b/.test(sql)) return { rows: [{ id: BASE_ID, owner_id: WRITER.id }] }
    if (/FROM meta_views\b/.test(sql) && sql.includes('WHERE id = $1')) {
      return { rows: p(0) === VIEW_ID ? [{ id: VIEW_ID, sheet_id: MANAGED_SHEET_ID, name: 'Managed grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }] : [] }
    }
    if (/^\s*INSERT\s+INTO\s+meta_records\b/i.test(sql)) {
      records.set(p(0), { id: p(0), sheet_id: p(1), data: JSON.parse(p(2)), version: Number(params?.[3] ?? 1) })
      return { rows: [], rowCount: 1 }
    }
    if (/FROM meta_records\b/.test(sql) && sql.includes('WHERE sheet_id = $1')) {
      return { rows: [...records.values()].filter((record) => record.sheet_id === p(0)) }
    }

    if (/^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql)) return { rows: [], rowCount: 0 }

    if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
      const rows = Array.from(fields.values()).filter((f) => f.sheet_id === p(0))
      return { rows: [{ max_order: rows.length ? Math.max(...rows.map((f) => f.order)) : -1 }] }
    }
    if (/^\s*INSERT\s+INTO\s+meta_fields\b/i.test(sql)) {
      const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      fields.set(id, { id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order })
      return { rows: [{ id, name, type, property: JSON.parse(propertyJson), order }] }
    }
    if (/^\s*UPDATE\s+meta_fields\b/i.test(sql)) return { rows: [] }
    if (/^\s*DELETE\s+FROM\s+meta_fields\b/i.test(sql)) {
      fields.delete(p(0))
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      const f = fields.get(p(0))
      return { rows: f ? [{ id: f.id, sheet_id: f.sheet_id }] : [] }
    }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE id = $1')) {
      const f = fields.get(p(0))
      return { rows: f ? [{ ...f }] : [] }
    }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE sheet_id = $1')) {
      return { rows: Array.from(fields.values()).filter((f) => f.sheet_id === p(0)).map((f) => ({ ...f })) }
    }

    // Anything else (field/view/record permission scopes, e-learning projection map, caches):
    // an empty result cannot make a cell pass by accident — every cell asserts an EXACT status and
    // a denied cell additionally asserts the exact FORBIDDEN body.
    return { rows: [] }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => {
    if (options.deleteOnTransaction) sheets.get(PLAIN_SHEET_ID)!.deleted_at = '2026-09-12T00:00:00Z'
    inTransaction = true
    try {
      return await fn({ query })
    } finally {
      inTransaction = false
      transactionAborted = false
      capabilitySavepoint = false
    }
  })
  return { query, transaction, sqlLog, records, sheets }
}

// ── app harness ────────────────────────────────────────────────────────────────

async function buildApp(
  actor: Actor,
  fields: Map<string, Field>,
  scopedWriterCodes: string[] = ['spreadsheet:write'],
  options: MockPoolOptions = {},
): Promise<{ app: Express; pool: ReturnType<typeof createMockPool> }> {
  // MUST come before doMock: §2/§3 import the permission service statically, so without a reset the
  // dynamic import below would hand back the already-loaded graph and the REAL rbac service with it
  // (which then tries to reach a live Postgres and the cell fails for the wrong reason).
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const pool = createMockPool(fields, scopedWriterCodes, options)
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { ...actor }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, pool }
}

const pinned = usePinnedServer()
function on(app: Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

// Pay the one-off cost of transforming the route module (routes/univer-meta.ts is ~19k lines) in a
// hook with its own budget, so the FIRST cell is not timed against module compilation.
beforeAll(async () => {
  vi.resetModules()
  await import('../../src/routes/univer-meta')
}, 180_000)

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

// ── §1 route cells ─────────────────────────────────────────────────────────────

describe('§1 schema routes on a plugin-managed sheet (real router, real permission service)', () => {
  it('sheet-scoped writer × MANAGED sheet: POST /fields → 403, table size unchanged, no field-writing SQL', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(WRITER, fields)
    const before = fields.size
    const res = await on(app)
      .post('/api/multitable/fields')
      .send({ sheetId: MANAGED_SHEET_ID, name: 'Template column', type: 'string' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(fields.size).toBe(before)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('sheet-scoped writer × MANAGED sheet: PATCH /fields/:id → 403, definition unchanged, no field-writing SQL', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(WRITER, fields)
    const res = await on(app)
      .patch(`/api/multitable/fields/${MANAGED_FIELD_ID}`)
      .send({ name: 'Renamed by operator', type: 'number' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(fields.get(MANAGED_FIELD_ID)).toEqual({
      id: MANAGED_FIELD_ID, sheet_id: MANAGED_SHEET_ID, name: 'Template column', type: 'string', property: {}, order: 0,
    })
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('sheet-scoped writer × MANAGED sheet: DELETE /fields/:id → 403, field still present, no field-writing SQL', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(WRITER, fields)
    const res = await on(app).delete(`/api/multitable/fields/${MANAGED_FIELD_ID}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(fields.has(MANAGED_FIELD_ID)).toBe(true)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('global multitable:manage-schema holder (non-admin) × MANAGED sheet: POST /fields → 403 (documented collateral)', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(GLOBAL_SCHEMA, fields)
    const before = fields.size
    const res = await on(app)
      .post('/api/multitable/fields')
      .send({ sheetId: MANAGED_SHEET_ID, name: 'Schema holder column', type: 'string' })
    expect(res.status).toBe(403)
    expect(fields.size).toBe(before)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('POSITIVE CONTROL — sheet-scoped writer × ORDINARY sheet: POST /fields → 201, exactly one row added', async () => {
    const fields = freshFields()
    const { app } = await buildApp(WRITER, fields)
    const before = fields.size
    const res = await on(app)
      .post('/api/multitable/fields')
      .send({ sheetId: PLAIN_SHEET_ID, name: 'Writer column', type: 'string' })
    expect(res.status).toBe(201)
    expect(fields.size).toBe(before + 1)
  })

  it('POSITIVE CONTROL — ADMIN × MANAGED sheet: POST /fields → 201, exactly one row added (repair path open)', async () => {
    const fields = freshFields()
    const { app } = await buildApp(ADMIN, fields)
    const before = fields.size
    const res = await on(app)
      .post('/api/multitable/fields')
      .send({ sheetId: MANAGED_SHEET_ID, name: 'Admin column', type: 'string' })
    expect(res.status).toBe(201)
    expect(fields.size).toBe(before + 1)
  })
})

// ── §2 capability layer ────────────────────────────────────────────────────────

describe('seed writes use the real schema gate, including GET /view aliases', () => {
  it.each([
    { label: 'managed sheet-scoped writer', actor: WRITER, codes: ['spreadsheet:write'], query: { sheetId: MANAGED_SHEET_ID } },
    { label: 'managed sheet-scoped reader', actor: WRITER, codes: ['spreadsheet:read'], query: { sheetId: MANAGED_SHEET_ID } },
    { label: 'managed global schema holder', actor: GLOBAL_SCHEMA, codes: [], query: { sheetId: MANAGED_SHEET_ID } },
    { label: 'ordinary sheet-scoped reader', actor: WRITER, codes: ['spreadsheet:read'], query: { sheetId: PLAIN_SHEET_ID } },
    { label: 'managed real viewId alias', actor: WRITER, codes: ['spreadsheet:write'], query: { viewId: VIEW_ID } },
    { label: 'managed unknown viewId fallback to sheetId', actor: WRITER, codes: ['spreadsheet:write'], query: { viewId: MANAGED_SHEET_ID } },
  ])('$label: refuses before ANY field or record write', async ({ actor, codes, query }) => {
    const fields = freshFields()
    const { app, pool } = await buildApp(actor, fields, codes)
    const beforeFields = [...fields.entries()]
    const beforeRecords = [...pool.records.entries()]
    const res = await on(app).get('/api/multitable/view').query({ ...query, seed: 'true' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect([...fields.entries()]).toEqual(beforeFields)
    expect([...pool.records.entries()]).toEqual(beforeRecords)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql) || RECORD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('registry failure cannot open GET seed on an ordinary sheet', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(WRITER, fields, ['spreadsheet:write'], { throwOnRegistry: true })
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET_ID, seed: 'true' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(fields.size).toBe(before)
    expect(pool.records.size).toBe(0)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql) || RECORD_WRITE_SQL.test(sql))).toEqual([])
  })

  it.each([
    { label: 'ordinary scoped writer', actor: WRITER, sheetId: PLAIN_SHEET_ID },
    { label: 'managed admin repair', actor: ADMIN, sheetId: MANAGED_SHEET_ID },
  ])('POSITIVE CONTROL — $label seeds six fields and five records', async ({ actor, sheetId }) => {
    const fields = freshFields()
    const { app, pool } = await buildApp(actor, fields)
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId, seed: 'true' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(fields.size).toBe(before + 6)
    expect(pool.records.size).toBe(5)
    expect(res.body.data.rows).toHaveLength(5)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql))).toHaveLength(6)
    expect(pool.sqlLog.filter((sql) => RECORD_WRITE_SQL.test(sql))).toHaveLength(5)
    expect(pool.sqlLog.some((sql) => /SELECT id FROM meta_sheets WHERE id = \$1 FOR UPDATE/.test(sql))).toBe(true)
  })

  it('POSITIVE CONTROL — new GET seed preserves first-touch behavior without global schema permission', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(GLOBAL_READ_WRITE, fields, [])
    const before = fields.size
    const sheetId = 'sheet_mgw_new_get'
    const res = await on(app).get('/api/multitable/view').query({ sheetId, seed: 'true' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(pool.sheets.has(sheetId)).toBe(true)
    expect(fields.size).toBe(before + 6)
    expect(pool.records.size).toBe(5)
  })

  it('POSITIVE CONTROL — POST new sheet seed stays in its caller-selected base transaction', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(WRITER, fields)
    const before = fields.size
    const sheetId = 'sheet_mgw_new_post'
    const res = await on(app).post('/api/multitable/sheets').send({ id: sheetId, baseId: BASE_ID, name: 'New owned sheet', seed: true })
    expect(res.status).toBe(200)
    expect(res.body.data.sheet).toMatchObject({ id: sheetId, baseId: BASE_ID, seeded: true })
    expect(pool.sheets.get(sheetId)?.base_id).toBe(BASE_ID)
    expect(pool.transaction).toHaveBeenCalledTimes(1)
    expect(fields.size).toBe(before + 6)
    expect(pool.records.size).toBe(5)
  })

  it('a sheet deleted after the outer read is not seeded inside the transaction', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(WRITER, fields, ['spreadsheet:write'], { deleteOnTransaction: true })
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET_ID, seed: 'true' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('SHEET_DELETED')
    expect(fields.size).toBe(before)
    expect(pool.records.size).toBe(0)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql) || RECORD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('a concurrent creator winning the initially absent id yields 409 and no field/record writes', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(GLOBAL_READ_WRITE, fields, [], { collideOnSheetInsert: true })
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId: 'sheet_mgw_insert_race', seed: 'true' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
    expect(pool.sqlLog.some((sql) => /^\s*INSERT\s+INTO\s+meta_sheets\b/i.test(sql))).toBe(true)
    expect(fields.size).toBe(before)
    expect(pool.records.size).toBe(0)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql) || RECORD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('optional permission table absence does not poison an authorized admin seed transaction', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(ADMIN, fields, [], { missingPermissionTable: 'always' })
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET_ID, seed: 'true' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(fields.size).toBe(before + 6)
    expect(pool.records.size).toBe(5)
    expect(pool.sqlLog).toContain('ROLLBACK TO SAVEPOINT seed_capability_probe')
    expect(pool.sqlLog).toContain('RELEASE SAVEPOINT seed_capability_probe')
  })

  it('optional-table fallback inside the transaction grants no authority to a caller without global permissions', async () => {
    const fields = freshFields()
    // The route sees the earlier scoped grant. Its absence in the transaction must not retain it.
    const { app, pool } = await buildApp(WRITER, fields, ['spreadsheet:write'], { missingPermissionTable: 'transaction' })
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET_ID, seed: 'true' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(pool.sqlLog).toContain('ROLLBACK TO SAVEPOINT seed_capability_probe')
    expect(fields.size).toBe(before)
    expect(pool.records.size).toBe(0)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql) || RECORD_WRITE_SQL.test(sql))).toEqual([])
  })

  it('failed savepoint cleanup aborts even an admin seed without any field or record write', async () => {
    const fields = freshFields()
    const { app, pool } = await buildApp(ADMIN, fields, [], { missingPermissionTable: 'always', failSavepointRollback: true })
    const before = fields.size
    const res = await on(app).get('/api/multitable/view').query({ sheetId: PLAIN_SHEET_ID, seed: 'true' })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
    expect(pool.sqlLog).toContain('ROLLBACK TO SAVEPOINT seed_capability_probe')
    expect(fields.size).toBe(before)
    expect(pool.records.size).toBe(0)
    expect(pool.sqlLog.filter((sql) => FIELD_WRITE_SQL.test(sql) || RECORD_WRITE_SQL.test(sql))).toEqual([])
  })
})

type CapQueryOpts = { managed: boolean; throwOnRegistry?: boolean }

function capabilityQuery(opts: CapQueryOpts): QueryFn {
  return (async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM plugin_multitable_object_registry')) {
      if (opts.throwOnRegistry) throw Object.assign(new Error('relation "plugin_multitable_object_registry" does not exist'), { code: '42P01' })
      return { rows: opts.managed ? [{ '?column?': 1 }] : [] }
    }
    if (sql.includes('FROM spreadsheet_permissions')) {
      const requested = Array.isArray(params?.[1]) ? (params?.[1] as unknown[]).map(String) : []
      return { rows: requested.map((sheetId) => ({ sheet_id: sheetId, perm_code: 'spreadsheet:write', subject_type: 'user' })) }
    }
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) return { rows: [{ deleted_at: null }] }
    return { rows: [] }
  }) as QueryFn
}

const writerAccess = { userId: WRITER.id, permissions: [] as string[], isAdminRole: false }
const adminAccess = { userId: ADMIN.id, permissions: [] as string[], isAdminRole: true }

describe('§2 capability layer — resolveSheetCapabilitiesForAccess (the real resolver)', () => {
  it('MANAGED sheet, non-admin: canManageFields drops to false', async () => {
    const resolved = await resolveSheetCapabilitiesForAccess(capabilityQuery({ managed: true }), MANAGED_SHEET_ID, writerAccess)
    expect(resolved.capabilities.canManageFields).toBe(false)
  })

  it('MANAGED sheet, non-admin: the DATA plane and view management are NOT touched', async () => {
    const resolved = await resolveSheetCapabilitiesForAccess(capabilityQuery({ managed: true }), MANAGED_SHEET_ID, writerAccess)
    expect({
      canRead: resolved.capabilities.canRead,
      canCreateRecord: resolved.capabilities.canCreateRecord,
      canEditRecord: resolved.capabilities.canEditRecord,
      canDeleteRecord: resolved.capabilities.canDeleteRecord,
      canManageViews: resolved.capabilities.canManageViews,
    }).toEqual({ canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageViews: true })
  })

  it('ORDINARY sheet, same actor and same grant: canManageFields stays true', async () => {
    const resolved = await resolveSheetCapabilitiesForAccess(capabilityQuery({ managed: false }), PLAIN_SHEET_ID, writerAccess)
    expect(resolved.capabilities.canManageFields).toBe(true)
  })

  it('MANAGED sheet, ADMIN: canManageFields stays true (admin exemption, as in the approval projection fence)', async () => {
    const resolved = await resolveSheetCapabilitiesForAccess(capabilityQuery({ managed: true }), MANAGED_SHEET_ID, adminAccess)
    expect(resolved.capabilities.canManageFields).toBe(true)
  })

  it('FAIL-CLOSED — registry lookup throws: a non-admin loses canManageFields and the request is not failed', async () => {
    const resolved = await resolveSheetCapabilitiesForAccess(
      capabilityQuery({ managed: false, throwOnRegistry: true }),
      PLAIN_SHEET_ID,
      writerAccess,
    )
    expect(resolved.capabilities.canManageFields).toBe(false)
    // Narrowing only — an unreadable registry must not take the data plane down with it.
    expect(resolved.capabilities.canEditRecord).toBe(true)
  })

  it('the registry is not queried at all when there is nothing to narrow (admin, and non-admin without the bit)', async () => {
    const adminSeen: string[] = []
    const adminQuery = (async (sql: string, params?: unknown[]) => {
      adminSeen.push(sql)
      return capabilityQuery({ managed: true })(sql, params)
    }) as QueryFn
    await resolveSheetCapabilitiesForAccess(adminQuery, MANAGED_SHEET_ID, adminAccess)
    expect(adminSeen.filter((sql) => sql.includes('FROM plugin_multitable_object_registry'))).toEqual([])

    const readerSeen: string[] = []
    const readerQuery = (async (sql: string, params?: unknown[]) => {
      readerSeen.push(sql)
      if (sql.includes('FROM spreadsheet_permissions')) {
        const requested = Array.isArray(params?.[1]) ? (params?.[1] as unknown[]).map(String) : []
        return { rows: requested.map((sheetId) => ({ sheet_id: sheetId, perm_code: 'spreadsheet:read', subject_type: 'user' })) }
      }
      return capabilityQuery({ managed: true })(sql, params)
    }) as QueryFn
    const reader = await resolveSheetCapabilitiesForAccess(readerQuery, MANAGED_SHEET_ID, writerAccess)
    expect(reader.capabilities.canManageFields).toBe(false)
    expect(readerSeen.filter((sql) => sql.includes('FROM plugin_multitable_object_registry'))).toEqual([])
  })
})

// ── §3 pure function ───────────────────────────────────────────────────────────

describe('§3 restrictManagedSheetSchemaWriteCapabilities / isPluginManagedSheetFailClosed', () => {
  const caps = { canManageFields: true, canEditRecord: true }

  it('managed + non-admin → the bit drops, nothing else changes', () => {
    expect(restrictManagedSheetSchemaWriteCapabilities(caps, true, false)).toEqual({ canManageFields: false, canEditRecord: true })
  })

  it('managed + admin → unchanged (same object identity: no copy, no drift)', () => {
    expect(restrictManagedSheetSchemaWriteCapabilities(caps, true, true)).toBe(caps)
  })

  it('not managed → unchanged for both roles', () => {
    expect(restrictManagedSheetSchemaWriteCapabilities(caps, false, false)).toBe(caps)
    expect(restrictManagedSheetSchemaWriteCapabilities(caps, false, true)).toBe(caps)
  })

  it('isPluginManagedSheetFailClosed: registry row → true, no row → false, thrown lookup → true', async () => {
    const withRow = (async () => ({ rows: [{ '?column?': 1 }] })) as unknown as Parameters<typeof isPluginManagedSheetFailClosed>[0]
    const withoutRow = (async () => ({ rows: [] })) as unknown as Parameters<typeof isPluginManagedSheetFailClosed>[0]
    const throwing = (async () => { throw new Error('registry unavailable') }) as unknown as Parameters<typeof isPluginManagedSheetFailClosed>[0]
    expect(await isPluginManagedSheetFailClosed(withRow, MANAGED_SHEET_ID)).toBe(true)
    expect(await isPluginManagedSheetFailClosed(withoutRow, MANAGED_SHEET_ID)).toBe(false)
    expect(await isPluginManagedSheetFailClosed(throwing, MANAGED_SHEET_ID)).toBe(true)
  })
})
