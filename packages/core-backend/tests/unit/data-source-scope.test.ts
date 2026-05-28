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

function dbRecord(id: string, ownerId: string, workspaceId: string | null) {
  return {
    id,
    name: id,
    type: 'postgres',
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
})
