/**
 * Config revert — the field snapshot is read under the row lock in the EXECUTE transaction only (DB-free).
 *
 * The generic execute branch compares the live field (its in-transaction snapshot) with the revision, re-reads the
 * stored property for the lock/switch carry, and then writes. Without a row lock between the snapshot and the write, a
 * change committed in that window is overwritten — with no CONFIG_DRIFT, because the drift check already passed on the
 * stale snapshot. So the execute snapshot of a FIELD is `FOR NO KEY UPDATE`; the preview stays lock-free and write-free
 * (it runs on the pool, outside any transaction), and views / sheet_config keep their unlocked snapshot.
 *
 * The real-Postgres interleavings (RT-5, RT-5b) live in tests/integration/multitable-field-row-concurrency-realdb.cases.ts.
 */
import { randomUUID } from 'node:crypto'

import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  FIELD_CONFIG_SNAPSHOT_LOCKED_SQL,
  FIELD_CONFIG_SNAPSHOT_SQL,
  loadEntityConfigSnapshot,
  type ConfigRevisionRow,
} from '../../src/multitable/config-restore'
import { dbUser, emptyWorld, FieldRetypeConvertFakePg, type FakeWorld } from '../utils/field-retype-convert-fake-pg'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET = 'sheet_snaplock_1'
const FIELD = 'fld_snaplock_1'
const ACTOR = 'user_snaplock'
const SECRET = 'snapshot-lock-secret-0123456789abcdef'
const PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']
// Every row-lock strength PostgreSQL has, plus the advisory/table locks.
const LOCK_RE = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b|pg_advisory\w*|\bLOCK\s+TABLE\b/i

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function revision(over: Partial<ConfigRevisionRow> = {}): ConfigRevisionRow {
  return {
    id: 'rev_1', sheet_id: SHEET, entity_type: 'field', entity_id: FIELD, action: 'update',
    before: { name: 'Old' }, after: { name: 'Status' }, changed_keys: ['name'], ...over,
  } as ConfigRevisionRow
}

describe('loadEntityConfigSnapshot — the lock option', () => {
  const capture = () => {
    const seen: string[] = []
    const query = async (sql: string) => { seen.push(normalize(sql)); return { rows: [] } }
    return { seen, query }
  }

  test('a field snapshot is unlocked by default and FOR NO KEY UPDATE with lockField', async () => {
    const plain = capture()
    await loadEntityConfigSnapshot(plain.query, revision())
    expect(plain.seen).toEqual([FIELD_CONFIG_SNAPSHOT_SQL])
    const locked = capture()
    await loadEntityConfigSnapshot(locked.query, revision(), { lockField: true })
    expect(locked.seen).toEqual([FIELD_CONFIG_SNAPSHOT_LOCKED_SQL])
    expect(FIELD_CONFIG_SNAPSHOT_LOCKED_SQL).toBe(`${FIELD_CONFIG_SNAPSHOT_SQL} FOR NO KEY UPDATE`)
  })

  test('lockField is field-only: view and sheet_config snapshots stay unlocked', async () => {
    for (const entityType of ['view', 'sheet_config'] as const) {
      const c = capture()
      await loadEntityConfigSnapshot(c.query, revision({ entity_type: entityType, entity_id: 'x' }), { lockField: true })
      expect(c.seen, entityType).toHaveLength(1)
      expect(c.seen[0], entityType).not.toMatch(LOCK_RE)
    }
  })
})

function world(): FakeWorld {
  return {
    ...emptyWorld(),
    sheets: [{ id: SHEET, base_id: 'base_1', deleted_at: null, row_level_read_permissions_enabled: false, system_kind: null, description: null, recovery_writer_state: null }],
    fields: [{ id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: {}, order: 0 }],
    dbUsers: { [ACTOR]: dbUser(PERMS) },
  }
}

const state: { pg: FieldRetypeConvertFakePg } = { pg: new FieldRetypeConvertFakePg(emptyWorld()) }
const pinned = usePinnedServer()

// The shared fake has no answer for the config snapshot; answer it here (both texts), after the fake has recorded the
// statement with its in-transaction flag.
async function query(sql: string, params: unknown[] = []) {
  const res = await state.pg.query(sql, params)
  const s = normalize(sql)
  if (s === FIELD_CONFIG_SNAPSHOT_SQL || s === FIELD_CONFIG_SNAPSHOT_LOCKED_SQL) {
    const rows = state.pg.world.fields.filter((f) => f.id === params[0]).map((f) => ({ name: f.name, type: f.type, property: clone(f.property), order: f.order }))
    return { rows, rowCount: rows.length }
  }
  return res
}

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn(async () => PERMS),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const routes = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query,
    transaction: (handler: (client: { query: typeof query }) => Promise<unknown>) => state.pg.transaction(() => handler({ query })),
  } as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: ACTOR, roles: [], perms: [...PERMS] } as never
    next()
  })
  app.use('/api/multitable', routes.univerMetaRouter())
  pinned.setApp(app)
}, 120_000)

afterAll(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../../src/rbac/service')
  vi.resetModules()
})

describe('config-restore routes: the field snapshot lock is execute-only', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', '')
    vi.stubEnv('RESTORE_PREVIEW_SECRET', SECRET)
    state.pg = new FieldRetypeConvertFakePg(world(), { permissiveTransaction: true })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const post = (path: string, body: unknown) => request(pinned.url()).post(`/api/multitable${path}`).send(body as object)
  const seedRevision = (over: Record<string, unknown> = {}) => {
    const id = randomUUID()
    state.pg.world.configRevisions.push({
      id, sheet_id: SHEET, entity_type: 'field', entity_id: FIELD, action: 'update',
      before: { name: 'Old' }, after: { name: 'Status' }, changed_keys: ['name'], batch_id: id, actor_id: ACTOR,
      source: 'mutation', restored_from_id: null, operation_id: null, ...over,
    })
    return id
  }

  test('a field revert: the preview reads the snapshot without any lock; the execute transaction reads it FOR NO KEY UPDATE', async () => {
    const rev = seedRevision()
    const previewed = await post(`/sheets/${SHEET}/config-restore-preview`, { revisionId: rev })
    expect(previewed.status, JSON.stringify(previewed.body)).toBe(200)
    const previewStatements = state.pg.statements.map((s) => ({ sql: normalize(s.sql), inTransaction: s.inTransaction }))
    expect(previewStatements.some((s) => s.sql === FIELD_CONFIG_SNAPSHOT_SQL)).toBe(true)
    expect(previewStatements.filter((s) => s.inTransaction), 'the preview opens no transaction').toEqual([])
    expect(previewStatements.filter((s) => LOCK_RE.test(s.sql)).map((s) => s.sql), 'the preview takes no lock').toEqual([])

    const n = state.pg.statements.length
    const executed = await post(`/sheets/${SHEET}/config-restore-execute`, { revisionId: rev, previewToken: previewed.body.data.previewToken })
    expect(executed.status, JSON.stringify(executed.body)).toBe(200)
    const tx = state.pg.statements.slice(n).filter((s) => s.inTransaction).map((s) => normalize(s.sql))
    const snapshot = tx.indexOf(FIELD_CONFIG_SNAPSHOT_LOCKED_SQL)
    const write = tx.findIndex((sql) => sql.startsWith('UPDATE meta_fields SET name = $1'))
    expect(snapshot, 'the execute snapshot is locked').toBeGreaterThanOrEqual(0)
    expect(write).toBeGreaterThan(snapshot)
    expect(tx).not.toContain(FIELD_CONFIG_SNAPSHOT_SQL)
  })

  test('a view revert: the execute snapshot stays unlocked (the lock is field-only)', async () => {
    const rev = seedRevision({ entity_type: 'view', entity_id: 'view_snaplock_1', before: { name: 'a' }, after: { name: 'b' } })
    const n = state.pg.statements.length
    await post(`/sheets/${SHEET}/config-restore-execute`, { revisionId: rev, previewToken: 'not-a-token' })
    const tx = state.pg.statements.slice(n).filter((s) => s.inTransaction).map((s) => normalize(s.sql))
    expect(tx.some((sql) => sql.includes('FROM meta_views WHERE id = $1')), 'the view snapshot ran in the execute transaction').toBe(true)
    expect(tx.filter((sql) => LOCK_RE.test(sql))).toEqual([])
  })
})
