import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'eventemitter3'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter, initializeDataSourceManager } from '../../src/routes/data-sources'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))
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

// Real HTTP, router, RBAC permission-code gate and manager; deterministic
// verified-request context, persistence stand-in and non-dialing adapter.
// This suite does not claim JWT cryptography or a real database transaction.
class NoDialAdapter extends EventEmitter {
  constructor(private config: DataSourceConfig) { super() }
  getConfig() { return this.config }
  isConnected() { return false }
  async disconnect() {}
}

function database() {
  const rows = new Map<string, Record<string, unknown>>()
  let writes = 0
  function builder() {
    let id: string | undefined
    let pending: Record<string, unknown> = {}
    const b = {
      selectAll: () => b,
      select: () => b,
      forUpdate: () => b,
      where: (key: string, _op: string, value: unknown) => {
        if (key === 'id') id = String(value)
        return b
      },
      values: (value: Record<string, unknown>) => { pending = value; return b },
      set: (value: Record<string, unknown>) => { pending = value; return b },
      onConflict: () => b,
      execute: async () => {
        if (Object.keys(pending).length) {
          const key = String(pending.id ?? id)
          rows.set(key, structuredClone({ ...rows.get(key), ...pending }))
          writes += 1
          return []
        }
        return [...rows.values()].filter(row => (!id || row.id === id) && row.is_active && row.deleted_at == null)
      },
    }
    return b
  }
  const executor = { selectFrom: builder, insertInto: builder, updateTable: builder }
  const db = { ...executor, transaction: () => ({ execute: async (fn: (trx: typeof executor) => unknown) => fn(executor) }) }
  return { db, rows, writes: () => writes }
}

const OWNER = { id: 'visual-owner', role: 'member', permissions: ['data_sources:read', 'data_sources:write'] }
const ADMIN = { id: 'visual-admin', role: 'admin' }
const ADMIN_ROLES = { id: 'visual-roles-admin', roles: ['member', 'admin'] }
const OTHER = { ...OWNER, id: 'visual-other' }
const TENANT = 'visual-tenant'
const adminActor = { userId: ADMIN.id, platformAdmin: true }
const source = (id: string, enabled?: boolean): DataSourceConfig => ({
  id, name: id, type: 'plm', connection: { baseUrl: 'https://plm.invalid' },
  options: { autoConnect: false, apiMode: 'yuantus', tenantId: TENANT, ...(enabled === undefined ? {} : { visualReviewEnabled: enabled }) },
})
const scope = { ownerId: OWNER.id, tenantId: TENANT, actor: adminActor }
const storage = database()
let manager: DataSourceManager
let currentUser: Record<string, unknown> | undefined
let currentTenant: string | undefined = TENANT
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = currentUser as never
  req.authenticatedTenantId = currentTenant
  next()
})
app.use(dataSourcesRouter())
const pinned = usePinnedServer()

function as(user: Record<string, unknown> | undefined, tenant: string | undefined = TENANT) {
  currentUser = user
  currentTenant = tenant
  pinned.setApp(app)
  return request(pinned.url())
}

beforeAll(async () => {
  manager = await initializeDataSourceManager(storage.db as never)
  manager.registerAdapterType('plm', NoDialAdapter as never)
  manager.registerAdapterType('http', NoDialAdapter as never)
})

describe('Visual V1 source administration via real HTTP', () => {
  it('anonymous and unprivileged users cannot provision any source', async () => {
    expect((await as(undefined).post('/api/data-sources').send(source('anonymous'))).status).toBe(401)
    expect((await as({ id: 'no-permission', role: 'member' }).post('/api/data-sources').send(source('unprivileged'))).status).toBe(403)
    expect(storage.rows.has('anonymous')).toBe(false)
    expect(storage.rows.has('unprivileged')).toBe(false)
  })

  it.each([undefined, false])('ordinary owner can create a default-dark source (%s)', async enabled => {
    const id = `visual-dark-${String(enabled)}`
    const result = await as(OWNER).post('/api/data-sources').send(source(id, enabled))
    expect(result.status).toBe(201)
    expect(manager.getDataSource(id).getConfig().options?.visualReviewEnabled).toBe(enabled)
  })

  it('data_sources:write and body admin/tenant overrides cannot authorize enablement', async () => {
    const count = storage.writes()
    const result = await as(OWNER).post('/api/data-sources').send({
      ...source('visual-forged-admin', true), actor: adminActor, platformAdmin: true, tenantId: TENANT,
    })
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('VISUAL_REVIEW_SOURCE_ADMIN_REQUIRED')
    expect(storage.writes()).toBe(count)
    expect(() => manager.getDataSource('visual-forged-admin')).toThrow(/not found/)
  })

  it.each([ADMIN, ADMIN_ROLES])('actual admin can explicitly enable a tenant-bound source ($id)', async actor => {
    const id = `visual-enabled-${actor.id}`
    const result = await as(actor).post('/api/data-sources').send(source(id, true))
    expect(result.status).toBe(201)
    expect(result.body.data.options.visualReviewEnabled).toBe(true)
    expect(storage.rows.get(id)?.tenant_id).toBe(TENANT)
  })

  it.each([
    ['missing', undefined], ['foreign', 'other-tenant'], ['whitespace', ` ${TENANT}`], ['oversized', 'x'.repeat(129)],
  ])('admin cannot enable with %s configured tenant', async (label, tenantId) => {
    const config = source(`visual-bad-${label}`, true)
    config.options = { visualReviewEnabled: true, ...(tenantId === undefined ? {} : { tenantId }) }
    const count = storage.writes()
    const result = await as(ADMIN).post('/api/data-sources').send(config)
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('VISUAL_REVIEW_SOURCE_SCOPE_INVALID')
    expect(storage.writes()).toBe(count)
  })

  it('legacy header-derived tenant and user.tenantId cannot supply authenticated scope', async () => {
    currentUser = { ...ADMIN, tenantId: TENANT }
    currentTenant = undefined
    pinned.setApp(app)
    const result = await request(pinned.url()).post('/api/data-sources').set('x-tenant-id', TENANT).send(source('visual-no-auth-tenant', true))
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('AUTHENTICATED_TENANT_REQUIRED')
  })

  it.each(['true', 1, null])('non-boolean visual option is rejected rather than coerced (%s)', async enabled => {
    const result = await as(ADMIN).post('/api/data-sources').send({
      ...source(`visual-bad-bool-${String(enabled)}`), options: { tenantId: TENANT, visualReviewEnabled: enabled },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('admin cannot enable visual review on a non-PLM source', async () => {
    const result = await as(ADMIN).post('/api/data-sources').send({ ...source('visual-http', true), type: 'http' })
    expect(result.status).toBe(400)
  })

  it('owner cannot enable an existing source; admin approval survives owner name-only edits', async () => {
    const id = 'visual-owner-approved'
    expect((await as(OWNER).post('/api/data-sources').send(source(id))).status).toBe(201)
    expect((await as(OWNER).put(`/api/data-sources/${id}`).send({ options: { visualReviewEnabled: true } })).status).toBe(403)
    expect((await as(ADMIN).put(`/api/data-sources/${id}`).send({ options: { visualReviewEnabled: true } })).status).toBe(200)
    expect((await as(OWNER).put(`/api/data-sources/${id}`).send({ name: 'renamed' })).status).toBe(200)
    expect(manager.getDataSource(id).getConfig()).toMatchObject({ name: 'renamed', options: { visualReviewEnabled: true } })
    expect(manager.getScope(id)?.ownerId).toBe(OWNER.id)
  })

  it.each([
    ['connection', { connection: { baseUrl: 'https://different.invalid' } }],
    ['options', { options: { orgId: 'other-org' } }],
    ['disable', { options: { visualReviewEnabled: false } }],
    ['pool', { poolConfig: { max: 9 } }],
  ])('owner cannot change approved %s binding', async (_label, body) => {
    const id = `visual-protected-${_label}`
    await manager.addDataSource(source(id, true), scope)
    const before = structuredClone(storage.rows.get(id))
    const writes = storage.writes()
    const result = await as(OWNER).put(`/api/data-sources/${id}`).send(body)
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('VISUAL_REVIEW_SOURCE_ADMIN_REQUIRED')
    expect(storage.rows.get(id)).toEqual(before)
    expect(storage.writes()).toBe(writes)
    expect(manager.getDataSource(id).getConfig()).toEqual(source(id, true))
  })

  it('credential rotation requires admin while enabled, then ordinary ownership works after admin disables', async () => {
    const id = 'visual-credentials'
    await manager.addDataSource(source(id, true), scope)
    const payload = { credentials: { token: 'synthetic-visual-secret' } }
    const denied = await as(OWNER).put(`/api/data-sources/${id}/credentials`).send(payload)
    expect(denied.status).toBe(403)
    const allowed = await as(ADMIN).put(`/api/data-sources/${id}/credentials`).send(payload)
    expect(allowed.status).toBe(200)
    expect(JSON.stringify(allowed.body)).not.toContain('synthetic-visual-secret')
    expect((await as(ADMIN).put(`/api/data-sources/${id}`).send({ options: { visualReviewEnabled: false } })).status).toBe(200)
    expect((await as(OWNER).put(`/api/data-sources/${id}/credentials`).send(payload)).status).toBe(200)
  })

  it('non-owner cannot use name-only exception to discover or modify enabled sources', async () => {
    const id = 'visual-foreign-owner'
    await manager.addDataSource(source(id, true), scope)
    const result = await as(OTHER).put(`/api/data-sources/${id}`).send({ name: 'forged' })
    expect(result.status).toBe(404)
    expect(manager.getDataSource(id).getConfig().name).toBe(id)
  })
})

describe('Visual V1 manager choke points and durable reload', () => {
  it('administrator can delete an enabled source after the reference check', async () => {
    const id = 'visual-admin-delete'
    await manager.addDataSource(source(id, true), scope)
    const count = vi.spyOn(manager, 'countExternalSystemReferences').mockResolvedValue(0)
    try {
      expect((await as(ADMIN).delete(`/api/data-sources/${id}`)).status).toBe(200)
      expect(storage.rows.get(id)?.is_active).toBe(false)
      expect(() => manager.getDataSource(id)).toThrow(/not found/)
    } finally { count.mockRestore() }
  })

  it('stale dark manager cannot delete a newly enabled durable Visual source', async () => {
    const shared = database()
    const a = new DataSourceManager({ db: shared.db as never })
    a.registerAdapterType('plm', NoDialAdapter as never)
    await a.addDataSource(source('stale-delete', false), scope)
    const b = new DataSourceManager()
    b.registerAdapterType('plm', NoDialAdapter as never)
    await b.initialize(shared.db as never)
    await a.updateDataSource('stale-delete', source('stale-delete', true), scope)
    const before = structuredClone(shared.rows.get('stale-delete'))
    await expect(b.removeDataSource('stale-delete')).rejects.toMatchObject({ status: 403 })
    expect(shared.rows.get('stale-delete')).toEqual(before)
    expect(b.getDataSource('stale-delete')).toBeDefined()
  })

  it('stale owner rename cannot restore administrator-disabled Visual binding', async () => {
    const shared = database()
    const a = new DataSourceManager({ db: shared.db as never })
    a.registerAdapterType('plm', NoDialAdapter as never)
    await a.addDataSource(source('stale-rename', true), scope)
    const b = new DataSourceManager()
    b.registerAdapterType('plm', NoDialAdapter as never)
    await b.initialize(shared.db as never)
    await a.updateDataSource('stale-rename', source('stale-rename', false), scope)
    const before = structuredClone(shared.rows.get('stale-rename'))
    await expect(b.updateDataSource('stale-rename', { ...source('stale-rename', true), name: 'old owner rename' },
      { actor: { userId: OWNER.id } })).rejects.toMatchObject({ status: 409 })
    expect(shared.rows.get('stale-rename')).toEqual(before)
  })

  it('stale manager creation cannot overwrite an existing approved source', async () => {
    const shared = database()
    const a = new DataSourceManager({ db: shared.db as never })
    const b = new DataSourceManager({ db: shared.db as never })
    for (const m of [a, b]) m.registerAdapterType('plm', NoDialAdapter as never)
    await a.addDataSource(source('stale-create', true), scope)
    const before = structuredClone(shared.rows.get('stale-create'))
    await expect(b.addDataSource(source('stale-create', false),
      { ownerId: OWNER.id, tenantId: TENANT, actor: { userId: OWNER.id } }))
      .rejects.toMatchObject({ status: 409 })
    expect(shared.rows.get('stale-create')).toEqual(before)
  })

  it('owner cannot delete an enabled source through manager or HTTP', async () => {
    const id = 'visual-owner-delete'
    await manager.addDataSource(source(id, true), scope)
    const before = structuredClone(storage.rows.get(id))
    const count = vi.spyOn(manager, 'countExternalSystemReferences').mockResolvedValue(0)
    try {
      expect((await as(OWNER).delete(`/api/data-sources/${id}`)).status).toBe(403)
      await expect(manager.removeDataSource(id)).rejects.toMatchObject({ status: 403 })
      expect(storage.rows.get(id)).toEqual(before)
      expect(manager.getDataSource(id).getConfig()).toEqual(source(id, true))
    } finally { count.mockRestore() }
  })

  it('direct creation cannot bypass platform admin or durable tenant validation', async () => {
    const db = database()
    const m = new DataSourceManager({ db: db.db as never })
    m.registerAdapterType('plm', NoDialAdapter as never)
    await expect(m.addDataSource(source('direct-enabled', true), { ownerId: OWNER.id, tenantId: TENANT }))
      .rejects.toMatchObject({ status: 403, code: 'VISUAL_REVIEW_SOURCE_ADMIN_REQUIRED' })
    await expect(m.addDataSource(source('direct-no-tenant', true), { ownerId: OWNER.id, actor: adminActor }))
      .rejects.toMatchObject({ status: 400, code: 'VISUAL_REVIEW_SOURCE_SCOPE_INVALID' })
    expect(db.writes()).toBe(0)
  })

  it.each(['type', 'id', 'owner', 'tenant', 'workspace', 'scope'])('direct update cannot move approved %s', async field => {
    const id = `direct-${field}`
    const db = database()
    const m = new DataSourceManager({ db: db.db as never })
    m.registerAdapterType('plm', NoDialAdapter as never)
    await m.addDataSource(source(id, true), scope)
    const config = source(id, true)
    const options: Parameters<DataSourceManager['updateDataSource']>[2] = { actor: { userId: OWNER.id } }
    if (field === 'type') config.type = 'http'
    if (field === 'id') config.id = 'replacement-id'
    if (field === 'owner') options.ownerId = 'replacement-owner'
    if (field === 'tenant') { options.tenantId = 'replacement-tenant'; config.options!.tenantId = 'replacement-tenant' }
    if (field === 'workspace') options.workspaceId = 'replacement-workspace'
    if (field === 'scope') options.scopeKind = 'legacy_private'
    await expect(m.updateDataSource(id, config, options)).rejects.toMatchObject({ status: field === 'type' ? 400 : 403 })
    expect(db.writes()).toBe(1)
    expect(m.getDataSource(id).getConfig()).toEqual(source(id, true))
  })

  it('restart loads the approved binding and quarantines malformed persisted visual configs', async () => {
    const db = database()
    const original = new DataSourceManager({ db: db.db as never })
    original.registerAdapterType('plm', NoDialAdapter as never)
    await original.addDataSource(source('load-good', true), scope)
    for (const [id, tenant, type, enabled] of [
      ['load-foreign', 'other', 'plm', true],
      ['load-no-tenant', null, 'plm', true],
      ['load-non-plm', TENANT, 'http', true],
      ['load-string', TENANT, 'plm', 'true'],
    ]) {
      const row = structuredClone(db.rows.get('load-good')!)
      row.id = id
      row.tenant_id = tenant
      row.type = type
      const config = row.config as { options: Record<string, unknown> }
      config.options.visualReviewEnabled = enabled
      db.rows.set(String(id), row)
    }
    const restarted = new DataSourceManager()
    restarted.registerAdapterType('plm', NoDialAdapter as never)
    restarted.registerAdapterType('http', NoDialAdapter as never)
    await restarted.initialize(db.db as never)
    expect(restarted.getDataSource('load-good').getConfig()).toMatchObject(source('load-good', true))
    expect(restarted.listLoadFailedDataSources({ actor: adminActor }).map(item => item.id).sort())
      .toEqual(['load-foreign', 'load-no-tenant', 'load-non-plm', 'load-string'])
    for (const id of ['load-foreign', 'load-no-tenant', 'load-non-plm', 'load-string']) {
      expect(() => restarted.getDataSource(id)).toThrow(/not found/)
    }
    expect(db.writes()).toBe(1)
  })

  it('credential re-seal does not restore an enabled source under an ordinary owner', async () => {
    const db = database()
    const original = new DataSourceManager({ db: db.db as never })
    original.registerAdapterType('plm', NoDialAdapter as never)
    await original.addDataSource(source('reseal-enabled', true), scope)
    const storedConfig = db.rows.get('reseal-enabled')!.config as { credentials: Record<string, string> }
    storedConfig.credentials = { token: 'enc:broken' }
    const restarted = new DataSourceManager()
    restarted.registerAdapterType('plm', NoDialAdapter as never)
    await restarted.initialize(db.db as never)
    expect(restarted.listLoadFailedDataSources({ actor: adminActor })[0].loadState).toBe('credentials_unreadable')
    await expect(restarted.resealLoadFailedDataSource('reseal-enabled', { token: 'new-synthetic-token' }, OWNER.id))
      .rejects.toMatchObject({ status: 403, code: 'VISUAL_REVIEW_SOURCE_ADMIN_REQUIRED' })
    expect(db.writes()).toBe(1)
    const recovered = await restarted.resealLoadFailedDataSource('reseal-enabled', { token: 'new-synthetic-token' }, adminActor)
    expect(recovered.restartRequired).toBe(false)
    expect(recovered.config.options?.visualReviewEnabled).toBe(true)
    expect(db.writes()).toBe(2)
  })
})


describe('managed Visual explicit administration with separate Native and Meta namespaces', () => {
  const managed = (id: string, enabled = true): DataSourceConfig => ({ ...source(id),
    options: { autoConnect: false, apiMode: 'yuantus', tenantId: 'native-tenant', orgId: 'native-org',
      managedVisualReviewEnabled: enabled } })
  it('refuses an ordinary source owner and allows explicit admin provisioning with distinct storage tenant', async () => {
    const refused = await as(OWNER).post('/api/data-sources').send(managed('managed-owner'))
    expect(refused.status).toBe(403); expect(storage.rows.has('managed-owner')).toBe(false)
    const accepted = await as(ADMIN).post('/api/data-sources').send(managed('managed-admin'))
    expect(accepted.status).toBe(201)
    expect(storage.rows.get('managed-admin')!.tenant_id).toBe(TENANT)
    expect(manager.getDataSource('managed-admin').getConfig().options).toMatchObject({
      tenantId: 'native-tenant', orgId: 'native-org', managedVisualReviewEnabled: true })
    expect(manager.getDataSource('managed-admin').getConfig().options?.visualReviewEnabled).toBeUndefined()
    expect(await manager.isVisualReviewSourceCurrent('managed-admin', 'native-tenant', manager.getDataSource('managed-admin'))).toBe(false)
  })
  it('requires a separate admin confirmation for enabling and disabling managed Visual', async () => {
    const id = 'managed-toggle'
    await manager.addDataSource(managed(id, false), scope)
    expect((await as(OWNER).put(`/api/data-sources/${id}`).send({ options: { managedVisualReviewEnabled: true } })).status).toBe(403)
    expect((await as(ADMIN).put(`/api/data-sources/${id}`).send({ options: { managedVisualReviewEnabled: true } })).status).toBe(200)
    expect((await as(OWNER).put(`/api/data-sources/${id}`).send({ name: 'renamed' })).status).toBe(200)
    expect(manager.getDataSource(id).getConfig().options?.managedVisualReviewEnabled).toBe(true)
    expect((await as(OWNER).put(`/api/data-sources/${id}`).send({ options: { managedVisualReviewEnabled: false } })).status).toBe(403)
    expect((await as(ADMIN).put(`/api/data-sources/${id}`).send({ options: { managedVisualReviewEnabled: false } })).status).toBe(200)
  })
  it.each([
    ['connection', { connection: { baseUrl: 'https://other.invalid' } }],
    ['native-tenant', { options: { tenantId: 'other' } }],
    ['native-org', { options: { orgId: 'other' } }],
    ['credentials', { credentials: { token: 'unapproved' } }],
  ])('does not let owners redirect approved managed %s', async (label, body) => {
    const id = 'managed-protect-' + label
    await manager.addDataSource(managed(id), scope)
    const before = structuredClone(storage.rows.get(id))
    expect((await as(OWNER).put(`/api/data-sources/${id}` + (label === 'credentials' ? '/credentials' : '')).send(body)).status).toBe(403)
    expect(storage.rows.get(id)).toEqual(before)
  })
  it('retains managed approval across restart and refuses stale-owner deletion after another process enables it', async () => {
    const shared = database()
    const a = new DataSourceManager({ db: shared.db as never }); a.registerAdapterType('plm', NoDialAdapter as never)
    await a.addDataSource(managed('managed-stale', false), scope)
    const b = new DataSourceManager(); b.registerAdapterType('plm', NoDialAdapter as never); await b.initialize(shared.db as never)
    await a.updateDataSource('managed-stale', managed('managed-stale'), scope)
    await expect(b.removeDataSource('managed-stale', { actor: { userId: OWNER.id } })).rejects.toMatchObject({ status: 403 })
    const restarted = new DataSourceManager(); restarted.registerAdapterType('plm', NoDialAdapter as never)
    await restarted.initialize(shared.db as never)
    expect(restarted.getDataSource('managed-stale').getConfig().options).toMatchObject({
      tenantId: 'native-tenant', orgId: 'native-org', managedVisualReviewEnabled: true })
    expect(restarted.getScope('managed-stale')?.tenantId).toBe(TENANT)
  })
  it.each(['true', 1, null])('refuses malformed managed approval %s at the HTTP boundary', async enabled => {
    const config = managed('managed-malformed-' + String(enabled)); config.options!.managedVisualReviewEnabled = enabled
    expect((await as(ADMIN).post('/api/data-sources').send(config)).status).toBe(400)
  })
})
