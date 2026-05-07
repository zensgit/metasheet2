export interface DingTalkGroupDelivery {
  id: string
  destinationId: string
  destinationName?: string
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
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

type DeliveryRow = {
  id: string
  destination_id: string
  destination_name: string | null
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
}

function mapDeliveryRow(row: DeliveryRow): DingTalkGroupDelivery {
  return {
    id: row.id,
    destinationId: row.destination_id,
    destinationName: row.destination_name ?? undefined,
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
  }
}

export async function listAutomationDingTalkGroupDeliveries(
  queryFn: QueryFn,
  ruleId: string,
  limit = 50,
  recordId = '',
): Promise<DingTalkGroupDelivery[]> {
  const normalizedLimit = Math.min(Math.max(limit, 1), 200)
  const normalizedRecordId = recordId.trim()
  const params: unknown[] = [ruleId]
  const recordFilter = normalizedRecordId ? ' AND d.record_id = $2' : ''
  if (normalizedRecordId) params.push(normalizedRecordId)
  params.push(normalizedLimit)
  const limitParam = params.length
  const result = await queryFn(
    `SELECT d.id,
            d.destination_id,
            g.name AS destination_name,
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
            d.delivered_at
       FROM dingtalk_group_deliveries d
       LEFT JOIN dingtalk_group_destinations g ON g.id = d.destination_id
      WHERE d.automation_rule_id = $1
        ${recordFilter}
      ORDER BY d.created_at DESC
      LIMIT $${limitParam}`,
    params,
  )

  return (result.rows as DeliveryRow[]).map(mapDeliveryRow)
}
