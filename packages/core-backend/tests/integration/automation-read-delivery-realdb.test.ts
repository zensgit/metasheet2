/** Real outbox/ledger migrations, PG transactions and dispatcher. Execution is
 * deliberately SYNTHETIC: this proves delivery admission/reconciliation, not
 * live PLM authority, the native driver or the preview planner. No source IO.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { resetAutomationReadRecordActivations } from '../utils/automation-read-execution-schema'
import { createAutomationReadDelivery, type AutomationReadDeliveryOptions } from '../../src/integration/automation-read-delivery'
import { AutomationActorAuthorityError } from '../../src/integration/automation-live-authority'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  type ReadRequestStatus } from '../../src/integration/automation-read-contracts'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import { ConsumerAdapterRegistry, runDispatchTick } from '../../src/multitable/automation-durable-dispatch-loop'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB must actually provide a database for the read delivery', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})
const manifest = { version: 1001, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] } }
const preview = { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
const retry = { outcome: 'retryable_failure', reason: 'adapter_error' }
const rejected = { outcome: 'permanent_failure', reason: 'permanent_rejection' }
const handled = { outcome: 'success' }
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describeDatabase('Automation read delivery: real PG sink and dispatcher, synthetic execution', () => {
  const schema = `automation_read_delivery_${randomBytes(8).toString('hex')}`
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>
  let schemaCreated = false
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const value = await work({ isTransaction: true, query: (text, params) => client.query(text, params) })
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
  async function seed(status: ReadRequestStatus = 'queued') {
    const grantId = randomUUID(), requestId = randomUUID()
    await admin.query(`INSERT INTO integration_automation_read_grants
      (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions)
      VALUES ($1,'synthetic-tenant','synthetic-owner','{}',$2,$3,ARRAY['synthetic-project'],ARRAY['manual'],
        '{"maxRows":100,"maxPages":5,"maxReadCount":8,"timeoutMs":60000}',clock_timestamp()+interval '1 hour',1)`,
    [grantId, JSON.stringify({ connectionId: 'synthetic-source', connectionIncarnation: randomUUID() }), 'a'.repeat(64)])
    const outboxId = await transaction(async trx => {
      await trx.query(`INSERT INTO integration_automation_read_requests
        (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type)
        VALUES ($1,$2,'synthetic-tenant','synthetic-owner',$3,'synthetic-project','manual')`, [requestId, grantId, randomUUID()])
      const outbox = await enqueueOutboxEvent(trx,
        { eventType: AUTOMATION_READ_EVENT, eventId: `integration-read:${requestId}`, payload: { requestId } }, manifest)
      await trx.query('UPDATE integration_automation_read_requests SET outbox_id = $2 WHERE id = $1', [requestId, outbox.outboxId])
      return outbox.outboxId
    })
    if (status === 'running') await running(requestId)
    else if (status !== 'queued') await terminal(requestId, status)
    return { grantId, requestId, outboxId }
  }
  async function running(requestId: string) {
    await transaction(async trx => {
      await trx.query(`UPDATE integration_automation_read_grants SET used_executions = 1
        WHERE id = (SELECT grant_id FROM integration_automation_read_requests WHERE id = $1)`, [requestId])
      await trx.query(`UPDATE integration_automation_read_requests SET status = 'running', fence = $2,
        started_at = clock_timestamp(), lease_expires_at = clock_timestamp()+interval '1 minute' WHERE id = $1`, [requestId, randomUUID()])
    })
  }
  async function terminal(requestId: string, status: ReadRequestStatus) {
    await admin.query(`UPDATE integration_automation_read_requests SET status = $2, finished_at = clock_timestamp(),
      result = $3 WHERE id = $1`, [requestId, status, status === 'succeeded' ? JSON.stringify(preview) : null])
  }
  async function snapshot(requestId: string) {
    return (await admin.query(`SELECT r.status, r.result, r.fence, g.used_executions,
      c.status AS delivery_status, c.last_error, c.attempts FROM integration_automation_read_requests r
      JOIN integration_automation_read_grants g ON g.id = r.grant_id
      JOIN meta_automation_outbox_consumer c ON c.outbox_id = r.outbox_id
      WHERE r.id = $1`, [requestId])).rows[0]
  }
  function adapter(execute: AutomationReadDeliveryOptions['execute'], tx = transaction) {
    return createAutomationReadDelivery({ transaction: tx, execute })
  }
  async function claim() {
    const rows = await claimDueConsumers(pool, { consumerKeys: [AUTOMATION_READ_CONSUMER], batchSize: 1, leaseMs: 30000 })
    expect(rows).toHaveLength(1)
    return rows[0]
  }
  async function tick(execute: AutomationReadDeliveryOptions['execute'], options: Parameters<typeof runDispatchTick>[2] = {}) {
    const registry = new ConsumerAdapterRegistry()
    registry.register(adapter(execute))
    return runDispatchTick(pool, registry, { batchSize: 1, ...options })
  }
  async function requeue(outboxId: string) {
    await admin.query(`UPDATE meta_automation_outbox_consumer SET status = 'pending', lease_expires_at = NULL
      WHERE outbox_id = $1`, [outboxId])
  }
  beforeAll(async () => {
    if (!/^automation_read_delivery_[a-f0-9]{16}$/u.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8,
      options: `-c search_path=${schema} -c statement_timeout=10000` })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL,
      max: 1, options: `-c search_path=${schema} -c statement_timeout=10000` }) }) })
    await db.transaction().execute(addOutbox)
    await db.transaction().execute(addLedger)
    await db.transaction().execute(addRecordActivation)
  })
  beforeEach(async () => {
    await resetAutomationReadRecordActivations(admin, async () => {
      await admin.query('TRUNCATE integration_automation_read_record_activations, integration_automation_read_requests, integration_automation_read_grants, meta_automation_outbox_consumer, meta_automation_outbox')
    })
  })
  afterAll(async () => {
    await db?.destroy()
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  it('real dispatch passes its AbortSignal, ACKs only durable success and never returns private result', async () => {
    const item = await seed()
    const execute = vi.fn(async (requestId: string, signal: AbortSignal) => {
      expect(requestId).toBe(item.requestId)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
      await running(requestId)
      await terminal(requestId, 'succeeded')
      return { requestId, status: 'succeeded' as const }
    })
    expect(await tick(execute)).toMatchObject({ completed: 1, rescheduled: 0 })
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'succeeded', result: preview, delivery_status: 'done', used_executions: 1 })
    await requeue(item.outboxId)
    expect(await tick(execute)).toMatchObject({ completed: 1 })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  for (const status of ['succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'] as const) {
    it(`${status} is transport-terminal, never reauthorized/reexecuted or relabeled preview success`, async () => {
      const item = await seed(status), execute = vi.fn()
      await admin.query("UPDATE integration_automation_read_grants SET status = 'revoked' WHERE id = $1", [item.grantId])
      expect(await tick(execute)).toMatchObject({ completed: 1 })
      expect(await snapshot(item.requestId)).toMatchObject({ status, delivery_status: 'done', result: status === 'succeeded' ? preview : null })
      expect(execute).not.toHaveBeenCalled()
    })
  }
  for (const status of ['queued', 'running', 'succeeded', 'outcome_unknown'] as const) {
    it(`a resolved ${status} return without durable evidence is NOT accepted as success`, async () => {
      const item = await seed()
      expect(await tick(async requestId => ({ requestId, status }))).toMatchObject({ completed: 0, rescheduled: 1 })
      expect(await snapshot(item.requestId)).toMatchObject({ status: 'queued', used_executions: 0, result: null, last_error: 'adapter_error' })
    })
  }
  it('an active running duplicate waits without execute; its expired source lease terminalizes unknown without reclaim', async () => {
    const item = await seed('running'), execute = vi.fn()
    expect(await tick(execute)).toMatchObject({ rescheduled: 1 })
    const before = await snapshot(item.requestId)
    await admin.query("UPDATE integration_automation_read_requests SET lease_expires_at = clock_timestamp()-interval '1 second' WHERE id = $1", [item.requestId])
    await requeue(item.outboxId)
    expect(await tick(execute)).toMatchObject({ completed: 1 })
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'outcome_unknown', fence: before.fence, used_executions: 1, result: null })
    expect(execute).not.toHaveBeenCalled()
  })
  const denials = [
    new AutomationReadLedgerError('AUTOMATION_READ_DENIED'),
    new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED'),
    new AutomationReadLedgerError('AUTOMATION_READ_BUDGET_EXHAUSTED'),
    new AutomationActorAuthorityError('AUTOMATION_ACTOR_AUTHORITY_DENIED'),
    Object.assign(new Error('synthetic inactive'), { code: 'AUTOMATION_READ_RUNTIME_INACTIVE' }),
  ]
  for (const error of denials) {
    it(`${error.code}: pre-fence queued refusal becomes blocked, not orphaned or retried`, async () => {
      const item = await seed(), execute = vi.fn().mockRejectedValue(error)
      expect(await tick(execute)).toMatchObject({ completed: 1 })
      expect(await snapshot(item.requestId)).toMatchObject({ status: 'blocked', used_executions: 0, fence: null, result: null, delivery_status: 'done' })
      await requeue(item.outboxId)
      expect(await tick(execute)).toMatchObject({ completed: 1 })
      expect(execute).toHaveBeenCalledTimes(1)
    })
  }
  it('transient unavailable before claim retries transport; only a later successful invocation simulates source IO', async () => {
    const item = await seed()
    let sourceReads = 0, calls = 0
    const execute = async (requestId: string) => {
      if (++calls === 1) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
      await running(requestId)
      sourceReads++
      await terminal(requestId, 'succeeded')
      return { requestId, status: 'succeeded' as const }
    }
    expect(await tick(execute)).toMatchObject({ rescheduled: 1 })
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'queued', used_executions: 0 })
    await requeue(item.outboxId)
    expect(await tick(execute)).toMatchObject({ completed: 1 })
    expect(sourceReads).toBe(1)
  })
  it('an exception after committed claim is conservatively unknown and never invokes execute a second time', async () => {
    const item = await seed()
    const execute = vi.fn(async (requestId: string) => {
      await running(requestId)
      throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
    })
    expect(await tick(execute)).toMatchObject({ completed: 1 })
    const before = await snapshot(item.requestId)
    expect(before).toMatchObject({ status: 'outcome_unknown', used_executions: 1, result: null })
    await requeue(item.outboxId)
    expect(await tick(execute)).toMatchObject({ completed: 1 })
    expect((await snapshot(item.requestId)).fence).toBe(before.fence)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  const mutations: Array<[string, string, (requestId: string) => unknown[]]> = [
    ['request association', "UPDATE integration_automation_read_requests SET outbox_id = 'synthetic-foreign-outbox' WHERE id = $1", id => [id]],
    ['persisted event identity', "UPDATE meta_automation_outbox SET event_id = 'integration-read:foreign'", () => []],
    ['persisted event type', "UPDATE meta_automation_outbox SET event_type = 'approval.approved'", () => []],
    ['persisted version', 'UPDATE meta_automation_outbox SET manifest_version = 1002', () => []],
    ['persisted payload extras', 'UPDATE meta_automation_outbox SET payload = $1', id => [JSON.stringify({ requestId: id, token: 'synthetic-private' })]],
    ['persisted payload request', 'UPDATE meta_automation_outbox SET payload = $1', () => [JSON.stringify({ requestId: randomUUID() })]],
  ]
  for (const [label, statement, values] of mutations) {
    it(`rejects wrong ${label} even when the delivered UUID is valid`, async () => {
      const item = await seed(), event = await claim(), execute = vi.fn()
      await admin.query(statement, values(item.requestId))
      expect(await adapter(execute).handle(event, { signal: new AbortController().signal })).toEqual(rejected)
      expect(execute).not.toHaveBeenCalled()
      expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id = $1', [item.requestId])).rows[0].status).toBe('queued')
    })
  }
  for (const [label, statement] of [
    ['stale fence', 'UPDATE meta_automation_outbox_consumer SET fence = fence + 1'],
    ['changed attempt', 'UPDATE meta_automation_outbox_consumer SET attempts = attempts + 1'],
    ['expired delivery lease', "UPDATE meta_automation_outbox_consumer SET lease_expires_at = clock_timestamp()-interval '1 second'"],
    ['already terminal delivery', "UPDATE meta_automation_outbox_consumer SET status = 'done', lease_expires_at = NULL"],
  ]) {
    it(`${label} cannot admit runtime or mutate the sink`, async () => {
      const item = await seed(), event = await claim(), execute = vi.fn()
      await admin.query(statement)
      expect(await adapter(execute).handle(event, { signal: new AbortController().signal })).toEqual(retry)
      expect(await snapshot(item.requestId)).toMatchObject({ status: 'queued', used_executions: 0 })
      expect(execute).not.toHaveBeenCalled()
    })
  }
  it('an autocommit client with a forged marker cannot make admission or safe-sink writes', async () => {
    const item = await seed(), event = await claim(), execute = vi.fn()
    const forged: AutomationReadDeliveryOptions['transaction'] = work => work({ isTransaction: true, query: (text, params) => admin.query(text, params) })
    expect(await adapter(execute, forged).handle(event, { signal: new AbortController().signal })).toEqual(retry)
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'queued', used_executions: 0 })
    expect(execute).not.toHaveBeenCalled()
  })
  it('abort arriving during admission is forwarded as no execution, not a new signal or successful ACK', async () => {
    const item = await seed(), event = await claim(), execute = vi.fn(), controller = new AbortController()
    const abortAfterTransaction: AutomationReadDeliveryOptions['transaction'] = async work => {
      const result = await transaction(work)
      controller.abort()
      return result
    }
    expect(await adapter(execute, abortAfterTransaction).handle(event, { signal: controller.signal })).toEqual(retry)
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'queued', used_executions: 0 })
    expect(execute).not.toHaveBeenCalled()
  })
  it('grant lock ordering preserves concurrent cancellation and checks delivery expiry after the lock wait', async () => {
    const item = await seed(), event = await claim(), execute = vi.fn(), waiting = barrier()
    const blocker = await pool.connect()
    let waiterPid = 0
    const observed: AutomationReadDeliveryOptions['transaction'] = work => transaction(async trx => {
      waiterPid = Number((await trx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      waiting.resolve()
      return work(trx)
    })
    let work: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await blocker.query('SELECT id FROM integration_automation_read_grants WHERE id = $1 FOR UPDATE', [item.grantId])
      work = adapter(execute, observed).handle(event, { signal: new AbortController().signal })
      await waiting.promise
      await vi.waitFor(async () => {
        expect((await admin.query('SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS ours', [blockerPid, waiterPid])).rows[0].ours).toBe(true)
      })
      await blocker.query(`UPDATE integration_automation_read_requests SET status = 'cancelled',
        finished_at = clock_timestamp() WHERE id = $1`, [item.requestId])
      await blocker.query(`UPDATE meta_automation_outbox_consumer SET lease_expires_at = clock_timestamp()-interval '1 second'
        WHERE outbox_id = $1`, [item.outboxId])
      await blocker.query('COMMIT')
      expect(await work).toEqual(retry)
      expect(await snapshot(item.requestId)).toMatchObject({ status: 'cancelled', used_executions: 0, result: null })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      await work
    }
  })
  it('real dispatcher timeout aborts the exact runtime signal; retry delivery drains unknown without rerunning', async () => {
    const item = await seed(), started = barrier(), stopped = barrier()
    let runtimeSignal: AbortSignal | undefined
    const execute = vi.fn(async (requestId: string, signal: AbortSignal) => {
      runtimeSignal = signal
      await running(requestId)
      signal.addEventListener('abort', stopped.resolve, { once: true })
      started.resolve()
      await stopped.promise
      await terminal(requestId, 'outcome_unknown')
      return { requestId, status: 'outcome_unknown' as const }
    })
    const dispatch = tick(execute, { adapterTimeoutMs: 1000 })
    try {
      await started.promise
      const outcome = await dispatch
      // This assertion kills disconnected-signal mutants by behavior, not by
      // waiting forever for a listener that can no longer receive cancellation.
      expect(runtimeSignal?.aborted).toBe(true)
      expect(outcome).toMatchObject({ rescheduled: 1 })
      // Wait for the cooperative safe sink; the outer timeout may win its COMMIT.
      await vi.waitFor(async () => expect((await snapshot(item.requestId)).status).toBe('outcome_unknown'))
      await requeue(item.outboxId)
      expect(await tick(execute)).toMatchObject({ completed: 1 })
      expect(await snapshot(item.requestId)).toMatchObject({ status: 'outcome_unknown', used_executions: 1, result: null, delivery_status: 'done' })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      stopped.resolve()
      await dispatch
      await vi.waitFor(async () => expect((await snapshot(item.requestId)).status).toBe('outcome_unknown'))
    }
  })
  it('a lost safe-sink COMMIT receipt retries transport and discovers committed blocked, without runtime retry', async () => {
    const item = await seed(), event = await claim(), execute = vi.fn().mockRejectedValue(new AutomationReadLedgerError('AUTOMATION_READ_DENIED'))
    let count = 0
    const lostReceipt: AutomationReadDeliveryOptions['transaction'] = async work => {
      const result = await transaction(work)
      if (++count === 2) throw new Error('synthetic lost receipt')
      return result
    }
    expect(await adapter(execute, lostReceipt).handle(event, { signal: new AbortController().signal })).toEqual(retry)
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'blocked', used_executions: 0 })
    expect(await adapter(execute).handle(event, { signal: new AbortController().signal })).toEqual(handled)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
