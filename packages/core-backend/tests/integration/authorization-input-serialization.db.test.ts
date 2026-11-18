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
import { acquireSourceSyncFreezeLock } from '../../src/directory/source-sync-freeze-lock'
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
import { discoverPrivilegeRolePlan, revalidatePrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'
import type { PrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'

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
  const createdPlanUserIds: string[] = []
  const createdSourceIds: string[] = []

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
    if (createdSourceIds.length > 0) await observer.query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [createdSourceIds])
    if (createdPlanUserIds.length > 0) await observer.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [createdPlanUserIds])
    if (createdUserIds.length > 0) await observer.query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds])
    if (createdRoleIds.length > 0) await observer.query('DELETE FROM roles WHERE id = ANY($1::text[])', [createdRoleIds])
    service.stopMetricsCollection()
    repeatableRead.stopMetricsCollection()
    await service.getInternalPool().end()
    await repeatableRead.getInternalPool().end()
    await observer.end()
  })

  describe('identity-read central slot', () => {
    async function seedIdentityPlan() {
      const sourceIds = [randomUUID(), randomUUID()].sort()
      const userId = `ais-p2a-user-${randomUUID()}`
      const roleId = `ais-p2a-role-${randomUUID()}`
      createdSourceIds.push(...sourceIds)
      createdUserIds.push(userId)
      createdRoleIds.push(roleId)
      for (const id of sourceIds) await observer.query('INSERT INTO directory_integrations (id, org_id, name, corp_id) VALUES ($1, $2, $2, $2)', [id, `ais-p2a-${id}`])
      await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
      await observer.query("INSERT INTO users (id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set) VALUES ($1, $1, $1, 'synthetic-unused', true, false, 'user', '[]'::jsonb, 'activated', false)", [userId])
      return { sourceIds, userId, roleId, plan: { intent: 'CONSUME_CLASS_DECISION' as const, identityRead: { sourceIntegrationIds: sourceIds }, roleIds: [roleId], userIds: [userId] } }
    }

    async function takeBlocker(client: PoolClient, rank: string, fixture: Awaited<ReturnType<typeof seedIdentityPlan>>) {
      if (rank === 'R2') await client.query("SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))")
      else if (rank === 'R2F') await acquireSourceSyncFreezeLock(client, fixture.sourceIds[0])
      else if (rank === 'R2R') await client.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [fixture.roleId])
      else await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [fixture.userId])
    }

    it('allows shared R2 readers on distinct sources and rejects missing source and user before callbacks', async () => {
      const fixture = await seedIdentityPlan()
      await withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', identityRead: { sourceIntegrationIds: [fixture.sourceIds[0]] } }, async (first) => {
        await withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', identityRead: { sourceIntegrationIds: [fixture.sourceIds[1]] } }, async (second) => {
          expect(await pidOf(first)).not.toBe(await pidOf(second))
          first.requireIdentityRead([fixture.sourceIds[0]])
          second.requireIdentityRead([fixture.sourceIds[1]])
        }, { transaction: runnerOf(service) })
      }, { transaction: runnerOf(service) })
      for (const missing of ['source', 'user', 'role']) {
        let callbacks = 0
        let failedPid = 0
        const plan = { ...fixture.plan,
          ...(missing === 'source' ? { identityRead: { sourceIntegrationIds: [randomUUID()] } } : {}),
          ...(missing === 'user' ? { userIds: [`ais-p2a-absent-${randomUUID()}`] } : {}),
          ...(missing === 'role' ? { roleIds: [`ais-p2a-absent-${randomUUID()}`] } : {}),
        }
        const error = await rejection(withAuthorizationInputTransaction(plan, async () => { callbacks += 1 }, {
          transaction: <Result>(handler: (client: AuthorizationInputHandlerClient) => Promise<Result>) => service.transaction(async (client) => {
            failedPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            return handler({ query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient })
          }),
          afterAcquire: async () => { callbacks += 1 },
        }))
        expect(error).toMatchObject({ reason: `${missing}_row_not_held` })
        expect(callbacks).toBe(0)
        const state = await observer.query('SELECT xact_start FROM pg_stat_activity WHERE pid = $1', [failedPid])
        expect(state.rows).toEqual([{ xact_start: null }])
      }
    })

    it.each(['R2', 'R2F', 'R2R', 'R5'])('waits on real %s blocker then releases or rolls back on timeout', async (rank) => {
      const fixture = await seedIdentityPlan()
      for (const timeout of [false, true]) {
        const blocker = await observer.connect()
        const ready = deferred()
        let waiterPid = 0
        let callbacks = 0
        let pending: Promise<unknown> | undefined
        try {
          await blocker.query('BEGIN')
          await takeBlocker(blocker, rank, fixture)
          const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          pending = withAuthorizationInputTransaction({ ...fixture.plan, identityRead: { sourceIntegrationIds: [...fixture.sourceIds].reverse().map((id) => id.toUpperCase()) } }, async (tx) => { callbacks += 1; tx.requireIdentityRead(fixture.sourceIds) }, {
            afterAcquire: async () => { callbacks += 1 },
            transaction: <Result>(handler: (client: AuthorizationInputHandlerClient) => Promise<Result>) => service.transaction(async (client) => {
              waiterPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
              ready.resolve()
              return handler({ query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient })
            }),
          })
          const outcome = pending.then(() => null, (error) => error)
          await Promise.race([ready.promise, pending])
          await waitUntilBlockedBy(waiterPid, blockerPid)
          expect(callbacks).toBe(0)
          const activity = await observer.query('SELECT query FROM pg_stat_activity WHERE pid = $1', [waiterPid])
          const expected = rank === 'R2' ? 'pg_advisory_xact_lock_shared(hashtext' : rank === 'R2F' ? 'pg_advisory_xact_lock(hashtext($1))' : rank === 'R2R' ? 'FROM roles' : 'FROM users'
          expect(activity.rows[0].query).toContain(expected)
          const identityLocks = await observer.query("SELECT mode, granted FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND objsubid = 1 AND objid = (hashtext($2)::bigint & 4294967295)::oid", [waiterPid, 'directory:identity-maintenance'])
          expect(identityLocks.rows).toEqual([{ mode: 'ShareLock', granted: rank !== 'R2' }])
          if (rank !== 'R2') {
            for (const [index, sourceId] of fixture.sourceIds.entries()) {
              const freezeLocks = await observer.query("SELECT mode, granted FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND objsubid = 1 AND objid = (hashtext($2)::bigint & 4294967295)::oid", [waiterPid, `directory:source-sync-freeze:${sourceId}`])
              expect(freezeLocks.rows).toEqual(rank === 'R2F' && index === 1 ? [] : [{ mode: 'ExclusiveLock', granted: rank !== 'R2F' }])
            }
          }
          if (timeout) {
            expect(await outcome).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'lock_timeout' })
            expect(callbacks).toBe(0)
            const locks = await observer.query("SELECT count(*)::int AS count FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted", [waiterPid])
            expect(locks.rows).toEqual([{ count: 0 }])
            const state = await observer.query('SELECT xact_start FROM pg_stat_activity WHERE pid = $1', [waiterPid])
            expect(state.rows).toEqual([{ xact_start: null }])
          }
          await blocker.query('ROLLBACK')
          if (!timeout) { expect(await outcome).toBeNull(); expect(callbacks).toBe(2) }
        } finally {
          await blocker.query('ROLLBACK').catch(() => undefined)
          blocker.release()
          await pending?.catch(() => undefined)
        }
        await withAuthorizationInputTransaction(fixture.plan, async (tx) => tx.requireIdentityRead(fixture.sourceIds), { transaction: runnerOf(service) })
      }
    })

    it.each(['R2', 'R2F'])('blocks the legacy %s writer in reverse arrival order', async (rank) => {
      const fixture = await seedIdentityPlan()
      const ready = deferred()
      const release = deferred()
      let holderPid = 0
      const holder = withAuthorizationInputTransaction(fixture.plan, async (tx) => { holderPid = await pidOf(tx); ready.resolve(); await release.promise }, { transaction: runnerOf(service) })
      const writer = await observer.connect()
      let pending: Promise<void> | undefined
      try {
        await Promise.race([ready.promise, holder])
        await writer.query('BEGIN')
        await writer.query("SET LOCAL statement_timeout = '8s'")
        const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        pending = takeBlocker(writer, rank, fixture)
        const outcome = pending.then(() => null, (error) => error)
        await waitUntilBlockedBy(writerPid, holderPid)
        release.resolve()
        await holder
        expect(await outcome).toBeNull()
      } finally {
        release.resolve()
        await holder.catch(() => undefined)
        await pending?.catch(() => undefined)
        await writer.query('ROLLBACK').catch(() => undefined)
        writer.release()
      }
    })

    it('serializes reverse multi-source plans in canonical order without deadlock', async () => {
      const fixture = await seedIdentityPlan()
      const ready = deferred()
      const release = deferred()
      let holderPid = 0
      let waiterPid = 0
      let callbacks = 0
      let waiter: Promise<void> | undefined
      let paused = false
      const holder = withAuthorizationInputTransaction(fixture.plan, async () => undefined, {
        transaction: <Result>(handler: (client: AuthorizationInputHandlerClient) => Promise<Result>) => service.transaction(async (client) => {
          holderPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          return handler({
            query: async (sql, params) => {
              const result = await client.query(sql, params)
              if (!paused && sql === 'SELECT pg_advisory_xact_lock(hashtext($1))' && params?.[0] === `directory:source-sync-freeze:${fixture.sourceIds[0]}`) {
                paused = true
                ready.resolve()
                await release.promise
              }
              return result
            },
            __rawClient: client.__rawClient,
          })
        }),
      })
      try {
        expect(await Promise.race([ready.promise.then(() => true), holder.then(() => false)])).toBe(true)
        const started = deferred()
        waiter = withAuthorizationInputTransaction({ ...fixture.plan, identityRead: { sourceIntegrationIds: [...fixture.sourceIds].reverse() } }, async () => { callbacks += 1 }, {
          transaction: <Result>(handler: (client: AuthorizationInputHandlerClient) => Promise<Result>) => service.transaction(async (client) => {
            waiterPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            started.resolve()
            return handler({ query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient })
          }),
        })
        await Promise.race([started.promise, waiter])
        await waitUntilBlockedBy(waiterPid, holderPid)
        expect(callbacks).toBe(0)
        for (const [index, sourceId] of fixture.sourceIds.entries()) {
          const locks = await observer.query("SELECT mode, granted FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND objsubid = 1 AND objid = (hashtext($2)::bigint & 4294967295)::oid", [waiterPid, `directory:source-sync-freeze:${sourceId}`])
          expect(locks.rows).toEqual(index === 0 ? [{ mode: 'ExclusiveLock', granted: false }] : [])
        }
        release.resolve()
        await Promise.all([holder, waiter])
      } finally {
        release.resolve()
        await Promise.allSettled([holder, ...(waiter ? [waiter] : [])])
      }
      expect(callbacks).toBe(1)
    })

    it('combines original role-plan revalidation and detects drift with the identity slot', async () => {
      const fixture = await seedIdentityPlan()
      const plan = await discoverPrivilegeRolePlan(observer, [fixture.userId], fixture.plan.identityRead)
      await withAuthorizationInputTransaction(plan.lockPlan, async (tx) => { tx.requireIdentityRead(fixture.sourceIds); await revalidatePrivilegeRolePlan(tx, plan) }, { transaction: runnerOf(service) })
      createdPlanUserIds.push(fixture.userId)
      await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.userId, fixture.roleId])
      let writes = 0
      const error = await rejection(withAuthorizationInputTransaction(plan.lockPlan, async (tx) => { await revalidatePrivilegeRolePlan(tx, plan); writes += 1 }, { transaction: runnerOf(service) }))
      expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_STALE', reason: 'role_membership_changed' })
      expect(writes).toBe(0)
    })
  })

  describe('consumer role witnesses', () => {
    async function seedWitnessRole(): Promise<string> {
      const roleId = `ais1-consumer-role-${randomUUID()}`
      createdRoleIds.push(roleId)
      await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
      return roleId
    }

    it('allows another role share lock while a consumer holds its witness', async () => {
      const roleId = await seedWitnessRole()
      await withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', roleIds: [roleId] }, async (tx) => {
        const other = await observer.connect()
        try {
          await other.query('BEGIN')
          await other.query("SET LOCAL statement_timeout = '2s'")
          const otherPid = Number((await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          expect(otherPid).not.toBe(await pidOf(tx))
          const rows = await other.query('SELECT id FROM roles WHERE id = $1 FOR SHARE', [roleId])
          expect(rows.rows).toEqual([{ id: roleId }])
          expect(tx.roleRows.get(roleId)).toBe('held')
        } finally {
          await other.query('ROLLBACK').catch(() => undefined)
          other.release()
        }
      }, { transaction: runnerOf(service) })
    })

    it('blocks an update lock on the exact role held by a consumer', async () => {
      const roleId = await seedWitnessRole()
      await withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', roleIds: [roleId] }, async (tx) => {
        const other = await observer.connect()
        try {
          await other.query('BEGIN')
          const error = await rejection(other.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE NOWAIT', [roleId]))
          expect(error).toMatchObject({ code: '55P03' })
          expect(tx.roleRows.get(roleId)).toBe('held')
          expect((await tx.query('SELECT 1 AS valid')).rows).toEqual([{ valid: 1 }])
        } finally {
          await other.query('ROLLBACK').catch(() => undefined)
          other.release()
        }
      }, { transaction: runnerOf(service) })
    })

    it('waits on an earlier update lock before reaching consumer work', async () => {
      const roleId = await seedWitnessRole()
      const other = await observer.connect()
      const ready = deferred()
      let consumerPid = 0
      let workCalls = 0
      let consumer: Promise<unknown> | undefined
      try {
        await other.query('BEGIN')
        await other.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [roleId])
        const blockerPid = Number((await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        consumer = withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', roleIds: [roleId] }, async (tx) => {
          workCalls += 1
          return tx.roleRows.get(roleId)
        }, {
          transaction: <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>) => service.transaction(async (client) => {
            consumerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            ready.resolve()
            return handler({ query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient })
          }),
        })
        await Promise.race([ready.promise, consumer])
        await waitUntilBlockedBy(consumerPid, blockerPid)
        expect(workCalls).toBe(0)
        const waiting = await observer.query('SELECT query FROM pg_stat_activity WHERE pid = $1', [consumerPid])
        expect(waiting.rows[0]?.query).toBe(AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)
        await other.query('ROLLBACK')
        expect(await consumer).toBe('held')
        expect(workCalls).toBe(1)
      } finally {
        await other.query('ROLLBACK').catch(() => undefined)
        other.release()
        await consumer?.catch(() => undefined)
      }
    })

    it('rolls back a missing witness before lower-ranked locks or consumer work', async () => {
      const missingRoleId = `ais1-missing-consumer-role-${randomUUID()}`
      const unreachableUserId = `ais1-consumer-unreached-${randomUUID()}`
      const queries: string[] = []
      let consumerPid = 0
      let workCalls = 0
      const error = await rejection(withAuthorizationInputTransaction({
        intent: 'CONSUME_CLASS_DECISION', roleIds: [missingRoleId], admissionUserIds: [unreachableUserId], userIds: [unreachableUserId],
      }, async () => { workCalls += 1 }, {
        transaction: <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>) => service.transaction(async (client) => {
          consumerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          return handler({
            query: (sql, params) => { queries.push(sql); return client.query(sql, params) },
            __rawClient: client.__rawClient,
          })
        }),
      }))
      expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'role_row_not_held' })
      expect(workCalls).toBe(0)
      expect(queries).not.toContain(AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission)
      expect(queries.some((sql) => /FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql))).toBe(false)
      const held = await observer.query("SELECT count(*)::int AS count FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted", [consumerPid])
      expect(held.rows).toEqual([{ count: 0 }])
    })
  })

  describe('discovered privilege role plans', () => {
    async function seedRolePlan() {
      const subjectIds = Array.from({ length: 3 }, () => `ais1-plan-user-${randomUUID()}`).sort()
      const roleIds = Array.from({ length: 2 }, () => `ais1-plan-role-${randomUUID()}`).sort()
      createdUserIds.push(...subjectIds)
      createdPlanUserIds.push(...subjectIds)
      createdRoleIds.push(...roleIds)
      for (const roleId of roleIds) await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
      for (const userId of subjectIds) {
        await observer.query(
          `INSERT INTO users (id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
           VALUES ($1, $1, $1, 'synthetic-unused', true, false, 'user', '[]'::jsonb, 'activated', false)`,
          [userId],
        )
      }
      await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4)', [subjectIds[0], roleIds[0], subjectIds[1], roleIds[1]])
      return { subjectIds, roleIds }
    }

    async function writeFromOtherConnection(discoveryClient: PoolClient, work: (client: PoolClient) => Promise<void>) {
      const writer = await service.getInternalPool().connect()
      try {
        const discoveryPid = Number((await discoveryClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        expect(writerPid).not.toBe(discoveryPid)
        await writer.query('BEGIN')
        await work(writer)
        await writer.query('COMMIT')
      } catch (error) {
        await writer.query('ROLLBACK')
        throw error
      } finally {
        writer.release()
      }
    }

    async function expectRejectedPlan(plan: PrivilegeRolePlan, expected: Record<string, unknown>) {
      const statements: Array<{ sql: string; params?: unknown[] }> = []
      let workCalls = 0
      let businessWrites = 0
      const error = await rejection(withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
        workCalls += 1
        expect(tx.plan).toBe(plan.lockPlan)
        await revalidatePrivilegeRolePlan(tx, plan)
        businessWrites += 1
        await tx.query('UPDATE users SET name = $1 WHERE id = ANY($2::text[])', ['unexpected-plan-write', plan.subjectIds])
      }, {
        transaction: <Result>(handler: (client: AuthorizationInputHandlerClient) => Promise<Result>) => service.transaction((client) => handler({
          query: (sql, params) => { statements.push({ sql, params }); return client.query(sql, params) },
          __rawClient: client.__rawClient,
        })),
      }))
      expect(error).toMatchObject(expected)
      expect(businessWrites).toBe(0)
      expect(statements.filter(({ sql }) => /^\s*(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql))).toEqual([])
      expect(statements.filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared).map(({ params }) => params)).toEqual(plan.roleIds.map((roleId) => [roleId]))
      const firstRead = statements.findIndex(({ sql }) => sql.includes('FROM users u'))
      if (firstRead >= 0) {
        expect(statements.slice(firstRead).filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared
          || sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission || /FOR UPDATE/.test(sql))).toEqual([])
      }
      const users = await observer.query('SELECT id, name FROM users WHERE id = ANY($1::text[]) ORDER BY id', [plan.subjectIds])
      expect(users.rows).toEqual(plan.subjectIds.map((id) => ({ id, name: id })))
      return { statements, workCalls }
    }

    it('discovers real mappings, normalizes repeated subjects and validates the exact returned plan including empty roles', async () => {
      const { subjectIds, roleIds } = await seedRolePlan()
      const plan = await discoverPrivilegeRolePlan(observer, [...subjectIds].reverse().concat(subjectIds[0]))
      expect(plan.subjectIds).toEqual(subjectIds)
      expect(plan.subjects).toEqual([
        { userId: subjectIds[0], roleIds: [roleIds[0]] },
        { userId: subjectIds[1], roleIds: [roleIds[1]] },
        { userId: subjectIds[2], roleIds: [] },
      ])
      const result = await withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
        expect(tx.plan).toBe(plan.lockPlan)
        expect([...tx.witnessed.userIds]).toEqual(subjectIds)
        expect([...tx.witnessed.admissionUserIds]).toEqual(subjectIds)
        return revalidatePrivilegeRolePlan(tx, plan)
      }, { transaction: runnerOf(service) })
      expect(result).toBeUndefined()
    })

    it.each(['add', 'remove', 'swap'] as const)('rejects a real committed membership %s between discovery and entry with zero business writes', async (change) => {
      const { subjectIds, roleIds } = await seedRolePlan()
      const discoveryClient = await observer.connect()
      try {
        const plan = await discoverPrivilegeRolePlan(discoveryClient, subjectIds)
        await writeFromOtherConnection(discoveryClient, async (writer) => {
          if (change === 'add') {
            await writer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [subjectIds[2], roleIds[0]])
          } else if (change === 'remove') {
            await writer.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [subjectIds[0], roleIds[0]])
          } else {
            await writer.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [subjectIds])
            await writer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4)', [subjectIds[0], roleIds[1], subjectIds[1], roleIds[0]])
          }
        })
        const current = await discoverPrivilegeRolePlan(discoveryClient, subjectIds)
        if (change === 'swap') expect(current.roleIds).toEqual(plan.roleIds)
        expect(current.subjects).not.toEqual(plan.subjects)
        const { statements, workCalls } = await expectRejectedPlan(plan, {
          code: 'AUTHORIZATION_INPUT_PLAN_STALE', reason: 'role_membership_changed', status: 409, retryable: false,
        })
        expect(workCalls).toBe(1)
        expect(statements.filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission).map(({ params }) => params)).toEqual(subjectIds.map((id) => [`namespace-admission:${id}`]))
      } finally {
        discoveryClient.release()
      }
    })

    it('rejects an actually deleted role from the discovered plan before lower-ranked locks or consumer work', async () => {
      const { subjectIds, roleIds } = await seedRolePlan()
      const discoveryClient = await observer.connect()
      try {
        const plan = await discoverPrivilegeRolePlan(discoveryClient, subjectIds)
        await writeFromOtherConnection(discoveryClient, async (writer) => {
          await writer.query('DELETE FROM user_roles WHERE role_id = $1', [roleIds[0]])
          await writer.query('DELETE FROM roles WHERE id = $1', [roleIds[0]])
        })
        expect((await observer.query('SELECT id FROM roles WHERE id = $1', [roleIds[0]])).rows).toEqual([])
        const { statements, workCalls } = await expectRejectedPlan(plan, { code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'role_row_not_held' })
        expect(workCalls).toBe(0)
        expect(statements.filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission || /FROM users\s+WHERE/.test(sql))).toEqual([])
      } finally {
        discoveryClient.release()
      }
    })

    it('refuses a discovered subject with no user row rather than silently treating it as an empty-role authorization', async () => {
      const missingId = `ais1-plan-missing-user-${randomUUID()}`
      const plan = await discoverPrivilegeRolePlan(observer, [missingId, missingId])
      expect(plan.subjects).toEqual([{ userId: missingId, roleIds: [] }])
      let writes = 0
      const error = await rejection(withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
        await revalidatePrivilegeRolePlan(tx, plan)
        writes += 1
        await tx.query('UPDATE users SET name = $1 WHERE id = $2', ['unexpected-plan-write', missingId])
      }, { transaction: runnerOf(service) }))
      expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'user_row_not_held' })
      expect(writes).toBe(0)
      expect((await observer.query('SELECT id FROM users WHERE id = $1', [missingId])).rows).toEqual([])
    })
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
