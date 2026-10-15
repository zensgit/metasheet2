/** Real PG source-authority races; isolated schema, real manager, non-dialing adapter.
 * Uses the source-table and scope migrations, not the complete application catalog.
 */
import { EventEmitter } from 'eventemitter3'
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { up as sourceTable } from '../../src/db/migrations/20251206000001_create_data_sources_table'
import { up as sourceScope } from '../../src/db/migrations/zzzz20260902120000_add_integration_connection_binding'

const routeRegistry = vi.hoisted(() => ({ manager: null as unknown, consume: vi.fn() }))
vi.mock('../../src/routes/data-sources', () => ({ getDataSourceManager: () => routeRegistry.manager }))
vi.mock('../../src/auth/embed-jti-store', () => ({ consumeEmbedJti: (...args: unknown[]) => routeRegistry.consume(...args), embedJtiKey: () => 'test-jti' }))
vi.mock('../../src/db/sharding/tenant-context', () => ({ extractTenantFromHeaders: () => undefined }))
vi.mock('../../src/metrics/metrics', () => ({ metrics: new Proxy({}, { get: () => ({ inc() {} }) }) }))
vi.mock('../../src/auth/AuthService', () => ({ authService: {} }))
import previewRouter from '../../src/routes/plm-embed-visual-preview'

const dsn = process.env.PLM_VISUAL_SOURCE_TEST_DATABASE_URL
if (process.env.EXPECT_PLM_VISUAL_SOURCE_DB === '1' && !dsn) throw new Error('Visual source DB URL is required')
class NoDial extends EventEmitter {
  constructor(private config: DataSourceConfig) { super() }
  getConfig() { return this.config }
  isConnected() { return false }
  async disconnect() {}
}
const adminActor = { userId: 'administrator', platformAdmin: true }
const ownerActor = { userId: 'owner' }
const scope = { ownerId: 'owner', tenantId: 'tenant', actor: adminActor }
const config = (id: string, enabled: boolean): DataSourceConfig => ({ id, name: id, type: 'plm',
  connection: { baseUrl: 'https://plm.invalid' }, options: { tenantId: 'tenant', apiMode: 'yuantus', autoConnect: false, visualReviewEnabled: enabled } })

describe.skipIf(!dsn)('Visual source durable authority on PostgreSQL', () => {
  const schema = `visual_source_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let pool: Pool
  let db: Kysely<unknown>
  async function manager(load = false) {
    const m = new DataSourceManager(load ? undefined : { db })
    m.registerAdapterType('plm', NoDial as never)
    if (load) await m.initialize(db)
    return m
  }
  async function row(id: string) { return (await pool.query('SELECT row_to_json(d) AS value FROM data_sources d WHERE id=$1', [id])).rows[0]?.value }
  async function waitForBlocker(pid: number) {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      const result = await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [pid])
      if (result.rowCount) {
        const waiters = result.rows.map(r => r.pid)
        console.info(JSON.stringify({ proof: 'pg_blocking_pids', blocker: pid, waiters }))
        return waiters
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('No actual PostgreSQL lock waiter observed')
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: dsn, max: 4 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString: dsn, options: `-c search_path=${schema}`, max: 8 })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await sourceTable(db)
    await sourceScope(db)
    // Installed empty reference catalog; this lane exercises the source guard.
    await pool.query('CREATE TABLE integration_external_systems(connection_id text, config jsonb)')
  })
  afterAll(async () => {
    await db?.destroy()
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin?.end()
  })

  it.each([true, false])('stale owner update cannot overwrite admin Visual=%s decision', async initial => {
    const id = `sequential-${initial}`
    const a = await manager()
    await a.addDataSource(config(id, initial), scope)
    const b = await manager(true)
    await a.updateDataSource(id, config(id, !initial), scope)
    const before = await row(id)
    await expect(b.updateDataSource(id, { ...config(id, initial), name: 'stale rename' }, { actor: ownerActor }))
      .rejects.toMatchObject({ status: 409 })
    expect(await row(id)).toEqual(before)
  })

  it('real PLM connect header mutation does not invalidate approved admission or name-only edit', async () => {
    class ConnectedPlm extends PLMAdapter {
      constructor(c: DataSourceConfig) {
        super({ get: async (key: string) => key === 'plm.mock' ? true : undefined } as never,
          { info() {}, warn() {}, error() {}, debug() {} } as never, c)
      }
    }
    const m = await manager()
    m.registerAdapterType('plm', ConnectedPlm as never)
    const id = 'real-adapter-runtime'
    const a = await m.addDataSource(config(id, true), scope)
    const before = await row(id)
    await a.connect()
    expect(a.getConfig().connection.headers).toMatchObject({ 'x-tenant-id': 'tenant' })
    expect(await m.isVisualReviewSourceCurrent(id, 'tenant', a)).toBe(true)
    await m.updateDataSource(id, { ...a.getConfig(), name: 'connected rename' }, { actor: ownerActor })
    expect((await row(id)).config).toEqual(before.config)
    expect(await m.isVisualReviewSourceCurrent(id, 'tenant', m.getDataSource(id))).toBe(true)
  })

  it.each(['disable', 'delete', 'redirect'])('durable %s invalidates a different manager preview admission', async action => {
    const id = `admission-${action}`
    const a = await manager()
    await a.addDataSource(config(id, true), scope)
    const b = await manager(true)
    const cached = b.getDataSource(id)
    expect(await b.isVisualReviewSourceCurrent(id, 'tenant', cached)).toBe(true)
    if (action === 'delete') await a.removeDataSource(id, { actor: adminActor })
    else await a.updateDataSource(id, action === 'disable' ? config(id, false)
      : { ...config(id, true), connection: { baseUrl: 'https://redirect.invalid' } }, scope)
    expect(await b.isVisualReviewSourceCurrent(id, 'tenant', cached)).toBe(false)
  })

  it.each(['disable', 'delete'])('new HTTP request after durable %s cannot connect or fetch old source', async action => {
    const id = `http-${action}`
    const a = await manager()
    await a.addDataSource(config(id, true), scope)
    const b = await manager(true)
    const cached = b.getDataSource(id) as unknown as Record<string, unknown>
    const connect = vi.fn()
    const provider = vi.fn()
    Object.assign(cached, { isVisualReviewEnabled: () => true, getEffectiveTenantId: () => 'tenant',
      isConnected: () => false, connect, listVisualPreviewFiles: provider, getVisualPreviewImage: provider })
    if (action === 'delete') await a.removeDataSource(id, { actor: adminActor })
    else await a.updateDataSource(id, config(id, false), scope)
    const keys = generateKeyPairSync('ed25519')
    const jwk = keys.publicKey.export({ format: 'jwk' })
    vi.stubEnv('YUANTUS_EMBED_PUBLIC_KEY', Buffer.from(jwk.x!, 'base64url').toString('base64'))
    vi.stubEnv('YUANTUS_EMBED_KEY_ID', 'source-test-key')
    vi.stubEnv('PLM_EMBED_AUDIENCE', 'metasheet2.embed')
    vi.stubEnv('PLM_EMBED_ALLOWED_ORIGINS', 'https://plm.invalid')
    vi.stubEnv('PLM_EMBED_DATA_SOURCE_ID', id)
    vi.stubEnv('PLM_EMBED_VISUAL_PREVIEW_ENABLED', 'true')
    routeRegistry.manager = b
    routeRegistry.consume.mockReset().mockResolvedValue(true)
    const app = express()
    app.use(express.json(), previewRouter())
    try {
      for (const suffix of ['files', 'image']) {
        const now = Math.floor(Date.now() / 1000)
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'source-test-key' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({ sub: '42', tenant_id: 'tenant', org_id: 'org', part_id: 'part',
          typ: 'embed', feature_key: 'bom_multitable', aud: 'metasheet2.embed', embed_origin: 'https://plm.invalid',
          jti: randomUUID(), iat: now, exp: now + 120 })).toString('base64url')
        const token = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`
        const response = await request(app).post(`/api/plm-embed/visual-preview/${suffix}`)
          .set('X-PLM-Embed-Token', token).send(suffix === 'image' ? { file_id: 'file', version_id: 'version' } : {})
        expect(response.status).toBe(503)
      }
      expect(connect).not.toHaveBeenCalled()
      expect(provider).not.toHaveBeenCalled()
      expect(routeRegistry.consume).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })

  it('ordinary owner rename preserves approved configuration and credentials', async () => {
    const id = 'rename-positive'
    const m = await manager()
    await m.addDataSource({ ...config(id, true), credentials: { token: 'synthetic-secret' } }, scope)
    const before = await row(id)
    await m.updateDataSource(id, { ...m.getDataSource(id).getConfig(), name: 'new name' }, { actor: ownerActor })
    const after = await row(id)
    expect(after.name).toBe('new name')
    for (const key of ['config', 'owner_id', 'tenant_id', 'workspace_id', 'scope_kind']) expect(after[key]).toEqual(before[key])
  })

  it('stale creation cannot take over an approved active id', async () => {
    const a = await manager()
    const b = await manager()
    await a.addDataSource(config('existing-create', true), scope)
    const before = await row('existing-create')
    await expect(b.addDataSource(config('existing-create', false), { ...scope, actor: ownerActor }))
      .rejects.toMatchObject({ status: 409 })
    expect(await row('existing-create')).toEqual(before)
  })

  it('actual insert conflict waits for uncommitted winner and refuses overwrite', async () => {
    const id = 'concurrent-create'
    const b = await manager()
    const held = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await held.query('BEGIN')
      await held.query(`INSERT INTO data_sources(id,name,type,config,owner_id,tenant_id,scope_kind)
        VALUES($1,$1,'plm',$2,'owner','tenant','private')`, [id, { connection: config(id, true).connection, options: config(id, true).options }])
      const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = b.addDataSource(config(id, false), { ...scope, actor: ownerActor }).then(
        () => ({ admitted: true }), error => error)
      expect((await waitForBlocker(pid)).length).toBeGreaterThan(0)
      await held.query('COMMIT')
      expect(await pending).toMatchObject({ status: 409 })
      expect((await row(id)).config.options.visualReviewEnabled).toBe(true)
      expect(() => b.getDataSource(id)).toThrow(/not found/)
    } finally { await held.query('ROLLBACK'); held.release(); await pending }
  })

  it('waiting owner update rechecks administrator change after row-lock release', async () => {
    const id = 'waiting-update'
    const a = await manager()
    await a.addDataSource(config(id, true), scope)
    const b = await manager(true)
    const held = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await held.query('BEGIN')
      await held.query("UPDATE data_sources SET config=jsonb_set(config,'{options,visualReviewEnabled}','false') WHERE id=$1", [id])
      const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = b.updateDataSource(id, { ...config(id, true), name: 'waiting rename' }, { actor: ownerActor }).then(
        () => ({ admitted: true }), error => error)
      expect((await waitForBlocker(pid)).length).toBeGreaterThan(0)
      await held.query('COMMIT')
      expect(await pending).toMatchObject({ status: 409 })
      expect((await row(id)).config.options.visualReviewEnabled).toBe(false)
    } finally { await held.query('ROLLBACK'); held.release(); await pending }
  })

  it('stale dark-cache owner delete observes enabled durable row; administrator may delete', async () => {
    const id = 'delete-authority'
    const a = await manager()
    await a.addDataSource(config(id, false), scope)
    const b = await manager(true)
    await a.updateDataSource(id, config(id, true), scope)
    const before = await row(id)
    await expect(b.removeDataSource(id, { actor: ownerActor })).rejects.toMatchObject({ status: 403 })
    expect(await row(id)).toEqual(before)
    await a.removeDataSource(id, { actor: adminActor })
    expect((await row(id)).is_active).toBe(false)
  })

  it('deleted approved source requires admin revival and active update cannot resurrect it', async () => {
    const id = 'revival'
    const a = await manager()
    await a.addDataSource(config(id, true), scope)
    const stale = await manager(true)
    await a.removeDataSource(id, { actor: adminActor })
    const before = await row(id)
    await expect(stale.updateDataSource(id, config(id, true), scope)).rejects.toMatchObject({ status: 409 })
    await expect((await manager()).addDataSource(config(id, false), { ...scope, actor: ownerActor }))
      .rejects.toMatchObject({ status: 403 })
    expect(await row(id)).toEqual(before)
    await a.addDataSource(config(id, true), scope)
    expect((await row(id)).is_active).toBe(true)
  })
})
