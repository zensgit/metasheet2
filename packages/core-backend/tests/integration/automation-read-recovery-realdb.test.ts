/** Real PG outbox/ledger and claim-time poison. Grants are synthetic fixture
 * rows, not live authorization. Recovery never calls an executor/source. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { resetAutomationReadRecordActivations } from '../utils/automation-read-execution-schema'
import { createAutomationReadRecovery, recoverDeadLetters } from '../../src/integration/automation-read-recovery'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, type ReadRequestStatus } from '../../src/integration/automation-read-contracts'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB provides a database for the read recovery', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const manifest = { version: 1001, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] } }
const preview = { status: 'ready', counts: { add: 17, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describeDatabase('Automation read dead-letter recovery: genuine PG, no execution authority', () => {
  const schema = `automation_read_recovery_${randomBytes(8).toString('hex')}`
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>
  let schemaCreated = false
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const value = await work({ isTransaction: true, query: (text, params) => client.query(text, params) })
      await client.query('COMMIT')
      return value
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
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
    if (status === 'running') {
      await admin.query('UPDATE integration_automation_read_grants SET used_executions = 1 WHERE id = $1', [grantId])
      await admin.query(`UPDATE integration_automation_read_requests SET status = 'running', fence = $2,
        started_at = clock_timestamp(), lease_expires_at = clock_timestamp()+interval '1 minute' WHERE id = $1`, [requestId, randomUUID()])
    } else if (status !== 'queued') {
      await admin.query(`UPDATE integration_automation_read_requests SET status = $2, finished_at = clock_timestamp(),
        result = $3 WHERE id = $1`, [requestId, status, status === 'succeeded' ? JSON.stringify(preview) : null])
    }
    // Persisted previous crashes exhausted transport without running a callback.
    await admin.query('UPDATE meta_automation_outbox_consumer SET attempts = 8, fence = 9 WHERE outbox_id = $1', [outboxId])
    return { grantId, requestId, outboxId }
  }
  async function poison() {
    expect(await claimDueConsumers(pool, { consumerKeys: [AUTOMATION_READ_CONSUMER], batchSize: 100 })).toEqual([])
  }
  async function snapshot(requestId: string) {
    return (await admin.query(`SELECT r.status, r.result, r.fence, r.finished_at, g.used_executions,
      c.status AS delivery_status, c.fence::text AS delivery_fence, c.attempts
      FROM integration_automation_read_requests r JOIN integration_automation_read_grants g ON g.id = r.grant_id
      JOIN meta_automation_outbox_consumer c ON c.outbox_id = r.outbox_id
      WHERE r.id = $1`, [requestId])).rows[0]
  }
  beforeAll(async () => {
    if (!/^automation_read_recovery_[a-f0-9]{16}$/u.test(schema)) throw new Error('Invalid owned schema')
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

  for (const status of ['queued', 'running'] as const) {
    it(`restart recovers ${status} after real claim-time poison with the notification entirely lost`, async () => {
      const item = await seed(status)
      await poison()
      const before = await snapshot(item.requestId)
      expect(before).toMatchObject({ status, delivery_status: 'dead_letter' })
      const recovery = createAutomationReadRecovery({ transaction })
      expect(await recovery.tick()).toBeUndefined()
      expect(await snapshot(item.requestId)).toMatchObject({
        status: status === 'queued' ? 'blocked' : 'outcome_unknown', result: null, fence: before.fence,
        used_executions: before.used_executions, delivery_status: 'dead_letter', delivery_fence: '9', attempts: 8,
      })
      const settled = await snapshot(item.requestId)
      await recovery.tick()
      expect(await snapshot(item.requestId)).toEqual(settled)
      await recovery.stop()
    })
  }
  for (const status of ['succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'] as const) {
    it(`preserves terminal ${status} including its private result and timestamp`, async () => {
      const item = await seed(status)
      await poison()
      const before = await snapshot(item.requestId)
      await recoverDeadLetters({ transaction })
      expect(await snapshot(item.requestId)).toEqual(before)
    })
  }
  const malformed = [
    ['extra payload', "UPDATE meta_automation_outbox SET payload = payload || '{\"extra\":true}'::jsonb WHERE id = $1"],
    ['array payload', "UPDATE meta_automation_outbox SET payload = '[]'::jsonb WHERE id = $1"],
    ['event identity', "UPDATE meta_automation_outbox SET event_id = 'synthetic-wrong-event' WHERE id = $1"],
    ['event type', "UPDATE meta_automation_outbox SET event_type = 'synthetic-wrong-type' WHERE id = $1"],
    ['nested depth', 'UPDATE meta_automation_outbox SET automation_depth = 1 WHERE id = $1'],
    ['consumer identity', "UPDATE meta_automation_outbox_consumer SET consumer_key = 'synthetic-other-consumer' WHERE outbox_id = $1"],
    ['zero fence', 'UPDATE meta_automation_outbox_consumer SET fence = 0 WHERE outbox_id = $1'],
    ['zero attempts', 'UPDATE meta_automation_outbox_consumer SET attempts = 0 WHERE outbox_id = $1'],
  ] as const
  for (const [name, statement] of malformed) {
    it(`refuses a dead-letter with ${name}`, async () => {
      const item = await seed()
      await poison()
      await admin.query(statement, [item.outboxId])
      const before = await snapshot(item.requestId)
      await recoverDeadLetters({ transaction })
      expect(await snapshot(item.requestId)).toEqual(before)
      expect(before.status).toBe('queued')
    })
  }
  it('refuses cross-request and cross-grant outbox linkage without touching either sink', async () => {
    const one = await seed(), two = await seed('running')
    await poison()
    await admin.query('UPDATE integration_automation_read_requests SET outbox_id = $2 WHERE id = $1', [one.requestId, two.outboxId])
    await admin.query('UPDATE integration_automation_read_requests SET outbox_id = $2 WHERE id = $1', [two.requestId, one.outboxId])
    const before = [await snapshot(one.requestId), await snapshot(two.requestId)]
    await recoverDeadLetters({ transaction })
    expect([await snapshot(one.requestId), await snapshot(two.requestId)]).toEqual(before)
  })
  it('requires durable dead_letter, never pending, in_progress or done', async () => {
    const item = await seed()
    for (const status of ['pending', 'in_progress', 'done']) {
      await admin.query(`UPDATE meta_automation_outbox_consumer SET status = $2,
        lease_expires_at = CASE WHEN $2 = 'in_progress' THEN clock_timestamp()+interval '1 minute' ELSE NULL END
        WHERE outbox_id = $1`, [item.outboxId, status])
      await recoverDeadLetters({ transaction })
      expect((await snapshot(item.requestId)).status).toBe('queued')
    }
  })
  it('rechecks dead-letter under locks after a scan race and never observes a private result', async () => {
    const item = await seed('running')
    await poison()
    const statements: string[] = []
    await recoverDeadLetters({ transaction: work => transaction(trx => work({ isTransaction: true,
      async query(text, params) {
        statements.push(text)
        const result = await trx.query(text, params)
        if (text.includes('ORDER BY r.grant_id, r.id LIMIT 16')) {
          await admin.query("UPDATE meta_automation_outbox_consumer SET status = 'pending' WHERE outbox_id = $1", [item.outboxId])
        }
        return result
      },
    })) })
    expect((await snapshot(item.requestId)).status).toBe('running')
    expect(statements.filter(text => /^\s*SELECT/u.test(text)).every(text => !/\bresult\b/u.test(text))).toBe(true)
    expect(statements.some(text => /FOR UPDATE SKIP LOCKED/u.test(text))).toBe(true)
    expect(statements.some(text => /FOR SHARE OF o, c SKIP LOCKED/u.test(text))).toBe(true)
  })
  it('preserves a terminal sink committed after candidate selection', async () => {
    const item = await seed('running')
    await poison()
    await recoverDeadLetters({ transaction: work => transaction(trx => work({ isTransaction: true,
      async query(text, params) {
        const result = await trx.query(text, params)
        if (text.includes('ORDER BY r.grant_id, r.id LIMIT 16')) {
          await admin.query(`UPDATE integration_automation_read_requests SET status = 'succeeded',
            finished_at = clock_timestamp(), result = $2 WHERE id = $1`, [item.requestId, JSON.stringify(preview)])
        }
        return result
      },
    })) })
    expect(await snapshot(item.requestId)).toMatchObject({ status: 'succeeded', result: preview })
  })
  it('bounds each sweep to 16, then catches up on the next existing dispatcher tick', async () => {
    const items = []
    for (let index = 0; index < 17; index++) items.push(await seed())
    await poison()
    await recoverDeadLetters({ transaction })
    const first = await Promise.all(items.map(item => snapshot(item.requestId)))
    expect(first.filter(row => row.status === 'blocked')).toHaveLength(16)
    expect(first.filter(row => row.status === 'queued')).toHaveLength(1)
    await recoverDeadLetters({ transaction })
    expect((await Promise.all(items.map(item => snapshot(item.requestId)))).every(row => row.status === 'blocked')).toBe(true)
  })
  it('malformed dead-letter rows cannot permanently fill the bounded candidate window', async () => {
    for (let index = 0; index < 17; index++) {
      const item = await seed()
      await admin.query("UPDATE meta_automation_outbox SET payload = '{}'::jsonb WHERE id = $1", [item.outboxId])
    }
    const valid = await seed()
    await poison()
    await recoverDeadLetters({ transaction })
    expect((await snapshot(valid.requestId)).status).toBe('blocked')
    expect((await admin.query("SELECT count(*)::int AS count FROM integration_automation_read_requests WHERE status='queued'")).rows[0].count).toBe(17)
  })
  it('skips an active grant lock and safely recovers on a later sweep', async () => {
    const item = await seed('running')
    await poison()
    await admin.query('BEGIN')
    await admin.query('SELECT id FROM integration_automation_read_grants WHERE id = $1 FOR UPDATE', [item.grantId])
    try {
      await recoverDeadLetters({ transaction })
      expect((await snapshot(item.requestId)).status).toBe('running')
    } finally { await admin.query('ROLLBACK') }
    await recoverDeadLetters({ transaction })
    expect((await snapshot(item.requestId)).status).toBe('outcome_unknown')
  })
  it('rotates past 16 continuously locked grants so the seventeenth settles before they unlock', async () => {
    for (let index = 0; index < 17; index++) await seed()
    await poison()
    const rows = (await admin.query('SELECT id, grant_id FROM integration_automation_read_requests ORDER BY grant_id, id')).rows
    const recovery = createAutomationReadRecovery({ transaction })
    await admin.query('BEGIN')
    await admin.query('SELECT id FROM integration_automation_read_grants WHERE id = ANY($1::uuid[]) FOR UPDATE',
      [rows.slice(0, 16).map(row => row.grant_id)])
    try {
      await recovery.tick()
      expect((await snapshot(rows[16].id)).status).toBe('queued')
      await recovery.tick()
      expect((await snapshot(rows[16].id)).status).toBe('blocked')
      expect((await snapshot(rows[0].id)).status).toBe('queued')
    } finally { await admin.query('ROLLBACK'); await recovery.stop() }
    // A replacement process does not need an in-memory cursor to reconcile
    // remaining rows after the locks clear; the durable dead letters suffice.
    await recoverDeadLetters({ transaction })
    expect((await snapshot(rows[0].id)).status).toBe('blocked')
  })
  it('coalesces overlap, synchronously closes admission, and stop waits for the admitted transaction', async () => {
    const item = await seed()
    await poison()
    const entered = barrier(), release = barrier()
    let admissions = 0
    const recovery = createAutomationReadRecovery({ transaction: async work => {
      admissions++; entered.resolve(); await release.promise
      return transaction(work)
    } })
    const first = recovery.tick()
    await entered.promise
    expect(recovery.tick()).toBe(first)
    const stopping = recovery.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await recovery.tick()
    expect(admissions).toBe(1)
    expect(stopped).toBe(false)
    release.resolve()
    await stopping
    expect((await snapshot(item.requestId)).status).toBe('blocked')
    await recovery.tick()
    expect(admissions).toBe(1)
  })
  it('shutdown before the admitted microtask prevents any new transaction', async () => {
    const tx = vi.fn()
    const recovery = createAutomationReadRecovery({ transaction: work => { tx(); return transaction(work) } })
    const first = recovery.tick()
    await recovery.stop()
    await first
    await recovery.tick()
    expect(tx).not.toHaveBeenCalled()
  })
  it('outage and throwing observer stay values-free and a later tick recovers without retrying execution', async () => {
    const item = await seed('running')
    await poison()
    let attempts = 0
    const onError = vi.fn(() => { throw new Error('synthetic-private-observer') })
    const recovery = createAutomationReadRecovery({ transaction: async work => {
      if (++attempts === 1) throw new Error('synthetic-private-database')
      return transaction(work)
    }, onError })
    expect(await recovery.tick()).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('AUTOMATION_READ_RECOVERY_UNAVAILABLE')
    expect((await snapshot(item.requestId)).status).toBe('running')
    await recovery.tick()
    expect((await snapshot(item.requestId)).status).toBe('outcome_unknown')
    await recovery.stop()
    await expect(recoverDeadLetters({ transaction: async () => { throw new Error('synthetic-private-database') } }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_RECOVERY_UNAVAILABLE', message: 'AUTOMATION_READ_RECOVERY_UNAVAILABLE' })
  })
})
