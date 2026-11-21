/** Real migrations and ledger operations in an owned schema. All sends use an in-memory adapter. */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { up as upUsers } from '../../src/db/migrations/zzzz20260119100000_create_users_table'
import { up as upDirectory } from '../../src/db/migrations/zzzz20260324150000_create_directory_sync_tables'
import { up as upDirectoryParentKeys } from '../../src/db/migrations/zzzz20260717120000_create_provider_org_transfers'
import { up as upEndpoints } from '../../src/db/migrations/zzzz20261111093417_create_user_notification_endpoints_preferences'
import { up, down, NOTIFICATION_SEND_DOWN_BLOCKED_CODE } from '../../src/db/migrations/zzzz20261121130000_create_notification_verifications_test_sends'
import { checkNotificationVerification, writeNotificationVerification } from '../../src/notifications/verification-evidence'
import { createNotificationTestSendService } from '../../src/notifications/test-send-service'
import { ProtectedAddress, type RecipientResolver, type ResolvedTarget } from '../../src/notifications/recipient-resolver'
import type { NotificationDbDeps } from '../../src/notifications/notification-tx'
import type { NotificationAdapter } from '../../src/notifications/adapters/notification-adapter'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const PREFIX = 'notification-send-db-'
const SCHEMA = `n78_send_${randomUUID().replaceAll('-', '')}`
const EVIDENCE = 'notification_connection_verifications'
const SENDS = 'notification_test_sends'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = { tenant: 'SyntheticCorp', appScope: 'SyntheticApp' }
const fingerprint = sha('synthetic-credential-tuple')

const EVIDENCE_CONSTRAINTS = [
  ['ncv_conn_fk', 'FOREIGN KEY (connection_id, provider) REFERENCES directory_integrations(id, provider) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['ncv_fp_chk', "CHECK ((tuple_fingerprint ~ '^[0-9a-f]{64}$'::text))"],
  ['ncv_level_chk', "CHECK ((reached_level = ANY (ARRAY['token'::text, 'send'::text])))"],
  ['ncv_revision_chk', 'CHECK ((revision >= 1))'],
  ['ncv_shape_chk', "CHECK (((provider ~ '^[a-z][a-z0-9_]{0,31}$'::text) AND (bound_tenant ~ '^[!-~]+$'::text) AND (bound_app_scope ~ '^[!-~]+$'::text) AND (char_length(bound_app_scope) <= 256) AND (verified_by ~ '^[!-~]+$'::text)))"],
  ['notification_connection_verifications_pkey', 'PRIMARY KEY (connection_id)'],
]

const LEDGER_CONSTRAINTS = [
  ['notification_test_sends_pkey', 'PRIMARY KEY (id)'],
  ['nts_code_chk', "CHECK (((outcome_code IS NULL) OR (outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'::text) OR ((char_length(outcome_code) <= 64) AND (outcome_code ~ '^dingtalk_business_error_(-[0-9]+([.][0-9]+)?|[0-9]+[.][0-9]+)$'::text))))"],
  ['nts_endpoint_conn_fk', 'FOREIGN KEY (endpoint_id, connection_id) REFERENCES user_notification_endpoints(id, connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['nts_endpoint_fk', 'FOREIGN KEY (endpoint_id, org_id, user_id) REFERENCES user_notification_endpoints(id, org_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['nts_finished_chk', "CHECK (((state = ANY (ARRAY['pending'::text, 'sending'::text])) = (finished_at IS NULL)))"],
  ['nts_key_chk', "CHECK ((idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'::text))"],
  ['nts_sending_at_chk', "CHECK (((state <> 'sending'::text) OR (sending_at IS NOT NULL)))"],
  ['nts_shape_chk', "CHECK (((org_id ~ '^[!-~]+$'::text) AND (user_id ~ '^[!-~]+$'::text)))"],
  ['nts_state_chk', "CHECK ((state = ANY (ARRAY['pending'::text, 'sending'::text, 'accepted'::text, 'failed'::text, 'outcome_unknown'::text, 'refused'::text])))"],
  ['nts_terminal_code_chk', "CHECK (((state = ANY (ARRAY['pending'::text, 'sending'::text])) OR (outcome_code IS NOT NULL)))"],
]

const EVIDENCE_INDEXES = [
  ['notification_connection_verifications_pkey', 'CREATE UNIQUE INDEX notification_connection_verifications_pkey ON public.notification_connection_verifications USING btree (connection_id)'],
]

const LEDGER_INDEXES = [
  ['notification_test_sends_pkey', 'CREATE UNIQUE INDEX notification_test_sends_pkey ON public.notification_test_sends USING btree (id)'],
  ['nts_conn_time_idx', 'CREATE INDEX nts_conn_time_idx ON public.notification_test_sends USING btree (connection_id, created_at DESC)'],
  ['nts_key_uniq', 'CREATE UNIQUE INDEX nts_key_uniq ON public.notification_test_sends USING btree (org_id, user_id, idempotency_key)'],
  ['nts_user_time_idx', 'CREATE INDEX nts_user_time_idx ON public.notification_test_sends USING btree (org_id, user_id, created_at DESC)'],
]

describeIfDatabase('notification verification and test sends (real database)', () => {
  let adminPool: Pool
  let pool: Pool
  let migrationDb: Kysely<unknown>
  let deps: NotificationDbDeps
  const connectionIds: string[] = []
  const query = (text: string, values?: unknown[]) => pool.query(text, values)

  async function integration(orgId = `${PREFIX}${randomUUID()}`, tenant = scope.tenant) {
    const result = await query(`INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
      VALUES ($1, 'dingtalk', $2, 'active', $3, $4::jsonb) RETURNING id::text AS id`,
    [orgId, `${PREFIX}${randomUUID()}`, tenant, JSON.stringify({ appKey: scope.appScope })])
    const connectionId = result.rows[0].id as string
    connectionIds.push(connectionId)
    return { connectionId, orgId, tenant }
  }

  async function endpoint(connection?: Awaited<ReturnType<typeof integration>>, userId = `${PREFIX}${randomUUID()}`) {
    const { connectionId, orgId, tenant } = connection ?? await integration()
    const proofId = randomUUID()
    const digest = sha(proofId)
    const result = await query(`INSERT INTO user_notification_endpoints
      (org_id,user_id,connection_id,provider,address_kind,proof_kind,proof_id,proof_witness,address_witness,
       tenant_address_witness,bound_tenant,bound_app_scope)
      VALUES ($1,$2,$3,'dingtalk','dingtalk_userid','directory_link',$4,$5,$5,$5,$6,$7)
      RETURNING id::text AS id`, [orgId, userId, connectionId, proofId, digest, tenant, scope.appScope])
    return { orgId, userId, connectionId, endpointId: result.rows[0].id as string, proofId, digest, tenant }
  }

  type Endpoint = Awaited<ReturnType<typeof endpoint>>

  async function crossConnectionEndpoints(): Promise<[Endpoint, Endpoint]> {
    const first = await endpoint()
    // One address cannot be active on two connections of the same enterprise (07a).
    const second = await endpoint(await integration(first.orgId, 'OtherSyntheticCorp'), first.userId)
    return [first, second]
  }

  function target(row: Endpoint): ResolvedTarget {
    return {
      connectionId: row.connectionId, provider: 'dingtalk', transport: 'work_notification',
      addressKind: 'dingtalk_userid', proofKind: 'directory_link', proofId: row.proofId,
      proofWitness: row.digest, addressWitness: row.digest, tenantAddressWitness: row.digest,
      boundTenant: row.tenant, boundAppScope: scope.appScope, address: new ProtectedAddress('synthetic-address-never-persist'),
    }
  }

  function sender(rows: Endpoint[], options: {
    enabled?: boolean; readiness?: boolean; endpointValid?: boolean; transaction?: NotificationDbDeps['transaction']
  } = {}) {
    const calls = vi.fn(async () => ({ ok: true as const }))
    const prepare = vi.fn(async () => ({ ok: true as const, send: calls }))
    const resolver = {
      verifyEndpoint: async (_db, input) => {
        const row = rows.find((item) => item.orgId === input.orgId && item.userId === input.userId && item.endpointId === input.endpointId)
        return row && options.endpointValid !== false
          ? { ok: true, target: target(row) }
          : { ok: false, code: 'endpoint_not_found' }
      },
    } as Pick<RecipientResolver, 'verifyEndpoint'> as RecipientResolver
    const adapter: NotificationAdapter = {
      provider: 'dingtalk', transport: 'work_notification',
      fingerprint: async () => ({ ok: true, value: fingerprint }),
      prepare,
    }
    const service = createNotificationTestSendService({
      ...deps, transaction: options.transaction ?? deps.transaction,
      resolver, prepareBudgetMs: 12000, isPreferencesEnabled: () => true, isDeliveryEnabled: () => options.enabled !== false,
      checkConnection: async () => options.readiness === false
        ? { ok: false, code: 'connection_not_verified' }
        : { ok: true, witness: sha('capability') },
      adapter: () => adapter,
    })
    return { service, calls, prepare }
  }

  function expectRateLimitedLosers(results: PromiseSettledResult<unknown>[], loserCount: number): void {
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(loserCount)
    for (const result of rejected) expect(result.reason).toMatchObject({ status: 429, code: 'TEST_SEND_RATE_LIMITED' })
  }

  /** Hold the actual connection key and witness every request queued on it before letting any count. */
  async function withBlockedConnection(connectionId: string, operations: Array<() => Promise<unknown>>) {
    const holder = await pool.connect()
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('notif-test-conn'), hashtext($1::text))", [connectionId])
      pending = Promise.allSettled(operations.map((operation) => operation()))
      const deadline = Date.now() + 4000
      let waiting = 0
      while (Date.now() < deadline) {
        const result = await query(`SELECT count(*)::integer AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = hashtext('notif-test-conn')::oid AND objid = hashtext($1::text)::oid`, [connectionId])
        waiting = result.rows[0].n
        if (waiting === operations.length) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(operations.length)
      expect((await query(`SELECT count(*)::integer AS n FROM ${SENDS} WHERE connection_id=$1`, [connectionId])).rows[0].n).toBe(59)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      // Drain even a failed wait assertion, so no transaction survives into fixture cleanup.
      if (pending) await pending
    }
    return pending!
  }

  async function ledger(row: Endpoint, columns: Record<string, unknown> = {}) {
    const record = {
      org_id: row.orgId, user_id: row.userId, endpoint_id: row.endpointId, connection_id: row.connectionId,
      idempotency_key: randomUUID(), ...columns,
    }
    const keys = Object.keys(record)
    return query(`INSERT INTO notification_test_sends (${keys.join(',')})
      VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id::text AS id`, Object.values(record))
  }

  const verify = (connectionId: string, overrides: Partial<Parameters<typeof checkNotificationVerification>[1]> = {}) =>
    checkNotificationVerification(pool, { connectionId, provider: 'dingtalk', scope, tupleFingerprint: fingerprint, ...overrides })

  async function evidence(connectionId: string, reachedLevel: 'none' | 'config' | 'token' | 'send' = 'send', failureLevel?: 'config' | 'token' | 'send', now = new Date()) {
    await deps.transaction((db) => writeNotificationVerification(db, {
      connectionId, provider: 'dingtalk', scope, tupleFingerprint: fingerprint, verifiedBy: `${PREFIX}admin`, now,
      report: {
        requestedLevel: 'send', reachedLevel,
        failure: failureLevel ? { level: failureLevel, code: 'token_rejected', message: 'Synthetic refusal' } : null,
      },
    }))
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl, max: 1 })
    // CI and the real-database runner migrate the database first. Do not install a shared extension in our schema.
    expect((await adminPool.query(`SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') AS installed,
      to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL AS uuid_available`)).rows[0])
      .toEqual({ installed: true, uuid_available: true })
    await adminPool.query(`CREATE SCHEMA "${SCHEMA}"`)
    const options = `-c search_path=${SCHEMA},pg_catalog`
    pool = new Pool({ connectionString: dbUrl, options, max: 12 })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl, options, max: 1 }) }) })
    await migrationDb.transaction().execute(async (trx) => {
      await upUsers(trx)
      await upDirectory(trx)
      await upDirectoryParentKeys(trx)
      await upEndpoints(trx)
      await up(trx)
    })
    deps = {
      db: pool,
      transaction: async (fn) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const value = await fn(client)
          await client.query('COMMIT')
          return value
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally { client.release() }
      },
    }
  })

  beforeEach(async () => {
    expect((await query('SELECT current_schema() AS schema')).rows[0].schema).toBe(SCHEMA)
    const present = await query(`SELECT to_regclass('${EVIDENCE}') IS NOT NULL AS e, to_regclass('${SENDS}') IS NOT NULL AS s`)
    if (!present.rows[0].e || !present.rows[0].s) await migrationDb.transaction().execute(up)
  })

  afterEach(async () => {
    await query(`DELETE FROM ${SENDS} WHERE org_id LIKE $1`, [`${PREFIX}%`])
    await query(`DELETE FROM ${EVIDENCE} WHERE connection_id = ANY($1::uuid[])`, [connectionIds])
    await query('DELETE FROM user_notification_endpoints WHERE org_id LIKE $1', [`${PREFIX}%`])
    await query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [connectionIds])
    connectionIds.length = 0
  })

  afterAll(async () => {
    await migrationDb?.destroy()
    await pool?.end()
    if (adminPool) {
      const tables = [
        SENDS, EVIDENCE, 'user_notification_preferences', 'user_notification_endpoints',
        'provider_org_transfer_decisions', 'provider_org_transfers', 'directory_sync_runs',
        'directory_account_links', 'directory_account_departments', 'directory_accounts',
        'directory_departments', 'directory_integrations', 'users',
      ]
      try {
        await adminPool.query(`DROP TABLE IF EXISTS ${tables.map((table) => `"${SCHEMA}"."${table}"`).join(', ')}`)
        await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}"`)
      } finally { await adminPool.end() }
    }
  })

  it('evidence upsert replaces the previous run and expires exactly at thirty days', async () => {
    const { connectionId } = await integration()
    const now = new Date()
    expect(await verify(connectionId)).toMatchObject({ ok: false, code: 'verification_missing' })
    await evidence(connectionId, 'send', undefined, now)
    expect(await verify(connectionId, { now })).toMatchObject({ ok: true, verification: { level: 'send', valid: true } })
    await evidence(connectionId, 'token', 'send', now)
    expect(await verify(connectionId, { now })).toMatchObject({ ok: true, verification: { level: 'token' } })
    const until = new Date(now.getTime() + 30 * 86400000)
    expect(await verify(connectionId, { now: new Date(until.getTime() - 1) })).toMatchObject({ ok: true })
    expect(await verify(connectionId, { now: until })).toMatchObject({ ok: false, code: 'verification_stale' })
    expect((await query(`SELECT revision FROM ${EVIDENCE} WHERE connection_id=$1`, [connectionId])).rows[0].revision).toBe('2')
  })

  it('token failures invalidate prior send evidence by failure level, and later success clears invalidation', async () => {
    const { connectionId } = await integration()
    await evidence(connectionId)
    await evidence(connectionId, 'config', 'token')
    expect(await verify(connectionId)).toMatchObject({ ok: false, code: 'verification_invalidated' })
    await evidence(connectionId, 'token')
    await evidence(connectionId, 'none', 'send')
    expect(await verify(connectionId)).toMatchObject({ ok: true, verification: { level: 'token' } })
    await evidence(connectionId, 'config', 'config')
    expect(await verify(connectionId)).toMatchObject({ ok: false, code: 'verification_invalidated' })
  })

  it('scope or tuple changes refuse persisted evidence without disclosing the fingerprint', async () => {
    const { connectionId } = await integration()
    await evidence(connectionId)
    for (const changed of [{ tenant: 'OtherCorp', appScope: scope.appScope }, { tenant: scope.tenant, appScope: 'OtherApp' }]) {
      expect(await verify(connectionId, { scope: changed })).toMatchObject({ ok: false, code: 'verification_anchor_changed' })
    }
    for (const field of ['agentId', 'baseUrl', 'appSecret']) {
      const result = await verify(connectionId, { tupleFingerprint: sha(`changed-${field}`) })
      expect(result).toMatchObject({ ok: false, code: 'verification_fingerprint_changed' })
      expect(JSON.stringify(result)).not.toContain(fingerprint)
    }
    const rows = await query(`SELECT * FROM ${EVIDENCE} WHERE connection_id=$1`, [connectionId])
    expect(JSON.stringify(rows.rows)).not.toContain('synthetic-credential-tuple')
  })

  it('same-key replay is durable and calls the adapter exactly once', async () => {
    const row = await endpoint()
    const { service, calls, prepare } = sender([row])
    const input = { ...row, idempotencyKey: randomUUID() }
    const first = await service.send(input)
    expect(first.outcome).toBe('accepted')
    expect(await service.send(input)).toEqual(first)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    const stored = (await query(`SELECT * FROM ${SENDS} WHERE id=$1`, [first.testSendId])).rows[0]
    expect(stored.state).toBe('accepted')
    expect(JSON.stringify([first, stored])).not.toMatch(/synthetic-address-never-persist|synthetic-credential-tuple/)
  })

  it('same-organization users independently send and replay the same idempotency key', async () => {
    const connection = await integration()
    const rows = [await endpoint(connection), await endpoint(connection)]
    const idempotencyKey = randomUUID()
    const { service, calls, prepare } = sender(rows)
    const first = await service.send({ ...rows[0], idempotencyKey })
    const second = await service.send({ ...rows[1], idempotencyKey })
    expect(first.outcome).toBe('accepted')
    expect(second.outcome).toBe('accepted')
    expect(second.testSendId).not.toBe(first.testSendId)
    for (const [index, row] of rows.entries()) {
      expect(await service.send({ ...row, idempotencyKey })).toEqual([first, second][index])
    }
    expect(calls).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect((await query(`SELECT user_id, id::text AS id FROM ${SENDS}
      WHERE org_id=$1 AND idempotency_key=$2 ORDER BY user_id`, [connection.orgId, idempotencyKey])).rows)
      .toEqual(rows.map((row, index) => ({ user_id: row.userId, id: [first, second][index].testSendId }))
        .sort((a, b) => a.user_id.localeCompare(b.user_id)))
  })

  it('concurrent requests for one endpoint never exceed one send per minute', async () => {
    const row = await endpoint()
    const { service, calls, prepare } = sender([row])
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.send({ ...row, idempotencyKey: randomUUID() })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expectRateLimitedLosers(results, 7)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect((await query(`SELECT count(*)::integer AS n FROM ${SENDS} WHERE endpoint_id=$1`, [row.endpointId])).rows[0].n).toBe(1)
  })

  it('user and connection hour limits include outcome_unknown and serialize distinct users on one connection', async () => {
    const row = await endpoint()
    for (let i = 0; i < 5; i++) await ledger(row, {
      state: 'outcome_unknown', outcome_code: 'test_send_interrupted',
      created_at: new Date(Date.now() - 120000), finished_at: new Date(),
    })
    const limited = sender([row])
    await expect(limited.service.send({ ...row, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 429, code: 'TEST_SEND_RATE_LIMITED' })
    expect(limited.calls).not.toHaveBeenCalled()
    expect(limited.prepare).not.toHaveBeenCalled()
    expect((await query(`SELECT count(*)::integer AS n FROM ${SENDS} WHERE endpoint_id=$1`, [row.endpointId])).rows[0].n).toBe(5)

    const connection = await integration()
    const seed = await endpoint(connection)
    for (let i = 0; i < 59; i++) await ledger(seed, {
      state: 'accepted', outcome_code: 'test_send_accepted',
      created_at: new Date(Date.now() - 120000), finished_at: new Date(),
    })
    const rows = await Promise.all(Array.from({ length: 6 }, () => endpoint(connection)))
    const concurrent = sender(rows)
    const results = await withBlockedConnection(connection.connectionId,
      rows.map((item) => () => concurrent.service.send({ ...item, idempotencyKey: randomUUID() })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expectRateLimitedLosers(results, 5)
    expect(concurrent.calls).toHaveBeenCalledTimes(1)
    expect(concurrent.prepare).toHaveBeenCalledTimes(1)
    expect((await query(`SELECT count(*)::integer AS n FROM ${SENDS} WHERE connection_id=$1`, [connection.connectionId])).rows[0].n).toBe(60)
  })

  it.each([{ limit: 'hourly', prior: 4 }, { limit: 'in-flight', prior: 0 }])(
    'serializes same-user cross-connection admissions at the $limit limit', async ({ prior }) => {
      const rows = await crossConnectionEndpoints()
      for (let i = 0; i < prior; i++) await ledger(rows[i % 2], {
        state: 'accepted', outcome_code: 'accepted',
        created_at: new Date(Date.now() - 120000), finished_at: new Date(),
      })
      const latch = () => {
        let resolve!: () => void
        const promise = new Promise<void>((done) => { resolve = done })
        return { promise, resolve }
      }
      const firstAtLimits = latch()
      const releaseAdmissions = latch()
      const firstFinished = latch()
      const secondAdmitted = latch()
      const releasePrepare = latch()
      const pids: number[] = []
      let transactions = 0
      let secondAtLimits = false
      let serialized = false
      const transaction: NotificationDbDeps['transaction'] = async (work) => {
        const index = transactions++
        const client = await pool.connect()
        try {
          pids[index] = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          await client.query('BEGIN')
          const result = await work({ query: async (text, values) => {
            const limits = text.includes('AS retry_after FROM (')
            // In the serialized hourly case, make the winner terminal before the loser counts:
            // the rejection must come from five per hour, not the pending-row limit.
            if (limits && index === 1 && serialized && prior === 4) await firstFinished.promise
            const result = await client.query(text, values)
            if (limits) {
              if (index === 0) firstAtLimits.resolve()
              else secondAtLimits = true
              await releaseAdmissions.promise
            }
            return result
          } })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
          if (index === 1) secondAdmitted.resolve()
        }
      }
      const concurrent = sender(rows, { transaction })
      if (prior === 0) concurrent.prepare.mockImplementation(async () => {
        await releasePrepare.promise
        return { ok: true as const, send: concurrent.calls }
      })
      const first = concurrent.service.send({ ...rows[0], idempotencyKey: randomUUID() })
      void first.then(firstFinished.resolve, firstFinished.resolve)
      const pending = [first]
      try {
        await Promise.race([firstAtLimits.promise, first.then(() => { throw new Error('first admission bypassed limits') })])
        pending.push(concurrent.service.send({ ...rows[1], idempotencyKey: randomUUID() }))
        const settled = Promise.allSettled(pending)
        // Observe real lock contention. If both user locks are removed, wait until both real
        // SELECTs have read the same ledger before either INSERT can run; no timing-only race.
        const deadline = Date.now() + 3500
        while (!secondAtLimits && Date.now() < deadline) {
          if (pids[1]) serialized = (await query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS waiting', [pids[1], pids[0]])).rows[0].waiting
          if (serialized) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(serialized || secondAtLimits).toBe(true)
        expect(pids[1]).not.toBe(pids[0])
        releaseAdmissions.resolve()
        await secondAdmitted.promise
        releasePrepare.resolve()
        const results = await settled
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expectRateLimitedLosers(results, 1)
        expect(concurrent.prepare).toHaveBeenCalledTimes(1)
        expect(concurrent.calls).toHaveBeenCalledTimes(1)
        expect((await query(`SELECT count(*)::integer AS n FROM ${SENDS}
          WHERE org_id=$1 AND user_id=$2`, [rows[0].orgId, rows[0].userId])).rows[0].n).toBe(prior + 1)
      } finally {
        releaseAdmissions.resolve()
        releasePrepare.resolve()
        await Promise.allSettled(pending)
      }
    },
  )

  it('a thirty-second pending row blocks the same user on another enterprise connection', async () => {
    const rows = await crossConnectionEndpoints()
    const pending = await ledger(rows[0], { state: 'pending', created_at: new Date(Date.now() - 30000), sending_at: null })
    const { service, calls, prepare } = sender(rows)
    await expect(service.send({ ...rows[1], idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 429, code: 'TEST_SEND_RATE_LIMITED' })
    expect(calls).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect((await query(`SELECT id::text AS id,state,sending_at,finished_at FROM ${SENDS} WHERE org_id=$1`, [rows[0].orgId])).rows)
      .toEqual([{ id: pending.rows[0].id, state: 'pending', sending_at: null, finished_at: null }])
  })

  it('a hundred-second pending row expires and admits the same user on another enterprise connection', async () => {
    const rows = await crossConnectionEndpoints()
    const pending = await ledger(rows[0], { state: 'pending', created_at: new Date(Date.now() - 100000), sending_at: null })
    const { service, calls, prepare } = sender(rows)
    expect(await service.send({ ...rows[1], idempotencyKey: randomUUID() })).toMatchObject({ outcome: 'accepted' })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect((await query(`SELECT state,outcome_code,sending_at,finished_at IS NOT NULL AS finished
      FROM ${SENDS} WHERE id=$1`, [pending.rows[0].id])).rows[0])
      .toEqual({ state: 'outcome_unknown', outcome_code: 'test_send_interrupted', sending_at: null, finished: true })
    expect((await query(`SELECT count(*)::integer AS n FROM ${SENDS} WHERE org_id=$1`, [rows[0].orgId])).rows[0].n).toBe(2)
  })

  it('interrupted sending is not replayed, and an old in-flight row does not block a new key forever', async () => {
    const row = await endpoint()
    const key = randomUUID()
    await ledger(row, { idempotency_key: key, state: 'sending', sending_at: new Date(Date.now() - 100000), created_at: new Date(Date.now() - 100000) })
    const { service, calls, prepare } = sender([row])
    expect(await service.send({ ...row, idempotencyKey: key })).toMatchObject({ outcome: 'outcome_unknown', code: 'test_send_interrupted' })
    expect(calls).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(await service.send({ ...row, idempotencyKey: randomUUID() })).toMatchObject({ outcome: 'accepted' })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    const old = (await query(`SELECT state,outcome_code FROM ${SENDS} WHERE idempotency_key=$1`, [key])).rows[0]
    expect(old).toEqual({ state: 'outcome_unknown', outcome_code: 'test_send_interrupted' })
  })

  it('a different key ages out an abandoned send, while a recent in-flight send still blocks admission', async () => {
    const abandoned = await endpoint()
    const oldKey = randomUUID()
    await ledger(abandoned, {
      idempotency_key: oldKey, state: 'sending', sending_at: new Date(Date.now() - 100000),
      created_at: new Date(Date.now() - 100000),
    })
    const recovery = sender([abandoned])
    expect(await recovery.service.send({ ...abandoned, idempotencyKey: randomUUID() })).toMatchObject({ outcome: 'accepted' })
    expect(recovery.calls).toHaveBeenCalledTimes(1)
    expect(recovery.prepare).toHaveBeenCalledTimes(1)
    const expired = (await query(`SELECT state,outcome_code FROM ${SENDS} WHERE idempotency_key=$1`, [oldKey])).rows[0]
    expect(expired).toEqual({ state: 'outcome_unknown', outcome_code: 'test_send_interrupted' })

    const recent = await endpoint()
    await ledger(recent, { state: 'sending', created_at: new Date(Date.now() - 80000), sending_at: new Date(Date.now() - 80000) })
    const blocked = sender([recent])
    await expect(blocked.service.send({ ...recent, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 429, code: 'TEST_SEND_RATE_LIMITED' })
    expect(blocked.calls).not.toHaveBeenCalled()
    expect(blocked.prepare).not.toHaveBeenCalled()
  })

  it.each(['enabled', 'readiness', 'endpointValid'] as const)('refuses %s failure with no adapter send', async (option) => {
    const row = await endpoint()
    const { service, calls, prepare } = sender([row], { [option]: false })
    await expect(service.send({ ...row, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 })
    expect(calls).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('closed states and levels, sending timestamp, terminal code and endpoint connection are enforced by PostgreSQL', async () => {
    const row = await endpoint()
    for (const [columns, constraint] of [
      [{ state: 'unexpected', finished_at: new Date(), outcome_code: 'unexpected' }, 'nts_state_chk'],
      [{ state: 'sending' }, 'nts_sending_at_chk'],
      [{ state: 'failed', finished_at: new Date() }, 'nts_terminal_code_chk'],
    ] as const) {
      await expect(ledger(row, columns)).rejects.toMatchObject({ code: '23514', constraint })
    }
    const other = await integration(row.orgId)
    await expect(ledger(row, { connection_id: other.connectionId })).rejects.toMatchObject({ code: '23503', constraint: 'nts_endpoint_conn_fk' })
    await evidence(row.connectionId)
    await expect(query(`UPDATE ${EVIDENCE} SET reached_level='unexpected' WHERE connection_id=$1`, [row.connectionId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ncv_level_chk' })
    await expect(query(`UPDATE ${EVIDENCE} SET tuple_fingerprint='not-a-hash' WHERE connection_id=$1`, [row.connectionId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ncv_fp_chk' })
  })

  it('C-1 accepts only the exact negative and fractional business-code grammar', async () => {
    const row = await endpoint()
    for (const code of ['dingtalk_business_error_-1', 'dingtalk_business_error_1.5', 'dingtalk_business_error_-1.5']) {
      const inserted = await ledger(row, { state: 'failed', outcome_code: code, finished_at: new Date() })
      expect(inserted).toBeDefined()
    }
    for (const code of ['other_-1', 'other_1.5', 'dingtalk_business_error_+1', 'dingtalk_business_error_.5',
      'dingtalk_business_error_1.', 'dingtalk_business_error_-1: detail', 'dingtalk_business_error_1e-3',
      'dingtalk_business_error_-1\n', 'dingtalk_business_error_--1', 'dingtalk_business_error_-1.2.3', 'BAD_CODE']) {
      await expect(ledger(row, { state: 'failed', outcome_code: code, finished_at: new Date() }))
        .rejects.toMatchObject({ code: '23514', constraint: 'nts_code_chk' })
    }
  })

  it('C-1 accepts 64-character fixed and business codes and rejects their 65-character counterparts', async () => {
    const row = await endpoint()
    const prefix = 'dingtalk_business_error_'
    for (const code of [
      'a'.repeat(64),
      `${prefix}-${'1'.repeat(64 - prefix.length - 1)}`,
      `${prefix}${'1'.repeat(64 - prefix.length - 2)}.5`,
      `${prefix}-${'1'.repeat(64 - prefix.length - 3)}.5`,
    ]) {
      expect(code).toHaveLength(64)
      const accepted = await ledger(row, { state: 'failed', outcome_code: code, finished_at: new Date() })
      expect((await query(`SELECT outcome_code FROM ${SENDS} WHERE id=$1`, [accepted.rows[0].id])).rows[0].outcome_code).toBe(code)
      await expect(ledger(row, { state: 'failed', outcome_code: `${code}1`, finished_at: new Date() }))
        .rejects.toMatchObject({ code: '23514', constraint: 'nts_code_chk' })
    }
  })

  it('down refuses persisted evidence or sends without removing either table', async () => {
    const row = await endpoint()
    await evidence(row.connectionId)
    await expect(migrationDb.transaction().execute(down)).rejects.toMatchObject({ code: NOTIFICATION_SEND_DOWN_BLOCKED_CODE })
    await query(`DELETE FROM ${EVIDENCE} WHERE connection_id=$1`, [row.connectionId])
    await ledger(row)
    await expect(migrationDb.transaction().execute(down)).rejects.toMatchObject({ code: NOTIFICATION_SEND_DOWN_BLOCKED_CODE })
    expect((await query(`SELECT count(*) FROM ${SENDS} WHERE endpoint_id=$1`, [row.endpointId])).rows[0].count).toBe('1')
  })

  it('up and down restore both transaction timeouts', async () => {
    const rollback = new Error('rollback fixture')
    await expect(migrationDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout','7s',true), set_config('statement_timeout','42s',true)`.execute(trx)
      for (const migration of [down, up]) {
        await migration(trx)
        const settings = await sql<{ l: string; s: string }>`SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s`.execute(trx)
        expect(settings.rows).toEqual([{ l: '7s', s: '42s' }])
      }
      throw rollback
    })).rejects.toBe(rollback)
  })

  it('pins every constraint and index of the evidence and ledger tables', async () => {
    for (const [table, expectedConstraints, expectedIndexes] of [
      [EVIDENCE, EVIDENCE_CONSTRAINTS, EVIDENCE_INDEXES],
      [SENDS, LEDGER_CONSTRAINTS, LEDGER_INDEXES],
    ] as const) {
      const constraints = await query(`SELECT conname AS n, pg_get_constraintdef(oid) AS d
        FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`, [table])
      const indexes = await query(`SELECT indexname AS n, indexdef AS d FROM pg_indexes
        WHERE schemaname=$2 AND tablename=$1 ORDER BY indexname`, [table, SCHEMA])
      expect(constraints.rows.map((row) => [row.n, row.d])).toEqual(expectedConstraints)
      expect(indexes.rows.map((row) => [row.n, row.d])).toEqual(expectedIndexes.map(([name, definition]) => [name, definition.replace(' ON public.', ` ON ${SCHEMA}.`)]))
    }
  })
})
