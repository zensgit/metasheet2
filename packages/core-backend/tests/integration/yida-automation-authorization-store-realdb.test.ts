// Private repository proof only: real PG/constraints/transaction races, not JWT,
// live source permission, execution capabilities, outbox or external sending.
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationAuthorizationStore } from '../../src/integration/yida-automation-authorization-store'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const sourceRoot = new URL('../../../../', import.meta.url)
const owner = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' } as const
const revision = '11111111-1111-4111-8111-111111111111'
const activation = '22222222-2222-4222-8222-222222222222'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const consent = () => ({ confirmationId: randomUUID(), ruleId: 'rule', expectedRuleRevision: revision,
  actionId: 'action', projectNo: 'synthetic-project', operationId: 'operation', rowKeys: ['row-a', 'row-b'],
  allowedTriggers: ['manual'], maxExecutions: 2, ttlMs: 900000 })
type Store = ReturnType<typeof createYidaAutomationAuthorizationStore>

it('sentinel: SA06D repository requires an explicitly provided disposable PG', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})

describe('SA06D private authorization repository — actual PostgreSQL', () => {
  let admin: Pool, pool: Pool, schema: string, store: Store, mono = 1000
  const ddl = (name: string) => readFileSync(fileURLToPath(new URL('packages/core-backend/migrations/' + name, sourceRoot)), 'utf8')
  async function transaction<T>(work: (trx: Queryable) => Promise<T>, isolation = 'READ COMMITTED') {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL ' + isolation)
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const occurrence = (grantId: string, requestKey = 'request') => ({ grantId, activationId: activation,
    ruleId: 'rule', ruleRevision: revision, actionId: 'action', triggerType: 'manual', requestKey })
  async function grant(input = consent()) {
    return transaction(trx => store.createInTransaction(trx, input, hash('material')))
  }
  async function reserve(grantId: string, key = 'request') {
    return transaction(trx => store.reserveInTransaction(trx, grantId, occurrence(grantId, key)))
  }
  async function ledger(trx: Queryable, rowKey: string, operationId = 'operation') {
    const ledgerId = randomUUID()
    await trx.query(`INSERT INTO integration_yida_delivery_ledger
      (id,tenant_id,workspace_id,operation_id,row_key,owner_id,target_ref,target_revision,
       plan_revision,payload_digest,business_key_digest,credential_ref,credential_generation,intent,status)
      VALUES ($1,$2,NULL,$3,$4,$5,'target','evidence-1',$6,$7,$8,'credential',1,'create','prepared')`,
    [ledgerId, owner.tenantId, operationId, rowKey, owner.ownerId, hash('plan'), hash('payload'), hash(rowKey)])
    return ledgerId
  }
  async function evidence() {
    return (await pool.query(`SELECT used_executions,active_request_id,
      (SELECT count(*)::int FROM integration_yida_auto_admissions) AS admissions,
      (SELECT count(*)::int FROM integration_yida_delivery_ledger) AS deliveries
      FROM integration_yida_auto_grants ORDER BY id`)).rows
  }
  beforeAll(() => {
    if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) throw new Error('SA06D_OWNED_DB_REQUIRED')
    const url = new URL(process.env.DATABASE_URL)
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/plm_full_app_synthetic') throw new Error('SA06D_OWNED_DB_REQUIRED')
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  })
  beforeEach(async () => {
    schema = 'sa06d_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=5000` })
    await pool.query(ddl('090_create_integration_yida_delivery_ledger.sql'))
    await pool.query(ddl('097_create_integration_yida_automation_authorizations.sql'))
    mono = 1000
    store = createYidaAutomationAuthorizationStore({ scope: owner, activationId: activation, monotonicNow: () => mono })
  })
  afterEach(async () => {
    await pool?.end()
    if (!/^sa06d_[0-9a-f]{32}$/u.test(schema)) throw new Error('SA06D_SCHEMA_NOT_OWNED')
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  })
  afterAll(async () => { await admin?.end() })

  it('creates immutable consent, replays it without renewal and rejects changed confirmation content', async () => {
    const input = consent(), first = await grant(input), second = await grant(input)
    expect(second).toEqual({ ...first, reused: true })
    await expect(grant({ ...input, ttlMs: 1000 })).rejects.toThrow('YIDA_AUTOMATION_STORE_CONFLICT')
    await expect(pool.query('UPDATE integration_yida_auto_grants SET ttl_ms=ttl_ms+1 WHERE id=$1', [first.grantId])).rejects.toBeTruthy()
    expect((await evidence())[0]).toMatchObject({ used_executions: 0, admissions: 0, deliveries: 0 })
  })
  it('concurrent duplicate confirmations commit only one grant', async () => {
    const input = consent(), result = await Promise.all([grant(input), grant(input)])
    expect(new Set(result.map(row => row.grantId)).size).toBe(1)
    expect(result.map(row => row.reused).sort()).toEqual([false, true])
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(1)
  })
  it('reserves each occurrence once and keeps a deterministic immutable row mapping', async () => {
    const created = await grant()
    const duplicate = await Promise.all([reserve(created.grantId), reserve(created.grantId)])
    expect(duplicate[0].requestId).toBe(duplicate[1].requestId)
    expect(duplicate[0].rowOrdinal).toBe(0)
    expect((await reserve(created.grantId, 'next')).rowOrdinal).toBe(1)
    await expect(reserve(created.grantId, 'overflow')).rejects.toThrow('YIDA_AUTOMATION_STORE_CONFLICT')
    expect((await evidence())[0].used_executions).toBe(0)
    await expect(pool.query('DELETE FROM integration_yida_auto_requests')).rejects.toBeTruthy()
  })
  it('revocation blocks new requests but replay only observes history, never another row', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    await transaction(trx => store.revokeInTransaction(trx, created.grantId))
    await transaction(trx => store.revokeInTransaction(trx, created.grantId))
    expect(await reserve(created.grantId)).toEqual({ ...request, reused: true })
    await expect(reserve(created.grantId, 'new')).rejects.toThrow('YIDA_AUTOMATION_STORE_REVOKED')
  })
  it('different owner or tenant cannot inspect or revoke an existing grant', async () => {
    const created = await grant()
    for (const scope of [{ ...owner, ownerId: 'other' }, { ...owner, tenantId: 'other' }]) {
      const other = createYidaAutomationAuthorizationStore({ scope, activationId: activation })
      await expect(transaction(trx => other.revokeInTransaction(trx, created.grantId))).rejects.toThrow('YIDA_AUTOMATION_STORE_NOT_FOUND')
    }
  })
  it('revocation between reservation and admission leaves counters and delivery preparation untouched', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    await transaction(trx => store.revokeInTransaction(trx, created.grantId))
    await expect(transaction(async trx => {
      const ledgerId = await ledger(trx, 'row-a')
      return store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
    })).rejects.toThrow('YIDA_AUTOMATION_STORE_REVOKED')
    expect((await evidence())[0]).toMatchObject({ used_executions: 0, admissions: 0, deliveries: 0 })
  })
  it('rule and action mismatches cannot reserve any row', async () => {
    const created = await grant()
    for (const mismatch of [{ ruleId: 'other' }, { actionId: 'other' }, { ruleRevision: randomUUID() }]) {
      await expect(transaction(trx => store.reserveInTransaction(trx, created.grantId,
        { ...occurrence(created.grantId), ...mismatch }))).rejects.toThrow('YIDA_AUTOMATION_STORE_CONFLICT')
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
  })
  it('a persisted forward time watermark prevents granting authority to a backward DB clock', async () => {
    const created = await grant()
    await pool.query('UPDATE integration_yida_auto_grants SET last_db_ms=last_db_ms+60000 WHERE id=$1', [created.grantId])
    await expect(reserve(created.grantId)).rejects.toThrow('YIDA_AUTOMATION_STORE_STALE')
    expect((await evidence())[0].used_executions).toBe(0)
  })
  it('restart, monotonic expiry and backward monotonic clocks refuse new reservations', async () => {
    const created = await grant()
    const restarted = createYidaAutomationAuthorizationStore({ scope: owner, activationId: randomUUID() })
    await expect(transaction(trx => restarted.reserveInTransaction(trx, created.grantId, occurrence(created.grantId))))
      .rejects.toThrow('YIDA_AUTOMATION_STORE_STALE')
    mono = 1100
    await reserve(created.grantId)
    mono = 1099
    await expect(reserve(created.grantId, 'rollback')).rejects.toThrow('YIDA_AUTOMATION_STORE_STALE')
    mono = 901000
    await expect(reserve(created.grantId, 'expired')).rejects.toThrow('YIDA_AUTOMATION_STORE_EXPIRED')
    await transaction(trx => store.revokeInTransaction(trx, created.grantId))
  })
  it('rejects an autocommit handle and a repeatable-read transaction', async () => {
    await expect(store.createInTransaction(pool, consent(), hash('material'))).rejects.toThrow('YIDA_AUTOMATION_STORE_UNAVAILABLE')
    await expect(transaction(trx => store.createInTransaction(trx, consent(), hash('material')), 'REPEATABLE READ'))
      .rejects.toThrow('YIDA_AUTOMATION_STORE_UNAVAILABLE')
    expect((await evidence()).length).toBe(0)
  })
  it('atomically admits one prepared CREATE and records the actual worker rather than the owner', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    const result = await transaction(async trx => {
      const ledgerId = await ledger(trx, 'row-a')
      return store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
    })
    expect(result.reused).toBe(false)
    expect((await evidence())[0]).toMatchObject({ used_executions: 1, admissions: 1, deliveries: 1, active_request_id: request.requestId })
    expect((await pool.query('SELECT worker_id,worker_fence::text FROM integration_yida_auto_admissions')).rows)
      .toEqual([{ worker_id: 'worker', worker_fence: '1' }])
    const replay = await transaction(trx => store.admitInTransaction(trx, created.grantId,
      { requestId: request.requestId, ledgerId: result.ledgerId, workerId: 'other-worker', workerFence: '2' }))
    expect(replay).toEqual({ ...result, reused: true })
    expect((await evidence())[0].used_executions).toBe(1)
  })
  it('rolls ledger preparation, admission and counter back together', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    await expect(transaction(async trx => {
      const ledgerId = await ledger(trx, 'row-a')
      await store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
      throw new Error('SYNTHETIC_TRANSACTION_ROLLBACK')
    })).rejects.toThrow('SYNTHETIC_TRANSACTION_ROLLBACK')
    expect((await evidence())[0]).toMatchObject({ used_executions: 0, admissions: 0, deliveries: 0, active_request_id: null })
  })
  it('expiry discovered after preparation rolls the whole admission transaction back', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    await expect(transaction(async trx => {
      const ledgerId = await ledger(trx, 'row-a')
      mono = 901000
      return store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
    })).rejects.toThrow('YIDA_AUTOMATION_STORE_EXPIRED')
    expect((await evidence())[0]).toMatchObject({ used_executions: 0, admissions: 0, deliveries: 0 })
  })
  it('a prepared row for another operation cannot consume this authorization', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    await expect(transaction(async trx => {
      const ledgerId = await ledger(trx, 'row-a', 'other-operation')
      return store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
    })).rejects.toThrow('YIDA_AUTOMATION_STORE_CONFLICT')
    expect((await evidence())[0]).toMatchObject({ used_executions: 0, admissions: 0, deliveries: 0 })
  })
  it('serializes competing admissions and never admits a second worker while one is active', async () => {
    const created = await grant(), first = await reserve(created.grantId), second = await reserve(created.grantId, 'second')
    const result = await Promise.allSettled([first, second].map((request, index) => transaction(async trx => {
      const ledgerId = await ledger(trx, index ? 'row-b' : 'row-a')
      return store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: `worker-${index}`, workerFence: '1' })
    })))
    expect(result.filter(value => value.status === 'fulfilled').length).toBe(1)
    expect(result.filter(value => value.status === 'rejected').length).toBe(1)
    expect((await evidence())[0]).toMatchObject({ used_executions: 1, admissions: 1, deliveries: 1 })
  })
  it('a lost COMMIT response consumes the budget; recovery observes the same admission', async () => {
    const created = await grant(), request = await reserve(created.grantId)
    let ledgerId = ''
    await expect((async () => {
      await transaction(async trx => {
        ledgerId = await ledger(trx, 'row-a')
        await store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
      })
      throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST')
    })()).rejects.toThrow('SYNTHETIC_COMMIT_RESPONSE_LOST')
    expect((await transaction(trx => store.admitInTransaction(trx, created.grantId,
      { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '2' }))).reused).toBe(true)
    expect((await evidence())[0]).toMatchObject({ used_executions: 1, admissions: 1 })
  })
  it('database constraints reject a counter without an admission and permit migration replay without refund', async () => {
    const created = await grant()
    await expect(transaction(trx => trx.query('UPDATE integration_yida_auto_grants SET used_executions=1 WHERE id=$1', [created.grantId])))
      .rejects.toBeTruthy()
    const request = await reserve(created.grantId)
    await transaction(async trx => {
      const ledgerId = await ledger(trx, 'row-a')
      await store.admitInTransaction(trx, created.grantId, { requestId: request.requestId, ledgerId, workerId: 'worker', workerFence: '1' })
    })
    const before = await evidence()
    await pool.query(ddl('097_create_integration_yida_automation_authorizations.sql'))
    expect(await evidence()).toEqual(before)
    await expect(pool.query('UPDATE integration_yida_auto_grants SET used_executions=0 WHERE id=$1', [created.grantId])).rejects.toBeTruthy()
  })
})
