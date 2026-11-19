import { query } from '../db/pg'
import type { QueryResultRow } from 'pg'

const oldRows = `SELECT id, created_at, event_type, event_category, event_severity, action,
  resource_type, resource_id, user_id, user_name, user_email, action_details, error_code,
  COALESCE(action_details->>'adminUserId', user_id::text) AS actor_id,
  'audit_logs'::text AS source, id::text AS source_id
  FROM audit_logs`
const operationRows = `SELECT NULL::bigint AS id, a.created_at,
  'AUTHORIZATION_OPERATION'::text AS event_type, 'SYSTEM'::text AS event_category,
  'INFO'::text AS event_severity,
  CASE WHEN r.action->'action'->>'kind' IN ('role.assign','direct.grant','template.apply') THEN 'grant'
       WHEN r.action->'action'->>'kind' IN ('role.revoke','direct.revoke','legacy.revoke') THEN 'revoke'
       ELSE 'update' END AS action,
  CASE WHEN r.action->'action'->>'kind' = 'legacy.revoke' THEN 'legacy-permission'
       WHEN r.action->'action'->>'kind' = 'template.apply' THEN 'permission-template'
       WHEN r.action->'action'->>'kind' IN ('direct.grant','direct.revoke') THEN 'permission'
       WHEN r.action->'action'->>'kind' IN ('role.assign','role.revoke') THEN 'user-role'
       ELSE 'user-namespace-admission' END AS resource_type,
  r.target_user_id AS resource_id, NULL::integer AS user_id, NULL::text AS user_name,
  NULL::text AS user_email,
  jsonb_build_object('operationKind', r.action->'action'->>'kind', 'operation', r.action->'action',
    'reason', a.reason, 'reasonOrigin', a.reason_origin, 'impact', a.impact,
    'clientOperationId', a.client_operation_id::text) AS action_details,
  NULL::text AS error_code, a.actor_id, 'authorization_operation'::text AS source,
  a.actor_id || ':' || a.client_operation_id::text AS source_id
  FROM authorization_operation_audit a
  JOIN authorization_operation_receipts r ON r.actor_id = a.actor_id AND r.client_operation_id = a.client_operation_id`

/** Only a specifically missing new evidence relation permits an old-schema fallback. */
function missingEvidenceRelation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const pg = error as { code?: unknown; message?: unknown }
  return pg.code === '42P01' && typeof pg.message === 'string'
    && /^relation "(?:[^".]+\.)?authorization_operation_(?:audit|receipts)" does not exist$/.test(pg.message)
}

/** `$AUDIT_FEED` is an internal SQL marker, never derived from a request. */
export async function queryAdminAuditFeed<T extends QueryResultRow>(sql: string, params: unknown[]) {
  const run = (includeOperations: boolean) => query<T>(
    sql.replace('$AUDIT_FEED', `(${oldRows}${includeOperations ? ` UNION ALL ${operationRows}` : ''}) AS audit_feed`), params,
  )
  try { return await run(true) }
  catch (error) {
    if (!missingEvidenceRelation(error)) throw error
    return run(false)
  }
}
