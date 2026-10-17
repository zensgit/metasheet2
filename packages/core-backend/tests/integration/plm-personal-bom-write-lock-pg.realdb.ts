/**
 * Real PostgreSQL lock order for public bind vs requireUsable.
 * Not collected by the default unit run (the name is not *.test.ts).
 * Runs through vitest.plm-personal-bom-write-lock.config.ts with an explicit
 * owned local socket or the opt-in disposable PostgreSQL CI service.
 * A skip is not this proof. The fake-pool SQL order test is not this proof.
 *
 * Use barrier matches /tmp/plm-bom-binding-pg-control.mts: after
 * `plm_personal_bom_write_bindings` `WHERE id=$1` `FOR UPDATE` returns, wait until
 * pg_blocking_pids shows the other session blocked. The opposite order pauses bind
 * after `data_sources` `FOR UPDATE` returns, before the binding lock.
 *
 * The same owned socket also runs the retired-grant resurrection cases: a new
 * grant still binds, and a credential already pending or unknown for this
 * binding is refused before it becomes the live secret. A retired DELETE that
 * receives 429 keeps its ciphertext and is revoked on a later 204 restart.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { up } from '../../src/db/migrations/zzzz20261017010000_create_plm_personal_bom_write_bindings'
import { decryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { PlmPersonalBomWriteBindingService } from '../../src/services/PlmPersonalBomWriteBindingService'

function explicitDisposableUrl(): string | null {
  const raw = process.env.PLM_PERSONAL_BOM_WRITE_TEST_PG_URL || process.env.MAIN_OWNED_META_PG_URL
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!['postgresql:', 'postgres:'].includes(url.protocol)) return null
    const ownedSocket = url.searchParams.get('host')?.startsWith('/tmp/plm-bom-main-pg-') === true
    const ciService = process.env.EXPECT_PLM_PERSONAL_BOM_WRITE_DB === '1'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === '/plm_personal_disposable'
    return ownedSocket || ciService ? raw : null
  } catch {
    return null
  }
}

const rawUrl = explicitDisposableUrl()
if (process.env.PLM_BOM_LOCK_PG_REQUIRED === 'true' && !rawUrl)
  throw new Error('Explicit disposable personal BOM PostgreSQL URL required')

const owner = 'meta-owner'
const sourceId = 'source-1'
const connection = 'conn-1'
const token = (id: string) => `yuw_${id.repeat(32)}_${'c'.repeat(43)}`

function searchPathUrl(url: string, schema: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('options', `-csearch_path=${schema}`)
  return parsed.href
}

describe.skipIf(!rawUrl)('personal BOM write binding postgres lock order', () => {
  const leftovers: Array<() => Promise<void>> = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    while (leftovers.length) {
      const close = leftovers.pop()
      if (close) await close()
    }
  })

  it('requireUsable holds the source lock before bind and both commit', async () => {
    await race('use-then-bind')
  }, 20000)

  it('bind holds the source lock before requireUsable and both commit', async () => {
    await race('bind-then-use')
  }, 20000)

  it('accepts a new grant while an unknown retirement remains and retry leaves it bound', async () => {
    const fx = await prepare()
    await bind(fx.service, 'a')
    await bind(fx.service, 'b')
    const saved = await bind(fx.service, 'c')
    expect(saved.bound).toBe(true)
    expect(saved.grantId).toBe('c'.repeat(32))
    const row = await live(fx.pool)
    expect(row.grant_id).toBe('c'.repeat(32))
    expect(row.target_origin).toBe('https://native.invalid')
    expect(row.remote_revoke_state).toBeNull()
    expect(decryptStoredSecretValue(row.encrypted_grant!)).toBe(token('c'))
    const history = await retired(fx.pool)
    expect(history.map((item) => item.grant_id)).toEqual(['a'.repeat(32), 'b'.repeat(32)])
    expect(history.every((item) => item.state === 'unknown' && item.slot === 'previous')).toBe(true)
    expect(decryptStoredSecretValue(history[0].encrypted_grant!)).toBe(token('a'))
    expect(decryptStoredSecretValue(history[1].encrypted_grant!)).toBe(token('b'))

    fx.interrupt.on = false
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    await fx.restart().retryRetiredRevocations(owner)
    expect([...fx.revoked]).toEqual(['a'.repeat(32), 'b'.repeat(32)])
    const kept = await live(fx.pool)
    expect(decryptStoredSecretValue(kept.encrypted_grant!)).toBe(token('c'))
    expect(kept.grant_id).toBe('c'.repeat(32))
    expect(kept.remote_revoke_state).toBeNull()
    expect(kept.previous_grant_revoke_state).toBe('revoked')
    const done = await retired(fx.pool)
    expect(done.every((item) => item.state === 'revoked' && item.encrypted_grant == null)).toBe(true)
    expect(fx.revoked.has('c'.repeat(32))).toBe(false)
  }, 20000)

  it('rejects A-B-A reuse of an unknown retired grant and retry revokes only A', async () => {
    const fx = await prepare()
    await bind(fx.service, 'a')
    const replaced = await bind(fx.service, 'b')
    const before = await live(fx.pool)
    const history = await retired(fx.pool)
    expect(replaced.bound).toBe(true)
    expect(before.grant_id).toBe('b'.repeat(32))
    expect(decryptStoredSecretValue(before.encrypted_grant!)).toBe(token('b'))
    expect(history).toHaveLength(1)
    expect(history[0].state).toBe('unknown')
    expect(decryptStoredSecretValue(history[0].encrypted_grant!)).toBe(token('a'))

    await expect(bind(fx.service, 'a')).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    const after = await live(fx.pool)
    const still = await retired(fx.pool)
    expect(after.encrypted_grant).toBe(before.encrypted_grant)
    expect(after.grant_id).toBe(before.grant_id)
    expect(after.target_origin).toBe('https://native.invalid')
    expect(after.generation).toBe(before.generation)
    expect(still[0].encrypted_grant).toBe(history[0].encrypted_grant)
    expect(still[0].state).toBe('unknown')
    expect(fx.revoked.size).toBe(0)

    fx.interrupt.on = false
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    await fx.restart().retryRetiredRevocations(owner)
    expect([...fx.revoked]).toEqual(['a'.repeat(32)])
    const current = await live(fx.pool)
    expect(current.grant_id).toBe('b'.repeat(32))
    expect(decryptStoredSecretValue(current.encrypted_grant!)).toBe(token('b'))
    expect(current.remote_revoke_state).toBeNull()
    expect(current.generation).toBe(before.generation)
    expect(fx.revoked.has(current.grant_id)).toBe(false)
    const done = await retired(fx.pool)
    expect(done[0].state).toBe('revoked')
    expect(done[0].encrypted_grant).toBeNull()
  }, 20000)

  it('keeps a 429 retired grant encrypted and revokes it on restart after 204', async () => {
    const fx = await prepare()
    fx.interrupt.status = 429
    await bind(fx.service, 'a')
    const replaced = await bind(fx.service, 'b')
    expect(replaced.bound).toBe(true)
    expect(replaced.previousGrantRevokeState).toBe('unknown')
    expect(fx.revoked.size).toBe(0)
    const before = await live(fx.pool)
    const history = await retired(fx.pool)
    expect(before.grant_id).toBe('b'.repeat(32))
    expect(before.remote_revoke_state).toBeNull()
    expect(before.previous_grant_revoke_state).toBe('unknown')
    expect(decryptStoredSecretValue(before.encrypted_grant!)).toBe(token('b'))
    expect(history).toHaveLength(1)
    expect(history[0].state).toBe('unknown')
    expect(history[0].slot).toBe('previous')
    expect(decryptStoredSecretValue(history[0].encrypted_grant!)).toBe(token('a'))

    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    await fx.restart().retryRetiredRevocations(owner)
    const held = await retired(fx.pool)
    expect(held[0].state).toBe('unknown')
    expect(held[0].encrypted_grant).toBe(history[0].encrypted_grant)
    expect(fx.revoked.size).toBe(0)

    fx.interrupt.on = false
    await fx.restart().retryRetiredRevocations(owner)
    expect([...fx.revoked]).toEqual(['a'.repeat(32)])
    const done = await retired(fx.pool)
    expect(done[0].state).toBe('revoked')
    expect(done[0].encrypted_grant).toBeNull()
    const kept = await live(fx.pool)
    expect(kept.grant_id).toBe('b'.repeat(32))
    expect(kept.remote_revoke_state).toBeNull()
    expect(kept.previous_grant_revoke_state).toBe('revoked')
    expect(decryptStoredSecretValue(kept.encrypted_grant!)).toBe(token('b'))
    expect(fx.revoked.has(kept.grant_id)).toBe(false)
  }, 20000)

  it('rejects unbind then rebind of the same grant and retry leaves it unbound', async () => {
    const fx = await prepare()
    const saved = await bind(fx.service, 'a')
    const unbound = await fx.service.unbind(owner, saved.id)
    expect(unbound.bound).toBe(false)
    expect(unbound.remoteRevokeState).toBe('unknown')
    const before = await live(fx.pool)
    const history = await retired(fx.pool)
    expect(before.encrypted_grant).toBeNull()
    expect(before.generation).toBe(2)
    expect(before.remote_revoke_state).toBe('unknown')
    expect(history[0].slot).toBe('current')
    expect(history[0].state).toBe('unknown')
    expect(decryptStoredSecretValue(history[0].encrypted_grant!)).toBe(token('a'))

    await expect(bind(fx.service, 'a')).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    const after = await live(fx.pool)
    const still = await retired(fx.pool)
    expect(after.encrypted_grant).toBeNull()
    expect(after.generation).toBe(2)
    expect(after.remote_revoke_state).toBe('unknown')
    expect(still[0].encrypted_grant).toBe(history[0].encrypted_grant)
    expect(still[0].state).toBe('unknown')
    expect(fx.revoked.size).toBe(0)

    fx.interrupt.on = false
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    await fx.restart().retryRetiredRevocations(owner)
    expect([...fx.revoked]).toEqual(['a'.repeat(32)])
    const current = await live(fx.pool)
    expect(current.encrypted_grant).toBeNull()
    expect(current.generation).toBe(2)
    expect(current.remote_revoke_state).toBe('revoked')
    const done = await retired(fx.pool)
    expect(done[0].state).toBe('revoked')
    expect(done[0].encrypted_grant).toBeNull()
    const listed = await fx.restart().list(owner)
    expect(listed).toEqual([
      expect.objectContaining({ bound: false, remoteRevokeState: 'revoked', grantId: 'a'.repeat(32) }),
    ])
  }, 20000)

  async function race(order: 'use-then-bind' | 'bind-then-use'): Promise<void> {
    if (!rawUrl) throw new Error('owned socket required')
    process.env.NODE_ENV = 'test'
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
    process.env.ENCRYPTION_KEY ||= 'synthetic-pg-lock-order-key'
    process.env.ENCRYPTION_SALT ||= 'synthetic-pg-lock-order-salt'
    const schema = `plm_bom_lock_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: rawUrl, max: 1 })
    let pool: Pool | undefined
    let db: Kysely<unknown> | undefined
    let releaseGate = () => {}
    leftovers.push(async () => {
      releaseGate()
      if (db) await db.destroy()
      else if (pool) await pool.end()
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: searchPathUrl(rawUrl, schema), max: 6 })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await pool.query(
      `CREATE TABLE users(id text PRIMARY KEY, is_active boolean NOT NULL);
       CREATE TABLE data_sources(
         id text PRIMARY KEY, owner_id text, workspace_id text, tenant_id text,
         scope_kind text, type text, config jsonb, is_active boolean, deleted_at timestamptz
       )`,
    )
    await up(db)
    const config = {
      id: sourceId,
      name: 'Source',
      type: 'plm',
      connection: { url: 'https://native.invalid', headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1' } },
      options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
    }
    await pool.query('INSERT INTO users VALUES($1,true)', [owner])
    await pool.query(
      "INSERT INTO data_sources VALUES($1,$2,'workspace-1','meta-a','private','plm',$3,true,NULL)",
      [sourceId, owner, JSON.stringify(config)],
    )
    const targets: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers: Record<string, string> }) => {
      const origin = new URL(String(url)).origin
      targets.push(origin)
      expect(origin).toBe('https://native.invalid')
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      const grantId = init.headers.Authorization.slice('Bearer yuw_'.length, 'Bearer yuw_'.length + 32)
      return new Response(JSON.stringify({
        schema: 'yuantus.plm-bom-write-binding.v1',
        grant_id: grantId,
        connection_id: connection,
        tenant_id: 'yt-b',
        org_id: 'org-1',
        auth_user_id: '42',
        expires_at: '2027-01-01T00:00:00.000000Z',
        purpose: 'bom_write',
      }), { status: 200 })
    })
    const adapter = new PLMAdapter(
      { get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { ...config, connection: { ...config.connection, url: 'https://stale-native.invalid' } } as never,
    )
    const provider = () => adapter
    const setup = new PlmPersonalBomWriteBindingService(pool, provider)
    const first = await setup.bind(owner, { dataSourceId: sourceId, connectionId: connection, grant: token('a') })
    expect(first.id).toBeTruthy()

    let releaseHeld = () => {}
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const usePid = { pid: 0 }
    const bindPid = { pid: 0 }
    const usePool = gatedPool(pool, (sql) => (
      sql.includes('FROM plm_personal_bom_write_bindings') &&
      sql.includes('WHERE id=$1') &&
      sql.includes('FOR UPDATE')
    ), usePid, held, gate, releaseHeld)
    const bindPool = gatedPool(
      pool,
      (sql) => order === 'bind-then-use' && sql.includes('FROM data_sources') && sql.includes('FOR UPDATE'),
      bindPid,
      held,
      gate,
      releaseHeld,
    )
    const useService = new PlmPersonalBomWriteBindingService(usePool, provider)
    const bindService = new PlmPersonalBomWriteBindingService(bindPool, provider)
    const settle = <T>(work: Promise<T>) => work.then(
      (value) => ({ ok: true as const, code: null, id: (value as { id?: string }).id ?? null }),
      (error: { code?: string }) => ({ ok: false as const, code: error.code ?? null, id: null }),
    )
    if (order === 'use-then-bind') {
      const use = settle(useService.requireUsable(owner, first.id))
      await Promise.race([
        held,
        new Promise((_, reject) => setTimeout(() => reject(new Error('use barrier not reached')), 5000)),
      ])
      const bind = settle(bindService.bind(owner, {
        dataSourceId: sourceId,
        connectionId: connection,
        grant: token('b'),
      }))
      expect(await blocked(pool, () => bindPid.pid, usePid.pid)).toBe(true)
      releaseGate()
      const [used, bound] = await Promise.all([use, bind])
      expect(used).toMatchObject({ ok: true, code: null })
      expect(bound).toMatchObject({ ok: true, code: null })
    } else {
      const bind = settle(bindService.bind(owner, {
        dataSourceId: sourceId,
        connectionId: connection,
        grant: token('b'),
      }))
      await Promise.race([
        held,
        new Promise((_, reject) => setTimeout(() => reject(new Error('bind barrier not reached')), 5000)),
      ])
      const use = settle(useService.requireUsable(owner, first.id))
      expect(await blocked(pool, () => usePid.pid, bindPid.pid)).toBe(true)
      releaseGate()
      const [bound, used] = await Promise.all([bind, use])
      expect(bound).toMatchObject({ ok: true, code: null })
      expect(used).toMatchObject({ ok: true, code: null })
    }
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((origin) => origin === 'https://native.invalid')).toBe(true)
    expect(targets).not.toContain('https://stale-native.invalid')
  }

  async function prepare(): Promise<{
    pool: Pool
    service: PlmPersonalBomWriteBindingService
    restart: () => PlmPersonalBomWriteBindingService
    interrupt: { on: boolean; status?: number }
    revoked: Set<string>
  }> {
    if (!rawUrl) throw new Error('owned socket required')
    process.env.NODE_ENV = 'test'
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
    process.env.ENCRYPTION_KEY ||= 'synthetic-pg-lock-order-key'
    process.env.ENCRYPTION_SALT ||= 'synthetic-pg-lock-order-salt'
    const schema = `plm_bom_lock_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: rawUrl, max: 1 })
    let pool: Pool | undefined
    let db: Kysely<unknown> | undefined
    leftovers.push(async () => {
      if (db) await db.destroy()
      else if (pool) await pool.end()
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: searchPathUrl(rawUrl, schema), max: 4 })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await pool.query(
      `CREATE TABLE users(id text PRIMARY KEY, is_active boolean NOT NULL);
       CREATE TABLE data_sources(
         id text PRIMARY KEY, owner_id text, workspace_id text, tenant_id text,
         scope_kind text, type text, config jsonb, is_active boolean, deleted_at timestamptz
       )`,
    )
    await up(db)
    const config = {
      id: sourceId,
      name: 'Source',
      type: 'plm',
      connection: { url: 'https://native.invalid', headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1' } },
      options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
    }
    await pool.query('INSERT INTO users VALUES($1,true)', [owner])
    await pool.query(
      "INSERT INTO data_sources VALUES($1,$2,'workspace-1','meta-a','private','plm',$3,true,NULL)",
      [sourceId, owner, JSON.stringify(config)],
    )
    const interrupt: { on: boolean; status?: number } = { on: true }
    const revoked = new Set<string>()
    vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers: Record<string, string> }) => {
      const origin = new URL(String(url)).origin
      expect(origin).toBe('https://native.invalid')
      const grantId = init.headers.Authorization.split('_')[1]
      if (init.method === 'DELETE') {
        if (interrupt.on) {
          if (interrupt.status) return new Response('{}', { status: interrupt.status })
          throw new TypeError('synthetic interruption before revoke')
        }
        revoked.add(grantId)
        return new Response(null, { status: 204 })
      }
      if (revoked.has(grantId)) return new Response('{}', { status: 401 })
      return new Response(JSON.stringify({
        schema: 'yuantus.plm-bom-write-binding.v1',
        grant_id: grantId,
        connection_id: connection,
        tenant_id: 'yt-b',
        org_id: 'org-1',
        auth_user_id: '42',
        expires_at: '2027-01-01T00:00:00.000000Z',
        purpose: 'bom_write',
      }), { status: 200 })
    })
    const adapter = new PLMAdapter(
      { get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { ...config, connection: { ...config.connection, url: 'https://stale-native.invalid' } } as never,
    )
    const provider = () => adapter
    const ready = pool
    return {
      pool: ready,
      service: new PlmPersonalBomWriteBindingService(ready, provider),
      restart: () => new PlmPersonalBomWriteBindingService(ready, provider),
      interrupt,
      revoked,
    }
  }

  function bind(service: PlmPersonalBomWriteBindingService, id: string) {
    return service.bind(owner, { dataSourceId: sourceId, connectionId: connection, grant: token(id) })
  }

  async function live(pool: Pool) {
    const found = await pool.query<{
      grant_id: string
      encrypted_grant: string | null
      generation: number
      target_origin: string
      remote_revoke_state: string | null
      previous_grant_revoke_state: string | null
    }>(
      `SELECT grant_id, encrypted_grant, generation, target_origin, remote_revoke_state, previous_grant_revoke_state
       FROM plm_personal_bom_write_bindings`,
    )
    return found.rows[0]
  }

  async function retired(pool: Pool) {
    const found = await pool.query<{
      grant_id: string
      state: string
      encrypted_grant: string | null
      slot: string
      target_origin: string
    }>(
      `SELECT grant_id, state, encrypted_grant, slot, target_origin
       FROM plm_personal_bom_write_retired_grants ORDER BY created_at, id`,
    )
    return found.rows
  }
})

function gatedPool(
  pool: Pool,
  match: (sql: string) => boolean,
  pid: { pid: number },
  held: Promise<void>,
  gate: Promise<void>,
  releaseHeld: () => void,
): Pick<Pool, 'connect'> {
  return {
    async connect() {
      const client = await pool.connect()
      pid.pid = client.processID
      return {
        release: () => client.release(),
        async query(sql: string, params?: unknown[]) {
          const out = await client.query(sql, params)
          if (match(sql)) {
            releaseHeld()
            await gate
          }
          return out
        },
      } as PoolClient
    },
  }
}

async function blocked(pool: Pool, waiter: () => number, holder: number): Promise<boolean> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const waiterPid = waiter()
    if (waiterPid) {
      const found = await pool.query('SELECT pg_blocking_pids($1) AS blockers', [waiterPid])
      const blockers = found.rows[0].blockers as Array<number | string>
      if (blockers.map(Number).includes(holder)) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}
