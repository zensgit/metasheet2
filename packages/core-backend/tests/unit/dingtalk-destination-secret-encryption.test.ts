import { beforeAll, describe, expect, it } from 'vitest'

import {
  decryptDingTalkDestinationSecret,
  decryptDingTalkDestinationWebhookUrl,
  encryptDingTalkDestinationValue,
} from '../../src/multitable/dingtalk-group-destinations'
import { isEncryptedSecretValue } from '../../src/security/encrypted-secrets'
import { toDingTalkGroupDestinationResponse } from '../../src/multitable/dingtalk-group-destination-response'

const PLAIN_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=abc123def456'
const PLAIN_SECRET = 'SECabcdef0123456789'

beforeAll(() => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key'
  process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'unit-test-salt'
})

/**
 * DT-HARDEN-03 — group-robot credentials at rest.
 *
 * webhook_url embeds the robot access_token and secret is the HMAC signing key:
 * together they let anyone inject messages into a customer group. They must not sit
 * in the database as plain text.
 */
describe('DT-HARDEN-03 DingTalk destination credential encryption', () => {
  it('encrypts the webhook URL at rest and never stores the access_token verbatim', () => {
    const stored = encryptDingTalkDestinationValue(PLAIN_WEBHOOK)
    expect(isEncryptedSecretValue(stored)).toBe(true)
    expect(stored).not.toContain('access_token')
    expect(stored).not.toContain('abc123def456')
  })

  it('encrypts the signing secret at rest', () => {
    const stored = encryptDingTalkDestinationValue(PLAIN_SECRET)
    expect(isEncryptedSecretValue(stored)).toBe(true)
    expect(stored).not.toContain(PLAIN_SECRET)
  })

  it('round-trips both values back to plaintext for signing and sending', () => {
    expect(decryptDingTalkDestinationWebhookUrl(encryptDingTalkDestinationValue(PLAIN_WEBHOOK))).toBe(PLAIN_WEBHOOK)
    expect(decryptDingTalkDestinationSecret(encryptDingTalkDestinationValue(PLAIN_SECRET))).toBe(PLAIN_SECRET)
  })

  it('is idempotent — re-encrypting an already-encrypted value is a no-op', () => {
    const once = encryptDingTalkDestinationValue(PLAIN_WEBHOOK)
    expect(encryptDingTalkDestinationValue(once)).toBe(once)
  })

  describe('compatibility reader for legacy plaintext rows', () => {
    it('passes a pre-existing plaintext webhook URL through unchanged', () => {
      expect(decryptDingTalkDestinationWebhookUrl(PLAIN_WEBHOOK)).toBe(PLAIN_WEBHOOK)
    })

    it('passes a pre-existing plaintext secret through unchanged', () => {
      expect(decryptDingTalkDestinationSecret(PLAIN_SECRET)).toBe(PLAIN_SECRET)
    })

    it('treats absent/empty secrets as undefined', () => {
      expect(decryptDingTalkDestinationSecret(null)).toBeUndefined()
      expect(decryptDingTalkDestinationSecret(undefined)).toBeUndefined()
      expect(decryptDingTalkDestinationSecret('')).toBeUndefined()
    })
  })

  describe('API responses never leak credentials', () => {
    it('masks the access_token and reduces the secret to a boolean', () => {
      const response = toDingTalkGroupDestinationResponse({
        id: 'dst_1',
        name: 'ops group',
        // rowToDestination decrypts, so the domain object carries plaintext.
        webhookUrl: PLAIN_WEBHOOK,
        secret: PLAIN_SECRET,
        enabled: true,
        scope: 'private',
        createdBy: 'user-1',
        createdAt: '2026-07-08T00:00:00.000Z',
      })

      expect(response.webhookUrl).toContain('access_token=***')
      expect(response.webhookUrl).not.toContain('abc123def456')
      expect(response.hasSecret).toBe(true)
      expect((response as Record<string, unknown>).secret).toBeUndefined()
    })

    it('reports hasSecret=false when no secret is configured', () => {
      const response = toDingTalkGroupDestinationResponse({
        id: 'dst_2',
        name: 'no secret',
        webhookUrl: PLAIN_WEBHOOK,
        enabled: true,
        scope: 'private',
        createdBy: 'user-1',
        createdAt: '2026-07-08T00:00:00.000Z',
      })
      expect(response.hasSecret).toBe(false)
    })
  })
})
