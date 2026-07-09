/**
 * DT-OPS-03 — deliver directory-sync failure alerts somewhere a human will see them.
 *
 * `directory_sync_alerts` has carried a `sent_to_webhook` column since it was created and
 * nothing ever sent anything: a nightly sync that fails because the app secret rotated
 * simply accumulates rows in a table nobody opens. The irony is that the product already
 * owns the channel — a DingTalk group robot — so "the DingTalk sync broke" can be
 * announced over DingTalk.
 *
 * Discipline, matching `breach-channels`:
 *  - the channel exists only when its env is configured (no channel, no noise, no
 *    per-tick warnings under retry);
 *  - delivery is best-effort and NEVER fails the sync. A sync that succeeded must not be
 *    reported as failed because a webhook was down;
 *  - the webhook URL is SSRF-pinned and HMAC-signed by the same `robot.ts` primitives the
 *    automation line uses, and it is masked in every log line.
 */
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  normalizeDingTalkRobotSecret,
  normalizeDingTalkRobotWebhookUrl,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import { maskDingTalkWebhookUrl } from '../integrations/dingtalk/runtime-policy'

const logger = new Logger('DirectorySyncAlertDelivery')

export type DirectorySyncAlertDeliveryConfig = {
  webhookUrl: string
  secret?: string
}

export function readDirectorySyncAlertWebhookConfig(): DirectorySyncAlertDeliveryConfig | null {
  const rawUrl = String(process.env.DIRECTORY_SYNC_ALERT_WEBHOOK ?? '').trim()
  if (!rawUrl) return null
  try {
    return {
      webhookUrl: normalizeDingTalkRobotWebhookUrl(rawUrl),
      secret: normalizeDingTalkRobotSecret(process.env.DIRECTORY_SYNC_ALERT_WEBHOOK_SECRET),
    }
  } catch (error) {
    // A malformed webhook must not be retried on every failure; say so once, loudly.
    logger.warn(
      `DIRECTORY_SYNC_ALERT_WEBHOOK is set but not a valid DingTalk robot URL: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/**
 * How many consecutive failed runs this integration has now had. Repeated failure is the
 * signal worth escalating — a single blip is noise, three nights in a row is an outage.
 */
export async function countConsecutiveFailedRuns(
  integrationId: string,
  queryFn: typeof query = query,
): Promise<number> {
  const result = await queryFn<{ status: string }>(
    `SELECT status
       FROM directory_sync_runs
      WHERE integration_id = $1 AND status IN ('completed', 'failed')
      ORDER BY started_at DESC
      LIMIT 20`,
    [integrationId],
  )
  let streak = 0
  for (const row of result.rows) {
    if (row.status !== 'failed') break
    streak += 1
  }
  return streak
}

export function buildDirectorySyncAlertMessage(options: {
  integrationName: string
  runId: string
  message: string
  consecutiveFailures: number
}): { subject: string; content: string } {
  const subject = options.consecutiveFailures > 1
    ? `钉钉目录同步连续失败 ${options.consecutiveFailures} 次`
    : '钉钉目录同步失败'
  const content = [
    `- 集成：${options.integrationName}`,
    `- 运行：${options.runId}`,
    `- 连续失败：${options.consecutiveFailures} 次`,
    `- 原因：${options.message}`,
  ].join('\n')
  return { subject, content }
}

/**
 * Best-effort delivery. Returns whether the alert actually went out, so the caller can
 * flip `sent_to_webhook`. Never throws.
 */
export async function deliverDirectorySyncFailureAlert(
  options: {
    integrationId: string
    integrationName: string
    runId: string
    message: string
  },
  deps: {
    config?: DirectorySyncAlertDeliveryConfig | null
    fetchFn?: typeof fetch
    queryFn?: typeof query
  } = {},
): Promise<boolean> {
  const config = deps.config !== undefined ? deps.config : readDirectorySyncAlertWebhookConfig()
  if (!config) return false

  const fetchFn = deps.fetchFn ?? fetch
  const queryFn = deps.queryFn ?? query

  try {
    const consecutiveFailures = await countConsecutiveFailedRuns(options.integrationId, queryFn)
    const { subject, content } = buildDirectorySyncAlertMessage({
      integrationName: options.integrationName,
      runId: options.runId,
      message: options.message,
      consecutiveFailures,
    })

    const signedUrl = buildSignedDingTalkWebhookUrl(config.webhookUrl, config.secret)
    const response = await fetchFn(signedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDingTalkMarkdown(subject, content)),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      logger.warn(`Directory sync alert webhook returned HTTP ${response.status} (${maskDingTalkWebhookUrl(config.webhookUrl)})`)
      return false
    }
    validateDingTalkRobotResponse(await response.json().catch(() => null))

    await queryFn(
      `UPDATE directory_sync_alerts
          SET sent_to_webhook = TRUE, updated_at = NOW()
        WHERE run_id = $1 AND code = 'sync_failed'`,
      [options.runId],
    )
    logger.info(`Directory sync failure alert delivered for run ${options.runId}`)
    return true
  } catch (error) {
    // A failed sync must never be made worse by a failed alert.
    logger.warn(
      `Failed to deliver directory sync alert for run ${options.runId}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

export type DirectoryManagerBindingCoverage = {
  managerCount: number
  linkedManagerCount: number
  coverage: number
}

/**
 * DT-OPS-03 — approval-routing health.
 *
 * `ApprovalDirectoryOrg` can only resolve a manager that is LINKED to a local user:
 * unlinked managers are skipped (dept head) or walked through (manager chain). So the
 * share of managers that are bound is a direct upper bound on approval-routing success,
 * and it is invisible today. Managers are the union of the department heads named in
 * `directory_departments.raw.dept_manager_userid_list` and the accounts flagged
 * `leader_in_dept` in their own raw.
 */
export async function getDirectoryManagerBindingCoverage(
  integrationId: string,
  queryFn: typeof query = query,
): Promise<DirectoryManagerBindingCoverage> {
  const result = await queryFn<{ manager_count: number; linked_manager_count: number }>(
    `WITH dept_heads AS (
       SELECT DISTINCT jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(d.raw->'dept_manager_userid_list') = 'array'
                     THEN d.raw->'dept_manager_userid_list'
                     ELSE '[]'::jsonb END
              ) AS external_user_id
         FROM directory_departments d
        WHERE d.integration_id = $1 AND d.is_active = true
     ),
     dept_leaders AS (
       SELECT DISTINCT a.external_user_id
         FROM directory_accounts a
        WHERE a.integration_id = $1
          AND a.is_active = true
          AND jsonb_typeof(a.raw->'leader_in_dept') = 'array'
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(a.raw->'leader_in_dept') AS entry
             WHERE entry->>'leader' = 'true'
          )
     ),
     managers AS (
       SELECT external_user_id FROM dept_heads
       UNION
       SELECT external_user_id FROM dept_leaders
     )
     SELECT COUNT(*)::int AS manager_count,
            COUNT(*) FILTER (WHERE l.local_user_id IS NOT NULL)::int AS linked_manager_count
       FROM managers m
       LEFT JOIN directory_accounts a
         ON a.integration_id = $1 AND a.external_user_id = m.external_user_id AND a.is_active = true
       LEFT JOIN directory_account_links l
         ON l.directory_account_id = a.id AND l.link_status = 'linked' AND l.local_user_id IS NOT NULL`,
    [integrationId],
  )

  const managerCount = Number(result.rows[0]?.manager_count ?? 0)
  const linkedManagerCount = Number(result.rows[0]?.linked_manager_count ?? 0)
  return {
    managerCount,
    linkedManagerCount,
    coverage: managerCount === 0 ? 1 : linkedManagerCount / managerCount,
  }
}
