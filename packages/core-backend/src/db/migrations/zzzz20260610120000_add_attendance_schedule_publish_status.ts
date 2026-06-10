import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  addColumnIfNotExists,
  checkTableExists,
  createIndexIfNotExists,
  dropColumnIfExists,
  dropIndexIfExists,
} from './_patterns'

const SCHEDULE_ASSIGNMENT_TABLES = [
  'attendance_shift_assignments',
  'attendance_rotation_assignments',
] as const

async function addPublishColumns(db: Kysely<unknown>, tableName: typeof SCHEDULE_ASSIGNMENT_TABLES[number]): Promise<void> {
  const exists = await checkTableExists(db, tableName)
  if (!exists) return
  const constraintName = `chk_${tableName}_publish_status`

  await addColumnIfNotExists(db, tableName, 'publish_status', 'text', {
    notNull: true,
    defaultTo: 'published',
  })
  await addColumnIfNotExists(db, tableName, 'publish_batch_id', 'uuid')
  await addColumnIfNotExists(db, tableName, 'publish_requested_at', 'timestamptz')
  await addColumnIfNotExists(db, tableName, 'publish_requested_by', 'text')
  await addColumnIfNotExists(db, tableName, 'published_at', 'timestamptz')
  await addColumnIfNotExists(db, tableName, 'published_by', 'text')
  await addColumnIfNotExists(db, tableName, 'locked_at', 'timestamptz')
  await addColumnIfNotExists(db, tableName, 'reopened_from_assignment_id', 'uuid')

  await sql.raw(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName}`).execute(db)
  await sql.raw(`
    ALTER TABLE ${tableName}
    ADD CONSTRAINT ${constraintName}
    CHECK (publish_status IN ('draft', 'pending', 'published')) NOT VALID
  `).execute(db)

  await createIndexIfNotExists(
    db,
    `idx_${tableName}_published_effective`,
    tableName,
    ['org_id', 'user_id', 'publish_status', 'is_active', 'start_date', 'end_date'],
  )
}

async function dropPublishColumns(db: Kysely<unknown>, tableName: typeof SCHEDULE_ASSIGNMENT_TABLES[number]): Promise<void> {
  const exists = await checkTableExists(db, tableName)
  if (!exists) return
  const constraintName = `chk_${tableName}_publish_status`

  await sql.raw(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName}`).execute(db)
  await dropIndexIfExists(db, `idx_${tableName}_published_effective`)
  await dropColumnIfExists(db, tableName, 'reopened_from_assignment_id')
  await dropColumnIfExists(db, tableName, 'locked_at')
  await dropColumnIfExists(db, tableName, 'published_by')
  await dropColumnIfExists(db, tableName, 'published_at')
  await dropColumnIfExists(db, tableName, 'publish_requested_by')
  await dropColumnIfExists(db, tableName, 'publish_requested_at')
  await dropColumnIfExists(db, tableName, 'publish_batch_id')
  await dropColumnIfExists(db, tableName, 'publish_status')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const tableName of SCHEDULE_ASSIGNMENT_TABLES) {
    await addPublishColumns(db, tableName)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const tableName of [...SCHEDULE_ASSIGNMENT_TABLES].reverse()) {
    await dropPublishColumns(db, tableName)
  }
}
