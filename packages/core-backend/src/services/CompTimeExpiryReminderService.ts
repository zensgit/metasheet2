import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'
import { resolveAttendanceDefaultDeliveryChannel } from './AttendanceNotificationDeliveryWorker'

/**
 * C5-1b comp-time expiry reminder producer.
 *
 * This job scans active `comp_time` grant lots approaching `expires_at` and produces C5 delivery
 * outbox rows for the balance owner plus current attendance group owners/sub-owners. It never mutates
 * the balance lot; C4's expiry state-flow remains the only path that changes lot status/remaining.
 */

export type CompTimeExpiryReminderQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export interface CompTimeExpiryReminderCandidate {
  orgId: string
  userId: string
  balanceId: string
  expiresAt: string
  windowDate: string
  remainingMinutes: number
}

export interface CompTimeExpiryReminderResult {
  candidates: number
  deliveries: number
}

export interface CompTimeExpiryReminderServiceOptions {
  query?: CompTimeExpiryReminderQuery
  lookaheadDays?: number
  now?: () => Date
  logger?: Logger
}

interface CandidateRow {
  org_id: string
  user_id: string
  balance_id: string
  expires_at: string
  window_date: string
  remaining_minutes: number | string
}

const DEFAULT_LOOKAHEAD_DAYS = 7
const MIN_LOOKAHEAD_DAYS = 1
const MAX_LOOKAHEAD_DAYS = 30
const SOURCE_TYPE = 'comp_time_expiry_reminder'
// S2: the producer stamps each outbox row with the deployment's default delivery channel
// (ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL), defaulting to the in-app work-notification channel —
// unchanged until configured. Allowlist-validated inside the resolver, so it is safe to interpolate.
const DELIVERY_CHANNEL = resolveAttendanceDefaultDeliveryChannel()
const INACTIVE_RECIPIENT_ERROR = 'recipient_inactive_or_missing'

export function clampCompTimeExpiryReminderLookaheadDays(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LOOKAHEAD_DAYS
  return Math.min(MAX_LOOKAHEAD_DAYS, Math.max(MIN_LOOKAHEAD_DAYS, Math.floor(n)))
}

const CANDIDATE_SQL = `
  SELECT b.org_id,
         b.user_id,
         b.id::text AS balance_id,
         b.expires_at::text AS expires_at,
         ((b.expires_at AT TIME ZONE 'UTC')::date)::text AS window_date,
         b.remaining_minutes
    FROM attendance_leave_balances b
   WHERE b.leave_type_code = 'comp_time'
     AND b.status = 'active'
     AND b.remaining_minutes > 0
     AND b.expires_at IS NOT NULL
     AND b.expires_at > $1::timestamptz
     AND b.expires_at <= $1::timestamptz + ($2::int * interval '24 hours')
`

export class CompTimeExpiryReminderService {
  private readonly query: CompTimeExpiryReminderQuery
  private readonly lookaheadDays: number
  private readonly now: () => Date
  private readonly logger: Logger
  private running = false

  constructor(options: CompTimeExpiryReminderServiceOptions = {}) {
    this.query = options.query ?? (defaultQuery as CompTimeExpiryReminderQuery)
    this.lookaheadDays = clampCompTimeExpiryReminderLookaheadDays(options.lookaheadDays)
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('CompTimeExpiryReminderService')
  }

  async scanCandidates(): Promise<CompTimeExpiryReminderCandidate[]> {
    const asOf = this.now().toISOString()
    const { rows } = await this.query<CandidateRow>(
      `${CANDIDATE_SQL}
       ORDER BY b.expires_at ASC, b.id ASC`,
      [asOf, this.lookaheadDays],
    )
    return rows.map((row) => ({
      orgId: row.org_id,
      userId: row.user_id,
      balanceId: row.balance_id,
      expiresAt: row.expires_at,
      windowDate: row.window_date,
      remainingMinutes: Number(row.remaining_minutes),
    }))
  }

  async produceDeliveries(): Promise<number> {
    const asOf = this.now().toISOString()
    const { rows } = await this.query<{ id: string }>(
      `WITH candidate_balances AS (
         ${CANDIDATE_SQL}
       ),
       candidate_recipients AS (
         SELECT b.org_id, b.user_id, b.balance_id, b.expires_at, b.window_date, b.remaining_minutes,
                b.user_id AS recipient_user_id, 'subject'::text AS recipient_role, NULL::uuid AS group_id
         FROM candidate_balances b
         UNION ALL
         SELECT b.org_id, b.user_id, b.balance_id, b.expires_at, b.window_date, b.remaining_minutes,
                gm.user_id AS recipient_user_id, gm.role AS recipient_role, gm.group_id
         FROM candidate_balances b
         JOIN attendance_group_members m
           ON m.org_id = b.org_id
          AND m.user_id = b.user_id
         JOIN attendance_group_managers gm
           ON gm.org_id = b.org_id
          AND gm.group_id = m.group_id
          AND gm.role IN ('owner','sub_owner')
       ),
       recipient_rows AS (
         SELECT c.org_id,
                c.user_id,
                c.balance_id,
                c.expires_at,
                c.window_date,
                c.remaining_minutes,
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
         GROUP BY c.org_id, c.user_id, c.balance_id, c.expires_at, c.window_date, c.remaining_minutes, c.recipient_user_id
       )
       INSERT INTO attendance_notification_deliveries
         (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, last_error, payload)
       SELECT r.org_id,
              '${SOURCE_TYPE}',
              r.balance_id,
              '${SOURCE_TYPE}:' || r.balance_id || ':' || r.window_date || ':recipient:' || r.recipient_user_id || ':channel:${DELIVERY_CHANNEL}',
              r.recipient_user_id,
              r.recipient_role,
              '${DELIVERY_CHANNEL}',
              CASE WHEN r.is_active THEN 'pending' ELSE 'skipped' END,
              CASE WHEN r.is_active THEN NULL ELSE '${INACTIVE_RECIPIENT_ERROR}' END,
              jsonb_build_object(
                'kind', 'comp_time_expiry_reminder',
                'title', 'Comp-time expiry reminder',
                'body', 'Comp-time balance expires on ' || r.window_date || '.',
                'sourceType', '${SOURCE_TYPE}',
                'balanceId', r.balance_id,
                'expiresAt', r.expires_at,
                'windowDate', r.window_date,
                'remainingMinutes', r.remaining_minutes,
                'subjectUserId', r.user_id,
                'recipientUserId', r.recipient_user_id,
                'recipientRole', r.recipient_role,
                'recipientRoles', r.recipient_roles,
                'groupIds', r.group_ids
              )
       FROM recipient_rows r
       ON CONFLICT (org_id, source_key) DO NOTHING
       RETURNING id::text AS id`,
      [asOf, this.lookaheadDays],
    )
    return rows.length
  }

  async run(): Promise<CompTimeExpiryReminderResult> {
    if (this.running) return { candidates: 0, deliveries: 0 }
    this.running = true
    try {
      const candidates = await this.scanCandidates()
      const deliveries = await this.produceDeliveries()
      this.logger.info(
        `Comp-time expiry reminders candidates=${candidates.length} deliveries=${deliveries} lookaheadDays=${this.lookaheadDays}`,
      )
      return { candidates: candidates.length, deliveries }
    } finally {
      this.running = false
    }
  }
}
