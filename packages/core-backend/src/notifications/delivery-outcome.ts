import type { TaskDeliveryChannelResult } from '../tasks/task-delivery-protocol'
import type { AdapterPrepared, AdapterSendResult } from './adapters/notification-adapter'
import type { ProviderTransportDescriptor } from './provider-notification-registry'

export type NotificationTestSendOutcome = 'accepted' | 'failed' | 'outcome_unknown' | 'refused'

/** The persisted routing error is the complete fixed code, without added detail. */
export function adapterResultToChannelResult(
  result: AdapterSendResult | Extract<AdapterPrepared, { ok: false }>,
): TaskDeliveryChannelResult {
  if (result.ok === true) return { ok: true }
  const { code, ...rest } = result
  return { ...rest, error: code }
}

export function classifyNotificationTestSendOutcome(
  result: unknown,
  phase: 'prepare' | 'send',
): NotificationTestSendOutcome {
  if (phase === 'prepare') return 'refused'
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return 'outcome_unknown'
  const value = result as Record<string, unknown>
  if (value.ok === true) return 'accepted'
  if (value.ok === false && value.outcomeUnknown !== true && value.skip !== true
    && typeof value.retryable === 'boolean' && typeof value.code === 'string') return 'failed'
  return 'outcome_unknown'
}

/** A provider-wide success code cannot override rejection of the individual recipient. */
export function providerResponseAcceptance(
  descriptor: Pick<ProviderTransportDescriptor, 'recipientLevelNonAcceptanceFields'>,
  response: Record<string, unknown>,
): AdapterSendResult {
  for (const field of descriptor.recipientLevelNonAcceptanceFields) {
    const value = response[field]
    if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      return { ok: false, retryable: false, outcomeUnknown: true, code: 'routed_send_unclassified' }
    }
  }
  return { ok: true }
}
