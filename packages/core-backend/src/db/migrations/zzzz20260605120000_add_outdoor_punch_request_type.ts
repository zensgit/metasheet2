import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

// ② 打卡策略组 S3 外勤审批 (design-lock attendance-outdoor-approval-s3-design-lock-20260605.md / #2304).
// Adds the `outdoor_punch` attendance request type — an outdoor (field-work) punch that, when
// punchPolicy.outdoor.requireApproval is enabled, becomes a pending approval request instead of a direct
// attendance_event; final approval writes the real punch. No new table: the outdoor fact lives in
// attendance_requests.metadata.outdoorPunch. This only widens the CHECK constraint; existing rows/behaviour
// are untouched.
const REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
]

// The set that existed immediately before this migration (so `down` restores the real prior state, not the
// original migration's narrower 3-type baseline).
const PRIOR_REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
]

async function setRequestTypeCheck(db: Kysely<unknown>, types: string[]): Promise<void> {
  const list = types.map(type => `'${type}'`).join(', ')
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS attendance_requests_type_check`.execute(db)
  await sql`
    ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check
    CHECK (request_type IN (${sql.raw(list)}))
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'attendance_requests'))) return
  await setRequestTypeCheck(db, REQUEST_TYPES)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'attendance_requests'))) return
  await setRequestTypeCheck(db, PRIOR_REQUEST_TYPES)
}
