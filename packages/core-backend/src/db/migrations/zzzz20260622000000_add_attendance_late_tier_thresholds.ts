import type { Kysely } from 'kysely'
import { addColumnIfNotExists, checkTableExists, dropColumnIfExists } from './_patterns'

// #5 RT-1a (design-lock #3055): per-group lateness tier thresholds on attendance_rules so
// severe-late / absence-late are configurable, not just the RT-1 code defaults. Additive + defaulted to
// the §3 recommended 30 / 60 (over the grace window), so existing rows keep tiering identically to RT-1.
export async function up(db: Kysely<unknown>): Promise<void> {
  const rulesExists = await checkTableExists(db, 'attendance_rules')
  if (!rulesExists) return
  await addColumnIfNotExists(db, 'attendance_rules', 'severe_late_threshold_minutes', 'integer', {
    notNull: true,
    defaultTo: 30,
  })
  await addColumnIfNotExists(db, 'attendance_rules', 'absence_late_threshold_minutes', 'integer', {
    notNull: true,
    defaultTo: 60,
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rulesExists = await checkTableExists(db, 'attendance_rules')
  if (!rulesExists) return
  await dropColumnIfExists(db, 'attendance_rules', 'severe_late_threshold_minutes')
  await dropColumnIfExists(db, 'attendance_rules', 'absence_late_threshold_minutes')
}
