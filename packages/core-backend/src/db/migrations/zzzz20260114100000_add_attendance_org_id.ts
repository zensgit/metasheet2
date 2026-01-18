import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, checkTableExists, createIndexIfNotExists, dropColumnIfExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  const rulesExists = await checkTableExists(db, 'attendance_rules')
  if (rulesExists) {
    await addColumnIfNotExists(db, 'attendance_rules', 'org_id', 'text', {
      notNull: true,
      defaultTo: DEFAULT_ORG_ID,
    })
    await createIndexIfNotExists(db, 'idx_attendance_rules_org', 'attendance_rules', 'org_id')
    await sql`DROP INDEX IF EXISTS idx_attendance_rules_default`.execute(db)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_rules_default
      ON attendance_rules(org_id)
      WHERE is_default = true
    `.execute(db)
  }

  const eventsExists = await checkTableExists(db, 'attendance_events')
  if (eventsExists) {
    await addColumnIfNotExists(db, 'attendance_events', 'org_id', 'text', {
      notNull: true,
      defaultTo: DEFAULT_ORG_ID,
    })
    await createIndexIfNotExists(db, 'idx_attendance_events_org', 'attendance_events', 'org_id')
    await sql`DROP INDEX IF EXISTS idx_attendance_events_user_time`.execute(db)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_attendance_events_user_org_time
      ON attendance_events(user_id, org_id, occurred_at DESC)
    `.execute(db)
  }

  const recordsExists = await checkTableExists(db, 'attendance_records')
  if (recordsExists) {
    await addColumnIfNotExists(db, 'attendance_records', 'org_id', 'text', {
      notNull: true,
      defaultTo: DEFAULT_ORG_ID,
    })
    await createIndexIfNotExists(db, 'idx_attendance_records_org', 'attendance_records', 'org_id')
    await sql`DROP INDEX IF EXISTS idx_attendance_records_user_date`.execute(db)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_records_user_date
      ON attendance_records(user_id, work_date, org_id)
    `.execute(db)
  }

  const requestsExists = await checkTableExists(db, 'attendance_requests')
  if (requestsExists) {
    await addColumnIfNotExists(db, 'attendance_requests', 'org_id', 'text', {
      notNull: true,
      defaultTo: DEFAULT_ORG_ID,
    })
    await createIndexIfNotExists(db, 'idx_attendance_requests_org', 'attendance_requests', 'org_id')
    await sql`DROP INDEX IF EXISTS idx_attendance_requests_user_date`.execute(db)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_attendance_requests_user_org_date
      ON attendance_requests(user_id, org_id, work_date)
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rulesExists = await checkTableExists(db, 'attendance_rules')
  if (rulesExists) {
    await sql`DROP INDEX IF EXISTS idx_attendance_rules_default`.execute(db)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_rules_default
      ON attendance_rules(is_default)
      WHERE is_default = true
    `.execute(db)
    await sql`DROP INDEX IF EXISTS idx_attendance_rules_org`.execute(db)
    await dropColumnIfExists(db, 'attendance_rules', 'org_id')
  }

  const eventsExists = await checkTableExists(db, 'attendance_events')
  if (eventsExists) {
    await sql`DROP INDEX IF EXISTS idx_attendance_events_user_org_time`.execute(db)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_attendance_events_user_time
      ON attendance_events(user_id, occurred_at DESC)
    `.execute(db)
    await sql`DROP INDEX IF EXISTS idx_attendance_events_org`.execute(db)
    await dropColumnIfExists(db, 'attendance_events', 'org_id')
  }

  const recordsExists = await checkTableExists(db, 'attendance_records')
  if (recordsExists) {
    await sql`DROP INDEX IF EXISTS idx_attendance_records_user_date`.execute(db)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_records_user_date
      ON attendance_records(user_id, work_date)
    `.execute(db)
    await sql`DROP INDEX IF EXISTS idx_attendance_records_org`.execute(db)
    await dropColumnIfExists(db, 'attendance_records', 'org_id')
  }

  const requestsExists = await checkTableExists(db, 'attendance_requests')
  if (requestsExists) {
    await sql`DROP INDEX IF EXISTS idx_attendance_requests_user_org_date`.execute(db)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_attendance_requests_user_date
      ON attendance_requests(user_id, work_date)
    `.execute(db)
    await sql`DROP INDEX IF EXISTS idx_attendance_requests_org`.execute(db)
    await dropColumnIfExists(db, 'attendance_requests', 'org_id')
  }
}
