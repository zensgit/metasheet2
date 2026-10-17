/** Actual PostgreSQL retention/locking evidence in one randomly owned schema.
 * Seeds are synthetic SQL fixtures using actual outbox/image migrations, not producer/REST evidence.
 * Age setup briefly disables ONLY the owned image UPDATE guard inside a transaction, restores it
 * before commit, and never changes the host/DB clock or the production pruning query.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addImages } from '../../src/db/migrations/zzzz20261001138000_automation_record_after_image'
import { pruneAutomationRecordAfterImages } from '../../src/multitable/automation-record-after-image-retention'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies isolated PG for after-image retention', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const consumer = 'automation-record-trigger'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

describeDb('Private after-image retention: real DB clock, locks and deletion scope', () => {
  const schema = 'automation_image_retention_' + randomBytes(8).toString('hex')
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, created = false
  const validSchema = () => { if (!/^automation_image_retention_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_RETENTION_SCHEMA') }
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>,
    afterQuery?: (sql: string, client: PoolClient) => Promise<void>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work({ isTransaction: true, async query(sql, params) {
        const response = await client.query(sql, params)
        await afterQuery?.(sql, client)
        return response
      } })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async function seed(options: { count?: number; age?: string; status?: string | null; key?: string; unavailable?: boolean } = {}) {
    const ids = Array.from({ length: options.count ?? 1 }, () => 'obx_' + randomUUID())
    await transaction(async trx => {
      for (const id of ids) {
        await trx.query(`INSERT INTO meta_automation_outbox(id,event_type,payload,manifest_version,event_id)
          VALUES($1,'multitable.record.created',$2::jsonb,1,$3)`,
        [id, JSON.stringify({ sheetId: 'synthetic-sheet', recordId: id }), 'event:' + id])
        if (options.status !== null) {
          const status = options.status ?? 'done'
          await trx.query(`INSERT INTO meta_automation_outbox_consumer(outbox_id,consumer_key,status,lease_expires_at)
            VALUES($1,$2,$3,CASE WHEN $3='in_progress' THEN clock_timestamp()+INTERVAL '1 hour' ELSE NULL END)`,
          [id, options.key ?? consumer, status])
        }
        await trx.query(`INSERT INTO meta_automation_record_after_images
          (outbox_id,event_type,event_id,sheet_id,record_id,record_version,status,reason,after_image,captured_bytes)
          VALUES($1,'multitable.record.created',$2,'synthetic-sheet',$1,1,$3,$4,$5::jsonb,$6)`,
        [id, 'event:' + id, options.unavailable ? 'unavailable' : 'captured',
          options.unavailable ? 'batch_limits' : null, options.unavailable ? null : '{}', options.unavailable ? 0 : 2])
      }
      // This is an owned, explicit test-only age fixture. The real INSERT guard above minted
      // its timestamp; the immutable UPDATE guard is restored before exposing this transaction.
      await trx.query('ALTER TABLE meta_automation_record_after_images DISABLE TRIGGER automation_record_after_image_immutable')
      await trx.query(`UPDATE meta_automation_record_after_images SET created_at=clock_timestamp()-$2::interval
        WHERE outbox_id=ANY($1::text[])`, [ids, options.age ?? '8 days'])
      await trx.query('ALTER TABLE meta_automation_record_after_images ENABLE TRIGGER automation_record_after_image_immutable')
    })
    return ids
  }
  async function retained() {
    return (await admin.query('SELECT outbox_id FROM meta_automation_record_after_images ORDER BY outbox_id')).rows.map(row => String(row.outbox_id))
  }
  async function parents() {
    return (await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM meta_automation_outbox o) AS events,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY outbox_id,consumer_key) FROM meta_automation_outbox_consumer c) AS consumers`)).rows[0]
  }
  beforeAll(async () => {
    validSchema()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5,
      options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true
    await db.transaction().execute(addOutbox)
    await db.transaction().execute(addImages)
  })
  beforeEach(async () => {
    validSchema()
    expect((await admin.query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }])
    await admin.query('TRUNCATE meta_automation_outbox CASCADE')
  })
  afterAll(async () => {
    if (admin) {
      if (created) { validSchema(); await admin.query('DROP SCHEMA "' + schema + '" CASCADE') }
      admin.release()
    }
    if (db) await db.destroy()
    else if (pool) await pool.end()
  })

  it('deletes old captured/unavailable images only, retaining complete event/consumer history unchanged', async () => {
    await seed(); await seed({ unavailable: true })
    const before = await parents()
    expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(2)
    expect(await retained()).toEqual([])
    expect(await parents()).toEqual(before)
    expect((await admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid='meta_automation_record_after_images'::regclass
      AND tgname='automation_record_after_image_immutable'`)).rows).toEqual([{ tgenabled: 'O' }])
  })
  it.each(['pending', 'in_progress', 'dead_letter', null])('retains images when the exact source consumer is %s', async status => {
    const ids = await seed({ status })
    const before = await parents()
    expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(0)
    expect(await retained()).toEqual(ids)
    expect(await parents()).toEqual(before)
  })
  it('a different done consumer cannot authorize image deletion', async () => {
    const ids = await seed({ key: 'synthetic-other-consumer' })
    expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(0)
    expect(await retained()).toEqual(ids)
  })
  it('uses actual DB age: younger than seven days remains while older than seven days is pruned', async () => {
    const young = await seed({ age: '6 days 23 hours' })
    await seed({ age: '7 days 1 hour' })
    expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(1)
    expect(await retained()).toEqual(young)
  })
  it('limits every actual DELETE to 200 even with a larger eligible backlog', async () => {
    await seed({ count: 203 })
    const before = await parents()
    expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(200)
    expect(await retained()).toHaveLength(3)
    expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(3)
    expect(await retained()).toHaveLength(0)
    expect(await parents()).toEqual(before)
  })
  it.each(['meta_automation_outbox_consumer', 'meta_automation_record_after_images'])(
    'skips a real held %s row and still cleans another eligible row', async table => {
      const [held] = await seed(), [free] = await seed()
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        // Receipt from the actual SELECT proves the row lock was acquired; no sleeps/guessed timing.
        expect((await blocker.query(`SELECT outbox_id FROM ${table} WHERE outbox_id=$1 FOR UPDATE`, [held])).rows).toHaveLength(1)
        expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(1)
        expect(await retained()).toEqual([held])
        expect(await retained()).not.toContain(free)
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
      expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(1)
    },
  )
  it('a writer-first done->pending transition is neither waited for nor pruned before or after commit', async () => {
    const ids = await seed(), writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      expect((await writer.query(`UPDATE meta_automation_outbox_consumer SET status='pending'
        WHERE outbox_id=$1 AND consumer_key=$2 RETURNING status`, [ids[0], consumer])).rows).toEqual([{ status: 'pending' }])
      expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(0)
      expect(await retained()).toEqual(ids)
      await writer.query('COMMIT')
      expect(await pruneAutomationRecordAfterImages({ transaction })).toBe(0)
      expect(await retained()).toEqual(ids)
    } finally { await writer.query('ROLLBACK'); writer.release() }
  })
  it('cleaner-first holds the exact consumer lock through DELETE and commit', async () => {
    const ids = await seed(), entered = deferred(), release = deferred(), writer = await pool.connect()
    const cleaning = pruneAutomationRecordAfterImages({ transaction: work => transaction(work, async sql => {
      if (sql.startsWith('SELECT i.outbox_id')) { entered.resolve(); await release.promise }
    }) })
    // Observe rejection immediately without changing the actual prune result.
    void cleaning.catch(() => undefined)
    try {
      await entered.promise
      await writer.query('BEGIN')
      await writer.query("SET LOCAL lock_timeout='100ms'")
      await expect(writer.query(`UPDATE meta_automation_outbox_consumer SET status='pending'
        WHERE outbox_id=$1 AND consumer_key=$2`, [ids[0], consumer])).rejects.toMatchObject({ code: '55P03' })
      await writer.query('ROLLBACK')
      release.resolve()
      expect(await cleaning).toBe(1)
      expect(await retained()).toEqual([])
    } finally { release.resolve(); await cleaning.catch(() => undefined); await writer.query('ROLLBACK'); writer.release() }
  })
  it('the final DELETE independently rechecks consumer state on the same transaction handle', async () => {
    const ids = await seed()
    // Deliberate same-txn fixture mutation, not a fabricated SELECT result or a claim about a
    // concurrent writer bypassing the lock. This isolates the final DELETE predicate itself.
    const count = await pruneAutomationRecordAfterImages({ transaction: work => transaction(work, async (sql, client) => {
      if (sql.startsWith('SELECT i.outbox_id')) await client.query(`UPDATE meta_automation_outbox_consumer
        SET status='pending' WHERE outbox_id=$1 AND consumer_key=$2`, [ids[0], consumer])
    }) })
    expect(count).toBe(0)
    expect(await retained()).toEqual(ids)
  })
  it('a missing image table is an observable fixed failure, never successful zero cleanup', async () => {
    await admin.query('ALTER TABLE meta_automation_record_after_images RENAME TO synthetic_retention_images_missing')
    try {
      await expect(pruneAutomationRecordAfterImages({ transaction })).rejects.toMatchObject({
        code: 'AUTOMATION_RECORD_AFTER_IMAGE_RETENTION_UNAVAILABLE', message: 'AUTOMATION_RECORD_AFTER_IMAGE_RETENTION_UNAVAILABLE',
      })
    } finally { await admin.query('ALTER TABLE synthetic_retention_images_missing RENAME TO meta_automation_record_after_images') }
  })
})
