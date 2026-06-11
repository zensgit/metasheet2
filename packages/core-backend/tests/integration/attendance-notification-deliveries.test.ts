import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up as createAttendanceNotificationDeliveries } from '../../src/db/migrations/zzzz20260611120000_create_attendance_notification_deliveries'
import {
  AttendanceNotificationDeliveryWorker,
  DeterministicFakeAttendanceDeliveryChannel,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'

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
      await requireTable(workerPool, 'attendance_notification_deliveries')

      const okId = await insertDelivery('ok')
      const retryId = await insertDelivery('retry', { payload: { fakeDelivery: 'retry' } })
      const maxRetryId = await insertDelivery('maxretry', { attemptCount: 1, payload: { fakeDelivery: 'retry' } })
      const failId = await insertDelivery('fail', { payload: { fakeDelivery: 'fail' } })
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

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 6, sent: 2, retrying: 1, failed: 3 })

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

      await expect(worker.runBatch()).resolves.toEqual({ claimed: 0, sent: 0, retrying: 0, failed: 0 })
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
            await expect(workerB.runBatch()).resolves.toEqual({ claimed: 1, sent: 0, retrying: 1, failed: 0 })
            return { ok: true }
          },
        }],
        now: () => claimNow,
        leaseMs: 5_000,
        workerId: 'worker-a',
      })

      await expect(workerA.runBatch()).resolves.toEqual({ claimed: 1, sent: 0, retrying: 0, failed: 0, lostLease: 1 })

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
})
