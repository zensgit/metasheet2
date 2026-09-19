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
 *     integration_external_systems canonical or attributable legacy binding references the
 *     source; force=true is platform-admin only and audited as a deliberate reference break.
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
import { dataSourcesRouter, getDataSourceManager, initializeDataSourceManager } from '../../src/routes/data-sources'
import { auditLog } from '../../src/audit/audit'
import { Logger } from '../../src/core/logger'
import { usePinnedServer } from '../utils/pinned-server'

const auditMock = vi.mocked(auditLog)

// ── actors ─────────────────────────────────────────────────────────────────────

const DS_PERMS = ['data_sources:read', 'data_sources:write', 'data_sources:execute']

const ADMIN = { id: 'u_dsv_admin', role: 'admin' }
const ADMIN_VIA_ROLES = { id: 'u_dsv_admin2', roles: ['admin', 'member'] }
const OWNER = { id: 'u_dsv_owner', roles: ['member'], permissions: DS_PERMS }
const OTHER = { id: 'u_dsv_other', roles: ['member'], permissions: DS_PERMS }

// G02 PR-1 — `PUT /:id/credentials` moved off `data_sources:write` onto `data_sources:rotate`,
// EXCLUSIVELY (src/routes/data-sources.ts:738). DS_PERMS above is deliberately LEFT as today's
// write-holder vocabulary, so this file keeps a live specimen of the tier that LOSES rotation. The
// variants below are the SAME user ids with `rotate` added, because ownership is an id comparison
// and the fine gate (`assertAccess`) must see no difference between them — that is what makes the
// pair "write-only => 403 / rotate => 200" attributable to the coarse door and nothing else.
const DS_PERMS_WITH_ROTATE = [...DS_PERMS, 'data_sources:rotate']
const OWNER_WITH_ROTATE = { ...OWNER, permissions: DS_PERMS_WITH_ROTATE }
const OTHER_WITH_ROTATE = { ...OTHER, permissions: DS_PERMS_WITH_ROTATE }

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
//    integration_external_systems reference table. Rows can carry either the canonical FK or the
//    legacy pointer plus server-side attribution stamp. The fake models the two non-overlapping
//    COUNT queries used during migration (canonical; then connection_id IS NULL + legacy). ─────
const externalRefRows: Array<{ connectionId?: string | null; dataSourceId: string; ownerId: string }> = []
const refCountQueriedIds: string[] = []
// Every GROUPED (batch) reference-count query this fake served, in order. The
// listing surface must issue exactly ONE canonical + ONE legacy grouped query
// per request no matter how many sources are listed — this is the N+1 probe.
const groupedRefQueries: Array<{ kind: 'canonical' | 'legacy'; ids: string[] }> = []

function fakeDb() {
  return {
    selectFrom: (table: string) => {
      if (table === 'integration_external_systems') {
        const captured: Array<{ lhs: unknown; op: unknown; value: unknown }> = []
        const b = {
          select: () => b,
          groupBy: () => b,
          where: (lhs: unknown, op: unknown, value: unknown) => {
            captured.push({ lhs, op, value })
            return b
          },
          execute: async () => {
            const first = captured[0]
            if (first?.lhs === 'connection_id' && first.op === '=') {
              const id = String(first.value)
              refCountQueriedIds.push(id)
              const count = externalRefRows.filter((r) => r.connectionId === id).length
              return [{ count }]
            }

            if (first?.lhs === 'connection_id' && first.op === 'in') {
              // BATCH canonical: ONE grouped query covering every requested id.
              const ids = (first.value as string[]).map(String)
              groupedRefQueries.push({ kind: 'canonical', ids: [...ids] })
              const grouped = new Map<string, number>()
              for (const r of externalRefRows) {
                if (r.connectionId == null || !ids.includes(r.connectionId)) continue
                grouped.set(r.connectionId, (grouped.get(r.connectionId) ?? 0) + 1)
              }
              return [...grouped].map(([reference_id, count]) => ({ reference_id, count }))
            }

            expect(first).toMatchObject({ lhs: 'connection_id', op: 'is', value: null })

            if (captured[1]?.op === 'in') {
              // BATCH legacy: connection_id IS NULL + dataSourceId IN (...), grouped by the
              // (dataSourceId, dataSourceOwnerId) PAIR. This fake deliberately does NOT filter
              // by owner — it hands back every pair — so a batch implementation that dropped the
              // owner attribution would visibly over-count a foreign pin (P2-A stays observable).
              expect(captured.length).toBe(2)
              const ids = (captured[1]?.value as string[]).map(String)
              groupedRefQueries.push({ kind: 'legacy', ids: [...ids] })
              const grouped: Array<{ reference_id: string; reference_owner_id: string; count: number }> = []
              for (const r of externalRefRows) {
                if (r.connectionId != null || !ids.includes(r.dataSourceId)) continue
                const hit = grouped.find((g) => g.reference_id === r.dataSourceId && g.reference_owner_id === r.ownerId)
                if (hit) hit.count += 1
                else grouped.push({ reference_id: r.dataSourceId, reference_owner_id: r.ownerId, count: 1 })
              }
              return grouped
            }

            // The SINGULAR legacy query must retain BOTH attribution predicates after its
            // connection_id IS NULL discriminator.
            expect(captured.length).toBe(3)
            const id = String(captured[1]?.value ?? '')
            const owner = String(captured[2]?.value ?? '')
            const count = externalRefRows.filter(
              (r) => r.connectionId == null && r.dataSourceId === id && r.ownerId === owner,
            ).length
            return [{ count }]
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
  // Model the verified JWT middleware output independently from req.user: the
  // production create route deliberately trusts only authenticatedTenantId.
  req.authenticatedTenantId = currentUser ? 'tenant-dsv' : undefined
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
    // OTHER_WITH_ROTATE, not OTHER: this cell is about the FINE gate, so the caller must clear the
    // coarse one. With plain OTHER the 404 below would be a 403 and this cell would silently stop
    // testing ownership at all (see the dedicated 403 cells in the rotate describe).
    expect(
      (await as(OTHER_WITH_ROTATE).put(`/api/data-sources/${ID}/credentials`).send({ credentials: { password: 'x' } }))
        .status,
    ).toBe(404)
    expect((await as(undefined).put(`/api/data-sources/${ID}`).send({ name: 'x' })).status).toBe(401)
  })
})

// ── G02 PR-1: rotation is its own verb ─────────────────────────────────────────
//
// `PUT /:id/credentials` used to share `data_sources:write` with `PUT /:id`, so the only way to let
// an operator swap a password was to also let them repoint the source at another host. The coarse
// door is now `data_sources:rotate`, EXCLUSIVELY — not an any-of that still accepts `write`, because
// an any-of would leave the two acts fused while looking like a split.
//
// The cells below pin all four corners, and they are written as PAIRS that differ in exactly one
// input, so each 403/200/404 is attributable:
//   same id, only the permission list differs  -> isolates the coarse door;
//   same permission list, only the id differs  -> isolates the fine door;
//   same actor, only the route differs         -> shows `write` still repoints (the split is real).
describe('credential rotation is gated by data_sources:rotate, EXCLUSIVELY (G02 PR-1)', () => {
  const ID = 'dsv-rotate-verb'

  function storedPassword(id: string): unknown {
    return (getDataSourceManager().getDataSource(id).getConfig().credentials ?? {}).password
  }

  it('FAIL-CLOSED: the owner holding write but NOT rotate => 403, credential untouched', async () => {
    await createAsOwner(ID)
    expect(storedPassword(ID)).toBe(POISON.password)

    const res = await as(OWNER).put(`/api/data-sources/${ID}/credentials`)
      .send({ credentials: { password: POISON.rotatedPassword } })
    expect(res.status).toBe(403)
    expectNoPoison(res.body)

    // The refusal is the COARSE door: the handler never ran, so nothing was written and nothing was
    // audited. This is the regression the deployment prerequisite exists for — today's
    // `data_sources:write` holders lose rotation until an administrator grants `rotate` via a ROLE.
    expect(storedPassword(ID)).toBe(POISON.password)
    expect(auditCalls('update_credentials', ID)).toHaveLength(0)
  })

  it('the very same owner, with rotate added => 200 (the ONLY difference is the permission)', async () => {
    const res = await as(OWNER_WITH_ROTATE).put(`/api/data-sources/${ID}/credentials`)
      .send({ credentials: { password: POISON.rotatedPassword } })
    expect(res.status).toBe(200)
    expectNoPoison(res.body)

    expect(storedPassword(ID)).toBe(POISON.rotatedPassword)
    const call = auditCalls('update_credentials', ID).at(-1)
    expect(call).toMatchObject({ actorId: OWNER.id, meta: { changedCredentialKeys: ['password'] } })
    // An owner rotating their own source is not a cross-owner admin action.
    expect((call?.meta as Record<string, unknown>).crossOwnerAdmin).toBeUndefined()
  })

  it('rotate does NOT widen ownership: a non-owner holding rotate still gets the uniform 404', async () => {
    const res = await as(OTHER_WITH_ROTATE).put(`/api/data-sources/${ID}/credentials`)
      .send({ credentials: { password: 'other-should-never-land' } })
    expect(res.status).toBe(404)
    expect(res.body).toEqual(notFoundBody(ID))
    expect(storedPassword(ID)).toBe(POISON.rotatedPassword)
  })

  it('platform admin is unaffected by the split (rbacGuard short-circuits the global-admin tier)', async () => {
    const res = await as(ADMIN).put(`/api/data-sources/${ID}/credentials`)
      .send({ credentials: { password: POISON.rotatedPassword } })
    expect(res.status).toBe(200)
    expectNoPoison(res.body)
    expect(auditCalls('update_credentials', ID).at(-1)).toMatchObject({
      actorId: ADMIN.id,
      meta: { ownerId: OWNER.id, crossOwnerAdmin: true },
    })
  })

  it('THE SPLIT IS A SPLIT: the write-only owner still repoints the connection on PUT /:id', async () => {
    // Same actor that just got 403 on rotation. If this were also refused, the change would be a
    // blanket tightening of `write` rather than the extraction of one verb.
    const res = await as(OWNER).put(`/api/data-sources/${ID}`)
      .send({ connection: { host: 'moved.example', port: 5432, database: 'plm' } })
    expect(res.status).toBe(200)
    expect(res.body.data.connection).toMatchObject({ host: 'moved.example' })

    // ...and symmetrically, rotate alone must not become a licence to repoint.
    const rotateOnly = { ...OWNER, permissions: ['data_sources:read', 'data_sources:rotate'] }
    expect((await as(rotateOnly).put(`/api/data-sources/${ID}`).send({ name: 'repoint-by-rotator' })).status).toBe(403)
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

  it('a FOREIGN-ATTRIBUTED pin does NOT block the owner delete (P2-A: no stranger denial-of-delete)', async () => {
    const ID = 'dsv-del-foreign'
    await createAsOwner(ID)
    // A stranger (any tenant) pinned this source id. The stamp is not the owner's,
    // so the reference is unattributable — it must neither block nor be counted.
    externalRefRows.push({ dataSourceId: ID, ownerId: 'u_hostile_other_tenant' })

    const res = await as(OWNER).delete(`/api/data-sources/${ID}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: ID, removed: true })
  })

  it('REFERENCED source: owner delete => coded 409 naming the OWNER-ATTRIBUTED count and the force escape hatch; source survives', async () => {
    const ID = 'dsv-del-ref'
    await createAsOwner(ID)
    externalRefRows.push(
      { dataSourceId: ID, ownerId: OWNER.id },
      { dataSourceId: ID, ownerId: OWNER.id },
      // a third, foreign-attributed pin must NOT inflate the count the owner sees
      { dataSourceId: ID, ownerId: 'u_hostile_other_tenant' },
    )

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

describe('DataSourceManager.countExternalSystemReferences (owner-attributed, P2-A)', () => {
  function countCfg(id: string): DataSourceConfig {
    return {
      id,
      name: id,
      type: 'postgres',
      connection: { host: 'localhost', port: 5432, database: 'x' },
      options: { autoConnect: false },
    }
  }

  it('no bound db => 0 (memory-only manager: nothing persisted can reference it)', async () => {
    const m = new DataSourceManager()
    await expect(m.countExternalSystemReferences('any')).resolves.toBe(0)
  })

  it('counts canonical plus owner-attributed legacy rows without double-counting migrated rows', async () => {
    const m = new DataSourceManager({ db: fakeDb() as never })
    await m.addDataSource(countCfg('counted-src'), { ownerId: 'alice' })
    externalRefRows.push(
      { connectionId: 'counted-src', dataSourceId: '', ownerId: '' },
      // A migrated row may retain the rollback pointer; connection_id wins and
      // this row is counted exactly once.
      { connectionId: 'counted-src', dataSourceId: 'counted-src', ownerId: 'alice' },
      { dataSourceId: 'counted-src', ownerId: 'alice' },
      { dataSourceId: 'counted-src', ownerId: 'alice' },
      { dataSourceId: 'counted-src', ownerId: 'alice' },
      // foreign-attributed and unstamped pins are invisible to the guard
      { dataSourceId: 'counted-src', ownerId: 'mallory' },
      { dataSourceId: 'counted-src', ownerId: '' },
    )
    await expect(m.countExternalSystemReferences('counted-src')).resolves.toBe(5)
    expect(refCountQueriedIds).toContain('counted-src')
  })

  it('every reference is foreign-attributed => 0: a stranger cannot deny the owner their delete', async () => {
    const m = new DataSourceManager({ db: fakeDb() as never })
    await m.addDataSource(countCfg('pinned-src'), { ownerId: 'alice' })
    externalRefRows.push({ dataSourceId: 'pinned-src', ownerId: 'u_hostile_other_tenant' })
    await expect(m.countExternalSystemReferences('pinned-src')).resolves.toBe(0)
  })

  it('unknown scope (no such source) => 0 without touching the reference table', async () => {
    const before = refCountQueriedIds.length
    const m = new DataSourceManager({ db: fakeDb() as never })
    await expect(m.countExternalSystemReferences('never-registered')).resolves.toBe(0)
    expect(refCountQueriedIds.length).toBe(before)
  })

  it('P2-B: exact-zero ONLY on SQLSTATE 42P01 — a prose-worded error without the code propagates (fail closed)', async () => {
    const throwingDb = (err: Error) => ({
      selectFrom: () => {
        const b = { select: () => b, where: () => b, execute: async () => { throw err } }
        return b
      },
      // addDataSource persists through these; only the reference COUNT read throws.
      insertInto: () => {
        const b = { values: () => b, onConflict: () => b, execute: async () => [] }
        return b
      },
      updateTable: () => {
        const b = { set: () => b, where: () => b, execute: async () => [] }
        return b
      },
    })
    const withSource = async (db: unknown) => {
      const m = new DataSourceManager({ db: db as never })
      await m.addDataSource(countCfg('err-src'), { ownerId: 'alice' })
      return m
    }

    // The real undefined_table signal: SQLSTATE code — message wording irrelevant.
    const coded = Object.assign(new Error('anything at all'), { code: '42P01' })
    await expect((await withSource(throwingDb(coded))).countExternalSystemReferences('err-src')).resolves.toBe(0)

    // Message SOUNDS like a missing table but carries no code: a delete guard
    // must not be talked into fail-open by prose (e.g. a proxy error, or a
    // future separate-DB deployment surfacing connection failures this way).
    const prose = new Error('relation "integration_external_systems" does not exist')
    await expect((await withSource(throwingDb(prose))).countExternalSystemReferences('err-src')).rejects.toThrow(
      /does not exist/,
    )

    // Any other failure propagates too.
    const broken = new Error('connection reset by peer')
    await expect((await withSource(throwingDb(broken))).countExternalSystemReferences('err-src')).rejects.toThrow(
      /connection reset/,
    )
  })

  it('does not discard an observed canonical count when the second query hits a 42P01 race', async () => {
    let query = 0
    const ddlRaceDb = {
      selectFrom: () => {
        query += 1
        const thisQuery = query
        const b = {
          select: () => b,
          where: () => b,
          execute: async () => {
            if (thisQuery === 1) return [{ count: 1 }]
            throw Object.assign(new Error('table disappeared after the canonical count'), { code: '42P01' })
          },
        }
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
    }
    const m = new DataSourceManager({ db: ddlRaceDb as never })
    await m.addDataSource(countCfg('ddl-race-src'), { ownerId: 'alice' })
    await expect(m.countExternalSystemReferences('ddl-race-src')).rejects.toThrow(/disappeared/)
  })
})

// ── the LIST surface's reference counter ──────────────────────────────────────
// The same fact the delete guard enforces, shown BEFORE a delete is attempted:
// "how many integration bindings point at this source". Two properties are
// load-bearing and both are pinned here — it is BATCHED (not N+1), and it is a
// COUNT and nothing else (no referencing system's name, tenant, owner, config).

describe('data_sources listing reference counts (batched, values-free)', () => {
  const FREE = 'dsv-rc-free'
  const CANON = 'dsv-rc-canonical'
  const BOTH = 'dsv-rc-both'

  it('each item carries an integer referenceCount: canonical + owner-attributed legacy, foreign pins excluded', async () => {
    await createAsOwner(FREE)
    await createAsOwner(CANON)
    await createAsOwner(BOTH)
    externalRefRows.push(
      { connectionId: CANON, dataSourceId: '', ownerId: '' },
      { connectionId: BOTH, dataSourceId: '', ownerId: '' },
      { dataSourceId: BOTH, ownerId: OWNER.id },
      // P2-A on the READ side: a stranger's pin must not inflate the number the
      // owner is shown, exactly as it does not inflate what the delete enforces.
      { dataSourceId: BOTH, ownerId: 'u_hostile_other_tenant' },
      { dataSourceId: FREE, ownerId: 'u_hostile_other_tenant' },
    )

    const res = await as(OWNER).get('/api/data-sources')
    expect(res.status).toBe(200)
    const items = res.body.data.items as Array<{ id: string; referenceCount?: number }>
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get(FREE)?.referenceCount).toBe(0)
    expect(byId.get(CANON)?.referenceCount).toBe(1)
    expect(byId.get(BOTH)?.referenceCount).toBe(2)
  })

  it('ONE grouped canonical + ONE grouped legacy query for the WHOLE page — not one pair per row (N+1 probe)', async () => {
    const before = groupedRefQueries.length
    const res = await as(OWNER).get('/api/data-sources')
    const items = res.body.data.items as Array<{ id: string }>
    // Several rows on the page...
    expect(items.length).toBeGreaterThan(2)
    // ...and exactly two queries served the whole page.
    const served = groupedRefQueries.slice(before)
    expect(served.map((q) => q.kind)).toEqual(['canonical', 'legacy'])
    // Both asked about every listed id AT ONCE, which is why two is enough.
    for (const q of served) {
      expect(q.ids).toEqual(expect.arrayContaining(items.map((i) => i.id)))
    }
  })

  it('values-free: an item carries the COUNT and nothing about the referencing systems', async () => {
    const res = await as(OWNER).get('/api/data-sources')
    const item = (res.body.data.items as Array<{ id: string }>).find((i) => i.id === BOTH) as Record<string, unknown>
    expect(Object.keys(item).sort()).toEqual(['connected', 'id', 'name', 'ownerId', 'referenceCount', 'type'])
    expect(typeof item.referenceCount).toBe('number')
  })

  it('detail (GET /:id) reports the same count through the same batched call', async () => {
    const res = await as(OWNER).get(`/api/data-sources/${BOTH}`)
    expect(res.status).toBe(200)
    expect(res.body.data.referenceCount).toBe(2)
    expectNoPoison(res.body)
  })

  it('DEGRADES TO UNKNOWN, never to a reassuring 0, when the count query fails', async () => {
    // A failed count must not paint "0 references / safe to delete" on a page
    // whose delete would still be refused. The field is dropped instead.
    const spy = vi
      .spyOn(DataSourceManager.prototype, 'countExternalSystemReferencesByIds')
      .mockRejectedValue(new Error('connection reset by peer'))
    try {
      const res = await as(OWNER).get('/api/data-sources')
      expect(res.status).toBe(200)
      const items = res.body.data.items as Array<Record<string, unknown>>
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item).not.toHaveProperty('referenceCount')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('on failure, logs ONLY the SQLSTATE and the id count — never the driver message', async () => {
    // The driver message can embed host, database and login (see SCHEMA_FAILURE_MESSAGE's own
    // rationale) — the exact thing values-free forbids reaching a log line for this surface.
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')
    const dbError = Object.assign(new Error('connection reset by peer at 10.10.52.16:5432 login failed'), {
      code: '57P01',
    })
    const spy = vi
      .spyOn(DataSourceManager.prototype, 'countExternalSystemReferencesByIds')
      .mockRejectedValue(dbError)
    try {
      const res = await as(OWNER).get('/api/data-sources')
      expect(res.status).toBe(200)
      const referenceCountWarnings = warnSpy.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('reference count')
      )
      expect(referenceCountWarnings).toHaveLength(1)
      const [, payload] = referenceCountWarnings[0]
      expect(Object.keys(payload as object).sort()).toEqual(['ids', 'sqlstate'])
      expect((payload as { sqlstate: string }).sqlstate).toBe('57P01')
      expect(typeof (payload as { ids: number }).ids).toBe('number')
      expect(JSON.stringify(payload)).not.toContain('connection reset by peer')
    } finally {
      spy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('THE BINDING: the count the listing shows is the count the DELETE guard enforces', async () => {
    const listed = (
      (await as(OWNER).get('/api/data-sources')).body.data.items as Array<{ id: string; referenceCount?: number }>
    ).find((i) => i.id === BOTH)?.referenceCount
    const refusal = await as(OWNER).delete(`/api/data-sources/${BOTH}`)
    expect(refusal.status).toBe(409)
    expect(refusal.body.error.details.referenceCount).toBe(listed)
    expect(listed).toBe(2)
  })

  it('an admin listing gets counts too, attributed to the SOURCE owner rather than the caller', async () => {
    const res = await as(ADMIN).get('/api/data-sources')
    expect(res.status).toBe(200)
    const byId = new Map(
      (res.body.data.items as Array<{ id: string; referenceCount?: number }>).map((i) => [i.id, i.referenceCount]),
    )
    // The admin sees 2, not 3: the foreign pin stays uncounted for everyone.
    expect(byId.get(BOTH)).toBe(2)
    expect(byId.get(FREE)).toBe(0)
  })
})

describe('DataSourceManager.countExternalSystemReferencesByIds (batched; same semantics as the singular guard)', () => {
  function batchCfg(id: string): DataSourceConfig {
    return {
      id,
      name: id,
      type: 'postgres',
      connection: { host: 'localhost', port: 5432, database: 'x' },
      options: { autoConnect: false },
    }
  }

  it('no bound db => every requested id maps to 0 (exact: nothing persisted can reference a memory-only source)', async () => {
    const m = new DataSourceManager()
    const counts = await m.countExternalSystemReferencesByIds(['a', 'b'])
    expect([...counts]).toEqual([['a', 0], ['b', 0]])
  })

  it('empty id list => empty map, no query at all', async () => {
    const before = groupedRefQueries.length
    const m = new DataSourceManager({ db: fakeDb() as never })
    expect((await m.countExternalSystemReferencesByIds([])).size).toBe(0)
    expect(groupedRefQueries.length).toBe(before)
  })

  it('AGREES WITH THE SINGULAR GUARD for every id — drift would make the list page lie about the delete', async () => {
    const m = new DataSourceManager({ db: fakeDb() as never })
    for (const id of ['eq-canonical', 'eq-legacy', 'eq-mixed', 'eq-foreign', 'eq-none']) {
      await m.addDataSource(batchCfg(id), { ownerId: 'alice' })
    }
    externalRefRows.push(
      { connectionId: 'eq-canonical', dataSourceId: '', ownerId: '' },
      { dataSourceId: 'eq-legacy', ownerId: 'alice' },
      { dataSourceId: 'eq-legacy', ownerId: 'alice' },
      // a migrated row keeping its rollback pointer is counted ONCE, canonically
      { connectionId: 'eq-mixed', dataSourceId: 'eq-mixed', ownerId: 'alice' },
      { dataSourceId: 'eq-mixed', ownerId: 'alice' },
      // foreign-attributed and unstamped pins are invisible to BOTH methods
      { dataSourceId: 'eq-foreign', ownerId: 'mallory' },
      { dataSourceId: 'eq-foreign', ownerId: '' },
    )

    const ids = ['eq-canonical', 'eq-legacy', 'eq-mixed', 'eq-foreign', 'eq-none', 'eq-never-registered']
    const batch = await m.countExternalSystemReferencesByIds(ids)
    for (const id of ids) {
      expect([id, batch.get(id)]).toEqual([id, await m.countExternalSystemReferences(id)])
    }
    expect(ids.map((id) => batch.get(id))).toEqual([1, 2, 2, 0, 0, 0])
  })

  it('an id with no owner scope => 0, and it is not even asked about', async () => {
    const m = new DataSourceManager({ db: fakeDb() as never })
    await m.addDataSource(batchCfg('scoped-src'), { ownerId: 'alice' })
    const before = groupedRefQueries.length
    const counts = await m.countExternalSystemReferencesByIds(['scoped-src', 'unscoped-src'])
    expect(counts.get('unscoped-src')).toBe(0)
    const served = groupedRefQueries.slice(before)
    expect(served.length).toBe(2)
    for (const q of served) {
      expect(q.ids).toEqual(['scoped-src'])
    }
  })

  it('returns exactly the requested keys — a returned row for an unrequested id cannot widen the answer', async () => {
    const m = new DataSourceManager({
      db: {
        selectFrom: () => {
          const b = {
            select: () => b,
            groupBy: () => b,
            where: () => b,
            execute: async () => [
              { reference_id: 'asked', reference_owner_id: 'alice', count: 1 },
              { reference_id: 'never-asked', reference_owner_id: 'alice', count: 99 },
            ],
          }
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
      } as never,
    })
    await m.addDataSource(batchCfg('asked'), { ownerId: 'alice' })
    const counts = await m.countExternalSystemReferencesByIds(['asked'])
    expect([...counts.keys()]).toEqual(['asked'])
    // one canonical row + one legacy row for 'asked'; the unrequested id is dropped
    expect(counts.get('asked')).toBe(2)
  })

  it('P2-B posture is inherited: exact-zero ONLY on SQLSTATE 42P01, prose propagates', async () => {
    const throwingDb = (err: Error) => ({
      selectFrom: () => {
        const b = { select: () => b, groupBy: () => b, where: () => b, execute: async () => { throw err } }
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
    })
    const withSource = async (db: unknown) => {
      const m = new DataSourceManager({ db: db as never })
      await m.addDataSource(batchCfg('batch-err-src'), { ownerId: 'alice' })
      return m
    }

    const coded = Object.assign(new Error('anything at all'), { code: '42P01' })
    const zeroes = await (await withSource(throwingDb(coded))).countExternalSystemReferencesByIds(['batch-err-src'])
    expect(zeroes.get('batch-err-src')).toBe(0)

    const prose = new Error('relation "integration_external_systems" does not exist')
    await expect(
      (await withSource(throwingDb(prose))).countExternalSystemReferencesByIds(['batch-err-src']),
    ).rejects.toThrow(/does not exist/)

    const broken = new Error('connection reset by peer')
    await expect(
      (await withSource(throwingDb(broken))).countExternalSystemReferencesByIds(['batch-err-src']),
    ).rejects.toThrow(/connection reset/)
  })
})
