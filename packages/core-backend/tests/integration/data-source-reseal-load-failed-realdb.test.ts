/**
 * Re-seal of a load-failed data source against REAL PostgreSQL (#6079; #6067 §5 R6).
 *
 * The unit file (tests/unit/data-source-reseal-load-failed.test.ts) pins the contract against a
 * stateful fake. A fake cannot prove the lock and transaction claims, so this file does, against a
 * real server:
 *   - the re-seal runs `SELECT … WHERE id AND is_active AND deleted_at IS NULL FOR UPDATE` and a
 *     guarded `UPDATE … SET config, updated_at WHERE id AND is_active AND deleted_at IS NULL`, inside
 *     ONE transaction, and changes no other column;
 *   - it really WAITS on a row lock held by another session, and a change that session commits
 *     meanwhile (soft delete, owner change, a first re-seal) is what it then sees;
 *   - a second re-seal of the same id: refused in-process while one is running; serialized across
 *     processes by the row lock (the second re-reads the first's committed row);
 *   - every refusal (non-owner, nonexistent, CREDENTIALS_REQUIRED, stale, gone, not re-sealable)
 *     leaves the row byte-identical (same xmin, same row_to_json), and the non-owner / nonexistent
 *     refusals issue NO statement at all.
 *
 * Isolation: every table lives in a throwaway schema (search_path), created from the real
 * migrations and dropped afterwards. Real-DB gate: runs only where DATABASE_URL is configured (the
 * plugin-tests.yml real-DB step, which also sets METASHEET_REAL_DB_TEST_STEP=1 so the sentinel
 * below fails instead of skip-greening when DATABASE_URL is missing there).
 *
 * Values-free: every secret below is a synthetic marker; hosts are reserved `.test` names.
 */
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest'

// The route case below is about the DATA-SOURCE decision, not RBAC: the rbac guard passes on the
// request user's own permission list (namespace admission mocked open), and audit is a no-op, so the
// only database this file's route traffic can reach is the Kysely instance whose statements it logs.
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

import { BaseDataAdapter } from '../../src/data-adapters/BaseAdapter'
import type { ColumnInfo, DbValue, QueryResult, SchemaInfo, TableInfo, Transaction } from '../../src/data-adapters/BaseAdapter'
import {
  DATA_SOURCE_CREDENTIALS_REQUIRED_CODE,
  DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE,
  DATA_SOURCE_LOAD_FAILED_STALE_CODE,
  DATA_SOURCE_RESEAL_IN_PROGRESS_CODE,
  DataSourceManager,
} from '../../src/data-adapters/DataSourceManager'
import { up as createDataSourcesTable } from '../../src/db/migrations/20251206000001_create_data_sources_table'
import { up as addConnectionBinding } from '../../src/db/migrations/zzzz20260902120000_add_integration_connection_binding'
import { up as addLiveIdBindingLock } from '../../src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock'
import { dataSourcesRouter, getDataSourceManager, initializeDataSourceManager } from '../../src/routes/data-sources'
import { decryptStoredSecretValue, encryptStoredSecretValue } from '../../src/security/encrypted-secrets'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

test('sentinel: data-source re-seal real-DB lane must not skip-green', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('data-source re-seal real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

// ── no-dial adapter ──
abstract class FakeBase extends BaseDataAdapter {
  async query<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async select<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
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
  async connect(): Promise<void> { this.connected = true }
  async disconnect(): Promise<void> { this.connected = false }
  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return true }
}

// ── encryption material: rows are sealed under PREVIOUS; the file runs under CURRENT ──
const PREVIOUS = { key: 'reseal-realdb-previous-key-0123456789abcdef', salt: 'reseal-realdb-previous-salt-0123456789' }
const CURRENT = { key: 'reseal-realdb-current-key-fedcba9876543210', salt: 'reseal-realdb-current-salt-9876543210' }
const savedMaterial = { key: process.env.ENCRYPTION_KEY, salt: process.env.ENCRYPTION_SALT }
function useMaterial(m: { key: string; salt: string }): void {
  process.env.ENCRYPTION_KEY = m.key
  process.env.ENCRYPTION_SALT = m.salt
}

const SECRET = {
  oldPassword: 'MARKER-old-password-3c91e7a2',
  oldApiKey: 'MARKER-old-apikey-5d20b8f4',
  newPassword: 'MARKER-new-password-8a4f16c0',
  secondPassword: 'MARKER-second-password-1e7d93b5',
  newApiKey: 'MARKER-new-apikey-6b3c0f92',
  username: 'MARKER-username-0f4e2a71',
}
const OWNER_ID = 'u_reseal_realdb_owner'
const OTHER_ID = 'u_reseal_realdb_other'
const ADMIN_ID = 'u_reseal_realdb_admin'
const OWNER = { userId: OWNER_ID, platformAdmin: false }
const OTHER = { userId: OTHER_ID, platformAdmin: false }
const CONNECTION = { host: 'db.reseal-realdb.test', port: 5432, database: 'plm', encrypt: true }
const SCHEMA = `reseal_realdb_${process.pid}_${Date.now()}`
// application_name of each simulated server process's pool (lets a case see WHICH one waits).
const PROCESS_A = `reseal-realdb-a-${process.pid}`
const PROCESS_B = `reseal-realdb-b-${process.pid}`

const GUARDED_SELECT_FOR_UPDATE =
  /^select \* from "data_sources" where "id" = \$1 and "is_active" = \$2 and "deleted_at" is null for update$/i
const GUARDED_UPDATE =
  /^update "data_sources" set "config" = \$1, "updated_at" = \$2 where "id" = \$3 and "is_active" = \$4 and "deleted_at" is null$/i

describeIfDatabase.sequential('data-source re-seal of a load-failed row — real PostgreSQL', () => {
  let admin: Pool
  let pool: Pool
  let db: Kysely<unknown>
  const sqlLog: string[] = []
  let oldPasswordSealed = ''
  let oldApiKeySealed = ''

  async function insertRow(id: string, over: { config?: unknown; ownerId?: string; type?: string } = {}): Promise<void> {
    const config = over.config ?? {
      connection: CONNECTION,
      credentials: { username: SECRET.username, password: oldPasswordSealed },
      options: { autoConnect: false, readOnly: true },
      poolConfig: { max: 3 },
      legacyExtra: { kept: true },
    }
    await pool.query(
      `INSERT INTO data_sources (id, name, type, config, owner_id, workspace_id, tenant_id, scope_kind, is_active, auto_connect, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'ws-realdb', 'tenant-realdb', 'private', true, false, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [id, `name-${id}`, over.type ?? 'postgres', JSON.stringify(config), over.ownerId ?? OWNER_ID],
    )
  }

  /** xmin + the whole row as JSON: identical means NOT written (not even a no-op UPDATE). */
  async function rowFingerprint(id: string): Promise<string> {
    const r = await pool.query(`SELECT xmin::text AS x, row_to_json(d)::text AS t FROM data_sources d WHERE id = $1`, [id])
    return `${r.rows[0]?.x}|${r.rows[0]?.t}`
  }

  async function freshManager(): Promise<DataSourceManager> {
    const manager = new DataSourceManager()
    manager.registerAdapterType('postgres', OkAdapter as never)
    await manager.initialize(db)
    return manager
  }

  /**
   * Another session takes the row lock and keeps its transaction open. `dispose()` (always call it
   * in `finally`) rolls back whatever is still open and releases the connection, so a failing
   * assertion can never leave an open transaction — or its row lock — in the pool for a later case.
   */
  async function holdRowLock(id: string): Promise<{ client: PoolClient; pid: number; dispose: () => Promise<void> }> {
    const client = await pool.connect()
    await client.query('BEGIN')
    await client.query('SELECT id FROM data_sources WHERE id = $1 FOR UPDATE', [id])
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    const dispose = async (): Promise<void> => {
      await client.query('ROLLBACK').catch(() => {}) // a no-op warning after COMMIT
      client.release()
    }
    return { client, pid, dispose }
  }

  /** True once a backend with this application_name is waiting on a heavyweight lock (~10 s max). */
  async function lockWaiting(applicationName: string): Promise<boolean> {
    for (let i = 0; i < 100; i += 1) {
      const r = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`,
        [applicationName],
      )
      if (r.rows[0].n > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }

  /** Backends of this database currently blocked by `holderPid` (waits up to ~10 s for `count`). */
  async function blockedBy(holderPid: number, count = 1): Promise<number[]> {
    let pids: number[] = []
    for (let i = 0; i < 100; i += 1) {
      const r = await admin.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      )
      pids = r.rows.map((row) => row.pid as number)
      if (pids.length >= count) return pids
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return pids
  }

  function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error & { code?: string; status?: number; details?: unknown } }> {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (error: Error & { code?: string; status?: number; details?: unknown }) => ({ ok: false as const, error }),
    )
  }

  beforeAll(async () => {
    useMaterial(PREVIOUS)
    oldPasswordSealed = encryptStoredSecretValue(SECRET.oldPassword)
    oldApiKeySealed = encryptStoredSecretValue(SECRET.oldApiKey)
    useMaterial(CURRENT)

    admin = new Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
      application_name: PROCESS_A,
      max: 8,
    })
    db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') sqlLog.push(event.query.sql)
      },
    })
    await createDataSourcesTable(db)
    await addConnectionBinding(db)
    await addLiveIdBindingLock(db)
  })

  afterAll(async () => {
    await db?.destroy()
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin?.end()
    if (savedMaterial.key === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = savedMaterial.key
    if (savedMaterial.salt === undefined) delete process.env.ENCRYPTION_SALT
    else process.env.ENCRYPTION_SALT = savedMaterial.salt
  })

  it('owner re-seal: FOR UPDATE + guarded UPDATE of config/updated_at in ONE transaction; every other column unchanged; the source goes live', async () => {
    await insertRow('rdb-ok')
    const manager = await freshManager()
    expect(manager.listLoadFailedDataSources({ actor: OWNER }).map((f) => [f.id, f.loadState]))
      .toEqual([['rdb-ok', 'credentials_unreadable']])
    const before = (await pool.query(`SELECT * FROM data_sources WHERE id = 'rdb-ok'`)).rows[0]

    sqlLog.length = 0
    const result = await manager.resealLoadFailedDataSource('rdb-ok', { password: SECRET.newPassword }, OWNER)
    expect(result.restartRequired).toBe(false)
    expect(sqlLog.map((s) => s.trim().replace(/\s+/g, ' '))).toEqual([
      expect.stringMatching(/^begin$/i),
      expect.stringMatching(GUARDED_SELECT_FOR_UPDATE),
      expect.stringMatching(GUARDED_UPDATE),
      expect.stringMatching(/^commit$/i),
    ])

    const after = (await pool.query(`SELECT * FROM data_sources WHERE id = 'rdb-ok'`)).rows[0]
    for (const column of Object.keys(before)) {
      if (column === 'config' || column === 'updated_at') continue
      expect(after[column], `column ${column} must be untouched`).toEqual(before[column])
    }
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
    const { credentials: _beforeCredentials, ...beforeRest } = before.config
    const { credentials, ...afterRest } = after.config
    expect(afterRest).toEqual(beforeRest)
    expect(credentials.password).toMatch(/^enc:/)
    expect(decryptStoredSecretValue(credentials.password)).toBe(SECRET.newPassword)
    expect(credentials.username).toBe(SECRET.username)

    expect(manager.getDataSource('rdb-ok').getConfig().connection).toEqual(CONNECTION)
    expect(manager.getScope('rdb-ok')).toEqual({
      ownerId: OWNER_ID, workspaceId: 'ws-realdb', tenantId: 'tenant-realdb', scopeKind: 'private',
    })
    expect(manager.listLoadFailedDataSources({ actor: OWNER })).toEqual([])

    // A second re-seal of the same id AFTER success is no re-seal: the id is loaded, so the route
    // takes the ordinary rotation path; the manager's re-seal entry point refuses without SQL.
    expect(manager.resolveCredentialRouteTarget('rdb-ok', OWNER)).toBe('loaded')
    sqlLog.length = 0
    const again = await settle(manager.resealLoadFailedDataSource('rdb-ok', { password: SECRET.secondPassword }, OWNER))
    expect(again.ok).toBe(false)
    expect(!again.ok && again.error.message).toBe("Data source with id 'rdb-ok' not found")
    expect(sqlLog).toEqual([])

    // A restart loads it normally with the re-sealed credential.
    const restarted = await freshManager()
    expect(restarted.getDataSource('rdb-ok').getConfig().credentials?.password).toBe(SECRET.newPassword)
  })

  it('CREDENTIALS_REQUIRED names the missing key only, rolls back, and the row is byte-identical', async () => {
    await insertRow('rdb-req', {
      config: {
        connection: CONNECTION,
        credentials: { username: SECRET.username, password: oldPasswordSealed, apiKey: oldApiKeySealed },
        options: { autoConnect: false },
      },
    })
    const manager = await freshManager()
    const before = await rowFingerprint('rdb-req')
    sqlLog.length = 0
    const refused = await settle(manager.resealLoadFailedDataSource('rdb-req', { password: SECRET.newPassword }, OWNER))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.status).toBe(400)
    expect(refused.error.code).toBe(DATA_SOURCE_CREDENTIALS_REQUIRED_CODE)
    expect(refused.error.details).toEqual({ missingCredentialKeys: ['apiKey'] })
    for (const value of Object.values(SECRET)) expect(JSON.stringify({ m: refused.error.message, d: refused.error.details })).not.toContain(value)
    expect(sqlLog.some((s) => /^update/i.test(s.trim()))).toBe(false)
    expect(sqlLog[sqlLog.length - 1]).toMatch(/^rollback$/i)
    expect(await rowFingerprint('rdb-req')).toBe(before)
    expect(manager.listLoadFailedDataSources({ actor: OWNER }).map((f) => f.id)).toContain('rdb-req')
  })

  it('STALE (owner changed before the re-seal) and NOT RESEALABLE (unsupported type): coded 409, row byte-identical', async () => {
    await insertRow('rdb-stale')
    await insertRow('rdb-type', { type: 'oracle' })
    const manager = await freshManager()
    await pool.query(`UPDATE data_sources SET tenant_id = 'tenant-moved' WHERE id = 'rdb-stale'`)
    const staleBefore = await rowFingerprint('rdb-stale')
    const typeBefore = await rowFingerprint('rdb-type')

    const stale = await settle(manager.resealLoadFailedDataSource('rdb-stale', { password: SECRET.newPassword }, OWNER))
    expect(!stale.ok && stale.error.code).toBe(DATA_SOURCE_LOAD_FAILED_STALE_CODE)
    expect(await rowFingerprint('rdb-stale')).toBe(staleBefore)

    sqlLog.length = 0
    const type = await settle(manager.resealLoadFailedDataSource('rdb-type', { password: SECRET.newPassword }, OWNER))
    expect(!type.ok && type.error.code).toBe(DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE)
    expect(!type.ok && type.error.details).toEqual({ loadState: 'unsupported_type' })
    expect(sqlLog).toEqual([]) // decided from memory, before any statement
    expect(await rowFingerprint('rdb-type')).toBe(typeBefore)
  })

  it('a concurrent SOFT DELETE committed while the re-seal waits on the row lock: the re-seal sees it → not-found, nothing written, failure dropped', async () => {
    await insertRow('rdb-gone')
    const manager = await freshManager()
    const holder = await holdRowLock('rdb-gone')
    const pending = settle(manager.resealLoadFailedDataSource('rdb-gone', { password: SECRET.newPassword }, OWNER))
    try {
      expect(await blockedBy(holder.pid)).toHaveLength(1) // really waiting on THIS session's row lock
      await holder.client.query(`UPDATE data_sources SET is_active = false, deleted_at = now() WHERE id = 'rdb-gone'`)
      await holder.client.query('COMMIT')
    } finally {
      await holder.dispose()
    }
    const outcome = await pending
    expect(!outcome.ok && outcome.error.message).toBe("Data source with id 'rdb-gone' not found")
    const row = (await pool.query(`SELECT config, is_active, deleted_at FROM data_sources WHERE id = 'rdb-gone'`)).rows[0]
    expect(row.is_active).toBe(false)
    expect(row.deleted_at).not.toBeNull()
    expect(row.config.credentials.password).toBe(oldPasswordSealed)
    expect(manager.listLoadFailedDataSources({ actor: OWNER }).map((f) => f.id)).not.toContain('rdb-gone')
  })

  it('a concurrent OWNER CHANGE committed while the re-seal waits on the row lock: 409 stale, nothing written', async () => {
    await insertRow('rdb-race')
    const manager = await freshManager()
    const holder = await holdRowLock('rdb-race')
    const pending = settle(manager.resealLoadFailedDataSource('rdb-race', { password: SECRET.newPassword }, OWNER))
    let afterOwnerChange = ''
    try {
      expect(await blockedBy(holder.pid)).toHaveLength(1)
      await holder.client.query(`UPDATE data_sources SET owner_id = $1 WHERE id = 'rdb-race'`, [OTHER_ID])
      await holder.client.query('COMMIT')
    } finally {
      await holder.dispose()
    }
    const outcome = await pending
    expect(!outcome.ok && outcome.error.code).toBe(DATA_SOURCE_LOAD_FAILED_STALE_CODE)
    afterOwnerChange = await rowFingerprint('rdb-race')
    const row = (await pool.query(`SELECT config, owner_id FROM data_sources WHERE id = 'rdb-race'`)).rows[0]
    expect(row.owner_id).toBe(OTHER_ID)
    expect(row.config.credentials.password).toBe(oldPasswordSealed)
    // The refusal wrote nothing after the other session's commit.
    expect(await rowFingerprint('rdb-race')).toBe(afterOwnerChange)
  })

  it('SECOND RE-SEAL, same process: refused 409 while the first waits on the lock (no statement); the first then completes', async () => {
    await insertRow('rdb-busy')
    const manager = await freshManager()
    const holder = await holdRowLock('rdb-busy')
    const first = settle(manager.resealLoadFailedDataSource('rdb-busy', { password: SECRET.newPassword }, OWNER))
    try {
      expect(await blockedBy(holder.pid)).toHaveLength(1)
      sqlLog.length = 0
      const second = await settle(
        manager.resealLoadFailedDataSource('rdb-busy', { password: SECRET.secondPassword }, { userId: ADMIN_ID, platformAdmin: true }),
      )
      expect(!second.ok && second.error.code).toBe(DATA_SOURCE_RESEAL_IN_PROGRESS_CODE)
      expect(sqlLog).toEqual([])
      await holder.client.query('COMMIT')
    } finally {
      await holder.dispose()
    }
    const outcome = await first
    expect(outcome.ok).toBe(true)
    const row = (await pool.query(`SELECT config FROM data_sources WHERE id = 'rdb-busy'`)).rows[0]
    expect(decryptStoredSecretValue(row.config.credentials.password)).toBe(SECRET.newPassword)
  })

  it('SECOND RE-SEAL, two processes: the row lock serializes them and the second re-reads the first\'s committed row', async () => {
    // Both stored secrets are unreadable. The FIRST re-seal supplies both; the SECOND supplies only the
    // password — it can succeed only if it reads the row AFTER the first committed (the apiKey is
    // then readable under the current key). Without the lock it would answer CREDENTIALS_REQUIRED.
    await insertRow('rdb-twoproc', {
      config: {
        connection: CONNECTION,
        credentials: { username: SECRET.username, password: oldPasswordSealed, apiKey: oldApiKeySealed },
        options: { autoConnect: false },
      },
    })
    // Process B is a separate server process: its own pool (so nothing in A's pool can delay it)
    // and its own application_name (so this case can see that IT waits on the row lock).
    const poolB = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
      application_name: PROCESS_B,
      max: 2,
    })
    const dbB = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: poolB }) })
    try {
      const processA = await freshManager()
      const processB = new DataSourceManager()
      processB.registerAdapterType('postgres', OkAdapter as never)
      await processB.initialize(dbB)

      const holder = await holdRowLock('rdb-twoproc')
      let pendingA: Promise<{ ok: boolean }> | null = null
      let pendingB: Promise<{ ok: boolean }> | null = null
      let bWaitedOnLock = false
      try {
        pendingA = settle(processA.resealLoadFailedDataSource('rdb-twoproc', { password: SECRET.newPassword, apiKey: SECRET.newApiKey }, OWNER))
        expect(await blockedBy(holder.pid, 1)).toHaveLength(1)
        pendingB = settle(processB.resealLoadFailedDataSource('rdb-twoproc', { password: SECRET.secondPassword }, OWNER))
        // B's `SELECT … FOR UPDATE` queues behind A (on the tuple lock A holds while it waits).
        bWaitedOnLock = await lockWaiting(PROCESS_B)
        await holder.client.query('COMMIT')
      } finally {
        await holder.dispose()
      }
      const [a, b] = await Promise.all([pendingA!, pendingB!])
      expect(bWaitedOnLock).toBe(true)
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
    } finally {
      await dbB.destroy()
    }
    const row = (await pool.query(`SELECT config, owner_id, tenant_id, scope_kind, workspace_id FROM data_sources WHERE id = 'rdb-twoproc'`)).rows[0]
    expect(decryptStoredSecretValue(row.config.credentials.password)).toBe(SECRET.secondPassword) // B committed last
    expect(decryptStoredSecretValue(row.config.credentials.apiKey)).toBe(SECRET.newApiKey) // A's, re-read by B
    expect(row.config.credentials.username).toBe(SECRET.username)
    expect([row.owner_id, row.tenant_id, row.scope_kind, row.workspace_id]).toEqual([OWNER_ID, 'tenant-realdb', 'private', 'ws-realdb'])
  })

  it('route: a non-owner on a load-failed id ≡ a nonexistent id — same 404 body, ZERO statements, row byte-identical', async () => {
    await insertRow('rdb-deny01')
    getDataSourceManager().registerAdapterType('postgres', OkAdapter as never)
    await initializeDataSourceManager(db)
    const before = await rowFingerprint('rdb-deny01')

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: OTHER_ID, roles: ['member'], permissions: ['data_sources:write'] } as never
      next()
    })
    app.use(dataSourcesRouter())

    sqlLog.length = 0
    const denied = await request(app).put('/api/data-sources/rdb-deny01/credentials').send({ credentials: { password: SECRET.newPassword } })
    const missing = await request(app).put('/api/data-sources/rdb-miss01/credentials').send({ credentials: { password: SECRET.newPassword } })
    expect(sqlLog).toEqual([])
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(denied.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: "Data source 'rdb-deny01' not found" } })
    expect(missing.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: "Data source 'rdb-miss01' not found" } })
    expect(denied.headers['content-length']).toBe(missing.headers['content-length'])
    expect(await rowFingerprint('rdb-deny01')).toBe(before)
  })
})
