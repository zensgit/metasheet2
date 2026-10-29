import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { assertDirectoryConnectionEnabled, disableDirectoryConnection, withDingTalkConnectionOperation, withDirectoryEnterpriseRegistration } from '../../src/directory/connection-disable'
import { updateDirectoryIntegration } from '../../src/directory/directory-sync'
import { acquireSourceSyncFreezeLock, sourceSyncFreezeLockKey } from '../../src/directory/source-sync-freeze-lock'

let afterRead: (() => Promise<void>) | undefined
let pool: Pool
let admin: Pool
const schema = `connection_stop_${randomUUID().replace(/-/g, '')}`
const appName = schema
vi.mock('../../src/db/pg', () => ({
  query: async (sql: string, params?: unknown[]) => {
    const result = await pool.query(sql, params)
    if (afterRead && sql.includes('WHERE id = $1 AND provider = $2')) {
      const hook = afterRead; afterRead = undefined; await hook()
    }
    return result
  },
  transaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  },
}))
const a = '10000000-0000-4000-8000-000000000001'
const b = '10000000-0000-4000-8000-000000000002'
const c = '10000000-0000-4000-8000-000000000003'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
async function waitForWaiters(count: number) {
  for (let i = 0; i < 200; i++) {
    const result = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [appName])
    if (result.rows[0].n >= count) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('Expected real advisory-lock contention was not observed')
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required; real DB gate must not skip')
  admin = new Pool({ connectionString: process.env.DATABASE_URL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, application_name: appName, max: 10 })
  await pool.query(`CREATE TABLE directory_integrations (id uuid PRIMARY KEY, org_id text NOT NULL, corp_id text NOT NULL, provider text NOT NULL DEFAULT 'dingtalk', status text NOT NULL DEFAULT 'active', name text DEFAULT 'Synthetic', schedule_cron text, schedule_timezone text, default_deprovision_policy text DEFAULT 'mark_inactive', last_sync_at timestamptz, last_success_at timestamptz, last_error text, created_at timestamptz DEFAULT now(), config jsonb, sync_enabled boolean DEFAULT true, updated_at timestamptz DEFAULT now())`)
  await pool.query('CREATE TABLE users (id text, role text); CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean); CREATE TABLE user_external_auth_grants (local_user_id text, enabled boolean); CREATE TABLE business_records (id text, payload jsonb)')
  await pool.query("INSERT INTO users VALUES ('synthetic-user','admin'); INSERT INTO user_orgs VALUES ('synthetic-user','org-a',true); INSERT INTO user_external_auth_grants VALUES ('synthetic-user',true); INSERT INTO business_records VALUES ('synthetic-record','{\"retained\":true}')")
})
afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() } })
beforeEach(async () => {
  afterRead = undefined
  await pool.query('DELETE FROM directory_integrations')
  await pool.query(`INSERT INTO directory_integrations (id,org_id,corp_id,config) VALUES
    ($1,'org-a','corp-a','{"appKey":"app-a","appSecret":"enc:invalid-ciphertext-must-not-be-decrypted"}'),
    ($2,'org-a','corp-a','{"appKey":"app-b"}'),
    ($3,'org-b','corp-a','{"appKey":"app-c"}')`, [a,b,c])
})
async function retainedFingerprint() {
  const result = await pool.query(`SELECT json_build_object('users',(SELECT json_agg(t) FROM users t),'orgs',(SELECT json_agg(t) FROM user_orgs t),'grants',(SELECT json_agg(t) FROM user_external_auth_grants t),'business',(SELECT json_agg(t) FROM business_records t)) AS snapshot`)
  return result.rows[0].snapshot
}
describe('connection disable with real PostgreSQL and synthetic data', () => {
  it('disables one integration without decrypting or changing local access/data', async () => {
    const before = await retainedFingerprint()
    expect(await disableDirectoryConnection(a, 'integration')).toEqual({ integrationIds: [a], disabled: true })
    const rows = (await pool.query('SELECT id,status,config,sync_enabled FROM directory_integrations ORDER BY id')).rows
    expect(rows.map((r) => [r.id,r.status,r.sync_enabled,r.config.connectionDisabled === true])).toEqual([[a,'active',false,true],[b,'active',true,false],[c,'active',true,false]])
    expect(rows[0].config.appSecret).toBe('enc:invalid-ciphertext-must-not-be-decrypted')
    expect(await retainedFingerprint()).toEqual(before)
  })
  it('enterprise scope is tenant-bound and blocks new connections for the stopped enterprise', async () => {
    const before = await retainedFingerprint()
    expect(await disableDirectoryConnection(a, 'enterprise')).toEqual({ integrationIds: [a,b], disabled: true })
    await expect(withDirectoryEnterpriseRegistration('org-a','corp-a','synthetic-new-app',async () => 'created')).rejects.toMatchObject({ code: 'DIRECTORY_ENTERPRISE_CONNECTION_DISABLED' })
    expect(await withDirectoryEnterpriseRegistration('org-b','corp-a','synthetic-other-app',async () => 'other-org')).toBe('other-org')
    const sent = vi.fn(async () => 'sent')
    expect(await withDingTalkConnectionOperation('app-c',sent)).toBe('sent')
    expect(await retainedFingerprint()).toEqual(before)
  })
  it('rejects shared-app scope expansion atomically', async () => {
    await pool.query("UPDATE directory_integrations SET config = '{\"appKey\":\"app-a\"}' WHERE id = $1",[c])
    await expect(disableDirectoryConnection(a,'enterprise')).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_APP_SHARED' })
    expect((await pool.query("SELECT count(*)::int AS n FROM directory_integrations WHERE config->'connectionDisabled' = 'true'::jsonb")).rows[0].n).toBe(0)
  })
  it('waits for a real in-flight send to finish before acknowledging disable', async () => {
    const entered = deferred(); const release = deferred()
    const send = withDingTalkConnectionOperation('app-a',async () => { entered.resolve(); await release.promise; return 'sent' })
    await entered.promise
    let done = false
    const stop = disableDirectoryConnection(a,'integration').then((result) => { done = true; return result })
    try { await waitForWaiters(1); expect(done).toBe(false) } finally { release.resolve() }
    expect(await send).toBe('sent'); await stop
    const forbidden = vi.fn()
    await expect(withDingTalkConnectionOperation('app-a',forbidden)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('rechecks a queued send after disable wins the real source lock', async () => {
    const blocker = await pool.connect()
    await blocker.query('SELECT pg_advisory_lock(hashtext($1))',[sourceSyncFreezeLockKey(a)])
    const stop = disableDirectoryConnection(a,'integration')
    let late: Promise<unknown> | undefined
    const send = vi.fn(async () => 'forbidden')
    try {
      await waitForWaiters(1)
      late = withDingTalkConnectionOperation('app-a',send)
      // Attach a handler before releasing the blocker so a correct refusal is never unhandled.
      late.catch(() => {})
      await waitForWaiters(2)
    } finally { await blocker.query('SELECT pg_advisory_unlock(hashtext($1))',[sourceSyncFreezeLockKey(a)]); blocker.release() }
    await stop
    await expect(late).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    expect(send).not.toHaveBeenCalled()
  })
  it('does not let a stale generic credential edit erase a committed stop', async () => {
    await pool.query(`UPDATE directory_integrations SET config = '{"appKey":"app-a","appSecret":"synthetic-secret"}' WHERE id = $1`,[a])
    const read = deferred(); const release = deferred()
    afterRead = async () => { read.resolve(); await release.promise }
    const update = updateDirectoryIntegration(a,{ name: 'Synthetic', corpId: 'corp-a', appKey: 'changed-app', appSecret: 'synthetic-secret' })
    update.catch(() => {})
    await read.promise
    try { await disableDirectoryConnection(a,'integration') } finally { release.resolve() }
    await expect(update).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_CHANGED' })
    expect((await pool.query('SELECT config FROM directory_integrations WHERE id = $1',[a])).rows[0].config).toMatchObject({ appKey: 'app-a', connectionDisabled: true })
  })
  it('retains the stop and enterprise marker across ordinary config saves', async () => {
    await pool.query(`UPDATE directory_integrations SET config = '{"appKey":"app-a","appSecret":"synthetic-secret"}' WHERE id = $1`,[a])
    await disableDirectoryConnection(a,'enterprise')
    await updateDirectoryIntegration(a,{ name: 'Renamed', corpId: 'corp-a', appKey: 'app-a', appSecret: 'synthetic-secret', syncEnabled: true, connectionDisabled: false } as never)
    const config = (await pool.query('SELECT config FROM directory_integrations WHERE id = $1',[a])).rows[0].config
    expect((await pool.query('SELECT sync_enabled FROM directory_integrations WHERE id = $1',[a])).rows[0].sync_enabled).toBe(false)
    expect(config.connectionDisabled).toBe(true)
    expect(config.enterpriseConnectionDisabled).toBe(true)
    await expect(updateDirectoryIntegration(a,{ name: 'Renamed', corpId: 'corp-a', appKey: 'changed-app', appSecret: 'synthetic-secret' })).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
  })
  it('does not let a different active integration adopt a stopped application', async () => {
    await pool.query(`UPDATE directory_integrations SET config = '{"appKey":"app-c","appSecret":"synthetic-secret"}' WHERE id = $1`,[c])
    await disableDirectoryConnection(a,'integration')
    await expect(updateDirectoryIntegration(c,{ name: 'Synthetic', corpId: 'corp-a', appKey: 'app-a', appSecret: 'synthetic-secret' })).rejects.toMatchObject({ code: 'DIRECTORY_ENTERPRISE_CONNECTION_DISABLED' })
    expect((await pool.query('SELECT config FROM directory_integrations WHERE id = $1',[c])).rows[0].config.appKey).toBe('app-c')
  })
  it('rejects stale unregistered send contexts after a connection has stopped', async () => {
    await disableDirectoryConnection(a,'integration')
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation('unregistered-old-app',send)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_SCOPE_REQUIRED' })
    expect(send).not.toHaveBeenCalled()
    expect(await withDingTalkConnectionOperation('app-c',async () => 'other-registered-org')).toBe('other-registered-org')
  })
  it('blocks the sync apply protocol after disable while retaining membership', async () => {
    await disableDirectoryConnection(a,'integration')
    const client = await pool.connect()
    const before = await retainedFingerprint()
    try {
      await client.query('BEGIN'); await acquireSourceSyncFreezeLock(client,a)
      await expect(assertDirectoryConnectionEnabled(a,client)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
      expect(await retainedFingerprint()).toEqual(before)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
})
