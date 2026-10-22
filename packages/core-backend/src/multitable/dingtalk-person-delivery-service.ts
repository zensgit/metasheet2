export interface DingTalkPersonDelivery {
  id: string
  localUserId: string
  dingtalkUserId?: string
  sourceType: string
  subject: string
  content: string
  success: boolean
  /** `outcome_unknown` (PR #4046 Phase B): send attempted, response lost — maybe delivered, never auto-resent. */
  status: 'success' | 'failed' | 'skipped' | 'outcome_unknown'
  httpStatus?: number
  responseBody?: string
  errorMessage?: string
  automationRuleId?: string
  recordId?: string
  initiatedBy?: string
  createdAt: string
  deliveredAt?: string
  localUserLabel?: string
  localUserSubtitle?: string
  /**
   * 客户反馈 2026-10-21 item 1 (review round 2): whether a user with this id exists NOW. A delivery row can
   * name an id with no user (a mistyped id): the viewer must say 未找到该用户 for it, not "inactive user".
   */
  localUserExists: boolean
  /** Current active flag; null when the user does not exist (unknown, not "inactive"). */
  localUserIsActive: boolean | null
}

/** Review round 2: the delivery list's optional server-side status filter (values-free, fixed set). */
export const DINGTALK_PERSON_DELIVERY_STATUS_FILTERS = ['success', 'failed', 'skipped', 'outcome_unknown'] as const
export type DingTalkPersonDeliveryStatusFilter = (typeof DINGTALK_PERSON_DELIVERY_STATUS_FILTERS)[number]

/** undefined = no filter; null = an invalid value (the route answers 400). */
export function parseDingTalkPersonDeliveryStatusFilter(value: unknown): DingTalkPersonDeliveryStatusFilter | undefined | null {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') return null
  return (DINGTALK_PERSON_DELIVERY_STATUS_FILTERS as readonly string[]).includes(value)
    ? value as DingTalkPersonDeliveryStatusFilter
    : null
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

type DeliveryRow = {
  id: string
  local_user_id: string
  dingtalk_user_id: string | null
  source_type: string
  subject: string
  content: string
  success: boolean
  status: string | null
  http_status: number | null
  response_body: string | null
  error_message: string | null
  automation_rule_id: string | null
  record_id: string | null
  initiated_by: string | null
  created_at: string
  delivered_at: string | null
  local_user_name: string | null
  local_user_email: string | null
  local_user_is_active: boolean | null
  local_user_exists?: boolean | null
}

function normalizeDeliveryStatus(status: string | null, success: boolean): DingTalkPersonDelivery['status'] {
  // outcome_unknown passes through unfolded (PR #4046 Phase B) — folding it into 'failed' would
  // erase the reconciliation signal the distinct state exists for.
  if (status === 'success' || status === 'failed' || status === 'skipped' || status === 'outcome_unknown') return status
  return success ? 'success' : 'failed'
}

function mapDeliveryRow(row: DeliveryRow): DingTalkPersonDelivery {
  return {
    id: row.id,
    localUserId: row.local_user_id,
    dingtalkUserId: row.dingtalk_user_id ?? undefined,
    sourceType: row.source_type,
    subject: row.subject,
    content: row.content,
    success: row.success,
    status: normalizeDeliveryStatus(row.status, row.success),
    httpStatus: row.http_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    errorMessage: row.error_message ?? undefined,
    automationRuleId: row.automation_rule_id ?? undefined,
    recordId: row.record_id ?? undefined,
    initiatedBy: row.initiated_by ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    localUserLabel: row.local_user_name ?? undefined,
    localUserSubtitle: row.local_user_email ?? undefined,
    localUserExists: row.local_user_exists === true,
    localUserIsActive: row.local_user_exists === true ? row.local_user_is_active === true : null,
  }
}

export async function listAutomationDingTalkPersonDeliveries(
  queryFn: QueryFn,
  ruleId: string,
  limit = 50,
  options: { status?: DingTalkPersonDeliveryStatusFilter } = {},
): Promise<DingTalkPersonDelivery[]> {
  const normalizedLimit = Math.min(Math.max(limit, 1), 200)
  // Review round 2: the run log's 「查看钉钉个人消息投递记录」 opens on skipped rows — filtered HERE, before the
  // LIMIT, so skipped rows older than the latest page are not lost. Same normalisation as mapDeliveryRow.
  const status = options.status && (DINGTALK_PERSON_DELIVERY_STATUS_FILTERS as readonly string[]).includes(options.status)
    ? options.status
    : undefined
  const result = await queryFn(
    `SELECT d.id,
            d.local_user_id,
            d.dingtalk_user_id,
            d.source_type,
            d.subject,
            d.content,
            d.success,
            d.status,
            d.http_status,
            d.response_body,
            d.error_message,
            d.automation_rule_id,
            d.record_id,
            d.initiated_by,
            d.created_at,
            d.delivered_at,
            u.name AS local_user_name,
            u.email AS local_user_email,
            u.is_active AS local_user_is_active,
            (u.id IS NOT NULL) AS local_user_exists
       FROM dingtalk_person_deliveries d
       LEFT JOIN users u ON u.id = d.local_user_id
      WHERE d.automation_rule_id = $1${status ? `
        AND (CASE
               WHEN d.status IN ('success', 'failed', 'skipped', 'outcome_unknown') THEN d.status
               WHEN d.success THEN 'success'
               ELSE 'failed'
             END) = $3` : ''}
      ORDER BY d.created_at DESC
      LIMIT $2`,
    status ? [ruleId, normalizedLimit, status] : [ruleId, normalizedLimit],
  )

  return (result.rows as DeliveryRow[]).map(mapDeliveryRow)
}
