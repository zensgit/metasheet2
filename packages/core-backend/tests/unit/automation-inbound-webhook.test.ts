import { describe, expect, test } from 'vitest'

import {
  signInboundWebhookBody,
  validateInboundWebhookTriggerAtSave,
  verifyInboundWebhookSignature,
  redactInboundWebhookTriggerConfig,
} from '../../src/multitable/automation-inbound-webhook'

describe('automation inbound webhook helpers', () => {
  test('verifies HMAC-SHA256 over timestamp.rawBody and strips sha256= before constant-time compare', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'ok' }))
    const timestamp = '1782900000'
    const signature = signInboundWebhookBody(rawBody, 'secret-1', timestamp)

    expect(verifyInboundWebhookSignature({
      rawBody,
      secret: 'secret-1',
      timestampHeader: timestamp,
      signatureHeader: signature,
      nowMs: Number(timestamp) * 1000,
    })).toEqual({ ok: true })
  })

  test('rejects stale timestamps and bad signatures', () => {
    const rawBody = Buffer.from('{"x":1}')
    const timestamp = '1782900000'
    const signature = signInboundWebhookBody(rawBody, 'secret-1', timestamp)
    const badSignature = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`

    expect(verifyInboundWebhookSignature({
      rawBody,
      secret: 'secret-1',
      timestampHeader: timestamp,
      signatureHeader: signature,
      nowMs: (Number(timestamp) + 301) * 1000,
    })).toEqual({ ok: false, reason: 'stale_timestamp' })

    expect(verifyInboundWebhookSignature({
      rawBody,
      secret: 'secret-1',
      timestampHeader: timestamp,
      signatureHeader: badSignature,
      nowMs: Number(timestamp) * 1000,
    })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  test('save gate requires a non-empty secret for webhook.received', () => {
    expect(validateInboundWebhookTriggerAtSave('webhook.received', {})).toBe('webhook.received requires trigger_config.secret')
    expect(validateInboundWebhookTriggerAtSave('webhook.received', { secret: '  ' })).toBe('webhook.received requires trigger_config.secret')
    expect(validateInboundWebhookTriggerAtSave('webhook.received', { secret: 's' })).toBeNull()
    expect(validateInboundWebhookTriggerAtSave('record.created', {})).toBeNull()
  })

  test('HTTP rule serialization redacts webhook trigger secrets', () => {
    expect(redactInboundWebhookTriggerConfig({ secret: 'live-secret', label: 'ingress' }))
      .toEqual({ secret: '<redacted>', label: 'ingress' })
  })
})
