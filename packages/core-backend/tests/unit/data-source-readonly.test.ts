import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { auditLog } from '../../src/audit/audit'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter, getDataSourceManager, isReadOnlySql } from '../../src/routes/data-sources'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

function sqlConfig(id: string, readOnly?: boolean): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'x' },
    options: { autoConnect: false, ...(readOnly === undefined ? {} : { readOnly }) },
  }
}

function httpConfig(id: string, readOnly?: boolean): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'http',
    connection: { baseURL: 'http://example.test' },
    options: { autoConnect: false, ...(readOnly === undefined ? {} : { readOnly }) },
  }
}

describe('isReadOnlySql classifier (A-RO)', () => {
  it('allows read-only leading verbs (case-insensitive, trailing semicolon ok)', () => {
    expect(isReadOnlySql('SELECT * FROM t')).toBe(true)
    expect(isReadOnlySql('  select 1;')).toBe(true)
    expect(isReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(isReadOnlySql('EXPLAIN SELECT 1')).toBe(true)
    expect(isReadOnlySql('show tables')).toBe(true)
  })

  it('rejects writes, multiple statements and SELECT ... INTO', () => {
    expect(isReadOnlySql('DELETE FROM t')).toBe(false)
    expect(isReadOnlySql('UPDATE t SET a=1')).toBe(false)
    expect(isReadOnlySql('INSERT INTO t VALUES (1)')).toBe(false)
    expect(isReadOnlySql('DROP TABLE t')).toBe(false)
    expect(isReadOnlySql('TRUNCATE t')).toBe(false)
    expect(isReadOnlySql('SELECT 1; DROP TABLE t')).toBe(false) // multiple statements
    expect(isReadOnlySql('SELECT * INTO backup FROM t')).toBe(false) // SELECT ... INTO
  })
})

describe('BaseDataAdapter read-only flags (A-RO)', () => {
  it('defaults to read-only; writable only when options.readOnly === false', async () => {
    const m = new DataSourceManager()
    const ro = await m.addDataSource(sqlConfig('ro'), { ownerId: 'a' })
    expect(ro.isReadOnly()).toBe(true)
    expect(() => ro.assertWritable()).toThrow(/read-only/)

    const rw = await m.addDataSource(sqlConfig('rw', false), { ownerId: 'a' })
    expect(rw.isReadOnly()).toBe(false)
    expect(() => rw.assertWritable()).not.toThrow()
  })

  it('classifies SQL vs non-SQL adapters', async () => {
    const m = new DataSourceManager()
    const pg = await m.addDataSource(sqlConfig('pg'), { ownerId: 'a' })
    const http = await m.addDataSource(httpConfig('http'), { ownerId: 'a' })
    expect(pg.isSqlDialect()).toBe(true)
    expect(http.isSqlDialect()).toBe(false)
  })
})

describe('DataSourceManager mutation guard (A-RO)', () => {
  it('rejects insert/update/delete on a read-only source', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlConfig('ro'), { ownerId: 'a' })
    await expect(m.insert('ro', 't', { a: 1 })).rejects.toThrow(/read-only/)
    await expect(m.update('ro', 't', { a: 1 }, { id: 1 })).rejects.toThrow(/read-only/)
    await expect(m.delete('ro', 't', { id: 1 })).rejects.toThrow(/read-only/)
  })
})

describe('data-sources /query read-only gate (A-RO)', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    next()
  })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })

  it('rejects write SQL on a read-only SQL source with 403 READ_ONLY', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send(sqlConfig('ro-sql'))
    const res = await request(app).post('/api/data-sources/ro-sql/query').send({ sql: 'DELETE FROM t' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })

  it('disables the raw query path entirely for a read-only non-SQL source', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send(httpConfig('ro-http'))
    const res = await request(app).post('/api/data-sources/ro-http/query').send({ sql: 'GET /whatever' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })
})

describe('data-sources PUT deep-merge (A-RO)', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    next()
  })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })

  it('a partial options update preserves sibling option keys', async () => {
    currentUser = admin('alice')
    await request(app)
      .post('/api/data-sources')
      .send({ ...sqlConfig('pm'), options: { autoConnect: true, readOnly: false } })

    const put = await request(app).put('/api/data-sources/pm').send({ options: { timeout: 5 } })
    expect(put.status).toBe(200)

    const got = await request(app).get('/api/data-sources/pm')
    expect(got.status).toBe(200)
    // shallow merge would have wiped readOnly/autoConnect; deep merge keeps them
    expect(got.body.data.options).toMatchObject({ autoConnect: true, readOnly: false, timeout: 5 })
  })

  it('persists per-source tenant scope option keys through create and partial update', async () => {
    currentUser = admin('alice')
    const create = await request(app)
      .post('/api/data-sources')
      .send({
        id: 'plm-scope',
        name: 'PLM scoped',
        type: 'http',
        connection: { baseURL: 'http://plm.example.test' },
        options: { autoConnect: false, readOnly: true, tenantId: 'tenant-a', orgId: 'org-a' },
      })
    expect(create.status).toBe(201)
    expect(create.body.data.options).toMatchObject({ tenantId: 'tenant-a', orgId: 'org-a' })

    // This route-level test only locks REST persistence of the option keys. PLM
    // embed reachability is locked by the real PLMAdapter tests; an HTTP source
    // is not a PLM BOM adapter.
    const put = await request(app)
      .put('/api/data-sources/plm-scope')
      .send({ options: { timeout: 10 } })
    expect(put.status).toBe(200)

    const got = await request(app).get('/api/data-sources/plm-scope')
    expect(got.status).toBe(200)
    expect(got.body.data.options).toMatchObject({
      autoConnect: false,
      readOnly: true,
      tenantId: 'tenant-a',
      orgId: 'org-a',
      timeout: 10,
    })
  })

  it('a partial connection update preserves hidden security keys (P1 regression)', async () => {
    currentUser = admin('alice')
    // A source whose connection carries security-sensitive keys an edit UI does NOT surface.
    await request(app).post('/api/data-sources').send({
      id: 'tlsmerge', name: 'tlsmerge', type: 'postgres',
      connection: {
        host: 'old-host', database: 'db',
        encrypt: true, trustServerCertificate: false, tlsMinVersion: 'TLSv1',
      },
      credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false, readOnly: true },
    })

    // The edit flow re-sends connection with only the visible field {host}. Wholesale replace would
    // drop encrypt/trustServerCertificate/tlsMinVersion (weakening cert validation / breaking TLS).
    const put = await request(app).put('/api/data-sources/tlsmerge').send({ connection: { host: 'new-host' } })
    expect(put.status).toBe(200)

    const got = await request(app).get('/api/data-sources/tlsmerge')
    expect(got.status).toBe(200)
    expect(got.body.data.connection).toMatchObject({
      host: 'new-host',        // visible edit applied
      database: 'db',          // hidden key preserved
      encrypt: true,           // hidden security key preserved
      trustServerCertificate: false,
      tlsMinVersion: 'TLSv1',
    })
    // credentials are still never returned, and the merge does not resurrect them into the response
    expect(got.body.data).not.toHaveProperty('credentials')
    expect(got.body.data.hasCredentials).toBe(true)
  })

  it('rotates credentials without exposing them or wiping omitted keys', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send({
      id: 'rotate-creds', name: 'rotate-creds', type: 'postgres',
      connection: { host: 'db', database: 'erp' },
      credentials: { username: 'old-user', password: 'old-password', apiKey: 'kept-key' },
      options: { autoConnect: false, readOnly: true },
    })

    const put = await request(app)
      .put('/api/data-sources/rotate-creds/credentials')
      .send({ credentials: { password: 'new-password' } })
    expect(put.status).toBe(200)
    expect(put.body.data).not.toHaveProperty('credentials')
    expect(put.body.data.hasCredentials).toBe(true)

    const got = await request(app).get('/api/data-sources/rotate-creds')
    expect(got.body.data).not.toHaveProperty('credentials')
    expect(got.body.data.hasCredentials).toBe(true)

    const config = getDataSourceManager().getDataSource('rotate-creds').getConfig()
    expect(config.credentials).toMatchObject({
      username: 'old-user',
      password: 'new-password',
      apiKey: 'kept-key',
    })
    const auditMeta = vi.mocked(auditLog).mock.calls.at(-1)?.[0]?.meta
    expect(auditMeta).toMatchObject({ changedCredentialKeys: ['password'] })
    expect(JSON.stringify(auditMeta)).not.toContain('new-password')
    expect(JSON.stringify(auditMeta)).not.toContain('old-password')
  })

  it('fails closed on empty credential rotation payloads', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send({
      id: 'rotate-empty', name: 'rotate-empty', type: 'postgres',
      connection: { host: 'db', database: 'erp' },
      credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false, readOnly: true },
    })

    const empty = await request(app)
      .put('/api/data-sources/rotate-empty/credentials')
      .send({ credentials: {} })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('VALIDATION_ERROR')

    const blank = await request(app)
      .put('/api/data-sources/rotate-empty/credentials')
      .send({ credentials: { password: '' } })
    expect(blank.status).toBe(400)
    expect(blank.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('scopes credential rotation to the source owner', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send({
      id: 'rotate-scope', name: 'rotate-scope', type: 'postgres',
      connection: { host: 'db', database: 'erp' },
      credentials: { username: 'u', password: 'alice-password' },
      options: { autoConnect: false, readOnly: true },
    })

    currentUser = admin('bob')
    const denied = await request(app)
      .put('/api/data-sources/rotate-scope/credentials')
      .send({ credentials: { password: 'bob-password' } })
    expect(denied.status).toBe(404)

    const config = getDataSourceManager().getDataSource('rotate-scope').getConfig()
    expect(config.credentials?.password).toBe('alice-password')
  })
})
