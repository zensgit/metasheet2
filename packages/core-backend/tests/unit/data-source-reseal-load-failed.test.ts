/**
 * Re-seal a data source that FAILED TO LOAD because its stored credential is unreadable (#6079
 * dev-machine follow-up; #6067 §5 R6).
 *
 * The situation this file pins: ENCRYPTION_KEY / ENCRYPTION_SALT change (e.g. finally configured on
 * a server that ran on the built-in defaults), so a source whose password was sealed under the old
 * material fails to decrypt at startup. loadFromDatabase logs and skips it, so it never enters
 * `adapters` / `scopes`: listing hid it and every id route — including PUT /:id/credentials —
 * answered 404. The only way back was POST-create with the same id, whose upsert silently
 * re-assigned owner / tenant / scope. The fix:
 *
 *   - loadFromDatabase records WHY a row failed (closed vocabulary; classified by a TYPED error,
 *     never by message prose) — metadata only, never config / credentials / error text;
 *   - GET /api/data-sources carries a SIBLING `data.loadFailed` (owner / platform admin only;
 *     omitted when empty) and leaves `items` / `total` untouched;
 *   - PUT /:id/credentials re-seals a credentials_unreadable row IN PLACE, owner / platform admin
 *     only, everyone else getting the byte-identical 404 of a nonexistent id with no DB work;
 *   - inside ONE transaction (SELECT … FOR UPDATE), the config is rebuilt from the ROW and only
 *     `config` + `updated_at` are written, under the same guarded WHERE;
 *   - an id armed for SQL write with no LOAD-phase pin is persisted but NOT loaded at runtime
 *     (restartRequired) — the runtime path never pins (FIX 2);
 *   - POST-create at a load-failed id is refused like a loaded duplicate (the takeover path).
 *
 * Harness: a STATEFUL fake Kysely (`makeFakeDb`) that EVALUATES the where-predicates it is given
 * (so a dropped `is_active` / `deleted_at` guard is observable), logs every statement with the
 * executor it ran on (`db` autocommit vs `trx`), and stages transactional writes on a copy that is
 * folded back only when the callback resolves (a refusal leaves the rows byte-identical). Route
 * cases go through ONE pinned listener (no `request(app)` — the #4154 tripwire).
 *
 * Values-free: every credential value below is a POISON marker asserted absent from responses and
 * audit rows; hosts are reserved `.test` names.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'

import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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
  DATA_SOURCE_CREDENTIALS_REQUIRED_CODE,
  DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE,
  DATA_SOURCE_LOAD_FAILED_STALE_CODE,
  DATA_SOURCE_RESEAL_IN_PROGRESS_CODE,
  DATA_SOURCE_RESEAL_NOT_PERSISTED_CODE,
  DataSourceManager,
} from '../../src/data-adapters/DataSourceManager'
import { OUTBOUND_SQL_WRITE_TARGETS_ENV } from '../../src/data-adapters/outbound-sql-write-gate'
import {
  __resetSqlArmBindingsForTests,
  sqlSourceConnectionMatchesPin,
} from '../../src/data-adapters/sql-write-arm-binding'
import { decryptStoredSecretValue, encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { auditLog } from '../../src/audit/audit'
import {
  dataSourcesRouter,
  getDataSourceManager,
  initializeDataSourceManager,
} from '../../src/routes/data-sources'
import { usePinnedServer } from '../utils/pinned-server'

const auditMock = vi.mocked(auditLog)

// ── encryption material: the file runs under CURRENT material; PREVIOUS seals the "old" rows ──
const PREVIOUS = { key: 'reseal-test-previous-key-0123456789abcdef', salt: 'reseal-test-previous-salt-0123456789' }
const CURRENT = { key: 'reseal-test-current-key-fedcba9876543210', salt: 'reseal-test-current-salt-9876543210' }
const savedMaterial = { key: process.env.ENCRYPTION_KEY, salt: process.env.ENCRYPTION_SALT }

function useMaterial(m: { key: string; salt: string }): void {
  process.env.ENCRYPTION_KEY = m.key
  process.env.ENCRYPTION_SALT = m.salt
}
useMaterial(CURRENT)

const sealCache = new Map<string, string>()
function sealWith(material: typeof PREVIOUS, plaintext: string): string {
  const cacheKey = `${material.key}|${plaintext}`
  const hit = sealCache.get(cacheKey)
  if (hit) return hit
  useMaterial(material)
  try {
    const sealed = encryptStoredSecretValue(plaintext)
    sealCache.set(cacheKey, sealed)
    return sealed
  } finally {
    useMaterial(CURRENT)
  }
}

// ── poison: if any of these ever appears in a response body or an audit row, credentials stopped
//    being write-only. ──
const POISON = {
  oldPassword: 'POISON-old-password-4b1e9d27c3a0',
  oldApiKey: 'POISON-old-apikey-8c2f61e0b7d5',
  currentToken: 'POISON-current-token-2e7a93c4f1b8',
  newPassword: 'POISON-new-password-6d0b18f5a2c9',
  newApiKey: 'POISON-new-apikey-a93e4c7d0f21',
  username: 'POISON-username-17f0c2e8b4a6',
}
const POISON_VALUES = Object.values(POISON)
function expectNoPoison(value: unknown): void {
  const text = JSON.stringify(value)
  for (const poison of POISON_VALUES) expect(text).not.toContain(poison)
}

// ── actors ──
const OWNER_ID = 'u_reseal_owner'
const OTHER_ID = 'u_reseal_other'
const ADMIN_ID = 'u_reseal_admin'
const DS_PERMS = ['data_sources:read', 'data_sources:write', 'data_sources:execute']
const OWNER = { id: OWNER_ID, roles: ['member'], permissions: DS_PERMS }
const OTHER = { id: OTHER_ID, roles: ['member'], permissions: DS_PERMS }
const ADMIN = { id: ADMIN_ID, role: 'admin' }

// ── rows ──
type Row = Record<string, unknown>
const CONNECTION = { host: 'db.reseal.test', port: 5432, database: 'plm', encrypt: true, trustServerCertificate: false }

function row(id: string, over: Row = {}): Row {
  return {
    id,
    name: `name-${id}`,
    type: 'postgres',
    description: null,
    config: {
      connection: { ...CONNECTION },
      credentials: { username: POISON.username, password: sealWith(PREVIOUS, POISON.oldPassword) },
      options: { autoConnect: false, readOnly: true, apiMode: 'kept-option' },
      poolConfig: { max: 3, idleTimeout: 1000 },
      // An unknown top-level config key must survive a re-seal byte-for-byte.
      legacyExtra: { kept: true },
    },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: OWNER_ID,
    workspace_id: 'ws-reseal',
    tenant_id: 'tenant-reseal',
    scope_kind: 'private',
    is_active: true,
    auto_connect: false,
    metadata: null,
    tags: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null,
    ...over,
  }
}

// ── the fake Kysely ──
type Where = Array<[string, string, unknown]>
interface Stmt {
  tag: 'db' | 'trx'
  kind: 'select' | 'select-for-update' | 'update' | 'insert' | 'delete'
  table: string
  where: Where
  set?: Record<string, unknown>
}

function matches(r: Row, where: Where): boolean {
  return where.every(([column, op, value]) => {
    if (op === '=') return r[column] === value
    if (op === 'is') return (r[column] ?? null) === value
    throw new Error(`fake db: unsupported operator ${op}`)
  })
}

function clone<T>(v: T): T {
  return structuredClone(v)
}

function makeFakeDb(initial: Row[] = []) {
  const rows = new Map<string, Row>(initial.map((r) => [String(r.id), clone(r)]))
  const log: Stmt[] = []
  const control: {
    failUpdate: Error | null
    // Parks the FOR UPDATE select until released (concurrency cases).
    gateForUpdate: { reached: () => void; wait: Promise<void> } | null
    // Runs right before the FOR UPDATE select resolves (simulates a concurrent committed change).
    beforeForUpdateResolves: ((rows: Map<string, Row>) => void) | null
  } = { failUpdate: null, gateForUpdate: null, beforeForUpdateResolves: null }

  function onlyDataSources(table: string): void {
    if (table !== 'data_sources') throw new Error(`fake db: table ${table} is not modelled`)
  }

  function executor(tag: 'db' | 'trx', store: Map<string, Row>) {
    return {
      selectFrom(table: string) {
        if (table === 'integration_external_systems') {
          // The listing's reference counts: nothing references these sources.
          const refs = { select: () => refs, where: () => refs, groupBy: () => refs, execute: async () => [] }
          return refs
        }
        onlyDataSources(table)
        const where: Where = []
        let forUpdate = false
        const b = {
          selectAll: () => b,
          select: () => b,
          where: (c: string, o: string, v: unknown) => {
            where.push([c, o, v])
            return b
          },
          forUpdate: () => {
            forUpdate = true
            return b
          },
          execute: async () => {
            log.push({ tag, kind: forUpdate ? 'select-for-update' : 'select', table, where: [...where] })
            if (forUpdate && control.gateForUpdate) {
              const gate = control.gateForUpdate
              gate.reached()
              await gate.wait
            }
            if (forUpdate && control.beforeForUpdateResolves) control.beforeForUpdateResolves(store)
            return [...store.values()].filter((r) => matches(r, where)).map((r) => clone(r))
          },
        }
        return b
      },
      updateTable(table: string) {
        onlyDataSources(table)
        const where: Where = []
        let set: Record<string, unknown> = {}
        const b = {
          set: (s: Record<string, unknown>) => {
            set = s
            return b
          },
          where: (c: string, o: string, v: unknown) => {
            where.push([c, o, v])
            return b
          },
          execute: async () => {
            log.push({ tag, kind: 'update', table, where: [...where], set: clone(set) })
            if (control.failUpdate && 'config' in set) throw control.failUpdate
            let n = 0
            for (const r of store.values()) {
              if (!matches(r, where)) continue
              Object.assign(r, clone(set))
              n += 1
            }
            return [{ numUpdatedRows: BigInt(n) }]
          },
        }
        return b
      },
      insertInto(table: string) {
        onlyDataSources(table)
        let pending: Row = {}
        const b = {
          values: (v: Row) => {
            pending = v
            return b
          },
          onConflict: () => b,
          execute: async () => {
            log.push({ tag, kind: 'insert', table, where: [] })
            const existing = store.get(String(pending.id))
            store.set(String(pending.id), { ...(existing ?? {}), ...clone(pending) })
            return []
          },
        }
        return b
      },
      deleteFrom(table: string) {
        onlyDataSources(table)
        const b = {
          where: () => b,
          execute: async () => {
            log.push({ tag, kind: 'delete', table, where: [] })
            return []
          },
        }
        return b
      },
    }
  }

  const db = {
    ...executor('db', rows),
    transaction: () => ({
      execute: async <T>(cb: (trx: ReturnType<typeof executor>) => Promise<T>): Promise<T> => {
        const staged = new Map<string, Row>([...rows].map(([k, v]) => [k, clone(v)]))
        const result = await cb(executor('trx', staged))
        rows.clear()
        for (const [k, v] of staged) rows.set(k, v)
        return result
      },
    }),
  }
  return { db, rows, log, control }
}

// ── fake adapter: no dialing ──
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
  async connect(): Promise<void> { this.connected = true; await this.onConnect() }
  async disconnect(): Promise<void> { this.connected = false; await this.onDisconnect() }
  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return true }
}
// An adapter whose constructor throws an Error WORDED like the decrypt failure. It must classify as
// `load_failed`: the classification reads the error's TYPE, never its prose.
class ProseTrapAdapter extends OkAdapter {
  constructor(config: DataSourceConfig) {
    super(config)
    throw new Error("Failed to decrypt credential 'password' (ENCRYPTION_KEY may have changed): look-alike")
  }
}

async function makeManager(rows: Row[]) {
  const fake = makeFakeDb(rows)
  const manager = new DataSourceManager()
  manager.registerAdapterType('postgres', OkAdapter as never)
  manager.registerAdapterType('prosetrap', ProseTrapAdapter as never)
  await manager.initialize(fake.db as never)
  return { manager, ...fake }
}

function thrownBy(fn: () => unknown): Error & { status?: number; code?: string; details?: Record<string, unknown> } {
  try {
    fn()
  } catch (error) {
    return error as Error & { status?: number; code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected a throw')
}

async function rejectionOf(p: Promise<unknown>): Promise<Error & { status?: number; code?: string; details?: Record<string, unknown> }> {
  try {
    await p
  } catch (error) {
    return error as Error & { status?: number; code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected a rejection')
}

// ── SQL write allowlist fixture (deploy-tier arming), same shape as outbound-sql-write-gate.test.ts ──
const savedAllowlistEnv = process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV]
const tempFiles: string[] = []
function armForSqlWrite(systemId: string): void {
  const file = path.join(os.tmpdir(), `reseal-sql-write-allowlist-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify({
    allowlistId: 'reseal-test',
    allowlistVersion: 1,
    targets: [{ entryId: 'e1', systemId, allObjects: true }],
  }), 'utf8')
  tempFiles.push(file)
  process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV] = file
}

afterEach(() => {
  __resetSqlArmBindingsForTests() // the arm-binding registry is a process singleton
  if (savedAllowlistEnv === undefined) delete process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV]
  else process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV] = savedAllowlistEnv
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* best effort */ }
  }
})

afterAll(() => {
  if (savedMaterial.key === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = savedMaterial.key
  if (savedMaterial.salt === undefined) delete process.env.ENCRYPTION_SALT
  else process.env.ENCRYPTION_SALT = savedMaterial.salt
})

const ADMIN_ACTOR = { userId: ADMIN_ID, platformAdmin: true }
const OWNER_ACTOR = { userId: OWNER_ID, platformAdmin: false }
const OTHER_ACTOR = { userId: OTHER_ID, platformAdmin: false }

// ═══════════════════════════ MANAGER ═══════════════════════════

describe('loadFromDatabase records WHY a row failed (closed vocabulary, typed classification)', () => {
  it('classifies decrypt / unsupported type / anything else, and leaves listDataSources() shape untouched', async () => {
    const { manager } = await makeManager([
      row('m-cred'),
      row('m-type', { type: 'oracle' }),
      row('m-bad', { config: null }),
      row('m-prose', { type: 'prosetrap', config: { connection: {}, credentials: { password: 'plain' } } }),
      row('m-ok', { config: { connection: { ...CONNECTION }, credentials: { password: 'plain-ok' } } }),
    ])

    const failed = manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR })
    const states = Object.fromEntries(failed.map((f) => [f.id, f.loadState]))
    expect(states).toEqual({
      'm-cred': 'credentials_unreadable',
      'm-type': 'unsupported_type',
      'm-bad': 'load_failed',
      // Worded exactly like the decrypt failure, but not the typed error → NOT credentials_unreadable.
      'm-prose': 'load_failed',
    })
    for (const entry of failed) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'loadState', 'name', 'ownerId', 'type'])
      expectNoPoison(entry)
    }

    // The loaded listing is exactly the old projection, and only the loaded source.
    expect(manager.listDataSources({ actor: ADMIN_ACTOR })).toEqual([
      { id: 'm-ok', name: 'name-m-ok', type: 'postgres', connected: false, ownerId: OWNER_ID },
    ])
  })

  it('unusable encryption MATERIAL is load_failed, not credentials_unreadable (a credential cannot fix it)', async () => {
    const materialRow = row('m-material') // sealed BEFORE the material is taken away
    const savedNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    delete process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_SALT
    try {
      const { manager } = await makeManager([materialRow])
      expect(manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR })).toEqual([
        expect.objectContaining({ id: 'm-material', loadState: 'load_failed' }),
      ])
    } finally {
      process.env.NODE_ENV = savedNodeEnv
      useMaterial(CURRENT)
    }
  })

  it('a later successful load clears the recorded failure (the source is no longer a re-seal candidate)', async () => {
    const { manager } = await makeManager([row('m-later')])
    expect(manager.resolveCredentialRouteTarget('m-later', OWNER_ACTOR)).toBe('load_failed')
    useMaterial(PREVIOUS) // the old material comes back: the same row now decrypts
    try {
      await manager.loadFromDatabase()
    } finally {
      useMaterial(CURRENT)
    }
    expect(() => manager.getDataSource('m-later')).not.toThrow()
    expect(manager.resolveCredentialRouteTarget('m-later', OWNER_ACTOR)).toBe('loaded')
    expect(manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR })).toEqual([])
  })

  it('a second loadFromDatabase over already-loaded ids never marks a live source as failed', async () => {
    const { manager } = await makeManager([row('m-live', { config: { connection: {}, credentials: {} } })])
    await manager.loadFromDatabase()
    expect(manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR })).toEqual([])
    expect(() => manager.getDataSource('m-live')).not.toThrow()
  })
})

describe('listLoadFailedDataSources visibility = scopePermitsListing (owner / platform admin only)', () => {
  it('owner sees own, admin sees all, another user and an id-less actor see nothing', async () => {
    const { manager } = await makeManager([
      row('v-mine'),
      row('v-theirs', { owner_id: OTHER_ID }),
      row('v-ownerless', { owner_id: null }),
    ])
    const ids = (actor: unknown) =>
      manager.listLoadFailedDataSources({ actor: actor as never }).map((f) => f.id).sort()

    expect(ids(OWNER_ACTOR)).toEqual(['v-mine'])
    expect(ids(OWNER_ID)).toEqual(['v-mine']) // bare user-id shape: owner-only, no admin tier
    expect(ids(OTHER_ACTOR)).toEqual(['v-theirs'])
    expect(ids(ADMIN_ACTOR)).toEqual(['v-mine', 'v-ownerless', 'v-theirs'])
    expect(ids({})).toEqual([])
    expect(ids(undefined)).toEqual([])
    expect(ids({ userId: ADMIN_ID })).toEqual([]) // admin tier needs the management actor shape
  })
})

// Replaces the manager's three private lookup maps with traced copies, so a test can compare the
// exact in-memory work two refusals performed.
function traceLookups(manager: DataSourceManager): string[] {
  const trace: string[] = []
  const fields = manager as unknown as Record<'adapters' | 'scopes' | 'loadFailures', Map<string, unknown>>
  for (const field of ['adapters', 'scopes', 'loadFailures'] as const) {
    const traced = new Map(fields[field])
    const get = traced.get.bind(traced)
    const has = traced.has.bind(traced)
    traced.get = (key: string) => { trace.push(`${field}.get`); return get(key) }
    traced.has = (key: string) => { trace.push(`${field}.has`); return has(key) }
    fields[field] = traced
  }
  return trace
}

describe('resolveCredentialRouteTarget — one access decision for loaded and load-failed ids', () => {
  it('verdict matrix: owner / platform admin pass for their kind of id; everyone else gets the uniform not-found', async () => {
    const { manager } = await makeManager([
      row('x-failed'),
      row('x-ownerless', { owner_id: null }),
      row('x-loaded', { config: { connection: { ...CONNECTION }, credentials: { password: 'plain-x' } } }),
    ])
    const verdict = (id: string, actor: unknown): string => {
      try {
        return manager.resolveCredentialRouteTarget(id, actor as never)
      } catch (error) {
        return (error as Error).message
      }
    }
    const nf = (id: string) => `Data source with id '${id}' not found`

    expect(verdict('x-loaded', OWNER_ACTOR)).toBe('loaded')
    expect(verdict('x-loaded', OWNER_ID)).toBe('loaded') // bare user-id shape: owner
    expect(verdict('x-loaded', ADMIN_ACTOR)).toBe('loaded')
    expect(verdict('x-loaded', OTHER_ACTOR)).toBe(nf('x-loaded'))
    expect(verdict('x-loaded', { userId: ADMIN_ID })).toBe(nf('x-loaded')) // no admin tier without platformAdmin

    expect(verdict('x-failed', OWNER_ACTOR)).toBe('load_failed')
    expect(verdict('x-failed', OWNER_ID)).toBe('load_failed')
    expect(verdict('x-failed', ADMIN_ACTOR)).toBe('load_failed')
    expect(verdict('x-failed', OTHER_ACTOR)).toBe(nf('x-failed'))
    expect(verdict('x-failed', { userId: ADMIN_ID })).toBe(nf('x-failed'))
    expect(verdict('x-failed', {})).toBe(nf('x-failed'))
    expect(verdict('x-failed', undefined)).toBe(nf('x-failed'))

    // A row with no owner can only be reached by a platform admin.
    expect(verdict('x-ownerless', ADMIN_ACTOR)).toBe('load_failed')
    expect(verdict('x-ownerless', OWNER_ACTOR)).toBe(nf('x-ownerless'))

    expect(verdict('x-missing', ADMIN_ACTOR)).toBe(nf('x-missing'))
    expect(verdict('x-missing', OWNER_ACTOR)).toBe(nf('x-missing'))

    // The loaded verdict is exactly assertAccess's.
    for (const actor of [OWNER_ACTOR, OWNER_ID, ADMIN_ACTOR, OTHER_ACTOR, { userId: ADMIN_ID }, {}, undefined]) {
      let assertVerdict = 'loaded'
      try {
        manager.assertAccess('x-loaded', actor as never)
      } catch (error) {
        assertVerdict = (error as Error).message
      }
      expect(verdict('x-loaded', actor)).toBe(assertVerdict)
    }
  })

  it('EQUAL COST: a non-owner on a load-failed id and anyone on a nonexistent id perform the identical lookup sequence', async () => {
    const { manager, log } = await makeManager([
      row('e-failed01'),
      row('e-loaded01', { owner_id: OTHER_ID, config: { connection: { ...CONNECTION }, credentials: { password: 'plain-e' } } }),
    ])
    const trace = traceLookups(manager)
    log.length = 0

    const run = (id: string, actor: unknown): { message: string; trace: string[] } => {
      trace.length = 0
      const message = thrownBy(() => manager.resolveCredentialRouteTarget(id, actor as never)).message
      return { message, trace: [...trace] }
    }
    const denied = run('e-failed01', OTHER_ACTOR)
    const missing = run('e-missing1', OTHER_ACTOR)
    const loadedDenied = run('e-loaded01', OWNER_ACTOR)
    const anonymousDenied = run('e-failed01', undefined)

    expect(denied.message).toBe("Data source with id 'e-failed01' not found")
    expect(missing.message).toBe("Data source with id 'e-missing1' not found")
    expect(denied.trace.length).toBeGreaterThan(0)
    expect(denied.trace).toEqual(missing.trace)
    expect(loadedDenied.trace).toEqual(missing.trace)
    expect(anonymousDenied.trace).toEqual(missing.trace)
    expect(log).toEqual([]) // no database statement on any refusal
  })
})

describe('resealLoadFailedDataSource — in place, row-sourced, owner/admin only', () => {
  afterEach(() => {
    __resetSqlArmBindingsForTests()
  })

  it('owner re-seal: only config+updated_at written under the guarded WHERE; scope, connection and every other column preserved; source goes live', async () => {
    const { manager, rows, log } = await makeManager([row('r-ok')])
    const before = clone(rows.get('r-ok') as Row)
    log.length = 0

    const result = await manager.resealLoadFailedDataSource('r-ok', { password: POISON.newPassword }, OWNER_ACTOR)
    expect(result.restartRequired).toBe(false)
    expect(result.priorLoadState).toBe('credentials_unreadable')
    expect(result.ownerId).toBe(OWNER_ID)

    // Statement shape: one FOR UPDATE select and one UPDATE, both inside the transaction.
    expect(log.map((s) => `${s.tag}:${s.kind}`)).toEqual(['trx:select-for-update', 'trx:update'])
    const guard: Where = [['id', '=', 'r-ok'], ['is_active', '=', true], ['deleted_at', 'is', null]]
    expect(log[0].where).toEqual(guard)
    expect(log[1].where).toEqual(guard)
    expect(Object.keys(log[1].set ?? {}).sort()).toEqual(['config', 'updated_at'])

    const after = rows.get('r-ok') as Row
    for (const column of Object.keys(before)) {
      if (column === 'config' || column === 'updated_at') continue
      expect(after[column], `column ${column} must be untouched`).toEqual(before[column])
    }
    const beforeConfig = before.config as Record<string, unknown>
    const afterConfig = after.config as Record<string, unknown>
    // Every config key except credentials is byte-identical (connection, options, poolConfig, extras).
    const { credentials: _b, ...beforeRest } = beforeConfig
    const { credentials: afterCredentials, ...afterRest } = afterConfig
    expect(JSON.stringify(afterRest)).toBe(JSON.stringify(beforeRest))
    const creds = afterCredentials as Record<string, string>
    expect(creds.password).toMatch(/^enc:/)
    expect(decryptStoredSecretValue(creds.password)).toBe(POISON.newPassword)
    expect(creds.username).toBe(POISON.username) // identifier kept, plaintext

    // Live, with the ROW's connection and the ROW's scope; the failure record is gone.
    const live = manager.getDataSource('r-ok').getConfig()
    expect(live.connection).toEqual(CONNECTION)
    expect(live.options).toEqual(beforeConfig.options)
    expect(live.credentials?.password).toBe(POISON.newPassword)
    expect(manager.getScope('r-ok')).toEqual({
      ownerId: OWNER_ID,
      workspaceId: 'ws-reseal',
      tenantId: 'tenant-reseal',
      scopeKind: 'private',
    })
    expect(manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR })).toEqual([])
    expect(manager.listDataSources({ actor: OWNER_ACTOR }).map((s) => s.id)).toEqual(['r-ok'])
    // The runtime load never pins (FIX 2): only a restart's LOAD phase may bind a connection.
    expect(sqlSourceConnectionMatchesPin('r-ok', CONNECTION)).toBe(false)
  })

  it('platform admin re-seals ANOTHER owner\'s source without becoming its owner', async () => {
    const { manager, rows } = await makeManager([row('r-admin')])
    await manager.resealLoadFailedDataSource('r-admin', { password: POISON.newPassword }, ADMIN_ACTOR)
    expect((rows.get('r-admin') as Row).owner_id).toBe(OWNER_ID)
    expect((rows.get('r-admin') as Row).tenant_id).toBe('tenant-reseal')
    expect(manager.getScope('r-admin')?.ownerId).toBe(OWNER_ID)
  })

  it('non-owner and nonexistent id: the SAME not-found, and ZERO database statements on either path', async () => {
    const { manager, log } = await makeManager([row('r-deny')])
    log.length = 0

    const denied = thrownBy(() => manager.assertLoadFailedAccess('r-deny', OTHER_ACTOR))
    const missing = thrownBy(() => manager.assertLoadFailedAccess('r-miss', OTHER_ACTOR))
    expect(denied.message).toBe("Data source with id 'r-deny' not found")
    expect(missing.message).toBe("Data source with id 'r-miss' not found")
    // Same wording as the loaded-path refusal (assertAccess) for a nonexistent id.
    expect(thrownBy(() => manager.assertAccess('r-miss', OTHER_ACTOR)).message).toBe(missing.message)

    const deniedAsync = await rejectionOf(manager.resealLoadFailedDataSource('r-deny', { password: 'x1' }, OTHER_ACTOR))
    expect(deniedAsync.message).toBe(denied.message)
    const noUser = await rejectionOf(manager.resealLoadFailedDataSource('r-deny', { password: 'x1' }, {}))
    expect(noUser.message).toBe(denied.message)
    expect(log).toEqual([])
    // Still recorded; nothing about it changed.
    expect(manager.listLoadFailedDataSources({ actor: OWNER_ACTOR }).map((f) => f.id)).toEqual(['r-deny'])
  })

  it('CREDENTIALS_REQUIRED names only the missing KEYS, writes nothing; then a complete re-seal keeps what the current key can read', async () => {
    const tokenUnderCurrentKey = sealWith(CURRENT, POISON.currentToken)
    const { manager, rows, log } = await makeManager([
      row('r-req', {
        config: {
          connection: { ...CONNECTION },
          credentials: {
            username: POISON.username,
            password: sealWith(PREVIOUS, POISON.oldPassword),
            apiKey: sealWith(PREVIOUS, POISON.oldApiKey),
            token: tokenUnderCurrentKey,
          },
          options: { autoConnect: false },
        },
      }),
    ])
    const before = clone(rows.get('r-req') as Row)
    log.length = 0

    const refused = await rejectionOf(
      manager.resealLoadFailedDataSource('r-req', { password: POISON.newPassword }, OWNER_ACTOR),
    )
    expect(refused.status).toBe(400)
    expect(refused.code).toBe(DATA_SOURCE_CREDENTIALS_REQUIRED_CODE)
    expect(refused.details).toEqual({ missingCredentialKeys: ['apiKey'] })
    expectNoPoison({ message: refused.message, details: refused.details })
    expect(rows.get('r-req')).toEqual(before) // rolled back / never written
    expect(log.some((s) => s.kind === 'update')).toBe(false)
    expect(() => manager.getDataSource('r-req')).toThrow(/not found/)

    await manager.resealLoadFailedDataSource(
      'r-req',
      { password: POISON.newPassword, apiKey: POISON.newApiKey },
      OWNER_ACTOR,
    )
    const creds = manager.getDataSource('r-req').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe(POISON.newPassword)
    expect(creds.apiKey).toBe(POISON.newApiKey)
    expect(creds.token).toBe(POISON.currentToken) // decryptable under the current key → kept
    expect(creds.username).toBe(POISON.username)
  })

  it.each([
    ['owner_id', OTHER_ID],
    ['tenant_id', 'tenant-other'],
    ['scope_kind', 'workspace'],
    ['workspace_id', 'ws-other'],
    ['type', 'mysql'],
    // Not an object any more: must NOT be read as {} (that would write a config with no connection).
    ['config', '{"connection":{}}'],
  ])('STALE: %s changed since the failed load → 409, nothing written, failure kept', async (column, value) => {
    const { manager, rows } = await makeManager([row('r-stale')])
    ;(rows.get('r-stale') as Row)[column] = value
    const before = clone(rows.get('r-stale') as Row)

    const refused = await rejectionOf(
      manager.resealLoadFailedDataSource('r-stale', { password: POISON.newPassword }, OWNER_ACTOR),
    )
    expect(refused.status).toBe(409)
    expect(refused.code).toBe(DATA_SOURCE_LOAD_FAILED_STALE_CODE)
    expect(rows.get('r-stale')).toEqual(before)
    expect(() => manager.getDataSource('r-stale')).toThrow(/not found/)
    expect(manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR }).map((f) => f.id)).toEqual(['r-stale'])
  })

  it('a concurrent change committed while waiting for the row lock is seen AFTER the lock (stale, not overwritten)', async () => {
    const { manager, rows, control } = await makeManager([row('r-race')])
    control.beforeForUpdateResolves = (store) => {
      ;(store.get('r-race') as Row).owner_id = OTHER_ID
    }
    const refused = await rejectionOf(
      manager.resealLoadFailedDataSource('r-race', { password: POISON.newPassword }, OWNER_ACTOR),
    )
    expect(refused.code).toBe(DATA_SOURCE_LOAD_FAILED_STALE_CODE)
    expect((rows.get('r-race') as Row).config).toEqual(row('r-race').config)
  })

  it.each([
    ['soft-deleted', { is_active: false, deleted_at: new Date('2026-02-01T00:00:00Z') }],
    ['deactivated', { is_active: false }],
    ['deleted_at set', { deleted_at: new Date('2026-02-01T00:00:00Z') }],
  ])('GONE (%s): the uniform not-found, nothing written, the failure record dropped', async (_label, change) => {
    const { manager, rows } = await makeManager([row('r-gone')])
    Object.assign(rows.get('r-gone') as Row, change)
    const before = clone(rows.get('r-gone') as Row)

    const refused = await rejectionOf(
      manager.resealLoadFailedDataSource('r-gone', { password: POISON.newPassword }, OWNER_ACTOR),
    )
    expect(refused.message).toBe("Data source with id 'r-gone' not found")
    expect(refused.code).toBeUndefined()
    expect(rows.get('r-gone')).toEqual(before)
    expect(manager.listLoadFailedDataSources({ actor: ADMIN_ACTOR })).toEqual([])
  })

  it('NOT RESEALABLE: unsupported_type / load_failed → coded 409 for the owner; still the uniform not-found for others', async () => {
    const { manager, rows, log } = await makeManager([
      row('r-type', { type: 'oracle' }),
      row('r-bad', { config: null }),
    ])
    const before = clone([...rows.values()])
    log.length = 0
    for (const [id, state] of [['r-type', 'unsupported_type'], ['r-bad', 'load_failed']] as const) {
      const refused = await rejectionOf(manager.resealLoadFailedDataSource(id, { password: 'x1' }, OWNER_ACTOR))
      expect(refused.status).toBe(409)
      expect(refused.code).toBe(DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE)
      expect(refused.details).toEqual({ loadState: state })
      const other = await rejectionOf(manager.resealLoadFailedDataSource(id, { password: 'x1' }, OTHER_ACTOR))
      expect(other.message).toBe(`Data source with id '${id}' not found`)
    }
    expect(log).toEqual([])
    expect([...rows.values()]).toEqual(before)
  })

  it('ARMED for SQL write with no LOAD-phase pin: credentials persisted, NOT loaded at runtime, restartRequired; the next load pins the row connection', async () => {
    const { manager, rows } = await makeManager([row('r-armed')])
    armForSqlWrite('r-armed')

    const result = await manager.resealLoadFailedDataSource('r-armed', { password: POISON.newPassword }, OWNER_ACTOR)
    expect(result.restartRequired).toBe(true)
    expect(result.connected).toBe(false)
    const stored = ((rows.get('r-armed') as Row).config as { credentials: Record<string, string> }).credentials
    expect(decryptStoredSecretValue(stored.password)).toBe(POISON.newPassword)
    // Not live, not pinned by the runtime path. Its credential is readable now, so it is no longer
    // credentials_unreadable: it is load_failed (an administrator's restart), and not re-sealable.
    expect(() => manager.getDataSource('r-armed')).toThrow(/not found/)
    expect(manager.getScope('r-armed')).toBeUndefined()
    expect(sqlSourceConnectionMatchesPin('r-armed', CONNECTION)).toBe(false)
    expect(manager.listLoadFailedDataSources({ actor: OWNER_ACTOR })).toEqual([
      expect.objectContaining({ id: 'r-armed', loadState: 'load_failed' }),
    ])
    const again = await rejectionOf(
      manager.resealLoadFailedDataSource('r-armed', { password: POISON.newApiKey }, OWNER_ACTOR),
    )
    expect(again.status).toBe(409)
    expect(again.code).toBe(DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE)
    expect(again.details).toEqual({ loadState: 'load_failed' })
    expect(decryptStoredSecretValue(
      ((rows.get('r-armed') as Row).config as { credentials: Record<string, string> }).credentials.password,
    )).toBe(POISON.newPassword)

    // "Restart": a fresh manager over the same rows loads it through the LOAD phase, which pins the
    // row's (unchanged) connection.
    const restarted = new DataSourceManager()
    restarted.registerAdapterType('postgres', OkAdapter as never)
    await restarted.initialize(makeFakeDb([...rows.values()]).db as never)
    expect(restarted.getDataSource('r-armed').getConfig().credentials?.password).toBe(POISON.newPassword)
    expect(sqlSourceConnectionMatchesPin('r-armed', CONNECTION)).toBe(true)
  })

  it('auto_connect on the row is honored after a runtime load', async () => {
    const { manager } = await makeManager([row('r-auto', { auto_connect: true })])
    const result = await manager.resealLoadFailedDataSource('r-auto', { password: POISON.newPassword }, OWNER_ACTOR)
    expect(result.connected).toBe(true)
    expect(manager.getDataSource('r-auto').isConnected()).toBe(true)
  })

  it('a second re-seal of the same id while one is running is refused (409), not raced', async () => {
    const { manager, control } = await makeManager([row('r-busy')])
    let reached!: () => void
    const reachedP = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    control.gateForUpdate = { reached, wait }

    const first = manager.resealLoadFailedDataSource('r-busy', { password: POISON.newPassword }, OWNER_ACTOR)
    await reachedP
    const second = await rejectionOf(
      manager.resealLoadFailedDataSource('r-busy', { password: POISON.newPassword }, ADMIN_ACTOR),
    )
    expect(second.status).toBe(409)
    expect(second.code).toBe(DATA_SOURCE_RESEAL_IN_PROGRESS_CODE)
    control.gateForUpdate = null
    release()
    await first
    expect(() => manager.getDataSource('r-busy')).not.toThrow()
  })

  it('a failed write is a values-free coded 500 and changes nothing', async () => {
    const { manager, rows, control } = await makeManager([row('r-fail')])
    const before = clone(rows.get('r-fail') as Row)
    control.failUpdate = Object.assign(new Error('connect ECONNREFUSED db.reseal.test:5432 user=svc_plm'), { code: '08006' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const refused = await rejectionOf(
        manager.resealLoadFailedDataSource('r-fail', { password: POISON.newPassword }, OWNER_ACTOR),
      )
      expect(refused.status).toBe(500)
      expect(refused.code).toBe(DATA_SOURCE_RESEAL_NOT_PERSISTED_CODE)
      expect(refused.message).not.toContain('db.reseal.test')
      expect(refused.message).not.toContain('svc_plm')
    } finally {
      warn.mockRestore()
    }
    expect(rows.get('r-fail')).toEqual(before)
    expect(manager.listLoadFailedDataSources({ actor: OWNER_ACTOR }).map((f) => f.id)).toEqual(['r-fail'])
  })

  it('no credential value reaches a log line (load failure, CREDENTIALS_REQUIRED, failed write)', async () => {
    const lines: string[] = []
    const capture = (...args: unknown[]): void => {
      lines.push(args.map((a) => inspect(a, { depth: 8 })).join(' '))
    }
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(capture))
    try {
      const { manager, control } = await makeManager([
        row('l-req', {
          config: {
            connection: { ...CONNECTION },
            credentials: {
              username: POISON.username,
              password: sealWith(PREVIOUS, POISON.oldPassword),
              apiKey: sealWith(PREVIOUS, POISON.oldApiKey),
            },
          },
        }),
        row('l-fail'),
      ])
      await rejectionOf(manager.resealLoadFailedDataSource('l-req', { password: POISON.newPassword }, OWNER_ACTOR))
      control.failUpdate = Object.assign(new Error('driver refused the write'), { code: '08006' })
      await rejectionOf(
        manager.resealLoadFailedDataSource('l-fail', { password: POISON.newPassword, apiKey: POISON.newApiKey }, OWNER_ACTOR),
      )
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(lines.some((line) => line.includes('Credential re-seal could not be persisted'))).toBe(true)
    expectNoPoison(lines)
  })

  it('POST-create at a load-failed id is refused like a loaded duplicate — the row is not taken over', async () => {
    const { manager, rows } = await makeManager([row('r-takeover')])
    const before = clone(rows.get('r-takeover') as Row)
    const refused = await rejectionOf(
      manager.addDataSource(
        { id: 'r-takeover', name: 'hijack', type: 'postgres', connection: { host: 'elsewhere.test' } },
        { ownerId: OTHER_ID, tenantId: 'tenant-other', scopeKind: 'private' },
      ),
    )
    expect(refused.message).toBe("Data source with id 'r-takeover' already exists")
    expect(rows.get('r-takeover')).toEqual(before)
  })
})

// ═══════════════════════════ ROUTES ═══════════════════════════

const ROUTE_ROWS: Row[] = [
  row('rt-list'),
  row('rt-list-other', { owner_id: OTHER_ID }),
  row('rt-loaded', { config: { connection: { ...CONNECTION }, credentials: { password: 'plain-loaded' } } }),
  row('rt-owner'),
  row('rt-admin'),
  row('rt-deny01'),
  row('rt-req', {
    config: {
      connection: { ...CONNECTION },
      credentials: { password: sealWith(PREVIOUS, POISON.oldPassword), apiKey: sealWith(PREVIOUS, POISON.oldApiKey) },
      options: { autoConnect: false },
    },
  }),
  row('rt-type', { type: 'oracle' }),
  row('rt-stale'),
  row('rt-armed'),
  row('rt-routes'),
  row('rt-create'),
  row('rt-strict'),
]
const routeFake = makeFakeDb(ROUTE_ROWS)

let currentUser: Record<string, unknown> | undefined
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = currentUser as never
  req.authenticatedTenantId = currentUser ? 'tenant-reseal' : undefined
  next()
})
app.use(dataSourcesRouter())
const pinned = usePinnedServer()

function as(user: Record<string, unknown> | undefined) {
  currentUser = user
  pinned.setApp(app)
  return request(pinned.url())
}

function notFoundBody(id: string) {
  return { ok: false, error: { code: 'NOT_FOUND', message: `Data source '${id}' not found` } }
}

function auditCalls(resourceId: string) {
  return auditMock.mock.calls.map(([o]) => o).filter((o) => o.resourceId === resourceId)
}

describe('routes — listing, re-seal and the unchanged 404 surface', () => {
  beforeAll(async () => {
    // Register the no-dial adapter on the singleton BEFORE it loads the rows.
    getDataSourceManager().registerAdapterType('postgres', OkAdapter as never)
    await initializeDataSourceManager(routeFake.db as never)
  })

  afterEach(() => {
    __resetSqlArmBindingsForTests()
  })

  it('GET /api/data-sources: items unchanged; loadFailed is a SIBLING for owner/admin, ABSENT for others', async () => {
    const owner = await as(OWNER).get('/api/data-sources')
    expect(owner.status).toBe(200)
    expect(Object.keys(owner.body.data).sort()).toEqual(['items', 'loadFailed', 'total'])
    const ownerItems = (owner.body.data.items as Array<{ id: string }>).map((i) => i.id)
    expect(ownerItems).toEqual(['rt-loaded'])
    expect(owner.body.data.total).toBe(1)
    const ownerFailed = owner.body.data.loadFailed as Array<Record<string, unknown>>
    expect(ownerFailed.find((f) => f.id === 'rt-list')).toEqual({
      id: 'rt-list', name: 'name-rt-list', type: 'postgres', loadState: 'credentials_unreadable', ownerId: OWNER_ID,
    })
    expect(ownerFailed.map((f) => f.id)).not.toContain('rt-list-other')
    expectNoPoison(owner.body)

    const admin = await as(ADMIN).get('/api/data-sources')
    const adminFailed = (admin.body.data.loadFailed as Array<{ id: string }>).map((f) => f.id)
    expect(adminFailed).toEqual(expect.arrayContaining(['rt-list', 'rt-list-other']))

    // A user who owns nothing that failed: the body is exactly the pre-existing shape.
    const stranger = await as({ id: 'u_reseal_stranger', roles: ['member'], permissions: DS_PERMS }).get('/api/data-sources')
    expect(stranger.body).toEqual({ ok: true, data: { items: [], total: 0 } })
  })

  it('owner PUT /:id/credentials re-seals in place: 200, values-free body + audit, and the source is live', async () => {
    auditMock.mockClear()
    const res = await as(OWNER).put('/api/data-sources/rt-owner/credentials').send({ credentials: { password: POISON.newPassword } })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      id: 'rt-owner', resealed: true, restartRequired: false, connected: false, hasCredentials: true, connection: CONNECTION,
    })
    expect(res.body.data.credentials).toBeUndefined()
    expectNoPoison(res.body)

    const audits = auditCalls('rt-owner')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actorId: OWNER_ID,
      action: 'update_credentials',
      resourceType: 'data_source',
      meta: {
        resealed: true, loadState: 'credentials_unreadable', restartRequired: false,
        changedCredentialKeys: ['password'], ownerId: OWNER_ID,
      },
    })
    expect(audits[0].meta).not.toHaveProperty('crossOwnerAdmin')
    expectNoPoison(audits)

    const detail = await as(OWNER).get('/api/data-sources/rt-owner')
    expect(detail.status).toBe(200)
    expect(detail.body.data.ownerId).toBe(OWNER_ID)
  })

  it('platform admin re-seal is audited as cross-owner and does not take ownership', async () => {
    auditMock.mockClear()
    const res = await as(ADMIN).put('/api/data-sources/rt-admin/credentials').send({ credentials: { password: POISON.newPassword } })
    expect(res.status).toBe(200)
    expect(auditCalls('rt-admin')[0]).toMatchObject({ actorId: ADMIN_ID, meta: { crossOwnerAdmin: true, ownerId: OWNER_ID } })
    expect((routeFake.rows.get('rt-admin') as Row).owner_id).toBe(OWNER_ID)
    expect((await as(OWNER).get('/api/data-sources/rt-admin')).status).toBe(200)
  })

  it('EXISTENCE NON-DISCLOSURE: another user on a load-failed id ≡ a nonexistent id (status, body, headers), no DB statement, no audit', async () => {
    auditMock.mockClear()
    const logBefore = routeFake.log.length
    // The refusal is decided by the route's single access resolver, BEFORE the re-seal entry point —
    // exactly where the nonexistent-id path stops too (not by the manager's inner re-check).
    const resealSpy = vi.spyOn(getDataSourceManager(), 'resealLoadFailedDataSource')
    const resolveSpy = vi.spyOn(getDataSourceManager(), 'resolveCredentialRouteTarget')
    const denied = await as(OTHER).put('/api/data-sources/rt-deny01/credentials').send({ credentials: { password: 'x1' } })
    const missing = await as(OTHER).put('/api/data-sources/rt-miss01/credentials').send({ credentials: { password: 'x1' } })
    expect(resolveSpy).toHaveBeenCalledTimes(2)
    expect(resealSpy).not.toHaveBeenCalled()
    resealSpy.mockRestore()
    resolveSpy.mockRestore()
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(denied.body).toEqual(notFoundBody('rt-deny01'))
    expect(missing.body).toEqual(notFoundBody('rt-miss01'))
    // Same-length ids, so every byte-bearing header can be compared too.
    const headerView = (h: Record<string, string>) => ({ type: h['content-type'], length: h['content-length'] })
    expect(headerView(denied.headers)).toEqual(headerView(missing.headers))
    expect(routeFake.log.length).toBe(logBefore)
    expect(auditMock).not.toHaveBeenCalled()
  })

  it('CREDENTIALS_REQUIRED → 400 naming only the missing keys; NOT_RESEALABLE → 409 with the load state', async () => {
    const req = await as(OWNER).put('/api/data-sources/rt-req/credentials').send({ credentials: { password: POISON.newPassword } })
    expect(req.status).toBe(400)
    expect(req.body.error.code).toBe(DATA_SOURCE_CREDENTIALS_REQUIRED_CODE)
    expect(req.body.error.details).toEqual({ missingCredentialKeys: ['apiKey'] })
    expectNoPoison(req.body)

    const type = await as(OWNER).put('/api/data-sources/rt-type/credentials').send({ credentials: { password: 'x1' } })
    expect(type.status).toBe(409)
    expect(type.body.error).toMatchObject({ code: DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE, details: { loadState: 'unsupported_type' } })
  })

  it('STALE → 409 and nothing written', async () => {
    ;(routeFake.rows.get('rt-stale') as Row).tenant_id = 'tenant-moved'
    const before = clone(routeFake.rows.get('rt-stale') as Row)
    const res = await as(OWNER).put('/api/data-sources/rt-stale/credentials').send({ credentials: { password: 'x1' } })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(DATA_SOURCE_LOAD_FAILED_STALE_CODE)
    expect(routeFake.rows.get('rt-stale')).toEqual(before)
  })

  it('ARMED id → 200 restartRequired:true; the source stays off every other route until restart', async () => {
    armForSqlWrite('rt-armed')
    const res = await as(OWNER).put('/api/data-sources/rt-armed/credentials').send({ credentials: { password: POISON.newPassword } })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ resealed: true, restartRequired: true, connected: false })
    expectNoPoison(res.body)
    expect((await as(OWNER).get('/api/data-sources/rt-armed')).status).toBe(404)
    const list = await as(OWNER).get('/api/data-sources')
    expect((list.body.data.loadFailed as Array<{ id: string; loadState: string }>).find((f) => f.id === 'rt-armed'))
      .toMatchObject({ loadState: 'load_failed' })
    const again = await as(OWNER).put('/api/data-sources/rt-armed/credentials').send({ credentials: { password: 'x1' } })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatchObject({ code: DATA_SOURCE_LOAD_FAILED_NOT_RESEALABLE_CODE, details: { loadState: 'load_failed' } })
  })

  it('every OTHER id route still answers the uniform 404 for a load-failed id — even to its owner', async () => {
    const id = 'rt-routes'
    const nf = notFoundBody(id)
    const cases: Array<[string, () => request.Test]> = [
      ['GET /:id', () => as(OWNER).get(`/api/data-sources/${id}`)],
      ['PUT /:id', () => as(OWNER).put(`/api/data-sources/${id}`).send({ name: 'renamed' })],
      ['DELETE /:id', () => as(OWNER).delete(`/api/data-sources/${id}`)],
      ['GET /:id/test', () => as(OWNER).get(`/api/data-sources/${id}/test`)],
    ]
    for (const [label, send] of cases) {
      const res = await send()
      expect(res.status, label).toBe(404)
      expect(res.body, label).toEqual(nf)
    }
    for (const [label, send] of [
      ['GET /:id/schema', () => as(OWNER).get(`/api/data-sources/${id}/schema`)],
      ['POST /:id/query', () => as(OWNER).post(`/api/data-sources/${id}/query`).send({ sql: 'select 1' })],
      ['POST /:id/select', () => as(OWNER).post(`/api/data-sources/${id}/select`).send({ table: 't' })],
    ] as Array<[string, () => request.Test]>) {
      expect((await send()).status, label).toBe(404)
    }
    expect((routeFake.rows.get(id) as Row).config).toEqual(row(id).config)
  })

  it('POST create with a load-failed id → 409 CONFLICT, the row keeps its owner/tenant/scope', async () => {
    const before = clone(routeFake.rows.get('rt-create') as Row)
    const res = await as(OTHER).post('/api/data-sources').send({
      id: 'rt-create', name: 'hijack', type: 'postgres', connection: { host: 'elsewhere.test', database: 'x' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
    expect(routeFake.rows.get('rt-create')).toEqual(before)
  })

  it('the request cannot carry connection/options: the credentials schema stays strict', async () => {
    const res = await as(OWNER).put('/api/data-sources/rt-strict/credentials').send({
      credentials: { password: 'x1' }, connection: { host: 'elsewhere.test' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect((routeFake.rows.get('rt-strict') as Row).config).toEqual(row('rt-strict').config)
  })

  it('a LOADED id keeps the pre-existing rotation path (no resealed/restartRequired fields)', async () => {
    const res = await as(OWNER).put('/api/data-sources/rt-loaded/credentials').send({ credentials: { password: POISON.newPassword } })
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('resealed')
    expect(res.body.data).not.toHaveProperty('restartRequired')
    expectNoPoison(res.body)
  })
})
