// Delivery prerequisite only: actual store/producer/shared dispatcher/PG locks.
// No JWT, live material authority, execution permit or remote transport claim.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createYidaAutomationDispatchClaimAuthority } from '../../src/integration/yida-automation-dispatch-claim'
import { createYidaAutomationAuthorizationStore } from '../../src/integration/yida-automation-authorization-store'
import { enqueueYidaAutomationRequestInTransaction, YIDA_AUTOMATION_CONSUMER } from '../../src/integration/yida-automation-outbox'
import { claimDueConsumers, completeConsumer, rescheduleConsumer, type ClaimedConsumer,
  type Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { up as migrateSharedOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'

const owner = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' } as const
const activationId = '22222222-2222-4222-8222-222222222222'
const ruleRevision = '11111111-1111-4111-8111-111111111111'
const sourceRoot = new URL('../../../../', import.meta.url)
type Authority = ReturnType<typeof createYidaAutomationDispatchClaimAuthority>
type Store = ReturnType<typeof createYidaAutomationAuthorizationStore>

it('sentinel: dispatch proof requires explicitly provided disposable PG', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
describe('SA06D actual durable dispatcher claim prerequisite — real PG', () => {
  let admin: Pool, pool: Pool, schema: string, authority: Authority, store: Store, mono = 1000
  let queued: { grantId: string; requestId: string; outboxId: string }
  let claimed: ClaimedConsumer
  const ddl = (name: string) => readFileSync(fileURLToPath(new URL('packages/core-backend/migrations/' + name, sourceRoot)), 'utf8')
  const factory = (patch: Record<string, unknown> = {}) => createYidaAutomationDispatchClaimAuthority({
    scope: owner, activationId, workerId: 'synthetic-worker', monotonicNow: () => mono, ...patch,
  })
  const denied = (pending: Promise<unknown>) => expect(pending).rejects.toThrow('YIDA_AUTOMATION_DISPATCH_CLAIM_DENIED')
  async function transaction<T>(work: (trx: Queryable) => Promise<T>) {
    const client = await pool.connect()
    try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); const result = await work(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async function dbClock() { return (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date }
  const take = (which = authority, delivery: unknown = claimed) => transaction(async trx =>
    which.takeInTransaction(trx, await which.lockInTransaction(trx, delivery)))
  beforeAll(() => {
    if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) throw new Error('SA06D_OWNED_DB_REQUIRED')
    const url = new URL(process.env.DATABASE_URL)
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/plm_full_app_synthetic') throw new Error('SA06D_OWNED_DB_REQUIRED')
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  })
  beforeEach(async () => {
    schema = 'sa06dclaim_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=5000` })
    await migrateSharedOutbox(new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }))
    for (const file of ['090_create_integration_yida_delivery_ledger.sql',
      '097_create_integration_yida_automation_authorizations.sql', 'zzzz20261019121000_link_integration_yida_automation_outbox.sql']) await pool.query(ddl(file))
    mono = 1000
    store = createYidaAutomationAuthorizationStore({ scope: owner, activationId, monotonicNow: () => mono })
    authority = factory()
    // Repository-layer fixture, not an authorization shortcut installed in host.
    // The separate live/management suite proves real approval/actor/material.
    queued = await transaction(async trx => {
      const grant = await store.createInTransaction(trx, { confirmationId: 'synthetic-confirmation', ruleId: 'synthetic-rule',
        expectedRuleRevision: ruleRevision, actionId: 'synthetic-slot', projectNo: 'DEMO-P1', operationId: 'synthetic-operation',
        rowKeys: ['synthetic-row'], allowedTriggers: ['manual'], maxExecutions: 1, ttlMs: 900000 }, 'a'.repeat(64))
      const request = await store.reserveInTransaction(trx, grant.grantId, { grantId: grant.grantId, activationId,
        ruleId: 'synthetic-rule', ruleRevision, actionId: 'synthetic-slot', triggerType: 'manual', requestKey: 'synthetic-request' })
      await enqueueYidaAutomationRequestInTransaction(trx, grant.grantId, request)
      const outbox = await trx.query('SELECT outbox_id FROM integration_yida_auto_outbox_links WHERE request_id=$1', [request.requestId])
      return { grantId: grant.grantId, requestId: request.requestId, outboxId: String(outbox.rows[0].outbox_id) }
    })
    const now = await dbClock()
    const result = await claimDueConsumers(pool, { consumerKeys: [YIDA_AUTOMATION_CONSUMER], leaseMs: 60000, now: () => now })
    expect(result.length).toBe(1); claimed = result[0]
  }, 15000)
  afterEach(async () => {
    authority?.close(); await pool?.end()
    if (!/^sa06dclaim_[0-9a-f]{32}$/u.test(schema)) throw new Error('SA06D_SCHEMA_NOT_OWNED')
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  })
  afterAll(async () => { await admin?.end() })

  it('proves actual claim facts with a distinct host worker, without send authority or budget consumption', async () => {
    await transaction(async trx => {
      const proof = await authority.lockInTransaction(trx, claimed)
      expect(Object.keys(proof)).toEqual([]); expect(Object.getOwnPropertySymbols(proof)).toEqual([])
      expect(JSON.stringify(proof)).toBe('{}')
      expect(await authority.takeInTransaction(trx, proof)).toMatchObject({ ...owner,
        grantId: queued.grantId, requestId: queued.requestId, outboxId: queued.outboxId, rowOrdinal: 0,
        workerId: 'synthetic-worker', workerFence: claimed.fence, canSend: false, externalWriteAttempted: false })
      await denied(authority.takeInTransaction(trx, proof))
    })
    expect((await pool.query('SELECT used_executions FROM integration_yida_auto_grants')).rows[0].used_executions).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_admissions')).rows[0].n).toBe(0)
  })
  it.each(['ownerId', 'tenantId'])('a different trusted %s binding cannot consume the real claim', async key => {
    await take()
    const other = factory({ scope: { ...owner, [key]: 'different' } })
    try { await denied(take(other)) } finally { other.close() }
  })
  it('a different activation cannot resurrect the old queued claim', async () => {
    const other = factory({ activationId: randomUUID() })
    try { await denied(take(other)) } finally { other.close() }
  })
  it('owner impersonation is rejected at host binding construction', () => {
    expect(() => factory({ workerId: owner.ownerId })).toThrow('YIDA_AUTOMATION_DISPATCH_CLAIM_DENIED')
  })
  it('unknown scope fields and getters in claim payload are refused before SQL', async () => {
    let queries = 0, getters = 0
    const poison: Queryable = { query: async () => { queries++; throw new Error('SA06D_SQL_MUST_NOT_RUN') } }
    const payload = Object.defineProperty({}, 'requestId', { enumerable: true, get() { getters++; return queued.requestId } })
    for (const input of [{ ...claimed, ownerId: owner.ownerId }, { ...claimed, payload },
      { ...claimed, payload: { requestId: queued.requestId, tenantId: owner.tenantId } }]) {
      await denied(authority.lockInTransaction(poison, input))
    }
    expect(queries).toBe(0); expect(getters).toBe(0)
  })
  it('actual reschedule invalidates the old fence even when attempts and the lease stay valid', async () => {
    await take()
    const now = await dbClock()
    expect(await rescheduleConsumer(pool, claimed.outboxId, claimed.consumerKey, claimed.fence, 60000, 'adapter_error', { now: () => now })).toBe(true)
    const current = (await pool.query('SELECT fence::text AS fence,attempts FROM meta_automation_outbox_consumer')).rows[0]
    expect(current.attempts).toBe(claimed.attempts)
    expect(current.fence).not.toBe(claimed.fence)
    await denied(take())
  })
  it('a completed consumer cannot supply a delivery prerequisite', async () => {
    const now = await dbClock()
    expect(await completeConsumer(pool, claimed.outboxId, claimed.consumerKey, claimed.fence, { now: () => now })).toBe(true)
    await denied(take())
  })
  it('lease expiry with the same fence refuses fresh and already-created proofs', async () => {
    await transaction(async trx => {
      const proof = await authority.lockInTransaction(trx, claimed)
      await trx.query("UPDATE meta_automation_outbox_consumer SET lease_expires_at=clock_timestamp()-interval '1 second'")
      await denied(authority.takeInTransaction(trx, proof))
    })
    await denied(take())
  })
  it('revocation after proof creation is rechecked before consumption', async () => {
    await transaction(async trx => {
      const proof = await authority.lockInTransaction(trx, claimed)
      await store.revokeInTransaction(trx, queued.grantId)
      await denied(authority.takeInTransaction(trx, proof))
    })
  })
  it('elapsed grant TTL cannot be hidden behind an otherwise valid shared lease', async () => {
    await transaction(async trx => {
      const proof = await authority.lockInTransaction(trx, claimed)
      mono += 900000
      await denied(authority.takeInTransaction(trx, proof))
    })
  })
  it('already-admitted requests never regain a queued delivery prerequisite', async () => {
    await transaction(async trx => {
      const id = randomUUID()
      // A prepared-row fixture only; this does not prove the not-yet-wired
      // plugin prepare/fence/actual worker admission composition.
      await trx.query(`INSERT INTO integration_yida_delivery_ledger
        (id,tenant_id,workspace_id,operation_id,row_key,owner_id,target_ref,target_revision,
         plan_revision,payload_digest,business_key_digest,credential_ref,credential_generation,intent,status)
        VALUES ($1,$2,NULL,'synthetic-operation','synthetic-row',$3,'target','evidence-1',$4,$4,$4,'credential',1,'create','prepared')`,
      [id, owner.tenantId, owner.ownerId, 'a'.repeat(64)])
      await store.admitInTransaction(trx, queued.grantId, { requestId: queued.requestId, ledgerId: id,
        workerId: 'synthetic-worker', workerFence: claimed.fence })
    })
    await denied(take())
    expect((await pool.query('SELECT used_executions FROM integration_yida_auto_grants')).rows[0].used_executions).toBe(1)
  })
  it('opaque proofs are instance-bound and JSON cannot recreate them', async () => {
    const other = factory()
    try {
      await transaction(async trx => {
        const proof = await authority.lockInTransaction(trx, claimed)
        await denied(other.takeInTransaction(trx, proof))
        await denied(authority.takeInTransaction(trx, JSON.parse(JSON.stringify(proof))))
        await authority.takeInTransaction(trx, proof)
      })
    } finally { other.close() }
  })
  it('concurrent consumption of one proof succeeds at most once', async () => {
    await transaction(async trx => {
      const proof = await authority.lockInTransaction(trx, claimed)
      const result = await Promise.allSettled([authority.takeInTransaction(trx, proof), authority.takeInTransaction(trx, proof)])
      expect(result.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected'])
    })
  })
  it('a proof does not survive COMMIT on the same physical client', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const proof = await authority.lockInTransaction(client, claimed)
      await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await denied(authority.takeInTransaction(client, proof))
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
  it('close invalidates pending proofs and rejects fresh work', async () => {
    await transaction(async trx => {
      const proof = await authority.lockInTransaction(trx, claimed)
      authority.close()
      await denied(authority.takeInTransaction(trx, proof)); await denied(authority.lockInTransaction(trx, claimed))
    })
  })
  it('autocommit cannot acquire a transaction-bound claim proof', async () => {
    const client = await pool.connect()
    try { await denied(authority.lockInTransaction(client, claimed)) } finally { client.release() }
  })
  it('the actual stored event is rechecked, not trusted from dispatcher input', async () => {
    for (const [column, value] of [
      ['event_type', 'other.event'], ['event_id', 'other-event'],
      ['payload', JSON.stringify({ requestId: randomUUID() })], ['automation_depth', 1], ['manifest_version', 4],
    ] as const) {
      await expect(transaction(async trx => {
        // Closed, local column list; every branch is an independent rollback.
        await trx.query(`UPDATE meta_automation_outbox SET ${column}=$1 WHERE id=$2`, [value, queued.outboxId])
        await denied(authority.lockInTransaction(trx, claimed))
        throw new Error('SA06D_TEST_RESTORE_EVENT')
      })).rejects.toThrow('SA06D_TEST_RESTORE_EVENT')
    }
    await take() // All five rollbacks restore the same genuine claim.
  })
})
