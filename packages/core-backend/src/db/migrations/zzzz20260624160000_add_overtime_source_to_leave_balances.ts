import type { Kysely } from 'kysely'
import { addColumnIfNotExists, checkTableExists, dropColumnIfExists } from './_patterns'

// 加班银行 v1-1b (design-lock attendance-overtime-bank-settlement-designlock-20260624, §3 账1): tag each
// overtime-conversion comp_time lot with the OT day-type SOURCE (workday / restday / special_hours / ...) so
// 账2 offset + 账4 settlement can treat sources differently (§6 — e.g. statutory_holiday must be paid, never
// poolable). NULLABLE, default NULL: every existing lot keeps NULL, and the DORMANT overtimeBankPolicy path
// (default, every current org) keeps writing a single NULL-source lot — byte-identical to pre-#8. Only when
// an org enables overtimeBankPolicy does the grant write per-source tagged lots.
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'attendance_leave_balances')
  if (!exists) return
  await addColumnIfNotExists(db, 'attendance_leave_balances', 'overtime_source', 'text', {})
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'attendance_leave_balances')
  if (!exists) return
  await dropColumnIfExists(db, 'attendance_leave_balances', 'overtime_source')
}
