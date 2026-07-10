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

export type DirectoryInactiveLinkedSample = {
  directoryAccountId: string
  externalUserId: string
  accountName: string | null
  localUserId: string
  localUserEmail: string | null
  localUserName: string | null
  inactiveSinceAt: string
  inactiveDays: number
}

export type DirectoryInactiveLinkedMetric = {
  thresholdDays: number
  count: number
  sample: DirectoryInactiveLinkedSample[]
}

const INACTIVE_LINKED_SAMPLE_LIMIT = 20

/**
 * roadmap §7.1 — the offboarding blind spot. `DIRECTORY_DEPROVISION_ENABLED` (DT-OPS-01) is
 * default-OFF by owner decision, so a directory account going `is_active = false` (DingTalk
 * removal / the deactivation sweep) does NOT touch the linked local user at all: password
 * login keeps working indefinitely. The `inactive_linked` review-item filter
 * (`directory-sync.ts` `buildReviewFilterSql`) surfaces these as a REVIEW QUEUE, but has no
 * notion of how long an account has sat that way — this is the missing age dimension.
 *
 * "Linked" here matches the `inactive_linked` review-item's own definition exactly:
 * `directory_account_links.local_user_id IS NOT NULL` (link_status is NOT required to be
 * `'linked'` — a recorded candidate match is enough to mean "this local user inherits
 * whatever the directory account grants"). We ALSO require the local user to still be
 * `is_active = true`: a local user already deactivated by some other path is not part of
 * this specific blind spot (there is nothing left to revoke).
 *
 * Anchor for "since when": `directory_accounts.updated_at`. There is no dedicated
 * deactivation-transition column in this schema. Verified by grepping every write site
 * that can touch `directory_accounts` in this codebase — there are exactly two, both in
 * `directory-sync.ts`:
 *   1. The re-sync upsert (`INSERT ... ON CONFLICT DO UPDATE SET is_active = true, ...,
 *      updated_at = NOW()`) — only fires for accounts CURRENTLY present in the DingTalk
 *      pull, and always sets is_active back to true (which takes the row OUT of this
 *      metric's target set).
 *   2. The deactivation sweep (`UPDATE directory_accounts SET is_active = false,
 *      updated_at = NOW() WHERE ... AND is_active = true`) — guarded by `AND is_active =
 *      true`, i.e. a genuine one-way transition, not a re-stamp. Once a row is inactive,
 *      this statement's WHERE clause no longer matches it, so it cannot bump `updated_at`
 *      again while the row stays inactive.
 * No other module in `packages/core-backend/src` issues an UPDATE or INSERT against
 * `directory_accounts` (every other reference is a read-only JOIN). So for a row that is
 * CURRENTLY `is_active = false`, `updated_at` is exactly the timestamp of the transition
 * into inactivity — an honest anchor, not an approximation, given the current schema.
 */
export async function getDirectoryInactiveLinkedMetric(
  integrationId: string,
  thresholdDays: number,
  queryFn: typeof query = query,
  sampleLimit: number = INACTIVE_LINKED_SAMPLE_LIMIT,
): Promise<DirectoryInactiveLinkedMetric> {
  const normalizedThresholdDays = Math.floor(thresholdDays)

  const [countResult, sampleResult] = await Promise.all([
    queryFn<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM directory_accounts a
         JOIN directory_account_links l ON l.directory_account_id = a.id
         JOIN users u ON u.id = l.local_user_id
        WHERE a.integration_id = $1
          AND a.is_active = FALSE
          AND u.is_active = TRUE
          AND a.updated_at <= NOW() - ($2 || ' days')::interval`,
      [integrationId, normalizedThresholdDays],
    ),
    queryFn<{
      directory_account_id: string
      external_user_id: string
      account_name: string | null
      local_user_id: string
      local_user_email: string | null
      local_user_name: string | null
      inactive_since_at: string
      inactive_days: number
    }>(
      `SELECT a.id AS directory_account_id,
              a.external_user_id,
              a.name AS account_name,
              u.id AS local_user_id,
              u.email AS local_user_email,
              u.name AS local_user_name,
              a.updated_at AS inactive_since_at,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - a.updated_at)) / 86400)::int AS inactive_days
         FROM directory_accounts a
         JOIN directory_account_links l ON l.directory_account_id = a.id
         JOIN users u ON u.id = l.local_user_id
        WHERE a.integration_id = $1
          AND a.is_active = FALSE
          AND u.is_active = TRUE
          AND a.updated_at <= NOW() - ($2 || ' days')::interval
        ORDER BY a.updated_at ASC
        LIMIT $3`,
      [integrationId, normalizedThresholdDays, sampleLimit],
    ),
  ])

  return {
    thresholdDays: normalizedThresholdDays,
    count: Number(countResult.rows[0]?.total ?? 0),
    sample: sampleResult.rows.map((row) => ({
      directoryAccountId: row.directory_account_id,
      externalUserId: row.external_user_id,
      accountName: row.account_name,
      localUserId: row.local_user_id,
      localUserEmail: row.local_user_email,
      localUserName: row.local_user_name,
      inactiveSinceAt: row.inactive_since_at,
      inactiveDays: Number(row.inactive_days),
    })),
  }
}

/**
 * `unset = off`, matching `DIRECTORY_SYNC_ALERT_WEBHOOK`'s own channel-gating discipline. A
 * non-positive or non-integer value is treated as unset (logged once) rather than silently
 * clamped, so a typo in ops config fails closed instead of alerting on a bogus threshold.
 */
export function readDirectoryInactiveLinkedAlertThresholdDays(): number | null {
  const raw = String(process.env.DIRECTORY_INACTIVE_LINKED_ALERT_DAYS ?? '').trim()
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(`DIRECTORY_INACTIVE_LINKED_ALERT_DAYS is set but not a positive integer: ${raw}`)
    return null
  }
  return parsed
}

export function buildDirectoryInactiveLinkedAlertMessage(options: {
  integrationName: string
  metric: DirectoryInactiveLinkedMetric
}): { subject: string; content: string } {
  const { integrationName, metric } = options
  const subject = `钉钉目录存在停用超 ${metric.thresholdDays} 天但本地账号仍激活的绑定`
  const lines = [
    `- 集成：${integrationName}`,
    `- 阈值：${metric.thresholdDays} 天`,
    `- 数量：${metric.count}`,
  ]
  for (const item of metric.sample.slice(0, 5)) {
    const label = item.localUserName || item.localUserEmail || item.localUserId
    lines.push(`  - ${item.accountName || item.externalUserId} → ${label}（已停用 ${item.inactiveDays} 天）`)
  }
  if (metric.count > metric.sample.length) {
    lines.push(`  - ……以及其他 ${metric.count - Math.min(metric.sample.length, 5)} 个账号`)
  }
  return { subject, content: lines.join('\n') }
}

/**
 * §7.1 post-run informational alert. Best-effort and NEVER throws — this is a backlog
 * digest, not a failure signal, and must not make a healthy sync look broken.
 *
 * Two independent env gates, both required, matching the `breach-channels` /
 * `DIRECTORY_SYNC_ALERT_WEBHOOK` convention that a side channel exists only when configured:
 *   - `DIRECTORY_INACTIVE_LINKED_ALERT_DAYS` turns THIS alert on and sets its threshold.
 *   - `DIRECTORY_SYNC_ALERT_WEBHOOK` (+ optional secret) is the delivery channel, shared
 *     with the sync-failure alert.
 * The threshold-days check is the SOLE gate on computing/sending this alert (no second,
 * redundant guard inside the metric query) — a query gate here as well would make the env
 * guard unfalsifiable by mutation (removing it would still silently no-op downstream).
 */
export async function deliverDirectoryInactiveLinkedAlert(
  options: {
    integrationId: string
    integrationName: string
  },
  deps: {
    thresholdDays?: number | null
    config?: DirectorySyncAlertDeliveryConfig | null
    fetchFn?: typeof fetch
    queryFn?: typeof query
  } = {},
): Promise<boolean> {
  const thresholdDays = deps.thresholdDays !== undefined ? deps.thresholdDays : readDirectoryInactiveLinkedAlertThresholdDays()
  if (!thresholdDays) return false

  const config = deps.config !== undefined ? deps.config : readDirectorySyncAlertWebhookConfig()
  if (!config) return false

  const queryFn = deps.queryFn ?? query
  const fetchFn = deps.fetchFn ?? fetch

  try {
    const metric = await getDirectoryInactiveLinkedMetric(options.integrationId, thresholdDays, queryFn)
    if (metric.count === 0) return false

    const { subject, content } = buildDirectoryInactiveLinkedAlertMessage({
      integrationName: options.integrationName,
      metric,
    })

    const signedUrl = buildSignedDingTalkWebhookUrl(config.webhookUrl, config.secret)
    const response = await fetchFn(signedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDingTalkMarkdown(subject, content)),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      logger.warn(`Directory inactive-linked alert webhook returned HTTP ${response.status} (${maskDingTalkWebhookUrl(config.webhookUrl)})`)
      return false
    }
    validateDingTalkRobotResponse(await response.json().catch(() => null))

    logger.info(`Directory inactive-linked backlog alert delivered for integration ${options.integrationId} (${metric.count} accounts >= ${thresholdDays}d)`)
    return true
  } catch (error) {
    // A backlog digest must never be made worse by a failed webhook — same discipline as
    // deliverDirectorySyncFailureAlert.
    logger.warn(
      `Failed to deliver directory inactive-linked alert for integration ${options.integrationId}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}
