/**
 * Same predicates as packages/core-backend/src/attendance/approval-change-settled-period.ts.
 * A query failure is a fault. Zero settled rows means the date is open.
 */

const ATTENDANCE_SETTLED_WORK_DATE_SQL_V1 = `SELECT 1
   FROM attendance_payroll_cycles c
  WHERE c.org_id = $1
    AND $2::date BETWEEN c.start_date AND c.end_date
    AND (
      c.status IN ('closed', 'archived')
      OR EXISTS (
        SELECT 1 FROM attendance_payroll_cycle_settlements s
         WHERE s.cycle_id = c.id AND s.org_id = c.org_id
      )
    )
  LIMIT 1`

const ATTENDANCE_RECOMPUTE_OBLIGATION_SQL_V1 = `SELECT 1
   FROM attendance_recompute_obligations
  WHERE org_id = $1
    AND work_date BETWEEN $2::date AND $3::date
    AND status IN ('pending', 'leased', 'failed')
    AND superseded_by IS NULL
  LIMIT 1`

function isSchemaFault(error) {
  const code = error && error.code
  return code === '42P01' || code === '42703'
}

async function assertAttendanceWorkDateOpen(trx, orgId, workDate) {
  const date = typeof workDate === 'string' ? workDate.slice(0, 10) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
  let rows
  try {
    rows = await trx.query(ATTENDANCE_SETTLED_WORK_DATE_SQL_V1, [orgId, date])
  } catch (error) {
    if (isSchemaFault(error)) {
      const fault = new Error('payroll cycle tables unavailable')
      fault.code = 'ATTENDANCE_PERIOD_SETTLED_UNAVAILABLE'
      fault.status = 503
      throw fault
    }
    throw error
  }
  if (rows.length > 0) {
    const blocked = new Error('该日所在的考勤周期已结账，不能撤销或修改')
    blocked.code = 'ATTENDANCE_PERIOD_SETTLED'
    blocked.status = 409
    throw blocked
  }
}

async function assertNoOpenRecomputeObligation(trx, orgId, startDate, endDate) {
  let rows
  try {
    rows = await trx.query(ATTENDANCE_RECOMPUTE_OBLIGATION_SQL_V1, [orgId, startDate, endDate])
  } catch (error) {
    if (isSchemaFault(error)) {
      const fault = new Error('recompute obligation table unavailable')
      fault.code = 'ATTENDANCE_RECOMPUTE_OBLIGATION_UNAVAILABLE'
      fault.status = 503
      throw fault
    }
    throw error
  }
  if (rows.length > 0) {
    const blocked = new Error('该周期仍有未完成的考勤重算，不能结账')
    blocked.code = 'ATTENDANCE_RECOMPUTE_OBLIGATION_OPEN'
    blocked.status = 409
    throw blocked
  }
}

module.exports = {
  ATTENDANCE_SETTLED_WORK_DATE_SQL_V1,
  ATTENDANCE_RECOMPUTE_OBLIGATION_SQL_V1,
  assertAttendanceWorkDateOpen,
  assertNoOpenRecomputeObligation,
}
