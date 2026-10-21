import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))
// The cross-owner rotation pin below now needs a NON-ADMIN denied user (platform
// admins legitimately rotate any source's credentials — see
// data-source-visibility-authority-matrix.test.ts). Stub rbacGuard's DB-backed
// fallbacks so a member with req.user.permissions is deterministic without a pool.
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => false),
  userHasPermission: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn(async () => true),
}))

import { auditLog } from '../../src/audit/audit'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  OUTBOUND_SQL_WRITE_DISABLED,
  OUTBOUND_SQL_WRITE_TARGETS_ENV,
} from '../../src/data-adapters/outbound-sql-write-gate'
import { dataSourcesRouter, getDataSourceManager, isReadOnlySql } from '../../src/routes/data-sources'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()

function sqlConfig(id: string, readOnly?: boolean): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'x' },
    options: { autoConnect: false, ...(readOnly === undefined ? {} : { readOnly }) },
  }
}

function c6WriteTargetConfig(id: string): DataSourceConfig {
  return {
    ...sqlConfig(id, false),
    options: {
      autoConnect: false,
      readOnly: false,
      c6WriteTarget: true,
      genericQueryDisabled: true,
    },
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

  it('rejects generic raw query and delete on a C6 write-gated target', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(c6WriteTargetConfig('c6-target'), { ownerId: 'a' })
    await expect(m.query('c6-target', 'DELETE FROM t')).rejects.toThrow(/generic raw query is disabled/)
    await expect(m.delete('c6-target', 't', { id: 1 })).rejects.toThrow(/generic delete is unsupported/)
  })

  it('rejects generic copy/federated helper paths on a C6 write-gated target before connecting', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlConfig('rw-source', false), { ownerId: 'a' })
    await m.addDataSource(sqlConfig('rw-target', false), { ownerId: 'a' })
    await m.addDataSource(c6WriteTargetConfig('c6-target'), { ownerId: 'a' })
    const connectSpy = vi.spyOn(m, 'connectDataSource')

    await expect(m.copyData('rw-source', 'src', 'c6-target', 'dst')).rejects.toThrow(/generic copy is unsupported/)
    await expect(m.copyData('c6-target', 'src', 'rw-target', 'dst')).rejects.toThrow(/generic raw query is disabled/)
    await expect(m.federatedQuery([
      { dataSourceId: 'c6-target', sql: 'SELECT * FROM target_table', alias: 'target' },
    ])).rejects.toThrow(/generic raw query is disabled/)
    expect(connectSpy).not.toHaveBeenCalled()
    connectSpy.mockRestore()
  })
})

describe('data-sources /query read-only gate (A-RO)', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    req.authenticatedTenantId = currentUser ? 'tenant-readonly-query' : undefined
    next()
  })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })

  it('rejects write SQL on a read-only SQL source with 403 READ_ONLY', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(sqlConfig('ro-sql'))
    const res = await request(pinned.url()).post('/api/data-sources/ro-sql/query').send({ sql: 'DELETE FROM t' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })

  it('disables the raw query path entirely for a read-only non-SQL source', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(httpConfig('ro-http'))
    const res = await request(pinned.url()).post('/api/data-sources/ro-http/query').send({ sql: 'GET /whatever' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })

  it('disables raw /query for a C6 write-gated target before SQL execution', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(c6WriteTargetConfig('c6-route-target'))
    const querySpy = vi.spyOn(DataSourceManager.prototype, 'query')
    const res = await request(pinned.url())
      .post('/api/data-sources/c6-route-target/query')
      .send({ sql: 'DELETE FROM target_table WHERE id = 1' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('DATA_SOURCE_C6_WRITE_TARGET_QUERY_DISABLED')
    expect(querySpy).not.toHaveBeenCalled()
    querySpy.mockRestore()
  })
})

describe('data-sources /query and /select — a typed gate refusal surfaces coded, not as a 500', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    req.authenticatedTenantId = currentUser ? 'tenant-readonly-refusal' : undefined
    next()
  })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })

  function sqlserverWritableConfig(id: string): DataSourceConfig {
    return {
      id,
      name: id,
      type: 'sqlserver',
      connection: { host: 'db.local', port: 1433, database: 'STAGE' },
      options: { autoConnect: false, readOnly: false },
    }
  }

  it('a default-deny SQL-write refusal via /query returns the gate own 403 + code (RED: was 500 QUERY_ERROR)', async () => {
    const savedEnv = process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV]
    delete process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV] // gate shut ⇒ every write refused, typed
    try {
      currentUser = admin('alice')
      pinned.setApp(app)
      await request(pinned.url()).post('/api/data-sources').send(sqlserverWritableConfig('gate-coded'))
      const res = await request(pinned.url())
        .post('/api/data-sources/gate-coded/query')
        .send({ sql: 'INSERT INTO staging (a) VALUES (1)' })
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
      expect(res.body.error.code).not.toBe('QUERY_ERROR')
    } finally {
      if (savedEnv === undefined) delete process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV]
      else process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV] = savedEnv
    }
  })

  it('a plain SQL failure via /query still returns 500 QUERY_ERROR (genuine failures keep their shape)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(sqlserverWritableConfig('query-500'))
    const querySpy = vi.spyOn(DataSourceManager.prototype, 'query')
      .mockRejectedValue(new Error('Incorrect syntax near the keyword FRUM'))
    try {
      const res = await request(pinned.url())
        .post('/api/data-sources/query-500/query')
        .send({ sql: 'SELECT * FRUM t' })
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('QUERY_ERROR')
    } finally {
      querySpy.mockRestore()
    }
  })

  it('/select: a typed status+code refusal surfaces verbatim; a plain failure stays 500 SELECT_ERROR', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(sqlserverWritableConfig('select-shapes'))

    const typed = vi.spyOn(DataSourceManager.prototype, 'select').mockRejectedValue(
      Object.assign(new Error('this data source is not authorized for generic outbound SQL write'), {
        status: 403,
        code: 'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED',
        details: {},
      })
    )
    try {
      const res = await request(pinned.url())
        .post('/api/data-sources/select-shapes/select')
        .send({ table: 't' })
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED')
    } finally {
      typed.mockRestore()
    }

    const plain = vi.spyOn(DataSourceManager.prototype, 'select')
      .mockRejectedValue(new Error('connection reset'))
    try {
      const res = await request(pinned.url())
        .post('/api/data-sources/select-shapes/select')
        .send({ table: 't' })
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('SELECT_ERROR')
    } finally {
      plain.mockRestore()
    }
  })
})

describe('data-sources PUT deep-merge (A-RO)', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    req.authenticatedTenantId = currentUser ? 'tenant-readonly-update' : undefined
    next()
  })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })

  it('G-4 marker durability: PUT cannot clear k3Destination once set (coded 403)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    // Register a source declared to be a K3 destination.
    await request(pinned.url())
      .post('/api/data-sources')
      .send({ ...sqlConfig('k3-durable', false), options: { autoConnect: false, readOnly: false, k3Destination: true } })

    // The #5401 config-edit vector: try to clear the marker via PUT.
    const cleared = await request(pinned.url())
      .put('/api/data-sources/k3-durable')
      .send({ options: { k3Destination: false } })
    expect(cleared.status).toBe(403)
    expect(cleared.body.error.code).toBe('K3_DESTINATION_MARKER_IMMUTABLE')

    // The marker is intact — the source is still a K3 destination.
    const got = await request(pinned.url()).get('/api/data-sources/k3-durable')
    expect(got.body.data.options).toMatchObject({ k3Destination: true })

    // An unrelated edit that does NOT touch the marker still succeeds and preserves it.
    const other = await request(pinned.url()).put('/api/data-sources/k3-durable').send({ options: { timeout: 7 } })
    expect(other.status).toBe(200)
    const after = await request(pinned.url()).get('/api/data-sources/k3-durable')
    expect(after.body.data.options).toMatchObject({ k3Destination: true, timeout: 7 })
  })

  it('a partial options update preserves sibling option keys', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/data-sources')
      .send({ ...sqlConfig('pm'), options: { autoConnect: true, readOnly: false } })

    const put = await request(pinned.url()).put('/api/data-sources/pm').send({ options: { timeout: 5 } })
    expect(put.status).toBe(200)

    const got = await request(pinned.url()).get('/api/data-sources/pm')
    expect(got.status).toBe(200)
    // shallow merge would have wiped readOnly/autoConnect; deep merge keeps them
    expect(got.body.data.options).toMatchObject({ autoConnect: true, readOnly: false, timeout: 5 })
  })

  it('a partial connection update preserves hidden security keys (P1 regression)', async () => {
    currentUser = admin('alice')
    // A source whose connection carries security-sensitive keys an edit UI does NOT surface.
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send({
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
    const put = await request(pinned.url()).put('/api/data-sources/tlsmerge').send({ connection: { host: 'new-host' } })
    expect(put.status).toBe(200)

    const got = await request(pinned.url()).get('/api/data-sources/tlsmerge')
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
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send({
      id: 'rotate-creds', name: 'rotate-creds', type: 'postgres',
      connection: { host: 'db', database: 'erp' },
      credentials: { username: 'old-user', password: 'old-password', apiKey: 'kept-key' },
      options: { autoConnect: false, readOnly: true },
    })

    const put = await request(pinned.url())
      .put('/api/data-sources/rotate-creds/credentials')
      .send({ credentials: { password: 'new-password' } })
    expect(put.status).toBe(200)
    expect(put.body.data).not.toHaveProperty('credentials')
    expect(put.body.data.hasCredentials).toBe(true)

    const got = await request(pinned.url()).get('/api/data-sources/rotate-creds')
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
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send({
      id: 'rotate-empty', name: 'rotate-empty', type: 'postgres',
      connection: { host: 'db', database: 'erp' },
      credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false, readOnly: true },
    })

    const empty = await request(pinned.url())
      .put('/api/data-sources/rotate-empty/credentials')
      .send({ credentials: {} })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('VALIDATION_ERROR')

    const blank = await request(pinned.url())
      .put('/api/data-sources/rotate-empty/credentials')
      .send({ credentials: { password: '' } })
    expect(blank.status).toBe(400)
    expect(blank.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('scopes credential rotation to the source owner (non-admin denied; admins may — by design)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send({
      id: 'rotate-scope', name: 'rotate-scope', type: 'postgres',
      connection: { host: 'db', database: 'erp' },
      credentials: { username: 'u', password: 'alice-password' },
      options: { autoConnect: false, readOnly: true },
    })

    // bob is a NON-ADMIN holding the global write code: rbacGuard passes, the
    // manager's ownership scope must still refuse with the uniform 404.
    currentUser = { id: 'bob', roles: ['member'], permissions: ['data_sources:write'] } as never
    const denied = await request(pinned.url())
      .put('/api/data-sources/rotate-scope/credentials')
      .send({ credentials: { password: 'bob-password' } })
    expect(denied.status).toBe(404)

    const config = getDataSourceManager().getDataSource('rotate-scope').getConfig()
    expect(config.credentials?.password).toBe('alice-password')
  })
})
