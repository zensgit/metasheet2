import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
]

export async function up(db: Kysely<unknown>): Promise<void> {
  const requestsExists = await checkTableExists(db, 'attendance_requests')
  if (!requestsExists) return

  const requestTypesSql = REQUEST_TYPES.map(type => `'${type}'`).join(', ')
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS attendance_requests_type_check`.execute(db)
  await sql`
    ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check
    CHECK (request_type IN (${sql.raw(requestTypesSql)}))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const requestsExists = await checkTableExists(db, 'attendance_requests')
  if (!requestsExists) return

  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS attendance_requests_type_check`.execute(db)
  await sql`
    ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check
    CHECK (request_type IN ('missed_check_in', 'missed_check_out', 'time_correction'))
  `.execute(db)
}
