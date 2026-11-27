import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'

// Caller owns the canonical rollout lock and transaction. This counter admits
// no writer and changes no source data. Count distinct referenced multi-segment
// shifts, not the number of references; every source arm is explicitly org-scoped.
// FSER desired-only config is not an effective fact. Its apply/rebuild results
// are covered by active assignments; desired metadata and delete protection stay intact.
export async function countAttendanceActiveMultiSegmentShiftReferencesV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<number | null> {
  const result = await trx.query(
    `SELECT COUNT(*)::int AS total
       FROM attendance_shifts s
      WHERE s.org_id = $1
        AND EXISTS (
          SELECT 1 FROM attendance_shift_segments seg
           WHERE seg.org_id = $1 AND seg.shift_id = s.id
           GROUP BY seg.shift_id HAVING COUNT(*) > 1
        )
        AND (
          EXISTS (
            SELECT 1 FROM attendance_shift_assignments a
             WHERE a.org_id = $1 AND a.shift_id = s.id AND a.is_active = true
          )
          OR EXISTS (
            SELECT 1 FROM attendance_rotation_rules r
             WHERE r.org_id = $1 AND r.is_active = true
               AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(r.shift_sequence) AS seq(shift_ref)
                  WHERE (btrim(seq.shift_ref) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                         AND lower(btrim(seq.shift_ref)) = s.id::text)
                     OR (btrim(seq.shift_ref) = btrim(s.name)
                         AND NOT EXISTS (
                           SELECT 1 FROM attendance_shifts id_target
                            WHERE id_target.org_id = $1
                              AND btrim(seq.shift_ref) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                              AND id_target.id::text = lower(btrim(seq.shift_ref))
                         ))
               )
          )
          OR EXISTS (
            SELECT 1 FROM attendance_shift_swap_requests d
            JOIN attendance_requests r ON r.id = d.request_id AND r.org_id = $1
             WHERE d.org_id = $1 AND r.status = 'pending'
               AND (d.requester_shift_id = s.id OR d.counterparty_shift_id = s.id)
          )
          OR EXISTS (
            SELECT 1 FROM attendance_schedule_dispatch_requests d
             WHERE d.org_id = $1 AND d.target_shift_id = s.id
               AND d.publish_status IN ('pending', 'published')
          )
        )`,
    [orgId],
  )
  const count = result.rows[0]?.total
  return result.rows.length === 1 && typeof count === 'number'
    && Number.isSafeInteger(count) && count >= 0 ? count : null
}
