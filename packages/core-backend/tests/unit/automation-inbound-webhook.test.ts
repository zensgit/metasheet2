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

  test('save gate rejects the redacted read-placeholder as a literal secret (round-trip corruption guard)', () => {
    // The read API serializes the secret as '<redacted>'; a client that round-trips a fetched rule must
    // NOT be able to persist the placeholder as the real secret (which would break every future signature).
    expect(validateInboundWebhookTriggerAtSave('webhook.received', { secret: '<redacted>' }))
      .toBe('webhook.received trigger_config.secret must not be the redacted placeholder (omit triggerConfig to keep the stored secret, or provide a new one)')
    expect(redactInboundWebhookTriggerConfig({ secret: 'real' }).secret).toBe('<redacted>')
  })

  test('HTTP rule serialization redacts webhook trigger secrets', () => {
    expect(redactInboundWebhookTriggerConfig({ secret: 'live-secret', label: 'ingress' }))
      .toEqual({ secret: '<redacted>', label: 'ingress' })
  })
})
