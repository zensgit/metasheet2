import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

// auditLog writes to the DB; in these in-memory tests it must be a no-op so the
// create/update/delete handlers don't fail on a missing connection.
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter } from '../../src/routes/data-sources'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

function pgConfig(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'x' },
    options: { autoConnect: false },
  }
}

// Minimal Kysely stand-in for loadFromDatabase: selectFrom().selectAll().where().where().execute()
function fakeDb(records: unknown[]) {
  const builder = {
    selectAll: () => builder,
    where: () => builder,
    execute: async () => records,
  }
  return { selectFrom: () => builder }
}

// Stateful Kysely stand-in that simulates the data_sources table across a
// persist -> reload cycle (insert/upsert, soft-delete update, scoped load).
function statefulFakeDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const control = { failUpsert: false }

  function selectBuilder() {
    const b = {
      selectAll: () => b,
      where: () => b,
      // mirrors loadFromDatabase's filter: is_active = true AND deleted_at IS NULL
      execute: async () =>
        [...rows.values()].filter((r) => r.is_active === true && r.deleted_at == null),
    }
    return b
  }

  function insertBuilder() {
    let pending: Record<string, unknown> = {}
    let updateSet: Record<string, unknown> | undefined
    const b = {
      values: (v: Record<string, unknown>) => {
        pending = v
        return b
      },
      onConflict: (cb: (oc: unknown) => unknown) => {
        const oc = { column: () => ({ doUpdateSet: (s: Record<string, unknown>) => { updateSet = s; return oc } }) }
        cb(oc)
        return b
      },
      execute: async () => {
        if (control.failUpsert) throw new Error('simulated persist failure')
        const id = pending.id as string
        if (rows.has(id) && updateSet) {
          rows.set(id, { ...rows.get(id), ...updateSet })
        } else {
          rows.set(id, { ...pending })
        }
        return []
      },
    }
    return b
  }

  function updateBuilder() {
    let setObj: Record<string, unknown> = {}
    let whereId: string | undefined
    const b = {
      set: (s: Record<string, unknown>) => { setObj = s; return b },
      where: (_col: unknown, _op: unknown, val: unknown) => { whereId = val as string; return b },
      execute: async () => {
        if (whereId != null && rows.has(whereId)) rows.set(whereId, { ...rows.get(whereId), ...setObj })
        return []
      },
    }
    return b
  }

  function deleteBuilder() {
    let whereId: string | undefined
    const b = {
      where: (_col: unknown, _op: unknown, val: unknown) => { whereId = val as string; return b },
      execute: async () => { if (whereId != null) rows.delete(whereId); return [] },
    }
    return b
  }

  return {
    rows,
    control,
    db: {
      selectFrom: () => selectBuilder(),
      insertInto: () => insertBuilder(),
      updateTable: () => updateBuilder(),
      deleteFrom: () => deleteBuilder(),
    },
  }
}

function dbRecord(id: string, ownerId: string, workspaceId: string | null, type = 'postgres') {
  return {
    id,
    name: id,
    type,
    description: null,
    config: { connection: {} },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: ownerId,
    workspace_id: workspaceId,
    is_active: true,
    auto_connect: false,
    metadata: null,
    tags: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  }
}

describe('DataSourceManager ownership scope (A0.1)', () => {
  it('addDataSource records the owner; workspace defaults to null', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('ds1'), { ownerId: 'alice' })
    expect(m.getScope('ds1')).toEqual({ ownerId: 'alice', workspaceId: null })
  })

  it('assertAccess allows the owner and rejects others / missing / anonymous', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('ds1'), { ownerId: 'alice' })
    expect(() => m.assertAccess('ds1', 'alice')).not.toThrow()
    expect(() => m.assertAccess('ds1', 'bob')).toThrow(/not found/)
    expect(() => m.assertAccess('ds1', undefined)).toThrow(/not found/)
    expect(() => m.assertAccess('missing', 'alice')).toThrow(/not found/)
  })

  it('listDataSources filters by owner (and returns all when unfiltered)', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('a1'), { ownerId: 'alice' })
    await m.addDataSource(pgConfig('b1'), { ownerId: 'bob' })
    expect(m.listDataSources({ ownerId: 'alice' }).map((s) => s.id)).toEqual(['a1'])
    expect(m.listDataSources({ ownerId: 'bob' }).map((s) => s.id)).toEqual(['b1'])
    expect(m.listDataSources().map((s) => s.id).sort()).toEqual(['a1', 'b1'])
  })

  it('healthCheck filters by owner', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('health-a'), { ownerId: 'alice' })
    await m.addDataSource(pgConfig('health-b'), { ownerId: 'bob' })

    expect([...((await m.healthCheck({ ownerId: 'alice' })).keys())]).toEqual(['health-a'])
    expect([...((await m.healthCheck({ ownerId: 'bob' })).keys())]).toEqual(['health-b'])
    expect([...((await m.healthCheck()).keys())].sort()).toEqual(['health-a', 'health-b'])
  })

  it('removeDataSource clears the scope entry', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('ds1'), { ownerId: 'alice' })
    await m.removeDataSource('ds1')
    expect(m.getScope('ds1')).toBeUndefined()
    expect(() => m.assertAccess('ds1', 'alice')).toThrow(/not found/)
  })

  it('loadFromDatabase populates per-record ownership from the DB row', async () => {
    const m = new DataSourceManager()
    await m.initialize(fakeDb([dbRecord('a1', 'alice', null), dbRecord('b1', 'bob', 'ws-b')]) as never)
    expect(m.getScope('a1')).toEqual({ ownerId: 'alice', workspaceId: null })
    expect(m.getScope('b1')).toEqual({ ownerId: 'bob', workspaceId: 'ws-b' })
    expect(() => m.assertAccess('a1', 'bob')).toThrow(/not found/)
    expect(m.listDataSources({ ownerId: 'bob' }).map((s) => s.id)).toEqual(['b1'])
  })

  it('skips persisted rows whose type is no longer in the supported runtime set', async () => {
    const m = new DataSourceManager()
    await m.initialize(fakeDb([
      dbRecord('pg-ok', 'alice', null, 'postgres'),
      dbRecord('legacy-mysql', 'alice', null, 'mysql'),
    ]) as never)
    expect(() => m.getDataSource('pg-ok')).not.toThrow()
    expect(() => m.getDataSource('legacy-mysql')).toThrow(/not found/)
    expect(m.listDataSources({ ownerId: 'alice' }).map((s) => s.id)).toEqual(['pg-ok'])
  })
})

describe('data-sources route ownership scope (A0.1)', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    next()
  })
  app.use(dataSourcesRouter())

  const admin = (id: string) => ({ id, role: 'admin' })

  it('a non-owner gets 404 on another user’s data source; the owner gets 200', async () => {
    currentUser = admin('alice')
    const create = await request(app).post('/api/data-sources').send(pgConfig('ds-get-1'))
    expect(create.status).toBe(201)

    currentUser = admin('bob')
    const asBob = await request(app).get('/api/data-sources/ds-get-1')
    expect(asBob.status).toBe(404)

    currentUser = admin('alice')
    const asAlice = await request(app).get('/api/data-sources/ds-get-1')
    expect(asAlice.status).toBe(200)
  })

  it('list returns only the caller’s own data sources', async () => {
    currentUser = admin('alice2')
    await request(app).post('/api/data-sources').send(pgConfig('ds-list-a'))
    currentUser = admin('bob2')
    await request(app).post('/api/data-sources').send(pgConfig('ds-list-b'))

    currentUser = admin('alice2')
    const list = await request(app).get('/api/data-sources')
    expect(list.status).toBe(200)
    const ids = (list.body.data.items as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain('ds-list-a')
    expect(ids).not.toContain('ds-list-b')
  })

  it('health route is reachable and returns only the caller’s own data sources', async () => {
    currentUser = admin('alice-health')
    await request(app).post('/api/data-sources').send(pgConfig('ds-health-a'))
    currentUser = admin('bob-health')
    await request(app).post('/api/data-sources').send(pgConfig('ds-health-b'))

    currentUser = admin('alice-health')
    const res = await request(app).get('/api/data-sources/health')
    expect(res.status).toBe(200)
    const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain('ds-health-a')
    expect(ids).not.toContain('ds-health-b')
  })

  it('PUT preserves the owner — a non-owner still gets 404 after the update', async () => {
    currentUser = admin('alice3')
    const create = await request(app).post('/api/data-sources').send(pgConfig('ds-put-1'))
    expect(create.status).toBe(201)

    const put = await request(app).put('/api/data-sources/ds-put-1').send({ name: 'renamed' })
    expect(put.status).toBe(200)

    // Without owner preservation the re-add would revert to 'system' and leak
    currentUser = admin('bob3')
    expect((await request(app).get('/api/data-sources/ds-put-1')).status).toBe(404)

    currentUser = admin('alice3')
    expect((await request(app).get('/api/data-sources/ds-put-1')).status).toBe(200)
  })

  it('rejects an unauthenticated request', async () => {
    currentUser = undefined
    const res = await request(app).post('/api/data-sources').send(pgConfig('ds-unauth'))
    expect(res.status).toBe(401)
  })

  it('rejects unsupported create types at validation time', async () => {
    currentUser = admin('alice4')
    for (const unsupportedType of ['mysql', 'mongodb', 'redis', 'elasticsearch']) {
      const res = await request(app)
        .post('/api/data-sources')
        .send({ ...pgConfig(`bad-${unsupportedType}`), type: unsupportedType })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.message).toContain('Unsupported data source type')
    }
  })
})

describe('DataSourceManager persistence round-trip (A0)', () => {
  it('a source recreated with the same id after deletion still loads after a restart', async () => {
    const { db } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(pgConfig('ds-x'), { ownerId: 'alice' })

    // delete (soft-delete) then recreate with the same id — upsert must revive
    await m1.removeDataSource('ds-x')
    await m1.addDataSource({ ...pgConfig('ds-x'), name: 'renamed' }, { ownerId: 'alice' })

    // restart: a fresh manager loading the same table must still see the source
    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    expect(m2.getScope('ds-x')).toEqual({ ownerId: 'alice', workspaceId: null })
    expect(m2.listDataSources().map((s) => s.id)).toContain('ds-x')
  })

  it('an updated source loads after a restart (updateDataSource persists)', async () => {
    const { db } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(pgConfig('ds-u'), { ownerId: 'alice' })
    await m1.updateDataSource('ds-u', { ...pgConfig('ds-u'), name: 'renamed' }, { ownerId: 'alice' })

    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    expect(m2.getScope('ds-u')).toEqual({ ownerId: 'alice', workspaceId: null })
    expect(m2.listDataSources().map((s) => s.id)).toContain('ds-u')
  })

  it('a rejected duplicate create does not mutate the existing persisted row', async () => {
    const { db, rows } = statefulFakeDb()
    const m = new DataSourceManager({ db: db as never })
    await m.addDataSource(pgConfig('ds-dup'), { ownerId: 'alice' })
    const rowBefore = { ...rows.get('ds-dup') }

    await expect(
      m.addDataSource({ ...pgConfig('ds-dup'), name: 'hijack' }, { ownerId: 'mallory' }),
    ).rejects.toThrow(/already exists/)

    // the rejected create must not have overwritten config or owner
    expect(rows.get('ds-dup')).toEqual(rowBefore)
    expect(m.getScope('ds-dup')).toEqual({ ownerId: 'alice', workspaceId: null })
  })

  it('a failed persist during update leaves the original source intact (atomic update)', async () => {
    const { db, control, rows } = statefulFakeDb()
    const m = new DataSourceManager({ db: db as never })
    await m.addDataSource(pgConfig('ds-z'), { ownerId: 'alice' })
    const rowBefore = { ...rows.get('ds-z') }

    control.failUpsert = true
    await expect(
      m.updateDataSource('ds-z', { ...pgConfig('ds-z'), name: 'renamed' }, { ownerId: 'alice' }),
    ).rejects.toThrow(/simulated persist failure/)

    // source survives in memory and the DB row is unchanged
    expect(() => m.getDataSource('ds-z')).not.toThrow()
    expect(m.getScope('ds-z')).toEqual({ ownerId: 'alice', workspaceId: null })
    expect(rows.get('ds-z')).toEqual(rowBefore)
  })

  it('updating autoConnect is persisted so restart behavior is consistent', async () => {
    const { db, rows } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource({ ...pgConfig('ds-y'), options: { autoConnect: false } }, { ownerId: 'alice' })
    expect(rows.get('ds-y')?.auto_connect).toBe(false)

    await m1.removeDataSource('ds-y')
    await m1.addDataSource({ ...pgConfig('ds-y'), options: { autoConnect: true } }, { ownerId: 'alice' })
    expect(rows.get('ds-y')?.auto_connect).toBe(true)
  })
})
