import { query as defaultQuery } from '../db/pg'

export type AttendanceExpiryQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export interface ExpiredCompTimeBalance {
  orgId: string
  userId: string
  balanceId: string
  expiredMinutes: number
}

interface ExpiredCompTimeBalanceRow {
  org_id: string
  user_id: string
  balance_id: string
  expired_minutes: number | string
}

export class AttendanceExpiryService {
  constructor(private readonly query: AttendanceExpiryQuery = defaultQuery as AttendanceExpiryQuery) {}

  // Expires every aged lot across ALL leave types (#2622 §5: the scan has no leave-type filter). The
  // expire event's source_type is derived per leave_type_code (comp_time → comp_time_expiry, annual →
  // annual_leave_expiry, else {type}_expiry) inside the single atomic statement, preserving the #2267
  // claim (events bound to the UPDATE RETURNING → a dup/leader-failed tick writes 0 events). The
  // comp_time-era method/type names are kept so the ④ C4-1 no-regress test re-runs verbatim.
  async expireCompTimeBalances(): Promise<ExpiredCompTimeBalance[]> {
    const result = await this.query<ExpiredCompTimeBalanceRow>(
      `WITH candidates AS (
         SELECT id, org_id, user_id, remaining_minutes
           FROM attendance_leave_balances
          WHERE status = 'active'
            AND remaining_minutes > 0
            AND expires_at IS NOT NULL
            AND expires_at <= now()
          FOR UPDATE SKIP LOCKED
       ),
       expired AS (
         UPDATE attendance_leave_balances b
            SET status = 'expired',
                remaining_minutes = 0,
                updated_at = now()
           FROM candidates c
          WHERE b.id = c.id
            AND b.status = 'active'
            AND b.remaining_minutes > 0
            AND b.expires_at IS NOT NULL
            AND b.expires_at <= now()
          RETURNING b.org_id, b.user_id, b.id AS balance_id, c.remaining_minutes AS expired_minutes, b.leave_type_code
       ),
       inserted_events AS (
         INSERT INTO attendance_leave_balance_events
           (org_id, user_id, balance_id, event_type, delta_minutes, source_type)
         SELECT org_id, user_id, balance_id, 'expire', -expired_minutes,
                CASE leave_type_code
                  WHEN 'comp_time' THEN 'comp_time_expiry'
                  WHEN 'annual' THEN 'annual_leave_expiry'
                  ELSE leave_type_code || '_expiry'
                END
           FROM expired
         RETURNING balance_id
       )
       SELECT e.org_id, e.user_id, e.balance_id, e.expired_minutes
         FROM expired e
         JOIN inserted_events ev ON ev.balance_id = e.balance_id
        ORDER BY e.balance_id`,
    )

    return result.rows.map((row) => ({
      orgId: row.org_id,
      userId: row.user_id,
      balanceId: row.balance_id,
      expiredMinutes: Number(row.expired_minutes),
    }))
  }
}

let sharedExpiryService: AttendanceExpiryService | null = null

export function getAttendanceExpiryService(): AttendanceExpiryService {
  if (!sharedExpiryService) sharedExpiryService = new AttendanceExpiryService()
  return sharedExpiryService
}
