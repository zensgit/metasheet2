/**
 * `PATCH /fields/:fieldId` lost-update guard (src/multitable/field-row-write-guard.ts) — DB-free.
 *
 * Pure: `fieldRowChangedSince` flips on name, type and property, never on `order`, never on property key order; the
 * snapshot is a deep copy.
 *
 * Route (mocked pool, pinned server): a scenario mock answers the route's first read and its late locked re-read
 * separately, so a "concurrent commit" can land between them:
 *   W-1 the late re-read runs AFTER the sibling order shift (and its revisions) and BEFORE the UPDATE;
 *   W-2 a change on the first attempt → the whole transaction runs again → 200, the concurrent change carried;
 *   W-3 a change on both attempts → 409 FIELD_CHANGED_CONCURRENTLY, values-free; no UPDATE, no config revision;
 *   W-4 the row gone at the late re-read → 404 (was a 500 'Update returned no rows');
 *   W-5 a PATCH without `order` takes its order from the locked row, and its config revision does not claim a move;
 *   G-1a/G-1b only a concurrent field change is retried: a statement timeout (57014) at the late re-read or a unique
 *       violation (23505) at the UPDATE runs ONE transaction, so a PATCH parked on the row lock waits at most one
 *       statement timeout and a failure never runs the whole transaction twice;
 *   G-2 the per-attempt reset: a rolled-back attempt's bulk-recompute snapshot does not leak into the committed attempt.
 * The real-Postgres interleavings live in tests/integration/multitable-field-row-concurrency-realdb.cases.ts and
 * tests/integration/stock-preparation-field-property-race-realdb.cases.ts.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FIELD_CHANGED_CONCURRENTLY_CODE,
  FIELD_CHANGED_CONCURRENTLY_MESSAGE,
  PATCH_FIELD_LOCKED_REREAD_SQL,
  PATCH_FIELD_MAX_ATTEMPTS,
  PATCH_FIELD_READ_SQL,
  fieldRowChangedSince,
  snapshotFieldRowForRecheck,
} from '../../src/multitable/field-row-write-guard'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_frwg_1'
const FIELD_ID = 'fld_frwg_secret_id'
const FIELD_NAME = 'Secret column name'
// The route's expression-change bulk-recompute snapshot read (the live record ids, taken inside the transaction).
const BULK_RECOMPUTE_SNAPSHOT_SQL = 'SELECT id FROM meta_records WHERE sheet_id = $1 ORDER BY id ASC'

type Row = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }
type QueryResult = { rows: unknown[]; rowCount?: number }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
// Postgres jsonb returns object keys shorter-first, then bytewise; the mock stores properties the same way so a
// read-back compares like the real one (the revision diff compares serialized values).
const jsonbOrder = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0)))

describe('fieldRowChangedSince / snapshotFieldRowForRecheck (pure)', () => {
  const base = { name: 'A', type: 'string', property: { x: 1, nested: { y: [1, 2] } }, order: 3 }

  it('name, type and property each flip it; order does not', () => {
    const snap = snapshotFieldRowForRecheck(base)
    expect(fieldRowChangedSince(snap, { ...base })).toBe(false)
    expect(fieldRowChangedSince(snap, { ...base, order: 9 })).toBe(false)
    expect(fieldRowChangedSince(snap, { ...base, name: 'B' })).toBe(true)
    expect(fieldRowChangedSince(snap, { ...base, type: 'number' })).toBe(true)
    expect(fieldRowChangedSince(snap, { ...base, property: { x: 1, nested: { y: [1, 2] }, switch: 'disabled' } })).toBe(true)
    expect(fieldRowChangedSince(snap, { ...base, property: { x: 1, nested: { y: [2, 1] } } })).toBe(true)
  })

  it('key order of the parsed property does not count as a change; SQL NULL equals JSON null', () => {
    const snap = snapshotFieldRowForRecheck(base)
    expect(fieldRowChangedSince(snap, { ...base, property: { nested: { y: [1, 2] }, x: 1 } })).toBe(false)
    const nullSnap = snapshotFieldRowForRecheck({ name: 'A', type: 'string', property: null })
    expect(fieldRowChangedSince(nullSnap, { name: 'A', type: 'string', property: null })).toBe(false)
    expect(fieldRowChangedSince(nullSnap, { name: 'A', type: 'string', property: {} })).toBe(true)
  })

  it('the type compare is the raw stored string (no alias mapping)', () => {
    const snap = snapshotFieldRowForRecheck({ name: 'A', type: 'longtext', property: {} })
    expect(fieldRowChangedSince(snap, { name: 'A', type: 'longText', property: {} })).toBe(true)
  })

  it('the snapshot is a deep copy: mutating the read row afterwards is not a concurrent change', () => {
    const row = clone(base)
    const snap = snapshotFieldRowForRecheck(row)
    row.property.nested.y.push(3)
    ;(row.property as Record<string, unknown>).x = 2
    expect(fieldRowChangedSince(snap, base)).toBe(false)
  })

  it('the locked re-read is the first read plus the row lock (same column list); two attempts at most', () => {
    expect(PATCH_FIELD_READ_SQL).toBe('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')
    expect(PATCH_FIELD_LOCKED_REREAD_SQL).toBe(`${PATCH_FIELD_READ_SQL} FOR NO KEY UPDATE`)
    expect(PATCH_FIELD_MAX_ATTEMPTS).toBe(2)
  })
})

/**
 * A scenario mock of the field row. `beforeLateReread(attempt, current)` runs right before the route's locked re-read
 * and may "commit" a concurrent change (return the new row) or delete the row (return null). `failAt` makes every
 * statement it matches throw a pg-shaped error with that SQLSTATE `code` (recorded first, so the attempt is countable).
 * `records` answers the expression-change bulk-recompute snapshot read.
 */
function createScenario(opts: {
  first: Row
  beforeLateReread?: (attempt: number, current: Row) => Row | null
  shifted?: Array<{ id: string; order: number }>
  failAt?: { sql: (s: string) => boolean; code: string }
  records?: string[]
}) {
  let row: Row | null = { ...clone(opts.first), property: jsonbOrder(clone(opts.first.property)) }
  let attempt = 0
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const handler = (rawSql: string, params: unknown[] = []): QueryResult => {
    const sql = normalize(rawSql)
    statements.push({ sql, params })
    if (opts.failAt && opts.failAt.sql(sql)) throw Object.assign(new Error('injected'), { code: opts.failAt.code })
    if (sql === 'SELECT id, sheet_id FROM meta_fields WHERE id = $1') return { rows: row ? [{ id: row.id, sheet_id: row.sheet_id }] : [] }
    if (sql === PATCH_FIELD_LOCKED_REREAD_SQL) {
      if (opts.beforeLateReread && row) {
        const next: Row | null = opts.beforeLateReread(attempt, clone(row))
        row = next ? { ...next, property: jsonbOrder(next.property) } : null
      }
      return { rows: row ? [clone(row)] : [] }
    }
    if (sql === PATCH_FIELD_READ_SQL) {
      attempt += 1
      return { rows: row ? [clone(row)] : [] }
    }
    if (sql.startsWith('UPDATE meta_fields SET "order" = "order"')) {
      return { rows: clone(opts.shifted ?? []), rowCount: (opts.shifted ?? []).length }
    }
    if (sql === BULK_RECOMPUTE_SNAPSHOT_SQL) {
      return { rows: (opts.records ?? []).map((id) => ({ id })), rowCount: (opts.records ?? []).length }
    }
    if (sql.startsWith('UPDATE meta_fields SET name = $2')) {
      if (!row) return { rows: [] }
      const [, name, type, propertyJson, order] = params as [string, string, string, string, number]
      row = { ...row, name, type, property: jsonbOrder(JSON.parse(propertyJson)), order }
      return { rows: [{ id: row.id, name: row.name, type: row.type, property: clone(row.property), order: row.order }] }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID, base_id: 'base_frwg', name: 'Sheet', description: null }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: row ? [{ id: row.id, name: row.name, type: row.type, property: clone(row.property), order: row.order }] : [] }
    }
    return { rows: [], rowCount: 0 }
  }
  return {
    handler,
    statements,
    current: () => row,
    revisionInserts: () => statements.filter((s) => s.sql.startsWith('INSERT INTO meta_config_revisions')),
    fieldUpdates: () => statements.filter((s) => s.sql.startsWith('UPDATE meta_fields SET name = $2')),
  }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return handler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(handler: (sql: string, params?: unknown[]) => QueryResult) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:write', 'multitable:manage-schema']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user_frwg', roles: [], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] } as never
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

const pinned = usePinnedServer()
const baseRow = (): Row => ({ id: FIELD_ID, sheet_id: SHEET_ID, name: FIELD_NAME, type: 'string', property: { humanWriteLock: 'plm_system', note: 'kept' }, order: 3 })

describe('PATCH /fields/:fieldId late locked re-read (route, mocked pool)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('W-1 the late re-read runs after the sibling order shift and its revisions, and before the UPDATE', async () => {
    const scenario = createScenario({ first: { ...baseRow(), order: 0 }, shifted: [{ id: 'fld_sib_1', order: 0 }, { id: 'fld_sib_2', order: 1 }] })
    const { app } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ order: 2 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const sqls = scenario.statements.map((s) => s.sql)
    const shift = sqls.findIndex((s) => s.startsWith('UPDATE meta_fields SET "order" = "order" - 1'))
    const reread = sqls.indexOf(PATCH_FIELD_LOCKED_REREAD_SQL)
    const update = sqls.findIndex((s) => s.startsWith('UPDATE meta_fields SET name = $2'))
    // the shifted siblings' revisions (recordFieldOrderShifts) are written before the re-read
    const shiftRevisions = sqls.map((s, i) => (s.startsWith('INSERT INTO meta_config_revisions') ? i : -1)).filter((i) => i >= 0 && i < update)
    expect(shiftRevisions).toHaveLength(2)
    const lastShiftRevision = Math.max(...shiftRevisions)
    expect(shift).toBeGreaterThanOrEqual(0)
    expect(lastShiftRevision).toBeGreaterThan(shift)
    expect(reread).toBeGreaterThan(lastShiftRevision)
    expect(update).toBe(reread + 1)
    // the first read stays unlocked, and the row is read exactly twice (first read + late re-read)
    expect(sqls.filter((s) => s === PATCH_FIELD_READ_SQL)).toHaveLength(1)
    expect(sqls.filter((s) => s === PATCH_FIELD_LOCKED_REREAD_SQL)).toHaveLength(1)
  })

  it('W-2 a concurrent change on the first attempt: the transaction runs again on fresh data and answers 200, carrying the change', async () => {
    const scenario = createScenario({
      first: baseRow(),
      beforeLateReread: (attempt, current) => (attempt === 1 ? { ...current, property: { ...current.property, stockPreparationManualRows: 'disabled' } } : current),
    })
    const { app, mockPool } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ name: 'Renamed' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(mockPool.transaction).toHaveBeenCalledTimes(2)
    expect(scenario.fieldUpdates()).toHaveLength(1)
    expect(scenario.current()).toMatchObject({
      name: 'Renamed',
      property: { humanWriteLock: 'plm_system', note: 'kept', stockPreparationManualRows: 'disabled' },
    })
    expect(scenario.revisionInserts()).toHaveLength(1)
  })

  it('W-3 a concurrent change on both attempts: 409 FIELD_CHANGED_CONCURRENTLY, values-free; no UPDATE and no config revision', async () => {
    const scenario = createScenario({
      first: baseRow(),
      beforeLateReread: (attempt, current) => ({ ...current, property: { ...current.property, concurrent: `value-${attempt}` } }),
    })
    const { app, mockPool } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ name: 'Renamed' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toEqual({ ok: false, error: { code: FIELD_CHANGED_CONCURRENTLY_CODE, message: FIELD_CHANGED_CONCURRENTLY_MESSAGE } })
    const body = JSON.stringify(res.body)
    for (const leaked of [FIELD_ID, FIELD_NAME, 'Renamed', 'value-1', 'value-2', 'plm_system', SHEET_ID]) expect(body).not.toContain(leaked)
    expect(mockPool.transaction).toHaveBeenCalledTimes(PATCH_FIELD_MAX_ATTEMPTS)
    expect(scenario.fieldUpdates()).toHaveLength(0)
    expect(scenario.revisionInserts()).toHaveLength(0)
  })

  it('W-4 the row is gone at the late re-read: 404, no UPDATE', async () => {
    const scenario = createScenario({ first: baseRow(), beforeLateReread: () => null })
    const { app } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ name: 'Renamed' })
    expect(res.status, JSON.stringify(res.body)).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(scenario.fieldUpdates()).toHaveLength(0)
  })

  it('W-5 without `order` in the body the order comes from the locked row, and the revision does not claim the move', async () => {
    const scenario = createScenario({
      first: { ...baseRow(), order: 3 },
      // a sibling's shift (or a concurrent reorder) moved this row between the two reads; order is not compared
      beforeLateReread: (_attempt, current) => ({ ...current, order: 7 }),
    })
    const { app, mockPool } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ name: 'Renamed' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
    const [update] = scenario.fieldUpdates()
    expect(update.params[4]).toBe(7)
    const [revision] = scenario.revisionInserts()
    expect(revision.params[3]).toBe(FIELD_ID)
    expect(revision.params[7]).toEqual(['name'])
    expect(JSON.parse(String(revision.params[5]))).toEqual({ name: FIELD_NAME })
  })

  it('G-1a a statement timeout (57014) at the late re-read is not retried: one transaction, 500', async () => {
    // A PATCH parked on the row lock until the statement timeout must not park a second time on a retry.
    const scenario = createScenario({ first: baseRow(), failAt: { sql: (s) => s === PATCH_FIELD_LOCKED_REREAD_SQL, code: '57014' } })
    const { app, mockPool } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ name: 'Renamed' })
    expect(res.status, JSON.stringify(res.body)).toBe(500)
    expect(mockPool.transaction, 'only FieldChangedConcurrentlyError is retried').toHaveBeenCalledTimes(1)
    expect(scenario.statements.filter((s) => s.sql === PATCH_FIELD_LOCKED_REREAD_SQL)).toHaveLength(1)
    expect(scenario.fieldUpdates()).toHaveLength(0)
  })

  it('G-1b a unique violation (23505) at the UPDATE is not retried: one transaction, 409 CONFLICT', async () => {
    const scenario = createScenario({ first: baseRow(), failAt: { sql: (s) => s.startsWith('UPDATE meta_fields SET name = $2'), code: '23505' } })
    const { app, mockPool } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ name: 'Renamed' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
    expect(mockPool.transaction, 'only FieldChangedConcurrentlyError is retried').toHaveBeenCalledTimes(1)
    expect(scenario.fieldUpdates()).toHaveLength(1)
  })

  it('G-2 a rolled-back attempt does not leak its bulk-recompute snapshot into the committed attempt', async () => {
    // Attempt 1: an expression PATCH on a formula field snapshots the live record ids for the post-commit recompute;
    // the field is retyped away from formula before the late re-read, so attempt 1 rolls back. Attempt 2 commits the
    // PATCH on a plain field: there is nothing to recompute and the response must not claim a recompute.
    const scenario = createScenario({
      first: { ...baseRow(), type: 'formula', property: { expression: '=1' } },
      beforeLateReread: (attempt, current) => (attempt === 1 ? { ...current, type: 'string' } : current),
      records: ['rec_frwg_1', 'rec_frwg_2'],
    })
    const { app, mockPool } = await createApp(scenario.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD_ID}`).send({ property: { expression: '=2' } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(mockPool.transaction).toHaveBeenCalledTimes(2)
    // the snapshot was taken on attempt 1 only (so the reset is what keeps it out of the response)
    expect(scenario.statements.filter((s) => s.sql === BULK_RECOMPUTE_SNAPSHOT_SQL)).toHaveLength(1)
    expect(res.body.data.field.type).toBe('string')
    expect(res.body.data.bulkRecompute, 'attempt 1 recompute snapshot must not leak into the committed attempt').toBeUndefined()
  })
})
