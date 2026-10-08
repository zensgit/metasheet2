-- W4C-2 roster entries 2-3 — READ-SIDE reconciliation input query (#4556).
-- Authorization: owner ruling issue-4556.comment-5317181927 (entries), mechanism per
-- issue-4556.comment-5322708492.
--
-- PURPOSE: for one org and one window, emit — per non-`equal` shadow calculation row — the
-- NINE inputs of `AttendanceW4C2ReadSideShadowRowProbeV1` plus this row's own identifiers.
-- This query performs NO classification: the disposition is made by feeding each row through
-- `isExpectedAttendanceW4C2ReadSideDifferenceV1` (packages/core-backend/src/attendance/
-- w4c2-shadow-expected-differences.ts), so the classifier is never re-derived in SQL — the
-- same single-implementation rule the window runner applies to Q8.
--
-- CONVERGENCE DEFINITION (matches the pinned v2 lifecycle EXACTLY, not "any later equal
-- row"): converged_to_equal is true iff the row with the SMALLEST version greater than this
-- row's, for the same attendance_record_id and mode='shadow', carries code 'equal'.
--
-- READ-ONLY; ad-hoc operator tool. Deliberately NOT wired into the window runner: adding an
-- alert source mid-window changes a live measurement's verdict semantics (see the runner's
-- own deliberate-non-change record in PR feat/w4c2-roster-entry-2-read-side).
--
-- Usage (psql):  \set org '''<org-uuid>'''  \set from '''<ISO>'''  \set to '''<ISO>'''
SELECT
  c.id::text                                   AS calculation_id,
  c.attendance_record_id::text                 AS attendance_record_id,
  c.version                                    AS version,
  r.work_date::text                            AS work_date,
  c.created_at                                 AS created_at,
  -- the nine probe inputs -----------------------------------------------------------------
  c.shadow_diff_code                           AS shadow_diff_code,
  c.shadow_diff -> 'changedFields'             AS changed_fields,
  c.projected_status                           AS projected_status,
  (c.projected_first_in_at IS NOT NULL)        AS projected_first_in_present,
  (c.projected_last_out_at IS NOT NULL)        AS projected_last_out_present,
  (c.shadow_diff ->> 'absoluteMinuteDelta')::int AS absolute_minute_delta,
  c.projected_late_minutes                     AS projected_late_minutes,
  c.projected_early_leave_minutes              AS projected_early_leave_minutes,
  COALESCE(next_row.shadow_diff_code = 'equal', false) AS converged_to_equal
FROM attendance_record_calculations c
JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id
LEFT JOIN LATERAL (
  SELECT n.shadow_diff_code
    FROM attendance_record_calculations n
   WHERE n.attendance_record_id = c.attendance_record_id
     AND n.mode = 'shadow'
     AND n.version > c.version
   ORDER BY n.version ASC
   LIMIT 1
) next_row ON true
WHERE c.org_id = :org
  AND c.mode = 'shadow'
  AND c.created_at >= :from::timestamptz
  AND c.created_at <  :to::timestamptz
  AND c.shadow_diff_code <> 'equal'
ORDER BY r.work_date, c.attendance_record_id, c.version;
