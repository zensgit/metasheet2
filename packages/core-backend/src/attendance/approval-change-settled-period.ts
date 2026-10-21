/**
 * A work date is settled when a payroll cycle covering it is closed or archived,
 * or that cycle already has a settlement row. Callers run this inside the org
 * rollout lock. A query failure is a fault, not "open".
 */

export const ATTENDANCE_SETTLED_WORK_DATE_SQL_V1 = `SELECT 1
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

export const ATTENDANCE_RECOMPUTE_OBLIGATION_SQL_V1 = `SELECT 1
   FROM attendance_recompute_obligations
  WHERE org_id = $1
    AND work_date BETWEEN $2::date AND $3::date
    AND status IN ('pending', 'leased', 'failed')
    AND superseded_by IS NULL
  LIMIT 1`
