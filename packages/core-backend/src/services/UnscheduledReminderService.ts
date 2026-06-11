import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'

/**
 * ⑤ Unscheduled-shift reminder job (design-lock attendance-unscheduled-reminder-design-lock-20260604).
 *
 * A SECOND job for the C4 AttendanceScheduler (NOT a second scheduler). Each tick it scans for members of
 * `scheduled_shift` attendance groups who have NO schedule coverage for an upcoming date, CLAIMS each as a
 * dispatch row (UNIQUE index → at-most-once, mirrors ④'s status-claim), and produces per-recipient C5
 * outbox rows. The delivery worker is the only component that may turn those rows into external sends.
 *
 * Default OFF: only wired when ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED=true (see AttendanceScheduler).
 */

export type UnscheduledReminderQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export interface UnscheduledReminderCandidate {
  orgId: string
  userId: string
}

export interface UnscheduledReminderResult {
  targetDate: string
  claimed: number
  deliveries: number
}

export interface UnscheduledReminderServiceOptions {
  query?: UnscheduledReminderQuery
  lookaheadDays?: number
  now?: () => Date
  logger?: Logger
}

interface CandidateRow {
  org_id: string
  user_id: string
}

interface DispatchRow {
  id: string
  org_id: string
  user_id: string
  target_date: string
  reminder_type: string
}

const DEFAULT_LOOKAHEAD_DAYS = 1
const MIN_LOOKAHEAD_DAYS = 1
const MAX_LOOKAHEAD_DAYS = 14
const REMINDER_TYPE = 'unscheduled'
const SOURCE_TYPE = 'unscheduled_reminder'
const DELIVERY_CHANNEL = 'dingtalk_work_notification'
const INACTIVE_RECIPIENT_ERROR = 'recipient_inactive_or_missing'
// Must equal the plugin predicate's ATTENDANCE_SCHEDULE_OPEN_END_DATE (index.cjs) — parity-locked by the
// integration test that compares scanCandidates() to isUserScheduledForDate().
const OPEN_END_DATE = '9999-12-31'

export function clampLookaheadDays(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LOOKAHEAD_DAYS
  return Math.min(MAX_LOOKAHEAD_DAYS, Math.max(MIN_LOOKAHEAD_DAYS, Math.floor(n)))
}

/**
 * Set-based scan that MIRRORS plugins/plugin-attendance/index.cjs `isUserScheduledForDate` (the shared
 * predicate the punch path also uses). Keep these in sync — the integration test asserts parity against
 * the exported predicate, so a divergence fails CI.
 *
 *  - the `bool_and(attendance_type = 'scheduled_shift')` HAVING == the predicate's applicability guard
 *    ("unscheduled" only when the user is in >=1 group AND every group is scheduled_shift; a user with no
 *    group has no row here ⇒ never a candidate, matching the predicate's `groupRows.length === 0 ⇒ true`).
 *  - the two NOT EXISTS == the predicate's coverage check (schedule-group membership OR shift assignment
 *    covering the date), same open-end sentinel.
 */
const SCAN_SQL = `
  WITH eligible AS (
    SELECT m.org_id, m.user_id
    FROM attendance_group_members m
    JOIN attendance_groups g ON g.id = m.group_id AND g.org_id = m.org_id
    GROUP BY m.org_id, m.user_id
    HAVING bool_and(g.attendance_type = 'scheduled_shift')
  )
  SELECT e.org_id, e.user_id
  FROM eligible e
  WHERE NOT EXISTS (
    SELECT 1 FROM attendance_schedule_group_members sgm
    WHERE sgm.org_id = e.org_id AND sgm.user_id = e.user_id AND sgm.schedule_group_id IS NOT NULL
      AND COALESCE(sgm.effective_from, DATE '0001-01-01') <= $1::date
      AND COALESCE(sgm.effective_to, DATE '${OPEN_END_DATE}') >= $1::date
  )
  AND NOT EXISTS (
    SELECT 1 FROM attendance_shift_assignments sa
    WHERE sa.org_id = e.org_id AND sa.user_id = e.user_id AND COALESCE(sa.is_active, true) = true
      AND COALESCE(sa.publish_status, 'published') = 'published'
      AND sa.start_date <= $1::date
      AND COALESCE(sa.end_date, DATE '${OPEN_END_DATE}') >= $1::date
  )
`

export class UnscheduledReminderService {
  private readonly query: UnscheduledReminderQuery
  private readonly lookaheadDays: number
  private readonly now: () => Date
  private readonly logger: Logger
  private running = false

  constructor(options: UnscheduledReminderServiceOptions = {}) {
    this.query = options.query ?? (defaultQuery as UnscheduledReminderQuery)
    this.lookaheadDays = clampLookaheadDays(options.lookaheadDays)
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('UnscheduledReminderService')
  }

  /** The upcoming date to remind about: today's UTC date + lookaheadDays (tz-aware target = deferred). */
  computeTargetDate(): string {
    const base = this.now()
    const utc = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()))
    utc.setUTCDate(utc.getUTCDate() + this.lookaheadDays)
    return utc.toISOString().slice(0, 10)
  }

  /** Pure read: the unscheduled candidates for `targetDate`. No side effects (used by the parity test). */
  async scanCandidates(targetDate: string): Promise<UnscheduledReminderCandidate[]> {
    const { rows } = await this.query<CandidateRow>(SCAN_SQL, [targetDate])
    return rows.map((row) => ({ orgId: row.org_id, userId: row.user_id }))
  }

  async claimDispatches(targetDate: string): Promise<DispatchRow[]> {
    const { rows } = await this.query<DispatchRow>(
      `INSERT INTO attendance_unscheduled_reminder_dispatch (org_id, user_id, target_date, reminder_type)
       SELECT c.org_id, c.user_id, $1::date, '${REMINDER_TYPE}'
       FROM ( ${SCAN_SQL} ) c
       ON CONFLICT (org_id, user_id, target_date, reminder_type) DO NOTHING
       RETURNING id::text AS id, org_id, user_id, target_date::text AS target_date, reminder_type`,
      [targetDate],
    )
    return rows
  }

  async findDispatchesMissingDeliveries(): Promise<DispatchRow[]> {
    const { rows } = await this.query<DispatchRow>(
      `SELECT d.id::text AS id, d.org_id, d.user_id, d.target_date::text AS target_date, d.reminder_type
       FROM attendance_unscheduled_reminder_dispatch d
       WHERE NOT EXISTS (
         SELECT 1
         FROM attendance_notification_deliveries nd
         WHERE nd.org_id = d.org_id
           AND nd.source_type = '${SOURCE_TYPE}'
           AND nd.source_id = d.id::text
       )
       ORDER BY d.created_at ASC, d.id ASC`,
    )
    return rows
  }

  async produceDeliveriesForDispatches(dispatches: DispatchRow[]): Promise<number> {
    if (dispatches.length === 0) return 0
    const { rows } = await this.query<{ id: string }>(
      `WITH dispatches AS (
         SELECT id, org_id, user_id, target_date, reminder_type
         FROM attendance_unscheduled_reminder_dispatch
         WHERE id = ANY($1::uuid[])
       ),
       candidate_recipients AS (
         SELECT d.id::text AS id, d.org_id, d.user_id, d.target_date::text AS target_date, d.reminder_type,
                d.user_id AS recipient_user_id, 'subject'::text AS recipient_role, NULL::uuid AS group_id
         FROM dispatches d
         UNION ALL
         SELECT d.id::text AS id, d.org_id, d.user_id, d.target_date::text AS target_date, d.reminder_type,
                gm.user_id AS recipient_user_id, gm.role AS recipient_role, gm.group_id
         FROM dispatches d
         JOIN attendance_group_members m
           ON m.org_id = d.org_id
          AND m.user_id = d.user_id
         JOIN attendance_group_managers gm
           ON gm.org_id = d.org_id
          AND gm.group_id = m.group_id
          AND gm.role IN ('owner','sub_owner')
       ),
       recipient_rows AS (
         SELECT c.id, c.org_id, c.user_id, c.target_date::text AS target_date, c.reminder_type,
                c.recipient_user_id,
                CASE
                  WHEN bool_or(c.recipient_role = 'subject') THEN 'subject'
                  WHEN bool_or(c.recipient_role = 'owner') THEN 'owner'
                  ELSE 'sub_owner'
                END AS recipient_role,
                array_remove(ARRAY[
                  CASE WHEN bool_or(c.recipient_role = 'subject') THEN 'subject' END,
                  CASE WHEN bool_or(c.recipient_role = 'owner') THEN 'owner' END,
                  CASE WHEN bool_or(c.recipient_role = 'sub_owner') THEN 'sub_owner' END
                ], NULL) AS recipient_roles,
                COALESCE(
                  array_agg(DISTINCT c.group_id::text) FILTER (WHERE c.group_id IS NOT NULL),
                  ARRAY[]::text[]
                ) AS group_ids,
                COALESCE(bool_or(u.is_active IS TRUE), false) AS is_active
         FROM candidate_recipients c
         LEFT JOIN users u ON u.id = c.recipient_user_id
         GROUP BY c.id, c.org_id, c.user_id, c.target_date, c.reminder_type, c.recipient_user_id
       )
       INSERT INTO attendance_notification_deliveries
         (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, last_error, payload)
       SELECT r.org_id,
              '${SOURCE_TYPE}',
              r.id::text,
              'unscheduled:' || r.id::text || ':recipient:' || r.recipient_user_id || ':channel:${DELIVERY_CHANNEL}',
              r.recipient_user_id,
              r.recipient_role,
              '${DELIVERY_CHANNEL}',
              CASE WHEN r.is_active THEN 'pending' ELSE 'skipped' END,
              CASE WHEN r.is_active THEN NULL ELSE '${INACTIVE_RECIPIENT_ERROR}' END,
              jsonb_build_object(
                'kind', 'unscheduled_shift_reminder',
                'title', 'Unscheduled shift reminder',
                'body', 'No schedule is assigned for ' || r.target_date || '.',
                'sourceType', '${SOURCE_TYPE}',
                'dispatchId', r.id::text,
                'targetDate', r.target_date,
                'reminderType', r.reminder_type,
                'subjectUserId', r.user_id,
                'recipientUserId', r.recipient_user_id,
                'recipientRole', r.recipient_role,
                'recipientRoles', r.recipient_roles,
                'groupIds', r.group_ids
              )
       FROM recipient_rows r
       ON CONFLICT (org_id, source_key) DO NOTHING
       RETURNING id::text AS id`,
      [dispatches.map((dispatch) => dispatch.id)],
    )
    return rows.length
  }

  /**
   * Scan → claim (at-most-once) → produce C5 outbox rows. A re-entrancy guard (mirrors the expiry
   * tick's `running` flag) keeps a slow scan from overlapping itself; the UNIQUE-constraint claim and
   * delivery source_key already make overlap merely wasteful, not wrong.
   */
  async run(): Promise<UnscheduledReminderResult> {
    const targetDate = this.computeTargetDate()
    if (this.running) return { targetDate, claimed: 0, deliveries: 0 }
    this.running = true
    try {
      const claimed = await this.claimDispatches(targetDate)
      const pendingDispatches = await this.findDispatchesMissingDeliveries()
      const deliveries = await this.produceDeliveriesForDispatches(pendingDispatches)
      this.logger.info(
        `Unscheduled-shift reminders claimed=${claimed.length} deliveries=${deliveries} target=${targetDate}`,
      )
      return { targetDate, claimed: claimed.length, deliveries }
    } finally {
      this.running = false
    }
  }
}
