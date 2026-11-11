/**
 * Delivery-result truthfulness: the ONE place that turns a `NotificationResult` into the outcome a
 * consumer may act on. Every consumer of a send_email result (the automation executor's legacy step
 * output, its Class-B two-phase step output, and the outbound-intent ledger `last_error`) goes through
 * {@link mapSendEmailDeliveryOutcome}, so one fact has one token on every path.
 *
 * Invariant (values-free, enforced by the channels and checked here):
 *   - `sent` is the ONLY status that proves a transport / provider accepted the message. It is matched
 *     positively; "not failed" is never treated as success.
 *   - `simulated` (development mock) and `cancelled` (nothing attempted: no recipient of the channel's
 *     type, transport disabled, or preference-filtered) are DEFINITE non-delivery: nothing left the
 *     client, so the ledger may record `failed` (retryable) under its existing status set.
 *   - `failed`, `pending`, `scheduled` and any unrecognised literal are NOT provable as pre-dispatch
 *     non-delivery and fail closed to `outcome_unknown` (never auto-resent).
 */
import type { NotificationResult } from '../types/plugin'

/** Channel-level `metadata.reason` literals (what the channel itself knows). */
export const NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON = 'no_channel_recipients' as const
export const NOTIFICATION_TRANSPORT_DISABLED_REASON = 'transport_disabled' as const
export const NOTIFICATION_TRANSPORT_SIMULATED_REASON = 'transport_simulated' as const
export const NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON = 'transport_not_configured' as const
/** A channel that addresses recipients through a bound endpoint: no addressed recipient had a usable endpoint. */
export const NOTIFICATION_RECIPIENTS_NOT_BOUND_REASON = 'recipients_not_bound' as const
/** The same channel: the allow-set for the event and its recipients was empty. */
export const NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON = 'recipients_not_allowed' as const

/** The closed set of send_email outcome reasons (step output `reason` and ledger `last_error`). */
export const SEND_EMAIL_OUTCOME_REASONS = Object.freeze({
  sent: 'sent',
  simulated: 'email_transport_simulated',
  disabled: 'email_transport_disabled',
  noRecipients: 'email_no_recipients',
  sendFailed: 'email_send_failed',
  sendThrew: 'email_send_threw',
  unrecognized: 'email_result_unrecognized',
} as const)

export type SendEmailOutcomeReason = (typeof SEND_EMAIL_OUTCOME_REASONS)[keyof typeof SEND_EMAIL_OUTCOME_REASONS]

/** Step-output marker for a step that made no send attempt (rendered as "skipped", never "success"). */
export const SEND_EMAIL_NOT_SENT_OUTCOME = 'not_sent' as const

export type SendEmailDeliveryOutcome =
  /** Provider accepted — the only success. */
  | { outcome: 'sent'; reason: typeof SEND_EMAIL_OUTCOME_REASONS.sent }
  /** Definite non-delivery (nothing left the client); ledger `failed`, step `skipped`, retry allowed. */
  | {
      outcome: 'failed'
      reason:
        | typeof SEND_EMAIL_OUTCOME_REASONS.simulated
        | typeof SEND_EMAIL_OUTCOME_REASONS.disabled
        | typeof SEND_EMAIL_OUTCOME_REASONS.noRecipients
    }
  /** Not provable either way; fail closed, never auto-resent. */
  | {
      outcome: 'outcome_unknown'
      reason: typeof SEND_EMAIL_OUTCOME_REASONS.sendFailed | typeof SEND_EMAIL_OUTCOME_REASONS.unrecognized
    }

const SEND_EMAIL_OUTCOME_REASON_SET: ReadonlySet<string> = new Set(Object.values(SEND_EMAIL_OUTCOME_REASONS))

export function isSendEmailOutcomeReason(value: unknown): value is SendEmailOutcomeReason {
  return typeof value === 'string' && SEND_EMAIL_OUTCOME_REASON_SET.has(value)
}

function metadataReason(result: Pick<NotificationResult, 'metadata'>): string | null {
  const reason = result.metadata?.reason
  return typeof reason === 'string' ? reason : null
}

/**
 * Map a channel result to the outcome every send_email consumer acts on. Pure, total, and fail-closed:
 * an unrecognised `status` literal is `outcome_unknown`, never success and never a retryable `failed`.
 */
export function mapSendEmailDeliveryOutcome(
  result: Pick<NotificationResult, 'status' | 'metadata'>,
): SendEmailDeliveryOutcome {
  switch (result.status) {
    case 'sent':
      return { outcome: 'sent', reason: SEND_EMAIL_OUTCOME_REASONS.sent }
    case 'simulated':
      return { outcome: 'failed', reason: SEND_EMAIL_OUTCOME_REASONS.simulated }
    case 'cancelled':
      return metadataReason(result) === NOTIFICATION_TRANSPORT_DISABLED_REASON
        ? { outcome: 'failed', reason: SEND_EMAIL_OUTCOME_REASONS.disabled }
        : { outcome: 'failed', reason: SEND_EMAIL_OUTCOME_REASONS.noRecipients }
    case 'failed':
      return { outcome: 'outcome_unknown', reason: SEND_EMAIL_OUTCOME_REASONS.sendFailed }
    default:
      // `pending` / `scheduled` (deferred) and any literal this module does not know: fail closed.
      return { outcome: 'outcome_unknown', reason: SEND_EMAIL_OUTCOME_REASONS.unrecognized }
  }
}
