import { describe, expect, it } from 'vitest'
import {
  adapterResultToChannelResult,
  classifyNotificationTestSendOutcome,
  providerResponseAcceptance,
} from '../../src/notifications/delivery-outcome'
import { classifyTaskDeliveryOutcome } from '../../src/tasks/task-delivery-protocol'
import type { AdapterPrepared, AdapterSendResult } from '../../src/notifications/adapters/notification-adapter'

describe('notification delivery vocabulary', () => {
  it.each(['routed_simulated', 'routed_cancelled'])('%s is refused before sending, never accepted', (code) => {
    const result: Extract<AdapterPrepared, { ok: false }> = { ok: false, retryable: false, skip: true, code }
    expect(classifyNotificationTestSendOutcome(result, 'prepare')).toBe('refused')
    expect(classifyNotificationTestSendOutcome(result, 'send')).toBe('outcome_unknown')
    expect(classifyTaskDeliveryOutcome({
      result: adapterResultToChannelResult(result), fenced: false, attemptCount: 0, maxAttempts: 5,
    })).toBe('skipped')
  })

  it.each([
    [{ ok: true }, 'accepted', 'sent', 1],
    [{ ok: false, retryable: false, code: 'dingtalk_business_error_40035' }, 'failed', 'failed', 1],
    [{ ok: false, retryable: true, code: 'dingtalk_request_429' }, 'failed', 'retrying', 1],
    [{ ok: false, retryable: true, code: 'dingtalk_request_429' }, 'failed', 'failed', 5],
    [{ ok: false, retryable: false, outcomeUnknown: true, code: 'dingtalk_send_outcome_unknown' }, 'outcome_unknown', 'outcome_unknown', 1],
  ] as const)('maps %j to the correct ledger and worker outcomes', (result, ledger, worker, attemptCount) => {
    expect(classifyNotificationTestSendOutcome(result, 'send')).toBe(ledger)
    expect(classifyTaskDeliveryOutcome({
      result: adapterResultToChannelResult(result), fenced: true, attemptCount, maxAttempts: 5,
    })).toBe(worker)
  })

  it.each([undefined, null, new Error('fixture'), {}, [], { ok: false }, { ok: 'true' }])('unclassified %j is outcome unknown', (result) => {
    expect(classifyNotificationTestSendOutcome(result, 'send')).toBe('outcome_unknown')
  })

  const routedCodes = [
    'routed_decision_missing', 'routed_decision_mismatch', 'routed_group_closed', 'routed_topic_paused',
    'routed_user_opted_out', 'routed_quiet_hours', 'routed_target_endpoint_stale', 'routed_target_proof_unavailable',
    'routed_target_proof_changed', 'routed_target_address_unusable', 'routed_target_capability_unavailable',
    'routed_target_capability_changed', 'routed_target_not_verified', 'routed_target_adapter_unavailable',
    'routed_target_scope_changed', 'routed_capability_unreadable', 'routed_schema_unavailable',
    'routed_credentials_unavailable', 'routed_destination_changed', 'routed_base_url_rejected',
    'routed_simulated', 'routed_cancelled', 'routed_send_unclassified',
  ]
  it.each(routedCodes)('preserves the complete fixed code %s as the channel error', (code) => {
    const result: AdapterSendResult = { ok: false, retryable: false, code }
    expect(adapterResultToChannelResult(result)).toEqual({ ok: false, retryable: false, error: code })
  })

  it.each(['invaliduser', 'unlicenseduser'])('refuses a success response with nonempty recipient rejection field %s', (field) => {
    const descriptor = { recipientLevelNonAcceptanceFields: ['invaliduser', 'unlicenseduser'] }
    const result = providerResponseAcceptance(descriptor, { errcode: 0, [field]: 'fixture-recipient' })
    expect(result).toEqual({ ok: false, retryable: false, outcomeUnknown: true, code: 'routed_send_unclassified' })
    expect(classifyNotificationTestSendOutcome(result, 'send')).toBe('outcome_unknown')
  })

  it.each([undefined, null, '', []])('accepts an empty recipient rejection field %j', (value) => {
    expect(providerResponseAcceptance({ recipientLevelNonAcceptanceFields: ['invaliduser'] }, { invaliduser: value })).toEqual({ ok: true })
  })
})
