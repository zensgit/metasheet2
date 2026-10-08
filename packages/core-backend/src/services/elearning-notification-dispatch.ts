import type { ElearningNotificationDeliveryDb } from './elearning-notification-delivery'
import { normalizeElearningNotificationTimestamp } from './elearning-notification-delivery'
import { checkElearningAssignmentReminderEligibility } from './elearning-assignment-reminder'
import { prepareElearningDingTalkNotification } from './elearning-notification-dingtalk'
import { checkElearningEventNotificationEligibility } from './elearning-notification-events'

export interface ElearningNotificationDispatchInput {
  orgId: string
  deliveryId: string
  idempotencyKey: string
  assignmentMemberId: string | null
  recipientUserId: string
  kind: 'assignment_reminder' | 'training_available' | 'result_published'
  payload: Record<string, unknown>
}

export type ElearningNotificationDispatchResult =
  | { outcome: 'sent' }
  | { outcome: 'failed' | 'retryable' | 'outcome_unknown'; code: string }

/** External delivery is a separate opt-in, never implied by installing the app. */
export function isElearningNotificationDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELEARNING_ENABLED === 'true'
    && env.ELEARNING_CONTENT_ENABLED === 'true'
    && env.ELEARNING_NOTIFICATIONS_ENABLED === 'true'
}

/**
 * Commit an irreversible effect fence BEFORE network IO. A reclaimed worker
 * cannot resend a claimed effect, even after process death. Uncertain delivery
 * deliberately needs reconciliation; a SQL lease cannot promise exactly-once
 * delivery from an external provider without an idempotency API.
 */
export async function dispatchElearningNotification(
  db: ElearningNotificationDeliveryDb,
  input: ElearningNotificationDispatchInput,
  options: {
    env?: NodeJS.ProcessEnv
    prepare?: typeof prepareElearningDingTalkNotification
    eligible?: (db: ElearningNotificationDeliveryDb, input: ElearningNotificationDispatchInput) => Promise<boolean>
  } = {},
): Promise<ElearningNotificationDispatchResult> {
  const enabled = () => isElearningNotificationDispatchEnabled(options.env)
    && (input?.kind !== 'assignment_reminder' || (options.env ?? process.env).ELEARNING_ASSIGNMENT_ENABLED === 'true')
    && (input?.kind !== 'result_published' || (options.env ?? process.env).ELEARNING_ASSESSMENT_ENABLED === 'true')
    && (input?.kind !== 'training_available' || (input.assignmentMemberId !== null
      ? (options.env ?? process.env).ELEARNING_ASSIGNMENT_ENABLED === 'true'
      : (options.env ?? process.env).ELEARNING_ENROLLMENT_ENABLED === 'true'))
  if (!enabled()) return { outcome: 'retryable', code: 'NOTIFICATION_DISABLED' }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!input || !uuid.test(input.deliveryId)
    || (input.assignmentMemberId !== null && !uuid.test(input.assignmentMemberId))
    || input.idempotencyKey !== `delivery:${input.deliveryId}`
    || !['assignment_reminder', 'training_available', 'result_published'].includes(input.kind)
    || (input.kind === 'assignment_reminder' && input.assignmentMemberId === null)
    || typeof input.orgId !== 'string' || !input.orgId.trim()
    || typeof input.recipientUserId !== 'string' || !input.recipientUserId.trim()) {
    return { outcome: 'failed', code: 'NOTIFICATION_INPUT_INVALID' }
  }
  let effectStarted = false
  let since: string
  try {
    since = normalizeElearningNotificationTimestamp((options.env ?? process.env).ELEARNING_NOTIFICATIONS_SINCE)
  } catch {
    return { outcome: 'retryable', code: 'NOTIFICATION_CUTOFF_REQUIRED' }
  }
  try {
    const loaded = await db.query(`/* elearning-notification-dispatch:load */
      SELECT dispatch_state, status, due_at FROM elearning_notification_deliveries
       WHERE org_id = $1 AND id = $2::uuid AND assignment_member_id IS NOT DISTINCT FROM $3::uuid
         AND recipient_user_id = $4 AND kind = $5 AND channel = 'platform'`,
    [input.orgId, input.deliveryId, input.assignmentMemberId, input.recipientUserId, input.kind])
    const row = loaded.rows[0]
    if (!row) return { outcome: 'failed', code: 'NOTIFICATION_NOT_FOUND' }
    if (row.dispatch_state === 'sent') return { outcome: 'sent' }
    if (row.dispatch_state === 'claimed') return { outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' }
    if (row.dispatch_state === 'failed') return { outcome: 'failed', code: 'NOTIFICATION_EFFECT_REJECTED' }
    if (row.dispatch_state !== 'idle' || row.status !== 'sending') {
      return { outcome: 'failed', code: 'NOTIFICATION_STATE_INVALID' }
    }
    if (normalizeElearningNotificationTimestamp(row.due_at) < since) {
      return { outcome: 'failed', code: 'NOTIFICATION_BEFORE_CUTOFF' }
    }
    const eligible = options.eligible ?? (async (target, value) => value.kind === 'assignment_reminder'
      ? checkElearningAssignmentReminderEligibility(target, { ...value, assignmentMemberId: value.assignmentMemberId! })
      : checkElearningEventNotificationEligibility(target, value))
    if (!await eligible(db, input)) return { outcome: 'failed', code: 'NOTIFICATION_INELIGIBLE' }
    const prepared = await (options.prepare ?? prepareElearningDingTalkNotification)(db.query.bind(db), input)
    if (prepared.outcome !== 'prepared') return prepared
    if (!enabled()) return { outcome: 'retryable', code: 'NOTIFICATION_DISABLED' }
    // Config/token preflight can take time: repeat domain eligibility before fencing.
    if (!await eligible(db, input)) return { outcome: 'failed', code: 'NOTIFICATION_INELIGIBLE' }
    if (!enabled()) return { outcome: 'retryable', code: 'NOTIFICATION_DISABLED' }
    effectStarted = true
    const claimed = await db.query(`/* elearning-notification-dispatch:claim */
      UPDATE elearning_notification_deliveries SET dispatch_state = 'claimed', updated_at = now()
       WHERE org_id = $1 AND id = $2::uuid AND dispatch_state = 'idle' AND status = 'sending'
       RETURNING id`, [input.orgId, input.deliveryId])
    if (claimed.rows.length !== 1) return { outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' }
    if (!enabled()) return { outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' }
    let outcome: Awaited<ReturnType<typeof prepared.send>>
    try {
      outcome = await prepared.send(enabled)
    } catch {
      return { outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' }
    }
    if (outcome.outcome === 'outcome_unknown') return outcome
    const finalized = await db.query(`/* elearning-notification-dispatch:finalize */
      UPDATE elearning_notification_deliveries SET dispatch_state = $3, updated_at = now()
       WHERE org_id = $1 AND id = $2::uuid AND dispatch_state = 'claimed' RETURNING id`,
    [input.orgId, input.deliveryId, outcome.outcome === 'sent' ? 'sent' : 'failed'])
    if (finalized.rows.length !== 1) return { outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' }
    return outcome
  } catch {
    // This includes an unknown COMMIT outcome. Never reinterpret it as safe to resend.
    return { outcome: effectStarted ? 'outcome_unknown' : 'retryable', code: 'NOTIFICATION_DISPATCH_UNAVAILABLE' }
  }
}
