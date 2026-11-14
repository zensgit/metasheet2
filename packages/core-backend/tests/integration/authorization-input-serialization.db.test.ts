/**
 * Authorization-input contract entry points against real PostgreSQL, driven by test stand-in
 * callers (no production caller exists yet).
 *
 * Pinned here: the world lock's compatibility matrix (shared/shared, shared then exclusive try,
 * exclusive then shared wait, exclusive/exclusive, and the lock timeout), the READ COMMITTED pin of
 * a self-built transaction on a pool whose default isolation is REPEATABLE READ and the takeover
 * entry's refusal under that default, token rejection before any statement, restoration of the
 * caller's timeouts after the lock statements, a terminated backend during the borrow reported as
 * busy with no unhandled error and no reuse of the dead connection, the absence of a convoy
 * behind a maintenance request, and the role-row-first order: a role delete (role row for update,
 * then the admission lock of a member) and a membership write on the same role and member (role row
 * in share mode, admission lock, user row) serialize on the role row in either arrival order with
 * no deadlock. Every scenario orders its sessions by `pg_stat_activity` and `pg_locks`, never by
 * sleeping.
 */
import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertAuthorizationInputTx } from '../../src/rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_STATEMENTS,
  AUTHORIZATION_INPUT_WORLD_LOCK_KEY1,
  AUTHORIZATION_INPUT_WORLD_LOCK_KEY2,
  AuthorizationInputBusyError,
  enterAuthorizationInputTransaction,
  withAuthorizationInputTransaction,
} from '../../src/rbac/authorization-input-lock'
import type { AuthorizationInputEntryOptions, AuthorizationInputHandlerClient, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { ConnectionPool } from '../../src/integration/db/connection-pool'

const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (authorization-input serialization)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const DATABASE_URL = process.env.DATABASE_URL ?? ''

function withDefaultIsolation(url: string, isolation: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}options=${encodeURIComponent(`-c default_transaction_isolation=${isolation.replace(' ', '\\ ')}`)}`
}

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected rejection')
}

describeIfDatabase('authorization-input serialization (real PostgreSQL)', () => {
  let observer: PgPool
  let service: ConnectionPool
  let repeatableRead: ConnectionPool
  const createdUserIds: string[] = []
  const createdRoleIds: string[] = []

  const runnerOf = (pool: ConnectionPool): AuthorizationInputEntryOptions['transaction'] =>
    <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>) =>
      pool.transaction((client) => handler({ query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient }))

  const pidOf = async (tx: AuthorizationInputTx): Promise<number> => Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)

  async function waitUntilBlockedBy(waiterPid: number, blockerPid: number, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const blocked = await observer.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE pid = $1 AND state = 'active' AND wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid))`,
        [waiterPid, blockerPid],
      )
      if (Number(blocked.rows[0]?.n ?? 0) === 1) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out waiting for backend ${waiterPid} to block on ${blockerPid}`)
  }

  async function waitUntilGone(pid: number, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const alive = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])
      if (Number(alive.rows[0]?.n ?? 0) === 0) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out waiting for backend ${pid} to disappear`)
  }

  async function worldLockRows(): Promise<Array<{ pid: number; mode: string; granted: boolean }>> {
    const rows = await observer.query(
      `SELECT pid, mode, granted FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2`,
      [AUTHORIZATION_INPUT_WORLD_LOCK_KEY1, AUTHORIZATION_INPUT_WORLD_LOCK_KEY2],
    )
    return rows.rows.map((row) => ({ pid: Number(row.pid), mode: String(row.mode), granted: row.granted === true }))
  }

  /** Runs `work` while waiting until the holder has acquired its lock; resolves holders by observing `pg_locks`. */
  async function waitUntilHolds(pid: number, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await worldLockRows()).some((row) => row.pid === pid && row.granted)) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out waiting for backend ${pid} to hold the world lock`)
  }

  beforeAll(() => {
    observer = new PgPool({ connectionString: DATABASE_URL, max: 2 })
    service = new ConnectionPool({ connectionString: DATABASE_URL, max: 4, name: 'authz-input-serialization' })
    repeatableRead = new ConnectionPool({ connectionString: withDefaultIsolation(DATABASE_URL, 'repeatable read'), max: 2, name: 'authz-input-repeatable-read' })
  })

  afterAll(async () => {
    if (createdUserIds.length > 0) await observer.query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds])
    if (createdRoleIds.length > 0) await observer.query('DELETE FROM roles WHERE id = ANY($1::text[])', [createdRoleIds])
    service.stopMetricsCollection()
    repeatableRead.stopMetricsCollection()
    await service.getInternalPool().end()
    await repeatableRead.getInternalPool().end()
    await observer.end()
  })

  describe('world lock compatibility', () => {
    it('shared and shared do not block each other', async () => {
      const gate = deferred()
      let holderPid = 0
      const holder = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => {
        holderPid = await pidOf(tx)
        await gate.promise
        return 'held'
      }, { transaction: runnerOf(service) })
      while (holderPid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await waitUntilHolds(holderPid)
      const second = await withAuthorizationInputTransaction({ intent: 'REVOKE_ROLE' }, async (tx) => {
        const rows = await worldLockRows()
        expect(rows.filter((row) => row.granted && row.mode === 'ShareLock').length).toBeGreaterThanOrEqual(2)
        return pidOf(tx)
      }, { transaction: runnerOf(service) })
      expect(second).not.toBe(holderPid)
      gate.resolve()
      expect(await holder).toBe('held')
    })

    it('an exclusive try fails while a shared holder exists; the shared request waits behind an exclusive holder; exclusive and exclusive exclude', async () => {
      const gate = deferred()
      let holderPid = 0
      const holder = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => {
        holderPid = await pidOf(tx)
        await gate.promise
      }, { transaction: runnerOf(service) })
      while (holderPid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await waitUntilHolds(holderPid)
      const denied = await rejection(withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive' }, async () => 'never', { transaction: runnerOf(service), exclusive: { attempts: 1 } }))
      expect(denied).toBeInstanceOf(AuthorizationInputBusyError)
      expect(denied).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'exclusive_exhausted', retryable: true })
      gate.resolve()
      await holder

      const exclusiveGate = deferred()
      let exclusivePid = 0
      const exclusive = withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async (tx) => {
        exclusivePid = await pidOf(tx)
        await exclusiveGate.promise
      }, { transaction: runnerOf(service), maintenance: { attempts: 1 } })
      while (exclusivePid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await waitUntilHolds(exclusivePid)
      const secondExclusive = await rejection(withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async () => 'never', { transaction: runnerOf(service), maintenance: { attempts: 1 } }))
      expect(secondExclusive).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'exclusive_exhausted' })

      const shared = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => pidOf(tx), { transaction: runnerOf(service) })
      const waiterPid = await (async () => {
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
          const waiting = (await worldLockRows()).find((row) => !row.granted && row.pid !== exclusivePid)
          if (waiting) return waiting.pid
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('shared request never queued behind the exclusive holder')
      })()
      await waitUntilBlockedBy(waiterPid, exclusivePid)
      exclusiveGate.resolve()
      await exclusive
      expect(await shared).toBe(waiterPid)
    })

    it('a shared request behind an exclusive holder that outlives the lock timeout is busy with zero writes', async () => {
      const gate = deferred()
      let exclusivePid = 0
      const exclusive = withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async (tx) => {
        exclusivePid = await pidOf(tx)
        await gate.promise
      }, { transaction: runnerOf(service), maintenance: { attempts: 1 } })
      while (exclusivePid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await waitUntilHolds(exclusivePid)
      const userId = `ais1-${randomUUID()}`
      const error = await rejection(withAuthorizationInputTransaction({ intent: 'BIRTH' }, async (tx) => {
        await tx.insertUserForBirth({ id: userId, username: userId, name: userId, password_hash: 'synthetic-unused', role: 'user' })
        return 'written'
      }, { transaction: runnerOf(service) }))
      expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'lock_timeout' })
      gate.resolve()
      await exclusive
      const rows = await observer.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [userId])
      expect(Number(rows.rows[0]?.n)).toBe(0)
    }, 20_000)
  })

  describe('isolation pin', () => {
    it('a self-built transaction is READ COMMITTED on a pool whose default is REPEATABLE READ, and a read after waiting sees the holder\'s committed write', async () => {
      const def = await repeatableRead.query("SELECT current_setting('default_transaction_isolation') AS iso")
      expect(def.rows[0]?.iso).toBe('repeatable read')
      const userId = `ais1-${randomUUID()}`
      createdUserIds.push(userId)
      const gate = deferred()
      let exclusivePid = 0
      const exclusive = withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async (tx) => {
        exclusivePid = await pidOf(tx)
        await tx.query(
          `INSERT INTO users (id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
           VALUES ($1, $1, $1, 'synthetic-unused', true, false, 'user', '[]'::jsonb, 'activated', false)`,
          [userId],
        )
        await gate.promise
      }, { transaction: runnerOf(service), maintenance: { attempts: 1 } })
      while (exclusivePid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await waitUntilHolds(exclusivePid)
      const seen = withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', userIds: [userId] }, async (tx) => {
        const isolation = await tx.query("SELECT current_setting('transaction_isolation') AS isolation")
        expect(isolation.rows[0]?.isolation).toBe('read committed')
        expect(tx.locked.has(userId)).toBe(true)
        const row = await tx.query('SELECT id::text AS id FROM users WHERE id = $1::text', [userId])
        return row.rows.length
      }, { transaction: runnerOf(repeatableRead) })
      const waiterPid = await (async () => {
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
          const waiting = (await worldLockRows()).find((row) => !row.granted)
          if (waiting) return waiting.pid
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('consumer never queued behind the exclusive holder')
      })()
      await waitUntilBlockedBy(waiterPid, exclusivePid)
      gate.resolve()
      await exclusive
      expect(await seen).toBe(1)
    })

    it('the takeover entry refuses a REPEATABLE READ transaction and accepts one pinned to READ COMMITTED', async () => {
      const client: PoolClient = await repeatableRead.getInternalPool().connect()
      try {
        await client.query('BEGIN')
        const refused = await rejection(enterAuthorizationInputTransaction({ query: (sql, params) => client.query(sql, params) }, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async () => 1))
        expect(refused).toMatchObject({ code: 'AUTHORIZATION_INPUT_ISOLATION' })
        await client.query('ROLLBACK')
        await client.query('BEGIN')
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        const world = await enterAuthorizationInputTransaction({ query: (sql, params) => client.query(sql, params) }, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async (tx) => {
          const rows = await worldLockRows()
          const pid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
          expect(rows.some((row) => row.pid === pid && row.granted && row.mode === 'ShareLock')).toBe(true)
          return tx.world
        })
        expect(world).toBe('shared')
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    })
  })

  describe('tokens', () => {
    it('a forged object, a committed token and another connection\'s token are refused before any statement', async () => {
      let token!: AuthorizationInputTx
      let handlerClient!: AuthorizationInputHandlerClient
      const runner: AuthorizationInputEntryOptions['transaction'] = <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>) =>
        service.transaction((client) => {
          handlerClient = { query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient }
          return handler(handlerClient)
        })
      await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: [] }, async (tx) => {
        token = tx
        expect(() => assertAuthorizationInputTx(tx, { client: handlerClient, userId: 'u' })).not.toThrow()
        return 1
      }, { transaction: runner })
      expect(token.open).toBe(false)
      expect(() => assertAuthorizationInputTx(token, { client: handlerClient, userId: 'u' })).toThrow(expect.objectContaining({ reason: 'closed' }))
      expect(() => assertAuthorizationInputTx({ id: 'u' }, { client: handlerClient, userId: 'u' })).toThrow(expect.objectContaining({ reason: 'unbranded' }))
      const other = await observer.connect()
      try {
        await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => {
          expect(() => assertAuthorizationInputTx(tx, { client: other, userId: 'u' })).toThrow(expect.objectContaining({ reason: 'other_connection' }))
          return 1
        }, { transaction: runnerOf(service) })
      } finally {
        other.release()
      }
      const closed = await rejection(token.query('SELECT 1'))
      expect(closed).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'token_closed' })
    })
  })

  describe('timeout scope', () => {
    it('after the lock statements the caller\'s lock and statement timeouts are restored', async () => {
      const client = await observer.connect()
      try {
        await client.query("SET lock_timeout = '7s'")
        await client.query("SET statement_timeout = '1min'")
        const runner: AuthorizationInputEntryOptions['transaction'] = async <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>) => {
          await client.query('BEGIN')
          try {
            const result = await handler({ query: (sql, params) => client.query(sql, params), __rawClient: client })
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          }
        }
        const inside = await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', admissionUserIds: ['u'] }, async (tx) => {
          const rows = await tx.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")
          return rows.rows[0]
        }, { transaction: runner })
        expect(inside).toEqual({ lock_timeout: '7s', statement_timeout: '1min' })
        const after = await client.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")
        expect(after.rows[0]).toEqual({ lock_timeout: '7s', statement_timeout: '1min' })
      } finally {
        await client.query('RESET lock_timeout')
        await client.query('RESET statement_timeout')
        client.release()
      }
    })
  })

  describe('terminated backend during the borrow', () => {
    it('is reported as busy, raises no unhandled error, leaves no write and the next borrow is a new backend', async () => {
      const gate = deferred()
      let pid = 0
      const userId = `ais1-${randomUUID()}`
      const run = withAuthorizationInputTransaction({ intent: 'BIRTH' }, async (tx) => {
        await tx.insertUserForBirth({ id: userId, username: userId, name: userId, password_hash: 'synthetic-unused', role: 'user' })
        pid = await pidOf(tx)
        await gate.promise
        await tx.query('SELECT 1')
        return 'unreachable'
      }, { transaction: runnerOf(service) })
      while (pid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await observer.query('SELECT pg_terminate_backend($1)', [pid])
      await waitUntilGone(pid)
      gate.resolve()
      const error = await rejection(run)
      expect(error).toBeInstanceOf(AuthorizationInputBusyError)
      expect(['session_terminated', 'connection_lost']).toContain((error as AuthorizationInputBusyError).busyReason)
      const rows = await observer.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [userId])
      expect(Number(rows.rows[0]?.n)).toBe(0)
      const next = await service.query('SELECT pg_backend_pid() AS pid')
      expect(Number(next.rows[0]?.pid)).not.toBe(pid)
      const again = await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => pidOf(tx), { transaction: runnerOf(service) })
      expect(again).not.toBe(pid)
    }, 20_000)
  })

  describe('role row before admission and user locks', () => {
    /** The backend whose current statement is `sql` and which waits on a lock held by `blockerPid`. */
    async function waitForWaiterOn(sql: string, blockerPid: number, timeoutMs = 8_000): Promise<number> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const waiting = await observer.query(
          `SELECT pid FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' AND query = $1 AND $2 = ANY(pg_blocking_pids(pid))
            LIMIT 1`,
          [sql, blockerPid],
        )
        if (waiting.rows[0]?.pid) return Number(waiting.rows[0].pid)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`timed out waiting for a backend to block on ${blockerPid}`)
    }

    async function seed(): Promise<{ roleId: string; memberId: string }> {
      const roleId = `ais1-role-${randomUUID()}`
      const memberId = `ais1-${randomUUID()}`
      createdRoleIds.push(roleId)
      createdUserIds.push(memberId)
      await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
      await observer.query(
        `INSERT INTO users (id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
         VALUES ($1, $1, $1, 'synthetic-unused', true, false, 'user', '[]'::jsonb, 'activated', false)`,
        [memberId],
      )
      return { roleId, memberId }
    }

    it('delete shape first: the membership write waits on the role row holding no admission lock, the delete adds the member\'s admission lock without waiting, and both commit', async () => {
      const { roleId, memberId } = await seed()
      const gate = deferred()
      const order: string[] = []
      let deletePid = 0
      const deleteShape = withAuthorizationInputTransaction({ intent: 'DELETE_ROLE', roleIds: [roleId] }, async (tx) => {
        deletePid = await pidOf(tx)
        expect(tx.roleRows.get(roleId)).toBe('held')
        await gate.promise
        await tx.acquire({ admissionUserIds: [memberId] })
        order.push('delete')
      }, { transaction: runnerOf(service) })
      while (deletePid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      const memberShape = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', roleIds: [roleId], admissionUserIds: [memberId], userIds: [memberId] }, async (tx) => {
        expect(tx.roleRows.get(roleId)).toBe('held')
        expect(tx.locked.has(memberId)).toBe(true)
        order.push('member')
      }, { transaction: runnerOf(service) })
      const memberPid = await waitForWaiterOn(AUTHORIZATION_INPUT_STATEMENTS.roleRowShared, deletePid)
      // The waiter holds the world lock shared and nothing else that the delete shape asks for.
      const heldByMember = await observer.query(`SELECT locktype, classid, objid, objsubid FROM pg_locks WHERE pid = $1 AND granted AND locktype = 'advisory'`, [memberPid])
      expect(heldByMember.rows.map((row) => [Number(row.classid), Number(row.objid), Number(row.objsubid)])).toEqual([[AUTHORIZATION_INPUT_WORLD_LOCK_KEY1, AUTHORIZATION_INPUT_WORLD_LOCK_KEY2, 2]])
      gate.resolve()
      await expect(deleteShape).resolves.toBeUndefined()
      await expect(memberShape).resolves.toBeUndefined()
      expect(order).toEqual(['delete', 'member'])
    }, 30_000)

    it('membership shape first: the delete waits on the role row holding no admission lock, and both commit', async () => {
      const { roleId, memberId } = await seed()
      const gate = deferred()
      const order: string[] = []
      let memberPid = 0
      const memberShape = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', roleIds: [roleId], admissionUserIds: [memberId], userIds: [memberId] }, async (tx) => {
        memberPid = await pidOf(tx)
        await gate.promise
        order.push('member')
      }, { transaction: runnerOf(service) })
      while (memberPid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      const deleteShape = withAuthorizationInputTransaction({ intent: 'DELETE_ROLE', roleIds: [roleId] }, async (tx) => {
        await tx.acquire({ admissionUserIds: [memberId] })
        order.push('delete')
      }, { transaction: runnerOf(service) })
      const deletePid = await waitForWaiterOn(AUTHORIZATION_INPUT_STATEMENTS.roleRow, memberPid)
      const heldByDelete = await observer.query(`SELECT locktype, classid, objid, objsubid FROM pg_locks WHERE pid = $1 AND granted AND locktype = 'advisory'`, [deletePid])
      expect(heldByDelete.rows.map((row) => [Number(row.classid), Number(row.objid), Number(row.objsubid)])).toEqual([[AUTHORIZATION_INPUT_WORLD_LOCK_KEY1, AUTHORIZATION_INPUT_WORLD_LOCK_KEY2, 2]])
      gate.resolve()
      await expect(memberShape).resolves.toBeUndefined()
      await expect(deleteShape).resolves.toBeUndefined()
      expect(order).toEqual(['member', 'delete'])
    }, 30_000)
  })

  describe('maintenance does not form a convoy', () => {
    it('a shared request arriving while a maintenance request is retrying is granted at once, and no session queues behind the maintenance request', async () => {
      const gate = deferred()
      let holderPid = 0
      const holder = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => {
        holderPid = await pidOf(tx)
        await gate.promise
      }, { transaction: runnerOf(service) })
      while (holderPid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await waitUntilHolds(holderPid)
      const maintenance = withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async (tx) => pidOf(tx), { transaction: runnerOf(service), maintenance: { attempts: 80, baseDelayMs: 100, jitterMs: 0 } })
      const maintenancePid = await (async () => {
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
          // The maintenance session's last statement is the exclusive try; the observer itself is excluded by pid.
          const trying = await observer.query(
            `SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND pid <> pg_backend_pid() AND query = $2 AND state IN ('active', 'idle in transaction') LIMIT 1`,
            [holderPid, AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry],
          )
          if (trying.rows[0]?.pid) return Number(trying.rows[0].pid)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('maintenance request never tried the world lock')
      })()
      const second = await withAuthorizationInputTransaction({ intent: 'REVOKE_ROLE' }, async (tx) => {
        const pid = await pidOf(tx)
        const blocking = await observer.query('SELECT pg_blocking_pids($1) AS pids', [pid])
        expect(blocking.rows[0]?.pids).toEqual([])
        expect((await worldLockRows()).filter((row) => !row.granted)).toEqual([])
        return pid
      }, { transaction: runnerOf(service) })
      expect(second).not.toBe(holderPid)
      expect(second).not.toBe(maintenancePid)
      expect((await worldLockRows()).filter((row) => !row.granted)).toEqual([])
      gate.resolve()
      await holder
      expect(await maintenance).toBe(maintenancePid)
    }, 30_000)
  })
})
