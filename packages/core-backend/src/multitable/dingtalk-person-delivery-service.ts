export interface DingTalkPersonDelivery {
  id: string
  localUserId: string
  dingtalkUserId?: string
  sourceType: string
  subject: string
  content: string
  success: boolean
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
  localUserIsActive: boolean
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
    localUserIsActive: row.local_user_is_active ?? false,
  }
}

export async function listAutomationDingTalkPersonDeliveries(
  queryFn: QueryFn,
  ruleId: string,
  limit = 50,
): Promise<DingTalkPersonDelivery[]> {
  const normalizedLimit = Math.min(Math.max(limit, 1), 200)
  const result = await queryFn(
    `SELECT d.id,
            d.local_user_id,
            d.dingtalk_user_id,
            d.source_type,
            d.subject,
            d.content,
            d.success,
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
            u.is_active AS local_user_is_active
       FROM dingtalk_person_deliveries d
       LEFT JOIN users u ON u.id = d.local_user_id
      WHERE d.automation_rule_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [ruleId, normalizedLimit],
  )

  return (result.rows as DeliveryRow[]).map(mapDeliveryRow)
}
