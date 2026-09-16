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
  DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
  DataSourceManager,
} from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter, initializeDataSourceManager } from '../../src/routes/data-sources'
import { usePinnedServer } from '../utils/pinned-server'

// A driver failure's own text is what must NEVER reach the client (it embeds host,
// port, database and login). The fake db throws exactly this shape.
const DRIVER_POISON = 'Login failed for user "svc_plm" at 10.10.52.16:5432 (db=plm_prod)'

interface RefRow {
  connectionId?: string | null
  dataSourceId?: string
  ownerId?: string
}

interface Harness {
  db: unknown
  rows: Map<string, Record<string, unknown>>
  refs: RefRow[]
  control: {
    failDataSourceWrite: boolean
    failRefCount: false | 'undefined_table' | 'other'
    /** Observer invoked at the moment the data_sources delete write executes. */
    onDataSourceWrite: (() => void) | null
  }
  writes: string[]
}

/**
 * Kysely stand-in covering the two tables removeDataSource touches:
 * `data_sources` (stateful rows, so a restart can be simulated by loading them into a
 * second manager) and `integration_external_systems` (the reference count's two
 * non-overlapping COUNT queries: canonical connection_id, then connection_id IS NULL
 * + legacy pointer + owner stamp).
 */
function makeHarness(): Harness {
  const rows = new Map<string, Record<string, unknown>>()
  const refs: RefRow[] = []
  const writes: string[] = []
  const control: Harness['control'] = {
    failDataSourceWrite: false,
    failRefCount: false,
    onDataSourceWrite: null,
  }

  function refCountBuilder() {
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
          return [{ count: refs.filter((r) => r.connectionId === id).length }]
        }
        const id = String(captured[1]?.[2] ?? '')
        const owner = String(captured[2]?.[2] ?? '')
        return [
          {
            count: refs.filter((r) => r.connectionId == null && r.dataSourceId === id && r.ownerId === owner).length,
          },
        ]
      },
    }
    return b
  }

  const db = {
    selectFrom: (table: string) => {
      if (table === 'integration_external_systems') return refCountBuilder()
      const b = {
        selectAll: () => b,
        where: () => b,
        // mirrors loadFromDatabase's filter
        execute: async () => [...rows.values()].filter((r) => r.is_active === true && r.deleted_at == null),
      }
      return b
    },
    insertInto: () => {
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
          if (rows.has(id) && updateSet) rows.set(id, { ...rows.get(id), ...updateSet })
          else rows.set(id, { ...pending })
          return []
        },
      }
      return b
    },
    updateTable: (_table: string) => {
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
            control.onDataSourceWrite?.()
            if (control.failDataSourceWrite) throw Object.assign(new Error(DRIVER_POISON), { code: '08006' })
          }
          if (whereId != null && rows.has(whereId)) rows.set(whereId, { ...rows.get(whereId), ...setObj })
          return []
        },
      }
      return b
    },
    deleteFrom: (_table: string) => {
      let whereId: string | undefined
      const b = {
        where: (_col: unknown, _op: unknown, val: unknown) => {
          whereId = val as string
          return b
        },
        execute: async () => {
          writes.push('hard-delete:' + String(whereId))
          control.onDataSourceWrite?.()
          if (control.failDataSourceWrite) throw Object.assign(new Error(DRIVER_POISON), { code: '08006' })
          if (whereId != null) rows.delete(whereId)
          return []
        },
      }
      return b
    },
  }

  return { db, rows, refs, control, writes }
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

  it('force=true (the route-authorized break) skips the check and reaches the db write', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-forced', harness)
    harness.refs.push({ connectionId: 'ds-forced' })

    await expect(m.removeDataSource('ds-forced', { force: true })).resolves.toBeUndefined()
    expect(harness.writes).toEqual(['soft-delete:ds-forced'])
    expect(inMemory(m, 'ds-forced')).toBe(false)
    expect(harness.rows.get('ds-forced')).toMatchObject({ is_active: false })
  })

  it('a non-42P01 reference-count failure fails CLOSED: no write, no memory change', async () => {
    const harness = makeHarness()
    const { m } = await managerWith('ds-refboom', harness)
    harness.control.failRefCount = 'other'
    await expect(m.removeDataSource('ds-refboom')).rejects.toThrow()
    expect(harness.writes).toEqual([])
    expect(inMemory(m, 'ds-refboom')).toBe(true)
    expectRowAlive(harness, 'ds-refboom')
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

    const res = await as(OWNER).delete('/api/data-sources/' + ID)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: ID, removed: true })
    expect(routeHarness.rows.get(ID)).toMatchObject({ is_active: false })
    expect((await as(OWNER).get('/api/data-sources/' + ID)).status).toBe(404)
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
