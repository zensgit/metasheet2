import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up as createAttendanceNotificationDeliveries } from '../../src/db/migrations/zzzz20260611120000_create_attendance_notification_deliveries'
import { up as addOutcomeUnknownDeliveryStatus } from '../../src/db/migrations/zzzz20260710150000_add_outcome_unknown_delivery_status'
// markFailed always writes redelivery_safe (PR #4102), so every isolated-schema harness below that
// runs the worker must chain this follow-up migration after the create — mirroring the full stack.
import { up as addRedeliverySafe } from '../../src/db/migrations/zzzz20260711120000_add_redelivery_safe_to_attendance_notification_deliveries'
import {
  AttendanceNotificationDeliveryWorker,
  buildAttendanceNotificationDeepLink,
  DeterministicFakeAttendanceDeliveryChannel,
  DingTalkAttendanceDeliveryChannel,
  EmailAttendanceDeliveryChannel,
  WeComAttendanceDeliveryChannel,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import { sendDingTalkWorkNotification, type DingTalkMessageConfig } from '../../src/integrations/dingtalk/client'
import type { WeComMessageConfig } from '../../src/integrations/wecom/client'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

async function requireTable(pool: Pool, tableName: string): Promise<void> {
  const tableCheck = await pool.query(`SELECT to_regclass(current_schema() || '.' || $1) AS name`, [tableName])
  if (!tableCheck.rows[0]?.name) {
    throw new Error(`Integration database is missing ${tableName}; run core-backend migrations before executing this suite.`)
  }
}

function createIsolatedSchemaName(): string {
  return `attendance_c5_outbox_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function withSearchPath(connectionString: string, schemaName: string): string {
  const url = new URL(connectionString)
  const existingOptions = url.searchParams.get('options')
  const schemaOption = `-c search_path=${schemaName}`
  url.searchParams.set('options', existingOptions ? `${existingOptions} ${schemaOption}` : schemaOption)
  return url.toString()
}

async function createSchema(connectionString: string, schemaName: string): Promise<void> {
  const adminPool = new Pool({ connectionString })
  try {
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  } finally {
    await adminPool.end()
  }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  const adminPool = new Pool({ connectionString })
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  } finally {
    await adminPool.end()
  }
}

async function tableExistsInPublic(connectionString: string, tableName: string): Promise<boolean> {
  const adminPool = new Pool({ connectionString })
  try {
    const result = await adminPool.query(`SELECT to_regclass($1) AS name`, [`public.${tableName}`])
    return Boolean(result.rows[0]?.name)
  } finally {
    await adminPool.end()
  }
}

function createTestDb(connectionString: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  })
}

describeIfDatabase('Attendance C5 notification delivery outbox', () => {
  let schemaName = ''
  let isolatedDbUrl = ''
  let testDb: Kysely<unknown> | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    if (await tableExistsInPublic(dbUrl, 'attendance_notification_deliveries')) {
      // CI runs the full migration stack before the attendance integration step. In that case, test
      // the real public table so the dedicated gate proves the actual migration output.
      pool = new Pool({ connectionString: dbUrl })
      return
    }

    // Local dev databases are often stale or partially migrated. Fall back to an isolated schema and
    // execute only the C5-0 migration so the DB-level invariants still get real Postgres coverage.
    schemaName = createIsolatedSchemaName()
    await createSchema(dbUrl, schemaName)
    isolatedDbUrl = withSearchPath(dbUrl, schemaName)
    testDb = createTestDb(isolatedDbUrl)
    pool = new Pool({ connectionString: isolatedDbUrl })
    await createAttendanceNotificationDeliveries(testDb)
    await addRedeliverySafe(testDb)
  })

  afterAll(async () => {
    if (testDb) await testDb.destroy()
    if (pool) await pool.end()
    if (schemaName && dbUrl) await dropSchema(dbUrl, schemaName)
  })

  it('C5-0 notification delivery outbox — source_key uniqueness + status invariants are DB-enforced (latent schema)', async () => {
    if (!pool) throw new Error('C5 outbox test pool was not initialized')
    const runSuffix = Date.now().toString(36)
    const orgId = `c5-outbox-${runSuffix}`
    const sourceId = randomUUID()
    const subjectUserId = `c5-subject-${runSuffix}`
    const ownerUserId = `c5-owner-${runSuffix}`
    const sourceInstanceKey = `comp_time_expiry_reminder:${sourceId}:2026-06-15`
    const subjectKey = `${sourceInstanceKey}:recipient:${subjectUserId}:channel:fake`
    const ownerKey = `${sourceInstanceKey}:recipient:${ownerUserId}:channel:fake`
    const rejects = async (text: string, params: unknown[], code: string, label: string) => {
      let err: { code?: string } | null = null
      try { await pool.query(text, params) } catch (e) { err = e as { code?: string } }
      expect({ label, code: err?.code }).toEqual({ label, code })
    }
    try {
      await requireTable(pool, 'attendance_notification_deliveries')

      const insert = `INSERT INTO attendance_notification_deliveries
        (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, payload)
        VALUES ($1, 'comp_time_expiry_reminder', $2, $3, $4, $5, 'fake', $6, $7::jsonb)
        RETURNING id`

      const subject = await pool.query(insert, [orgId, sourceId, subjectKey, subjectUserId, 'subject', 'pending', JSON.stringify({ recipientRoles: ['subject'] })])
      expect(subject.rows[0]?.id).toBeTruthy()

      // One delivery row per recipient/channel: the same source instance may fan out to an owner with a
      // distinct delivery source_key. This would collide if the key only used balance/window.
      const owner = await pool.query(insert, [orgId, sourceId, ownerKey, ownerUserId, 'owner', 'pending', JSON.stringify({ recipientRoles: ['owner'] })])
      expect(owner.rows[0]?.id).toBeTruthy()

      // Idempotency backstop: exact same (org_id, source_key) cannot create another row.
      await rejects(insert, [orgId, sourceId, subjectKey, subjectUserId, 'subject', 'pending', '{}'], '23505', 'source_key unique')

      await rejects(insert, [orgId, `${sourceId}-status`, `${subjectKey}:bad-status`, `${subjectUserId}-s`, 'subject', 'bogus', '{}'], '23514', 'status enum')
      await rejects(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, attempt_count)
         VALUES ($1, 'unscheduled_reminder', $2, $3, $4, 'subject', 'fake', -1)`,
        [orgId, `${sourceId}-attempts`, `${subjectKey}:attempts`, `${subjectUserId}-a`],
        '23514',
        'attempt_count non-negative',
      )
      await rejects(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, delivered_at)
         VALUES ($1, 'unscheduled_reminder', $2, $3, $4, 'subject', 'fake', 'pending', now())`,
        [orgId, `${sourceId}-delivered`, `${subjectKey}:delivered`, `${subjectUserId}-d`],
        '23514',
        'delivered_at only when sent',
      )

      const sent = await pool.query(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, delivered_at)
         VALUES ($1, 'unscheduled_reminder', $2, $3, $4, 'subject', 'fake', 'sent', now())
         RETURNING id`,
        [orgId, `${sourceId}-sent`, `${subjectKey}:sent`, `${subjectUserId}-sent`],
      )
      expect(sent.rows[0]?.id).toBeTruthy()

      const sending = await pool.query(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, claimed_at, claim_expires_at, claim_worker_id)
         VALUES ($1, 'unscheduled_reminder', $2, $3, $4, 'subject', 'fake', 'sending', now(), now() - interval '1 minute', 'worker-a')
         RETURNING id, claim_expires_at`,
        [orgId, `${sourceId}-sending`, `${subjectKey}:sending`, `${subjectUserId}-sending`],
      )
      expect(sending.rows[0]?.id).toBeTruthy()
      expect(sending.rows[0]?.claim_expires_at).toBeTruthy()

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'attendance_notification_deliveries'
            AND indexname = ANY($1::text[])`,
        [[
          'uq_attendance_notification_deliveries_source_key',
          'idx_attendance_notification_deliveries_claim',
          'idx_attendance_notification_deliveries_reclaim',
          'idx_attendance_notification_deliveries_source',
        ]],
      )
      expect(new Set(indexes.rows.map(row => row.indexname))).toEqual(new Set([
        'uq_attendance_notification_deliveries_source_key',
        'idx_attendance_notification_deliveries_claim',
        'idx_attendance_notification_deliveries_reclaim',
        'idx_attendance_notification_deliveries_source',
      ]))
    } finally {
      await pool.query('DELETE FROM attendance_notification_deliveries WHERE org_id = $1', [orgId]).catch(() => undefined)
    }
  })

  it('C5-2 delivery worker claims due rows, sends via fake channel, retries/fails visibly, reclaims stale sending, and does not repeat sent rows', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const workerSchemaName = createIsolatedSchemaName()
    await createSchema(dbUrl, workerSchemaName)
    const workerDbUrl = withSearchPath(dbUrl, workerSchemaName)
    const workerDb = createTestDb(workerDbUrl)
    const workerPool = new Pool({ connectionString: workerDbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `c5-worker-${runSuffix}`
    const fixedNow = new Date('2026-08-01T00:00:00.000Z')
    const liveLease = new Date('2026-08-01T00:10:00.000Z').toISOString()
    const pastLease = new Date('2026-07-31T23:00:00.000Z').toISOString()
    const sourceId = randomUUID()
    const insertDelivery = async (label: string, overrides: Record<string, unknown> = {}) => {
      const status = String(overrides.status ?? 'pending')
      const channel = String(overrides.channel ?? 'dingtalk_work_notification')
      const attemptCount = Number(overrides.attemptCount ?? 0)
      const payload = overrides.payload ?? {}
      const claimedAt = overrides.claimedAt ?? null
      const claimExpiresAt = overrides.claimExpiresAt ?? null
      const claimWorkerId = overrides.claimWorkerId ?? null
      const deliveredAt = overrides.deliveredAt ?? null
      const result = await workerPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status,
            attempt_count, claimed_at, claim_expires_at, claim_worker_id, delivered_at, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject',$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11::timestamptz,$12::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `worker:${runSuffix}:${label}`,
          `u-${label}-${runSuffix}`,
          channel,
          status,
          attemptCount,
          claimedAt,
          claimExpiresAt,
          claimWorkerId,
          deliveredAt,
          JSON.stringify(payload),
        ],
      )
      return result.rows[0].id
    }
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await workerPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    try {
      await createAttendanceNotificationDeliveries(workerDb)
      await addRedeliverySafe(workerDb)
      await requireTable(workerPool, 'attendance_notification_deliveries')

      const okId = await insertDelivery('ok')
      const retryId = await insertDelivery('retry', { payload: { fakeDelivery: 'retry' } })
      const maxRetryId = await insertDelivery('maxretry', { attemptCount: 1, payload: { fakeDelivery: 'retry' } })
      const failId = await insertDelivery('fail', { payload: { fakeDelivery: 'fail' } })
      const skipId = await insertDelivery('skip', { payload: { fakeDelivery: 'skip' } })
      const missingChannelId = await insertDelivery('missing-channel', { channel: 'unknown_channel' })
      const staleSendingId = await insertDelivery('stale-sending', {
        status: 'sending',
        attemptCount: 1,
        claimedAt: pastLease,
        claimExpiresAt: pastLease,
        claimWorkerId: 'old-worker',
      })
      const liveSendingId = await insertDelivery('live-sending', {
        status: 'sending',
        attemptCount: 1,
        claimedAt: fixedNow.toISOString(),
        claimExpiresAt: liveLease,
        claimWorkerId: 'live-worker',
      })
      const alreadySentId = await insertDelivery('sent', {
        status: 'sent',
        deliveredAt: fixedNow.toISOString(),
      })

      const worker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [new DeterministicFakeAttendanceDeliveryChannel()],
        now: () => fixedNow,
        leaseMs: 60_000,
        maxAttempts: 2,
        workerId: 'worker-test',
      })

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 7, sent: 2, retrying: 1, failed: 3, skipped: 1 })

      const row = async (id: string) => (await workerPool.query(
        `SELECT status, attempt_count, delivered_at, next_attempt_at, last_error, claim_expires_at, claim_worker_id
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [id],
      )).rows[0]

      expect(await row(okId)).toMatchObject({
        status: 'sent',
        attempt_count: 1,
        last_error: null,
        claim_expires_at: null,
        claim_worker_id: null,
      })
      expect((await row(okId)).delivered_at).toBeTruthy()
      expect(await row(staleSendingId)).toMatchObject({
        status: 'sent',
        attempt_count: 2,
        last_error: null,
        claim_expires_at: null,
        claim_worker_id: null,
      })
      const retry = await row(retryId)
      expect(retry).toMatchObject({
        status: 'retrying',
        attempt_count: 1,
        last_error: 'fake_retryable_failure',
        claim_expires_at: null,
        claim_worker_id: null,
      })
      expect(new Date(retry.next_attempt_at).getTime()).toBeGreaterThan(fixedNow.getTime())
      expect(await row(maxRetryId)).toMatchObject({
        status: 'failed',
        attempt_count: 2,
        last_error: 'fake_retryable_failure',
        claim_expires_at: null,
        claim_worker_id: null,
      })
      expect(await row(failId)).toMatchObject({
        status: 'failed',
        attempt_count: 1,
        last_error: 'fake_non_retryable_failure',
        claim_expires_at: null,
        claim_worker_id: null,
      })
      // The structurally-undeliverable (skip: true) row lands `skipped`, not `failed` — and it must NOT
      // have been counted toward the `failed` bucket in the runBatch() result asserted above.
      expect(await row(skipId)).toMatchObject({
        status: 'skipped',
        attempt_count: 1,
        last_error: 'fake_structural_skip',
        claim_expires_at: null,
        claim_worker_id: null,
      })
      expect(await row(missingChannelId)).toMatchObject({
        status: 'failed',
        attempt_count: 1,
        last_error: 'attendance_delivery_channel_not_configured',
        claim_expires_at: null,
        claim_worker_id: null,
      })
      expect(await row(liveSendingId)).toMatchObject({
        status: 'sending',
        attempt_count: 1,
        claim_worker_id: 'live-worker',
      })
      expect(await row(alreadySentId)).toMatchObject({
        status: 'sent',
        attempt_count: 0,
      })

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 })
      expect(await row(okId)).toMatchObject({ status: 'sent', attempt_count: 1 })
      expect(await row(retryId)).toMatchObject({ status: 'retrying', attempt_count: 1 })
    } finally {
      await workerPool.end().catch(() => undefined)
      await workerDb.destroy().catch(() => undefined)
      await dropSchema(dbUrl, workerSchemaName).catch(() => undefined)
    }
  })

  it('C5-2 delivery worker does not let an expired lease owner overwrite a reclaimed worker result', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const workerSchemaName = createIsolatedSchemaName()
    await createSchema(dbUrl, workerSchemaName)
    const workerDbUrl = withSearchPath(dbUrl, workerSchemaName)
    const workerDb = createTestDb(workerDbUrl)
    const workerPool = new Pool({ connectionString: workerDbUrl })
    const orgId = `c5-worker-lease-${Date.now().toString(36)}`
    const sourceId = randomUUID()
    const claimNow = new Date('2026-08-01T00:00:00.000Z')
    const reclaimNow = new Date('2026-08-01T00:00:10.000Z')
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await workerPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    try {
      await createAttendanceNotificationDeliveries(workerDb)
      await addRedeliverySafe(workerDb)
      await requireTable(workerPool, 'attendance_notification_deliveries')
      const insert = await workerPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,'u-lease','subject','dingtalk_work_notification',$4::jsonb)
         RETURNING id::text AS id`,
        [orgId, sourceId, `lease-race:${sourceId}`, JSON.stringify({ fakeDelivery: 'retry' })],
      )
      const deliveryId = insert.rows[0].id

      const workerB = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [new DeterministicFakeAttendanceDeliveryChannel()],
        now: () => reclaimNow,
        leaseMs: 60_000,
        workerId: 'worker-b',
      })
      const workerA = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [{
          name: 'dingtalk_work_notification',
          async send() {
            await expect(workerB.runBatch()).resolves.toEqual({ claimed: 1, sent: 0, retrying: 1, failed: 0, skipped: 0 })
            return { ok: true }
          },
        }],
        now: () => claimNow,
        leaseMs: 5_000,
        workerId: 'worker-a',
      })

      await expect(workerA.runBatch()).resolves.toEqual({ claimed: 1, sent: 0, retrying: 0, failed: 0, skipped: 0, lostLease: 1 })

      const row = (await workerPool.query(
        `SELECT status, attempt_count, delivered_at, last_error, claim_worker_id, claim_expires_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [deliveryId],
      )).rows[0]
      expect(row).toMatchObject({
        status: 'retrying',
        attempt_count: 2,
        delivered_at: null,
        last_error: 'fake_retryable_failure',
        claim_worker_id: null,
        claim_expires_at: null,
      })
    } finally {
      await workerPool.end().catch(() => undefined)
      await workerDb.destroy().catch(() => undefined)
      await dropSchema(dbUrl, workerSchemaName).catch(() => undefined)
    }
  })

  it('PR #4046 Phase B: an outcome-unknown DingTalk send terminates as outcome_unknown — zero retries, never re-claimed, never resent; an ordinary network error still retries', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const workerSchemaName = createIsolatedSchemaName()
    await createSchema(dbUrl, workerSchemaName)
    const workerDbUrl = withSearchPath(dbUrl, workerSchemaName)
    const workerDb = createTestDb(workerDbUrl)
    const workerPool = new Pool({ connectionString: workerDbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `c5-outcome-unknown-${runSuffix}`
    const sourceId = randomUUID()
    const firstNow = new Date('2026-08-01T00:00:00.000Z')
    // beyond computeDeliveryBackoffMs(1)=60s, so the retrying row is due again on batch 2
    const secondNow = new Date('2026-08-01T00:05:00.000Z')
    let now = firstNow
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await workerPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    // Per-recipient send attempts — the resend-hazard counter.
    const sendAttemptsByUser = new Map<string, number>()
    try {
      await createAttendanceNotificationDeliveries(workerDb)
      // the migration under test: widens the status CHECK by 'outcome_unknown'
      await addOutcomeUnknownDeliveryStatus(workerDb)
      // markFailed writes redelivery_safe on the definite-failure branch this test also exercises.
      await addRedeliverySafe(workerDb)
      await requireTable(workerPool, 'attendance_notification_deliveries')

      const insert = async (label: string) => (await workerPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','dingtalk_work_notification','{}'::jsonb)
         RETURNING id::text AS id`,
        [orgId, sourceId, `outcome-unknown:${runSuffix}:${label}`, `u-${label}`],
      )).rows[0].id
      const unknownId = await insert('unknown')
      const transientId = await insert('transient')

      // Real DingTalkAttendanceDeliveryChannel; recipient resolution stubbed (unit-style DI — the
      // directory JOIN is pinned elsewhere/C5-3), but the SEND for the outcome-unknown recipient
      // goes through the REAL client + transport with a fetch that rejects at network level, so
      // the outcome-unknown MARKING itself is the real transport behavior, not a hand-rolled flag.
      const channel = new DingTalkAttendanceDeliveryChannel({
        query: (async (sqlText: string, params?: unknown[]) => {
          if (sqlText.includes('directory_account_links')) {
            return { rows: [{ integration_id: 'integ-1', external_user_id: `dd_${String(params?.[0])}` }] }
          }
          return { rows: [{ org_has_active_integration: true }] }
        }) as never,
        readConfig: async () => ({ appKey: 'k', appSecret: 's', agentId: '42' }),
        fetchAccessToken: async () => 'tok',
        sendWorkNotification: async (accessToken, input, config) => {
          const target = input.userIds[0]
          sendAttemptsByUser.set(target, (sendAttemptsByUser.get(target) ?? 0) + 1)
          if (target === 'dd_u-unknown') {
            // network-level rejection → the real transport marks the rethrown error outcome-unknown
            return sendDingTalkWorkNotification(accessToken, input, config, {
              fetchFn: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
            })
          }
          // ordinary transient failure WITHOUT the marker — must keep retrying (pinned unchanged)
          throw new Error('ECONNRESET: transient blip')
        },
      })

      const worker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [channel],
        now: () => now,
        leaseMs: 60_000,
        maxAttempts: 5,
        workerId: 'worker-outcome-unknown',
      })

      await expect(worker.runBatch()).resolves.toEqual({
        claimed: 2, sent: 0, retrying: 1, failed: 0, skipped: 0, outcomeUnknown: 1,
      })

      const row = async (id: string) => (await workerPool.query(
        `SELECT status, attempt_count, delivered_at, last_error, claim_expires_at, claim_worker_id
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [id],
      )).rows[0]

      // Terminal distinct state against the REAL widened CHECK — not 'failed', lease released,
      // attempt budget NOT burned beyond the single attempt.
      expect(await row(unknownId)).toMatchObject({
        status: 'outcome_unknown',
        attempt_count: 1,
        delivered_at: null,
        claim_expires_at: null,
        claim_worker_id: null,
      })
      expect(String((await row(unknownId)).last_error)).toMatch(/^dingtalk_send_outcome_unknown: /)
      expect(await row(transientId)).toMatchObject({ status: 'retrying', attempt_count: 1 })

      // Next batch (past the retry backoff): the outcome_unknown row is NOT re-claimed and NOT
      // resent; the ordinary transient row IS retried (behavior pinned unchanged).
      now = secondNow
      await expect(worker.runBatch()).resolves.toEqual({
        claimed: 1, sent: 0, retrying: 1, failed: 0, skipped: 0,
      })
      expect(await row(unknownId)).toMatchObject({ status: 'outcome_unknown', attempt_count: 1 })
      expect(await row(transientId)).toMatchObject({ status: 'retrying', attempt_count: 2 })
      // The resend-hazard assertion: exactly ONE send ever reached the outcome-unknown recipient.
      expect(sendAttemptsByUser.get('dd_u-unknown')).toBe(1)
      expect(sendAttemptsByUser.get('dd_u-transient')).toBe(2)
    } finally {
      await workerPool.end().catch(() => undefined)
      await workerDb.destroy().catch(() => undefined)
      await dropSchema(dbUrl, workerSchemaName).catch(() => undefined)
    }
  })

  it('C5-3 real DingTalk channel resolves linked directory users (sent) and skips — not fails — an unbound recipient, without external network', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const publicPool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `c5-dingtalk-${runSuffix}`
    const localUserId = `u-c5-dingtalk-${runSuffix}`
    const unboundUserId = `u-c5-dingtalk-unbound-${runSuffix}`
    const integrationId = randomUUID()
    const directoryAccountId = randomUUID()
    const sourceId = randomUUID()
    let deliveryId = ''
    let unboundDeliveryId = ''
    const config: DingTalkMessageConfig = {
      appKey: 'dt-app-key',
      appSecret: 'dt-app-secret',
      agentId: '123456789',
      baseUrl: 'https://oapi.dingtalk.com',
    }
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await publicPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    const sentMessages: unknown[] = []

    try {
      await requireTable(publicPool, 'users')
      await requireTable(publicPool, 'directory_integrations')
      await requireTable(publicPool, 'directory_accounts')
      await requireTable(publicPool, 'directory_account_links')
      await requireTable(publicPool, 'attendance_notification_deliveries')

      await publicPool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1,$2,'hash',$3,'user',true)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
        [localUserId, `${localUserId}@example.test`, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
         VALUES ($1,$2,'dingtalk',$3,'active','corp-c5',$4::jsonb)`,
        [integrationId, orgId, `C5 DingTalk ${runSuffix}`, JSON.stringify({})],
      )
      await publicPool.query(
        `INSERT INTO directory_accounts
           (id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
         VALUES ($1,$2,'dingtalk','corp-c5','dt-user-c5','dt-key-c5',$3,true)`,
        [directoryAccountId, integrationId, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1,$2,'linked','manual')`,
        [directoryAccountId, localUserId],
      )
      const delivery = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','dingtalk_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `c5-dingtalk:${sourceId}:recipient:${localUserId}:channel:dingtalk_work_notification`,
          localUserId,
          JSON.stringify({ title: 'C5 DingTalk smoke', body: 'Please check the attendance reminder.' }),
        ],
      )
      deliveryId = delivery.rows[0].id

      // A second recipient with NO directory_account_links row at all — the ordinary "not onboarded to
      // DingTalk yet" gap for a partially-adopted org. This delivery must land `skipped`, not `failed`,
      // and must never reach readConfig/fetchAccessToken/sendWorkNotification (no channel identity to
      // resolve, so the real-network mocks below must not be invoked for this row).
      const unboundDelivery = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','dingtalk_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `c5-dingtalk:${sourceId}:recipient:${unboundUserId}:channel:dingtalk_work_notification`,
          unboundUserId,
          JSON.stringify({ title: 'C5 DingTalk smoke (unbound)', body: 'Should never send.' }),
        ],
      )
      unboundDeliveryId = unboundDelivery.rows[0].id

      const channel = new DingTalkAttendanceDeliveryChannel({
        query,
        readConfig: async (receivedIntegrationId) => {
          expect(receivedIntegrationId).toBe(integrationId)
          return config
        },
        fetchAccessToken: async (receivedConfig) => {
          expect(receivedConfig).toBe(config)
          return 'access-token'
        },
        sendWorkNotification: async (accessToken, input, receivedConfig) => {
          sentMessages.push({ accessToken, input, receivedConfig })
          return { taskId: 'task-c5', requestId: 'req-c5', raw: {} }
        },
      })
      const worker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [channel],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-c5-dingtalk',
      })

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 2, sent: 1, retrying: 0, failed: 0, skipped: 1 })

      // Only the linked recipient's row reached the network mocks — the unbound recipient never did.
      expect(sentMessages).toEqual([{
        accessToken: 'access-token',
        input: {
          userIds: ['dt-user-c5'],
          title: 'C5 DingTalk smoke',
          content: 'Please check the attendance reminder.',
        },
        receivedConfig: config,
      }])
      const row = (await publicPool.query(
        `SELECT status, delivered_at, last_error, attempt_count, claim_worker_id, claim_expires_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [deliveryId],
      )).rows[0]
      expect(row).toMatchObject({
        status: 'sent',
        last_error: null,
        attempt_count: 1,
        claim_worker_id: null,
        claim_expires_at: null,
      })
      expect(row.delivered_at).toBeTruthy()

      const unboundRow = (await publicPool.query(
        `SELECT status, delivered_at, last_error, attempt_count, claim_worker_id, claim_expires_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [unboundDeliveryId],
      )).rows[0]
      expect(unboundRow).toMatchObject({
        status: 'skipped',
        delivered_at: null,
        last_error: 'dingtalk_recipient_not_bound',
        attempt_count: 1,
        claim_worker_id: null,
        claim_expires_at: null,
      })
    } finally {
      if (deliveryId) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [deliveryId]).catch(() => undefined)
      }
      if (unboundDeliveryId) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [unboundDeliveryId]).catch(() => undefined)
      }
      await publicPool.query('DELETE FROM directory_account_links WHERE directory_account_id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_accounts WHERE id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_integrations WHERE id = $1', [integrationId]).catch(() => undefined)
      await publicPool.query('DELETE FROM users WHERE id = $1', [localUserId]).catch(() => undefined)
      await publicPool.end().catch(() => undefined)
    }
  })

  it('H1 (review #3920 P3-1): org has NO active integration (suspended, not absent) -> retryable failure lands `retrying`, NOT `skipped` — DingTalk + WeCom parity', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const publicPool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `h1-org-inactive-${runSuffix}`
    const dingTalkRecipientUserId = `u-h1-dingtalk-${runSuffix}`
    const weComRecipientUserId = `u-h1-wecom-${runSuffix}`
    const dingTalkIntegrationId = randomUUID()
    const weComIntegrationId = randomUUID()
    const dingTalkSourceId = randomUUID()
    const weComSourceId = randomUUID()
    let dingTalkDeliveryId = ''
    let weComDeliveryId = ''
    const dingTalkConfig: DingTalkMessageConfig = {
      appKey: 'dt-app-key',
      appSecret: 'dt-app-secret',
      agentId: '123456789',
      baseUrl: 'https://oapi.dingtalk.com',
    }
    const weComConfig: WeComMessageConfig = {
      corpId: 'we-corp-h1',
      corpSecret: 'we-corp-secret-h1',
      agentId: '1000002',
      baseUrl: 'https://qyapi.weixin.qq.com',
    }
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await publicPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    let dingTalkNetworkTouched = false
    let weComNetworkTouched = false

    try {
      await requireTable(publicPool, 'directory_integrations')
      await requireTable(publicPool, 'attendance_notification_deliveries')

      // Both integration rows EXIST for this org but are `suspended`, not `active` — proves the
      // EXISTS predicate filters on status, not mere row presence (stronger than an absent-row
      // fixture, which would pass even against a bug that only checks "any row"). No
      // directory_account_links row is created for either recipient (0-row cold path either way).
      await publicPool.query(
        `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
         VALUES ($1,$2,'dingtalk',$3,'suspended','corp-h1',$4::jsonb)`,
        [dingTalkIntegrationId, orgId, `H1 DingTalk suspended ${runSuffix}`, JSON.stringify({})],
      )
      await publicPool.query(
        `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
         VALUES ($1,$2,'wecom',$3,'suspended','we-corp-h1',$4::jsonb)`,
        [weComIntegrationId, orgId, `H1 WeCom suspended ${runSuffix}`, JSON.stringify({})],
      )

      const dingTalkDelivery = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','dingtalk_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          dingTalkSourceId,
          `h1-dingtalk:${dingTalkSourceId}:recipient:${dingTalkRecipientUserId}:channel:dingtalk_work_notification`,
          dingTalkRecipientUserId,
          JSON.stringify({ title: 'H1 DingTalk org-inactive', body: 'Should never send.' }),
        ],
      )
      dingTalkDeliveryId = dingTalkDelivery.rows[0].id

      const weComDelivery = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','wecom_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          weComSourceId,
          `h1-wecom:${weComSourceId}:recipient:${weComRecipientUserId}:channel:wecom_work_notification`,
          weComRecipientUserId,
          JSON.stringify({ title: 'H1 WeCom org-inactive', body: 'Should never send.' }),
        ],
      )
      weComDeliveryId = weComDelivery.rows[0].id

      const dingTalkChannel = new DingTalkAttendanceDeliveryChannel({
        query,
        readConfig: async () => { dingTalkNetworkTouched = true; return dingTalkConfig },
        fetchAccessToken: async () => { dingTalkNetworkTouched = true; return 'access-token' },
        sendWorkNotification: async () => { dingTalkNetworkTouched = true; return { taskId: 'unused', raw: {} } },
      })
      const weComChannel = new WeComAttendanceDeliveryChannel({
        query,
        readConfig: async () => { weComNetworkTouched = true; return weComConfig },
        fetchAccessToken: async () => { weComNetworkTouched = true; return 'access-token' },
        sendTextMessage: async () => { weComNetworkTouched = true; return { errcode: 0, errmsg: 'ok', invalidUserIds: [], raw: {} } },
      })
      const worker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [dingTalkChannel, weComChannel],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-h1-org-inactive',
      })

      // Neither recipient has a channel identity to resolve (0 recipient rows) AND neither org has an
      // active integration (suspended, not active) — retryable:true, no skip: both land `retrying`,
      // NOT `skipped`, and the worker's normal backoff will keep retrying rather than dropping them
      // for good.
      await expect(worker.runBatch()).resolves.toEqual({ claimed: 2, sent: 0, retrying: 2, failed: 0, skipped: 0 })
      expect(dingTalkNetworkTouched).toBe(false)
      expect(weComNetworkTouched).toBe(false)

      const dingTalkRow = (await publicPool.query(
        `SELECT status, delivered_at, last_error, attempt_count, claim_worker_id, claim_expires_at, next_attempt_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [dingTalkDeliveryId],
      )).rows[0]
      expect(dingTalkRow).toMatchObject({
        status: 'retrying',
        delivered_at: null,
        last_error: 'dingtalk_org_integration_inactive',
        attempt_count: 1,
        claim_worker_id: null,
        claim_expires_at: null,
      })
      expect(dingTalkRow.next_attempt_at).toBeTruthy()

      const weComRow = (await publicPool.query(
        `SELECT status, delivered_at, last_error, attempt_count, claim_worker_id, claim_expires_at, next_attempt_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [weComDeliveryId],
      )).rows[0]
      expect(weComRow).toMatchObject({
        status: 'retrying',
        delivered_at: null,
        last_error: 'wecom_org_integration_inactive',
        attempt_count: 1,
        claim_worker_id: null,
        claim_expires_at: null,
      })
      expect(weComRow.next_attempt_at).toBeTruthy()
    } finally {
      if (dingTalkDeliveryId) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [dingTalkDeliveryId]).catch(() => undefined)
      }
      if (weComDeliveryId) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [weComDeliveryId]).catch(() => undefined)
      }
      await publicPool.query('DELETE FROM directory_integrations WHERE id = $1', [dingTalkIntegrationId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_integrations WHERE id = $1', [weComIntegrationId]).catch(() => undefined)
      await publicPool.end().catch(() => undefined)
    }
  })

  it('E3 deep-link: flag+base-URL send an actionCard whose button opens the container landing; missing URL falls back to text', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const publicPool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `e3-deeplink-${runSuffix}`
    const localUserId = `u-e3-deeplink-${runSuffix}`
    const integrationId = randomUUID()
    const directoryAccountId = randomUUID()
    const sourceId = randomUUID()
    const deliveryIds: string[] = []
    const envSnapshot = {
      flag: process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED,
      publicUrl: process.env.PUBLIC_APP_URL,
      baseUrl: process.env.APP_BASE_URL,
    }
    const config: DingTalkMessageConfig = {
      appKey: 'dt-app-key',
      appSecret: 'dt-app-secret',
      agentId: '123456789',
      baseUrl: 'https://oapi.dingtalk.com',
    }
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await publicPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }

    const insertDelivery = async (): Promise<string> => {
      const row = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','dingtalk_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `e3-deeplink:${sourceId}:recipient:${localUserId}:n:${deliveryIds.length}:${runSuffix}`,
          localUserId,
          JSON.stringify({ title: 'E3 deep-link smoke', body: 'Tap to open attendance.' }),
        ],
      )
      deliveryIds.push(row.rows[0].id)
      return row.rows[0].id
    }

    const buildChannel = (sink: { text: unknown[]; card: unknown[] }) => new DingTalkAttendanceDeliveryChannel({
      query,
      readConfig: async () => config,
      fetchAccessToken: async () => 'access-token',
      sendWorkNotification: async (_accessToken, input) => {
        sink.text.push(input)
        return { taskId: 'task-e3-text', requestId: 'req-e3-text', raw: {} }
      },
      sendWorkNotificationActionCard: async (_accessToken, input) => {
        sink.card.push(input)
        return { taskId: 'task-e3-card', requestId: 'req-e3-card', raw: {} }
      },
    })

    try {
      await requireTable(publicPool, 'attendance_notification_deliveries')
      await publicPool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1,$2,'hash',$3,'user',true)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
        [localUserId, `${localUserId}@example.test`, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
         VALUES ($1,$2,'dingtalk',$3,'active','corp-e3',$4::jsonb)`,
        [integrationId, orgId, `E3 DingTalk ${runSuffix}`, JSON.stringify({})],
      )
      await publicPool.query(
        `INSERT INTO directory_accounts
           (id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
         VALUES ($1,$2,'dingtalk','corp-e3','dt-user-e3','dt-key-e3',$3,true)`,
        [directoryAccountId, integrationId, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1,$2,'linked','manual')`,
        [directoryAccountId, localUserId],
      )

      // Case 1: flag + base URL (with a trailing slash to prove normalization) -> actionCard.
      process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
      process.env.PUBLIC_APP_URL = 'https://app.example.test/'
      delete process.env.APP_BASE_URL
      await insertDelivery()
      const cardSink = { text: [] as unknown[], card: [] as unknown[] }
      const cardWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(cardSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-e3-card',
      })
      await expect(cardWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(cardSink.text).toHaveLength(0)
      expect(cardSink.card).toEqual([{
        userIds: ['dt-user-e3'],
        title: 'E3 deep-link smoke',
        markdown: 'Tap to open attendance.',
        singleTitle: '打开考勤',
        singleUrl: 'https://app.example.test/attendance?noticeSource=unscheduled_reminder',
      }])

      // Case 2: flag on but NO base URL -> text path, byte-identical fallback.
      process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
      delete process.env.PUBLIC_APP_URL
      delete process.env.APP_BASE_URL
      await insertDelivery()
      const textSink = { text: [] as unknown[], card: [] as unknown[] }
      const textWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(textSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-e3-text',
      })
      await expect(textWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(textSink.card).toHaveLength(0)
      expect(textSink.text).toEqual([{
        userIds: ['dt-user-e3'],
        title: 'E3 deep-link smoke',
        content: 'Tap to open attendance.',
      }])

      // Case 2b (review P3): APP_BASE_URL alone (no PUBLIC_APP_URL) also powers
      // the deep link — the fallback branch of the base-URL resolver.
      process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
      delete process.env.PUBLIC_APP_URL
      process.env.APP_BASE_URL = 'https://fallback.example.test'
      await insertDelivery()
      const fallbackSink = { text: [] as unknown[], card: [] as unknown[] }
      const fallbackWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(fallbackSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-e3-appbase',
      })
      await expect(fallbackWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(fallbackSink.text).toHaveLength(0)
      expect(fallbackSink.card).toHaveLength(1)
      expect((fallbackSink.card[0] as { singleUrl: string }).singleUrl)
        .toBe('https://fallback.example.test/attendance?noticeSource=unscheduled_reminder')

      // Case 3: base URL present but flag OFF -> text path (the flag is load-bearing:
      // PUBLIC_APP_URL is already set in production for approval cards).
      delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
      process.env.PUBLIC_APP_URL = 'https://app.example.test'
      await insertDelivery()
      const flagOffSink = { text: [] as unknown[], card: [] as unknown[] }
      const flagOffWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(flagOffSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-e3-flagoff',
      })
      await expect(flagOffWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(flagOffSink.card).toHaveLength(0)
      expect(flagOffSink.text).toHaveLength(1)

      // Builder contract: trailing slashes normalized, source encoded, empty base -> null.
      expect(buildAttendanceNotificationDeepLink('manual_missed_punch_reminder', 'https://a.example//'))
        .toBe('https://a.example/attendance?noticeSource=manual_missed_punch_reminder')
      expect(buildAttendanceNotificationDeepLink('week end/review', 'https://a.example'))
        .toBe('https://a.example/attendance?noticeSource=week%20end%2Freview')
      expect(buildAttendanceNotificationDeepLink('unscheduled_reminder', '')).toBeNull()
      expect(buildAttendanceNotificationDeepLink('unscheduled_reminder', undefined)).toBeNull()
    } finally {
      if (envSnapshot.flag === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
      else process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = envSnapshot.flag
      if (envSnapshot.publicUrl === undefined) delete process.env.PUBLIC_APP_URL
      else process.env.PUBLIC_APP_URL = envSnapshot.publicUrl
      if (envSnapshot.baseUrl === undefined) delete process.env.APP_BASE_URL
      else process.env.APP_BASE_URL = envSnapshot.baseUrl
      for (const id of deliveryIds) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [id]).catch(() => undefined)
      }
      await publicPool.query('DELETE FROM directory_account_links WHERE directory_account_id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_accounts WHERE id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_integrations WHERE id = $1', [integrationId]).catch(() => undefined)
      await publicPool.query('DELETE FROM users WHERE id = $1', [localUserId]).catch(() => undefined)
      await publicPool.end().catch(() => undefined)
    }
  })

  it('S4 WeCom channel resolves linked directory users (sent) and skips — not fails — an unbound recipient, without external network', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const publicPool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `c5-wecom-${runSuffix}`
    const localUserId = `u-c5-wecom-${runSuffix}`
    const unboundUserId = `u-c5-wecom-unbound-${runSuffix}`
    const integrationId = randomUUID()
    const directoryAccountId = randomUUID()
    const sourceId = randomUUID()
    let deliveryId = ''
    let unboundDeliveryId = ''
    const config: WeComMessageConfig = {
      corpId: 'we-corp-c5',
      corpSecret: 'we-corp-secret-c5',
      agentId: '1000002',
      baseUrl: 'https://qyapi.weixin.qq.com',
    }
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await publicPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    const sentMessages: unknown[] = []

    try {
      await requireTable(publicPool, 'users')
      await requireTable(publicPool, 'directory_integrations')
      await requireTable(publicPool, 'directory_accounts')
      await requireTable(publicPool, 'directory_account_links')
      await requireTable(publicPool, 'attendance_notification_deliveries')

      await publicPool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1,$2,'hash',$3,'user',true)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
        [localUserId, `${localUserId}@example.test`, localUserId],
      )
      // provider='wecom' — same three-table shape as the DingTalk channel, zero new tables/columns
      // (design-lock G5/G7).
      await publicPool.query(
        `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
         VALUES ($1,$2,'wecom',$3,'active','we-corp-c5',$4::jsonb)`,
        [integrationId, orgId, `S4 WeCom ${runSuffix}`, JSON.stringify({})],
      )
      await publicPool.query(
        `INSERT INTO directory_accounts
           (id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
         VALUES ($1,$2,'wecom','we-corp-c5','we-user-c5','we-key-c5',$3,true)`,
        [directoryAccountId, integrationId, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1,$2,'linked','manual')`,
        [directoryAccountId, localUserId],
      )
      const delivery = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','wecom_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `c5-wecom:${sourceId}:recipient:${localUserId}:channel:wecom_work_notification`,
          localUserId,
          JSON.stringify({ title: 'S4 WeCom smoke', body: 'Please check the attendance reminder.' }),
        ],
      )
      deliveryId = delivery.rows[0].id

      // A second recipient with NO directory_account_links row at all — the ordinary "not onboarded to
      // WeCom yet" gap (WeCom directory population is a named prerequisite outside this channel's
      // scope). This delivery must land `skipped`, not `failed`, and must never reach
      // readConfig/fetchAccessToken/send (no channel identity to resolve, so the real-network mocks
      // below must not be invoked for this row).
      const unboundDelivery = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','wecom_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `c5-wecom:${sourceId}:recipient:${unboundUserId}:channel:wecom_work_notification`,
          unboundUserId,
          JSON.stringify({ title: 'S4 WeCom smoke (unbound)', body: 'Should never send.' }),
        ],
      )
      unboundDeliveryId = unboundDelivery.rows[0].id

      const channel = new WeComAttendanceDeliveryChannel({
        query,
        readConfig: async (receivedIntegrationId) => {
          expect(receivedIntegrationId).toBe(integrationId)
          return config
        },
        fetchAccessToken: async (receivedConfig) => {
          expect(receivedConfig).toBe(config)
          return 'access-token'
        },
        sendTextMessage: async (accessToken, input, receivedConfig) => {
          sentMessages.push({ accessToken, input, receivedConfig })
          return { errcode: 0, errmsg: 'ok', msgId: 'msg-c5-wecom', invalidUserIds: [], raw: {} }
        },
      })
      const worker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [channel],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-c5-wecom',
      })

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 2, sent: 1, retrying: 0, failed: 0, skipped: 1 })

      // Only the linked recipient's row reached the network mocks — the unbound recipient never did.
      expect(sentMessages).toEqual([{
        accessToken: 'access-token',
        input: {
          userIds: ['we-user-c5'],
          content: 'Please check the attendance reminder.',
        },
        receivedConfig: config,
      }])
      const row = (await publicPool.query(
        `SELECT status, delivered_at, last_error, attempt_count, claim_worker_id, claim_expires_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [deliveryId],
      )).rows[0]
      expect(row).toMatchObject({
        status: 'sent',
        last_error: null,
        attempt_count: 1,
        claim_worker_id: null,
        claim_expires_at: null,
      })
      expect(row.delivered_at).toBeTruthy()

      const unboundRow = (await publicPool.query(
        `SELECT status, delivered_at, last_error, attempt_count, claim_worker_id, claim_expires_at
           FROM attendance_notification_deliveries
          WHERE id = $1`,
        [unboundDeliveryId],
      )).rows[0]
      expect(unboundRow).toMatchObject({
        status: 'skipped',
        delivered_at: null,
        last_error: 'wecom_recipient_not_bound',
        attempt_count: 1,
        claim_worker_id: null,
        claim_expires_at: null,
      })
    } finally {
      if (deliveryId) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [deliveryId]).catch(() => undefined)
      }
      if (unboundDeliveryId) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [unboundDeliveryId]).catch(() => undefined)
      }
      await publicPool.query('DELETE FROM directory_account_links WHERE directory_account_id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_accounts WHERE id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_integrations WHERE id = $1', [integrationId]).catch(() => undefined)
      await publicPool.query('DELETE FROM users WHERE id = $1', [localUserId]).catch(() => undefined)
      await publicPool.end().catch(() => undefined)
    }
  })

  it('S4 WeCom deep-link: flag+base-URL send a textcard whose button opens the container landing; missing URL falls back to text', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const publicPool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `s4-wecom-deeplink-${runSuffix}`
    const localUserId = `u-s4-wecom-deeplink-${runSuffix}`
    const integrationId = randomUUID()
    const directoryAccountId = randomUUID()
    const sourceId = randomUUID()
    const deliveryIds: string[] = []
    const envSnapshot = {
      flag: process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED,
      publicUrl: process.env.PUBLIC_APP_URL,
      baseUrl: process.env.APP_BASE_URL,
    }
    const config: WeComMessageConfig = {
      corpId: 'we-corp-s4',
      corpSecret: 'we-corp-secret-s4',
      agentId: '1000002',
      baseUrl: 'https://qyapi.weixin.qq.com',
    }
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await publicPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }

    const insertDelivery = async (): Promise<string> => {
      const row = await publicPool.query<{ id: string }>(
        `INSERT INTO attendance_notification_deliveries
           (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
         VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','wecom_work_notification',$5::jsonb)
         RETURNING id::text AS id`,
        [
          orgId,
          sourceId,
          `s4-wecom-deeplink:${sourceId}:recipient:${localUserId}:n:${deliveryIds.length}:${runSuffix}`,
          localUserId,
          JSON.stringify({ title: 'S4 WeCom deep-link smoke', body: 'Tap to open attendance.' }),
        ],
      )
      deliveryIds.push(row.rows[0].id)
      return row.rows[0].id
    }

    const buildChannel = (sink: { text: unknown[]; card: unknown[] }) => new WeComAttendanceDeliveryChannel({
      query,
      readConfig: async () => config,
      fetchAccessToken: async () => 'access-token',
      sendTextMessage: async (_accessToken, input) => {
        sink.text.push(input)
        return { errcode: 0, errmsg: 'ok', msgId: 'msg-text', invalidUserIds: [], raw: {} }
      },
      sendTextCardMessage: async (_accessToken, input) => {
        sink.card.push(input)
        return { errcode: 0, errmsg: 'ok', msgId: 'msg-card', invalidUserIds: [], raw: {} }
      },
    })

    try {
      await requireTable(publicPool, 'attendance_notification_deliveries')
      await publicPool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1,$2,'hash',$3,'user',true)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
        [localUserId, `${localUserId}@example.test`, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
         VALUES ($1,$2,'wecom',$3,'active','we-corp-s4',$4::jsonb)`,
        [integrationId, orgId, `S4 WeCom deep-link ${runSuffix}`, JSON.stringify({})],
      )
      await publicPool.query(
        `INSERT INTO directory_accounts
           (id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
         VALUES ($1,$2,'wecom','we-corp-s4','we-user-s4','we-key-s4',$3,true)`,
        [directoryAccountId, integrationId, localUserId],
      )
      await publicPool.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1,$2,'linked','manual')`,
        [directoryAccountId, localUserId],
      )

      // Case 1: flag + base URL -> textcard.
      process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
      process.env.PUBLIC_APP_URL = 'https://app.example.test/'
      delete process.env.APP_BASE_URL
      await insertDelivery()
      const cardSink = { text: [] as unknown[], card: [] as unknown[] }
      const cardWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(cardSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-s4-wecom-card',
      })
      await expect(cardWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(cardSink.text).toHaveLength(0)
      expect(cardSink.card).toEqual([{
        userIds: ['we-user-s4'],
        title: 'S4 WeCom deep-link smoke',
        description: 'Tap to open attendance.',
        url: 'https://app.example.test/attendance?noticeSource=unscheduled_reminder',
        btnTxt: '打开考勤',
      }])

      // Case 2: flag on but NO base URL -> text path, byte-identical fallback.
      process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
      delete process.env.PUBLIC_APP_URL
      delete process.env.APP_BASE_URL
      await insertDelivery()
      const textSink = { text: [] as unknown[], card: [] as unknown[] }
      const textWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(textSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-s4-wecom-text',
      })
      await expect(textWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(textSink.card).toHaveLength(0)
      expect(textSink.text).toEqual([{
        userIds: ['we-user-s4'],
        content: 'Tap to open attendance.',
      }])

      // Case 3: base URL present but flag OFF -> text path (the flag is load-bearing).
      delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
      process.env.PUBLIC_APP_URL = 'https://app.example.test'
      await insertDelivery()
      const flagOffSink = { text: [] as unknown[], card: [] as unknown[] }
      const flagOffWorker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [buildChannel(flagOffSink)],
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        workerId: 'worker-s4-wecom-flagoff',
      })
      await expect(flagOffWorker.runBatch()).resolves.toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, skipped: 0 })
      expect(flagOffSink.card).toHaveLength(0)
      expect(flagOffSink.text).toHaveLength(1)
    } finally {
      if (envSnapshot.flag === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
      else process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = envSnapshot.flag
      if (envSnapshot.publicUrl === undefined) delete process.env.PUBLIC_APP_URL
      else process.env.PUBLIC_APP_URL = envSnapshot.publicUrl
      if (envSnapshot.baseUrl === undefined) delete process.env.APP_BASE_URL
      else process.env.APP_BASE_URL = envSnapshot.baseUrl
      for (const id of deliveryIds) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [id]).catch(() => undefined)
      }
      await publicPool.query('DELETE FROM directory_account_links WHERE directory_account_id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_accounts WHERE id = $1', [directoryAccountId]).catch(() => undefined)
      await publicPool.query('DELETE FROM directory_integrations WHERE id = $1', [integrationId]).catch(() => undefined)
      await publicPool.query('DELETE FROM users WHERE id = $1', [localUserId]).catch(() => undefined)
      await publicPool.end().catch(() => undefined)
    }
  })

  it('C5 email_smtp — org-scoped recipient: active in-org→sent, transport 5xx→failed(no retry), NOT-in-org→failed & never sent', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL is required for this integration test')
    const publicPool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const orgId = `c5-email-${runSuffix}`
    const otherOrgId = `c5-email-other-${runSuffix}`
    const okUser = `u-c5-email-ok-${runSuffix}`
    const failUser = `u-c5-email-fail-${runSuffix}`
    const noOrgUser = `u-c5-email-noorg-${runSuffix}`
    const sourceId = randomUUID()
    const ids: Record<string, string> = {}
    // SMTP transport is mocked; this env only needs to make resolveEmailSmtpTransportConfig succeed.
    const smtpEnv = {
      MULTITABLE_EMAIL_TRANSPORT: 'smtp',
      MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.test',
      MULTITABLE_EMAIL_SMTP_PORT: '587',
      MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
      MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
      MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.test',
    } as NodeJS.ProcessEnv
    const sentTo: string[] = []
    const query: AttendanceNotificationDeliveryQuery = async (sqlText, params) => {
      const r = await publicPool.query(sqlText, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    const emailOf = (uid: string) => `${uid}@example.test`
    try {
      await requireTable(publicPool, 'users')
      await requireTable(publicPool, 'user_orgs')
      await requireTable(publicPool, 'attendance_notification_deliveries')

      for (const uid of [okUser, failUser, noOrgUser]) {
        await publicPool.query(
          `INSERT INTO users (id, email, password_hash, name, role, is_active)
           VALUES ($1,$2,'hash',$3,'user',true)
           ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active, email = EXCLUDED.email`,
          [uid, emailOf(uid), uid],
        )
      }
      // ok + fail are ACTIVE members of the delivery org; noOrg is active but only a member of ANOTHER org.
      await publicPool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1,$2,true) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`, [okUser, orgId])
      await publicPool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1,$2,true) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`, [failUser, orgId])
      await publicPool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1,$2,true) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`, [noOrgUser, otherOrgId])

      const insertEmailRow = async (uid: string) => {
        const r = await publicPool.query<{ id: string }>(
          `INSERT INTO attendance_notification_deliveries
             (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
           VALUES ($1,'unscheduled_reminder',$2,$3,$4,'subject','email_smtp',$5::jsonb)
           RETURNING id::text AS id`,
          [orgId, sourceId, `c5-email:${sourceId}:${uid}`, uid, JSON.stringify({ title: 'Email smoke', body: 'Please check the attendance reminder.' })],
        )
        return r.rows[0].id
      }
      ids.ok = await insertEmailRow(okUser)
      ids.fail = await insertEmailRow(failUser)
      ids.noorg = await insertEmailRow(noOrgUser)

      const transport = {
        sendMail: async (opts: { to: string }) => {
          sentTo.push(opts.to)
          if (opts.to === emailOf(failUser)) {
            throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 })
          }
          return { messageId: 'ok' }
        },
      }
      const channel = new EmailAttendanceDeliveryChannel({ query, env: smtpEnv, createTransport: () => transport })
      const worker = new AttendanceNotificationDeliveryWorker({
        query,
        channels: [channel],
        now: () => new Date('2026-08-03T00:00:00.000Z'),
        maxAttempts: 2,
        workerId: 'worker-c5-email',
      })

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 3, sent: 1, retrying: 0, failed: 2, skipped: 0 })

      const row = async (id: string) => (await publicPool.query(
        `SELECT status, delivered_at, last_error FROM attendance_notification_deliveries WHERE id = $1`,
        [id],
      )).rows[0]
      // active in-org member + transport ok → sent
      expect(await row(ids.ok)).toMatchObject({ status: 'sent', last_error: null })
      expect((await row(ids.ok)).delivered_at).toBeTruthy()
      // in-org + transport 5xx → permanent failure, not retried
      const failRow = await row(ids.fail)
      expect(failRow.status).toBe('failed')
      expect(String(failRow.last_error)).toContain('email_send_failed_550')
      // NOT a member of the delivery org → fail-closed (dead-lettered) AND the transport was never invoked for it
      const noorgRow = await row(ids.noorg)
      expect(noorgRow.status).toBe('failed')
      expect(String(noorgRow.last_error)).toContain('email_recipient_unresolved')
      expect(sentTo).toContain(emailOf(okUser))
      expect(sentTo).toContain(emailOf(failUser))
      expect(sentTo).not.toContain(emailOf(noOrgUser))
    } finally {
      for (const id of Object.values(ids)) {
        await publicPool.query('DELETE FROM attendance_notification_deliveries WHERE id = $1', [id]).catch(() => undefined)
      }
      await publicPool.query('DELETE FROM user_orgs WHERE user_id = ANY($1)', [[okUser, failUser, noOrgUser]]).catch(() => undefined)
      await publicPool.query('DELETE FROM users WHERE id = ANY($1)', [[okUser, failUser, noOrgUser]]).catch(() => undefined)
      await publicPool.end().catch(() => undefined)
    }
  })
})
