/**
 * PERM-04 — DataSourceManager.removeDataSource must be DURABLE-FIRST.
 *
 * The bug this file pins (minimal-plan §5 PR-2 acceptance: "删除失败不会改变内存状态，
 * 重启后不会复活"): removeDataSource used to disconnect, drop the adapter /
 * connectionPool / scope entry, and only THEN write the soft delete — whose failure
 * was swallowed by console.warn. A delete that failed at the database therefore
 * looked like a success, stopped answering in-process, and CAME BACK at the next
 * restart, because loadFromDatabase re-observes is_active = true AND deleted_at IS NULL.
 *
 * Mutation probe for this file: move the memory clear (adapters/connectionPool/scopes
 * .delete) back ABOVE the db write in removeDataSource and the ordering tests below go
 * red — the fake db observes the in-memory state AT WRITE TIME, so the ordering is
 * asserted directly, not inferred from the end state.
 *
 * W7-B (#5784 owner reservation ②, PR-A) extends the ordering contract INTO the database:
 * the referential check and the soft/hard delete now share ONE transaction whose first
 * statement is `SELECT id FROM data_sources WHERE id = $1 FOR UPDATE`. The fake db logs
 * every statement with the executor it ran on, so the tests pin the ORDER
 * (FOR UPDATE → count → UPDATE) and the EXECUTOR (all `@trx`, never `@db`). In-memory
 * mutation probes (see the verification doc): drop `.forUpdate()`, count on `this.db`
 * instead of `trx`, hoist the count above the transaction, write before counting, or
 * translate the 409 into the 500 — each turns exactly the assertion built for it red.
 *
 * W7-B PR-B (owner ruling 2026-09-20 ①): `force` is RETIRED. The count runs on EVERY delete —
 * an extra `{ force: true }` option changes nothing — and the database's live-connection FK
 * (migration zzzz20260920120000) is the backstop: a 23503 on that constraint raised by the
 * soft delete itself is mapped to the same 409, never to the 500. Mutation probes: re-wrap the
 * count in `if (options?.force !== true)` and the force tests go red; drop the 23503 mapping
 * and the backstop test reads a 500.
 */
import express from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// auditLog writes to the DB; a no-op keeps the route handler DB-free.
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))
// rbacGuard consults these for non-admin users; req.user.permissions carries the grants.
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

import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import {
  DATA_SOURCE_DELETE_NOT_PERSISTED_CODE,
  DATA_SOURCE_LIVE_CONNECTION_FK,
  DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
  DataSourceManager,
} from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter, initializeDataSourceManager } from '../../src/routes/data-sources'
import { usePinnedServer } from '../utils/pinned-server'

// A driver failure's own text is what must NEVER reach the client (it embeds host,
// port, database and login). The fake db throws exactly this shape.
const DRIVER_POISON = 'Login failed for user "svc_plm" at 10.10.52.16:5432 (db=plm_prod)'

/**
 * What `pg` raises when the soft delete trips the PR-B live-connection foreign key on a zh_CN
 * server: SQLSTATE + constraint name are stable; the prose is not English. A mapping keyed on
 * the SQLSTATE sees this; one keyed on "violates foreign key constraint" does not.
 */
function fkViolation(): Error {
  return Object.assign(
    new Error('在 "data_sources" 上更新或删除违反了在 "integration_external_systems" 上的外键约束 (db=plm_prod)'),
    { code: '23503', constraint: DATA_SOURCE_LIVE_CONNECTION_FK, table: 'integration_external_systems' },
  )
}

interface RefRow {
  connectionId?: string | null
  dataSourceId?: string
  ownerId?: string
}

/** Which Kysely instance a statement ran on: the manager's `db`, or the transaction it opened. */
type ExecutorTag = 'db' | 'trx'

interface TransactionRecord {
  committed: boolean
  error: unknown
}

interface Harness {
  db: unknown
  rows: Map<string, Record<string, unknown>>
  refs: RefRow[]
  control: {
    /**
     * `true`: the delete write fails like a dead connection (08006, driver prose).
     * `'fk'`: the delete write is refused by PostgreSQL's live-connection foreign key
     * (23503 on fk_integration_external_systems_live_connection_id) — the PR-B database
     * backstop. Its message is deliberately the zh_CN server's, so a mapping that read the
     * English prose instead of the SQLSTATE would miss it.
     */
    failDataSourceWrite: boolean | 'fk'
    failRefCount: false | 'undefined_table' | 'other'
    /** Observer invoked at the moment the data_sources delete write executes. */
    onDataSourceWrite: (() => void) | null
  }
  /** The delete writes that were ISSUED (committed or not), in order — the pre-W7-B contract. */
  writes: string[]
  /**
   * W7-B: the ORDERED statement log of everything removeDataSource runs, each entry
   * stamped with the executor it ran on (`@db` autocommit vs `@trx` inside the transaction):
   *   for-update:data_sources:<id>@trx  count:canonical:<id>@trx  count:legacy:<id>@trx
   *   soft-delete:data_sources:<id>@trx
   * A `select:data_sources:<id>` entry (no FOR UPDATE) is what the lock step degrades to if the
   * `.forUpdate()` clause is dropped — so the mutation is visible as a different string.
   * The TABLE NAME rides in every data_sources entry (lock, soft delete, hard delete), and the
   * fake THROWS for any table it does not model: a lock taken on some other real table
   * (`selectFrom('integration_runs').forUpdate()`) is not "a lock" — it is a red run.
   */
  ops: string[]
  /** One record per `db.transaction().execute(...)`, in order. */
  transactions: TransactionRecord[]
}

/**
 * Kysely stand-in covering the two tables removeDataSource touches:
 * `data_sources` (stateful rows, so a restart can be simulated by loading them into a
 * second manager) and `integration_external_systems` (the reference count's two
 * non-overlapping COUNT queries: canonical connection_id, then connection_id IS NULL
 * + legacy pointer + owner stamp).
 *
 * W7-B shape: the top-level `db` and the `trx` handed to `transaction().execute(cb)` are the
 * SAME builder set, built by `makeExecutor(tag)`, so a statement issued on either is answered
 * identically — but every statement is logged with the executor it ran on. That is the lever
 * the "count runs on the transaction, not on this.db" assertion turns on.
 *
 * Rollback is REAL at the fake's level: the transaction executor writes to a STAGED copy of
 * `rows` that is folded back only when the callback resolves. A callback that throws leaves
 * `rows` byte-identical, and the record's `committed` stays false.
 */
function makeHarness(): Harness {
  const rows = new Map<string, Record<string, unknown>>()
  const refs: RefRow[] = []
  const writes: string[] = []
  const ops: string[] = []
  const transactions: TransactionRecord[] = []
  const control: Harness['control'] = {
    failDataSourceWrite: false,
    failRefCount: false,
    onDataSourceWrite: null,
  }

  function refCountBuilder(tag: ExecutorTag) {
    const captured: unknown[][] = []
    const b = {
      select: () => b,
      where: (...args: unknown[]) => {
        captured.push(args)
        return b
      },
      execute: async () => {
        if (control.failRefCount === 'undefined_table') {
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' })
        }
        if (control.failRefCount === 'other') {
          throw Object.assign(new Error(DRIVER_POISON), { code: '08006' })
        }
        const first = captured[0]
        if (first?.[0] === 'connection_id' && first[1] === '=') {
          const id = String(first[2])
          ops.push(`count:canonical:${id}@${tag}`)
          return [{ count: refs.filter((r) => r.connectionId === id).length }]
        }
        const id = String(captured[1]?.[2] ?? '')
        const owner = String(captured[2]?.[2] ?? '')
        ops.push(`count:legacy:${id}@${tag}`)
        return [
          {
            count: refs.filter((r) => r.connectionId == null && r.dataSourceId === id && r.ownerId === owner).length,
          },
        ]
      },
    }
    return b
  }

  /**
   * The fake is TABLE-STRICT: `data_sources` is the only stateful table it models, so a
   * statement aimed at any other table name is a harness error, not a silently-answered
   * query. This is what makes the table name in the `ops` log load-bearing — a build that
   * locks / updates / deletes some OTHER table cannot reach a green assertion.
   */
  function assertKnownTable(verb: string, table: string): void {
    if (table !== 'data_sources') {
      throw new Error(`fake db: ${verb}(${JSON.stringify(table)}) — the harness models only data_sources`)
    }
  }

  /** One full builder set over `view` (the live rows, or a transaction's staged copy). */
  function makeExecutor(tag: ExecutorTag, view: Map<string, Record<string, unknown>>) {
    return {
      selectFrom: (table: string) => {
        if (table === 'integration_external_systems') return refCountBuilder(tag)
        assertKnownTable('selectFrom', table)
        let whereId: string | undefined
        let lockForUpdate = false
        const b = {
          selectAll: () => b,
          select: () => b,
          where: (_col?: unknown, _op?: unknown, val?: unknown) => {
            if (_col === 'id' && _op === '=') whereId = val as string
            return b
          },
          forUpdate: () => {
            lockForUpdate = true
            return b
          },
          execute: async () => {
            if (whereId != null) {
              ops.push(`${lockForUpdate ? 'for-update' : 'select'}:${table}:${whereId}@${tag}`)
              const row = view.get(whereId)
              return row ? [{ id: whereId }] : []
            }
            // mirrors loadFromDatabase's filter
            return [...view.values()].filter((r) => r.is_active === true && r.deleted_at == null)
          },
        }
        return b
      },
      insertInto: (table: string) => {
        assertKnownTable('insertInto', table)
        let pending: Record<string, unknown> = {}
        let updateSet: Record<string, unknown> | undefined
        const b = {
          values: (v: Record<string, unknown>) => {
            pending = v
            return b
          },
          onConflict: (cb: (oc: unknown) => unknown) => {
            const oc = {
              column: () => ({
                doUpdateSet: (s: Record<string, unknown>) => {
                  updateSet = s
                  return oc
                },
              }),
            }
            cb(oc)
            return b
          },
          execute: async () => {
            const id = pending.id as string
            if (view.has(id) && updateSet) view.set(id, { ...view.get(id), ...updateSet })
            else view.set(id, { ...pending })
            return []
          },
        }
        return b
      },
      updateTable: (table: string) => {
        assertKnownTable('updateTable', table)
        let setObj: Record<string, unknown> = {}
        let whereId: string | undefined
        const b = {
          set: (s: Record<string, unknown>) => {
            setObj = s
            return b
          },
          where: (_col: unknown, _op: unknown, val: unknown) => {
            whereId = val as string
            return b
          },
          execute: async () => {
            // updateStatus() also lands here; only the soft delete carries deleted_at.
            const isDelete = Object.prototype.hasOwnProperty.call(setObj, 'deleted_at')
            if (isDelete) {
              writes.push('soft-delete:' + String(whereId))
              ops.push(`soft-delete:${table}:${String(whereId)}@${tag}`)
              control.onDataSourceWrite?.()
              if (control.failDataSourceWrite === 'fk') throw fkViolation()
              if (control.failDataSourceWrite) throw Object.assign(new Error(DRIVER_POISON), { code: '08006' })
            }
            if (whereId != null && view.has(whereId)) view.set(whereId, { ...view.get(whereId), ...setObj })
            return []
          },
        }
        return b
      },
      deleteFrom: (table: string) => {
        assertKnownTable('deleteFrom', table)
        let whereId: string | undefined
        const b = {
          where: (_col: unknown, _op: unknown, val: unknown) => {
            whereId = val as string
            return b
          },
          execute: async () => {
            writes.push('hard-delete:' + String(whereId))
            ops.push(`hard-delete:${table}:${String(whereId)}@${tag}`)
            control.onDataSourceWrite?.()
            if (control.failDataSourceWrite === 'fk') throw fkViolation()
            if (control.failDataSourceWrite) throw Object.assign(new Error(DRIVER_POISON), { code: '08006' })
            if (whereId != null) view.delete(whereId)
            return []
          },
        }
        return b
      },
    }
  }

  const db = {
    ...makeExecutor('db', rows),
    transaction: () => ({
      execute: async <T>(cb: (trx: unknown) => Promise<T>): Promise<T> => {
        const record: TransactionRecord = { committed: false, error: undefined }
        transactions.push(record)
        const staged = new Map(rows)
        try {
          const result = await cb(makeExecutor('trx', staged))
          // COMMIT: fold the staged view back into the live rows.
          rows.clear()
          for (const [k, v] of staged) rows.set(k, v)
          record.committed = true
          return result
        } catch (err) {
          // ROLLBACK: the staged view is dropped; `rows` was never touched.
          record.error = err
          throw err
        }
      },
    }),
  }

  return { db, rows, refs, control, writes, ops, transactions }
}

function pgConfig(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'x' },
    options: { autoConnect: false },
  }
}

/** The row is ALIVE: not soft-deleted. A freshly inserted row carries no deleted_at key at all. */
function expectRowAlive(harness: Harness, id: string): void {
  const row = harness.rows.get(id)
  expect(row).toMatchObject({ is_active: true })
  expect(row?.deleted_at ?? null).toBeNull()
}

/** Public-API probe for "is this id still registered in memory". */
function inMemory(m: DataSourceManager, id: string): boolean {
  try {
    m.getDataSource(id)
    return true
  } catch {
    return false
  }
}

/** connectionPool is private; the ordering contract is about it, so the test reads it directly. */
function poolHas(m: DataSourceManager, id: string): boolean {
  return (m as unknown as { connectionPool: Map<string, Promise<void>> }).connectionPool.has(id)
}

function seedPool(m: DataSourceManager, id: string): void {
  // Never settles, so there is no unhandled rejection; it only has to be PRESENT.
  const pool = (m as unknown as { connectionPool: Map<string, Promise<void>> }).connectionPool
  pool.set(id, new Promise<void>(() => {}))
}

async function managerWith(id: string, harness: Harness) {
  const m = new DataSourceManager({ db: harness.db as never })
  await m.addDataSource(pgConfig(id), { ownerId: 'alice' })
  seedPool(m, id)
  const adapter = m.getDataSource(id)
  return { m, adapter }
}

describe('removeDataSource — durable write precedes the memory clear (PERM-04)', () => {
  it('DB write FAILS => coded values-free refusal; adapter, connectionPool and scope are untouched', async () => {
    const harness = makeHarness()
    const { m, adapter } = await managerWith('ds-fail', harness)
    const disconnect = vi.spyOn(adapter, 'disconnect').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    harness.control.failDataSourceWrite = true

    const error = await m.removeDataSource('ds-fail').then(
      () => null,
      (e: unknown) => e as { code?: string; status?: number; message?: string },
    )

    expect(error).not.toBeNull()
    expect(error?.code).toBe(DATA_SOURCE_DELETE_NOT_PERSISTED_CODE)
    expect(error?.status).toBe(500)
    // values-free: the driver's own text stays in the log.
    expect(String(error?.message)).not.toContain(DRIVER_POISON)
    expect(String(error?.message)).not.toContain('10.10.52.16')

    // not one byte of in-memory state moved
    expect(inMemory(m, 'ds-fail')).toBe(true)
    expect(poolHas(m, 'ds-fail')).toBe(true)
    expect(m.getScope('ds-fail')).toMatchObject({ ownerId: 'alice' })
    // and the connection was NOT released for a delete that did not happen
    expect(disconnect).not.toHaveBeenCalled()
    // the row is still alive, so a restart finds exactly the source memory still has
    expectRowAlive(harness, 'ds-fail')
    // W7-B: the failure happened INSIDE the one transaction, which rolled back.
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0]?.committed).toBe(false)
    expect(harness.ops).toEqual([
      'for-update:data_sources:ds-fail@trx',
      'count:canonical:ds-fail@trx',
      'count:legacy:ds-fail@trx',
      'soft-delete:data_sources:ds-fail@trx',
    ])
  })

  it('a failed delete leaves NO ghost: the restarted manager and the live one agree', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-ghost', harness)
    harness.control.failDataSourceWrite = true
    await expect(m.removeDataSource('ds-ghost')).rejects.toMatchObject({
      code: DATA_SOURCE_DELETE_NOT_PERSISTED_CODE,
    })

    const restarted = new DataSourceManager()
    await restarted.initialize(harness.db as never)
    // Before the fix: memory said gone, the row said alive => the source came back HERE
    // while the live manager had already forgotten it. Now both say alive.
    expect(inMemory(m, 'ds-ghost')).toBe(true)
    expect(inMemory(restarted, 'ds-ghost')).toBe(true)
  })

  it('DB write SUCCEEDS => memory is still intact AT WRITE TIME, cleared after, disconnect last', async () => {
    const harness = makeHarness()
    const { m, adapter } = await managerWith('ds-ok', harness)
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)

    let atWriteTime: { inMemory: boolean; pool: boolean; scope: boolean } | null = null
    harness.control.onDataSourceWrite = () => {
      atWriteTime = {
        inMemory: inMemory(m, 'ds-ok'),
        pool: poolHas(m, 'ds-ok'),
        scope: m.getScope('ds-ok') !== undefined,
      }
    }
    let atDisconnectTime: { inMemory: boolean; rowDeleted: boolean } | null = null
    const disconnect = vi.spyOn(adapter, 'disconnect').mockImplementation(async () => {
      atDisconnectTime = {
        inMemory: inMemory(m, 'ds-ok'),
        rowDeleted: harness.rows.get('ds-ok')?.deleted_at != null,
      }
    })

    await m.removeDataSource('ds-ok')

    // (2) the durable write ran while memory was still whole — the ordering assertion
    expect(atWriteTime).toEqual({ inMemory: true, pool: true, scope: true })
    // (3) memory cleared only afterwards
    expect(inMemory(m, 'ds-ok')).toBe(false)
    expect(poolHas(m, 'ds-ok')).toBe(false)
    expect(m.getScope('ds-ok')).toBeUndefined()
    expect(harness.rows.get('ds-ok')).toMatchObject({ is_active: false })
    expect(harness.rows.get('ds-ok')?.deleted_at).toBeInstanceOf(Date)
    // (4) release happened LAST: by then the row was deleted and memory was clear
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(atDisconnectTime).toEqual({ inMemory: false, rowDeleted: true })
    // (W7-B) and the whole durable step was ONE committed transaction, in lock order
    expect(harness.transactions).toEqual([{ committed: true, error: undefined }])
    expect(harness.ops).toEqual([
      'for-update:data_sources:ds-ok@trx',
      'count:canonical:ds-ok@trx',
      'count:legacy:ds-ok@trx',
      'soft-delete:data_sources:ds-ok@trx',
    ])

    // restart: the soft-deleted row is not re-observed
    const restarted = new DataSourceManager()
    await restarted.initialize(harness.db as never)
    expect(inMemory(restarted, 'ds-ok')).toBe(false)
  })

  it('disconnect FAILS after a committed delete => still resolves; the delete is not rolled back', async () => {
    const harness = makeHarness()
    const { m, adapter } = await managerWith('ds-disc', harness)
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    vi.spyOn(adapter, 'disconnect').mockRejectedValue(new Error(DRIVER_POISON))

    await expect(m.removeDataSource('ds-disc')).resolves.toBeUndefined()
    expect(inMemory(m, 'ds-disc')).toBe(false)
    expect(harness.rows.get('ds-disc')).toMatchObject({ is_active: false })
  })

  it('hardDelete keeps the same ordering: the row is gone before memory is cleared', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-hard', harness)
    let memoryAtWrite: boolean | null = null
    harness.control.onDataSourceWrite = () => {
      memoryAtWrite = inMemory(m, 'ds-hard')
    }
    await m.removeDataSource('ds-hard', { hardDelete: true })
    expect(memoryAtWrite).toBe(true)
    expect(harness.rows.has('ds-hard')).toBe(false)
    expect(inMemory(m, 'ds-hard')).toBe(false)
    // (W7-B) hard delete rides the same transaction and the same lock order
    expect(harness.ops).toEqual([
      'for-update:data_sources:ds-hard@trx',
      'count:canonical:ds-hard@trx',
      'count:legacy:ds-hard@trx',
      'hard-delete:data_sources:ds-hard@trx',
    ])
    expect(harness.transactions.map((t) => t.committed)).toEqual([true])
  })
})

describe('removeDataSource — the referential check runs before ANY mutation', () => {
  it('referenced and NOT forced => coded 409, no db write, memory unchanged', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-ref', harness)
    harness.refs.push({ connectionId: 'ds-ref' }, { connectionId: 'ds-ref' })

    const error = await m.removeDataSource('ds-ref').then(
      () => null,
      (e: unknown) => e as { code?: string; status?: number; details?: { referenceCount?: number } },
    )
    expect(error?.code).toBe(DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE)
    expect(error?.status).toBe(409)
    expect(error?.details).toEqual({ referenceCount: 2 })

    expect(harness.writes).toEqual([])
    expect(inMemory(m, 'ds-ref')).toBe(true)
    expect(poolHas(m, 'ds-ref')).toBe(true)
    expect(m.getScope('ds-ref')).toMatchObject({ ownerId: 'alice' })
    expectRowAlive(harness, 'ds-ref')
    // (W7-B) the refusal was decided INSIDE the transaction, after the lock and
    // before any write; the transaction rolled back carrying the 409 itself.
    expect(harness.ops).toEqual(['for-update:data_sources:ds-ref@trx', 'count:canonical:ds-ref@trx', 'count:legacy:ds-ref@trx'])
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0]?.committed).toBe(false)
    expect((harness.transactions[0]?.error as { code?: string })?.code).toBe(DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE)
  })

  it('the legacy pointer counts only with the owner stamp (the existing P2-A attribution)', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-legacy', harness)
    harness.refs.push({ connectionId: null, dataSourceId: 'ds-legacy', ownerId: 'u_other_tenant' })
    // a stranger's unattributable pin must not block the owner's delete
    await expect(m.removeDataSource('ds-legacy')).resolves.toBeUndefined()

    const harness2 = makeHarness()
    const { m: m2 } = await managerWith('ds-legacy2', harness2)
    harness2.refs.push({ connectionId: null, dataSourceId: 'ds-legacy2', ownerId: 'alice' })
    await expect(m2.removeDataSource('ds-legacy2')).rejects.toMatchObject({
      code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
      details: { referenceCount: 1 },
    })
    expect(harness2.writes).toEqual([])
  })

  it('force is RETIRED (owner ruling ①): `{ force: true }` changes nothing — same 409, no write, memory unchanged', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-forced', harness)
    harness.refs.push({ connectionId: 'ds-forced' })

    // The option no longer exists on the signature; an old caller that still sends it is
    // exercised through a loose cast so the test proves the RUNTIME ignores it.
    const legacyOptions = { force: true } as unknown as { hardDelete?: boolean }
    await expect(m.removeDataSource('ds-forced', legacyOptions)).rejects.toMatchObject({
      status: 409,
      code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
      details: { referenceCount: 1 },
    })
    expect(harness.writes).toEqual([])
    expect(inMemory(m, 'ds-forced')).toBe(true)
    expectRowAlive(harness, 'ds-forced')
    // The count RAN (force used to skip exactly this step), inside the transaction, after the lock.
    expect(harness.ops).toEqual(['for-update:data_sources:ds-forced@trx', 'count:canonical:ds-forced@trx', 'count:legacy:ds-forced@trx'])
    expect(harness.transactions.map((t) => t.committed)).toEqual([false])
  })

  it('the 409 copy tells the operator to UNBIND first and no longer advertises force', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-copy', harness)
    harness.refs.push({ connectionId: 'ds-copy' }, { connectionId: 'ds-copy' }, { connectionId: 'ds-copy' })
    const error = await m.removeDataSource('ds-copy').then(() => null, (e: unknown) => e as Error)
    expect(error?.message).toContain('请先解绑 3 个外部系统')
    expect(error?.message).toContain('unbind them first')
    expect(error?.message).not.toMatch(/repeat the request with force=true/)
  })

  it('DATABASE BACKSTOP (PR-B): the soft delete refused by the live-connection FK (23503) => the SAME 409, rolled back, memory unchanged', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-fk', harness)
    // The count saw nothing (no rows in `refs`) — this is the case the count cannot catch and
    // only the database can: the UPDATE of data_sources trips the FK re-pointed at live_id.
    harness.control.failDataSourceWrite = 'fk'

    const error = await m.removeDataSource('ds-fk').then(
      () => null,
      (e: unknown) => e as { code?: string; status?: number; message?: string; details?: unknown },
    )
    expect(error?.status).toBe(409)
    expect(error?.code).toBe(DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE)
    // the count is unknown on this path (the transaction is already aborted) — say so, honestly
    expect(error?.details).toEqual({ referenceCount: null })
    expect(error?.message).toContain('请先解绑')
    // the driver's prose (with its db name) never reaches the caller
    expect(error?.message).not.toContain('plm_prod')
    expect(error?.message).not.toContain('外键约束')

    // the UPDATE was issued (this is the database refusing, not the count) and then rolled back
    expect(harness.ops).toEqual(['for-update:data_sources:ds-fk@trx', 'count:canonical:ds-fk@trx', 'count:legacy:ds-fk@trx', 'soft-delete:data_sources:ds-fk@trx'])
    expect(harness.transactions.map((t) => t.committed)).toEqual([false])
    expectRowAlive(harness, 'ds-fk')
    expect(inMemory(m, 'ds-fk')).toBe(true)
    expect(poolHas(m, 'ds-fk')).toBe(true)
    expect(m.getScope('ds-fk')).toMatchObject({ ownerId: 'alice' })
  })

  it('a 23503 from some OTHER constraint is still a persistence failure (values-free 500), not a referential 409', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-fk-other', harness)
    harness.control.onDataSourceWrite = () => {
      throw Object.assign(new Error(DRIVER_POISON), { code: '23503', constraint: 'fk_some_other_table_source_id' })
    }
    await expect(m.removeDataSource('ds-fk-other')).rejects.toMatchObject({
      status: 500,
      code: DATA_SOURCE_DELETE_NOT_PERSISTED_CODE,
    })
    expectRowAlive(harness, 'ds-fk-other')
    expect(inMemory(m, 'ds-fk-other')).toBe(true)
  })

  it('a non-42P01 reference-count failure fails CLOSED: no write, no memory change', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-refboom', harness)
    harness.control.failRefCount = 'other'
    const error = await m.removeDataSource('ds-refboom').then(
      () => null,
      (e: unknown) => e as { code?: string; status?: number; message?: string },
    )
    expect(error).not.toBeNull()
    expect(harness.writes).toEqual([])
    expect(inMemory(m, 'ds-refboom')).toBe(true)
    expectRowAlive(harness, 'ds-refboom')
    // (W7-B) the count now fails INSIDE the transaction, so it surfaces through the
    // same values-free translation as a write failure — never as the driver's text.
    expect(error?.code).toBe(DATA_SOURCE_DELETE_NOT_PERSISTED_CODE)
    expect(error?.status).toBe(500)
    expect(String(error?.message)).not.toContain(DRIVER_POISON)
    expect(harness.transactions.map((t) => t.committed)).toEqual([false])
    expect(harness.ops).toEqual(['for-update:data_sources:ds-refboom@trx'])
  })
})

// ── W7-B: check and write share ONE transaction, opened by FOR UPDATE ──────────

describe('removeDataSource — W7-B: referential check and soft delete in ONE transaction under FOR UPDATE', () => {
  it('① referenced => 409 raised INSIDE the transaction: no UPDATE issued, transaction rolled back, row byte-identical', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-tx-ref', harness)
    const rowBefore = { ...harness.rows.get('ds-tx-ref') }
    harness.refs.push({ connectionId: 'ds-tx-ref' })

    await expect(m.removeDataSource('ds-tx-ref')).rejects.toMatchObject({
      status: 409,
      code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
      details: { referenceCount: 1 },
    })

    // no write statement was ever ISSUED, not merely rolled back
    expect(harness.ops.filter((op) => op.startsWith('soft-delete') || op.startsWith('hard-delete'))).toEqual([])
    expect(harness.writes).toEqual([])
    // exactly one transaction, and it did NOT commit
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0]?.committed).toBe(false)
    // the live row is untouched by the rolled-back staged view
    expect(harness.rows.get('ds-tx-ref')).toEqual(rowBefore)
    expect(inMemory(m, 'ds-tx-ref')).toBe(true)
  })

  it('② the count runs on the SAME transaction that holds the lock — never on this.db', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-tx-same', harness)
    await m.removeDataSource('ds-tx-same')

    const counts = harness.ops.filter((op) => op.startsWith('count:'))
    expect(counts).toHaveLength(2)
    for (const op of counts) expect(op.endsWith('@trx')).toBe(true)
    // and NOTHING of the delete ran outside the transaction
    expect(harness.ops.some((op) => op.endsWith('@db'))).toBe(false)
    // the lock is the FIRST statement, ahead of the first count
    expect(harness.ops.indexOf('for-update:data_sources:ds-tx-same@trx')).toBe(0)
    expect(harness.ops.indexOf('for-update:data_sources:ds-tx-same@trx')).toBeLessThan(harness.ops.indexOf(counts[0]!))
  })

  it('②-sensitivity: a count that IGNORES the executor is visible as @db — the assertion above is not vacuous', async () => {
    // In-memory mutation at the call boundary: equivalent to `executor ?? this.db` → `this.db`.
    const proto = DataSourceManager.prototype
    const original = proto.countExternalSystemReferences
    proto.countExternalSystemReferences = function (this: DataSourceManager, id: string) {
      return original.call(this, id) // executor dropped on the floor
    }
    try {
      const harness = makeHarness()
      const { m } = await managerWith('ds-tx-mut', harness)
      await m.removeDataSource('ds-tx-mut')
      const counts = harness.ops.filter((op) => op.startsWith('count:'))
      expect(counts).toHaveLength(2)
      // the mutated build counts on the autocommit connection: the fake SEES it
      for (const op of counts) expect(op.endsWith('@db')).toBe(true)
      expect(harness.ops.some((op) => op.endsWith('@db'))).toBe(true)
    } finally {
      proto.countExternalSystemReferences = original
    }
  })

  it('④ the lock is taken on data_sources — the ops log names the table, and the fake refuses any other', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-tx-table', harness)
    await m.removeDataSource('ds-tx-table')
    // the lock entry carries the table name; a lock on any other table would not produce it
    expect(harness.ops[0]).toBe('for-update:data_sources:ds-tx-table@trx')
    expect(harness.ops.filter((op) => op.startsWith('for-update:'))).toEqual(['for-update:data_sources:ds-tx-table@trx'])
    expect(harness.ops.at(-1)).toBe('soft-delete:data_sources:ds-tx-table@trx')
  })

  it('④-sensitivity: the fake is table-strict — a FOR UPDATE / UPDATE / DELETE aimed at another real table is a thrown harness error', async () => {
    // Self-check of the lever ④ turns on: if this ever passes for a foreign table, ④ is vacuous.
    const harness = makeHarness()
    const db = harness.db as {
      selectFrom: (t: string) => unknown
      updateTable: (t: string) => unknown
      deleteFrom: (t: string) => unknown
      insertInto: (t: string) => unknown
    }
    for (const foreign of ['integration_runs', 'data_source', 'DATA_SOURCES', '']) {
      expect(() => db.selectFrom(foreign)).toThrow(/models only data_sources/)
      expect(() => db.updateTable(foreign)).toThrow(/models only data_sources/)
      expect(() => db.deleteFrom(foreign)).toThrow(/models only data_sources/)
      expect(() => db.insertInto(foreign)).toThrow(/models only data_sources/)
    }
    // and the two tables removeDataSource legitimately touches are answered
    expect(() => db.selectFrom('data_sources')).not.toThrow()
    expect(() => db.selectFrom('integration_external_systems')).not.toThrow()
    expect(harness.ops).toEqual([])
  })

  it('③ memory-only manager (no db): the bypass keeps the referential contract without a transaction', async () => {
    // (a) nothing persisted => nothing referenced => removal resolves and memory is cleared
    const plain = new DataSourceManager()
    await plain.addDataSource(pgConfig('mem-free'), { ownerId: 'alice' })
    await expect(plain.removeDataSource('mem-free')).resolves.toBeUndefined()
    expect(inMemory(plain, 'mem-free')).toBe(false)

    // (b) the count is still CONSULTED on the bypass: a non-zero answer refuses with the same 409
    const m = new DataSourceManager()
    await m.addDataSource(pgConfig('mem-ref'), { ownerId: 'alice' })
    const count = vi.spyOn(m, 'countExternalSystemReferences').mockResolvedValue(3)
    await expect(m.removeDataSource('mem-ref')).rejects.toMatchObject({
      status: 409,
      code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
      details: { referenceCount: 3 },
    })
    // called WITHOUT an executor: there is no transaction to hand over
    expect(count).toHaveBeenCalledTimes(1)
    expect(count.mock.calls[0]).toEqual(['mem-ref'])
    expect(inMemory(m, 'mem-ref')).toBe(true)
    expect(m.getScope('mem-ref')).toMatchObject({ ownerId: 'alice' })

    // (c) force is retired on the memory-only path too: the count still runs and still refuses
    const legacyOptions = { force: true } as unknown as { hardDelete?: boolean }
    await expect(m.removeDataSource('mem-ref', legacyOptions)).rejects.toMatchObject({
      status: 409,
      code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
      details: { referenceCount: 3 },
    })
    expect(count).toHaveBeenCalledTimes(2)
    expect(inMemory(m, 'mem-ref')).toBe(true)
  })

  it('a write failure INSIDE the transaction rolls back the staged row and surfaces the values-free 500', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-tx-boom', harness)
    const rowBefore = { ...harness.rows.get('ds-tx-boom') }
    harness.control.failDataSourceWrite = true
    await expect(m.removeDataSource('ds-tx-boom')).rejects.toMatchObject({
      status: 500,
      code: DATA_SOURCE_DELETE_NOT_PERSISTED_CODE,
    })
    // the UPDATE was issued (so this is a write failure, not a refusal) and then rolled back
    expect(harness.writes).toEqual(['soft-delete:ds-tx-boom'])
    expect(harness.transactions.map((t) => t.committed)).toEqual([false])
    expect(harness.rows.get('ds-tx-boom')).toEqual(rowBefore)
  })
})

// ── route contract: a failed delete must not look like a success ───────────────

const OWNER = {
  id: 'u_owner_rm',
  tenantId: 'tenant-rm',
  roles: ['member'],
  permissions: ['data_sources:read', 'data_sources:write'],
}
let currentUser: Record<string, unknown> | undefined
const routeHarness = makeHarness()
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = currentUser as never
  req.authenticatedTenantId = currentUser ? 'tenant-rm' : undefined
  next()
})
app.use(dataSourcesRouter())
const pinned = usePinnedServer()

function as(user: Record<string, unknown> | undefined) {
  currentUser = user
  pinned.setApp(app)
  return request(pinned.url())
}

beforeAll(async () => {
  await initializeDataSourceManager(routeHarness.db as never)
})

describe('DELETE /api/data-sources/:id — a failed delete is reported as a failure', () => {
  it('db write fails => non-200 coded refusal, values-free, and the source still answers', async () => {
    const ID = 'ds-route-fail'
    expect((await as(OWNER).post('/api/data-sources').send(pgConfig(ID))).status).toBe(201)

    routeHarness.control.failDataSourceWrite = true
    const res = await as(OWNER).delete('/api/data-sources/' + ID)
    routeHarness.control.failDataSourceWrite = false

    expect(res.status).not.toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.code).toBe(DATA_SOURCE_DELETE_NOT_PERSISTED_CODE)
    expect(JSON.stringify(res.body)).not.toContain('10.10.52.16')
    expect(JSON.stringify(res.body)).not.toContain('Login failed')

    // the source is still there — the client's retry has something to retry
    expect((await as(OWNER).get('/api/data-sources/' + ID)).status).toBe(200)
    expectRowAlive(routeHarness, ID)
  })

  it('the unreferenced happy path is unchanged: 200 removed, row soft-deleted, 404 afterwards', async () => {
    const ID = 'ds-route-ok'
    expect((await as(OWNER).post('/api/data-sources').send(pgConfig(ID))).status).toBe(201)

    const opsBefore = routeHarness.ops.length
    const res = await as(OWNER).delete('/api/data-sources/' + ID)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: ID, removed: true })
    expect(routeHarness.rows.get(ID)).toMatchObject({ is_active: false })
    expect((await as(OWNER).get('/api/data-sources/' + ID)).status).toBe(404)
    // (W7-B) through the real route: the route's own ADVISORY pre-count (routes/data-sources.ts
    // DELETE, used to shape the 409 message with its count) still runs on the autocommit
    // connection, and is NOT what gates the delete — the manager re-counts INSIDE the
    // transaction, after the lock. Both are visible, in this order.
    expect(routeHarness.ops.slice(opsBefore)).toEqual([
      `count:canonical:${ID}@db`,
      `count:legacy:${ID}@db`,
      `for-update:data_sources:${ID}@trx`,
      `count:canonical:${ID}@trx`,
      `count:legacy:${ID}@trx`,
      `soft-delete:data_sources:${ID}@trx`,
    ])
  })

  it('referenced => the existing 409 contract, and nothing was written or cleared', async () => {
    const ID = 'ds-route-ref'
    expect((await as(OWNER).post('/api/data-sources').send(pgConfig(ID))).status).toBe(201)
    routeHarness.refs.push({ connectionId: ID })

    const res = await as(OWNER).delete('/api/data-sources/' + ID)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE)
    expect(res.body.error.details).toEqual({ referenceCount: 1 })
    expectRowAlive(routeHarness, ID)
    expect((await as(OWNER).get('/api/data-sources/' + ID)).status).toBe(200)
  })
})
