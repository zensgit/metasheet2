/**
 * data_sources visibility/authority model — actor x capability matrix (mock db, no real dialing).
 *
 * Register style follows tests/unit/multitable-manage-schema-permission-matrix.test.ts: explicit
 * actor tiers, EXACT statuses per cell, negative controls asserted as first-class cells, one pinned
 * listener for the whole file (the repo bans request(app) — supertest-app-mode-tripwire).
 *
 * WHAT IS UNDER TEST — the authority redesign:
 *   - OWNER keeps full control of their sources (unchanged capabilities).
 *   - PLATFORM ADMIN (the rbac global-admin tier that already bypasses every `data_sources:*`
 *     rbacGuard) gains MANAGEMENT of every source: list/see (name/type/status/owner — never
 *     credentials), test, connect/disconnect, edit non-secret config, rotate credentials
 *     (write-only), delete. Previously DataSourceManager.assertAccess stopped this tier with the
 *     uniform 404 — the manager was misaligned with the permission model.
 *   - NON-ADMIN NON-OWNER: unchanged — the same uniform 404 on every route, no existence leak.
 *     THIS NEGATIVE CONTROL IS THE POINT: the expansion must not leak sideways.
 *   - DATA PLANE (/query /select /schema /tables) stays OWNER-ONLY for every tier including
 *     admins: managing a connection is not silent access to the customer data behind it.
 *   - CREDENTIALS are write-only for EVERY tier (poison-value sweep over every response body and
 *     every audit row).
 *   - DELETE gains a referential guard: 409 (coded, naming the reference COUNT) while any
 *     integration_external_systems.config->>'dataSourceId' references the source; force=true is
 *     platform-admin only and audited as a deliberate reference break.
 *
 * ACTOR TIERS
 *   T1 admin    { role: 'admin' }                        — the management tier (also T1b via roles[])
 *   T2 owner    member + data_sources:* permission codes — created the source
 *   T3 other    member + the SAME permission codes       — passes rbacGuard, must still see 404s
 *   T4 anonymous                                          — 401 from rbacGuard
 */
import express from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// auditLog writes to the DB; record calls in-memory instead (assertions below inspect them).
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))
// rbacGuard consults these for non-admin users; make them deterministic (no DB in unit tests).
// req.user.permissions carries the grants; namespace admission is not the surface under test.
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

import { BaseDataAdapter } from '../../src/data-adapters/BaseAdapter'
import type {
  ColumnInfo,
  DataSourceConfig,
  DbValue,
  QueryResult,
  SchemaInfo,
  TableInfo,
  Transaction,
} from '../../src/data-adapters/BaseAdapter'
import {
  DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE,
  DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
  DataSourceManager,
} from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter, initializeDataSourceManager } from '../../src/routes/data-sources'
import { auditLog } from '../../src/audit/audit'
import { usePinnedServer } from '../utils/pinned-server'

const auditMock = vi.mocked(auditLog)

// ── actors ─────────────────────────────────────────────────────────────────────

const DS_PERMS = ['data_sources:read', 'data_sources:write', 'data_sources:execute']

const ADMIN = { id: 'u_dsv_admin', role: 'admin' }
const ADMIN_VIA_ROLES = { id: 'u_dsv_admin2', roles: ['admin', 'member'] }
const OWNER = { id: 'u_dsv_owner', roles: ['member'], permissions: DS_PERMS }
const OTHER = { id: 'u_dsv_other', roles: ['member'], permissions: DS_PERMS }

// ── poison values: if ANY of these ever appears in ANY response body or audit row, credentials
//    stopped being write-only. (Values chosen to be un-collidable with generated output.)
const POISON = {
  username: 'POISON-username-51c9f7ab30de',
  password: 'POISON-password-9f2e71c04ab8',
  apiKey: 'POISON-apikey-3d84ba6ef192',
  token: 'POISON-token-7a15cc98d40f',
  rotatedPassword: 'POISON-rotated-e6b20d97f3a1',
}
const POISON_VALUES = Object.values(POISON)

// ── fake db bound to the route singleton: empty data_sources at load; a controllable
//    integration_external_systems reference count keyed by data source id. ─────
const externalRefCounts = new Map<string, number>()
const refCountQueriedIds: string[] = []

function fakeDb() {
  return {
    selectFrom: (table: string) => {
      if (table === 'integration_external_systems') {
        let capturedId: string | undefined
        const b = {
          select: () => b,
          where: (_lhs: unknown, _op: unknown, value: unknown) => {
            capturedId = String(value)
            return b
          },
          execute: async () => {
            refCountQueriedIds.push(capturedId ?? '')
            return [{ count: externalRefCounts.get(capturedId ?? '') ?? 0 }]
          },
        }
        return b
      }
      const b = { selectAll: () => b, where: () => b, execute: async () => [] }
      return b
    },
    insertInto: () => {
      const b = { values: () => b, onConflict: () => b, execute: async () => [] }
      return b
    },
    updateTable: () => {
      const b = { set: () => b, where: () => b, execute: async () => [] }
      return b
    },
    deleteFrom: () => {
      const b = { where: () => b, execute: async () => [] }
      return b
    },
  }
}

// ── fake adapter (no dialing): overrides the singleton's 'postgres' registration so sources
//    created through the real POST route never open a socket. ──────────────────
abstract class FakeBase extends BaseDataAdapter {
  async query<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async select<T = Record<string, DbValue>>(): Promise<QueryResult<T>> {
    return { data: [{ ok: 1 } as never] }
  }
  async insert<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async update<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async delete<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async getSchema(): Promise<SchemaInfo> { return { tables: [] } }
  async getTableInfo(): Promise<TableInfo> { return { name: 't', columns: [] } }
  async getColumns(): Promise<ColumnInfo[]> { return [] }
  async tableExists(): Promise<boolean> { return false }
  async beginTransaction(): Promise<Transaction> { return {} as Transaction }
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async inTransaction<R = unknown>(_t: Transaction, cb: () => Promise<R>): Promise<R> { return cb() }
  async *stream<T = Record<string, DbValue>>(): AsyncIterableIterator<T> { /* no rows */ }
}
class OkAdapter extends FakeBase {
  async connect(): Promise<void> { this.connected = true; await this.onConnect() }
  async disconnect(): Promise<void> { this.connected = false; await this.onDisconnect() }
  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return true }
}

// ── app harness: one app, mutable request user, pinned listener ────────────────

let currentUser: Record<string, unknown> | undefined
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = currentUser as never
  next()
})
app.use(dataSourcesRouter())

const pinned = usePinnedServer()

function as(user: Record<string, unknown> | undefined) {
  currentUser = user
  pinned.setApp(app)
  return request(pinned.url())
}

function expectNoPoison(body: unknown): void {
  const text = JSON.stringify(body)
  for (const value of POISON_VALUES) {
    expect(text).not.toContain(value)
  }
}

function notFoundBody(id: string) {
  return { ok: false, error: { code: 'NOT_FOUND', message: `Data source '${id}' not found` } }
}

function sourcePayload(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'db.internal.example', port: 5432, database: 'plm' },
    credentials: {
      username: POISON.username,
      password: POISON.password,
      apiKey: POISON.apiKey,
      token: POISON.token,
    },
    options: { autoConnect: false },
  }
}

async function createAsOwner(id: string): Promise<void> {
  const res = await as(OWNER).post('/api/data-sources').send(sourcePayload(id))
  expect(res.status).toBe(201)
  expectNoPoison(res.body)
}

function auditCalls(action?: string, resourceId?: string) {
  return auditMock.mock.calls
    .map(([opts]) => opts)
    .filter((o) => (action === undefined || o.action === action) && (resourceId === undefined || o.resourceId === resourceId))
}

beforeAll(async () => {
  const manager = await initializeDataSourceManager(fakeDb() as never)
  // No real dialing in unit tests: the route only accepts SUPPORTED types, so
  // override the registered postgres adapter with the in-memory fake.
  manager.registerAdapterType('postgres', OkAdapter as never)
})

// ── the matrix ─────────────────────────────────────────────────────────────────

describe('data_sources authority matrix — detail (GET /api/data-sources/:id)', () => {
  const ID = 'dsv-detail'

  it('owner => 200 with ownerId, credentials stripped (hasCredentials only)', async () => {
    await createAsOwner(ID)
    const res = await as(OWNER).get(`/api/data-sources/${ID}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(ID)
    expect(res.body.data.ownerId).toBe(OWNER.id)
    expect(res.body.data.credentials).toBeUndefined()
    expect(res.body.data.hasCredentials).toBe(true)
    expectNoPoison(res.body)
  })

  it('THE EXPANSION: platform admin (role) => 200 with owner attribution, audited as cross-owner read', async () => {
    const res = await as(ADMIN).get(`/api/data-sources/${ID}`)
    expect(res.status).toBe(200)
    expect(res.body.data.ownerId).toBe(OWNER.id)
    expect(res.body.data.credentials).toBeUndefined()
    expectNoPoison(res.body)

    const reads = auditCalls('read', ID)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.at(-1)).toMatchObject({
      actorId: ADMIN.id,
      resourceType: 'data_source',
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true },
    })
  })

  it('platform admin via roles[] array => 200 (both request-user admin shapes count)', async () => {
    const res = await as(ADMIN_VIA_ROLES).get(`/api/data-sources/${ID}`)
    expect(res.status).toBe(200)
    expect(res.body.data.ownerId).toBe(OWNER.id)
  })

  it('NEGATIVE CONTROL: non-admin non-owner => the uniform 404, byte-identical to a missing id', async () => {
    const denied = await as(OTHER).get(`/api/data-sources/${ID}`)
    expect(denied.status).toBe(404)
    expect(denied.body).toEqual(notFoundBody(ID))

    const missing = await as(OTHER).get('/api/data-sources/dsv-does-not-exist')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual(notFoundBody('dsv-does-not-exist'))
    // Same shape either way — existence is not leaked by wording.
    expect(Object.keys(denied.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
  })

  it('anonymous => 401 from rbacGuard', async () => {
    const res = await as(undefined).get(`/api/data-sources/${ID}`)
    expect(res.status).toBe(401)
  })
})

describe('data_sources authority matrix — listing and health', () => {
  const ID = 'dsv-list'

  it('owner list contains own source; admin list contains it WITH ownerId; other list omits it', async () => {
    await createAsOwner(ID)

    const owner = await as(OWNER).get('/api/data-sources')
    expect(owner.status).toBe(200)
    const ownerItems = owner.body.data.items as Array<{ id: string; ownerId?: string }>
    expect(ownerItems.map((i) => i.id)).toContain(ID)
    expectNoPoison(owner.body)

    const admin = await as(ADMIN).get('/api/data-sources')
    expect(admin.status).toBe(200)
    const adminItems = admin.body.data.items as Array<{ id: string; ownerId?: string }>
    const seen = adminItems.find((i) => i.id === ID)
    expect(seen).toBeDefined()
    expect(seen?.ownerId).toBe(OWNER.id)
    expectNoPoison(admin.body)

    const other = await as(OTHER).get('/api/data-sources')
    expect(other.status).toBe(200)
    expect((other.body.data.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(ID)
  })

  it("health follows the same scoping: admin sees the owner's source, other does not", async () => {
    const admin = await as(ADMIN).get('/api/data-sources/health')
    expect(admin.status).toBe(200)
    expect((admin.body.data.items as Array<{ id: string }>).map((i) => i.id)).toContain(ID)

    const other = await as(OTHER).get('/api/data-sources/health')
    expect(other.status).toBe(200)
    expect((other.body.data.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(ID)
  })

  it('anonymous list => 401', async () => {
    const res = await as(undefined).get('/api/data-sources')
    expect(res.status).toBe(401)
  })
})

describe('data_sources authority matrix — test / connect / disconnect', () => {
  const ID = 'dsv-conn'

  it("admin can test another owner's source (200), audited with actor + owner; other gets 404", async () => {
    await createAsOwner(ID)

    const admin = await as(ADMIN).get(`/api/data-sources/${ID}/test`)
    expect(admin.status).toBe(200)
    expect(admin.body.data.success).toBe(true)
    expectNoPoison(admin.body)
    expect(auditCalls('test', ID).at(-1)).toMatchObject({
      actorId: ADMIN.id,
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true, success: true },
    })

    const other = await as(OTHER).get(`/api/data-sources/${ID}/test`)
    expect(other.status).toBe(404)
    expect(other.body).toEqual(notFoundBody(ID))
  })

  it('owner test emits NO cross-owner audit row (owner path unchanged)', async () => {
    const before = auditCalls('test', ID).length
    const res = await as(OWNER).get(`/api/data-sources/${ID}/test`)
    expect(res.status).toBe(200)
    expect(auditCalls('test', ID).length).toBe(before)
  })

  it('admin connect + disconnect => 200 each, audited; other => 404 each', async () => {
    const connect = await as(ADMIN).post(`/api/data-sources/${ID}/connect`)
    expect(connect.status).toBe(200)
    expect(auditCalls('connect', ID).at(-1)).toMatchObject({
      actorId: ADMIN.id,
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true },
    })

    const disconnect = await as(ADMIN).post(`/api/data-sources/${ID}/disconnect`)
    expect(disconnect.status).toBe(200)
    expect(auditCalls('disconnect', ID).at(-1)).toMatchObject({
      actorId: ADMIN.id,
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true },
    })

    expect((await as(OTHER).post(`/api/data-sources/${ID}/connect`)).status).toBe(404)
    expect((await as(OTHER).post(`/api/data-sources/${ID}/disconnect`)).status).toBe(404)
  })
})

describe('data_sources authority matrix — edit and credential rotation', () => {
  const ID = 'dsv-edit'

  it("admin edits non-secret config of another owner's source; OWNERSHIP IS PRESERVED", async () => {
    await createAsOwner(ID)

    const put = await as(ADMIN).put(`/api/data-sources/${ID}`).send({ name: 'renamed-by-admin' })
    expect(put.status).toBe(200)
    expect(put.body.data.name).toBe('renamed-by-admin')
    expectNoPoison(put.body)
    expect(auditCalls('update', ID).at(-1)).toMatchObject({
      actorId: ADMIN.id,
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true },
    })

    // The admin edit must NOT have captured ownership.
    const asOwner = await as(OWNER).get(`/api/data-sources/${ID}`)
    expect(asOwner.status).toBe(200)
    expect(asOwner.body.data.ownerId).toBe(OWNER.id)
    // ...and must not have opened the source to third parties.
    expect((await as(OTHER).get(`/api/data-sources/${ID}`)).status).toBe(404)
  })

  it('admin rotates credentials WRITE-ONLY: 200, no credential value in response or audit trail', async () => {
    const res = await as(ADMIN)
      .put(`/api/data-sources/${ID}/credentials`)
      .send({ credentials: { password: POISON.rotatedPassword } })
    expect(res.status).toBe(200)
    expectNoPoison(res.body)

    const call = auditCalls('update_credentials', ID).at(-1)
    expect(call).toMatchObject({
      actorId: ADMIN.id,
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true, changedCredentialKeys: ['password'] },
    })
    // key NAMES may be audited; VALUES never.
    expectNoPoison(call)
  })

  it('other => 404 on both edit routes; anonymous => 401', async () => {
    expect((await as(OTHER).put(`/api/data-sources/${ID}`).send({ name: 'x' })).status).toBe(404)
    expect(
      (await as(OTHER).put(`/api/data-sources/${ID}/credentials`).send({ credentials: { password: 'x' } })).status,
    ).toBe(404)
    expect((await as(undefined).put(`/api/data-sources/${ID}`).send({ name: 'x' })).status).toBe(401)
  })
})

describe('data_sources referential delete guard', () => {
  it('owner deletes an UNREFERENCED source => 200 removed (unchanged owner capability)', async () => {
    const ID = 'dsv-del-free'
    await createAsOwner(ID)
    const res = await as(OWNER).delete(`/api/data-sources/${ID}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: ID, removed: true })
    // The guard consulted the reference table for exactly this id.
    expect(refCountQueriedIds).toContain(ID)
  })

  it('REFERENCED source: owner delete => coded 409 naming the COUNT and the force escape hatch; source survives', async () => {
    const ID = 'dsv-del-ref'
    await createAsOwner(ID)
    externalRefCounts.set(ID, 2)

    const res = await as(OWNER).delete(`/api/data-sources/${ID}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE)
    expect(res.body.error.message).toContain('2 external system')
    expect(res.body.error.message).toContain('force=true')
    expect(res.body.error.details).toEqual({ referenceCount: 2 })
    // Count, not config: the refusal carries ONLY code/message/details.referenceCount —
    // nothing from the referencing systems' configuration rides along.
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'details', 'message'])
    expect(Object.keys(res.body.error.details)).toEqual(['referenceCount'])

    expect((await as(OWNER).get(`/api/data-sources/${ID}`)).status).toBe(200)
  })

  it('force=true is ADMIN-ONLY: the owner is refused 403 and the source survives', async () => {
    const ID = 'dsv-del-ref'
    const res = await as(OWNER).delete(`/api/data-sources/${ID}?force=true`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe(DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE)
    expect((await as(OWNER).get(`/api/data-sources/${ID}`)).status).toBe(200)
  })

  it('admin WITHOUT force => the same 409 (force must be explicit, admin or not)', async () => {
    const ID = 'dsv-del-ref'
    const res = await as(ADMIN).delete(`/api/data-sources/${ID}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE)
  })

  it('stranger delete on a referenced source (force included) => uniform 404 — access precedes referential detail', async () => {
    const ID = 'dsv-del-ref'
    const res = await as(OTHER).delete(`/api/data-sources/${ID}?force=true`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual(notFoundBody(ID))
  })

  it('admin WITH force=true => 200, audited as a deliberate reference break with actor + owner + count', async () => {
    const ID = 'dsv-del-ref'
    const res = await as(ADMIN).delete(`/api/data-sources/${ID}?force=true`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: ID, removed: true })

    expect(auditCalls('delete', ID).at(-1)).toMatchObject({
      actorId: ADMIN.id,
      meta: {
        ownerId: OWNER.id,
        crossOwnerAdmin: true,
        forcedReferenceBreak: true,
        referenceCount: 2,
      },
    })

    currentUser = OWNER
    expect((await as(OWNER).get(`/api/data-sources/${ID}`)).status).toBe(404)
  })

  it('anonymous delete => 401', async () => {
    expect((await as(undefined).delete('/api/data-sources/dsv-del-ref')).status).toBe(401)
  })
})

describe('data plane stays OWNER-ONLY — admin management is not data access', () => {
  const ID = 'dsv-plane'

  it('owner keeps the data plane: /select answers 200', async () => {
    await createAsOwner(ID)
    const res = await as(OWNER).post(`/api/data-sources/${ID}/select`).send({ table: 't' })
    expect(res.status).toBe(200)
  })

  it("platform admin gets the uniform 404 on /query /select /schema /tables of another owner's source", async () => {
    const query = await as(ADMIN).post(`/api/data-sources/${ID}/query`).send({ sql: 'SELECT 1' })
    expect(query.status).toBe(404)
    expect(query.body).toEqual(notFoundBody(ID))

    expect((await as(ADMIN).post(`/api/data-sources/${ID}/select`).send({ table: 't' })).status).toBe(404)
    expect((await as(ADMIN).get(`/api/data-sources/${ID}/schema`)).status).toBe(404)
    expect((await as(ADMIN).get(`/api/data-sources/${ID}/tables/t`)).status).toBe(404)
  })

  it('non-admin non-owner: 404 across the data plane too', async () => {
    expect((await as(OTHER).post(`/api/data-sources/${ID}/query`).send({ sql: 'SELECT 1' })).status).toBe(404)
    expect((await as(OTHER).post(`/api/data-sources/${ID}/select`).send({ table: 't' })).status).toBe(404)
    expect((await as(OTHER).get(`/api/data-sources/${ID}/schema`)).status).toBe(404)
    expect((await as(OTHER).get(`/api/data-sources/${ID}/tables/t`)).status).toBe(404)
  })
})

describe('poison sweep — credentials are write-only for EVERY tier, everywhere', () => {
  it('no credential value ever appeared in any audit row of this whole file', () => {
    expectNoPoison(auditMock.mock.calls)
  })

  it('every cross-owner audit row names an admin actor and the true owner', () => {
    const crossOwner = auditMock.mock.calls
      .map(([o]) => o)
      .filter((o) => (o.meta as Record<string, unknown> | undefined)?.crossOwnerAdmin === true)
    expect(crossOwner.length).toBeGreaterThan(0)
    for (const call of crossOwner) {
      expect([ADMIN.id, ADMIN_VIA_ROLES.id]).toContain(call.actorId)
      expect((call.meta as Record<string, unknown>).ownerId).toBe(OWNER.id)
    }
  })
})

// ── manager-level semantics (the single choke point other branches inherit) ────

describe('DataSourceManager.assertAccess — actor semantics', () => {
  function pgConfig(id: string): DataSourceConfig {
    return {
      id,
      name: id,
      type: 'postgres',
      connection: { host: 'localhost', port: 5432, database: 'x' },
      options: { autoConnect: false },
    }
  }

  it('bare-string shape stays OWNER-ONLY (data-plane call sites inherit no admin bypass)', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('m1'), { ownerId: 'alice' })
    expect(() => m.assertAccess('m1', 'alice')).not.toThrow()
    // even the admin's own user id, passed as a bare string, is just a user id
    expect(() => m.assertAccess('m1', 'u_dsv_admin')).toThrow(/not found/)
    expect(() => m.assertAccess('m1', undefined)).toThrow(/not found/)
  })

  it('actor-context shape: platformAdmin passes on existing sources; plain context stays owner-scoped', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('m2'), { ownerId: 'alice' })
    expect(() => m.assertAccess('m2', { userId: 'root', platformAdmin: true })).not.toThrow()
    expect(() => m.assertAccess('m2', { userId: 'alice' })).not.toThrow()
    expect(() => m.assertAccess('m2', { userId: 'bob' })).toThrow(/not found/)
    expect(() => m.assertAccess('m2', { userId: 'bob', platformAdmin: false })).toThrow(/not found/)
    expect(() => m.assertAccess('m2', {})).toThrow(/not found/)
  })

  it('a platform admin probing a MISSING id gets the identical not-found', () => {
    const m = new DataSourceManager()
    expect(() => m.assertAccess('missing', { userId: 'root', platformAdmin: true })).toThrow(
      /Data source with id 'missing' not found/,
    )
  })

  it('listDataSources actor scoping: admin unscoped with ownerId attribution; member own-only; empty actor sees nothing', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('la'), { ownerId: 'alice' })
    await m.addDataSource(pgConfig('lb'), { ownerId: 'bob' })

    const admin = m.listDataSources({ actor: { userId: 'root', platformAdmin: true } })
    expect(admin.map((s) => s.id).sort()).toEqual(['la', 'lb'])
    expect(admin.find((s) => s.id === 'la')?.ownerId).toBe('alice')
    expect(admin.find((s) => s.id === 'lb')?.ownerId).toBe('bob')

    expect(m.listDataSources({ actor: { userId: 'alice' } }).map((s) => s.id)).toEqual(['la'])
    expect(m.listDataSources({ actor: {} })).toEqual([])
    // legacy filter shape unchanged
    expect(m.listDataSources({ ownerId: 'bob' }).map((s) => s.id)).toEqual(['lb'])
  })

  it('healthCheck actor scoping matches the listing', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('ha'), { ownerId: 'alice' })
    await m.addDataSource(pgConfig('hb'), { ownerId: 'bob' })
    expect([...(await m.healthCheck({ actor: { userId: 'root', platformAdmin: true } })).keys()].sort()).toEqual(['ha', 'hb'])
    expect([...(await m.healthCheck({ actor: { userId: 'alice' } })).keys()]).toEqual(['ha'])
    expect([...(await m.healthCheck({ actor: {} })).keys()]).toEqual([])
  })
})

describe('DataSourceManager.countExternalSystemReferences', () => {
  it('no bound db => 0 (memory-only manager: nothing persisted can reference it)', async () => {
    const m = new DataSourceManager()
    await expect(m.countExternalSystemReferences('any')).resolves.toBe(0)
  })

  it('counts rows for exactly the requested id through the bound db', async () => {
    const m = new DataSourceManager({ db: fakeDb() as never })
    externalRefCounts.set('counted-src', 3)
    await expect(m.countExternalSystemReferences('counted-src')).resolves.toBe(3)
    expect(refCountQueriedIds).toContain('counted-src')
  })

  it('missing integration schema (undefined_table) => 0; any OTHER failure propagates (delete fails closed)', async () => {
    const schemaError = Object.assign(new Error('relation "integration_external_systems" does not exist'), {
      code: '42P01',
    })
    const throwingDb = (err: Error) => ({
      selectFrom: () => {
        const b = { select: () => b, where: () => b, execute: async () => { throw err } }
        return b
      },
    })

    const degraded = new DataSourceManager({ db: throwingDb(schemaError) as never })
    await expect(degraded.countExternalSystemReferences('x')).resolves.toBe(0)

    const broken = new DataSourceManager({ db: throwingDb(new Error('connection reset by peer')) as never })
    await expect(broken.countExternalSystemReferences('x')).rejects.toThrow(/connection reset/)
  })
})
