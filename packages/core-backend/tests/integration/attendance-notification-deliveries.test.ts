import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up as createAttendanceNotificationDeliveries } from '../../src/db/migrations/zzzz20260611120000_create_attendance_notification_deliveries'

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
})
