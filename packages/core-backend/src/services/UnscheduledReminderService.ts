import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'
import {
  AttendanceNotifier,
  type AttendanceNotificationMessage,
} from './AttendanceNotifier'

/**
 * ⑤ Unscheduled-shift reminder job (design-lock attendance-unscheduled-reminder-design-lock-20260604).
 *
 * A SECOND job for the C4 AttendanceScheduler (NOT a second scheduler). Each tick it scans for members of
 * `scheduled_shift` attendance groups who have NO schedule coverage for an upcoming date, CLAIMS each as a
 * dispatch row (UNIQUE index → at-most-once, mirrors ④'s status-claim), and routes the newly-claimed rows
 * through the AttendanceNotifier. Default = no channels ⇒ no external send; the claimed dispatch row is the
 * v1 internal reminder record. Real channels = C5.
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
  dispatched: number
}

export interface UnscheduledReminderServiceOptions {
  query?: UnscheduledReminderQuery
  notifier?: AttendanceNotifier
  lookaheadDays?: number
  now?: () => Date
  logger?: Logger
}

interface CandidateRow {
  org_id: string
  user_id: string
}

const DEFAULT_LOOKAHEAD_DAYS = 1
const MIN_LOOKAHEAD_DAYS = 1
const MAX_LOOKAHEAD_DAYS = 14
const REMINDER_TYPE = 'unscheduled'
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
      AND sa.start_date <= $1::date
      AND COALESCE(sa.end_date, DATE '${OPEN_END_DATE}') >= $1::date
  )
`

export class UnscheduledReminderService {
  private readonly query: UnscheduledReminderQuery
  private readonly notifier: AttendanceNotifier
  private readonly lookaheadDays: number
  private readonly now: () => Date
  private readonly logger: Logger
  private running = false

  constructor(options: UnscheduledReminderServiceOptions = {}) {
    this.query = options.query ?? (defaultQuery as UnscheduledReminderQuery)
    this.notifier = options.notifier ?? new AttendanceNotifier()
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

  /**
   * Scan → claim (at-most-once) → dispatch. A re-entrancy guard (mirrors the expiry tick's `running` flag)
   * keeps a slow scan from overlapping itself; the UNIQUE-constraint claim already makes overlap merely
   * wasteful, not wrong.
   */
  async run(): Promise<UnscheduledReminderResult> {
    const targetDate = this.computeTargetDate()
    if (this.running) return { targetDate, claimed: 0, dispatched: 0 }
    this.running = true
    try {
      // Scan + claim atomically. RETURNING yields ONLY the rows this statement inserted (won the claim);
      // a repeat/concurrent tick conflicts on the unique index and returns nothing → no double reminder.
      const { rows } = await this.query<CandidateRow>(
        `INSERT INTO attendance_unscheduled_reminder_dispatch (org_id, user_id, target_date, reminder_type)
         SELECT c.org_id, c.user_id, $1::date, '${REMINDER_TYPE}'
         FROM ( ${SCAN_SQL} ) c
         ON CONFLICT (org_id, user_id, target_date, reminder_type) DO NOTHING
         RETURNING org_id, user_id`,
        [targetDate],
      )
      const claimed = rows.map((row) => ({ orgId: row.org_id, userId: row.user_id }))
      if (claimed.length === 0) return { targetDate, claimed: 0, dispatched: 0 }

      const messages: AttendanceNotificationMessage[] = claimed.map((c) => ({
        orgId: c.orgId,
        userId: c.userId,
        kind: 'unscheduled_shift_reminder',
        text: `No schedule is assigned for ${targetDate}.`,
      }))
      const dispatch = await this.notifier.notify(messages)
      this.logger.info(
        `Unscheduled-shift reminders claimed=${claimed.length} dispatched=${dispatch.sent} target=${targetDate}`,
      )
      return { targetDate, claimed: claimed.length, dispatched: dispatch.sent }
    } finally {
      this.running = false
    }
  }
}
