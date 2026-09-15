/**
 * The DingTalk todo mirror's ONE extra piece of configuration: `todoOperatorUnionId` — the unionId the
 * mirrored todo is created BY (design §6/§8.2).
 *
 * NOT A SECRET: a unionId is an opaque tenant-scoped identifier, so it is stored PLAINTEXT in
 * `directory_integrations.config` (unlike appSecret / workNotificationAgentId, which go through
 * security/encrypted-secrets). It is still never logged — the mirror's log discipline is values-free.
 *
 * PER-INTEGRATION ONLY, deliberately: the resolver takes the integration id the RECIPIENT resolved to
 * and reads THAT row, exactly like `resolveApprovalCardLinkSecretForIntegration`. There is NO
 * "first active dingtalk integration" fallback — creating corp A's todo as corp B's operator is a
 * cross-tenant write, not a convenience. An env override is also deliberately absent: one deployment
 * can host several corps, and a single env value would silently re-point all of them.
 *
 * FAIL-CLOSED: no row / no key / query failure → '' and the caller refuses to send (the row stays
 * retryable so the todo self-heals once the owner fills the key in).
 */
import { query as defaultQuery } from '../../db/pg'

export const DINGTALK_TODO_OPERATOR_UNION_ID_CONFIG_KEY = 'todoOperatorUnionId'

const DEFAULT_PROVIDER = 'dingtalk'

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {}
}

/**
 * Read `todoOperatorUnionId` off ONE integration row, scoped to the org that owns the mirror row.
 * `orgId` is part of the predicate (not just the id) so a mis-joined integration id can never read
 * another tenant's operator identity.
 */
export async function resolveDingTalkTodoOperatorUnionId(
  integrationId: string,
  orgId: string,
  queryFn: QueryFn = defaultQuery as unknown as QueryFn,
): Promise<string> {
  const normalizedIntegrationId = normalizeText(integrationId)
  const normalizedOrgId = normalizeText(orgId)
  if (!normalizedIntegrationId || !normalizedOrgId) return ''
  try {
    const result = await queryFn(
      `SELECT config
         FROM directory_integrations
        WHERE id = $1::uuid
          AND org_id = $2
          AND provider = $3
          AND status = 'active'
        LIMIT 1`,
      [normalizedIntegrationId, normalizedOrgId, DEFAULT_PROVIDER],
    )
    const row = (result.rows[0] ?? null) as { config?: unknown } | null
    if (!row) return ''
    return normalizeText(parseJsonRecord(row.config)[DINGTALK_TODO_OPERATOR_UNION_ID_CONFIG_KEY])
  } catch {
    // Fail-closed: an unreadable config must never fall back to "some other integration's operator".
    return ''
  }
}
